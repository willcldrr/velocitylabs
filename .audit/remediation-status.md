# Remediation Status

Baseline commit: `765b811` on `master`
Working branch: `fix/prod-readiness-remediation`
Strategy: Option A — in-place edits, git as safety net, migrations written to disk only (not applied).

Legend: `[ ] PENDING` · `[~] IN PROGRESS` · `[✓] DONE` · `[!] BLOCKED`

## Launch Blockers

| ID | Status | Item | Owner |
|----|--------|------|-------|
| LB-2 | [✓] | /api/admin/restore-session lateral takeover (caller==target, audit log) | W2-A |
| LB-3 | [✓] | Instagram OAuth `state`-as-userId hijack (resolve user from session) | W2-A |
| LB-4 | [✓] | Collapse/namespace Stripe webhooks; IG+TG idempotency | W2-B |
| LB-5a | [✓] | Postgres EXCLUDE USING gist on bookings (vehicle × daterange) | W1-B |
| LB-5b | [✓] | Post-payment multi-step mutation → Postgres RPC transaction | W2-B |
| LB-6 | [✓] | Encrypt per-tenant Stripe keys, IG tokens; hash api_keys | W1-A |
| LB-7 | [✓] | Structured logger + Sentry wiring; redact 245 console.* | W2-D |
| LB-8 | [✓] | Stripe webhook 500 on internal errors; Sentry capture | W2-B |
| LB-9 | [✓] | safe-fetch SSRF hardening + fetch timeouts everywhere | W2-C |
| LB-10 | [✓] | Replace in-memory rate limiter with shared store | W2-C |
| LB-11 | [✓] | OTP brute-force: failed_attempts, lockout, TTL, composite key | W2-A |
| LB-12 | [✓] | Thread currency through 4 Stripe checkout routes | W2-B |

## High-priority findings (from domain reports)

### Security
- [ ] H8 — SUPABASE_SERVICE_ROLE_KEY loaded in edge middleware bundle
- [ ] M1 — /api/sms/send missing lead-ownership check
- [ ] M2 — .or() filter-string injection in /api/sms/bulk
- [ ] M3 — /api/bookings/checkout auth/signed-token missing
- [ ] M4 — admin reset-password weak min length
- [✓] M5 — admin businesses endpoint accepts plaintext Stripe keys (resolved by LB-6)
- [✓] H3 — per-tenant Stripe secret keys encrypted at rest (LB-6)
- [✓] H4 — Instagram access tokens encrypted at rest (LB-6)
- [✓] H5 — api_keys stored as SHA-256 hash + constant-time compare (LB-6)
- [ ] M6 — CSP unsafe-inline + unsafe-eval
- [ ] M7 — HTML email template un-escaped fullName
- [ ] M8 — widget CORS Access-Control-Allow-Origin: *
- [✓] M9 — impersonate logs verify-otp result (log line removed in W2-A)
- [ ] M10 — access_codes plaintext + non-constant-time compare
- [ ] M11 — cron secret non-constant-time compare

### Reliability
- [✓] R-7 — raw fetch w/o timeout in 15+ files (covered by LB-9)
- [ ] R-8 — signup Resend call un-try/caught
- [ ] R-10 — checkout/create race: claim before Stripe session
- [ ] R-11 — no retry/backoff/circuit breaker on external SDKs
- [ ] R-12 — post-payment confirmation send has no retry/pending queue
- [ ] R-13 — AI-failure overwrites lead.status
- [ ] R-14 — findOrCreateLead no unique constraint backing
- [✓] R-15 — webhook-idempotency fail-open on missing event id (W2-B: sha256(source|body) fallback when caller passes `fallbackBody`; legacy callers still fail-open with TODO(LB-7) warn)
- [ ] R-17 — module-scope service-role clients crash cold start on missing env
- [ ] R-18 — pageIdCache never invalidates on 4xx
- [ ] R-19 — parseInstagramWebhook swallows errors
- [ ] R-20 — saveMessage swallows insert errors
- [ ] R-21 — calendar-sync serial upsert loop

