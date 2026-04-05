import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { applyRateLimit } from "@/lib/api-rate-limit"

/**
 * LB-11: Composite (email + IP) rate limiting for auth OTP flows.
 *
 * This is a thin wrapper around `applyRateLimit` that derives the rate-limit
 * identifier from `sha256(email.toLowerCase() + '|' + ip)` instead of IP
 * alone. An attacker rotating IPs still hits the per-email bucket; an
 * attacker targeting many victims still hits the per-IP-derived suffix.
 *
 * TODO(LB-10): Wave 2-C will swap the rate-limiter backend from the in-memory
 * Map in `lib/rate-limit.ts` to a shared store. This helper does not need to
 * change at that time — it delegates to `applyRateLimit` which W2-C will
 * update in place.
 */
export async function applyAuthRateLimit(
  request: NextRequest,
  email: string | null | undefined,
  config: { limit: number; window: number }
): Promise<NextResponse | null> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  const normalized = (email || "").trim().toLowerCase()
  const composite = crypto
    .createHash("sha256")
    .update(`${normalized}|${ip}`)
    .digest("hex")

  return applyRateLimit(request, {
    limit: config.limit,
    window: config.window,
    identifier: composite,
  })
}
