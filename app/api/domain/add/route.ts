import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { safeFetch } from "@/lib/safe-fetch"
import { log } from "@/lib/log"

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    const { domain } = await request.json()

    if (!domain) {
      return NextResponse.json({ error: "Domain is required" }, { status: 400 })
    }

    // Verify user is authenticated
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Clean the domain
    const cleanDomain = domain.replace(/^https?:\/\//, '').toLowerCase()

    // Check if Vercel API is configured
    const vercelToken = process.env.VERCEL_API_TOKEN
    const projectId = process.env.VERCEL_PROJECT_ID
    const teamId = process.env.VERCEL_TEAM_ID

    if (!vercelToken || !projectId) {
      // Vercel not configured - just return success (manual domain addition required)
      return NextResponse.json({
        success: true,
        message: "Domain saved. Manual Vercel configuration required.",
        manualSetup: true
      })
    }

    // Add domain to Vercel project
    const vercelUrl = teamId
      ? `https://api.vercel.com/v10/projects/${projectId}/domains?teamId=${teamId}`
      : `https://api.vercel.com/v10/projects/${projectId}/domains`

    const response = await safeFetch(vercelUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: cleanDomain,
      }),
      timeoutMs: 10_000,
    })

    const data = await response.json()

    if (!response.ok) {
      // Check for common errors
      if (data.error?.code === "domain_already_in_use") {
        // Domain already added - this is fine
        return NextResponse.json({
          success: true,
          message: "Domain is already configured in Vercel",
          alreadyExists: true
        })
      }

      log.error("Vercel API error:", data)
      return NextResponse.json({
        success: false,
        error: data.error?.message || "Failed to add domain to Vercel",
        vercelError: data.error
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      message: "Domain added to Vercel successfully",
      domain: data
    })
  } catch (error) {
    log.error("Add domain error:", error)
    return NextResponse.json(
      { error: "Failed to add domain" },
      { status: 500 }
    )
  }
}
