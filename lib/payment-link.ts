import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { log } from "@/lib/log"

const EXPIRATION_HOURS = 24

export interface PaymentLinkData {
  vehicleId: string
  vehicleName: string
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
  dailyRate: number
  totalAmount: number
  depositAmount: number
  customerName: string
  customerPhone: string
  customerEmail?: string
  businessName?: string
  // Lead tracking - critical for webhook to update correct lead
  leadId?: string
  userId?: string
  // NOTE: Stripe keys are NOT stored in payment links for security
  // They are looked up from deposit_portal_config at checkout time using userId
  // Custom payment domain (e.g., "exoticrentals.com" - defaults to rentalcapture.xyz)
  paymentDomain?: string
  // Company slug for URL (e.g., "velocity-exotics" -> rentalcapture.xyz/velocity-exotics/TOKEN)
  companySlug?: string
  // Business reference for multi-tenant
  businessId?: string
}

export interface BusinessInfo {
  id: string
  name: string
  slug: string
  payment_domain: string | null
  stripe_publishable_key: string | null
  logo_url: string | null
  primary_color: string
  secondary_color: string
  phone: string | null
  email: string | null
  deposit_percentage: number
}

interface StoredPaymentLink extends PaymentLinkData {
  id: string
  short_token: string
  expires_at: string
  created_at: string
  used_at: string | null
}

// Default payment domain
const DEFAULT_PAYMENT_DOMAIN = "https://rentalcapture.xyz"

/**
 * Get the payment link URL base
 * Priority: custom domain > env variable > default (rentalcapture.xyz)
 * When using default domain, includes company slug if provided
 *
 * URL structure:
 * - Custom domain: https://custom.domain.com/{token}
 * - Default with slug: https://rentalcapture.xyz/{slug}/checkout/{token}
 * - Default without slug: https://rentalcapture.xyz/checkout/{token}
 */
function getPaymentUrl(customDomain?: string, companySlug?: string): string {
  if (customDomain) {
    // Normalize the custom domain - no slug needed for custom domains
    const domain = customDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")
    return `https://${domain}`
  }

  const baseDomain = process.env.PAYMENT_LINK_DOMAIN || DEFAULT_PAYMENT_DOMAIN

  // Include company slug in path for default domain
  if (companySlug) {
    return `${baseDomain}/${companySlug}/checkout`
  }

  return `${baseDomain}/checkout`
}

/**
 * Generate a short, readable token in format: XXXXXXX-XXXXXXX-XXXXX
 * Uses alphanumeric characters (excluding confusing ones like 0/O, 1/I/l)
 */
function generateShortToken(): string {
  // Alphanumeric without confusing characters
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

  const generateSegment = (length: number): string => {
    const bytes = crypto.randomBytes(length)
    let result = ""
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % chars.length]
    }
    return result
  }

  return `${generateSegment(7)}-${generateSegment(7)}-${generateSegment(5)}`
}

/**
 * Get Supabase client for server-side operations
 */
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase environment variables not configured")
  }

  return createClient(supabaseUrl, supabaseKey)
}

/**
 * Generate a secure payment link with a short, readable token
 * Stores payment data in database and returns a short URL
 *
 * @param data - Payment/booking data to store
 * @returns Full payment URL with short token (e.g., /checkout/ABC1234-XYZ5678-12345)
 */
export async function generateSecurePaymentLink(data: PaymentLinkData): Promise<string> {
  const baseUrl = getPaymentUrl(data.paymentDomain, data.companySlug)
  const shortToken = generateShortToken()

  // Calculate expiration
  const expiresAt = new Date(Date.now() + EXPIRATION_HOURS * 60 * 60 * 1000).toISOString()

  try {
    const supabase = getSupabaseClient()

    // Store payment link in database
    // NOTE: Stripe secret keys are NOT stored here for security
    // They are looked up from deposit_portal_config at checkout time
    const { error } = await supabase.from("payment_links").insert({
      short_token: shortToken,
      vehicle_id: data.vehicleId,
      vehicle_name: data.vehicleName,
      start_date: data.startDate,
      end_date: data.endDate,
      daily_rate: data.dailyRate,
      total_amount: data.totalAmount,
      deposit_amount: data.depositAmount,
      customer_name: data.customerName,
      customer_phone: data.customerPhone,
      business_name: data.businessName || "Velocity Exotics",
      expires_at: expiresAt,
      // Lead and user tracking for webhook
      lead_id: data.leadId || null,
      user_id: data.userId || null,
      business_id: data.businessId || null,
      // Store custom payment domain and company slug
      payment_domain: data.paymentDomain || null,
      company_slug: data.companySlug || null,
    })

    if (error) {
      log.error("Failed to store payment link:", error)
      throw new Error("Failed to create payment link")
    }

    return `${baseUrl}/${shortToken}`
  } catch (error) {
    log.error("Payment link generation error:", error)
    throw error
  }
}

/**
 * Legacy sync version - generates token without DB storage
 * Used as fallback if DB is unavailable
 */
export function generateSecurePaymentLinkSync(data: PaymentLinkData): string {
  const baseUrl = getPaymentUrl(data.paymentDomain, data.companySlug)
  const shortToken = generateShortToken()

  // For sync version, encode minimal data in token itself
  // This is a fallback and won't persist
  log.warn("Using sync payment link generation - link data will not be persisted")

  const payload = Buffer.from(JSON.stringify({
    ...data,
    exp: Date.now() + EXPIRATION_HOURS * 60 * 60 * 1000,
  })).toString("base64url")

  return `${baseUrl}/${shortToken}?d=${payload}`
}

