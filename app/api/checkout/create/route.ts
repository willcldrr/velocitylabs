import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"
import { lookupPaymentToken, decodePaymentToken, claimPaymentLinkForCheckout } from "@/lib/payment-link"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { decrypt } from "@/lib/crypto"
import { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } from "@/lib/currency"
import { log } from "@/lib/log"

const checkoutSchema = z.object({
  token: z.string().min(1, "Payment token is required").max(500, "Invalid token"),
})

export const runtime = "nodejs"

function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase environment variables not configured")
  }

  return createClient(supabaseUrl, supabaseKey)
}

/**
 * Look up Stripe keys from user's deposit portal config (NOT from payment link)
 * This prevents storing sensitive keys in the payment_links table
 */
async function getStripeKeysForUser(userId: string): Promise<{ secretKey: string | null; publishableKey: string | null }> {
  const supabase = getSupabaseClient()

  // LB-6 dual-read: prefer encrypted trio, fall back to legacy plaintext.
  const { data, error } = await supabase
    .from("deposit_portal_config")
    .select(
      "stripe_secret_key, stripe_publishable_key, encrypted_stripe_secret_key, stripe_secret_key_iv, stripe_secret_key_tag"
    )
    .eq("user_id", userId)
    .single()

  if (error || !data) {
    return { secretKey: null, publishableKey: null }
  }

  let secretKey: string | null = null
  if (
    data.encrypted_stripe_secret_key &&
    data.stripe_secret_key_iv &&
    data.stripe_secret_key_tag
  ) {
    try {
      secretKey = decrypt({
        ciphertext: data.encrypted_stripe_secret_key,
        iv: data.stripe_secret_key_iv,
        tag: data.stripe_secret_key_tag,
      })
    } catch (err) {
      log.error("[checkout/create] Failed to decrypt tenant Stripe key", undefined)
    }
  }
  if (!secretKey) {
    secretKey = data.stripe_secret_key ?? null
  }

  return {
    secretKey,
    publishableKey: data.stripe_publishable_key,
  }
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    const body = await request.json()

    const parseResult = checkoutSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { token } = parseResult.data

    // Try database lookup first (for short tokens)
    let paymentData = await lookupPaymentToken(token)

    // Fall back to legacy decode for old-style tokens
    if (!paymentData) {
      paymentData = decodePaymentToken(token)
    }

    if (!paymentData) {
      return NextResponse.json(
        { error: "Invalid or expired payment link" },
        { status: 400 }
      )
    }

    // Look up Stripe keys from user's config (secure - not stored in payment link)
    let stripeSecretKey = process.env.STRIPE_SECRET_KEY

    if (paymentData.userId) {
      const userStripeKeys = await getStripeKeysForUser(paymentData.userId)
      if (userStripeKeys.secretKey) {
        stripeSecretKey = userStripeKeys.secretKey
      }
    }

    if (!stripeSecretKey) {
      return NextResponse.json(
        { error: "Stripe is not configured for this business" },
        { status: 500 }
      )
    }

    // Create Stripe instance with the appropriate key
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2026-02-25.clover",
    })

    // Build success and cancel URLs
    const origin = request.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
    const successUrl = `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${origin}/checkout/${token}`

    // LB-12: resolve currency from the tenant's business row. Falls back to
    // env default if the businesses.currency column isn't live yet.
    let businessCurrencyRaw: string | undefined
    if (paymentData.userId) {
      try {
        const supabase = getSupabaseClient()
        const { data: bizRow } = await supabase
          .from("businesses")
          .select("currency")
          .eq("owner_user_id", paymentData.userId)
          .maybeSingle()
        businessCurrencyRaw = (bizRow as { currency?: string } | null)?.currency
      } catch {
        // Column may not exist yet — use env fallback.
      }
    }
    const envDefault = (process.env.DEFAULT_CURRENCY || DEFAULT_CURRENCY).toUpperCase()
    let resolvedCurrency = (businessCurrencyRaw || envDefault).toUpperCase()
    if (!SUPPORTED_CURRENCIES[resolvedCurrency]) {
      log.warn("[checkout] unsupported currency, falling back to usd", { v0: {
        businessId: paymentData.userId,
        currency: resolvedCurrency,
      } })
      resolvedCurrency = "USD"
    }
    const stripeCurrency = resolvedCurrency.toLowerCase()

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: undefined,
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: `${paymentData.vehicleName} Rental Deposit`,
              description: `${paymentData.startDate} to ${paymentData.endDate} | Total rental: $${paymentData.totalAmount.toLocaleString()}`,
              images: [],
            },
            unit_amount: paymentData.depositAmount * 100,
          },
          quantity: 1,
        },
      ],
      metadata: {
        // Include lead_id and user_id for webhook to create booking
        lead_id: paymentData.leadId || "",
        user_id: paymentData.userId || "",
        vehicle_id: paymentData.vehicleId,
        start_date: paymentData.startDate,
        end_date: paymentData.endDate,
        customer_phone: paymentData.customerPhone,
        customer_name: paymentData.customerName,
        total_amount: paymentData.totalAmount.toString(),
        deposit_amount: paymentData.depositAmount.toString(),
        // LB-12: propagate to payments/webhook for bookings.currency.
        currency: resolvedCurrency,
        // Additional fields for reference
        paymentToken: token,
        vehicleName: paymentData.vehicleName,
        dailyRate: paymentData.dailyRate.toString(),
        businessName: paymentData.businessName || "Velocity Exotics",
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    })

    // Atomically claim the payment link (prevents double-spend)
    if (token.includes("-")) {
      const claimed = await claimPaymentLinkForCheckout(token, session.id)
      if (!claimed) {
        // Link was already used - this is a race condition or replay attack
        log.error("Payment link already used or not found:", token)
        return NextResponse.json(
          { error: "This payment link has already been used" },
          { status: 400 }
        )
      }
    }

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
    })
  } catch (error: any) {
    log.error("Stripe checkout error:", error)
    return NextResponse.json(
      { error: error.message || "Failed to create checkout session" },
      { status: 500 }
    )
  }
}
