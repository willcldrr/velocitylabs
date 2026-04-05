import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * Look up Stripe secret key for a user from their deposit portal config
 */
async function getStripeKeyForUser(userId: string): Promise<string | null> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from("deposit_portal_config")
    .select("stripe_secret_key")
    .eq("user_id", userId)
    .single()

  if (error || !data?.stripe_secret_key) {
    return null
  }

  return data.stripe_secret_key
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 20, window: 60 })
  if (limited) return limited

  try {
    const { sessionId } = await request.json()

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session ID required" },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // First check if booking already exists (webhook may have created it)
    const { data: existingBooking } = await supabase
      .from("bookings")
      .select("*")
      .eq("stripe_session_id", sessionId)
      .single()

    if (existingBooking) {
      // Booking already created by webhook
      return NextResponse.json({
        success: true,
        booking: existingBooking,
        source: "webhook"
      })
    }

    // Booking doesn't exist - verify with Stripe and create it
    // Look up the payment link by stripe_session_id to get the user_id
    const { data: paymentLink } = await supabase
      .from("payment_links")
      .select("user_id")
      .eq("stripe_session_id", sessionId)
      .single()

    // Determine which Stripe key to use
    let stripeSecretKey = process.env.STRIPE_SECRET_KEY

    // If we found a user from payment link, try to use their key
    if (paymentLink?.user_id) {
      const userStripeKey = await getStripeKeyForUser(paymentLink.user_id)
      if (userStripeKey) {
        stripeSecretKey = userStripeKey
      }
    }

    if (!stripeSecretKey) {
      return NextResponse.json(
        { error: "Stripe not configured" },
        { status: 500 }
      )
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2026-02-25.clover",
    })

    const session = await stripe.checkout.sessions.retrieve(sessionId)

    if (session.payment_status !== "paid") {
      return NextResponse.json(
        { error: "Payment not completed" },
        { status: 400 }
      )
    }

    const metadata = session.metadata
    if (!metadata) {
      return NextResponse.json(
        { error: "No metadata found" },
        { status: 400 }
      )
    }

    const userId = metadata.user_id
    const vehicleId = metadata.vehicle_id
    const startDate = metadata.start_date
    const endDate = metadata.end_date
    const customerName = metadata.customer_name
    const customerPhone = metadata.customer_phone
    const totalAmount = parseFloat(metadata.total_amount || "0")
    const depositAmount = parseFloat(metadata.deposit_amount || "0")
    const leadId = metadata.lead_id

    if (!vehicleId || !startDate || !endDate) {
      return NextResponse.json(
        { error: "Missing required booking data" },
        { status: 400 }
      )
    }

    // Determine user_id - try metadata first, then lookup from vehicle
    let finalUserId = userId
    if (!finalUserId && vehicleId) {
      const { data: vehicle } = await supabase
        .from("vehicles")
        .select("user_id")
        .eq("id", vehicleId)
        .single()
      finalUserId = vehicle?.user_id
    }

    if (!finalUserId) {
      return NextResponse.json(
        { error: "Could not determine user for booking" },
        { status: 400 }
      )
    }

    // Create the booking
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        user_id: finalUserId,
        vehicle_id: vehicleId,
        customer_name: customerName || "Customer",
        customer_phone: customerPhone || null,
        customer_email: session.customer_email || null,
        start_date: startDate,
        end_date: endDate,
        total_amount: totalAmount,
        deposit_amount: depositAmount,
        deposit_paid: true,
        status: "confirmed",
        stripe_session_id: sessionId,
        stripe_payment_intent: session.payment_intent as string,
        lead_id: leadId || null,
      })
      .select()
      .single()

    if (bookingError) {
      log.error("Error creating booking:", bookingError)
      return NextResponse.json(
        { error: "Failed to create booking: " + bookingError.message },
        { status: 500 }
      )
    }

    // Update lead status if we have a lead_id
    if (leadId) {
      await supabase
        .from("leads")
        .update({
          status: "booked",
          notes: `Deposit paid: $${depositAmount} via Stripe`,
        })
        .eq("id", leadId)
    }

    // Get vehicle details for the response
    const { data: vehicle } = await supabase
      .from("vehicles")
      .select("make, model, year")
      .eq("id", vehicleId)
      .single()

    return NextResponse.json({
      success: true,
      booking: {
        ...booking,
        vehicle: vehicle
      },
      source: "success_page"
    })

  } catch (error: any) {
    log.error("Verify checkout error:", error)
    return NextResponse.json(
      { error: error.message || "Failed to verify payment" },
      { status: 500 }
    )
  }
}
