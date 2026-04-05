import { NextRequest, NextResponse } from "next/server"
import twilio from "twilio"
import { createClient } from "@/lib/supabase/server"
import { z } from "zod"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

const MAX_RECIPIENTS = 100

const bulkSmsSchema = z.object({
  recipients: z
    .array(z.string().min(10, "Phone number too short").max(20, "Phone number too long"))
    .min(1, "At least one recipient is required")
    .max(MAX_RECIPIENTS, `Maximum ${MAX_RECIPIENTS} recipients per request`),
  message: z.string().min(1, "Message is required").max(1600, "Message too long"),
})

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    // Authenticate using Supabase auth
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const body = await request.json()

    const parseResult = bulkSmsSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { recipients, message } = parseResult.data

    const twilioClient = getTwilioClient()
    const fromNumber = process.env.TWILIO_PHONE_NUMBER

    let successCount = 0
    let failureCount = 0
    const errors: { recipient: string; error: string }[] = []

    // Send SMS to each recipient
    const results = await Promise.allSettled(
      recipients.map(async (to) => {
        const twilioMessage = await twilioClient.messages.create({
          body: message,
          from: fromNumber,
          to,
        })
        return { to, sid: twilioMessage.sid }
      })
    )

    for (const result of results) {
      if (result.status === "fulfilled") {
        successCount++
      } else {
        failureCount++
        const reason = result.reason as Error
        errors.push({
          recipient: "unknown",
          error: reason.message || "Failed to send",
        })
      }
    }

    // Log bulk send to messages table for each successful recipient
    // We match recipients to results by index
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        // Try to find a lead by phone number so we can log the message
        const phone = recipients[i]
        const { data: lead } = await supabase
          .from("leads")
          .select("id")
          .or(`phone.eq.${phone},phone.eq.+${phone.replace(/^\+/, "")}`)
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle()

        if (lead) {
          await supabase.from("messages").insert({
            user_id: user.id,
            lead_id: lead.id,
            content: message,
            direction: "outbound",
          })
        }
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      successCount,
      failureCount,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error: any) {
    log.error("Bulk SMS error:", error)
    return NextResponse.json(
      { error: error.message || "Failed to send bulk SMS" },
      { status: 500 }
    )
  }
}