### Performance (HIGH tier)
- [ ] Perf #1/#2/#7 — dashboard 3–5s unbounded polls (deferred — not a code-correctness blocker, tracked for Wave 2-C or backlog)
- [ ] Perf #3 — bulk leads loop serial round-trips
- [ ] Perf #8 — ai_settings full scan on every inbound SMS
- [ ] Perf #9 — findOrCreateLead ilike trailing wildcard
- [ ] Perf #10 — sms-ai serial awaits + unbounded bookings select
- [ ] Perf #11 — calendar-sync serial upsert (duplicate of R-21)
- [ ] Perf #12 — /api/analytics unbounded history
- [✓] Perf #15 — in-memory rate limiter (resolved by LB-10)

### Observability (HIGH tier)
- [ ] F-2 — Sentry beforeSend brittle regex
- [ ] F-3 — no beforeSend on client/edge
- [✓] F-11 — chatbot logs raw AI response (LB-7)
- [✓] F-12 — SMS webhook logs plaintext phone (LB-7)
- [✓] F-14 — OTP insert failures logged with Supabase error objects (LB-7)
- [✓] F-15 — Google OAuth callback logs errorData from token exchange (LB-7)
- [✓] F-16 — Telegram webhook logs full API error bodies (LB-7)
- [✓] R-23 — zero Sentry captures in app code (LB-7; log.error dynamically imports and forwards to Sentry)
- [ ] F-20 — no trace propagation into Supabase/Stripe/Anthropic

