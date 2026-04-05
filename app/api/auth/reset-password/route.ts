import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyAuthRateLimit } from "@/lib/auth-rate-limit"
import { log } from "@/lib/log"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  let email: string | undefined
  let code: string | undefined
  let password: string | undefined
  try {
    const body = await request.json()
    email = body?.email
    code = body?.code
    password = body?.password
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // LB-11: composite (email+IP) rate-limit.
  const limited = await applyAuthRateLimit(request, email, { limit: 5, window: 60 })
  if (limited) return limited

  try {
    if (!email || !code || !password) {
      return NextResponse.json(
        { error: "Email, code, and new password are required" },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      )
    }

    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return NextResponse.json(
        { error: "Password must contain at least one letter and one number" },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // Latest unused OTP for the email, regardless of code match.
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

    if (new Date(latest.expires_at) < new Date()) {
      await supabase
        .from("otp_codes")
        .update({ used: true })
        .eq("id", latest.id)
      return NextResponse.json(
        { error: "Code has expired. Please request a new one." },
        { status: 400 }
      )
    }

    const { data: matchRow } = await supabase
      .from("otp_codes")
      .select("id")
      .eq("id", latest.id)
      .eq("code", code)
      .maybeSingle()

    if (!matchRow) {
      const newCount = (latest.failed_attempts || 0) + 1
      const updates: Record<string, unknown> = { failed_attempts: newCount }
      if (newCount >= 5) {
        updates.locked_at = new Date().toISOString()
        updates.used = true
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

    // Update the user's password via admin API
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      latest.user_id,
      { password }
    )

    if (updateError) {
      log.error("[auth.reset-password] failed to update password", updateError, { route: "auth.reset-password" })
      return NextResponse.json(
        { error: "Failed to update password" },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    log.error("[auth.reset-password] unhandled error", error, { route: "auth.reset-password" })
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
