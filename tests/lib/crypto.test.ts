/**
 * LB-6 encryption (lib/crypto.ts) tests.
 *
 * Round-trips, tamper detection, determinism/nondeterminism contracts for
 * `encrypt`/`decrypt`/`hashApiKey`/`verifyApiKey`, plus startup error cases
 * for malformed/missing `ENCRYPTION_KEY`.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

// Note: a valid key is already set in tests/setup.ts, but we stub it again
// here so that the tests are self-contained and the reset helper below can
// re-stub after unsetting.
const VALID_KEY = "00".repeat(32) // 32 bytes = 64 hex chars

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("ENCRYPTION_KEY", VALID_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function loadCrypto() {
  return await import("@/lib/crypto")
}

describe("encrypt/decrypt round-trip", () => {
  it("empty string round-trips", async () => {
    const { encrypt, decrypt } = await loadCrypto()
    expect(decrypt(encrypt(""))).toBe("")
  })

  it("ASCII string", async () => {
    const { encrypt, decrypt } = await loadCrypto()
    expect(decrypt(encrypt("hello world"))).toBe("hello world")
  })

  it("multi-byte UTF-8", async () => {
    const { encrypt, decrypt } = await loadCrypto()
    const s = "café — 日本語 — 🚗"
    expect(decrypt(encrypt(s))).toBe(s)
  })
})

describe("tamper detection", () => {
  it("tampered ciphertext throws", async () => {
    const { encrypt, decrypt } = await loadCrypto()
    const p = encrypt("secret")
    // Flip the last base64 char (still valid base64, different bytes).
    const tampered = {
      ...p,
      ciphertext:
        p.ciphertext.slice(0, -2) + (p.ciphertext.endsWith("A=") ? "B=" : "A="),
    }
    expect(() => decrypt(tampered)).toThrow()
  })

  it("tampered auth tag throws", async () => {
    const { encrypt, decrypt } = await loadCrypto()
    const p = encrypt("secret")
    const tagBuf = Buffer.from(p.tag, "base64")
    tagBuf[0] ^= 0xff
    expect(() => decrypt({ ...p, tag: tagBuf.toString("base64") })).toThrow()
  })
})

describe("nondeterminism", () => {
  it("encrypt() produces a fresh iv each call for the same input", async () => {
    const { encrypt } = await loadCrypto()
    const a = encrypt("same input")
    const b = encrypt("same input")
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })
})

describe("hashApiKey / verifyApiKey", () => {
  it("hashApiKey is deterministic and 64 hex chars", async () => {
    const { hashApiKey } = await loadCrypto()
    const h1 = hashApiKey("abc")
    const h2 = hashApiKey("abc")
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("verifyApiKey accepts matching key", async () => {
    const { verifyApiKey, hashApiKey } = await loadCrypto()
    expect(verifyApiKey("abc", hashApiKey("abc"))).toBe(true)
  })

  it("verifyApiKey rejects mismatch", async () => {
    const { verifyApiKey, hashApiKey } = await loadCrypto()
    expect(verifyApiKey("abc", hashApiKey("xyz"))).toBe(false)
  })

  it("verifyApiKey returns false on length-mismatched hex without throwing", async () => {
    const { verifyApiKey } = await loadCrypto()
    // Raw timingSafeEqual throws on unequal lengths; wrapper must guard.
    expect(() => verifyApiKey("abc", "deadbeef")).not.toThrow()
    expect(verifyApiKey("abc", "deadbeef")).toBe(false)
  })
})

describe("ENCRYPTION_KEY validation", () => {
  it("missing key throws with a clear error", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("ENCRYPTION_KEY", "")
    vi.resetModules()
    const { encrypt } = await import("@/lib/crypto")
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY is not set/)
  })

  it("wrong-length key throws with a clear error", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("ENCRYPTION_KEY", "deadbeef")
    vi.resetModules()
    const { encrypt } = await import("@/lib/crypto")
    expect(() => encrypt("x")).toThrow(/32-byte hex string/)
  })
})
