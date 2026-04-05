/**
 * LB-10 rate limiter (lib/rate-limit.ts + lib/api-rate-limit.ts + lib/auth-rate-limit.ts) tests.
 *
 * Covers: in-memory backend counting + reset-on-window, composite auth key
 * isolation, Upstash backend fallback to in-memory on REST error, and a
 * grep-based invariant that `rateLimitStore` is not exported / re-imported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const safeFetchMock = vi.fn()
vi.mock("@/lib/safe-fetch", () => ({
  safeFetchAllowInternal: (...args: unknown[]) => safeFetchMock(...args),
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  safeFetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

function mockRequest(pathname: string, ip = "1.2.3.4") {
  return {
    headers: new Headers({ "x-forwarded-for": ip }),
    nextUrl: { pathname },
  } as unknown as import("next/server").NextRequest
}

describe("in-memory backend", () => {
  it("allows up to limit then denies, resetAt monotonic", async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit")
    const cfg = { limit: 3, windowSeconds: 60 }
    const r1 = await checkRateLimit("k1", cfg)
    const r2 = await checkRateLimit("k1", cfg)
    const r3 = await checkRateLimit("k1", cfg)
    const r4 = await checkRateLimit("k1", cfg)
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r3.success).toBe(true)
    expect(r4.success).toBe(false)
    expect(r1.resetAt).toBeLessThanOrEqual(r2.resetAt)
    expect(r2.resetAt).toBe(r3.resetAt)
  })
})

describe("applyRateLimit", () => {
  it("returns null twice then 429 on the third call when limit=2", async () => {
    const { applyRateLimit } = await import("@/lib/api-rate-limit")
    const req = mockRequest("/api/test/apply")
    const a = await applyRateLimit(req, { limit: 2, window: 60 })
    const b = await applyRateLimit(req, { limit: 2, window: 60 })
    const c = await applyRateLimit(req, { limit: 2, window: 60 })
    expect(a).toBeNull()
    expect(b).toBeNull()
    expect(c).not.toBeNull()
    expect(c!.status).toBe(429)
  })

  it("resets the counter after the window elapses (fake timers)", async () => {
    vi.useFakeTimers()
    const { applyRateLimit } = await import("@/lib/api-rate-limit")
    const req = mockRequest("/api/test/reset")
    expect(await applyRateLimit(req, { limit: 1, window: 1 })).toBeNull()
    expect(
      (await applyRateLimit(req, { limit: 1, window: 1 }))!.status
    ).toBe(429)
    // Advance past the 1s window.
    vi.setSystemTime(Date.now() + 2_000)
    expect(await applyRateLimit(req, { limit: 1, window: 1 })).toBeNull()
  })
})

describe("applyAuthRateLimit composite key", () => {
  it("independent buckets for different emails", async () => {
    const { applyAuthRateLimit } = await import("@/lib/auth-rate-limit")
    const req = mockRequest("/api/auth/verify-otp")
    // With limit=1, first call for email A allowed, second for A denied,
    // but first for B still allowed (independent bucket).
    const a1 = await applyAuthRateLimit(req, "alice@example.com", {
      limit: 1,
      window: 60,
    })
    const a2 = await applyAuthRateLimit(req, "alice@example.com", {
      limit: 1,
      window: 60,
    })
    const b1 = await applyAuthRateLimit(req, "bob@example.com", {
      limit: 1,
      window: 60,
    })
    expect(a1).toBeNull()
    expect(a2).not.toBeNull()
    expect(a2!.status).toBe(429)
    expect(b1).toBeNull()
  })
})

describe("Upstash fallback to in-memory on error", () => {
  it("returns allowed=true even when Upstash REST call rejects", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://x.upstash.io")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "y")
    safeFetchMock.mockRejectedValue(new Error("network boom"))
    const { checkRateLimit } = await import("@/lib/rate-limit")
    const r = await checkRateLimit("fallback-key", {
      limit: 5,
      windowSeconds: 60,
    })
    // Must degrade to in-memory and allow, not fail closed.
    expect(r.success).toBe(true)
  })
})

describe("invariant: rateLimitStore is not imported outside lib/rate-limit.ts", () => {
  it("no source file references `rateLimitStore`", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry === ".git")
          continue
        const p = join(dir, entry)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
          const body = readFileSync(p, "utf8")
          if (
            body.includes("rateLimitStore") &&
            !p.endsWith("lib/rate-limit.ts") &&
            !p.includes("/tests/")
          ) {
            hits.push(p)
          }
        }
      }
    }
    walk(join(process.cwd(), "lib"))
    walk(join(process.cwd(), "app"))
    expect(hits).toEqual([])
  })
})
