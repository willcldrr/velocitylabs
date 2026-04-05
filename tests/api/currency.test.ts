/**
 * LB-12 currency threading tests.
 *
 * We drive `app/api/bookings/checkout` end-to-end (mocking Stripe and Supabase)
 * for the three currency-resolution branches: tenant currency honored, unsupported
 * currency falls back to USD with a log.warn, pre-migration query-error path
 * falls back to env/default without surfacing the error. The other 3 checkout
 * routes reuse the same `SUPPORTED_CURRENCIES` + fallback logic from
 * `lib/currency.ts` — we cover that pure module below so the 3 other routes do
 * not each need a full Stripe/Supabase harness.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const sessionsCreateMock = vi.fn(async (opts: unknown) => ({
  id: "cs_test",
  url: "https://stripe/success",
  __opts: opts,
}))
const logWarnMock = vi.fn()

// Supabase `from("bookings").select(...).eq(...).single()` → our scripted row.
const bookingRowQueue: Array<{
  data: unknown
  error: unknown
}> = []

vi.mock("stripe", () => {
  function Stripe() {
    return { checkout: { sessions: { create: sessionsCreateMock } } }
  }
  return { default: Stripe }
})

vi.mock("@supabase/supabase-js", () => {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.update = vi.fn(() => ({ eq: async () => ({ data: null, error: null }) }))
  chain.single = vi.fn(async () =>
    bookingRowQueue.shift() ?? { data: null, error: null }
  )
  return { createClient: () => ({ from: () => chain }) }
})

vi.mock("@/lib/log", async () => {
  const actual =
    (await vi.importActual<typeof import("@/lib/log")>("@/lib/log"))
  return {
    ...actual,
    log: {
      ...actual.log,
      warn: (...args: unknown[]) => {
        logWarnMock(...args)
      },
    },
  }
})

function req(body: Record<string, unknown>) {
  const url = "http://localhost/api/bookings/checkout"
  const r = new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
  }) as unknown as import("next/server").NextRequest
  ;(r as unknown as { nextUrl: URL }).nextUrl = new URL(url)
  return r
}

beforeEach(() => {
  vi.resetModules()
  sessionsCreateMock.mockClear()
  logWarnMock.mockReset()
  bookingRowQueue.length = 0
})

describe("bookings/checkout currency threading", () => {
  it("EUR on booking row is passed to Stripe as lowercase 'eur'", async () => {
    bookingRowQueue.push({
      data: {
        id: "b-1",
        deposit_paid: false,
        deposit_amount: 100,
        currency: "EUR",
      },
      error: null,
    })
    const { POST } = await import("@/app/api/bookings/checkout/route")
    const res = await POST(
      req({
        bookingId: "b-1",
        vehicleName: "Ferrari",
        startDate: "2026-05-01",
        endDate: "2026-05-03",
      })
    )
    expect(res.status).toBe(200)
    expect(sessionsCreateMock).toHaveBeenCalledTimes(1)
    const opts = sessionsCreateMock.mock.calls[0][0] as {
      line_items: Array<{ price_data: { currency: string } }>
    }
    expect(opts.line_items[0].price_data.currency).toBe("eur")
  })

  it("unsupported currency falls back to usd and emits log.warn", async () => {
    bookingRowQueue.push({
      data: {
        id: "b-2",
        deposit_paid: false,
        deposit_amount: 100,
        currency: "XYZ",
      },
      error: null,
    })
    const { POST } = await import("@/app/api/bookings/checkout/route")
    const res = await POST(
      req({
        bookingId: "b-2",
        vehicleName: "Ferrari",
        startDate: "2026-05-01",
        endDate: "2026-05-03",
      })
    )
    expect(res.status).toBe(200)
    const opts = sessionsCreateMock.mock.calls[0][0] as {
      line_items: Array<{ price_data: { currency: string } }>
    }
    expect(opts.line_items[0].price_data.currency).toBe("usd")
    // log.warn is also called by rate-limit backend selection; filter for the
    // currency warning specifically.
    const currencyWarn = logWarnMock.mock.calls.find((c) =>
      String(c[0] ?? "").includes("unsupported currency")
    )
    expect(currencyWarn).toBeDefined()
  })

  it("pre-migration: missing currency column → env/default fallback, no client-facing error", async () => {
    // Row has no `currency` field at all (simulates pre-migration schema).
    bookingRowQueue.push({
      data: { id: "b-3", deposit_paid: false, deposit_amount: 100 },
      error: null,
    })
    const { POST } = await import("@/app/api/bookings/checkout/route")
    const res = await POST(
      req({
        bookingId: "b-3",
        vehicleName: "Ferrari",
        startDate: "2026-05-01",
        endDate: "2026-05-03",
      })
    )
    expect(res.status).toBe(200)
    const opts = sessionsCreateMock.mock.calls[0][0] as {
      line_items: Array<{ price_data: { currency: string } }>
    }
    // lib/currency.ts DEFAULT_CURRENCY is "USD".
    expect(opts.line_items[0].price_data.currency).toBe("usd")
  })
})

describe("SUPPORTED_CURRENCIES (shared by all 4 checkout routes)", () => {
  it("recognizes the 5 expected codes and defaults to USD", async () => {
    const mod = await import("@/lib/currency")
    for (const c of ["USD", "EUR", "GBP", "CAD", "AUD"]) {
      expect(mod.SUPPORTED_CURRENCIES[c]).toBeDefined()
    }
    expect(mod.DEFAULT_CURRENCY).toBe("USD")
    expect(mod.SUPPORTED_CURRENCIES["XYZ" as keyof typeof mod.SUPPORTED_CURRENCIES]).toBeUndefined()
  })
})
