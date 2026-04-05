/**
 * Sentry browser-side configuration.
 *
 * Uses NEXT_PUBLIC_SENTRY_DSN so the DSN can be embedded in the client bundle
 * without leaking server-only credentials. The same gating applies: if the
 * env var is unset Sentry no-ops.
 */

import * as Sentry from "@sentry/nextjs"

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
    sendDefaultPii: false,
  })
}
