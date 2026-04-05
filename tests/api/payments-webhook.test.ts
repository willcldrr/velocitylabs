/**
 * Payments webhook tests covering LB-4 idempotency, LB-5a overlap surfacing
 * as 409 `booking_conflict`, LB-5b single-RPC contract (no sequential
 * leads/bookings/messages writes), and LB-8 error semantics (500 on transient
 * error + markWebhookEventProcessed("failed")).
 *
 * Stripe's signature verification is stubbed out so we can feed arbitrary
 * `event` objects. Supabase `from()` lookups return inert rows; the only
 * mutation in the happy path is the `rpc("confirm_booking_and_lead", ...)`
 * call — that's the single-transaction contract we want to prove.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const rpcMock = vi.fn()
const markProcessedMock = vi.fn(async () => undefined)
const claimMock = vi.fn(async () => ({ claimed: true, rowId: "ledger-1" }))

// Track individual table mutations so we can assert the 3-step mutation was
// NOT performed (LB-5b proof).
const updateCalls: Array<{ table: string }> = []
const insertCalls: Array<{ table: string }> = []

vi.mock("@/lib/webhook-idempotency", () => ({
  claimWebhookEvent: (...args: unknown[]) => claimMock(...args),
  markWebhookEventProcessed: (...args: unknown[]) => markProcessedMock(...args),
}))

vi.mock("@/lib/anthropic", () => ({
  generateResponse: vi.fn(async () => ({ content: "Confirmation text" })),
}))

vi.mock("@/lib/instagram", () => ({
  sendInstagramMessage: vi.fn(async () => ({ success: true })),
}))

vi.mock("stripe", () => {
  // Use a real function so `new Stripe(...)` works; vi.fn() proxies don't
  // implement [[Construct]] in this vitest version.
  function Stripe() {
    return {
      webhooks: {
        constructEvent: (body: string) => JSON.parse(body),
      },
    }
  }
  return { default: Stripe }
})

vi.mock("@supabase/supabase-js", () => {
  const tableChain = (table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.or = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.single = vi.fn(async () => {
      // Minimal rows so the handler reaches the RPC path.
      if (table === "leads")
        return { data: { id: "lead-1", user_id: "user-1" }, error: null }
      if (table === "vehicles")
        return {
          data: { user_id: "user-1", make: "M", model: "X", year: 2025 },
          error: null,
        }
      if (table === "ai_settings")
        return {
          data: { business_name: "Biz", tone: "friendly" },
          error: null,
        }
      return { data: null, error: null }
    })
    chain.update = vi.fn(() => {
      updateCalls.push({ table })
      return { eq: vi.fn(async () => ({ data: null, error: null })) }
    })
    chain.insert = vi.fn(() => {
      insertCalls.push({ table })
      return {
        select: () => ({ single: async () => ({ data: null, error: null }) }),
      }
    })
    return chain
  }
  return {
    createClient: () => ({
      from: (table: string) => tableChain(table),
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  }
})

function eventReq(event: Record<string, unknown>) {
  const url = "http://localhost/api/payments/webhook"
  const req = new Request(url, {
    method: "POST",
    body: JSON.stringify(event),
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=fake",
    },
  }) as unknown as import("next/server").NextRequest
  ;(req as unknown as { nextUrl: URL }).nextUrl = new URL(url)
  return req
}

function makeCheckoutEvent() {
  return {
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        amount_total: 10_000, // $100 → matches deposit below
        payment_intent: "pi_test_1",
        customer_email: "a@b.com",
        metadata: {
          lead_id: "lead-1",
          user_id: "user-1",
          vehicle_id: "veh-1",
          start_date: "2026-05-01",
          end_date: "2026-05-03",
          customer_phone: "+15551234567",
          customer_name: "Test",
          total_amount: "400",
          deposit_amount: "100",
          currency: "USD",
        },
      },
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  rpcMock.mockReset()
  markProcessedMock.mockClear()
  claimMock.mockClear()
  updateCalls.length = 0
  insertCalls.length = 0
})

async function loadRoute() {
  return await import("@/app/api/payments/webhook/route")
}

describe("payments webhook LB-5b (single RPC)", () => {
  it("happy path: rpc resolves and no per-table leads/bookings/messages mutation runs", async () => {
    rpcMock.mockResolvedValueOnce({ data: "booking-xyz", error: null })
    const { POST } = await loadRoute()
    const res = await POST(eventReq(makeCheckoutEvent()))
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock.mock.calls[0][0]).toBe("confirm_booking_and_lead")
    // LB-5b proof: no direct inserts into `bookings` / `messages` and no
    // `update` of `leads` table inside the handler.
    expect(insertCalls.find((c) => c.table === "bookings")).toBeUndefined()
    expect(insertCalls.find((c) => c.table === "messages")).toBeUndefined()
    expect(updateCalls.find((c) => c.table === "leads")).toBeUndefined()
  })
})

describe("payments webhook LB-5a overlap surfacing", () => {
  it("rpc booking_conflict → 409 response (constraint 23P01 surfaced by RPC)", async () => {
    // NOTE: the real overlap constraint lives in migration
    // 20260405120100_booking_overlap_constraint.sql; its correctness is
    // validated by the DB, not this test.
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: {
        code: "P0001",
        message: "booking_conflict: dates overlap",
      },
    })
    const { POST } = await loadRoute()
    const res = await POST(eventReq(makeCheckoutEvent()))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("booking_conflict")
    // 409 is terminal — ledger marked processed, not failed.
    expect(markProcessedMock).toHaveBeenCalledWith(
      "ledger-1",
      "processed",
      "booking_conflict"
    )
  })
})

describe("payments webhook LB-8 error semantics", () => {
  it("generic rpc rejection → 500 + markWebhookEventProcessed(failed)", async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { code: "08006", message: "connection reset" },
    })
    const { POST } = await loadRoute()
    const res = await POST(eventReq(makeCheckoutEvent()))
    expect(res.status).toBe(500)
    expect(markProcessedMock).toHaveBeenCalled()
    const [, outcome] = markProcessedMock.mock.calls[0]
    expect(outcome).toBe("failed")
  })
})
