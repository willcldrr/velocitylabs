# Velocity Labs — Remediation Complete

**Branch:** `fix/prod-readiness-remediation`
**Baseline:** `765b811` (audit score **28/100**)
**Head:** `fb87796` (10 commits on branch)
**Date:** 2026-04-05

## Verification summary

| Gate | Result |
|---|---|
| All 11 Launch Blockers marked `[✓]` in `.audit/remediation-status.md` | **YES** (LB-2 through LB-12) |
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` | **14 files, 80 tests passing** |
| Coverage on Wave 1-2 remediated paths | **71.84% lines, 57.45% branches, 92.30% functions, 69.41% stmts** (floor 40/30/40/40) |
| `console.*` in server code (`app/api` + `lib`, excluding `"use client"` files) | **0** |
| CI `no-console` job added (fails build on regression) | **YES** |
| `build` job `needs:` includes `test`, `audit`, `no-console` | **YES** |
| `.env` gitignored | **YES (verified in `.gitignore:9-12`)** |
| Migrations applied to DB | **NO — disk only, per instructions** |
| `.env` modified | **NO — never touched** |

---

## Changes by Launch Blocker

### LB-2 — `/api/admin/restore-session` lateral takeover
**Commit:** `aa274f6` (Wave 2-A)
**Files:** `app/api/admin/restore-session/route.ts`, `supabase/migrations/20260405130000_audit_logs.sql`, `.env.example`
- Handler now calls `supabase.auth.getUser()` and requires caller id == target id (self-only restore).
- Env-gated kill switch `ENABLE_SESSION_RESTORE=false` returns 503 when the endpoint is disabled.
- Every successful call writes an `audit_logs` row (new generic table, not overloading `impersonation_logs`).
- Adjacent fix: removed `console.log` of `verifyOtp` result in `app/api/admin/impersonate/route.ts:84` (resolves M9).

### LB-3 — Instagram OAuth `state`-as-userId hijack
**Commit:** `aa274f6` (Wave 2-A)
**Files:** `app/api/instagram/callback/route.ts`, `app/api/instagram/auth/route.ts`
- `state` is now `crypto.randomBytes(32).toString('hex')` — a pure random CSRF token.
- Callback resolves `userId` from `supabase.auth.getUser()` (cookie-auth server client), never from the state payload.
- State compared with `timingSafeEqual` on equal-length Buffers.
- Any caller that previously passed `userId` via the state payload now has it ignored; the session user is authoritative.

### LB-4 — Stripe webhook race + IG/Telegram idempotency
**Commit:** `ca4bffc` (Wave 2-B)
**Files:** `app/api/stripe-webhook/route.ts`, `app/api/payments/webhook/route.ts`, `app/api/instagram/webhook/route.ts`, `app/api/telegram/webhook/route.ts`, `lib/webhook-idempotency.ts`
- Namespaced idempotency: `stripe:bookings` vs `stripe:payments` (dashboard vs IG/SMS flows) — no more race on one key.
- Instagram: `claimWebhookEvent("instagram", message.mid, "dm.inbound", body)` inside `processInstagramMessage`.
- Telegram: `claimWebhookEvent("telegram", String(update.update_id), ...)` after secret verification.
- `WebhookSource` union widened to accept the new namespaced literals.
- **R-15 hardening:** fallback branch (missing `eventId`) now computes a stable `sha256(source|body)` and ledgers it, instead of silently fail-open.

### LB-5a — Booking vehicle-overlap constraint
**Commit:** `5b8c614` (Wave 1-B)
**File:** `supabase/migrations/20260405120100_booking_overlap_constraint.sql`
- `CREATE EXTENSION IF NOT EXISTS btree_gist`.
- `ALTER TABLE bookings ADD CONSTRAINT bookings_no_vehicle_overlap EXCLUDE USING gist (vehicle_id WITH =, daterange(start_date, end_date, '[)') WITH &&) WHERE (status NOT IN ('cancelled', 'rejected'))`.
- Idempotent pre-drop via `DO $$` block. Includes `SQLSTATE 23P01` handling guidance in a `COMMENT`.

### LB-5b — Post-payment multi-step mutation → transactional RPC
**Commit:** `ca4bffc` (Wave 2-B)
**Files:** `supabase/migrations/20260405140000_confirm_booking_rpc.sql`, `app/api/payments/webhook/route.ts`
- New Postgres function `confirm_booking_and_lead(...)` performs `insert bookings` + `update leads` + `insert messages` in a single transaction with `SECURITY DEFINER`.
- Catches `SQLSTATE 23P01` from LB-5a's constraint and raises `booking_conflict: vehicle already booked for those dates`, which the route surfaces as a user-visible 409.
- The webhook handler replaces the three sequential writes with a single `supabase.rpc("confirm_booking_and_lead", {...})`.
- Confirmation SMS/IG send still runs *after* the RPC (money-first, notification-best-effort). `TODO(HP-2)` comment flags the pending_notifications queue as a future task.

### LB-6 — Encrypt per-tenant secrets; hash API keys
**Commit:** `e6f5622` (Wave 1-A)
**Files:** `lib/crypto.ts` (new), 11 route/lib callsites, `supabase/migrations/20260405120000_encrypt_secrets_at_rest.sql`, `.env.example`
- `lib/crypto.ts`: AES-256-GCM `encrypt/decrypt` with random 12-byte IV, auth-tag verification, base64 envelope. `hashApiKey` (SHA-256 hex), `verifyApiKey` (constant-time via `timingSafeEqual`). Lazy-loaded `ENCRYPTION_KEY` (32-byte hex).
- Migration adds `encrypted_*` + iv + tag columns on `businesses`, `deposit_portal_config`, `instagram_connections`, plus `key_hash` + index on `api_keys`. **Plaintext columns preserved** — a follow-up migration after backfill will drop them.
- Dual-read / dual-write at every callsite for Stripe keys and IG access tokens. Legacy rows without encrypted columns still work until backfill.
- `lib/survey-auth.ts` looks up by `key_hash` first, falls back to plaintext + `timingSafeEqual` for legacy rows.
- `ENCRYPTION_KEY=` placeholder added to `.env.example` with `openssl rand -hex 32` comment.
- **Bug fix in commit `d213d35`:** `decrypt()` guard rejected empty-string round-trips; tightened to `typeof === "string"` check. Caught by Wave 3-A tests.

### LB-7 — Structured logger + Sentry wiring; redact console.*
**Commit:** `14b96de` (Wave 2-D)
**Files:** `lib/log.ts` (new, ~160 lines), `sentry.{server,client,edge}.config.ts`, 66 touched files
- `lib/log.ts`: JSON-line logger (`debug`/`info`/`warn`/`error`), recursive `scrub()` that redacts context keys matching a wide regex (`token|secret|key|password|otp|phone|email|refresh|authorization|bearer|cookie|session|api[_-]?key|access[_-]?token|stripe[_-]?key|webhook[_-]?secret`) and also value-level patterns for JWTs, Stripe `sk_`/`pk_`/`whsec_`/`rk_`, and long bearer tokens. Depth cap of 5 prevents cycles. `log.error` dynamically imports `@sentry/nextjs` and calls `captureException` — edge-safe.
- Sentry configs now include `release: process.env.VERCEL_GIT_COMMIT_SHA` (client uses `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`).
- All F-7 through F-16 PII/token leak sites hand-migrated with scrubbed context. 47 lower-risk files mechanically migrated.
- **console.* residual in server code:** 327 → **0** (all 71 remaining hits live in `"use client"` components; browser-side Sentry already catches them via `sentry.client.config.ts`).
- CI `no-console` job added in Wave 3-B as a regression guard.

### LB-8 — Stripe webhook 500 on transient errors; Sentry escalation
**Commit:** `ca4bffc` (Wave 2-B), finalized by `14b96de` (Wave 2-D log wiring)
**Files:** `app/api/stripe-webhook/route.ts`, `app/api/payments/webhook/route.ts`
- Errors split into **terminal** (amount mismatch, unknown source, booking_conflict → 200 + `markWebhookEventProcessed(..., "processed", reason)`) and **transient** (Supabase 5xx, network, unexpected → 500 + `markWebhookEventProcessed(..., "failed", error)` so Stripe retries).
- Every error branch now goes through `log.error` which forwards to `Sentry.captureException` (resolves **R-23** — zero Sentry captures was the original state).

### LB-9 — SSRF-safe fetch + timeouts everywhere
**Commit:** `6d704fa` (Wave 2-C)
**Files:** `lib/safe-fetch.ts` (rewritten), 15+ raw-fetch callsites
- `lib/safe-fetch.ts` is now a real SSRF guard:
  - Scheme allowlist (`http:`/`https:` only).
  - `dns.promises.lookup({ all: true })` + `isBlockedIp()` covering `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata), `100.64/10` CGNAT, `0.0.0.0/8`, `198.18/15`, multicast/reserved, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6, empty hosts.
  - `redirect: "manual"` with manual re-validation on 3xx (cap 3 hops).
  - 15 s default timeout via `AbortSignal.timeout()`.
  - `safeFetchAllowInternal()` escape hatch for trusted self-to-self lambda hops.
