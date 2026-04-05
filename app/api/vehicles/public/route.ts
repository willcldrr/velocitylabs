import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"

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
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
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

    // Get all active vehicles for this user
    const { data: vehicles, error: vehiclesError } = await supabase
      .from("vehicles")
      .select("id, name, make, model, year, type, daily_rate, image_url")
      .eq("user_id", keyData.user_id)
      .eq("status", "available")
      .order("make", { ascending: true })

    if (vehiclesError) {
      console.error("Error fetching vehicles:", vehiclesError)
      return NextResponse.json(
        { error: "Failed to fetch vehicles" },
        { status: 500, headers: corsHeaders }
      )
    }

    return NextResponse.json(
      { vehicles: vehicles || [] },
      { status: 200, headers: corsHeaders }
    )

  } catch (error) {
    console.error("Vehicles API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    )
  }
}
