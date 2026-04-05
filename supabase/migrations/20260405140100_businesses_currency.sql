-- HOW TO APPLY: review, then `supabase db push` or paste into SQL editor.
-- LB-12: thread per-business currency through the Stripe checkout path.
--
-- Context: `lib/currency.ts` defines 5 supported currencies (USD/EUR/GBP/
-- CAD/AUD) and `formatCurrency`/`convertCurrency` helpers, but four
-- checkout routes hardcoded `currency: "usd"`. Testing finding T-09.
--
-- This migration adds a nullable `currency` column (default 'USD') to
-- `businesses` and `bookings` so the money path has a persistent source
-- of truth per tenant and per booking. The checkout-route code also
-- honours `process.env.DEFAULT_CURRENCY` as a fallback when the businesses
-- row is not fetched by that route (several routes do not join businesses
-- today — a follow-up can widen them).

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'
  CHECK (currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN businesses.currency IS
  'LB-12: ISO 4217 code (uppercase). Must be one of lib/currency.ts SUPPORTED_CURRENCIES or the checkout route will log and fall back to USD.';

-- Bookings need to persist the currency they were transacted in so invoices
-- and refunds don't drift.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'
  CHECK (currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN bookings.currency IS
  'LB-12: ISO 4217 code the Stripe session was created in. Copied from businesses.currency at checkout time.';
