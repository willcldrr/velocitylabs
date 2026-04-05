import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"

// Service role client bypasses RLS
const serviceSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    // Get the authenticated user
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Use service role to check business status (bypasses RLS)
    const { data: business, error: dbError } = await serviceSupabase
      .from("businesses")
      .select("id, name, status, owner_user_id")
      .eq("owner_user_id", user.id)
      .single()

    if (dbError && dbError.code !== "PGRST116") {
      // PGRST116 = no rows returned, which is fine
      return NextResponse.json({ error: dbError.message }, { status: 500 })
    }

    return NextResponse.json({
      business: business || null,
      userId: user.id,
      email: user.email
    })
  } catch (err) {
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
