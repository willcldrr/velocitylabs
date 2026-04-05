import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders })
}

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = getSupabase()

    // Get API key from header
    const apiKey = request.headers.get("X-API-Key")

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing API key" },
        { status: 401, headers: corsHeaders }
      )
    }

    // Validate API key and get associated user
    const { data: keyData, error: keyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("key", apiKey)
      .single()

    if (keyError || !keyData || !keyData.is_active) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401, headers: corsHeaders }
      )
    }

    // Get optional vehicle_id filter from query params
    const { searchParams } = new URL(request.url)
    const vehicleId = searchParams.get("vehicle_id")

    // Build query for bookings
    let query = supabase
      .from("bookings")
      .select("id, vehicle_id, start_date, end_date, status")
      .eq("user_id", keyData.user_id)
      .in("status", ["confirmed", "pending"])
      .gte("end_date", new Date().toISOString().split("T")[0]) // Only future/current bookings

    if (vehicleId) {
      query = query.eq("vehicle_id", vehicleId)
    }

    const { data: bookings, error: bookingsError } = await query.order("start_date", { ascending: true })

    if (bookingsError) {
      log.error("Error fetching bookings:", bookingsError)
      return NextResponse.json(
        { error: "Failed to fetch availability" },
        { status: 500, headers: corsHeaders }
      )
    }

    // Get all vehicles to provide complete availability picture
    const { data: vehicles } = await supabase
      .from("vehicles")
      .select("id, name, make, model")
      .eq("user_id", keyData.user_id)
      .eq("status", "available")

    // Format response: group bookings by vehicle
    const availabilityByVehicle: Record<string, {
      vehicle: { id: string; name: string; make: string; model: string };
      booked_dates: Array<{ start: string; end: string; status: string }>;
    }> = {}

    // Initialize all vehicles
    for (const vehicle of vehicles || []) {
      availabilityByVehicle[vehicle.id] = {
        vehicle: vehicle,
        booked_dates: []
      }
    }

    // Add bookings to each vehicle
    for (const booking of bookings || []) {
      if (availabilityByVehicle[booking.vehicle_id]) {
        availabilityByVehicle[booking.vehicle_id].booked_dates.push({
          start: booking.start_date,
          end: booking.end_date,
          status: booking.status
        })
      }
    }

    return NextResponse.json(
      {
        availability: Object.values(availabilityByVehicle),
        // Also return flat list of all booked date ranges for simple use cases
        all_bookings: (bookings || []).map(b => ({
          vehicle_id: b.vehicle_id,
          start: b.start_date,
          end: b.end_date
        }))
      },
      { status: 200, headers: corsHeaders }
    )

  } catch (error) {
    log.error("Availability API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    )
  }
}
