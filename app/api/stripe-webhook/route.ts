// LB-4: uses namespaced idempotency ledger key "stripe:bookings" so the two
// Stripe endpoints (this one + app/api/payments/webhook) do not race on the
// same Stripe event_id. This route owns booking_deposit + dashboard_invoices
// + legacy client_invoices. payments/webhook owns the Instagram/SMS flow.
// NOTE: the Stripe dashboard must still be configured to deliver the event
// to BOTH endpoint URLs — that is a human operator step; this code change
// only stops the ledger from letting one endpoint starve the other.
import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { claimWebhookEvent, markWebhookEventProcessed } from "@/lib/webhook-idempotency"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-02-25.clover",
})

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 100, window: 60 })
  if (limited) return limited

  const body = await request.text()
  const signature = request.headers.get("stripe-signature")

  if (!signature) {
    return NextResponse.json({ error: "No signature" }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error("Webhook signature verification failed:", err.message)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  // LB-4: namespaced ledger key so this route's claim cannot starve
  // payments/webhook's claim (or vice versa) for the same Stripe event_id.
  const claim = await claimWebhookEvent("stripe:bookings", event.id, event.type)
  if (!claim.claimed) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session

      const invoiceId = session.metadata?.invoice_id
      const bookingId = session.metadata?.booking_id
      const source = session.metadata?.source

      // Handle booking deposits
      if (source === "booking_deposit" && bookingId) {
        // Verify amount matches expected deposit
        const { data: booking, error: bookingLookupError } = await supabase
          .from("bookings")
          .select("deposit_amount")
          .eq("id", bookingId)
          .single()

        // LB-8: treat lookup-row-not-found as terminal (nothing to do), but
        // a real Supabase error is transient — let it fall through to the
        // outer catch and return 500 so Stripe retries.
        if (bookingLookupError && (bookingLookupError as { code?: string }).code !== "PGRST116") {
          throw bookingLookupError
        }

        if (booking) {
          const expectedAmountCents = Math.round(booking.deposit_amount * 100)
          const paidAmountCents = session.amount_total || 0
          if (Math.abs(paidAmountCents - expectedAmountCents) > 1) {
            // LB-8: amount mismatch is terminal — do NOT retry, mark processed.
            console.error(`AMOUNT MISMATCH for booking ${bookingId}: paid ${paidAmountCents} cents, expected ${expectedAmountCents} cents`)
            await markWebhookEventProcessed(claim.rowId, "processed", "amount_mismatch")
            return NextResponse.json({ received: true, terminal: "amount_mismatch" })
          }
        }

        const { data: updatedBooking, error } = await supabase
          .from("bookings")
          .update({
            deposit_paid: true,
            status: "confirmed",
            stripe_payment_intent_id: session.payment_intent as string,
          })
          .eq("id", bookingId)
          .select("lead_id")
          .single()

        // LB-8: Supabase update failure is transient — throw to outer catch.
        if (error) {
          throw error
        }

        console.log(`Booking ${bookingId} deposit confirmed`)

        // Update lead status to booked
        const leadId = updatedBooking?.lead_id
        if (leadId) {
          const { error: leadError } = await supabase.from("leads").update({ status: 'booked' }).eq("id", leadId)
          if (leadError) throw leadError
        }
      }

      // Handle invoices
      if (invoiceId) {
        // Check which table to update based on source
        if (source === "dashboard_invoices") {
          // Verify amount matches expected invoice total
          const { data: invoice, error: invoiceLookupError } = await supabase
            .from("invoices")
            .select("total_amount")
            .eq("id", invoiceId)
            .single()

          if (invoiceLookupError && (invoiceLookupError as { code?: string }).code !== "PGRST116") {
            throw invoiceLookupError
          }

          if (invoice) {
            const expectedAmountCents = Math.round(invoice.total_amount * 100)
            const paidAmountCents = session.amount_total || 0
            if (Math.abs(paidAmountCents - expectedAmountCents) > 1) {
              console.error(`AMOUNT MISMATCH for invoice ${invoiceId}: paid ${paidAmountCents} cents, expected ${expectedAmountCents} cents`)
              await markWebhookEventProcessed(claim.rowId, "processed", "amount_mismatch")
              return NextResponse.json({ received: true, terminal: "amount_mismatch" })
            }
          }

          // Update dashboard invoices table
          const { error } = await supabase
            .from("invoices")
            .update({
              status: "paid",
              paid_at: new Date().toISOString(),
              stripe_checkout_session_id: session.id,
              stripe_payment_intent_id: session.payment_intent as string,
            })
            .eq("id", invoiceId)

          if (error) throw error
          console.log(`Dashboard invoice ${invoiceId} marked as paid`)
        } else {
          // Verify amount matches expected invoice total
          const { data: clientInvoice, error: clientLookupError } = await supabase
            .from("client_invoices")
            .select("total_amount")
            .eq("id", invoiceId)
            .single()

          if (clientLookupError && (clientLookupError as { code?: string }).code !== "PGRST116") {
            throw clientLookupError
          }

          if (clientInvoice) {
            const expectedAmountCents = Math.round(clientInvoice.total_amount * 100)
            const paidAmountCents = session.amount_total || 0
            if (Math.abs(paidAmountCents - expectedAmountCents) > 1) {
              console.error(`AMOUNT MISMATCH for client invoice ${invoiceId}: paid ${paidAmountCents} cents, expected ${expectedAmountCents} cents`)
              await markWebhookEventProcessed(claim.rowId, "processed", "amount_mismatch")
              return NextResponse.json({ received: true, terminal: "amount_mismatch" })
            }
          }

          // Update client_invoices table (legacy)
          const { error } = await supabase
            .from("client_invoices")
            .update({
              status: "paid",
              paid_at: new Date().toISOString(),
              stripe_checkout_session_id: session.id,
              stripe_payment_intent_id: session.payment_intent as string,
            })
            .eq("id", invoiceId)

          if (error) throw error
          console.log(`Client invoice ${invoiceId} marked as paid`)
        }
      }
    }

    await markWebhookEventProcessed(claim.rowId, "processed")
    return NextResponse.json({ received: true })
  } catch (err) {
    // LB-8: transient / unexpected errors should trigger a Stripe retry.
    // Previously this path returned 200 { received: true } and dropped the
    // event. We now ledger as "failed" and return 500 so Stripe redelivers.
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error("[stripe-webhook] internal error", { eventId: event.id, error: err }) // TODO(LB-7): replace with log.error + Sentry.captureException
    await markWebhookEventProcessed(claim.rowId, "failed", errorMessage)
    return NextResponse.json({ error: "internal" }, { status: 500 })
  }
}