- All 15+ raw `fetch(` callsites in `instagram/*`, `telegram/*`, `domain/*`, `cron/refresh-instagram-tokens`, `crm/google-calendar.ts` swapped to `safeFetch(url, { timeoutMs: … })` — 10 s for hot paths, 30 s for OAuth exchanges.
- **`lib/ical-parser.ts`** (user-controlled `turo_ical_url`, the highest-impact SSRF vector) uses the hardened `safeFetch` — closes H2 SSRF directly.
- `lib/sms-ai.ts` self-call to `/api/payments/create-checkout` uses `safeFetchAllowInternal` so local dev still works.
- **Bug fix in commit `d213d35`:** IPv6 bracketed literals (`[::1]`, `[fc00::1]`) bypassed the `isIP()` guard because `URL.hostname` returns them wrapped; added bracket stripping. Caught by Wave 3-A tests.

### LB-10 — Pluggable rate limiter backend
**Commit:** `6d704fa` (Wave 2-C)
**Files:** `lib/rate-limit.ts` (refactored), `lib/api-rate-limit.ts`, `lib/auth-rate-limit.ts`, `.env.example`, ~65 call sites (mechanical `await` prefix)
- `lib/rate-limit.ts` factored into a `RateLimiterBackend` interface with `InMemoryBackend` (dev) and `UpstashBackend` (Upstash Redis REST via plain `safeFetchAllowInternal` — no `@upstash/*` npm dependency).
- `createRateLimiter()` picks `Upstash` iff both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, else `InMemory`. Upstash errors degrade gracefully to in-memory — **never fail closed**.
- `applyRateLimit` is now `async` (Node has no sync HTTP). ~75 call sites received a one-word `await` prefix; **zero logic changes** in any callsite.
- `.env.example`: new `# Shared rate limiter (LB-10)` section.
- Existing `lib/auth-rate-limit.ts` composite-key wrapper from Wave 2-A keeps working unchanged (return type async-converted).

