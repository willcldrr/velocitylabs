import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } from "@/lib/currency"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-02-25.clover",
})

export async function POST(request: NextRequest) {
  const limited = applyRateLimit(request, { limit: 15, window: 60 })
  if (limited) return limited

  try {
    // Authenticate the user
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { invoiceId, clientName, clientEmail, description } = await request.json()

    if (!invoiceId) {
      return NextResponse.json(
        { error: "Invoice ID is required" },
        { status: 400 }
      )
    }

    // Look up the invoice from the database to get the real amount
    const { data: invoice, error: invoiceError } = await supabase
      .from("client_invoices")
      .select("id, total_amount, status")
      .eq("id", invoiceId)
      .single()

    if (invoiceError || !invoice) {
      return NextResponse.json(
        { error: "Invoice not found" },
        { status: 404 }
      )
    }

    if (invoice.status === "paid") {
      return NextResponse.json(
        { error: "Invoice has already been paid" },
        { status: 400 }
      )
    }

    const amount = invoice.total_amount

    // LB-12: resolve currency from the authenticated owner's business row.
    // Falls back to env default if the column isn't live yet.
    let businessCurrencyRaw: string | undefined
    try {
      const { data: bizRow } = await supabase
        .from("businesses")
        .select("currency")
        .eq("owner_user_id", user.id)
        .maybeSingle()
      businessCurrencyRaw = (bizRow as { currency?: string } | null)?.currency
    } catch {
      // Column may not exist yet — use env fallback.
    }
    const envDefault = (process.env.DEFAULT_CURRENCY || DEFAULT_CURRENCY).toUpperCase()
    let resolvedCurrency = (businessCurrencyRaw || envDefault).toUpperCase()
    if (!SUPPORTED_CURRENCIES[resolvedCurrency]) {
      console.warn("[checkout] unsupported currency, falling back to usd", {
        businessId: user.id,
        currency: resolvedCurrency,
      }) // TODO(LB-7)
      resolvedCurrency = "USD"
    }
    const stripeCurrency = resolvedCurrency.toLowerCase()

    const origin = request.headers.get("origin") || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: description || "Velocity Labs Invoice",
              description: `Invoice payment for ${clientName}`,
            },
            unit_amount: Math.round(amount * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${origin}/pay/success?invoice_id=${invoiceId}`,
      cancel_url: `${origin}/pay/${invoiceId}`,
      customer_email: clientEmail || undefined,
      metadata: {
        invoice_id: invoiceId,
      },
    })

    return NextResponse.json({ url: session.url })
  } catch (error: any) {
    console.error("Error creating checkout session:", error)
    return NextResponse.json(
      { error: error.message || "Failed to create checkout session" },
      { status: 500 }
    )
  }
}
