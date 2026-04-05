/**
 * LB-5a booking overlap surfacing test.
 *
 * The real overlap constraint lives in migration
 * `20260405120100_booking_overlap_constraint.sql`; its correctness is
 * validated by the DB, not this test. Here we only verify that when the
 * downstream RPC rejects with a PostgresError whose message contains
 * `booking_conflict` (how the RPC wraps raised 23P01s), the payments webhook
 * handler surfaces a 409 `booking_conflict` response rather than 500.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const rpcMock = vi.fn()
const markProcessedMock = vi.fn(async () => undefined)

vi.mock("@/lib/webhook-idempotency", () => ({
  claimWebhookEvent: vi.fn(async () => ({ claimed: true, rowId: "row-1" })),
  markWebhookEventProcessed: (...args: unknown[]) => markProcessedMock(...args),
}))

vi.mock("@/lib/anthropic", () => ({
  generateResponse: vi.fn(async () => ({ content: "..." })),
}))
vi.mock("@/lib/instagram", () => ({
  sendInstagramMessage: vi.fn(async () => ({ success: true })),
}))

vi.mock("stripe", () => {
  function Stripe() {
    return {
      webhooks: { constructEvent: (body: string) => JSON.parse(body) },
    }
  }
  return { default: Stripe }
})

vi.mock("@supabase/supabase-js", () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.or = () => chain
  chain.limit = () => chain
  chain.single = async () => ({
    data: { user_id: "user-1", make: "M", model: "X", year: 2025 },
    error: null,
  })
  chain.update = () => ({ eq: async () => ({ data: null, error: null }) })
  chain.insert = () => ({
    select: () => ({ single: async () => ({ data: null, error: null }) }),
  })
  return {
    createClient: () => ({
      from: () => chain,
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  }
})

function req() {
  const url = "http://localhost/api/payments/webhook"
  const r = new Request(url, {
    method: "POST",
    body: JSON.stringify({
      id: "evt_overlap",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs",
          amount_total: 10_000,
          metadata: {
            lead_id: "lead-1",
            user_id: "user-1",
            vehicle_id: "veh-1",
            start_date: "2026-05-01",
            end_date: "2026-05-03",
            total_amount: "400",
            deposit_amount: "100",
          },
        },
      },
    }),
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=stub",
    },
  }) as unknown as import("next/server").NextRequest
  ;(r as unknown as { nextUrl: URL }).nextUrl = new URL(url)
  return r
}

beforeEach(() => {
  vi.resetModules()
  rpcMock.mockReset()
  markProcessedMock.mockClear()
})

describe("LB-5a overlap constraint surfacing", () => {
  it("RPC re-raises 23P01 as booking_conflict → handler returns 409", async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: {
        code: "P0001",
        message: "booking_conflict: vehicle already booked",
      },
    })
    const { POST } = await import("@/app/api/payments/webhook/route")
    const res = await POST(req())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("booking_conflict")
  })
})
