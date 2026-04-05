import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

// Service role client bypasses RLS
function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    // Get the current user from the request cookies
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ authenticated: false })
    }

    // Use service role to bypass RLS and get accurate data
    const serviceSupabase = getServiceSupabase()

    // Get profile
    const { data: profile } = await serviceSupabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()

    // Get business
    const { data: business } = await serviceSupabase
      .from("businesses")
      .select("status")
      .eq("owner_user_id", user.id)
      .single()

    return NextResponse.json({
      authenticated: true,
      userId: user.id,
      isAdmin: profile?.is_admin === true,
      businessStatus: business?.status || null,
      canAccessDashboard: profile?.is_admin === true || business?.status === "active",
    })
  } catch (error) {
    log.error("[auth.status] unhandled error", error, { route: "auth.status" })
    return NextResponse.json({ authenticated: false, error: "Internal error" }, { status: 500 })
  }
}
