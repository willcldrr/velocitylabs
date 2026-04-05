/**
 * LB-8 error semantics for app/api/stripe-webhook (the "stripe:bookings" route).
 *
 * - Signature verification failure → 400.
 * - Terminal amount mismatch → 200 + markWebhookEventProcessed(processed).
 * - Transient supabase error → 500 + markWebhookEventProcessed(failed).
 *
 * stripe-webhook constructs Stripe + Supabase at MODULE load, so our mocks
 * must be in place before the first dynamic import.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const markProcessedMock = vi.fn(async () => undefined)
const claimMock = vi.fn(async () => ({ claimed: true, rowId: "row-1" }))
const constructEventMock = vi.fn()

// Supabase per-call queue
const selectQueue: Array<{ data?: unknown; error?: unknown }> = []
const updateQueue: Array<{ data?: unknown; error?: unknown }> = []

vi.mock("@/lib/webhook-idempotency", () => ({
  claimWebhookEvent: (...args: unknown[]) => claimMock(...args),
  markWebhookEventProcessed: (...args: unknown[]) => markProcessedMock(...args),
}))

vi.mock("stripe", () => {
  function Stripe() {
    return {
      webhooks: {
        constructEvent: (...args: unknown[]) => constructEventMock(...args),
      },
    }
  }
  return { default: Stripe }
})

vi.mock("@supabase/supabase-js", () => {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.single = vi.fn(async () => selectQueue.shift() ?? { data: null, error: null })
  chain.update = vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => updateQueue.shift() ?? { data: null, error: null }),
      })),
    })),
  }))
  return {
    createClient: () => ({ from: () => chain }),
  }
})

function req(sig: string | null = "t=1,v1=stub") {
  const url = "http://localhost/api/stripe-webhook"
  const r = new Request(url, {
    method: "POST",
    body: "raw-body",
    headers: sig
      ? { "content-type": "application/json", "stripe-signature": sig }
      : { "content-type": "application/json" },
  }) as unknown as import("next/server").NextRequest
  ;(r as unknown as { nextUrl: URL }).nextUrl = new URL(url)
  return r
}

beforeEach(() => {
  vi.resetModules()
  markProcessedMock.mockClear()
  claimMock.mockClear()
  constructEventMock.mockReset()
  selectQueue.length = 0
  updateQueue.length = 0
})

describe("stripe-webhook LB-8", () => {
  it("signature verification failure → 400", async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error("bad signature")
    })
    const { POST } = await import("@/app/api/stripe-webhook/route")
    const res = await POST(req())
    expect(res.status).toBe(400)
  })

  it("amount mismatch → 200 + markWebhookEventProcessed(processed, amount_mismatch)", async () => {
    constructEventMock.mockReturnValue({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          amount_total: 12_345,
          metadata: { source: "booking_deposit", booking_id: "b-1" },
        },
      },
    })
    // Lookup returns a booking with a different deposit amount.
    selectQueue.push({ data: { deposit_amount: 999.99 }, error: null })
    const { POST } = await import("@/app/api/stripe-webhook/route")
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(markProcessedMock).toHaveBeenCalledWith(
      "row-1",
      "processed",
      "amount_mismatch"
    )
  })

  it("transient supabase error → 500 + markWebhookEventProcessed(failed)", async () => {
    constructEventMock.mockReturnValue({
      id: "evt_2",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_2",
          amount_total: 10_000,
          metadata: { source: "booking_deposit", booking_id: "b-2" },
        },
      },
    })
    // First select (lookup) is a non-PGRST116 transient error — handler throws.
    selectQueue.push({
      data: null,
      error: { code: "08006", message: "connection refused" },
    })
    const { POST } = await import("@/app/api/stripe-webhook/route")
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(markProcessedMock).toHaveBeenCalled()
    const [, outcome] = markProcessedMock.mock.calls[0]
    expect(outcome).toBe("failed")
  })
})
