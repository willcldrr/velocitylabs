import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { z } from "zod"
import { applyRateLimit } from "@/lib/api-rate-limit"

const impersonateSchema = z.object({
  userId: z.string().uuid("Invalid user ID format"),
})

export const dynamic = "force-dynamic"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    const supabase = getSupabase()

    // Verify admin via Bearer token
    const authHeader = request.headers.get("authorization")
    if (!authHeader) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user: adminUser }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !adminUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check admin status
    const { data: adminProfile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", adminUser.id)
      .single()

    if (!adminProfile?.is_admin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const parsed = impersonateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }
    const { userId } = parsed.data

    if (userId === adminUser.id) {
      return NextResponse.json({ error: "Cannot impersonate yourself" }, { status: 400 })
    }

    // Get target user
    const { data: targetUser, error: targetError } = await supabase.auth.admin.getUserById(userId)

    if (targetError || !targetUser.user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    // Generate a magic link and immediately verify it to get a full session
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: targetUser.user.email!,
    })

    if (linkError || !linkData) {
      console.error("Failed to generate link:", linkError)
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 })
    }

    // Use the hashed_token to verify via the SDK (most reliable method)
    const { data: sessionData, error: verifyError } = await supabase.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    })

    if (verifyError || !sessionData.session) {
      console.error("Failed to verify token:", verifyError)
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 })
    }

    // Audit log (non-blocking)
    try {
      await supabase.from("impersonation_logs").insert({
        admin_id: adminUser.id,
        target_user_id: userId,
        ip_address: request.headers.get("x-forwarded-for") || "unknown",
        created_at: new Date().toISOString(),
      })
    } catch { /* don't fail if audit log fails */ }

    return NextResponse.json({
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
      user: {
        id: targetUser.user.id,
        email: targetUser.user.email,
        name: targetUser.user.user_metadata?.full_name || null,
      },
    })
  } catch (error) {
    console.error("Impersonation error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
