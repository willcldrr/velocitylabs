// Structured logger with PII-scrubbing + Sentry escalation on errors.
// Usage:
//   log.info("user signed up", { userId, email })   // scrubbed automatically
//   log.warn("fallback path", { reason })
//   log.error("payment webhook failed", err, { eventId, route })
//
// Every log line is a single JSON object on stdout (Vercel log drain
// picks it up) with { level, ts, msg, ...scrubbedContext }. Error calls
// additionally invoke Sentry.captureException(err, { extra: scrubbed }).
//
// Dynamic Sentry import keeps the SDK out of edge bundles that never log
// errors. Any import failure is swallowed so logging itself never throws.

export type Level = "debug" | "info" | "warn" | "error"

export interface LogContext {
  [k: string]: unknown
}

// Keys whose VALUE should be redacted regardless of content.
const SCRUB_KEYS =
  /token|secret|key|password|passwd|otp|phone|email|refresh|authorization|bearer|cookie|session|api[_-]?key|access[_-]?token|stripe[_-]?key|webhook[_-]?secret/i

// Value-level patterns — catch tokens even when the key is innocuous.
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/
const STRIPE_RE = /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}\b|\bpk_(live|test)_[A-Za-z0-9]{8,}\b|\bwhsec_[A-Za-z0-9]{8,}\b/
const LONG_BEARER_RE = /^[A-Za-z0-9_-]{40,}$/ // opaque token heuristic — only used when key already looked suspicious

const MAX_DEPTH = 5
const REDACTED = "[REDACTED]"

function scrubString(s: string): string {
  if (JWT_RE.test(s)) return REDACTED
  if (STRIPE_RE.test(s)) return REDACTED
  return s
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]"
  if (value == null) return value
  if (typeof value === "string") return scrubString(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? value.stack.split("\n").slice(0, 10).join("\n") : undefined,
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SCRUB_KEYS.test(k)) {
        out[k] = REDACTED
        continue
      }
      // Belt-and-suspenders: redact obvious opaque-token strings whose key
      // names looked innocuous.
      if (typeof v === "string" && LONG_BEARER_RE.test(v) && /auth|grant|credential/i.test(k)) {
        out[k] = REDACTED
        continue
      }
      out[k] = scrub(v, depth + 1)
    }
    return out
  }
  return String(value)
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: scrubString(err.message),
      stack: err.stack ? err.stack.split("\n").slice(0, 10).join("\n") : undefined,
    }
  }
  if (err && typeof err === "object") {
    return { value: scrub(err) as Record<string, unknown> }
  }
  return { value: String(err) }
}

function emit(level: Level, msg: string, ctx: LogContext | undefined, stream: NodeJS.WriteStream): void {
  const line: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg,
  }
  if (ctx) {
    const scrubbed = scrub(ctx) as Record<string, unknown>
    for (const [k, v] of Object.entries(scrubbed)) {
      if (!(k in line)) line[k] = v
    }
  }
  try {
    stream.write(JSON.stringify(line) + "\n")
  } catch {
    // Never throw from a logger — stdout full, circular, etc.
  }
}

function captureToSentry(err: unknown, ctx: LogContext | undefined): void {
  // Dynamic import so edge bundles that never hit an error path don't pull
  // the SDK in. Any failure (import error, SDK disabled, DSN missing) is
  // swallowed.
  import("@sentry/nextjs")
    .then((mod) => {
      try {
        mod.captureException(err, { extra: (ctx ? (scrub(ctx) as Record<string, unknown>) : undefined) })
      } catch {
        /* swallow */
      }
    })
    .catch(() => {
      /* swallow */
    })
}

export const log = {
  debug(msg: string, ctx?: LogContext): void {
    if (process.env.LOG_LEVEL !== "debug") return
    emit("debug", msg, ctx, process.stdout)
  },
  info(msg: string, ctx?: LogContext): void {
    emit("info", msg, ctx, process.stdout)
  },
  warn(msg: string, ctx?: LogContext): void {
    emit("warn", msg, ctx, process.stdout)
  },
  error(msg: string, err: unknown, ctx?: LogContext): void {
    const line: Record<string, unknown> = {
      level: "error",
      ts: new Date().toISOString(),
      msg,
      err: serializeError(err),
    }
    if (ctx) {
      const scrubbed = scrub(ctx) as Record<string, unknown>
      for (const [k, v] of Object.entries(scrubbed)) {
        if (!(k in line)) line[k] = v
      }
    }
    try {
      process.stderr.write(JSON.stringify(line) + "\n")
    } catch {
      /* swallow */
    }
    captureToSentry(err, ctx)
  },
}
