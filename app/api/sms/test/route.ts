import { NextRequest, NextResponse } from "next/server"
import twilio from "twilio"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )
}

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", user.id).single()
    if (!profile?.is_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const client = getTwilioClient()

    // Test the connection by fetching account info
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID!).fetch()

    return NextResponse.json({
      success: true,
      status: account.status,
      friendlyName: account.friendlyName,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    })
  } catch (error: any) {
    log.error("Twilio test error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to connect to Twilio",
      },
      { status: 500 }
    )
  }
}
