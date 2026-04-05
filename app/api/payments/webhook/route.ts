// LB-4: uses namespaced idempotency ledger key "stripe:payments" so this
// route cannot race the booking-deposit route (app/api/stripe-webhook) on
// the same Stripe event_id. This route owns the Instagram/SMS payment flow
// (lead → checkout → bookings row created here).
// NOTE: the Stripe dashboard must be configured to deliver to BOTH endpoint
// URLs — that is a human operator step.
import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"
import { createClient } from "@supabase/supabase-js"
import { generateResponse, ChatMessage } from "@/lib/anthropic"
import { sendInstagramMessage } from "@/lib/instagram"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { claimWebhookEvent, markWebhookEventProcessed } from "@/lib/webhook-idempotency"

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-02-25.clover",
  })
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Generate an AI confirmation response for deposit payment
async function generateDepositConfirmationResponse(
  businessName: string,
  customerName: string,
  vehicleName: string,
  startDate: string,
  endDate: string,
  depositAmount: number,
  tone: string = "friendly",
  channel: "sms" | "instagram" = "sms"
): Promise<string> {
  const toneInstructions: Record<string, string> = {
    friendly: "Be warm, casual, and enthusiastic. Feel like texting a friend who just made an exciting decision.",
    professional: "Be polished and business-like, but still warm and congratulatory.",
    luxury: "Provide a premium, white-glove concierge experience. Be sophisticated and elegant.",
    energetic: "Be super excited and enthusiastic! Show genuine excitement about their upcoming experience.",
  }

  const systemPrompt = `You are an AI assistant for ${businessName || "an exotic car rental business"}. A customer just successfully paid their deposit, and you need to send them a confirmation and next steps.

TONE: ${toneInstructions[tone] || toneInstructions.friendly}

BOOKING DETAILS:
- Customer: ${customerName}
- Vehicle: ${vehicleName}
- Dates: ${startDate} to ${endDate}
- Deposit Paid: $${depositAmount}

YOUR TASK:
Write a brief, enthusiastic confirmation message that:
1. Confirms their deposit was received and their booking is secured
2. Mentions the vehicle and dates
3. Lets them know you'll be in touch soon with pickup details
4. Thanks them for choosing the business

${channel === "sms"
  ? "Keep it SHORT - this is SMS, max 2-3 sentences. Be concise but warm."
  : "Keep it concise but can be slightly longer than SMS. Use line breaks for readability if needed."
}

DO NOT include any [EXTRACTED] blocks or special markers. Just write the natural message.`

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "Generate a deposit confirmation message for this customer."
    }
  ]

  try {
    const result = await generateResponse(systemPrompt, messages, {
      model: "claude-haiku-4-5-20251001",
      maxTokens: 200,
      temperature: 0.8,
      forceModel: true, // No escalation needed for confirmations
    })

    return result.content
  } catch (error) {
    console.error("Error generating AI response:", error)
    // Fallback to a standard message if AI fails
    return `Your deposit of $${depositAmount} has been confirmed! Your ${vehicleName} is reserved for ${startDate} to ${endDate}. We'll be in touch with pickup details soon. Thanks for booking with us!`
  }
}

