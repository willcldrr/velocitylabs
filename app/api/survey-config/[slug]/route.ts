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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = getSupabase()
    const { slug } = await params

    // Look up survey config by slug (no auth required - slug is unique)
    const { data: config, error: configError } = await supabase
      .from("survey_config")
      .select("*")
      .eq("slug", slug)
      .eq("is_active", true)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: "Survey not found" },
        { status: 404, headers: corsHeaders }
      )
    }

    // Get vehicles - either specific ones or all available
    let vehiclesQuery = supabase
      .from("vehicles")
      .select("id, name, make, model, year, type, daily_rate, image_url")
      .eq("user_id", config.user_id)
      .eq("status", "available")

    if (config.vehicle_ids && config.vehicle_ids.length > 0) {
      vehiclesQuery = vehiclesQuery.in("id", config.vehicle_ids)
    }

    const { data: vehicles } = await vehiclesQuery.order("make", { ascending: true })

    // Get availability if dates are being collected
    let availability: any[] = []
    if (config.collect_dates) {
      const { data: bookings } = await supabase
        .from("bookings")
        .select("vehicle_id, start_date, end_date")
        .eq("user_id", config.user_id)
        .in("status", ["confirmed", "pending"])
        .gte("end_date", new Date().toISOString().split("T")[0])

      availability = bookings || []
    }

    // Do NOT return any api_key here. The hosted survey page authenticates
    // submissions by echoing this slug back via the X-Survey-Slug header,
    // which the capture endpoint resolves server-side. Exposing a real
    // api_key to the browser leaked full-scope business credentials.
    return NextResponse.json(
      {
        config: {
          business_name: config.business_name,
          logo_url: config.logo_url,
          primary_color: config.primary_color,
          background_color: config.background_color,
          welcome_title: config.welcome_title,
          welcome_subtitle: config.welcome_subtitle,
          success_title: config.success_title,
          success_subtitle: config.success_subtitle,
          minimum_age: config.minimum_age,
          fields: {
            name: config.collect_name,
            email: config.collect_email,
            phone: config.collect_phone,
            age: config.collect_age,
            dates: config.collect_dates,
            vehicle: config.collect_vehicle,
          },
          require_email: config.require_email,
        },
        vehicles: vehicles || [],
        availability: availability,
      },
      { status: 200, headers: corsHeaders }
    )

  } catch (error) {
    console.error("Survey config error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    )
  }
}
