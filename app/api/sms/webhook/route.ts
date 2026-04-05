import { NextRequest, NextResponse } from "next/server"
import twilio from "twilio"
import { createClient } from "@supabase/supabase-js"
import {
  generateAIResponse,
  findOrCreateLead,
  saveMessage,
} from "@/lib/sms-ai"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { claimWebhookEvent, markWebhookEventProcessed } from "@/lib/webhook-idempotency"

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * Validate Twilio webhook signature to prevent spoofed requests
 */
function validateTwilioSignature(
  request: NextRequest,
  params: Record<string, string>
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    console.error("TWILIO_AUTH_TOKEN not configured")
    return false
  }

  const signature = request.headers.get("x-twilio-signature")
  if (!signature) {
    console.error("Missing X-Twilio-Signature header")
    return false
  }

  // Build the full URL that Twilio used to sign the request
  const url = process.env.TWILIO_WEBHOOK_URL || `${process.env.NEXT_PUBLIC_APP_URL}/api/sms/webhook`

  // Validate using Twilio's helper
  const isValid = twilio.validateRequest(authToken, signature, url, params)

  if (!isValid) {
    console.error("Invalid Twilio signature - request may be spoofed")
  }

  return isValid
}

// Look up user by their configured Twilio phone number
async function getUserIdByPhoneNumber(phoneNumber: string): Promise<string | null> {
  const supabase = getSupabase()

  // Normalize to last 10 digits for matching
  const normalizedPhone = phoneNumber.replace(/\D/g, "").slice(-10)

  const { data: settings } = await supabase
    .from("ai_settings")
    .select("user_id, business_phone")

  if (settings) {
    for (const s of settings) {
      const storedNormalized = (s.business_phone || "").replace(/\D/g, "").slice(-10)
      if (storedNormalized && storedNormalized === normalizedPhone) {
        return s.user_id
      }
    }
  }
  return null
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 100, window: 60 })
  if (limited) return limited

  try {
    const twilioClient = getTwilioClient()
    const formData = await request.formData()

    // Convert FormData to plain object for signature validation
    const params: Record<string, string> = {}
    formData.forEach((value, key) => {
      params[key] = value.toString()
    })

    // Validate Twilio signature to prevent spoofed requests
    if (!validateTwilioSignature(request, params)) {
      return new NextResponse("Invalid signature", { status: 403 })
    }

    const from = params.From
    const to = params.To
    const body = params.Body
    const messageSid = params.MessageSid

    if (!from || !body || !to) {
      return new NextResponse("Missing required fields", { status: 400 })
    }

    // Idempotency: Twilio retries on our 5xx responses. If we've already
    // processed this MessageSid, short-circuit with an empty TwiML response
    // so the customer isn't double-replied.
    const claim = await claimWebhookEvent("twilio", messageSid, "sms.inbound")
    if (!claim.claimed) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`
      return new NextResponse(twiml, { status: 200, headers: { "Content-Type": "text/xml" } })
    }

    // Look up the user by the Twilio number they received the SMS on
    const userId = await getUserIdByPhoneNumber(to)
    if (!userId) {
      console.error(`No user configured for phone number: ${to}`)
      return new NextResponse("No user configured for this number", { status: 404 })
    }

    // Find or create the lead
    const lead = await findOrCreateLead(userId, from)
    if (!lead) {
      console.error("Could not find or create lead")
      return new NextResponse("Lead error", { status: 500 })
    }

    // Save the incoming message
    await saveMessage(userId, lead.id, body, "inbound")

    // Check if AI is disabled for this lead (human takeover)
    const { data: leadData } = await getSupabase()
      .from("leads")
      .select("ai_disabled")
      .eq("id", lead.id)
      .single()

    if (leadData?.ai_disabled) {
      // AI is paused — business owner is handling manually, just save the message
      const twiml = new (await import("twilio")).twiml.MessagingResponse()
      return new NextResponse(twiml.toString(), {
        headers: { "Content-Type": "text/xml" },
      })
    }

    // Generate AI response
    const aiResult = await generateAIResponse(userId, lead.id, body, lead.name)

    // Save the outgoing message
    await saveMessage(userId, lead.id, aiResult.response, "outbound")

    // Send the SMS response via Twilio
    await twilioClient.messages.create({
      body: aiResult.response,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
    })

    // Log without PII
    console.log(`SMS response sent [Model: ${aiResult.model}, Cost: $${aiResult.cost.totalCost.toFixed(4)}]`)

    // Return TwiML response (Twilio expects this)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`

    await markWebhookEventProcessed(claim.rowId, "processed")
    return new NextResponse(twiml, {
      status: 200,
      headers: {
        "Content-Type": "text/xml",
      },
    })
  } catch (error) {
    console.error("SMS webhook error:", error)
    return new NextResponse("Internal error", { status: 500 })
  }
}

// Handle GET for webhook verification
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 100, window: 60 })
  if (limited) return limited

  return new NextResponse("SMS webhook is active", { status: 200 })
}
