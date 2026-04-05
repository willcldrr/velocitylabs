import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { safeFetch } from "@/lib/safe-fetch"

/**
 * Check if Instagram API is configured
 */
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID
  const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN
  const appSecret = process.env.INSTAGRAM_APP_SECRET

  // Check if all required credentials are present
  const configured = !!(accessToken && accountId && verifyToken && appSecret)

  if (!configured) {
    return NextResponse.json({
      configured: false,
      message: "Instagram API credentials not configured",
      missing: {
        accessToken: !accessToken,
        accountId: !accountId,
        verifyToken: !verifyToken,
        appSecret: !appSecret,
      },
    })
  }

  // Optionally verify the token is valid by making a test API call
  try {
    const response = await safeFetch(
      `https://graph.facebook.com/v19.0/${accountId}?fields=id,username&access_token=${accessToken}`,
      { timeoutMs: 10_000 }
    )

    if (response.ok) {
      const data = await response.json()
      return NextResponse.json({
        configured: true,
        connected: true,
        accountId: data.id,
        username: data.username,
      })
    } else {
      const error = await response.json()
      return NextResponse.json({
        configured: true,
        connected: false,
        error: error.error?.message || "Failed to verify Instagram connection",
      })
    }
  } catch (error) {
    return NextResponse.json({
      configured: true,
      connected: false,
      error: "Failed to connect to Instagram API",
    })
  }
}
