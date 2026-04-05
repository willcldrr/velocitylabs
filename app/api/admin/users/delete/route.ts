import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"

// Service role client for admin operations
const getServiceSupabase = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error("Missing Supabase service role configuration")
  }

  return createClient(url, serviceKey)
}

// Helper to safely delete from a table and log any errors
async function safeDelete(
  supabase: ReturnType<typeof createClient>,
  table: string,
  column: string,
  value: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.from(table).delete().eq(column, value)
    if (error) {
      console.error(`[DELETE] ${table}: ${error.message}`)
      return { success: false, error: error.message }
    }
    console.log(`[DELETE] ${table}: OK`)
    return { success: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error"
    console.error(`[DELETE] ${table}: ${msg}`)
    return { success: false, error: msg }
  }
}

// Helper to safely update (set null) in a table
async function safeSetNull(
  supabase: ReturnType<typeof createClient>,
  table: string,
  column: string,
  value: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await (supabase.from(table) as any).update({ [column]: null }).eq(column, value)
    if (error) {
      console.error(`[SET NULL] ${table}.${column}: ${error.message}`)
      return { success: false, error: error.message }
    }
    console.log(`[SET NULL] ${table}.${column}: OK`)
    return { success: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error"
    console.error(`[SET NULL] ${table}.${column}: ${msg}`)
    return { success: false, error: msg }
  }
}

