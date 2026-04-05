import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import twilio from "twilio"
import { z } from "zod"
import { defaultLeadStatus } from "@/lib/lead-status"
import { checkRateLimit, getRateLimitHeaders, RATE_LIMITS } from "@/lib/rate-limit"
import { resolveSurveyOrApiKey } from "@/lib/survey-auth"
import { log } from "@/lib/log"

// Input validation schema
const leadCaptureSchema = z.object({
  name: z.string().min(1, "Name is required").max(200, "Name too long"),
  email: z.string().email("Invalid email").max(255).optional().nullable(),
  phone: z.string().min(10, "Phone number too short").max(20, "Phone number too long"),
  vehicle_interest: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  source: z.string().max(100).optional().nullable(),
  sms_consent: z.boolean().optional(),
  consent_timestamp: z.string().optional(),
})

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )
}

// CORS headers for cross-origin requests from lead capture sites
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Survey-Slug",
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders })
}

export async function POST(request: NextRequest) {
  // Rate limit by IP address
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
             request.headers.get("x-real-ip") ||
             "unknown"

  const rateLimitResult = await checkRateLimit(`lead-capture:${ip}`, RATE_LIMITS.leadCapture)

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: {
          ...corsHeaders,
          ...getRateLimitHeaders(rateLimitResult),
        }
      }
    )
  }

  try {
    const supabase = getSupabase()

    // Parse and validate body
    const body = await request.json()

    // Validate input with Zod schema
    const parseResult = leadCaptureSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten().fieldErrors },
        { status: 400, headers: corsHeaders }
      )
    }

    const { name, email, phone, vehicle_interest, notes, source, sms_consent, consent_timestamp } = parseResult.data

    // Handle A2P compliance form submissions (no API key required)
    if (source === "lead-capture-a2p") {
      // Validate required fields
      if (!name || !phone) {
        return NextResponse.json(
          { error: "Name and phone are required" },
          { status: 400, headers: corsHeaders }
        )
      }

      // Clean phone number
      let cleanPhone = phone.replace(/\D/g, "")
      if (cleanPhone.length === 10) {
        cleanPhone = "1" + cleanPhone
      }
      if (cleanPhone.length < 10) {
        return NextResponse.json(
          { error: "Invalid phone number" },
          { status: 400, headers: corsHeaders }
        )
      }
      const formattedPhone = "+" + cleanPhone

      // Store in a2p_leads table (create if needed) or just log success
      // For A2P compliance, just return success - actual lead handling can be configured separately
      // Note: PII is not logged for security

      return NextResponse.json(
        {
          success: true,
          message: "Lead captured successfully",
          is_new: true
        },
        { status: 201, headers: corsHeaders }
      )
    }

    // Resolve auth: accepts either X-API-Key (legacy third-party widgets) or
    // X-Survey-Slug (hosted survey at /lead/[slug]). The survey-slug path
    // replaces the old flow where the browser held a real api_key.
    const authResult = await resolveSurveyOrApiKey(request, supabase)
    if (!authResult.ok) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status, headers: corsHeaders }
      )
    }
    const auth = authResult.auth

    // Body already parsed above for A2P check
    // const { name, email, phone, vehicle_interest, notes, source } = body

    // Validate required fields
    if (!name || !phone) {
      return NextResponse.json(
        { error: "Name and phone are required" },
        { status: 400, headers: corsHeaders }
      )
    }

    // Clean phone number - ensure it has country code
    let cleanPhone = phone.replace(/\D/g, "")
    if (cleanPhone.length === 10) {
      cleanPhone = "1" + cleanPhone // Add US country code
    }
    if (cleanPhone.length < 10) {
      return NextResponse.json(
        { error: "Invalid phone number" },
        { status: 400, headers: corsHeaders }
      )
    }
    const formattedPhone = "+" + cleanPhone

    // Check for existing lead with same phone number for this user
    const { data: existingLead } = await supabase
      .from("leads")
      .select("id")
      .eq("user_id", auth.userId)
      .or(`phone.ilike.%${cleanPhone.slice(-10)}%`)
      .single()

    if (existingLead) {
      // Update existing lead with new info if provided
      const { error: updateError } = await supabase
        .from("leads")
        .update({
          name: name || undefined,
          email: email || undefined,
          notes: notes ? `${notes}\n\n[Updated from lead capture]` : undefined,
          vehicle_interest: vehicle_interest || undefined,
        })
        .eq("id", existingLead.id)

      if (updateError) {
        log.error("Error updating lead:", updateError)
      }

      // Bookkeeping: only update api_key last_used_at when this request actually
      // used an api_key (survey-slug auth has no key to stamp).
      if (auth.source === "api_key" && auth.apiKeyId) {
        await supabase
          .from("api_keys")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", auth.apiKeyId)
      }

      return NextResponse.json(
        {
          success: true,
          message: "Lead already exists, updated info",
          lead_id: existingLead.id,
          is_new: false
        },
        { status: 200, headers: corsHeaders }
      )
    }

    // Create new lead
    const { data: newLead, error: insertError } = await supabase
      .from("leads")
      .insert({
        user_id: auth.userId,
        api_key_id: auth.apiKeyId,
        name,
        email: email || null,
        phone: formattedPhone,
        vehicle_interest: vehicle_interest || null,
        notes: notes || null,
        source: source || auth.apiKeyDomain || (auth.source === "survey_slug" ? "hosted_survey" : "lead_capture"),
        status: defaultLeadStatus,
      })
      .select("id")
      .single()

    if (insertError) {
      log.error("Error creating lead:", insertError)
      return NextResponse.json(
        { error: "Failed to create lead" },
        { status: 500, headers: corsHeaders }
      )
    }

    // Bookkeeping: only update api_key last_used_at for api-key auth path.
    if (auth.source === "api_key" && auth.apiKeyId) {
      await supabase
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", auth.apiKeyId)
    }

    // Send initial SMS to the new lead
    try {
      const twilioClient = getTwilioClient()

      // Get AI settings for personalized greeting
      const { data: aiSettings } = await supabase
        .from("ai_settings")
        .select("business_name, tone")
        .eq("user_id", auth.userId)
        .single()

      // Get vehicles for context
      const { data: vehicles } = await supabase
        .from("vehicles")
        .select("make, model, year")
        .eq("user_id", auth.userId)
        .eq("status", "available")
        .limit(3)

      // Generate greeting message
      const greeting = generateGreeting(
        name,
        aiSettings?.business_name || "our exotic car rental",
        aiSettings?.tone || "friendly",
        vehicles || [],
        vehicle_interest ?? null,
        notes ?? null
      )

      // Send SMS
      await twilioClient.messages.create({
        body: greeting,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: formattedPhone,
      })

      // Save the outbound message
      await supabase.from("messages").insert({
        user_id: auth.userId,
        lead_id: newLead.id,
        content: greeting,
        direction: "outbound",
      })

      // Update lead status
      await supabase
        .from("leads")
        .update({ status: "new" })
        .eq("id", newLead.id)

      // SMS sent successfully

    } catch (smsError) {
      log.error("Failed to send initial SMS:", smsError)
      // Don't fail the lead capture if SMS fails
    }

    return NextResponse.json(
      {
        success: true,
        message: "Lead captured successfully",
        lead_id: newLead.id,
        is_new: true
      },
      { status: 201, headers: corsHeaders }
    )

  } catch (error) {
    log.error("Lead capture error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    )
  }
}

