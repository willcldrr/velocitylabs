/**
 * LB-11 OTP hardening tests (app/api/auth/verify-otp/route.ts).
 *
 * Mocks `@supabase/supabase-js.createClient` with a scripted query builder:
 * each SELECT returns whatever the test queued next via `queueSelect`, and
 * UPDATEs are recorded so we can assert `failed_attempts` increments.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

type SelectResult = { data?: unknown; error?: unknown }
const selectQueue: SelectResult[] = []
const updateCalls: Array<Record<string, unknown>> = []
const adminUpdateMock = vi.fn(async () => ({ data: null, error: null }))

vi.mock("@supabase/supabase-js", () => {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(async () => selectQueue.shift() ?? { data: null, error: null }),
    maybeSingle: vi.fn(async () => selectQueue.shift() ?? { data: null, error: null }),
    update: vi.fn((patch: Record<string, unknown>) => {
      updateCalls.push(patch)
      return {
        eq: vi.fn(async () => ({ data: null, error: null })),
      }
    }),
  }
  return {
    createClient: () => ({
      from: vi.fn(() => chain),
      auth: {
        admin: {
          updateUserById: adminUpdateMock,
        },
      },
    }),
  }
})

function mockReq(body: Record<string, unknown>, ip = "9.9.9.9") {
  const url = "http://localhost/api/auth/verify-otp"
  const req = new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  }) as unknown as import("next/server").NextRequest
  ;(req as unknown as { nextUrl: URL }).nextUrl = new URL(url)
  return req
}

async function loadRoute() {
  return await import("@/app/api/auth/verify-otp/route")
}

beforeEach(() => {
  vi.resetModules()
  selectQueue.length = 0
  updateCalls.length = 0
  adminUpdateMock.mockClear()
})

describe("verify-otp", () => {
  it("increments failed_attempts on 5 wrong codes and locks (429) on the 6th", async () => {
    const { POST } = await loadRoute()
    for (let attempt = 0; attempt < 5; attempt++) {
      // SELECT latest OTP row (not expired, not locked)
      selectQueue.push({
        data: {
          id: "otp-1",
          user_id: "user-1",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          failed_attempts: attempt,
          locked_at: null,
        },
        error: null,
      })
      // SELECT by id + code — miss
      selectQueue.push({ data: null, error: null })
      const res = await POST(
        mockReq({ email: `a+${attempt}@b.com`, code: "000000" })
      )
      if (attempt < 4) {
        expect(res.status).toBe(400) // still counting
      } else {
        expect(res.status).toBe(429) // 5th miss trips the lock
      }
    }

    // 6th call arrives against a locked row → immediate 429.
    selectQueue.push({
      data: {
        id: "otp-1",
        user_id: "user-1",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        failed_attempts: 5,
        locked_at: new Date().toISOString(),
      },
      error: null,
    })
    const sixth = await POST(mockReq({ email: "locked@b.com", code: "000000" }))
    expect(sixth.status).toBe(429)
  })

  it("correct code succeeds and does not increment failed_attempts", async () => {
    selectQueue.push({
      data: {
        id: "otp-ok",
        user_id: "user-ok",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        failed_attempts: 2,
        locked_at: null,
      },
      error: null,
    })
    // code match row found
    selectQueue.push({ data: { id: "otp-ok" }, error: null })
    const { POST } = await loadRoute()
    const res = await POST(mockReq({ email: "ok@b.com", code: "123456" }))
    expect(res.status).toBe(200)
    // No update containing `failed_attempts` increment should exist.
    const bumps = updateCalls.filter(
      (u) => typeof u.failed_attempts === "number"
    )
    expect(bumps).toEqual([])
  })

  it("expired OTP returns 400 (expired) even for a matching code", async () => {
    selectQueue.push({
      data: {
        id: "otp-old",
        user_id: "u",
        expires_at: new Date(Date.now() - 1000).toISOString(),
        failed_attempts: 0,
        locked_at: null,
      },
      error: null,
    })
    const { POST } = await loadRoute()
    const res = await POST(mockReq({ email: "exp@b.com", code: "123456" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(String(body.error).toLowerCase()).toMatch(/expired/)
  })

  it("different email in body → independent composite rate-limit bucket", async () => {
    // Fresh unused OTP row for each call so we never hit the 429 lockout path.
    const ok = () => ({
      data: {
        id: "r",
        user_id: "u",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        failed_attempts: 0,
        locked_at: null,
      },
      error: null,
    })
    const { POST } = await loadRoute()
    // Drain email A up to the default rate-limit (10/min). Then email B should
    // still be allowed on its own bucket.
    for (let i = 0; i < 10; i++) {
      selectQueue.push(ok())
      selectQueue.push({ data: { id: "r" }, error: null })
      const r = await POST(
        mockReq({ email: "flooder@example.com", code: "111111" }, "5.5.5.5")
      )
      expect(r.status).toBe(200)
    }
    // 11th call for A is rate-limited
    const over = await POST(
      mockReq({ email: "flooder@example.com", code: "111111" }, "5.5.5.5")
    )
    expect(over.status).toBe(429)
    // But a different email on the same IP is a different bucket.
    selectQueue.push(ok())
    selectQueue.push({ data: { id: "r" }, error: null })
    const other = await POST(
      mockReq({ email: "fresh@example.com", code: "222222" }, "5.5.5.5")
    )
    expect(other.status).toBe(200)
  })
})
