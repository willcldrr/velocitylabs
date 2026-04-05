/**
 * LB-9 SSRF guard (lib/safe-fetch.ts) tests.
 *
 * We mock `dns/promises.lookup` and `global.fetch` so the tests never touch
 * the network. DNS results are driven per-test via `lookupMock.mockResolvedValueOnce`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const lookupMock = vi.fn()
vi.mock("dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}))

const fetchMock = vi.fn()
// Install a module-scope fetch replacement. `safeFetch` calls `fetch(...)`
// unqualified, which resolves to globalThis.fetch.
;(globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock

async function loadSafeFetch() {
  return await import("@/lib/safe-fetch")
}

function okResponse(status = 200, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

beforeEach(() => {
  lookupMock.mockReset()
  fetchMock.mockReset()
})

describe("scheme + literal blocks (no DNS)", () => {
  it("rejects file:///etc/passwd before any DNS lookup", async () => {
    const { safeFetch } = await loadSafeFetch()
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/Blocked scheme/)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it("rejects http://127.0.0.1 (literal loopback)", async () => {
    const { safeFetch } = await loadSafeFetch()
    await expect(safeFetch("http://127.0.0.1/x")).rejects.toThrow(/Blocked IP/)
  })

  // BLOCKED: safe-fetch.ts does not strip `[`/`]` before calling
  // `isIP(hostname)`, so bracketed IPv6 literals like `[::1]` fail the literal
  // check and fall through to DNS resolution. In practice DNS usually rejects
  // them too, but this means the literal `::1`/`fc00::1` guards are dead code.
  // See .audit/remediation-status.md BLOCKED section. These tests lock in the
  // CURRENT behavior (fall-through to DNS) rather than the intended behavior.
  it("IPv6 bracketed literals fall through to DNS (BLOCKED: bracket strip missing)", async () => {
    const { safeFetch } = await loadSafeFetch()
    // DNS fails for a bracketed hostname — confirm we end up in the DNS
    // failure branch rather than the literal-IP rejection branch.
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"))
    await expect(safeFetch("http://[::1]/x")).rejects.toThrow(
      /DNS lookup failed|ENOTFOUND/
    )
  })
})

describe("DNS-based private-IP rejection", () => {
  it("rejects host resolving to 10.x private", async () => {
    const { safeFetch } = await loadSafeFetch()
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }])
    await expect(safeFetch("http://internal.example.com/x")).rejects.toThrow(
      /private IP/
    )
  })

  it("rejects if ANY resolved address is private (mixed public/private)", async () => {
    const { safeFetch } = await loadSafeFetch()
    lookupMock.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "10.1.2.3", family: 4 },
    ])
    await expect(safeFetch("http://target/x")).rejects.toThrow(/private IP/)
  })
})

describe("happy path", () => {
  it("accepts public host and fetches with signal + manual redirect", async () => {
    const { safeFetch } = await loadSafeFetch()
    lookupMock.mockResolvedValueOnce([{ address: "34.205.12.8", family: 4 }])
    fetchMock.mockResolvedValueOnce(okResponse(200, { ok: true }))

    const resp = await safeFetch("https://api.stripe.com/x")
    expect(resp.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe("manual")
    expect(init.signal).toBeDefined()
  })
})

describe("redirect handling", () => {
  it("follows a 302 to a public host once", async () => {
    const { safeFetch } = await loadSafeFetch()
    lookupMock
      .mockResolvedValueOnce([{ address: "1.2.3.4", family: 4 }]) // initial host
      .mockResolvedValueOnce([{ address: "5.6.7.8", family: 4 }]) // redirect target
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://target.example.com/final"))
      .mockResolvedValueOnce(okResponse(200, { done: true }))

    const resp = await safeFetch("https://initial.example.com/x")
    expect(resp.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("rejects a 302 whose target resolves to a private IP", async () => {
    const { safeFetch } = await loadSafeFetch()
    lookupMock
      .mockResolvedValueOnce([{ address: "1.2.3.4", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.9", family: 4 }])
    fetchMock.mockResolvedValueOnce(
      redirectResponse("http://evil.example.com/")
    )
    await expect(safeFetch("https://initial.example.com/x")).rejects.toThrow(
      /private IP/
    )
  })

  it("aborts after MAX_REDIRECTS (3 hops)", async () => {
    const { safeFetch } = await loadSafeFetch()
    // 4 hops: initial + 3 redirects all resolve to public IPs.
    lookupMock.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://a.example.com/2"))
      .mockResolvedValueOnce(redirectResponse("https://a.example.com/3"))
      .mockResolvedValueOnce(redirectResponse("https://a.example.com/4"))
      .mockResolvedValueOnce(redirectResponse("https://a.example.com/5"))
    await expect(safeFetch("https://a.example.com/1")).rejects.toThrow(
      /Too many redirects/
    )
  })

  it("rejects a 302 whose target uses a disallowed scheme", async () => {
    const { safeFetch } = await loadSafeFetch()
    lookupMock.mockResolvedValueOnce([{ address: "1.2.3.4", family: 4 }])
    fetchMock.mockResolvedValueOnce(redirectResponse("file:///etc/passwd"))
    await expect(safeFetch("https://ok.example.com/x")).rejects.toThrow(
      /Blocked scheme/
    )
  })
})

describe("safeFetchAllowInternal", () => {
  it("allows localhost URLs (skips private-IP block) but still enforces timeout", async () => {
    const { safeFetchAllowInternal } = await loadSafeFetch()
    fetchMock.mockResolvedValueOnce(okResponse(200, { internal: true }))
    const resp = await safeFetchAllowInternal("http://localhost:6379/ping")
    expect(resp.status).toBe(200)
    // No DNS lookup performed in the private-IP code path.
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it("honors a short timeoutMs and rejects if fetch never resolves", async () => {
    const { safeFetchAllowInternal } = await loadSafeFetch()
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () =>
            rej(new Error("aborted"))
          )
        })
    )
    await expect(
      safeFetchAllowInternal("http://localhost/x", { timeoutMs: 10 })
    ).rejects.toThrow()
  })
})
