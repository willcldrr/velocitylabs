import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getRateLimitHeaders } from "@/lib/rate-limit"

interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number
  /** Time window in seconds */
  window: number
  /** Optional custom identifier (defaults to IP address) */
  identifier?: string
}

/**
 * Apply rate limiting to an API route handler.
 *
 * Returns `null` if the request is allowed, or a 429 NextResponse if rate limited.
 *
 * Usage:
 * ```ts
 * const limited = await applyRateLimit(request, { limit: 30, window: 60 })
 * if (limited) return limited
 * ```
 *
 * LB-10: as of Wave 2-C this helper is async. The underlying backend can
 * now be an Upstash Redis REST client (when `UPSTASH_REDIS_REST_URL` +
 * `UPSTASH_REDIS_REST_TOKEN` are set) or the in-memory Map fallback.
 * Node has no sync HTTP client, so callers must `await` the result. A
 * sweep of the codebase swapped every call site to `await applyRateLimit`
 * in the same wave.
 */
export async function applyRateLimit(
  request: NextRequest,
  config: RateLimitConfig
): Promise<NextResponse | null> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"

  const identifier = config.identifier || ip
  // Prefix with the pathname so each endpoint has its own bucket
  const key = `${request.nextUrl.pathname}:${identifier}`

  const result = await checkRateLimit(key, {
    limit: config.limit,
    windowSeconds: config.window,
  })

  if (!result.success) {
    const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000)
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: {
          ...getRateLimitHeaders(result),
          "Retry-After": retryAfter.toString(),
        },
      }
    )
  }

  return null
}
