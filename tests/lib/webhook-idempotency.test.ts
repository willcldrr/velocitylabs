/**
 * LB-4 webhook idempotency (lib/webhook-idempotency.ts) tests.
 *
 * Mocks `@supabase/supabase-js.createClient` to return a configurable
 * insert-builder stub. Each test primes the next `.single()` return.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

type InsertResult = { data?: unknown; error?: unknown }
const insertQueue: InsertResult[] = []
const insertMock = vi.fn()

vi.mock("@supabase/supabase-js", () => {
  const from = vi.fn(() => ({
    insert: (...args: unknown[]) => {
      insertMock(...args)
      return {
        select: () => ({
          single: async () =>
            insertQueue.shift() ?? { data: null, error: null },
        }),
      }
    },
    update: () => ({
      eq: async () => ({ data: null, error: null }),
    }),
  }))
  return {
    createClient: () => ({ from }),
  }
})

async function loadModule() {
  return await import("@/lib/webhook-idempotency")
}

beforeEach(() => {
  vi.resetModules()
  insertQueue.length = 0
  insertMock.mockReset()
})

describe("claimWebhookEvent", () => {
  it("fresh event → { claimed: true, rowId }", async () => {
    insertQueue.push({ data: { id: "row-1" }, error: null })
    const { claimWebhookEvent } = await loadModule()
    const r = await claimWebhookEvent("stripe:bookings", "evt_1", "type")
    expect(r).toEqual({ claimed: true, rowId: "row-1" })
  })

  it("duplicate (unique-violation 23505) → { claimed: false, duplicate }", async () => {
    insertQueue.push({
      data: null,
      error: { code: "23505", message: "duplicate" },
    })
    const { claimWebhookEvent } = await loadModule()
    const r = await claimWebhookEvent("stripe:bookings", "evt_1", "type")
    expect(r).toEqual({ claimed: false, reason: "duplicate" })
  })

  it("different source, same eventId → claimed true (namespacing)", async () => {
    insertQueue.push({ data: { id: "row-a" }, error: null })
    insertQueue.push({ data: { id: "row-b" }, error: null })
    const { claimWebhookEvent } = await loadModule()
    const a = await claimWebhookEvent("stripe:bookings", "evt_shared")
    const b = await claimWebhookEvent("stripe:payments", "evt_shared")
    expect(a.claimed).toBe(true)
    expect(b.claimed).toBe(true)
    expect(insertMock).toHaveBeenCalledTimes(2)
    // Inserted rows should carry different `source` columns.
    const sources = insertMock.mock.calls.map(
      (c) => (c[0] as { source: string }).source
    )
    expect(sources).toEqual(["stripe:bookings", "stripe:payments"])
  })

  it("fallback hash path: identical body dedupes via synthetic id", async () => {
    // First insert succeeds, second hits 23505 on the same fallback hash id.
    insertQueue.push({ data: { id: "row-1" }, error: null })
    insertQueue.push({
      data: null,
      error: { code: "23505", message: "duplicate" },
    })
    const { claimWebhookEvent } = await loadModule()
    const body = JSON.stringify({ hello: "world" })
    const a = await claimWebhookEvent("instagram", "", "msg", body)
    const b = await claimWebhookEvent("instagram", "", "msg", body)
    expect(a.claimed).toBe(true)
    expect(b.claimed).toBe(false)
    // Both calls must carry the SAME synthetic eventId starting with "fallback:".
    const ids = insertMock.mock.calls.map(
      (c) => (c[0] as { event_id: string }).event_id
    )
    expect(ids[0]).toMatch(/^fallback:[0-9a-f]{64}$/)
    expect(ids[0]).toBe(ids[1])
  })

  it("arbitrary supabase error → fail-open { claimed: true, reason: 'error' }", async () => {
    insertQueue.push({
      data: null,
      error: { code: "08006", message: "connection refused" },
    })
    const { claimWebhookEvent } = await loadModule()
    const r = await claimWebhookEvent("stripe:bookings", "evt_err")
    expect(r.claimed).toBe(true)
    expect(r.reason).toBe("error")
  })
})
