/**
 * Sentry edge runtime configuration.
 *
 * This is the edge-runtime counterpart to sentry.server.config.ts. Edge
 * functions run in a restricted environment (no Node APIs), so the Sentry
 * SDK applies a different transport. Same DSN, same gating, same sampling.
 */

import * as Sentry from "@sentry/nextjs"

const dsn = process.env.SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  })
}
