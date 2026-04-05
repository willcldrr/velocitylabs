/**
 * LB-7 logger (lib/log.ts) tests.
 *
 * Covers the scrubber's key/value redaction rules, depth cap + cycle safety,
 * the `log.error` stderr JSON format, the dynamic-import Sentry escalation
 * path, and the LOG_LEVEL=debug gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const captureExceptionMock = vi.fn()

// Mock BEFORE importing lib/log so that the dynamic import inside
// `captureToSentry` resolves to our fake. Vitest hoists vi.mock to the top.
vi.mock("@sentry/nextjs", () => ({
  captureException: captureExceptionMock,
}))

async function loadLog() {
  return await import("@/lib/log")
}

beforeEach(() => {
  vi.resetModules()
  captureExceptionMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("scrub: key-based redaction", () => {
  it("redacts top-level email but preserves innocuous keys", async () => {
    const { scrub } = await loadLog()
    expect(scrub({ email: "a@b.com", name: "bob" })).toEqual({
      email: "[REDACTED]",
      name: "bob",
    })
  })

  it("redacts nested secret keys while preserving siblings", async () => {
    const { scrub } = await loadLog()
    expect(scrub({ user: { access_token: "foo", id: 1 } })).toEqual({
      user: { access_token: "[REDACTED]", id: 1 },
    })
  })
})

describe("scrub: value-based redaction", () => {
  it("redacts JWT-shaped values even under innocuous keys", async () => {
    const { scrub } = await loadLog()
    const jwt = "eyJhbGciOiJIUzI1NiJ9.payload.sig"
    expect(scrub({ note: jwt })).toEqual({ note: "[REDACTED]" })
  })

  it("redacts Stripe live/test/whsec/pk patterns by value", async () => {
    const { scrub } = await loadLog()
    const values = {
      a: "sk_live_AAAAAAAAAAAAAA",
      b: "sk_test_xxxxxxxxxxxxxx",
      c: "whsec_yyyyyyyyyyyyyy",
      d: "pk_live_zzzzzzzzzzzzzz",
    }
    const out = scrub(values) as Record<string, string>
    expect(out.a).toBe("[REDACTED]")
    expect(out.b).toBe("[REDACTED]")
    expect(out.c).toBe("[REDACTED]")
    expect(out.d).toBe("[REDACTED]")
  })
})

describe("scrub: arrays and depth", () => {
  it("preserves array structure and redacts keys inside array elements", async () => {
    const { scrub } = await loadLog()
    const out = scrub([{ email: "x@y", id: 1 }, { id: 2 }]) as Array<
      Record<string, unknown>
    >
    expect(Array.isArray(out)).toBe(true)
    expect(out[0].email).toBe("[REDACTED]")
    expect(out[0].id).toBe(1)
    expect(out[1].id).toBe(2)
  })

  it("caps depth and does not infinite-loop on cycles", async () => {
    const { scrub } = await loadLog()
    type Node = { id: number; child?: Node }
    const cyclic: Node = { id: 0 }
    cyclic.child = cyclic
    // Should return (rather than throw) and mark the deep frontier.
    let out: unknown
    expect(() => {
      out = scrub(cyclic)
    }).not.toThrow()
    // Walk down to depth 6 and confirm truncation marker appears.
    let cursor: unknown = out
    for (let i = 0; i < 6; i++) {
      cursor = (cursor as Record<string, unknown>).child
    }
    expect(cursor).toBe("[MAX_DEPTH]")
  })
})

describe("log.error", () => {
  it("stringifies JSON to stderr with level, err.name/message/stack, and ctx", async () => {
    const { log } = await loadLog()
    const writes: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      log.error("msg", new Error("boom"), { userId: 1 })
    } finally {
      process.stderr.write = origWrite
    }

    expect(writes.length).toBe(1)
    const line = JSON.parse(writes[0].trim())
    expect(line.level).toBe("error")
    expect(line.msg).toBe("msg")
    expect(line.err.name).toBe("Error")
    expect(line.err.message).toBe("boom")
    expect(typeof line.err.stack).toBe("string")
    expect(line.userId).toBe(1)
  })

  it("forwards to Sentry.captureException via dynamic import", async () => {
    const { log } = await loadLog()
    // Silence stderr to keep the test output clean.
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      log.error("msg", new Error("sentry-me"), { route: "test" })
    } finally {
      process.stderr.write = orig
    }
    // Dynamic import in captureToSentry schedules a microtask chain; flush.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const [errArg, extraArg] = captureExceptionMock.mock.calls[0]
    expect((errArg as Error).message).toBe("sentry-me")
    expect((extraArg as { extra?: { route?: string } }).extra?.route).toBe(
      "test"
    )
  })
})

describe("log.debug", () => {
  it("only emits when LOG_LEVEL=debug", async () => {
    const { log } = await loadLog()
    const writes: string[] = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      // LOG_LEVEL not set → no emission.
      vi.stubEnv("LOG_LEVEL", "")
      log.debug("silent")
      expect(writes.length).toBe(0)

      vi.stubEnv("LOG_LEVEL", "debug")
      log.debug("loud", { k: "v" })
    } finally {
      process.stdout.write = orig
    }

    expect(writes.length).toBe(1)
    const line = JSON.parse(writes[0].trim())
    expect(line.level).toBe("debug")
    expect(line.msg).toBe("loud")
    expect(line.k).toBe("v")
  })
})
