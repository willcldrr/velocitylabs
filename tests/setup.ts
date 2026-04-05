/**
 * Vitest global setup for the Wave 3-A test suite.
 *
 * Provides:
 *  - default stubs for the env vars that lib/crypto, lib/supabase, the Stripe
 *    clients at module scope, etc. dereference with `!` on import,
 *  - a chainable `createMockSupabaseBuilder` factory so individual tests can
 *    override `single`, `insert`, `update`, `upsert`, etc. return values,
 *  - a `createMockRequest` helper that returns a `NextRequest`-compatible
 *    object for app-router handler tests.
 *
 * Tests that need specific mocks for `@supabase/supabase-js` or `@supabase/ssr`
 * should still call `vi.mock("@supabase/supabase-js", ...)` inside the test
 * file because vitest mock hoisting is per-file. This setup only guarantees
 * the env vars exist so that module-scope `createClient(URL!, KEY!)` calls in
 * route files don't throw on import.
 */
import { vi, beforeEach, afterEach } from "vitest"

// Env vars that various modules dereference with `!` at import time.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://stub.supabase.co"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "stub-anon-key"
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub-service-role-key"
process.env.STRIPE_SECRET_KEY ||= "sk_test_stub"
process.env.STRIPE_WEBHOOK_SECRET ||= "whsec_stub"
process.env.ENCRYPTION_KEY ||= "00".repeat(32)
process.env.NEXT_PUBLIC_APP_URL ||= "http://localhost:3000"
process.env.META_APP_ID ||= "meta-app-id"
process.env.META_APP_SECRET ||= "meta-app-secret"

/**
 * Build a chainable query-builder stub mirroring the subset of PostgREST we
 * actually use. Each terminal method (`single`, `maybeSingle`, the builder
 * itself when awaited) resolves to whatever the test plugged in via
 * `builder.__setResult({ data, error })`. `insert`/`update`/`upsert`/`delete`
 * return the same chain so `.select().single()` still works afterwards.
 */
export interface MockBuilder {
  __setResult(result: { data?: unknown; error?: unknown }): void
  __setRpcResult(result: { data?: unknown; error?: unknown }): void
  __calls: Record<string, unknown[][]>
  from: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  upsert: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  neq: ReturnType<typeof vi.fn>
  gte: ReturnType<typeof vi.fn>
  lte: ReturnType<typeof vi.fn>
  in: ReturnType<typeof vi.fn>
  or: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
  rpc: ReturnType<typeof vi.fn>
  auth: {
    getUser: ReturnType<typeof vi.fn>
    admin: {
      getUserById: ReturnType<typeof vi.fn>
      generateLink: ReturnType<typeof vi.fn>
      updateUserById: ReturnType<typeof vi.fn>
    }
    verifyOtp: ReturnType<typeof vi.fn>
  }
}

export function createMockSupabaseBuilder(): MockBuilder {
  // Per-table result stack: test can push { data, error } that the NEXT
  // terminal call will consume.
  const resultQueue: Array<{ data?: unknown; error?: unknown }> = []
  const rpcQueue: Array<{ data?: unknown; error?: unknown }> = []
  const calls: Record<string, unknown[][]> = {}

  const record = (name: string, args: unknown[]) => {
    calls[name] = calls[name] || []
    calls[name].push(args)
  }

  const terminal = async () => {
    return resultQueue.shift() ?? { data: null, error: null }
  }

  const chain: Partial<MockBuilder> = {}
  const chainMethods = [
    "from",
    "select",
    "insert",
    "update",
    "upsert",
    "delete",
    "eq",
    "neq",
    "gte",
    "lte",
    "in",
    "or",
    "order",
    "limit",
  ] as const
  for (const m of chainMethods) {
    ;(chain as Record<string, unknown>)[m] = vi.fn((...args: unknown[]) => {
      record(m, args)
      return chain
    })
  }
  chain.single = vi.fn((...args: unknown[]) => {
    record("single", args)
    return terminal()
  })
  chain.maybeSingle = vi.fn((...args: unknown[]) => {
    record("maybeSingle", args)
    return terminal()
  })
  chain.rpc = vi.fn((...args: unknown[]) => {
    record("rpc", args)
    return Promise.resolve(rpcQueue.shift() ?? { data: null, error: null })
  })
  chain.auth = {
    getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    admin: {
      getUserById: vi.fn(async () => ({ data: { user: null }, error: null })),
      generateLink: vi.fn(async () => ({ data: null, error: null })),
      updateUserById: vi.fn(async () => ({ data: null, error: null })),
    },
    verifyOtp: vi.fn(async () => ({ data: { session: null }, error: null })),
  }
  // Make `await builder.from().update()...` resolve too (non-terminal awaits).
  ;(chain as Record<string, unknown>).then = (
    resolve: (v: unknown) => unknown
  ) => resolve(resultQueue.shift() ?? { data: null, error: null })

  chain.__calls = calls
  chain.__setResult = (r) => {
    resultQueue.push(r)
  }
  chain.__setRpcResult = (r) => {
    rpcQueue.push(r)
  }

  return chain as MockBuilder
}

/**
 * Build a NextRequest-like object. The real NextRequest class is hard to
 * instantiate outside a Next handler; for our tests the handlers only touch
 * `.headers`, `.nextUrl`, `.cookies`, `.json()`, and `.text()`, so a fetch-API
 * Request plus a `nextUrl` getter is enough.
 */
export function createMockRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string | object
    cookies?: Record<string, string>
  } = {}
): Request & {
  nextUrl: URL
  cookies: { get(name: string): { value: string } | undefined }
} {
  const method = init.method || "GET"
  const headers = new Headers(init.headers || {})
  if (init.cookies) {
    const cookieStr = Object.entries(init.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
    headers.set("cookie", cookieStr)
  }
  const bodyStr =
    typeof init.body === "string"
      ? init.body
      : init.body != null
        ? JSON.stringify(init.body)
        : undefined
  const req = new Request(url, {
    method,
    headers,
    body: bodyStr,
  }) as Request & {
    nextUrl: URL
    cookies: { get(name: string): { value: string } | undefined }
  }
  // Next adds .nextUrl — monkey-patch it on.
  Object.defineProperty(req, "nextUrl", {
    get() {
      return new URL(url)
    },
  })
  Object.defineProperty(req, "cookies", {
    get() {
      return {
        get(name: string) {
          const v = init.cookies?.[name]
          return v ? { value: v } : undefined
        },
      }
    },
  })
  return req
}

// Ensure each test starts with clean mock state for vi.fn()s attached to
// modules we globally mocked in individual files.
beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})
