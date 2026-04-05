import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/api-rate-limit"

/**
 * Hardcoded exchange rates relative to USD.
 * 1 USD = <rate> of the target currency.
 */
const EXCHANGE_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.36,
  AUD: 1.53,
}

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 60, window: 60 })
  if (limited) return limited

  return NextResponse.json({
    base: "USD",
    rates: EXCHANGE_RATES,
    updatedAt: new Date().toISOString(),
  })
}
