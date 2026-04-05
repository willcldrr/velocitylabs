import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { lookupPaymentToken, decodePaymentToken, lookupBusinessById, BusinessInfo } from "@/lib/payment-link"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

export const runtime = "nodejs"

function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase environment variables not configured")
  }

  return createClient(supabaseUrl, supabaseKey)
}

interface DepositPortalBranding {
  logo_url: string | null
  accent_color: string
  portal_title: string
  portal_subtitle: string
  terms_enabled: boolean
  terms_text: string | null
  success_message: string | null
  require_id_upload: boolean
  require_insurance_upload: boolean
}

async function lookupDepositPortalConfig(userId: string): Promise<DepositPortalBranding | null> {
  try {
    const supabase = getSupabaseClient()

    const { data, error } = await supabase
      .from("deposit_portal_config")
      .select("logo_url, accent_color, portal_title, portal_subtitle, terms_enabled, terms_text, success_message, require_id_upload, require_insurance_upload")
      .eq("user_id", userId)
      .single()

    if (error || !data) {
      return null
    }

    return data as DepositPortalBranding
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 20, window: 60 })
  if (limited) return limited

  try {
    const { token } = await request.json()

    if (!token) {
      return NextResponse.json(
        { valid: false, error: "No token provided" },
        { status: 400 }
      )
    }

    // Try database lookup first (for short tokens)
    let data = await lookupPaymentToken(token)

    // Fall back to legacy decode for old-style tokens
    if (!data) {
      data = decodePaymentToken(token)
    }

    if (!data) {
      return NextResponse.json(
        { valid: false, error: "Invalid or expired payment link" },
        { status: 400 }
      )
    }

    // First, try to look up branding from deposit_portal_config using user_id
    let branding: {
      name: string
      subtitle: string | null
      logo_url: string | null
      primary_color: string
      secondary_color: string
      phone: string | null
      email: string | null
      terms_enabled: boolean
      terms_text: string | null
      success_message: string | null
      require_id_upload: boolean
      require_insurance_upload: boolean
    } | null = null

    if (data.userId) {
      const portalConfig = await lookupDepositPortalConfig(data.userId)
      if (portalConfig) {
        branding = {
          name: portalConfig.portal_title || data.businessName || "Secure Payment",
          subtitle: portalConfig.portal_subtitle || null,
          logo_url: portalConfig.logo_url,
          primary_color: portalConfig.accent_color || "#FFFFFF",
          secondary_color: "#000000",
          phone: null,
          email: null,
          terms_enabled: portalConfig.terms_enabled ?? true,
          terms_text: portalConfig.terms_text || null,
          success_message: portalConfig.success_message || null,
          require_id_upload: portalConfig.require_id_upload ?? false,
          require_insurance_upload: portalConfig.require_insurance_upload ?? false,
        }
      }
    }

    // Fall back to businesses table if no deposit config found
    if (!branding && data.businessId) {
      const business = await lookupBusinessById(data.businessId)
      if (business) {
        branding = {
          name: business.name,
          subtitle: null,
          logo_url: business.logo_url,
          primary_color: business.primary_color,
          secondary_color: business.secondary_color,
          phone: business.phone,
          email: business.email,
          terms_enabled: true,
          terms_text: null,
          success_message: null,
          require_id_upload: false,
          require_insurance_upload: false,
        }
      }
    }

    return NextResponse.json({
      valid: true,
      data,
      business: branding,
    })
  } catch (error) {
    log.error("Token validation error:", error)
    return NextResponse.json(
      { valid: false, error: "Failed to validate token" },
      { status: 500 }
    )
  }
}
