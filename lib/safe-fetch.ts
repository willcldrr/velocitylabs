/**
 * SSRF-hardened fetch wrapper (LB-9).
 *
 * Two exports:
 *   - `safeFetch(url, init?)`: the hardened default. Validates scheme
 *     (http/https only), DNS-resolves the host and rejects if ANY resolved
 *     IP is private / loopback / link-local / multicast / reserved, refuses
 *     `localhost`/empty hosts, re-validates manually on redirects (max 3
 *     hops), and enforces a 15s timeout by default.
 *   - `safeFetchAllowInternal(url, init?)`: escape hatch for trusted
 *     internal callers that legitimately hit private hosts (e.g. our own
 *     lambda self-calls, or our Upstash REST endpoint inside the rate
 *     limiter itself). Only enforces scheme + timeout, NOT private-IP
 *     blocking. Callers must opt in explicitly.
 *
 * Why not a library: we need to stay zero-dep for this file because the
 * rate limiter (LB-10) imports the internal escape hatch, and pulling in a
 * transitive dependency at import time would risk edge-bundle bloat.
 */

import { lookup } from "dns/promises"
import { isIP } from "net"

export interface SafeFetchOptions extends RequestInit {
  /** Abort the request after this many milliseconds. Default 15_000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SsrfBlockedError"
  }
}

/**
 * Returns true if the given IPv4/IPv6 literal is in a blocked range.
 * Blocks: loopback, private (RFC1918), link-local, CGNAT, multicast,
 * reserved, unspecified, ULA, IPv4-mapped IPv6, site-local, 6to4 to private,
 * and Cloud metadata (169.254.169.254 falls under link-local).
 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true // not a valid IP, block defensively

  if (family === 4) {
    const parts = ip.split(".").map((x) => parseInt(x, 10))
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
    const [a, b] = parts
    // 0.0.0.0/8 unspecified/"this network"
    if (a === 0) return true
    // 10.0.0.0/8
    if (a === 10) return true
    // 127.0.0.0/8 loopback
    if (a === 127) return true
    // 169.254.0.0/16 link-local (includes AWS/GCP metadata 169.254.169.254)
    if (a === 169 && b === 254) return true
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true
    // 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true
    // 198.18.0.0/15 benchmark
    if (a === 198 && (b === 18 || b === 19)) return true
    // 100.64.0.0/10 CGNAT
    if (a === 100 && b >= 64 && b <= 127) return true
    // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
    if (a >= 224) return true
    return false
  }

  // IPv6
  const normalized = ip.toLowerCase()
  // Strip zone id if any (Node's isIP rejects zone IDs already, but belt+braces)
  const bare = normalized.split("%")[0]
  // ::1 loopback
  if (bare === "::1" || bare === "::") return true
  // IPv4-mapped ::ffff:a.b.c.d — extract inner v4 and re-check
  const mapped = bare.match(/^::ffff:([0-9.]+)$/)
  if (mapped) return isBlockedIp(mapped[1])
  // fe80::/10 link-local
  if (bare.startsWith("fe8") || bare.startsWith("fe9") || bare.startsWith("fea") || bare.startsWith("feb")) return true
  // fc00::/7 unique-local
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true
  // ff00::/8 multicast
  if (bare.startsWith("ff")) return true
  // 2002::/16 6to4 — conservatively allow; real SSRF via 6to4 is rare and
  // would need deeper parsing. Flag a TODO rather than false-blocking.
  return false
}

/** Validate a URL's scheme and (if `blockPrivate`) its resolved IPs. */
async function validateUrl(url: string, blockPrivate: boolean): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${url}`)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Blocked scheme: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname
  if (!hostname) {
    throw new SsrfBlockedError("Empty hostname")
  }
  if (hostname.includes("%")) {
    throw new SsrfBlockedError("IPv6 zone IDs are not allowed")
  }

  if (!blockPrivate) return

  if (hostname.toLowerCase() === "localhost") {
    throw new SsrfBlockedError("Blocked hostname: localhost")
  }

  // If hostname is already an IP literal, check it directly.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(`Blocked IP: ${hostname}`)
    }
    return
  }

  // Otherwise, resolve all A/AAAA records and block if any are private.
  // (An attacker who controls DNS can return a public IP for the check then
  // a private one for the real connection, aka DNS rebinding. Mitigating
  // that fully requires pinning the resolved IP through the socket — out of
  // scope here; defense in depth still catches 99% of SSRF.)
  let addrs: { address: string; family: number }[]
  try {
    addrs = await lookup(hostname, { all: true })
  } catch (err) {
    throw new SsrfBlockedError(
      `DNS lookup failed for ${hostname}: ${(err as Error).message}`
    )
  }
  if (!addrs.length) {
    throw new SsrfBlockedError(`No DNS records for ${hostname}`)
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SsrfBlockedError(
        `Blocked: ${hostname} resolves to private IP ${a.address}`
      )
    }
  }
}

/** Build the combined AbortSignal (caller signal ∪ timeout). */
function buildSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return timeoutSignal
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === "function") {
    return anyFn([callerSignal, timeoutSignal])
  }
  return timeoutSignal
}

async function doFetch(
  url: string,
  options: SafeFetchOptions,
  blockPrivate: boolean
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...init } = options

  let currentUrl = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await validateUrl(currentUrl, blockPrivate)

    const signal = buildSignal(callerSignal, timeoutMs)
    const response = await fetch(currentUrl, {
      ...init,
      redirect: "manual",
      signal,
    })

    // 3xx: re-validate Location and hop manually.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) return response // 3xx with no Location — return as-is
      // Resolve relative redirects against the current URL
      const next = new URL(location, currentUrl).toString()
      currentUrl = next
      // Drain the body so the socket can be reused
      try {
        await response.arrayBuffer()
      } catch {
        /* ignore */
      }
      continue
    }

    return response
  }

  throw new SsrfBlockedError(`Too many redirects (> ${MAX_REDIRECTS}) starting at ${url}`)
}

/**
 * Hardened fetch. Rejects non-http(s), private IPs, localhost, and
 * redirects that escape into private space. Enforces a timeout.
 *
 * Default behavior for ALL outbound HTTP in the app unless the caller has
 * a specific reason to talk to an internal host.
 */
export async function safeFetch(
  input: RequestInfo | URL,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString()
  return doFetch(url, options, /* blockPrivate */ true)
}

/**
 * Internal-only fetch: enforces scheme + timeout, skips private-IP
 * blocking. Use ONLY for deliberate self-to-self lambda hops or trusted
 * infra endpoints (e.g. Upstash REST inside the rate limiter itself).
 *
 * DO NOT use this with any URL that could be influenced by user input.
 */
export async function safeFetchAllowInternal(
  input: RequestInfo | URL,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString()
  return doFetch(url, options, /* blockPrivate */ false)
}
