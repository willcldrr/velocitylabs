/**
 * Sentry server-side configuration.
 *
 * Gated on SENTRY_DSN: if the env var is absent Sentry silently no-ops, which
 * keeps local development and any deploy that hasn't set the DSN yet from
 * emitting warnings. Once the DSN is set in Vercel project settings, server
 * errors and traces start flowing automatically.
 *
 * Intentionally conservative defaults:
 *   • tracesSampleRate low so we don't rack up quota on hot routes.
 *   • PII scrubbing: we never want customer emails or phone numbers in Sentry.
 */

import * as Sentry from "@sentry/nextjs"

const dsn = process.env.SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0.1,
    // Do not send PII by default. Routes that want to attach a user id must
    // do so explicitly via Sentry.setUser() with only the stable user id.
    sendDefaultPii: false,
    beforeSend(event) {
      // Belt-and-suspenders PII scrub. Drop any email/phone that slipped into
      // breadcrumbs or context objects, regardless of where they came from.
      const scrubbed = JSON.parse(
        JSON.stringify(event).replace(
          /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+?\d[\d\s().-]{7,})/g,
          "[redacted]"
        )
      )
      return scrubbed
    },
  })
}
