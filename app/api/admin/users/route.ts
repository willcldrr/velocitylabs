import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// GET - List all users with their business info + auth metadata
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const serviceSupabase = getSupabase()

    const { data: profile } = await serviceSupabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()

    if (!profile?.is_admin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Fetch profiles, businesses, and auth users in parallel
    const [profilesResult, businessesResult, authUsersResult] = await Promise.all([
      serviceSupabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false }),
      serviceSupabase
        .from("businesses")
        .select("id, name, status, payment_domain, stripe_connected, owner_user_id, created_at"),
      serviceSupabase.auth.admin.listUsers({ perPage: 1000 }),
    ])

    if (profilesResult.error) {
      return NextResponse.json({ error: profilesResult.error.message }, { status: 500 })
    }

    const profiles = profilesResult.data || []
    const businesses = businessesResult.data || []
    const authUsers = authUsersResult.data?.users || []

    // Build a map of auth user data for quick lookup
    const authUserMap = new Map(
      authUsers.map(u => [u.id, {
        email_confirmed_at: u.email_confirmed_at,
        last_sign_in_at: u.last_sign_in_at,
        created_at: u.created_at,
        providers: u.app_metadata?.providers || [],
      }])
    )

    // Merge all data
    const usersWithBusiness = profiles.map(p => ({
      ...p,
      business: businesses.find(b => b.owner_user_id === p.id) || null,
      auth: authUserMap.get(p.id) || null,
    }))

    return NextResponse.json({ users: usersWithBusiness })
  } catch (err) {
    console.error("Admin users API error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
