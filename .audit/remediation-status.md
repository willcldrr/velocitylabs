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
| LB-7 | [ ] | Structured logger + Sentry wiring; redact 245 console.* | W2-D |
| LB-8 | [✓] | Stripe webhook 500 on internal errors; Sentry capture | W2-B |
| LB-9 | [ ] | safe-fetch SSRF hardening + fetch timeouts everywhere | W2-C |
| LB-10 | [ ] | Replace in-memory rate limiter with shared store | W2-C |
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
- [ ] R-7 — raw fetch w/o timeout in 15+ files (covered by LB-9)
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
- [ ] Perf #15 — in-memory rate limiter (resolved by LB-10)

### Observability (HIGH tier)
- [ ] F-2 — Sentry beforeSend brittle regex
- [ ] F-3 — no beforeSend on client/edge
- [ ] F-11 — chatbot logs raw AI response (covered by LB-7)
- [ ] F-12 — SMS webhook logs plaintext phone (covered by LB-7)
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
- **LB-4 Stripe namespacing (W2-B).** Two Stripe webhook routes remain in place; `app/api/stripe-webhook` claims `"stripe:bookings"`, `app/api/payments/webhook` claims `"stripe:payments"`. **Human operator step required:** Stripe dashboard must deliver `checkout.session.completed` to BOTH endpoint URLs so each half of the business logic (booking_deposit vs IG/SMS flow) still runs. This cannot be verified from code.
- **LB-5b RPC (W2-B).** Migration `20260405140000_confirm_booking_rpc.sql` defines `confirm_booking_and_lead(...)`. Signature took 15 params (not 13 from the audit draft) because (a) `p_lead_id` is nullable to match the existing flow where IG/SMS checkouts sometimes lack a lead, (b) `p_stripe_payment_intent` is needed (booking row persists it), (c) `p_lead_notes` lets the caller override the lead's `notes` column without a second round-trip. Column-name audit: `bookings.total_amount`, `bookings.deposit_amount`, `bookings.deposit_paid`, `bookings.stripe_session_id`, `bookings.stripe_payment_intent`, `bookings.customer_{name,email,phone}`, `bookings.currency` — all verified against `20260319_bookings_lead_id.sql`, `20260405120203_retroactive_bookings_stripe_columns.sql`, and the existing `.insert({...})` shape at `app/api/payments/webhook/route.ts:219`. `messages` columns verified against `lib/sms-ai.ts:682` (`user_id, lead_id, content, direction`).
- **LB-12 currency (W2-B).** Neither `businesses` nor `bookings` had a `currency` column before this wave — confirmed by grep over `supabase/migrations/*.sql` (zero matches). Migration `20260405140100_businesses_currency.sql` adds `currency TEXT NOT NULL DEFAULT 'USD'` with an ISO-4217 regex CHECK to both tables. Until that migration is applied, the 4 checkout routes fall back to `process.env.DEFAULT_CURRENCY || 'USD'` via `lib/currency.ts` `DEFAULT_CURRENCY`. `app/api/payments/create-checkout` and `app/api/checkout/create` and `app/api/create-checkout` also now attempt to `SELECT businesses.currency WHERE owner_user_id = ?` (wrapped in try/catch so pre-migration deploys don't crash on unknown-column errors). `app/api/bookings/checkout` reads an optional `currency` field off the `bookings` row. All 4 routes lowercase the code for Stripe and validate against `SUPPORTED_CURRENCIES`, logging and falling back to `usd` on anything unsupported.
