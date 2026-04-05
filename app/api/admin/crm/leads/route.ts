import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

// Service role client bypasses RLS
const serviceSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Helper to verify admin
async function verifyAdmin(): Promise<{ isAdmin: boolean; userId?: string; error?: string }> {
  try {
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return { isAdmin: false, error: "Unauthorized" }
    }

    const { data: profile } = await serviceSupabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()

    if (!profile?.is_admin) {
      return { isAdmin: false, error: "Admin access required" }
    }

    return { isAdmin: true, userId: user.id }
  } catch (err) {
    return { isAdmin: false, error: "Auth error" }
  }
}

// GET - List CRM leads with pagination, filtering, sorting
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, error } = await verifyAdmin()
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const { searchParams } = new URL(request.url)
  const page = parseInt(searchParams.get("page") || "1")
  const limit = parseInt(searchParams.get("limit") || "50")
  const search = searchParams.get("search") || ""
  const status = searchParams.get("status") || "all"
  const sortField = searchParams.get("sortField") || "last_contacted_at"
  const sortDirection = searchParams.get("sortDirection") || "desc"

  const from = (page - 1) * limit
  const to = from + limit - 1

  let query = serviceSupabase
    .from("crm_leads")
    .select("*", { count: "exact" })

  // Apply search filter
  if (search.trim()) {
    query = query.or(`company_name.ilike.%${search}%,contact_name.ilike.%${search}%,contact_email.ilike.%${search}%,location.ilike.%${search}%`)
  }

  // Apply status filter
  if (status !== "all") {
    query = query.eq("status", status)
  }

  // Apply sorting and pagination
  const { data, error: dbError, count } = await query
    .order(sortField, { ascending: sortDirection === "asc" })
    .range(from, to)

  if (dbError) {
    log.error("Error fetching CRM leads:", dbError)
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ leads: data, count })
}

// POST - Create a new CRM lead
export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, userId, error } = await verifyAdmin()
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const body = await request.json()

  const { data, error: dbError } = await serviceSupabase
    .from("crm_leads")
    .insert({ ...body, user_id: userId })
    .select()
    .single()

  if (dbError) {
    log.error("Error creating CRM lead:", dbError)
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ lead: data })
}

// PATCH - Update CRM lead(s) - supports single ID or array of IDs for bulk updates
export async function PATCH(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, error } = await verifyAdmin()
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const { id, ids, ...updates } = await request.json()

  // Support both single id and bulk ids array
  const targetIds = ids || (id ? [id] : null)

  if (!targetIds || targetIds.length === 0) {
    return NextResponse.json({ error: "Lead ID(s) required" }, { status: 400 })
  }

  const { data, error: dbError } = await serviceSupabase
    .from("crm_leads")
    .update(updates)
    .in("id", targetIds)
    .select()

  if (dbError) {
    log.error("Error updating CRM lead:", dbError)
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ lead: data })
}

// DELETE - Delete a CRM lead
export async function DELETE(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, error } = await verifyAdmin()
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")

  if (!id) {
    return NextResponse.json({ error: "Lead ID is required" }, { status: 400 })
  }

  const { error: dbError } = await serviceSupabase
    .from("crm_leads")
    .delete()
    .eq("id", id)

  if (dbError) {
    log.error("Error deleting CRM lead:", dbError)
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
