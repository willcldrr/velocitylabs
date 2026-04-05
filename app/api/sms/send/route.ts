import { NextRequest, NextResponse } from "next/server"
import twilio from "twilio"
import { createClient as createServiceClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { z } from "zod"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

const sendSmsSchema = z.object({
  to: z.string().min(10, "Phone number too short").max(20, "Phone number too long"),
  message: z.string().min(1, "Message is required").max(1600, "Message too long"),
  leadId: z.string().uuid().optional(),
})

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )
}

function getSupabaseService() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const twilioClient = getTwilioClient()
    const supabaseService = getSupabaseService()

    const body = await request.json()

    const parseResult = sendSmsSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { to, message, leadId } = parseResult.data

    // Send SMS via Twilio
    const twilioMessage = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to,
    })

    // Save message to database if leadId provided
    if (leadId) {
      await supabaseService.from("messages").insert({
        user_id: user.id,
        lead_id: leadId,
        content: message,
        direction: "outbound",
      })
    }

    return NextResponse.json({
      success: true,
      messageId: twilioMessage.sid,
    })
  } catch (error: any) {
    log.error("Send SMS error:", error)
    return NextResponse.json(
      { error: error.message || "Failed to send SMS" },
      { status: 500 }
    )
  }
}