### LB-11 — OTP brute-force hardening
**Commit:** `aa274f6` (Wave 2-A)
**Files:** `app/api/auth/verify-otp/route.ts`, `app/api/auth/reset-password/route.ts`, `app/api/auth/forgot-password/route.ts`, `app/api/auth/resend-otp/route.ts`, `lib/auth-rate-limit.ts` (new), `supabase/migrations/20260405130100_otp_hardening.sql`
- Every failed OTP match increments `failed_attempts`. At 5 failures, the row is marked `locked_at + used=true`, the next attempt returns 429, and a fresh OTP is required.
- Composite `(email + IP)` rate key via `lib/auth-rate-limit.ts`: `sha256(email.toLowerCase() + '|' + ip)`. An attacker cannot bypass by rotating either axis.
- OTP TTL confirmed at 10 minutes max (already the case).
- Migration adds `locked_at`, re-declares `failed_attempts` with `IF NOT EXISTS`, and adds a `(email, created_at desc)` index.

### LB-12 — Currency threaded through Stripe checkout
**Commit:** `ca4bffc` (Wave 2-B)
**Files:** `app/api/bookings/checkout/route.ts`, `app/api/payments/create-checkout/route.ts`, `app/api/checkout/create/route.ts`, `app/api/create-checkout/route.ts`, `supabase/migrations/20260405140100_businesses_currency.sql`
- Each route reads `businesses.currency` inside a try/catch, validates against `SUPPORTED_CURRENCIES`, falls back to `process.env.DEFAULT_CURRENCY || 'USD'`, lowercases for Stripe.
- `payments/create-checkout` and `checkout/create` stamp `metadata.currency` so the webhook RPC receives it.
- Migration adds `currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$')` to **both** `businesses` and `bookings` (so booking rows persist the currency they were charged in).
- Pre-migration deploys do not crash: the try/catch falls through to env / default.

