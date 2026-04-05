import { NextRequest, NextResponse } from "next/server"
import { sendInstagramMessage } from "@/lib/instagram"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { safeFetch } from "@/lib/safe-fetch"
import { log } from "@/lib/log"

/**
 * Debug endpoint to test Instagram setup
 * GET /api/instagram/debug - Check configuration
 * POST /api/instagram/debug - Send test message (provide recipientId in body)
 */
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", user.id).single()
  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const config = {
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN ? "SET (" + process.env.INSTAGRAM_ACCESS_TOKEN.substring(0, 10) + "...)" : "NOT SET",
    accountId: process.env.INSTAGRAM_ACCOUNT_ID || "NOT SET",
    verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN ? "SET" : "NOT SET",
    appSecret: process.env.INSTAGRAM_APP_SECRET ? "SET" : "NOT SET",
  }

  // Test API connection
  let apiTest = { success: false, error: "", data: null as any }

  if (process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID) {
    try {
      const response = await safeFetch(
        `https://graph.facebook.com/v19.0/${process.env.INSTAGRAM_ACCOUNT_ID}?fields=id,username,name&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`,
        { timeoutMs: 10_000 }
      )
      const data = await response.json()

      if (response.ok) {
        apiTest = { success: true, error: "", data }
      } else {
        apiTest = { success: false, error: data.error?.message || "Unknown error", data }
      }
    } catch (error) {
      apiTest = { success: false, error: String(error), data: null }
    }
  }

  // Check webhook subscriptions
  let webhookTest = { success: false, error: "", data: null as any }

  if (process.env.INSTAGRAM_ACCESS_TOKEN) {
    try {
      // This requires app access token, not page token - may not work
      const response = await safeFetch(
        `https://graph.facebook.com/v19.0/${process.env.INSTAGRAM_ACCOUNT_ID}/subscribed_apps?access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`,
        { timeoutMs: 10_000 }
      )
      const data = await response.json()
      webhookTest = { success: response.ok, error: data.error?.message || "", data }
    } catch (error) {
      webhookTest = { success: false, error: String(error), data: null }
    }
  }

  return NextResponse.json({
    status: "Debug info for Instagram integration",
    timestamp: new Date().toISOString(),
    configuration: config,
    apiConnectionTest: apiTest,
    webhookSubscription: webhookTest,
    checklist: {
      "1_env_vars_set": !!(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID && process.env.INSTAGRAM_VERIFY_TOKEN && process.env.INSTAGRAM_APP_SECRET),
      "2_api_connection_works": apiTest.success,
      "3_webhook_url": "https://YOUR_DOMAIN/api/instagram/webhook",
      "4_required_permissions": ["instagram_manage_messages", "instagram_basic", "pages_messaging", "pages_manage_metadata"],
      "5_app_mode": "Must be in LIVE mode (not development) for production webhooks",
    },
    troubleshooting: [
      "1. Check if app is in LIVE mode in Meta Developer Console",
      "2. Verify webhook is subscribed to 'messages' field for Instagram",
      "3. Ensure Instagram account is linked to a Facebook Page",
      "4. Check that Page Access Token has correct permissions",
      "5. Verify webhook URL is publicly accessible (not localhost)",
      "6. Check Vercel/server logs for incoming webhook requests",
    ]
  }, { status: 200 })
}

/**
 * POST - Send a test message to verify sending works
 */
export async function POST(request: NextRequest) {
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

    const body = await request.json()
    const { recipientId, message } = body

    if (!recipientId) {
      return NextResponse.json({
        error: "recipientId is required",
        hint: "You need the Instagram-scoped user ID (IGSID) of someone who has messaged your account"
      }, { status: 400 })
    }

    const testMessage = message || "This is a test message from the Velocity Labs AI Assistant!"

    log.info(`[Debug] Sending test message to ${recipientId}: ${testMessage}`)

    const result = await sendInstagramMessage(recipientId, testMessage)

    return NextResponse.json({
      success: result.success,
      result,
      note: "If this failed, check that the recipientId has messaged your Instagram account within the last 24 hours (Meta's messaging window policy)"
    })
  } catch (error) {
    return NextResponse.json({
      error: String(error)
    }, { status: 500 })
  }
}
