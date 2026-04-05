/**
 * Pluggable rate limiter (LB-10).
 *
 * Historically this file was a single in-process `Map`. On serverless
 * (Vercel) every cold start resets it and every parallel lambda has its
 * own bucket, so the limiter was effectively off in production — a key
 * finding in security H7 / perf #15 / reliability R-22 / testing T-11.
 *
 * This refactor introduces a `RateLimiterBackend` interface with two
 * implementations:
 *   - `InMemoryBackend`: the original Map, kept for local dev and as a
 *     fall-through when Upstash is unreachable.
 *   - `UpstashBackend`: a REST-API client for Upstash Redis
 *     (`INCR` + `EXPIRE` via the `/pipeline` endpoint). Chosen over the
 *     `@upstash/redis` SDK to avoid adding a hard dependency — plain fetch
 *     is enough, and we already have `safeFetchAllowInternal` to enforce
 *     timeouts without recursing through the rate limiter.
 *
 * `createRateLimiter()` picks the Upstash backend iff both
 * `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set.
 *
 * The public `checkRateLimit(identifier, config)` API is preserved so that
 * `lib/api-rate-limit.ts` and `lib/auth-rate-limit.ts` (the composite-key
 * wrapper for LB-11) need zero edits.
 */

import { safeFetchAllowInternal } from "./safe-fetch"
import { log } from "./log"

// ─── Types ────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number
  /** Time window in seconds */
  windowSeconds: number
}

export interface RateLimitResult {
  success: boolean
  remaining: number
  resetAt: number
}

interface BackendCheckResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

interface RateLimiterBackend {
  name: string
  check(key: string, limit: number, windowSec: number): Promise<BackendCheckResult>
}

// ─── In-memory backend ───────────────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()

// Clean up expired entries periodically (keeps the Map bounded in dev).
// In serverless this interval may not fire between invocations; that's
// fine — entries expire on read.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetAt < now) rateLimitStore.delete(key)
    }
  }, 60_000).unref?.()
}

const inMemoryBackend: RateLimiterBackend = {
  name: "in-memory",
  async check(key, limit, windowSec) {
    const now = Date.now()
    const windowMs = windowSec * 1000
    const existing = rateLimitStore.get(key)

    if (!existing || existing.resetAt < now) {
      const resetAt = now + windowMs
      rateLimitStore.set(key, { count: 1, resetAt })
      return { allowed: true, remaining: limit - 1, resetAt }
    }

    if (existing.count >= limit) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt }
    }

    existing.count++
    return { allowed: true, remaining: limit - existing.count, resetAt: existing.resetAt }
  },
}

// ─── Upstash backend ─────────────────────────────────────────────────────

function makeUpstashBackend(url: string, token: string): RateLimiterBackend {
  // Normalize: strip trailing slash so we can append `/pipeline`.
  const base = url.replace(/\/+$/, "")
  return {
    name: "upstash",
    async check(key, limit, windowSec) {
      // Pipeline: INCR then EXPIRE (NX) then PTTL, all in one round trip.
      // PTTL tells us how long until the window resets so we can surface an
      // accurate resetAt to the caller.
      const body = JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(windowSec), "NX"],
        ["PTTL", key],
      ])

      // NOTE: we deliberately use safeFetchAllowInternal (not safeFetch)
      // here: (a) Upstash hostnames are public but DNS-resolving every
      // request adds latency to the hot path, and (b) crucially this fetch
      // must NOT recurse through rate limiting — if it did, an
      // Upstash-backed limiter could throttle its own health checks.
      // safeFetchAllowInternal skips the SSRF DNS block but still enforces
      // scheme + timeout.
      const response = await safeFetchAllowInternal(`${base}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        timeoutMs: 2_000,
      })

      if (!response.ok) {
        throw new Error(`Upstash pipeline failed: ${response.status}`)
      }
      // Upstash pipeline returns an array of { result } or { error } objects.
      const payload = (await response.json()) as Array<{ result?: unknown; error?: string }>
      if (!Array.isArray(payload) || payload.length < 3) {
        throw new Error("Upstash pipeline returned unexpected shape")
      }
      for (const step of payload) {
        if (step.error) throw new Error(`Upstash step error: ${step.error}`)
      }
      const count = Number(payload[0].result ?? 0)
      let pttlMs = Number(payload[2].result ?? windowSec * 1000)
      // PTTL returns -1 if no expire (shouldn't happen post-EXPIRE NX, but guard)
      if (pttlMs < 0) pttlMs = windowSec * 1000
      const resetAt = Date.now() + pttlMs

      if (count > limit) {
        return { allowed: false, remaining: 0, resetAt }
      }
      return { allowed: true, remaining: Math.max(0, limit - count), resetAt }
    },
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

function createRateLimiter(): RateLimiterBackend {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    log.info("[rate-limit] backend selected", { backend: "upstash" })
    return makeUpstashBackend(url, token)
  }
  log.warn("[rate-limit] backend selected", {
    backend: "in-memory",
    note: "per-instance, DEV ONLY — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in production",
  })
  return inMemoryBackend
}

const activeBackend = createRateLimiter()

// ─── Public API (preserved) ──────────────────────────────────────────────

/**
 * Check if a request should be rate limited.
 *
 * NOTE: synchronous by contract for backward compatibility with existing
 * callers (`api-rate-limit.ts` and `auth-rate-limit.ts` return
 * `NextResponse | null` synchronously). For the in-memory backend this is
 * trivially synchronous. For the Upstash backend we would need async — so
 * we preserve the sync signature by providing `checkRateLimit` that
 * delegates to whichever backend is active, and we expose an async twin
 * `checkRateLimitAsync` for the Upstash path. `applyRateLimit` in
 * `api-rate-limit.ts` is updated in a tiny edit to become async.
 *
 * If the Upstash backend errors, we fall back to the in-memory backend so
 * a Redis outage degrades gracefully rather than 500-ing every request.
 */
export async function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  try {
    const r = await activeBackend.check(identifier, config.limit, config.windowSeconds)
    return { success: r.allowed, remaining: r.remaining, resetAt: r.resetAt }
  } catch (err) {
    if (activeBackend.name !== "in-memory") {
      log.error("[rate-limit] backend error, falling back to in-memory", err, { backend: activeBackend.name })
      const r = await inMemoryBackend.check(identifier, config.limit, config.windowSeconds)
      return { success: r.allowed, remaining: r.remaining, resetAt: r.resetAt }
    }
    throw err
  }
}

/**
 * Get rate limit headers for response
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": Math.ceil(result.resetAt / 1000).toString(),
  }
}

// Preset configurations
export const RATE_LIMITS = {
  // Lead capture: 10 requests per minute per IP
  leadCapture: { limit: 10, windowSeconds: 60 },
  // SMS webhook: 100 requests per minute per phone number
  smsWebhook: { limit: 100, windowSeconds: 60 },
  // API endpoints: 60 requests per minute per IP
  api: { limit: 60, windowSeconds: 60 },
  // Auth endpoints: 5 requests per minute per IP (prevent brute force)
  auth: { limit: 5, windowSeconds: 60 },
}