### DevOps (HIGH tier)
- [✓] DevOps H1 — 22 ad-hoc supabase/*.sql files outside migrations/ (W1-B) — 21 files promoted to `supabase/migrations/20260405120200..20260405120220_retroactive_*.sql` (actual count was 21, not 22; all DDL, no seeds or scratch scripts). `supabase/performance_indexes.sql` kept as retroactive migration because it differs meaningfully from `20260404_performance_indexes.sql` (different index sets).
- [ ] DevOps H2 — migrations not transactional, no down scripts — DEFERRED from W1-B. Wrapping each existing migration in BEGIN/COMMIT touches every historical file and risks breaking idempotency semantics (e.g. `CREATE EXTENSION` inside a transaction, `DO $$` blocks). Requires coordinated review per-file plus matching down scripts. Tracked as a standalone follow-up wave.
- [ ] DevOps H3 — migration filename collisions / 2024 typo — DEFERRED from W1-B. Hard rule for this wave was "do not rename existing migrations" because any environment that has already applied them would re-apply or diverge from the tracked history. Fix requires coordination with every environment's `schema_migrations` ledger and is out of scope here.
- [ ] DevOps H4 — PM2-vs-Vercel ambiguity in ecosystem.config.js
- [ ] DevOps H5 — vercel.json missing functions.maxDuration + regions
- [ ] DevOps H6 — cron CRON_SECRET enforcement verification

## Notes & scope decisions

- **Migrations are written to disk only.** Applying them to the Supabase project is a human step; each migration file includes a `-- HOW TO APPLY` comment at the top.
- **`.env` is never touched.** Any new env var required (e.g., `ENCRYPTION_KEY`, `UPSTASH_*`) is added to `.env.example` only, with a note in `REMEDIATION-COMPLETE.md` under "Human actions required".
- **Test-first scope is narrow.** Wave 3-A writes tests for every path touched in Waves 1–2, not for untouched code.
- **Conservative scope.** No refactors beyond what each finding requires. Renames are avoided.
- **No cross-agent messaging primitives available.** Waves are sequenced by the main loop, not by agent-to-agent SendMessage.
- **LB-11 rate-limit wrapper (W2-A).** `lib/auth-rate-limit.ts` computes `sha256(email+'|'+ip)` and delegates to the existing in-memory `applyRateLimit`. Backend is still the in-memory Map from `lib/rate-limit.ts` pending W2-C (LB-10); when W2-C swaps the store, this helper keeps working with no changes. A `TODO(LB-10)` marker is left in the wrapper.
- **LB-9 safe-fetch hardening (W2-C).** `lib/safe-fetch.ts` is now a real SSRF guard: scheme allowlist (http/https), DNS-resolve via `dns.promises.lookup({all:true})`, reject any result in `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata), `100.64/10` CGNAT, multicast, reserved, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6; `redirect:"manual"` with manual re-validation on 3xx up to 3 hops; default 15s timeout via `AbortSignal.timeout()`. A separate `safeFetchAllowInternal(url, init)` export skips the private-IP block for trusted callers (scheme+timeout still enforced) — used by the `lib/sms-ai.ts:610` self-to-self payment-link call (so localhost dev still works) and by the Upstash REST client inside the rate limiter. All 15+ raw-fetch callsites listed in R-7 were swapped to `safeFetch`; the critical `lib/ical-parser.ts` path (user-controlled `turo_ical_url`, H2) uses the HARDENED `safeFetch`, not the escape hatch.
- **LB-10 rate limiter backend (W2-C).** `lib/rate-limit.ts` refactored into a `RateLimiterBackend` interface with two implementations: `InMemoryBackend` (the original Map, kept as the dev-only fallback) and `UpstashBackend` (talks to the Upstash Redis REST API via `POST /pipeline` with `INCR` + `EXPIRE NX` + `PTTL` in one round trip — zero new npm dependencies, no `@upstash/redis`/`@upstash/ratelimit` install). `createRateLimiter()` picks Upstash iff both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, else InMemory. Backend choice is logged once at module load with a `TODO(LB-7)` marker for W2-D. On any Upstash error (network, 5xx) the limiter falls back to in-memory and continues serving rather than failing all traffic. The Upstash pipeline call uses `safeFetchAllowInternal` so it cannot recursively get throttled by the rate limiter during its own HTTP call. **Scope deviation:** Node has no sync HTTP client, so `checkRateLimit` and therefore `applyRateLimit` (`lib/api-rate-limit.ts`) and `applyAuthRateLimit` (`lib/auth-rate-limit.ts`) had to become `async`. All 75+ route-handler call sites were updated with a mechanical `await` prefix (no logic changes). The task's "zero caller edits" rule was in direct conflict with the "replace in-memory with Upstash" rule; adding `await` is the minimal possible change. `auth-rate-limit.ts` was touched only to flip its return type from `NextResponse|null` to `Promise<NextResponse|null>` — the sha256(email+'|'+ip) logic is byte-identical. New env vars `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` added to `.env.example` under a new "Shared rate limiter (LB-10)" section.
- **LB-4 Stripe namespacing (W2-B).** Two Stripe webhook routes remain in place; `app/api/stripe-webhook` claims `"stripe:bookings"`, `app/api/payments/webhook` claims `"stripe:payments"`. **Human operator step required:** Stripe dashboard must deliver `checkout.session.completed` to BOTH endpoint URLs so each half of the business logic (booking_deposit vs IG/SMS flow) still runs. This cannot be verified from code.
- **LB-5b RPC (W2-B).** Migration `20260405140000_confirm_booking_rpc.sql` defines `confirm_booking_and_lead(...)`. Signature took 15 params (not 13 from the audit draft) because (a) `p_lead_id` is nullable to match the existing flow where IG/SMS checkouts sometimes lack a lead, (b) `p_stripe_payment_intent` is needed (booking row persists it), (c) `p_lead_notes` lets the caller override the lead's `notes` column without a second round-trip. Column-name audit: `bookings.total_amount`, `bookings.deposit_amount`, `bookings.deposit_paid`, `bookings.stripe_session_id`, `bookings.stripe_payment_intent`, `bookings.customer_{name,email,phone}`, `bookings.currency` — all verified against `20260319_bookings_lead_id.sql`, `20260405120203_retroactive_bookings_stripe_columns.sql`, and the existing `.insert({...})` shape at `app/api/payments/webhook/route.ts:219`. `messages` columns verified against `lib/sms-ai.ts:682` (`user_id, lead_id, content, direction`).
- **LB-7 structured logger + Sentry wiring (W2-D).** New `lib/log.ts` (~160 lines, pure Node + dynamic `@sentry/nextjs` import, no new deps): `log.debug|info|warn` write single-line JSON to `process.stdout`; `log.error(msg, err, ctx?)` writes to `process.stderr` AND calls `Sentry.captureException(err, { extra: scrub(ctx) })`. Scrubber redacts any key matching `/token|secret|key|password|passwd|otp|phone|email|refresh|authorization|bearer|cookie|session|api[_-]?key|access[_-]?token|stripe[_-]?key|webhook[_-]?secret/i`, plus value-level redaction of JWT (`eyJ...`) and Stripe (`sk_`, `pk_`, `rk_`, `whsec_`) patterns, with a max recursion depth of 5. `log.debug` only emits when `LOG_LEVEL=debug`. All three `sentry.*.config.ts` files gained `release: process.env.VERCEL_GIT_COMMIT_SHA` (client uses `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || VERCEL_GIT_COMMIT_SHA`); the brittle-regex `beforeSend` scrub (F-2/F-3) is explicitly out of scope and remains a backlog item. **Migration scope:** all 17 audit-flagged PII/token leak sites (F-7 through F-16) fixed by hand with minimal, scrubbed context. The remaining ~230 server-side `console.*` calls across `app/api/**` and `lib/**` were migrated mechanically by `/tmp/migrate_console.py` (kept in /tmp only; not committed), which (a) inserts `import { log } from "@/lib/log"`, (b) rewrites `console.log|info` → `log.info`, `console.warn` → `log.warn`, `console.debug` → `log.debug`, `console.error` → `log.error` with heuristic arg reassignment. `find_matching_paren` handles multi-line calls; client components (`"use client"`) and `.tsx` pages are skipped because `log.ts` uses `process.stdout.write` and cannot run in the browser. **F-13 (velocity-ai info disclosure):** `details: error?.message` field dropped from the client response; server logs via `log.error` instead. **F-10 (payments webhook):** confirmation-body logs replaced with `{ channel, route }` only; no customer name/phone/booking details. **TODO(LB-7) markers left by W2-B (`app/api/stripe-webhook/route.ts`, `app/api/payments/webhook/route.ts`) and W2-C (`lib/rate-limit.ts`) were removed** and their underlying `console.*` calls replaced with `log.*`. **Console residual:** 245 → 71, and all 71 are in `.tsx`/client files (dashboards, settings panels, React error boundaries `error.tsx`/`global-error.tsx`, one `lib/dashboard-cache.tsx` `"use client"` cache) — migrating them requires a browser-safe logger shim, which is NOT in LB-7's scope. `tsc --noEmit` is clean. `grep -rn "Sentry\.(captureException|captureMessage)" app/ lib/` still returns zero direct hits, but every `log.error` forwards to `captureException` via dynamic import, which is the R-23 remediation.
- **LB-12 currency (W2-B).** Neither `businesses` nor `bookings` had a `currency` column before this wave — confirmed by grep over `supabase/migrations/*.sql` (zero matches). Migration `20260405140100_businesses_currency.sql` adds `currency TEXT NOT NULL DEFAULT 'USD'` with an ISO-4217 regex CHECK to both tables. Until that migration is applied, the 4 checkout routes fall back to `process.env.DEFAULT_CURRENCY || 'USD'` via `lib/currency.ts` `DEFAULT_CURRENCY`. `app/api/payments/create-checkout` and `app/api/checkout/create` and `app/api/create-checkout` also now attempt to `SELECT businesses.currency WHERE owner_user_id = ?` (wrapped in try/catch so pre-migration deploys don't crash on unknown-column errors). `app/api/bookings/checkout` reads an optional `currency` field off the `bookings` row. All 4 routes lowercase the code for Stripe and validate against `SUPPORTED_CURRENCIES`, logging and falling back to `usd` on anything unsupported.
