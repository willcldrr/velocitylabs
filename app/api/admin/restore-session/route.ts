import { NextRequest, NextResponse } from "next/server"
import { createClient as createServiceClient } from "@supabase/supabase-js"
import { createClient as createCookieClient } from "@/lib/supabase/server"
import { z } from "zod"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

const restoreSessionSchema = z.object({
  adminUserId: z.string().uuid("Invalid admin user ID format"),
})

export const dynamic = "force-dynamic"

function getServiceSupabase() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * Generate a fresh session for the admin user after exiting impersonation.
 *
 * Self-only: the caller must already be authenticated as `adminUserId`.
 * This endpoint is purely a "re-mint my own session" helper used after
 * exiting an impersonation flow — it is NEVER a lateral-restore path.
 *
 * Gated behind ENABLE_SESSION_RESTORE feature flag (LB-2).
 */
export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  // Kill switch — must be explicitly enabled per environment.
  if (process.env.ENABLE_SESSION_RESTORE !== "true") {
    return NextResponse.json(
      { error: "Session restore endpoint is disabled" },
      { status: 503 }
    )
  }

  try {
    // Cookie-authenticated client — resolves the CURRENT caller, not the body.
    const cookieSupabase = await createCookieClient()
    const { data: { user: callerUser }, error: callerError } = await cookieSupabase.auth.getUser()

    if (callerError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const parsed = restoreSessionSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }
    const { adminUserId } = parsed.data

    // Self-only: the caller must be re-minting their OWN session.
    if (callerUser.id !== adminUserId) {
      return NextResponse.json(
        { error: "Forbidden: session restore is self-only" },
        { status: 403 }
      )
    }

    const supabase = getServiceSupabase()

    // Verify this user is actually an admin
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", adminUserId)
      .single()

    if (!profile?.is_admin) {
      return NextResponse.json({ error: "Not an admin" }, { status: 403 })
    }

    // Get the admin user's email
    const { data: adminUser, error: userError } = await supabase.auth.admin.getUserById(adminUserId)

    if (userError || !adminUser.user?.email) {
      return NextResponse.json({ error: "Admin user not found" }, { status: 404 })
    }

    // Generate a fresh session via magic link
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: adminUser.user.email,
    })

    if (linkError || !linkData) {
      return NextResponse.json({ error: "Failed to generate session" }, { status: 500 })
    }

    const { data: sessionData, error: verifyError } = await supabase.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    })

    if (verifyError || !sessionData.session) {
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 })
    }

    // Audit log (non-blocking but best-effort)
    try {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "unknown"
      const userAgent = request.headers.get("user-agent") || "unknown"
      await supabase.from("audit_logs").insert({
        action: "session_restore",
        actor_id: callerUser.id,
        target_id: adminUserId,
        ip_address: ip,
        user_agent: userAgent,
      })
    } catch {
      /* non-blocking */
    }

    return NextResponse.json({
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
    })
  } catch (error) {
    log.error("[Restore Admin Session] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
