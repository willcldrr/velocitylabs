import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { safeFetch } from "@/lib/safe-fetch"
import { log } from "@/lib/log"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID

// GET - List all domains with their owners
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  // Verify admin
  const authHeader = request.headers.get("authorization")
  if (!authHeader) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const token = authHeader.replace("Bearer ", "")
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Check if user is admin
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single()

  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  // Get all custom domains with user info
  const { data: domains, error } = await supabase
    .from("custom_domains")
    .select(`
      *,
      profiles:user_id (
        company_name,
        email
      )
    `)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ domains })
}

// POST - Add a domain to Vercel and database
export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  // Verify admin
  const authHeader = request.headers.get("authorization")
  if (!authHeader) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const token = authHeader.replace("Bearer ", "")
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Check if user is admin
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single()

  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const { domain, userId } = await request.json()

  if (!domain || !userId) {
    return NextResponse.json({ error: "Domain and userId are required" }, { status: 400 })
  }

  // Clean domain
  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim()

  // Validate domain format
  const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/
  if (!domainRegex.test(cleanDomain)) {
    return NextResponse.json({ error: "Invalid domain format" }, { status: 400 })
  }

  // Check if domain already exists
  const { data: existing } = await supabase
    .from("custom_domains")
    .select("id")
    .eq("domain", cleanDomain)
    .single()

  if (existing) {
    return NextResponse.json({ error: "Domain already registered" }, { status: 400 })
  }

  // Add to Vercel if API token is configured
  let vercelStatus = "pending"
  if (VERCEL_API_TOKEN && VERCEL_PROJECT_ID) {
    try {
      const vercelUrl = VERCEL_TEAM_ID
        ? `https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/domains?teamId=${VERCEL_TEAM_ID}`
        : `https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/domains`

      const vercelResponse = await safeFetch(vercelUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VERCEL_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: cleanDomain }),
        timeoutMs: 10_000,
      })

      const vercelData = await vercelResponse.json()

      if (vercelResponse.ok) {
        vercelStatus = "added_to_vercel"
      } else {
        log.error("Vercel API error:", vercelData)
        // Continue anyway - domain can be added to Vercel manually
      }
    } catch (err) {
      log.error("Vercel API error:", err)
    }
  }

  // Add to database
  const { data: newDomain, error: dbError } = await supabase
    .from("custom_domains")
    .insert({
      user_id: userId,
      domain: cleanDomain,
      ssl_status: vercelStatus,
    })
    .select()
    .single()

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({
    domain: newDomain,
    vercelStatus,
    message: vercelStatus === "added_to_vercel"
      ? "Domain added to Vercel and database"
      : "Domain added to database. Add to Vercel manually if needed.",
  })
}

// DELETE - Remove a domain
export async function DELETE(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  // Verify admin
  const authHeader = request.headers.get("authorization")
  if (!authHeader) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const token = authHeader.replace("Bearer ", "")
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Check if user is admin
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single()

  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const domainId = searchParams.get("id")
  const domainName = searchParams.get("domain")

  if (!domainId) {
    return NextResponse.json({ error: "Domain ID is required" }, { status: 400 })
  }

  // Remove from Vercel if configured
  if (VERCEL_API_TOKEN && VERCEL_PROJECT_ID && domainName) {
    try {
      const vercelUrl = VERCEL_TEAM_ID
        ? `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains/${domainName}?teamId=${VERCEL_TEAM_ID}`
        : `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains/${domainName}`

      await safeFetch(vercelUrl, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${VERCEL_API_TOKEN}`,
        },
        timeoutMs: 10_000,
      })
    } catch (err) {
      log.error("Vercel API error:", err)
    }
  }

  // Remove from database
  const { error: dbError } = await supabase
    .from("custom_domains")
    .delete()
    .eq("id", domainId)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
