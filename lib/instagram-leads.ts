import { createClient } from "@supabase/supabase-js"
import { log } from "@/lib/log"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

interface Lead {
  id: string
  name: string
}

/**
 * Find or create a lead for an Instagram user
 * Searches by instagram_user_id, creates new lead if not found
 */
export async function findOrCreateInstagramLead(
  userId: string,
  instagramUserId: string,
  instagramUsername?: string,
  instagramName?: string
): Promise<Lead | null> {
  const supabase = getSupabase()

  // First, try to find existing lead by Instagram user ID
  const { data: existingLead } = await supabase
    .from("leads")
    .select("id, name")
    .eq("user_id", userId)
    .eq("instagram_user_id", instagramUserId)
    .single()

  if (existingLead) {
    // Update username and fix generic names
    const updates: Record<string, string> = {}
    if (instagramUsername) {
      updates.instagram_username = instagramUsername
    }
    if (existingLead.name.startsWith("Instagram User") && (instagramName || instagramUsername)) {
      updates.name = instagramName || `@${instagramUsername}`
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from("leads").update(updates).eq("id", existingLead.id)
      if (updates.name) existingLead.name = updates.name
    }
    return existingLead
  }

  // Create new lead for this Instagram user
  const leadName = instagramName ||
    (instagramUsername ? `@${instagramUsername}` : `Instagram User ${instagramUserId.slice(-6)}`)

  const { data: newLead, error } = await supabase
    .from("leads")
    .insert({
      user_id: userId,
      name: leadName,
      phone: "", // Instagram users don't have phone initially
      status: "new",
      source: "instagram",
      instagram_user_id: instagramUserId,
      instagram_username: instagramUsername || null,
    })
    .select("id, name")
    .single()

  if (error) {
    log.error("Error creating Instagram lead:", error)
    return null
  }

  return newLead
}

/**
 * Update Instagram lead with collected information
 */
export async function updateInstagramLead(
  leadId: string,
  updates: {
    name?: string
    phone?: string
    email?: string
    vehicle_interest?: string
    collected_vehicle_id?: string
    collected_start_date?: string
    collected_end_date?: string
    ready_for_payment?: boolean
  }
): Promise<boolean> {
  const supabase = getSupabase()

  const { error } = await supabase
    .from("leads")
    .update(updates)
    .eq("id", leadId)

  if (error) {
    log.error("Error updating Instagram lead:", error)
    return false
  }

  return true
}

/**
 * Get lead by Instagram user ID
 */
export async function getLeadByInstagramId(
  userId: string,
  instagramUserId: string
): Promise<Lead | null> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from("leads")
    .select("id, name")
    .eq("user_id", userId)
    .eq("instagram_user_id", instagramUserId)
    .single()

  if (error || !data) {
    return null
  }

  return data
}

/**
 * Check if Instagram AI responses are enabled for a user
 */
export async function isInstagramAIEnabled(userId: string): Promise<boolean> {
  const supabase = getSupabase()

  const { data } = await supabase
    .from("ai_settings")
    .select("instagram_enabled")
    .eq("user_id", userId)
    .single()

  return data?.instagram_enabled ?? false
}

/**
 * Get Instagram-specific greeting if configured
 */
export async function getInstagramGreeting(userId: string): Promise<string | null> {
  const supabase = getSupabase()

  const { data } = await supabase
    .from("ai_settings")
    .select("instagram_greeting")
    .eq("user_id", userId)
    .single()

  return data?.instagram_greeting || null
}
