import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import crypto from "crypto"

/**
 * Initiate Instagram OAuth flow
 * Redirects user to Meta's OAuth authorization page
 */
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  const supabase = await createClient()

  // Verify user is authenticated
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL("/auth/login", request.url))
  }

  const appId = process.env.META_APP_ID
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/instagram/callback`

  if (!appId) {
    return NextResponse.json(
      { error: "Meta App ID not configured" },
      { status: 500 }
    )
  }

  // LB-3: state is a pure random CSRF token. The userId is NOT encoded in
  // it — the callback resolves the real user from the session cookie.
  const state = crypto.randomBytes(32).toString("hex")

  const response = NextResponse.redirect(
    `https://www.facebook.com/v19.0/dialog/oauth?` +
    new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state: state,
      scope: [
        "instagram_basic",
        "instagram_manage_messages",
        "pages_show_list",
        "pages_messaging",
        "pages_manage_metadata",
      ].join(","),
      response_type: "code",
    }).toString()
  )

  response.cookies.set("instagram_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
  })

  return response
}