---

## Also resolved along the way (HIGH-severity audit findings)

- **Security H3, H4, H5** — plaintext Stripe keys, IG tokens, api_keys (resolved by LB-6).
- **Security H6** — OTP brute force (LB-11).
- **Security H7** — in-memory rate limit (LB-10).
- **Security H1, H2** — safe-fetch SSRF + `turo_ical_url` (LB-9).
- **Security M5** — admin businesses accepts plaintext Stripe keys (LB-6).
- **Security M9** — impersonate logs verifyOtp result (LB-7 + adjacent W2-A removal).
- **Reliability R-1, R-2, R-3** — Stripe webhook race, IG/TG no idempotency (LB-4).
- **Reliability R-4** — no DB overlap constraint (LB-5a).
- **Reliability R-5** — multi-step mutation not atomic (LB-5b).
- **Reliability R-6** — iCal parser fetches user-controlled URL with no timeout (LB-9).
- **Reliability R-7** — 15+ raw fetch callsites (LB-9).
- **Reliability R-9** — webhook 200-on-internal-error (LB-8).
- **Reliability R-15** — idempotency fallback fail-open (LB-4 extension).
- **Reliability R-22** — in-memory rate limiter under load (LB-10).
- **Reliability R-23** — zero Sentry captures in app code (LB-7).
- **Observability F-1, F-7, F-8, F-9, F-10, F-11, F-12, F-14, F-15, F-16** — Sentry not called; PII/token leaks in logs (LB-7).
- **Observability F-13** — velocity-ai returns raw error.message to client (LB-7).
- **Performance #15** — in-memory rate limiter (LB-10).
- **Testing T-04, T-05, T-09, T-11** — Telegram/IG idempotency tests, currency, rate limiter (LB-4/LB-12/LB-10 + Wave 3-A test coverage).
- **DevOps C1** — not fully resolved (CI branch protection must be configured on GitHub itself, out-of-tree). Wave 3-B tightened the workflow; human must toggle branch protection.
- **DevOps C2** — no runbook/DR docs → `docs/RUNBOOK.md` created.
- **DevOps C3** — no README → `README.md` created.
- **DevOps H1** — 22 (actually 21) ad-hoc `supabase/*.sql` files adopted into the migration pipeline as `retroactive_*` with provenance headers (Wave 1-B).
- **DevOps H5** — `vercel.json` had no function config → added `functions` block with per-route `maxDuration`.
- **DevOps M3** — `build` job did not depend on `test`/`audit` → expanded `needs: [lint, typecheck, test, audit, no-console]`.

---

## 🔴 HUMAN ACTIONS REQUIRED BEFORE DEPLOYING

The remediation is code-complete but several steps cannot be automated from this session. **Do all of these before shipping the branch to production.**

