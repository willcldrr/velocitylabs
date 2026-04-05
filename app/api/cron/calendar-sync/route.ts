import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { fetchAndParseIcal, filterRelevantEvents } from "@/lib/ical-parser"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

// Use service role for cron jobs (no user context)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/cron/calendar-sync
 * Automated cron job to sync all Turo calendars
 * Call this endpoint every 2 hours via Vercel Cron or external scheduler
 */
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    // Verify cron secret (optional but recommended for production)
    const authHeader = request.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET

    if (!cronSecret) {
      log.error("CRON_SECRET not configured", undefined)
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 })
    }
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get all vehicles with Turo iCal URLs
    const { data: vehicles, error: vehiclesError } = await supabase
      .from("vehicles")
      .select("id, name, turo_ical_url, user_id")
      .not("turo_ical_url", "is", null)

    if (vehiclesError) {
      log.error("Error fetching vehicles:", vehiclesError)
      return NextResponse.json({ error: "Failed to fetch vehicles" }, { status: 500 })
    }

    if (!vehicles || vehicles.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No vehicles with Turo iCal URLs found",
        synced: 0,
      })
    }

    let successCount = 0
    let errorCount = 0

    for (const vehicle of vehicles) {
      try {
        // Fetch and parse iCal
        const events = await fetchAndParseIcal(vehicle.turo_ical_url)
        const relevantEvents = filterRelevantEvents(events)

        // Upsert events
        for (const event of relevantEvents) {
          await supabase.from("calendar_syncs").upsert(
            {
              user_id: vehicle.user_id,
              vehicle_id: vehicle.id,
              source: "turo",
              external_id: event.uid,
              event_summary: event.summary,
              start_date: event.dtstart.toISOString().split("T")[0],
              end_date: event.dtend.toISOString().split("T")[0],
              synced_at: new Date().toISOString(),
            },
            {
              onConflict: "vehicle_id,source,external_id",
            }
          )
        }

        // Update last sync timestamp
        await supabase
          .from("vehicles")
          .update({ last_turo_sync: new Date().toISOString() })
          .eq("id", vehicle.id)

        successCount++
      } catch (err) {
        log.error(`Cron sync error for vehicle ${vehicle.id}:`, err)
        errorCount++
      }
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${successCount} vehicles, ${errorCount} errors`,
      synced: successCount,
      errors: errorCount,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    log.error("Cron calendar sync error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
