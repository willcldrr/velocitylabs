import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { safeFetch } from "@/lib/safe-fetch"

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 20, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { domain } = await request.json()

    if (!domain) {
      return NextResponse.json({ error: "Domain is required" }, { status: 400 })
    }

    // Clean the domain (remove protocol if present)
    const cleanDomain = domain.replace(/^https?:\/\//, '').toLowerCase().trim()

    const vercelToken = process.env.VERCEL_API_TOKEN
    const projectId = process.env.VERCEL_PROJECT_ID
    const teamId = process.env.VERCEL_TEAM_ID

    // If Vercel is configured, check domain status directly via Vercel API
    if (vercelToken && projectId) {
      try {
        const vercelUrl = teamId
          ? `https://api.vercel.com/v9/projects/${projectId}/domains/${cleanDomain}?teamId=${teamId}`
          : `https://api.vercel.com/v9/projects/${projectId}/domains/${cleanDomain}`

        const vercelResponse = await safeFetch(vercelUrl, {
          headers: {
            Authorization: `Bearer ${vercelToken}`,
          },
          cache: 'no-store',
          timeoutMs: 10_000,
        })

        if (vercelResponse.ok) {
          const vercelData = await vercelResponse.json()

          // Check if domain is verified in Vercel
          if (vercelData.verified) {
            return NextResponse.json({
              verified: true,
              message: "Domain is verified and active",
              vercelStatus: vercelData
            })
          } else {
            // Domain exists in Vercel but not verified yet
            return NextResponse.json({
              verified: false,
              message: vercelData.verification?.[0]?.reason || "Domain pending verification in Vercel",
              vercelStatus: vercelData,
              verification: vercelData.verification
            })
          }
        } else if (vercelResponse.status === 404) {
          // Domain not added to Vercel yet
          return NextResponse.json({
            verified: false,
            message: "Domain not found in Vercel. Save your settings to add it automatically.",
            notInVercel: true
          })
        }
      } catch (vercelError) {
        console.error("Vercel API error:", vercelError)
      }
    }

    // Fallback: Use DNS check if Vercel API not configured or failed
    try {
      // Use Google's DNS-over-HTTPS API
      const dnsResponse = await safeFetch(
        `https://dns.google/resolve?name=${encodeURIComponent(cleanDomain)}&type=CNAME`,
        { cache: 'no-store', timeoutMs: 10_000 }
      )

      const dnsData = await dnsResponse.json()

      if (dnsData.Answer && dnsData.Answer.length > 0) {
        const cnameRecords = dnsData.Answer
          .filter((record: { type: number }) => record.type === 5)
          .map((record: { data: string }) => record.data.replace(/\.$/, ''))

        const isVerified = cnameRecords.some(
          (record: string) => record.toLowerCase().includes('vercel')
        )

        if (isVerified) {
          return NextResponse.json({
            verified: true,
            message: "DNS configured correctly. Domain should be active.",
            records: cnameRecords
          })
        } else {
          return NextResponse.json({
            verified: false,
            message: "CNAME found but not pointing to Vercel",
            records: cnameRecords
          })
        }
      }

      // Check A records for apex domains
      const aResponse = await safeFetch(
        `https://dns.google/resolve?name=${encodeURIComponent(cleanDomain)}&type=A`,
        { cache: 'no-store', timeoutMs: 10_000 }
      )
      const aData = await aResponse.json()

      // Vercel's A record IPs
      const vercelIPs = ['76.76.21.21', '76.76.21.22', '76.76.21.123']

      if (aData.Answer && aData.Answer.length > 0) {
        const aRecords = aData.Answer
          .filter((r: { type: number }) => r.type === 1)
          .map((r: { data: string }) => r.data)

        const pointsToVercel = aRecords.some((ip: string) => vercelIPs.includes(ip))

        if (pointsToVercel) {
          return NextResponse.json({
            verified: true,
            message: "A record configured correctly for Vercel",
            records: aRecords
          })
        }

        return NextResponse.json({
          verified: false,
          message: "A records found but not pointing to Vercel. Use CNAME for subdomains.",
          records: aRecords
        })
      }

      return NextResponse.json({
        verified: false,
        message: "No DNS records found. Add the CNAME record and wait for propagation (up to 48 hours)."
      })

    } catch (dnsError) {
      console.error("DNS lookup error:", dnsError)
      return NextResponse.json({
        verified: false,
        message: "DNS lookup failed. Please try again."
      })
    }
  } catch (error) {
    console.error("Domain verification error:", error)
    return NextResponse.json(
      { error: "Failed to verify domain" },
      { status: 500 }
    )
  }
}
