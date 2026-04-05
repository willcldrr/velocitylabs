export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createClient } from "@supabase/supabase-js"
import { z } from "zod"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { decrypt } from "@/lib/crypto"
import { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } from "@/lib/currency"

const paymentCheckoutSchema = z.object({
  leadId: z.string().uuid("Invalid lead ID"),
  vehicleId: z.string().uuid("Invalid vehicle ID"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)"),
  // depositAmount removed - calculated server-side from AI settings deposit_percentage
  customerPhone: z.string().max(20).optional(),
  customerName: z.string().max(200).optional(),
  customerEmail: z.string().email().optional().nullable(),
})

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 15, window: 60 })
  if (limited) return limited

  try {
    const supabase = getSupabase()

    const body = await request.json()

    const parseResult = paymentCheckoutSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { leadId, vehicleId, startDate, endDate, customerPhone, customerName, customerEmail } = parseResult.data

    // Get the lead to find the user_id (business owner)
    const { data: lead } = await supabase
      .from("leads")
      .select("user_id")
      .eq("id", leadId)
      .single()

    if (!lead) {
      return NextResponse.json(
        { error: "Lead not found" },
        { status: 404 }
      )
    }

    // Get the business's Stripe configuration.
    // LB-6 dual-read: prefer the encrypted trio, fall back to legacy
    // plaintext for rows that predate the backfill.
    const { data: depositConfig } = await supabase
      .from("deposit_portal_config")
      .select(
        "stripe_secret_key, stripe_publishable_key, encrypted_stripe_secret_key, stripe_secret_key_iv, stripe_secret_key_tag"
      )
      .eq("user_id", lead.user_id)
      .single()

    let tenantStripeSecretKey: string | null = null
    if (
      depositConfig?.encrypted_stripe_secret_key &&
      depositConfig?.stripe_secret_key_iv &&
      depositConfig?.stripe_secret_key_tag
    ) {
      try {
        tenantStripeSecretKey = decrypt({
          ciphertext: depositConfig.encrypted_stripe_secret_key,
          iv: depositConfig.stripe_secret_key_iv,
          tag: depositConfig.stripe_secret_key_tag,
        })
      } catch (err) {
        console.error("[payments/create-checkout] Failed to decrypt tenant Stripe key")
      }
    }
    if (!tenantStripeSecretKey && depositConfig?.stripe_secret_key) {
      tenantStripeSecretKey = depositConfig.stripe_secret_key
    }

    // Use business's Stripe key if available, otherwise fall back to platform key
    const stripeSecretKey = tenantStripeSecretKey || process.env.STRIPE_SECRET_KEY

    if (!stripeSecretKey) {
      return NextResponse.json(
        { error: "Stripe is not configured. Please add your Stripe API keys in Settings > Deposit Portal." },
        { status: 400 }
      )
    }

    // Create Stripe instance with the business's key
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2026-02-25.clover",
    })

    // Get vehicle details
    const { data: vehicle } = await supabase
      .from("vehicles")
      .select("name, make, model, year, daily_rate")
      .eq("id", vehicleId)
      .single()

    if (!vehicle) {
      return NextResponse.json(
        { error: "Vehicle not found" },
        { status: 404 }
      )
    }

    // Check for booking conflicts
    const { data: conflicts } = await supabase
      .from("bookings")
      .select("id")
      .eq("vehicle_id", vehicleId)
      .eq("user_id", lead.user_id)
      .in("status", ["confirmed", "pending"])
      .lte("start_date", endDate)
      .gte("end_date", startDate)

    if (conflicts && conflicts.length > 0) {
      return NextResponse.json(
        { error: "This vehicle is already booked for the selected dates. Please choose different dates." },
        { status: 409 }
      )
    }

    // Calculate rental days
    const start = new Date(startDate)
    const end = new Date(endDate)
    const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    const totalAmount = days * vehicle.daily_rate

    // Get AI settings for the business to determine deposit percentage
    const { data: aiSettings } = await supabase
      .from("ai_settings")
      .select("deposit_percentage")
      .eq("user_id", lead.user_id)
      .single()

    const depositPercentage = aiSettings?.deposit_percentage || 25
    const depositAmount = totalAmount * depositPercentage / 100

    // LB-12: resolve currency. Try the business row for this tenant
    // (businesses.currency is added by migration 20260405140100); fall back
    // to DEFAULT_CURRENCY from env/lib if the column isn't live yet or the
    // row doesn't exist.
    let businessCurrencyRaw: string | undefined
    try {
      const { data: bizRow } = await supabase
        .from("businesses")
        .select("currency")
        .eq("owner_user_id", lead.user_id)
        .maybeSingle()
      businessCurrencyRaw = (bizRow as { currency?: string } | null)?.currency
    } catch {
      // Column may not exist yet — swallow and use env fallback.
    }
    const envDefault = (process.env.DEFAULT_CURRENCY || DEFAULT_CURRENCY).toUpperCase()
    let resolvedCurrency = (businessCurrencyRaw || envDefault).toUpperCase()
    if (!SUPPORTED_CURRENCIES[resolvedCurrency]) {
      console.warn("[checkout] unsupported currency, falling back to usd", {
        businessId: lead.user_id,
        currency: resolvedCurrency,
      }) // TODO(LB-7)
      resolvedCurrency = "USD"
    }
    const stripeCurrency = resolvedCurrency.toLowerCase()

    // Get the base URL for redirects
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.headers.get("origin") || "http://localhost:3000"

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: customerEmail || undefined,
      metadata: {
        lead_id: leadId,
        vehicle_id: vehicleId,
        start_date: startDate,
        end_date: endDate,
        customer_phone: customerPhone || "",
        customer_name: customerName || "",
        total_amount: totalAmount.toString(),
        deposit_amount: depositAmount.toString(),
        // LB-12: downstream webhook (payments/webhook) reads this to pass
        // into confirm_booking_and_lead so bookings.currency is persisted.
        currency: resolvedCurrency,
      },
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: `Deposit: ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
              description: `Rental from ${startDate} to ${endDate} (${days} day${days > 1 ? "s" : ""})`,
            },
            unit_amount: Math.round(depositAmount * 100), // Stripe uses cents
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          lead_id: leadId,
          vehicle_id: vehicleId,
        },
      },
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancel`,
    })

    // Update lead with pending payment info
    await supabase
      .from("leads")
      .update({
        stripe_session_id: session.id,
        vehicle_interest: vehicleId,
        notes: `Pending deposit: $${depositAmount} for ${startDate} to ${endDate}`,
      })
      .eq("id", leadId)

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url,
    })

  } catch (error: any) {
    console.error("Create checkout error:", error)
    return NextResponse.json(
      { error: error.message || "Failed to create checkout session" },
      { status: 500 }
    )
  }
}