1. **Rotate every secret found in `/var/www/velocity/.env`.** The audit found live production values (`sk_live_…`, Supabase service-role JWT, Twilio, Anthropic, Resend, Meta, `CRON_SECRET`) sitting in plaintext at the working directory. This branch does not touch that file, so rotation is still your job. After rotating, update Vercel env vars and ensure the host no longer has a `.env` with secrets.
2. **Generate and set `ENCRYPTION_KEY`.** Run `openssl rand -hex 32`, paste into Vercel env vars (Production + Preview + Development). Without this var, `lib/crypto.ts` throws at first use. Once set, the encryption-at-rest path works; until a backfill runs, the dual-read path reads legacy plaintext columns.
3. **Write and run the encryption backfill.** A one-time script that reads every row with a non-null plaintext column (`businesses.stripe_secret_key`, `deposit_portal_config.stripe_secret_key`, `instagram_connections.access_token`), calls `encrypt()`, and writes the resulting trio into the `encrypted_*` columns. After verification, author a follow-up migration to drop the plaintext columns. **Not in this PR** — intentionally deferred per LB-6 dual-read strategy.
4. **Apply the new migrations in order** via `supabase db push` or the Supabase SQL editor:
    - `20260405120000_encrypt_secrets_at_rest.sql`
    - `20260405120100_booking_overlap_constraint.sql`
    - `20260405120200…120220_retroactive_*.sql` (21 files from Wave 1-B — review each first; several use `IF NOT EXISTS` and are safe to re-apply, a few do not)
    - `20260405130000_audit_logs.sql`
    - `20260405130100_otp_hardening.sql`
    - `20260405140000_confirm_booking_rpc.sql`
    - `20260405140100_businesses_currency.sql`
    Until `20260405140000` is applied, `/api/payments/webhook` will return 500 (transient) on every Instagram-flow event because `supabase.rpc('confirm_booking_and_lead')` will not resolve.
5. **Set up Upstash Redis (optional but strongly recommended for production).** Create a database at upstash.com, copy `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` into Vercel env. Without these, the rate limiter runs in in-memory mode per-instance — effectively off across serverless cold starts, but the system will not crash. The audit gave this a 🔴.
6. **Verify Stripe webhook delivery.** In the Stripe dashboard, confirm that `checkout.session.completed` is delivered to **both** `/api/stripe-webhook` AND `/api/payments/webhook`. Without dual delivery, one of the two business-logic branches (dashboard-invoice flow vs IG/SMS flow) is dead. The namespaced idempotency (LB-4) requires that each endpoint actually receives the event.
7. **Configure GitHub branch protection** on `main` to require `Lint`, `Typecheck`, `Test`, `Audit`, `no-console`, `Build` as required status checks. Wave 3-B added the `no-console` job; branch protection is a GitHub console toggle this session cannot flip. Resolves DevOps C1.
8. **Set `ENABLE_SESSION_RESTORE=false` in production Vercel env.** LB-2 ships with the endpoint behind a kill switch; default is off. Only set to `true` if the endpoint is actively used by admin tooling (read the audit C2 finding first — this endpoint may not have a legitimate use case).
9. **Fill in `<FILL IN:>` placeholders in `docs/RUNBOOK.md`** — on-call contacts, PagerDuty URL, Vercel project URL, Sentry org/project, vendor support contacts, Supabase region, Supabase PITR retention window.
10. **Populate `businesses.currency` for non-USD tenants** after migration `20260405140100` lands. The migration defaults to `USD`, so USD tenants continue working immediately; EUR/GBP/other tenants need an `UPDATE businesses SET currency = 'EUR' WHERE …`.
11. **Review all 21 `retroactive_*.sql` migrations** before running. Most use `IF NOT EXISTS` and are idempotent; a few (`access_codes`, `client_invoices`, `add_admin_field`) do not and will fail if re-applied to a database that already has the objects. The provenance header on each file explains the original ad-hoc path.

---

## DEFERRED items (tracked, not shipped in this PR)

These were flagged during the remediation but intentionally left for a follow-up PR to keep scope contained:

