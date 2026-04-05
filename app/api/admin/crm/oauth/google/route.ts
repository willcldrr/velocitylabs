import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  const supabase = await createClient()

  // Check if user is authenticated and admin
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"))
  }

  // Check if admin
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single()

  if (!profile?.is_admin) {
    return NextResponse.redirect(new URL("/dashboard", process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"))
  }

  // Get OAuth config from database
  const { data: config, error: configError } = await supabase
    .from("crm_oauth_config")
    .select("*")
    .eq("provider", "google")
    .single()

  if (configError || !config) {
    // Redirect back to settings with error
    return NextResponse.redirect(
      new URL("/dashboard/admin/crm?tab=settings&error=no_config", process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000")
    )
  }

  // Build Google OAuth URL
  const baseUrl = "https://accounts.google.com/o/oauth2/v2/auth"

  // Generate state for CSRF protection
  const state = Buffer.from(JSON.stringify({
    userId: user.id,
    timestamp: Date.now(),
  })).toString("base64")

  // Store state in a cookie or session (for now we'll pass it through)
  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    response_type: "code",
    scope: config.scopes || "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    prompt: "consent",
    state: state,
  })

  const authUrl = `${baseUrl}?${params.toString()}`

  return NextResponse.redirect(authUrl)
}
