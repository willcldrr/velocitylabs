import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyAuthRateLimit } from "@/lib/auth-rate-limit"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  let email: string | undefined
  let code: string | undefined
  try {
    const body = await request.json()
    email = body?.email
    code = body?.code
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // LB-11: composite (email+IP) rate-limit. Applied BEFORE existence checks
  // so enumeration attempts still consume a tick.
  const limited = await applyAuthRateLimit(request, email, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    if (!email || !code) {
      return NextResponse.json(
        { error: "Email and code are required" },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // Fetch the latest unused OTP for this email (regardless of whether the
    // submitted code matches) so we can atomically increment failed_attempts
    // on a miss. Keyed by (email, type=verify) — this route handles the
    // signup/email-verify flow.
    const { data: latest } = await supabase
      .from("otp_codes")
      .select("id, user_id, expires_at, failed_attempts, locked_at")
      .eq("email", email)
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (!latest) {
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 400 }
      )
    }

    // Already locked → 429, and force the row to be unusable.
    if (latest.locked_at || (latest.failed_attempts || 0) >= 5) {
      await supabase
        .from("otp_codes")
        .update({ used: true, locked_at: latest.locked_at || new Date().toISOString() })
        .eq("id", latest.id)
      return NextResponse.json(
        { error: "Too many failed attempts. Please request a new code." },
        { status: 429 }
      )
    }

    // Expired → mark used, no need to increment attempts.
    if (new Date(latest.expires_at) < new Date()) {
      await supabase
        .from("otp_codes")
        .update({ used: true })
        .eq("id", latest.id)
      return NextResponse.json(
        { error: "Verification code has expired. Please request a new one." },
        { status: 400 }
      )
    }

    // Re-fetch by code to check match (row-level lookup already scoped by
    // email above; here we only confirm the submitted code matches `latest`).
    const { data: matchRow } = await supabase
      .from("otp_codes")
      .select("id")
      .eq("id", latest.id)
      .eq("code", code)
      .maybeSingle()

    if (!matchRow) {
      // LB-11: increment failed_attempts on EVERY miss. Lock at 5.
      const newCount = (latest.failed_attempts || 0) + 1
      const updates: Record<string, unknown> = { failed_attempts: newCount }
      if (newCount >= 5) {
        updates.locked_at = new Date().toISOString()
        updates.used = true // immediately expire so retries can't succeed
      }
      await supabase.from("otp_codes").update(updates).eq("id", latest.id)

      if (newCount >= 5) {
        return NextResponse.json(
          { error: "Too many failed attempts. Please request a new code." },
          { status: 429 }
        )
      }
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 400 }
      )
    }

    // Mark OTP as used
    await supabase
      .from("otp_codes")
      .update({ used: true })
      .eq("id", latest.id)

    // Confirm the user's email via admin API
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      latest.user_id,
      { email_confirm: true }
    )

    if (updateError) {
      console.error("Failed to confirm user:", updateError)
      return NextResponse.json(
        { error: "Failed to verify email" },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Verify OTP API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
