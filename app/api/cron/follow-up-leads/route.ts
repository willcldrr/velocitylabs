import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { generateResponse, type ChatMessage } from "@/lib/anthropic"
import { sendInstagramMessage, type InstagramCredentials } from "@/lib/instagram"
import { log } from "@/lib/log"

export const dynamic = "force-dynamic"

/**
 * Cron job to send AI-generated follow-up messages to stale leads.
 *
 * Targets:
 *  - "qualified" leads with no response after a configurable window (default 24h)
 *  - "pending" leads (payment link sent, no payment) after a configurable window (default 12h)
 *
 * Guards:
 *  - Skips leads where ai_disabled = true (human takeover)
 *  - Maximum 3 follow-ups per lead (counted as consecutive outbound messages after the last inbound)
 *  - Only processes leads with an instagram_user_id
 *
 * Should be invoked via Vercel Cron or an external scheduler with:
 *   Authorization: Bearer <CRON_SECRET>
 */

const MAX_FOLLOW_UPS = 3
const DEFAULT_QUALIFIED_HOURS = 24
const DEFAULT_PENDING_HOURS = 12

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

interface StaleLead {
  id: string
  name: string
  status: string
  user_id: string
  instagram_user_id: string
  last_message_time: string
}

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  // Verify cron secret (mandatory)
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    log.error("[Follow-Up] CRON_SECRET not configured", undefined)
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = getSupabase()
  const summary = { followedUp: 0, skipped: 0, errors: 0 }

  try {
    // ---------------------------------------------------------------
    // 1. Resolve per-user follow-up settings from ai_settings
    // ---------------------------------------------------------------
    const { data: allSettings } = await supabase
      .from("ai_settings")
      .select("user_id, follow_up_enabled, follow_up_hours")

    // Build a map: user_id -> { enabled, qualifiedHours, pendingHours }
    const settingsMap = new Map<
      string,
      { enabled: boolean; qualifiedHours: number; pendingHours: number }
    >()

    if (allSettings) {
      for (const s of allSettings) {
        const enabled =
          s.follow_up_enabled !== undefined ? Boolean(s.follow_up_enabled) : true
        const qualifiedHours =
          typeof s.follow_up_hours === "number" && s.follow_up_hours > 0
            ? s.follow_up_hours
            : DEFAULT_QUALIFIED_HOURS
        // Pending always uses half the qualified window, floored to the default
        const pendingHours = Math.min(qualifiedHours, DEFAULT_PENDING_HOURS)
        settingsMap.set(s.user_id, { enabled, qualifiedHours, pendingHours })
      }
    }

    // ---------------------------------------------------------------
    // 2. Query leads that might need a follow-up
    // ---------------------------------------------------------------
    // We use the most generous cutoff (12h) to cast a wide net, then
    // filter precisely per-user below.
    const cutoff = new Date(Date.now() - DEFAULT_PENDING_HOURS * 60 * 60 * 1000).toISOString()

    const { data: staleLeads, error: queryError } = await supabase
      .from("leads")
      .select("id, name, status, user_id, instagram_user_id, last_message_time")
      .in("status", ["qualified", "pending"])
      .eq("ai_disabled", false)
      .not("instagram_user_id", "is", null)
      .lt("last_message_time", cutoff)

    if (queryError) {
      log.error("[Follow-Up] Query error:", queryError)
      return NextResponse.json(
        { error: "Database query failed", detail: queryError.message },
        { status: 500 }
      )
    }

    if (!staleLeads || staleLeads.length === 0) {
      return NextResponse.json({ message: "No leads need follow-up", ...summary })
    }

    // ---------------------------------------------------------------
    // 3. Process each lead
    // ---------------------------------------------------------------
    for (const lead of staleLeads as StaleLead[]) {
      try {
        // --- Per-user settings check ---
        const userSettings = settingsMap.get(lead.user_id) ?? {
          enabled: true,
          qualifiedHours: DEFAULT_QUALIFIED_HOURS,
          pendingHours: DEFAULT_PENDING_HOURS,
        }

        if (!userSettings.enabled) {
          summary.skipped++
          continue
        }

        // --- Apply the correct time threshold per status ---
        const requiredHours =
          lead.status === "pending"
            ? userSettings.pendingHours
            : userSettings.qualifiedHours

        const thresholdTime = new Date(
          Date.now() - requiredHours * 60 * 60 * 1000
        )

        if (new Date(lead.last_message_time) > thresholdTime) {
          summary.skipped++
          continue
        }

        // --- Check consecutive outbound count (follow-up cap) ---
        const { data: recentMessages, error: msgError } = await supabase
          .from("messages")
          .select("direction")
          .eq("lead_id", lead.id)
          .order("created_at", { ascending: false })
          .limit(MAX_FOLLOW_UPS + 1)

        if (msgError) {
          log.error(`[Follow-Up] Message query failed for lead ${lead.id}:`, msgError)
          summary.errors++
          continue
        }

        // Count consecutive outbound messages from the most recent backwards
        let consecutiveOutbound = 0
        for (const msg of recentMessages || []) {
          if (msg.direction === "outbound") {
            consecutiveOutbound++
          } else {
            break
          }
        }

        if (consecutiveOutbound >= MAX_FOLLOW_UPS) {
          summary.skipped++
          continue
        }

        // --- Calculate hours since last message ---
        const hoursSinceLastMessage = Math.round(
          (Date.now() - new Date(lead.last_message_time).getTime()) / (1000 * 60 * 60)
        )

        // --- Generate follow-up message via Anthropic ---
        const systemPrompt =
          "You previously helped this customer with a car rental inquiry. " +
          `They haven't responded in ${hoursSinceLastMessage} hours. ` +
          "Send a brief, professional follow-up message. Keep it to 1-2 sentences. " +
          "Don't be pushy."

        const chatMessages: ChatMessage[] = [
          {
            role: "user",
            content: `Generate a follow-up message for ${lead.name || "this customer"} whose status is "${lead.status}".`,
          },
        ]

        let followUpText: string
        try {
          const aiResult = await generateResponse(systemPrompt, chatMessages, {
            model: "claude-haiku-4-5-20251001",
            maxTokens: 150,
            temperature: 0.8,
            forceModel: true,
          })
          followUpText = aiResult.content
        } catch (aiError) {
          log.error(`[Follow-Up] AI generation failed for lead ${lead.id}:`, aiError)
          summary.errors++
          continue
        }

        if (!followUpText || followUpText.trim().length === 0) {
          log.warn(`[Follow-Up] Empty AI response for lead ${lead.id}`)
          summary.errors++
          continue
        }

        // --- Resolve Instagram credentials for the lead's owner ---
        const { data: connection } = await supabase
          .from("instagram_connections")
          .select("access_token, instagram_account_id")
          .eq("user_id", lead.user_id)
          .eq("is_active", true)
          .single()

        let credentials: InstagramCredentials | undefined
        if (connection) {
          credentials = {
            accessToken: connection.access_token,
            accountId: connection.instagram_account_id,
          }
        }

        // --- Send via Instagram DM ---
        const sendResult = await sendInstagramMessage(
          lead.instagram_user_id,
          followUpText,
          credentials
        )

        if (!sendResult.success) {
          log.error(`[Follow-Up] Instagram send failed for lead ${lead.id}:`, sendResult.error)
          summary.errors++
          continue
        }

        // --- Save the outbound message ---
        const { error: saveError } = await supabase.from("messages").insert({
          user_id: lead.user_id,
          lead_id: lead.id,
          content: followUpText,
          direction: "outbound",
        })

        if (saveError) {
          log.error(`[Follow-Up] Failed to save message for lead ${lead.id}:`, saveError)
          // Message was sent but not recorded — count as partial error
          summary.errors++
          continue
        }

        // --- Update last_message_time on the lead ---
        await supabase
          .from("leads")
          .update({
            last_message_time: new Date().toISOString(),
            last_message: followUpText,
            last_message_direction: "outbound",
          })
          .eq("id", lead.id)

        log.info(`[Follow-Up] Sent follow-up to lead ${lead.id} (${lead.name}) — ` +
            `status=${lead.status}, hours_stale=${hoursSinceLastMessage}, ` +
            `consecutive_outbound=${consecutiveOutbound + 1}`)

        summary.followedUp++
      } catch (leadError) {
        log.error(`[Follow-Up] Unexpected error for lead ${lead.id}:`, leadError)
        summary.errors++
      }
    }

    return NextResponse.json({
      message: `Processed ${staleLeads.length} stale leads`,
      ...summary,
    })
  } catch (error) {
    log.error("[Follow-Up] Fatal error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