export async function DELETE(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  const errors: string[] = []

  try {
    console.log("[DELETE USER] Starting user deletion...")

    // Verify the requesting user is an admin
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      console.error("[DELETE USER] Auth error:", authError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check admin status using service role
    let serviceSupabase: any
    try {
      serviceSupabase = getServiceSupabase()
    } catch (e) {
      console.error("[DELETE USER] Service role error:", e)
      return NextResponse.json({
        error: "Server configuration error - missing service role key"
      }, { status: 500 })
    }

    const { data: profile } = await serviceSupabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()

    if (!profile?.is_admin) {
      console.error("[DELETE USER] Not admin:", user.id)
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Get user ID to delete from request
    const { userId, businessId } = await request.json()
    console.log("[DELETE USER] Target user:", userId, "Business:", businessId)

    if (!userId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 })
    }

    // Don't allow deleting yourself
    if (userId === user.id) {
      return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 })
    }

    // First verify the target user exists
    const { data: targetUser } = await serviceSupabase
      .from("profiles")
      .select("id, email")
      .eq("id", userId)
      .single()

    if (!targetUser) {
      console.log("[DELETE USER] User not found:", userId)
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }
    console.log("[DELETE USER] Found user:", targetUser.email)

    // Delete business if provided
    // Must clear payment_links.business_id first (no CASCADE on that FK)
    if (businessId) {
      // Clear business_id references in payment_links
      const { error: plError } = await serviceSupabase
        .from("payment_links")
        .update({ business_id: null })
        .eq("business_id", businessId)

      if (plError) {
        console.error("[DELETE USER] Failed to clear payment_links.business_id:", plError)
      } else {
        console.log("[DELETE USER] Cleared payment_links.business_id references")
      }

      const { error: businessError } = await serviceSupabase
        .from("businesses")
        .delete()
        .eq("id", businessId)

      if (businessError) {
        console.error("[DELETE USER] Business deletion error:", businessError)
        errors.push(`business: ${businessError.message}`)
        // Continue anyway - business might have RLS issues or already be deleted
      } else {
        console.log("[DELETE USER] Business deleted:", businessId)
      }
    }

    // Tables that have ON DELETE CASCADE to auth.users - these will be auto-deleted
    // But we delete them explicitly to ensure they're gone before we hit any blocking FKs

    // Tables with user_id FK (ON DELETE CASCADE) - safe to delete
    await safeDelete(serviceSupabase, "vehicles", "user_id", userId)
    await safeDelete(serviceSupabase, "bookings", "user_id", userId)
    await safeDelete(serviceSupabase, "leads", "user_id", userId)
    await safeDelete(serviceSupabase, "messages", "user_id", userId)
    await safeDelete(serviceSupabase, "deposit_portal_config", "user_id", userId)
    await safeDelete(serviceSupabase, "business_branding", "user_id", userId)
    await safeDelete(serviceSupabase, "custom_domains", "user_id", userId)
    await safeDelete(serviceSupabase, "user_sessions", "user_id", userId)
    await safeDelete(serviceSupabase, "calendar_syncs", "user_id", userId)
    await safeDelete(serviceSupabase, "telegram_link_codes", "user_id", userId)
    await safeDelete(serviceSupabase, "telegram_bot_logs", "user_id", userId)
    await safeDelete(serviceSupabase, "instagram_connections", "user_id", userId)
    await safeDelete(serviceSupabase, "agreements", "user_id", userId)
    await safeDelete(serviceSupabase, "inspections", "user_id", userId)
    await safeDelete(serviceSupabase, "deliveries", "user_id", userId)
    await safeDelete(serviceSupabase, "reactivation_campaign_messages", "user_id", userId)
    await safeDelete(serviceSupabase, "reactivation_campaigns", "user_id", userId)
    await safeDelete(serviceSupabase, "reactivation_contacts", "user_id", userId)
    await safeDelete(serviceSupabase, "reactivation_templates", "user_id", userId)
    await safeDelete(serviceSupabase, "reactivation_settings", "user_id", userId)
    await safeDelete(serviceSupabase, "crm_oauth_tokens", "user_id", userId)
    await safeDelete(serviceSupabase, "crm_notes", "user_id", userId)
    await safeDelete(serviceSupabase, "crm_events", "user_id", userId)
    await safeDelete(serviceSupabase, "crm_activity_log", "user_id", userId)
    await safeDelete(serviceSupabase, "payment_links", "user_id", userId)
    await safeDelete(serviceSupabase, "integration_requests", "user_id", userId)

    // Tables with nullable FKs to profiles (NO CASCADE) - must set to null
    await safeSetNull(serviceSupabase, "access_codes", "used_by", userId)
    await safeSetNull(serviceSupabase, "client_invoices", "created_by", userId)
    await safeSetNull(serviceSupabase, "crm_leads", "user_id", userId)
    await safeSetNull(serviceSupabase, "data_deletion_requests", "user_id", userId)

    // Now delete the profile
    console.log("[DELETE USER] Deleting profile...")
    const { error: profileError } = await serviceSupabase
      .from("profiles")
      .delete()
      .eq("id", userId)

    if (profileError) {
      console.error("[DELETE USER] Profile deletion FAILED:", profileError)
      // This is a critical error - we need to report what's blocking it
      return NextResponse.json({
        error: `Failed to delete profile: ${profileError.message}. This may indicate a foreign key constraint that wasn't cleaned up.`,
        details: profileError
      }, { status: 500 })
    }
    console.log("[DELETE USER] Profile deleted successfully")

    // Finally delete from auth.users
    console.log("[DELETE USER] Deleting auth user...")
    const { error: authDeleteError } = await serviceSupabase.auth.admin.deleteUser(userId)

    if (authDeleteError) {
      console.error("[DELETE USER] Auth deletion FAILED:", authDeleteError)
      // Profile is already deleted, so return partial success
      return NextResponse.json({
        success: true,
        warning: `Profile deleted but auth user removal failed: ${authDeleteError.message}`
      })
    }
    console.log("[DELETE USER] Auth user deleted successfully")

    return NextResponse.json({
      success: true,
      message: "User and all associated data deleted successfully"
    })
  } catch (error) {
    console.error("[DELETE USER] Unexpected error:", error)
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({
      error: `Internal server error: ${message}`,
      errors
    }, { status: 500 })
  }
}
