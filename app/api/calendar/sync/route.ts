import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { fetchAndParseIcal, filterRelevantEvents } from "@/lib/ical-parser"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

interface SyncResult {
  vehicleId: string
  vehicleName: string
  success: boolean
  eventsFound: number
  eventsImported: number
  error?: string
}

/**
 * POST /api/calendar/sync
 * Manually trigger calendar sync for a specific vehicle or all vehicles
 */
export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const vehicleId = body.vehicleId as string | undefined

    // Get vehicles with Turo iCal URLs
    let query = supabase
      .from("vehicles")
      .select("id, name, turo_ical_url, user_id")
      .eq("user_id", user.id)
      .not("turo_ical_url", "is", null)

    if (vehicleId) {
      query = query.eq("id", vehicleId)
    }

    const { data: vehicles, error: vehiclesError } = await query

    if (vehiclesError) {
      log.error("Error fetching vehicles:", vehiclesError)
      return NextResponse.json({ error: "Failed to fetch vehicles" }, { status: 500 })
    }

    if (!vehicles || vehicles.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No vehicles with Turo iCal URLs found",
        results: [],
      })
    }

    const results: SyncResult[] = []

    for (const vehicle of vehicles) {
      const result: SyncResult = {
        vehicleId: vehicle.id,
        vehicleName: vehicle.name,
        success: false,
        eventsFound: 0,
        eventsImported: 0,
      }

      try {
        // Fetch and parse iCal
        const events = await fetchAndParseIcal(vehicle.turo_ical_url)
        const relevantEvents = filterRelevantEvents(events)
        result.eventsFound = relevantEvents.length

        // Upsert events into calendar_syncs
        for (const event of relevantEvents) {
          const { error: upsertError } = await supabase
            .from("calendar_syncs")
            .upsert(
              {
                user_id: user.id,
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

          if (!upsertError) {
            result.eventsImported++
          }
        }

        // Update last sync timestamp
        await supabase
          .from("vehicles")
          .update({ last_turo_sync: new Date().toISOString() })
          .eq("id", vehicle.id)

        result.success = true
      } catch (err) {
        result.error = err instanceof Error ? err.message : "Unknown error"
        log.error(`Sync error for vehicle ${vehicle.id}:`, err)
      }

      results.push(result)
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${results.filter((r) => r.success).length} of ${results.length} vehicles`,
      results,
    })
  } catch (error) {
    log.error("Calendar sync error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * GET /api/calendar/sync
 * Get sync status for vehicles
 */
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get vehicles with their sync info
    const { data: vehicles, error } = await supabase
      .from("vehicles")
      .select("id, name, turo_ical_url, last_turo_sync")
      .eq("user_id", user.id)
      .not("turo_ical_url", "is", null)

    if (error) {
      return NextResponse.json({ error: "Failed to fetch vehicles" }, { status: 500 })
    }

    // Get recent synced events count
    const vehicleIds = vehicles?.map((v) => v.id) || []
    const { data: syncCounts } = await supabase
      .from("calendar_syncs")
      .select("vehicle_id")
      .in("vehicle_id", vehicleIds)
      .gte("end_date", new Date().toISOString().split("T")[0])

    const countByVehicle: Record<string, number> = {}
    syncCounts?.forEach((s) => {
      countByVehicle[s.vehicle_id] = (countByVehicle[s.vehicle_id] || 0) + 1
    })

    return NextResponse.json({
      vehicles: vehicles?.map((v) => ({
        ...v,
        upcomingEvents: countByVehicle[v.id] || 0,
      })),
    })
  } catch (error) {
    log.error("Get sync status error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