function generateGreeting(
  leadName: string,
  businessName: string,
  tone: string,
  vehicles: any[],
  vehicleInterest: string | null,
  notes: string | null
): string {
  const firstName = leadName.split(" ")[0]

  // Build vehicle list
  const vehicleList = vehicles.length > 0
    ? vehicles.map(v => `${v.year} ${v.make} ${v.model}`).slice(0, 3).join(", ")
    : "our exotic fleet"

  // Parse vehicle/date info from notes if available
  let dateInfo = ""
  if (notes) {
    const dateMatch = notes.match(/Dates?:\s*([^,\n]+)/i)
    if (dateMatch) dateInfo = dateMatch[1].trim()
  }

  // Generate based on tone
  if (vehicleInterest && dateInfo) {
    return `Hey ${firstName}! ${businessName} here. ${vehicleInterest} for ${dateInfo}? Let me check availability!`
  }

  if (vehicleInterest) {
    return `Hey ${firstName}! ${businessName} here. Great choice on the ${vehicleInterest}! What dates?`
  }

  const greetings: Record<string, string[]> = {
    friendly: [
      `Hey ${firstName}! Thanks for reaching out to ${businessName}. What dates are you looking at?`,
      `Hi ${firstName}! ${businessName} here. Which car interests you?`,
    ],
    professional: [
      `Hello ${firstName}, thank you for contacting ${businessName}. What dates work for you?`,
    ],
    luxury: [
      `Hello ${firstName}. Welcome to ${businessName}. How may I assist you today?`,
    ],
    energetic: [
      `Hey ${firstName}! ${businessName} here! Ready to drive something amazing? What dates?`,
    ],
  }

  const toneGreetings = greetings[tone] || greetings.friendly
  return toneGreetings[Math.floor(Math.random() * toneGreetings.length)]
}