| ID | Item | Deferred by | Reason |
|---|---|---|---|
| LB-6 cutover | Drop plaintext `stripe_secret_key` / `access_token` / `api_keys.key` columns | W1-A | Requires production backfill + verification window |
| HP-2 | `pending_notifications` queue for failed post-payment SMS/IG sends | W2-B | Design + new table + cron — out of LB scope |
| HP-18 | Feature flags / kill switches (`FEATURE_AI_SMS`, `FEATURE_BULK_SMS`, etc.) | All | Infra change, not a single-LB fix |
| DevOps H2 | Wrap each migration in `BEGIN;…COMMIT;` + write `*.down.sql` | W1-B | Per-file review, separate PR |
| DevOps H3 | Rename existing migrations to `YYYYMMDDHHMMSS` full timestamps | W1-B | Forbidden by hard rule (renames break applied history) |
| DevOps H4 | Resolve PM2-vs-Vercel ambiguity in `ecosystem.config.js` | W3-B | Decision needed from human (which is canonical) |
| DevOps H6 | Verify each cron handler enforces `CRON_SECRET` bearer auth | W3-B | Requires runtime verification, not code review |
| DevOps M1 | Hardcode `typescript.ignoreBuildErrors: false` in `next.config.mjs` | W3-B | Conservative scope; safe in prod, minor hygiene |
| DevOps M2 | Wire `scripts/verify-migrations.mjs` into CI against staging | W3-B | Requires staging Supabase URL, out-of-tree |
| DevOps M4 | Remove `--legacy-peer-deps` flag from CI | W3-B | Requires resolving the underlying peer conflict first |
| Perf #1/#2/#7 | Kill 3–5 s dashboard polling, add `.limit()` to list queries | not assigned | Not a code-correctness blocker; scheduled as HP-21 |
| Sentry F-2/F-3 | Fix brittle `beforeSend` PII regex; add to client/edge | W2-D | Beyond LB-7 scope |
| Client-side console.* | 71 hits in `"use client"` components need a browser-safe logger shim | W2-D | Needs a separate log surface (`navigator.sendBeacon` / Sentry browser) |

---

## Estimated new score

The audit scored the baseline at **28/100**. With all 11 launch blockers closed, HIGH-severity findings largely covered, structured logging + Sentry escalation wired, SSRF hardened, rate limiting pluggable, and an 80-test safety net in place:

| Domain | Baseline | New | Delta |
|---|---|---|---|
| Security | 22 | **70** | +48 |
| Reliability | 28 | **72** | +44 |
| Testing & Quality | 8 | **55** | +47 |
| Observability | 18 | **65** | +47 |
| Performance | 42 | **52** | +10 |
| Infra & DevOps | 48 | **70** | +22 |

**Overall: 28 → ~64 / 100.**

Not a perfect score. What's holding it back:
- Performance domain still has dashboard polling, N+1 loops, and no background queue for bulk SMS / AI follow-ups (HP-21 through HP-25 unaddressed). These are not launch blockers but they will bite under load.
- The encryption backfill and plaintext column drop are human steps — until they run, the system is only *capable* of encryption, not *enforcing* it.
- Upstash setup and Stripe dual-delivery verification are human steps.
- Testing coverage is 71% on *remediated* paths but closer to 10% for the whole codebase — HP-26 (broader coverage) is backlog.
- DevOps H2/H3/H4 are unresolved.

A follow-up pass covering HP-21 through HP-33 (performance + observability + DevOps backlog) would plausibly push the score into the 80s.

---

## No BLOCKED items remain

Wave 3-A initially flagged two bugs (`crypto.decrypt` empty-string guard, `safe-fetch` IPv6 bracket bypass). Both were fixed in commit `d213d35` and the corresponding tests were updated to assert the post-fix contract. No agent ended in a BLOCKED state.

---

## Branch contents

```
fb87796 fix(tests): type-level fixes so tsc --noEmit passes in CI
97d740d Wave 3-B: README, RUNBOOK, CI console-guard, vercel.json
d213d35 fix: two bugs found by Wave 3-A tests (LB-6, LB-9)
4cf25b8 Wave 3-A: tests for Wave 1-2 remediated paths
14b96de LB-7: structured logger + Sentry escalation; migrate console.*
6d704fa LB-9, LB-10: SSRF-safe fetch + pluggable rate limiter
ca4bffc LB-4, LB-5b, LB-8, LB-12: payments + webhook reliability
aa274f6 LB-2, LB-3, LB-11: auth hardening
5b8c614 LB-5a + DevOps H1: booking overlap constraint; adopt ad-hoc SQL
e6f5622 LB-6: encrypt per-tenant secrets at rest; hash api_keys
```
(baseline `765b811` on `master`)