export async function POST(request: NextRequest) {
  const limited = applyRateLimit(request, { limit: 100, window: 60 })
  if (limited) return limited

  const stripe = getStripe()
  const supabase = getSupabase()

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
  // stripe-webhook's claim (or vice versa) for the same Stripe event_id.
  const claim = await claimWebhookEvent("stripe:payments", event.id, event.type)
  if (!claim.claimed) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  // Handle the event
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session

    console.log("Payment successful for session:", session.id)

    const metadata = session.metadata
    if (!metadata) {
      // LB-8: terminal — nothing to process. Mark the ledger so we never retry.
      console.error("No metadata in session")
      await markWebhookEventProcessed(claim.rowId, "processed", "no_metadata")
      return NextResponse.json({ received: true, terminal: "no_metadata" })
    }

    const leadId = metadata.lead_id
    const metadataUserId = metadata.user_id // User ID passed from checkout
    const vehicleId = metadata.vehicle_id
    const startDate = metadata.start_date
    const endDate = metadata.end_date
    const customerPhone = metadata.customer_phone
    const customerName = metadata.customer_name
    const totalAmount = parseFloat(metadata.total_amount || "0")
    const depositAmount = parseFloat(metadata.deposit_amount || "0")

    // Validate required fields
    if (!vehicleId || !startDate || !endDate) {
      // LB-8: terminal — malformed metadata cannot be salvaged by retry.
      console.error("Missing required metadata fields:", { vehicleId, startDate, endDate })
      await markWebhookEventProcessed(claim.rowId, "processed", "missing_metadata")
      return NextResponse.json({ received: true, terminal: "missing_metadata" })
    }

    try {
      let lead: any = null
      let userId: string | null = metadataUserId || null // Use metadata user_id first

      // Try to get the lead if we have a lead_id
      if (leadId) {
        const { data: leadData } = await supabase
          .from("leads")
          .select("user_id, name, phone, email, instagram_user_id, instagram_username")
          .eq("id", leadId)
          .single()

        lead = leadData
        if (!userId) userId = leadData?.user_id
      }

      // If no lead found but we have customer phone, try to find by phone
      if (!lead && customerPhone) {
        const cleanPhone = customerPhone.replace(/\D/g, "")
        const { data: leadByPhone } = await supabase
          .from("leads")
          .select("id, user_id, name, phone, email, instagram_user_id, instagram_username")
          .or(`phone.ilike.%${cleanPhone}%`)
          .limit(1)
          .single()

        if (leadByPhone) {
          lead = leadByPhone
          if (!userId) userId = leadByPhone.user_id
        }
      }

      // If still no user, try to get user from vehicle
      if (!userId && vehicleId) {
        const { data: vehicle } = await supabase
          .from("vehicles")
          .select("user_id")
          .eq("id", vehicleId)
          .single()

        userId = vehicle?.user_id
      }

      if (!userId) {
        // LB-8: terminal — we cannot route this payment to any tenant.
        console.error("Could not determine user_id for booking")
        await markWebhookEventProcessed(claim.rowId, "processed", "no_user_id")
        return NextResponse.json({ received: true, terminal: "no_user_id" })
      }

      console.log("Creating booking with userId:", userId, "vehicleId:", vehicleId)

      // Verify the paid amount matches the expected deposit
      const paidAmountCents = session.amount_total || 0
      const expectedDepositCents = Math.round(depositAmount * 100)
      if (Math.abs(paidAmountCents - expectedDepositCents) > 1) {
        // LB-8: terminal — amount mismatch is not fixable by retry.
        console.error(`AMOUNT MISMATCH: paid ${paidAmountCents} cents, expected ${expectedDepositCents} cents for vehicle ${vehicleId}`)
        await markWebhookEventProcessed(claim.rowId, "processed", "amount_mismatch")
        return NextResponse.json({ received: true, terminal: "amount_mismatch" })
      }

      // LB-5b: pre-compute the confirmation message BEFORE the atomic write
      // so the RPC can persist it in the same transaction as the booking +
      // lead update. AI failure falls back to a canned string inside
      // generateDepositConfirmationResponse.
      let vehicleNameForMessage = "your vehicle"
      let businessNameForMessage = "our exotic car rental"
      let toneForMessage = "friendly"
      let isInstagramLeadForSend = false
      try {
        const { data: vehicle } = await supabase
          .from("vehicles")
          .select("make, model, year")
          .eq("id", vehicleId)
          .single()
        if (vehicle) {
          vehicleNameForMessage = `${vehicle.year} ${vehicle.make} ${vehicle.model}`
        }
        const { data: aiSettings } = await supabase
          .from("ai_settings")
          .select("business_name, tone")
          .eq("user_id", userId)
          .single()
        if (aiSettings) {
          businessNameForMessage = aiSettings.business_name || businessNameForMessage
          toneForMessage = aiSettings.tone || toneForMessage
        }
        isInstagramLeadForSend = !!lead?.instagram_user_id
      } catch (lookupErr) {
        // Non-fatal — message will use fallback names. Let the RPC proceed.
        console.error("[payments/webhook] vehicle/ai_settings lookup failed (non-fatal)", lookupErr)
      }

      const channel: "sms" | "instagram" = isInstagramLeadForSend ? "instagram" : "sms"
      const confirmationMessage = await generateDepositConfirmationResponse(
        businessNameForMessage,
        customerName || lead?.name || "Customer",
        vehicleNameForMessage,
        startDate,
        endDate,
        depositAmount,
        toneForMessage,
        channel
      )

      // LB-5b: single atomic RPC replaces the previous sequential
      //   1. UPDATE leads
      //   2. INSERT bookings
      //   3. INSERT messages
      // chain. Supabase-js has no multi-statement txn; the Postgres function
      // `confirm_booking_and_lead` (migration 20260405140000) wraps all
      // three in one transaction and catches 23P01 from the LB-5a overlap
      // constraint, re-raising as `booking_conflict: ...`.
      // LB-12: prefer the currency that the checkout route stamped into
      // metadata (create-checkout does this). Fall back to env default.
      const metadataCurrency = (metadata.currency || "").toString().toUpperCase()
      const resolvedCurrency =
        metadataCurrency || (process.env.DEFAULT_CURRENCY || "USD").toUpperCase()
      const { data: rpcBookingId, error: rpcError } = await supabase.rpc(
        "confirm_booking_and_lead",
        {
          p_lead_id: lead?.id || leadId || null,
          p_user_id: userId,
          p_vehicle_id: vehicleId,
          p_start_date: startDate,
          p_end_date: endDate,
          p_total_amount: totalAmount,
          p_deposit_amount: depositAmount,
          p_currency: resolvedCurrency,
          p_stripe_session_id: session.id,
          p_stripe_payment_intent: (session.payment_intent as string) || null,
          p_customer_name: customerName || lead?.name || "Customer",
          p_customer_email: session.customer_email || lead?.email || null,
          p_customer_phone: customerPhone || lead?.phone || null,
          p_confirmation_message: confirmationMessage,
          p_lead_notes: `Deposit paid: $${depositAmount} via Stripe`,
        }
      )

      if (rpcError) {
        const msg = (rpcError as { message?: string }).message || String(rpcError)
        // LB-5b: surface the LB-5a overlap violation as a 409 terminal state.
        // Stripe has already charged the customer; retrying will never succeed
        // because the date range is taken. Ops must refund out-of-band.
        // TODO(HP-2): queue a pending_notifications row so the refund + apology
        // SMS can be dispatched from a cron instead of being dropped here.
        if (msg.includes("booking_conflict")) {
          console.error("[payments/webhook] booking_conflict (LB-5a)", { sessionId: session.id, vehicleId, startDate, endDate })
          await markWebhookEventProcessed(claim.rowId, "processed", "booking_conflict")
          return NextResponse.json(
            { error: "booking_conflict", message: "vehicle already booked for those dates" },
            { status: 409 }
          )
        }
        // Anything else is transient — let the outer catch turn it into a 500.
        throw rpcError
      }

      console.log("Booking created via RPC:", rpcBookingId)

      // LB-5b: Twilio/Instagram confirmation send stays AFTER the RPC. If the
      // provider is down the RPC already committed (customer is paid + booked
      // + message row stored), which is the right semantics — we'd rather
      // retry the physical send than roll back a successful booking.
      // TODO(HP-2): write a `pending_notifications` row on send failure and
      // retry from a cron so the customer always eventually hears back.
      try {
        console.log(`Sending ${channel} confirmation:`, confirmationMessage)

        // Send via the appropriate channel. The message row was ALREADY
        // persisted inside the LB-5b RPC; this block only does the physical
        // provider send.
        if (isInstagramLeadForSend && lead?.instagram_user_id) {
          const result = await sendInstagramMessage(lead.instagram_user_id, confirmationMessage)
          if (result.success) {
            console.log("Instagram confirmation sent successfully, messageId:", result.messageId)
          } else {
            console.error("Failed to send Instagram confirmation:", result.error)
          }
        } else if (customerPhone || lead?.phone) {
          const twilio = await import("twilio")
          const twilioClient = twilio.default(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
          )

          await twilioClient.messages.create({
            body: confirmationMessage,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: customerPhone || lead?.phone,
          })

          console.log("SMS confirmation sent successfully")
        }
      } catch (confirmationError) {
        // LB-5b: send failure is non-fatal — booking is already committed.
        // TODO(HP-2): enqueue pending_notifications row for cron retry.
        console.error("Error sending AI confirmation (non-fatal, booking already committed):", confirmationError)
      }

    } catch (error) {
      // LB-8: previously returned 200 { received: true } which told Stripe
      // to stop retrying on transient Supabase/network errors. Now we ledger
      // as "failed" and return 500 so Stripe redelivers, unless we already
      // returned early above with a terminal reason.
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error("[payments/webhook] internal error", { eventId: event.id, error }) // TODO(LB-7): replace with log.error + Sentry.captureException
      await markWebhookEventProcessed(claim.rowId, "failed", errorMessage)
      return NextResponse.json({ error: "internal" }, { status: 500 })
    }
  }

  await markWebhookEventProcessed(claim.rowId, "processed")
  return NextResponse.json({ received: true })
}
