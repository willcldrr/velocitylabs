import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { safeFetch } from "@/lib/safe-fetch"

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"
  const settingsUrl = new URL("/dashboard/admin/crm?tab=settings", baseUrl)

  // Handle error from Google
  if (error) {
    settingsUrl.searchParams.set("error", error)
    return NextResponse.redirect(settingsUrl)
  }

  if (!code) {
    settingsUrl.searchParams.set("error", "no_code")
    return NextResponse.redirect(settingsUrl)
  }

  const supabase = await createClient()

  // Get current user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL("/login", baseUrl))
  }

  // Verify admin status
  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", user.id).single()
  if (!profile?.is_admin) {
    return NextResponse.redirect(new URL("/dashboard", baseUrl))
  }

  // Verify state
  if (state) {
    try {
      const stateData = JSON.parse(Buffer.from(state, "base64").toString())
      if (stateData.userId !== user.id) {
        settingsUrl.searchParams.set("error", "invalid_state")
        return NextResponse.redirect(settingsUrl)
      }
      // Check if state is not too old (5 minutes)
      if (Date.now() - stateData.timestamp > 5 * 60 * 1000) {
        settingsUrl.searchParams.set("error", "state_expired")
        return NextResponse.redirect(settingsUrl)
      }
    } catch {
      settingsUrl.searchParams.set("error", "invalid_state")
      return NextResponse.redirect(settingsUrl)
    }
  }

  // Get OAuth config from database
  const { data: config, error: configError } = await supabase
    .from("crm_oauth_config")
    .select("*")
    .eq("provider", "google")
    .single()

  if (configError || !config) {
    settingsUrl.searchParams.set("error", "no_config")
    return NextResponse.redirect(settingsUrl)
  }

  // Exchange code for tokens
  try {
    const tokenResponse = await safeFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: config.client_id,
        client_secret: config.client_secret,
        redirect_uri: config.redirect_uri,
        grant_type: "authorization_code",
      }),
      timeoutMs: 30_000,
    })

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json()
      console.error("Token exchange error:", errorData)
      settingsUrl.searchParams.set("error", "token_exchange_failed")
      return NextResponse.redirect(settingsUrl)
    }

    const tokens = await tokenResponse.json()

    // Get user email from Google
    let providerEmail = null
    try {
      const userInfoResponse = await safeFetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
        timeoutMs: 10_000,
      })
      if (userInfoResponse.ok) {
        const userInfo = await userInfoResponse.json()
        providerEmail = userInfo.email
      }
    } catch (e) {
      console.error("Failed to get user info:", e)
    }

    // Calculate token expiration
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null

    // Store tokens in database (upsert)
    const { error: upsertError } = await supabase
      .from("crm_oauth_tokens")
      .upsert(
        {
          user_id: user.id,
          provider: "google",
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || null,
          token_expires_at: expiresAt,
          scope: tokens.scope || null,
          provider_email: providerEmail,
        },
        {
          onConflict: "user_id,provider",
        }
      )

    if (upsertError) {
      console.error("Failed to store tokens:", upsertError)
      settingsUrl.searchParams.set("error", "storage_failed")
      return NextResponse.redirect(settingsUrl)
    }

    // Success - redirect back to settings
    settingsUrl.searchParams.set("success", "connected")
    return NextResponse.redirect(settingsUrl)
  } catch (e) {
    console.error("OAuth callback error:", e)
    settingsUrl.searchParams.set("error", "unknown_error")
    return NextResponse.redirect(settingsUrl)
  }
}