/**
 * Look up payment data by short token from database
 *
 * @param shortToken - The short token (e.g., ABC1234-XYZ5678-12345)
 * @returns Payment data or null if not found/expired
 */
export async function lookupPaymentToken(shortToken: string): Promise<PaymentLinkData | null> {
  try {
    const supabase = getSupabaseClient()

    const { data, error } = await supabase
      .from("payment_links")
      .select("*")
      .eq("short_token", shortToken.toUpperCase())
      .single()

    if (error || !data) {
      log.error("Payment link not found:", error)
      return null
    }

    // Check expiration
    if (new Date(data.expires_at) < new Date()) {
      log.error("Payment link expired", undefined)
      return null
    }

    // Check if already used
    if (data.used_at) {
      log.error("Payment link already used", undefined)
      return null
    }

    return {
      vehicleId: data.vehicle_id,
      vehicleName: data.vehicle_name,
      startDate: data.start_date,
      endDate: data.end_date,
      dailyRate: data.daily_rate,
      totalAmount: data.total_amount,
      depositAmount: data.deposit_amount,
      customerName: data.customer_name,
      customerPhone: data.customer_phone,
      businessName: data.business_name,
      leadId: data.lead_id || undefined,
      userId: data.user_id || undefined,
      // NOTE: Stripe keys are NOT returned - they should be looked up from deposit_portal_config
      paymentDomain: data.payment_domain || undefined,
      companySlug: data.company_slug || undefined,
      businessId: data.business_id || undefined,
    }
  } catch (error) {
    log.error("Failed to lookup payment token:", error)
    return null
  }
}

/**
 * Mark a payment link as used (after successful payment)
 * Uses atomic update to prevent race conditions - only marks if not already used
 */
export async function markPaymentLinkUsed(shortToken: string): Promise<boolean> {
  try {
    const supabase = getSupabaseClient()

    // Atomic update: only mark as used if not already used
    const { data, error } = await supabase
      .from("payment_links")
      .update({ used_at: new Date().toISOString() })
      .eq("short_token", shortToken.toUpperCase())
      .is("used_at", null)
      .select("id")

    // Success only if we actually updated a row
    return !error && data && data.length > 0
  } catch {
    return false
  }
}

/**
 * Atomically claim a payment link for checkout (prevents double-spend)
 * Returns true if successfully claimed, false if already used or not found
 */
export async function claimPaymentLinkForCheckout(
  shortToken: string,
  stripeSessionId: string
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient()

    // Atomic update: only claim if not already used
    const { data, error } = await supabase
      .from("payment_links")
      .update({
        stripe_session_id: stripeSessionId,
        used_at: new Date().toISOString(),
      })
      .eq("short_token", shortToken.toUpperCase())
      .is("used_at", null)
      .select("id")

    // Success only if we actually updated a row
    return !error && data && data.length > 0
  } catch {
    return false
  }
}

/**
 * Look up business by payment domain
 */
export async function lookupBusinessByDomain(domain: string): Promise<BusinessInfo | null> {
  try {
    const supabase = getSupabaseClient()

    // Normalize domain (remove protocol and trailing slashes)
    const normalizedDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")

    const { data, error } = await supabase
      .from("businesses")
      .select("id, name, slug, payment_domain, stripe_publishable_key, logo_url, primary_color, secondary_color, phone, email, deposit_percentage")
      .eq("payment_domain", normalizedDomain)
      .eq("domain_status", "active")
      .eq("status", "active")
      .single()

    if (error || !data) {
      log.error("Business not found for domain:", normalizedDomain, { v0: error })
      return null
    }

    return data as BusinessInfo
  } catch (error) {
    log.error("Failed to lookup business:", error)
    return null
  }
}

/**
 * Look up business by ID
 */
export async function lookupBusinessById(businessId: string): Promise<BusinessInfo | null> {
  try {
    const supabase = getSupabaseClient()

    const { data, error } = await supabase
      .from("businesses")
      .select("id, name, slug, payment_domain, stripe_publishable_key, logo_url, primary_color, secondary_color, phone, email, deposit_percentage")
      .eq("id", businessId)
      .eq("status", "active")
      .single()

    if (error || !data) {
      log.error("Business not found:", businessId, { v0: error })
      return null
    }

    return data as BusinessInfo
  } catch (error) {
    log.error("Failed to lookup business:", error)
    return null
  }
}

/**
 * Legacy decode function for old-style tokens
 * Kept for backwards compatibility
 */
export function decodePaymentToken(token: string): PaymentLinkData | null {
  // Check if it's a short token format (has dashes)
  if (token.includes("-")) {
    // This is async, but we need sync for backwards compat
    // Return null and let the API handle async lookup
    return null
  }

  // Try to decode as legacy base64 token
  try {
    // Check for query param encoded data
    if (token.includes("?d=")) {
      const [, encoded] = token.split("?d=")
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString())

      if (payload.exp && payload.exp < Date.now()) {
        return null
      }

      const { exp, ...data } = payload
      return data
    }

    return null
  } catch {
    return null
  }
}
