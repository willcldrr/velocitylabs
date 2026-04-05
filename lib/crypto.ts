/**
 * Application-side encryption helpers for secrets at rest.
 *
 * Part of LB-6 remediation: per-tenant Stripe secret keys, Instagram long-lived
 * access tokens, and similar secrets must not be stored in Postgres as
 * plaintext. Callers encrypt before insert with `encrypt()` and decrypt on
 * read with `decrypt()`. The ciphertext/iv/tag triple is stored in three
 * separate columns (see migration 20260405120000_encrypt_secrets_at_rest.sql).
 *
 * For API keys we use a one-way SHA-256 hash (`hashApiKey`) so the plaintext
 * key is never recoverable from the database — the plaintext is shown to the
 * user exactly once at creation time and then discarded.
 *
 * Key material is loaded lazily from `process.env.ENCRYPTION_KEY` (32-byte
 * hex). A missing or malformed key throws on first use so misconfiguration
 * surfaces immediately rather than corrupting records silently.
 *
 * No third-party dependencies — all primitives come from `node:crypto`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

const ALGO = "aes-256-gcm"
const IV_LENGTH = 12 // 96-bit IV is the GCM-recommended size
const KEY_LENGTH = 32 // 256-bit key

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  if (cachedKey) return cachedKey

  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` and add it to your environment."
    )
  }

  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== KEY_LENGTH * 2) {
    throw new Error(
      `ENCRYPTION_KEY must be a ${KEY_LENGTH}-byte hex string (${KEY_LENGTH * 2} hex chars). Got ${raw.length} chars.`
    )
  }

  cachedKey = Buffer.from(raw, "hex")
  return cachedKey
}

export interface EncryptedPayload {
  ciphertext: string
  iv: string
  tag: string
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 * Returns base64 ciphertext, IV, and auth tag. All three must be stored and
 * passed back to `decrypt()` together.
 */
export function encrypt(plaintext: string): EncryptedPayload {
  if (typeof plaintext !== "string") {
    throw new TypeError("encrypt() expects a string plaintext")
  }

  const key = loadKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  }
}

/**
 * Decrypt a payload previously produced by `encrypt()`.
 * Throws if the auth tag does not verify (tamper detection) or if the key
 * has changed since encryption.
 */
export function decrypt(payload: EncryptedPayload): string {
  if (
    !payload ||
    typeof payload.ciphertext !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.tag !== "string"
  ) {
    throw new Error("decrypt() requires { ciphertext, iv, tag }")
  }

  const key = loadKey()
  const iv = Buffer.from(payload.iv, "base64")
  const tag = Buffer.from(payload.tag, "base64")
  const ciphertext = Buffer.from(payload.ciphertext, "base64")

  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString("utf8")
}

/**
 * One-way SHA-256 hash for API key storage. Hex-encoded so it is safe to
 * stuff into a TEXT column and index.
 *
 * We use raw SHA-256 rather than a password hash (bcrypt/argon2) because
 * API keys are already high-entropy random strings; the attacker does not
 * get to mount a dictionary attack against them.
 */
export function hashApiKey(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("hashApiKey() expects a non-empty string")
  }
  return createHash("sha256").update(raw, "utf8").digest("hex")
}

/**
 * Constant-time comparison of a raw API key against a stored SHA-256 hex
 * digest. Returns false on length mismatch (instead of throwing) so callers
 * can fall through to a legacy path without branching on exception types.
 */
export function verifyApiKey(raw: string, storedHash: string): boolean {
  if (typeof raw !== "string" || typeof storedHash !== "string") {
    return false
  }
  const computed = hashApiKey(raw)
  if (computed.length !== storedHash.length) {
    return false
  }
  const a = Buffer.from(computed, "utf8")
  const b = Buffer.from(storedHash, "utf8")
  return timingSafeEqual(a, b)
}
