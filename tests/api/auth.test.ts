/**
 * LB-2 / LB-3 auth route tests.
 *
 * - /api/admin/restore-session:
 *     * feature flag off → 503
 *     * caller !== target → 403 (self-only)
 *     * caller === target + admin profile → 200 and audit_logs insert fires
 * - /api/instagram/callback:
 *     * missing state cookie → redirect to dashboard with error
 *     * mismatched state cookie → redirect with error (timingSafeEqual path)
 *     * valid state + authenticated session → upsert instagram_connections
 *       with user_id sourced from SESSION, not from any state payload
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

// ---------- shared mocks ----------
const cookieGetUserMock = vi.fn()
const serviceClientMock = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: cookieGetUserMock },
  }),
}))

// @supabase/supabase-js createClient returns whatever each test installs on
// `serviceClientMock`. This lets both routes share the same mock.
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => serviceClientMock(...args),
}))

// SSRF-guarded fetch (used by instagram/callback) → immediately return
// synthetic success responses.
const safeFetchMock = vi.fn()
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  safeFetchAllowInternal: (...args: unknown[]) => safeFetchMock(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))

beforeEach(() => {
  vi.resetModules()
  cookieGetUserMock.mockReset()
  serviceClientMock.mockReset()
  safeFetchMock.mockReset()
  vi.unstubAllEnvs()
})

// ---------- restore-session ----------
describe("/api/admin/restore-session (LB-2)", () => {
  function req(body: Record<string, unknown>) {
    const url = "http://localhost/api/admin/restore-session"
    const r = new Request(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4",
      },
    }) as unknown as import("next/server").NextRequest
    ;(r as unknown as { nextUrl: URL }).nextUrl = new URL(url)
    return r
  }

  it("503 when ENABLE_SESSION_RESTORE is unset", async () => {
    vi.stubEnv("ENABLE_SESSION_RESTORE", "")
    cookieGetUserMock.mockResolvedValue({
      data: { user: { id: "u-1" } },
      error: null,
    })
    serviceClientMock.mockReturnValue({})
    const { POST } = await import("@/app/api/admin/restore-session/route")
    const res = await POST(req({ adminUserId: "u-1" }))
    expect(res.status).toBe(503)
  })

  it("403 when caller id !== target id (self-only)", async () => {
    vi.stubEnv("ENABLE_SESSION_RESTORE", "true")
    cookieGetUserMock.mockResolvedValue({
      data: { user: { id: "caller" } },
      error: null,
    })
    serviceClientMock.mockReturnValue({})
    const { POST } = await import("@/app/api/admin/restore-session/route")
    const res = await POST(
      req({ adminUserId: "11111111-1111-1111-1111-111111111111" })
    )
    expect(res.status).toBe(403)
  })

  it("200 when caller === target and audit_logs insert fires", async () => {
    vi.stubEnv("ENABLE_SESSION_RESTORE", "true")
    const uuid = "11111111-1111-1111-1111-111111111111"
    cookieGetUserMock.mockResolvedValue({
      data: { user: { id: uuid } },
      error: null,
    })
    const auditInsertMock = vi.fn(async () => ({ data: null, error: null }))
    const profilesChain = {
      select: () => profilesChain,
      eq: () => profilesChain,
      single: async () => ({ data: { is_admin: true }, error: null }),
    } as unknown as Record<string, unknown>
    const auditChain = {
      insert: auditInsertMock,
    }
    const from = vi.fn((table: string) => {
      if (table === "profiles") return profilesChain
      if (table === "audit_logs") return auditChain
      return {}
    })
    serviceClientMock.mockReturnValue({
      from,
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: { email: "admin@example.com" } },
            error: null,
          }),
          generateLink: async () => ({
            data: { properties: { hashed_token: "tok" } },
            error: null,
          }),
        },
        verifyOtp: async () => ({
          data: {
            session: { access_token: "a", refresh_token: "r" },
          },
          error: null,
        }),
      },
    })
    const { POST } = await import("@/app/api/admin/restore-session/route")
    const res = await POST(req({ adminUserId: uuid }))
    expect(res.status).toBe(200)
    expect(auditInsertMock).toHaveBeenCalledTimes(1)
    const inserted = auditInsertMock.mock.calls[0][0] as Record<string, unknown>
    expect(inserted.action).toBe("session_restore")
    expect(inserted.actor_id).toBe(uuid)
    expect(inserted.target_id).toBe(uuid)
  })
})

// ---------- instagram/callback ----------
describe("/api/instagram/callback (LB-3)", () => {
  function req({
    state,
    code,
    cookie,
  }: {
    state?: string
    code?: string
    cookie?: string
  }) {
    const params = new URLSearchParams()
    if (code) params.set("code", code)
    if (state) params.set("state", state)
    const url = `http://localhost/api/instagram/callback?${params.toString()}`
    const headers: Record<string, string> = {
      "x-forwarded-for": "2.2.2.2",
    }
    if (cookie) headers.cookie = `instagram_oauth_state=${cookie}`
    const r = new Request(url, { method: "GET", headers }) as unknown as
      import("next/server").NextRequest
    ;(r as unknown as { nextUrl: URL }).nextUrl = new URL(url)
    // Next's `request.cookies.get` is not in the base Request; monkey-patch.
    Object.defineProperty(r, "cookies", {
      get() {
        return {
          get(name: string) {
            return cookie && name === "instagram_oauth_state"
              ? { value: cookie }
              : undefined
          },
        }
      },
    })
    return r
  }

  it("redirects with error when state cookie is missing", async () => {
    serviceClientMock.mockReturnValue({})
    const { GET } = await import("@/app/api/instagram/callback/route")
    const res = await GET(req({ state: "abcd", code: "c" }))
    // Next redirect responses are status 307/308.
    expect([307, 308]).toContain(res.status)
    const loc = res.headers.get("location") || ""
    expect(loc).toMatch(/instagram_error/)
  })

  it("redirects with error when state cookie value mismatches", async () => {
    serviceClientMock.mockReturnValue({})
    const { GET } = await import("@/app/api/instagram/callback/route")
    const res = await GET(
      req({ state: "aaaaaa", code: "c", cookie: "bbbbbb" })
    )
    expect([307, 308]).toContain(res.status)
    expect(res.headers.get("location") || "").toMatch(/instagram_error/)
  })

  it("uses session user id (not any state payload) when upserting connection", async () => {
    cookieGetUserMock.mockResolvedValue({
      data: { user: { id: "session-user" } },
      error: null,
    })
    // Stub token exchanges + pages/Instagram account/username lookups.
    safeFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "short" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "long", expires_in: 100 }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "page-1", access_token: "page-tok" }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            instagram_business_account: { id: "ig-1" },
            name: "PageName",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ username: "igname" }), { status: 200 })
      )

    const upsertMock = vi.fn(async () => ({ error: null }))
    const from = vi.fn(() => ({ upsert: upsertMock }))
    serviceClientMock.mockReturnValue({ from })

    const { GET } = await import("@/app/api/instagram/callback/route")
    // State payload intentionally carries a foreign userId — must be ignored.
    const foreignStatePayload = Buffer.from(
      JSON.stringify({ userId: "victim-user" })
    ).toString("hex")
    const res = await GET(
      req({
        state: foreignStatePayload,
        code: "c",
        cookie: foreignStatePayload, // matches so we pass the safeEqualHex check
      })
    )
    expect([307, 308]).toContain(res.status)
    expect(upsertMock).toHaveBeenCalledTimes(1)
    const inserted = upsertMock.mock.calls[0][0] as { user_id: string }
    // LB-3: user_id MUST come from the session, not the state payload.
    expect(inserted.user_id).toBe("session-user")
    expect(inserted.user_id).not.toBe("victim-user")
  })
})
