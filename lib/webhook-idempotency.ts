/**
 * Webhook idempotency helper.
 *
 * Every inbound webhook (Stripe, Twilio, Instagram) must call claimWebhookEvent
 * BEFORE running any side effect. The helper attempts to insert a row into the
 * webhook_events ledger keyed on (source, event_id). If the insert succeeds,
 * this delivery is new and the handler should proceed. If the insert fails due
 * to the UNIQUE (source, event_id) constraint, a previous delivery already
 * claimed it and the handler must short-circuit with a 200 response so the
 * provider stops retrying.
 *
 * Once the handler finishes its side effects, it should call markWebhookEventProcessed
 * so ops can tell "received but failed" apart from "received and succeeded".
 *
 * This module uses the service role client directly; it must only be imported
 * from server code.
 */

import { createHash } from "crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { log } from "@/lib/log"

// LB-4: `WebhookSource` was a closed union but we now namespace Stripe into
// `"stripe:bookings"`, `"stripe:dashboard"`, `"stripe:payments"` so the two
// Stripe webhook routes don't race on the same Stripe `event.id`. Widen to
// `string` (with the historical literals kept for documentation and IDE hints)
// rather than maintaining a churny union.
export type WebhookSource =
  | "stripe"
  | "stripe:bookings"
  | "stripe:dashboard"
  | "stripe:payments"
  | "twilio"
  | "instagram"
  | "telegram"
  | (string & {})

export interface ClaimResult {
  /** True if THIS delivery won the race and should process the event. */
  claimed: boolean
  /** The row id in webhook_events; useful for follow-up updates. */
  rowId?: string
  /**
   * When claimed === false, indicates why. Currently always "duplicate",
   * but future values may include "error" for unexpected insert failures.
   */
  reason?: "duplicate" | "error"
}

let cachedClient: SupabaseClient | null = null

function getServiceClient(): SupabaseClient {
  if (cachedClient) return cachedClient
  cachedClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  return cachedClient
}

/**
 * Attempt to claim an inbound webhook event as "first delivery". Returns
 * { claimed: true, rowId } on a fresh event, { claimed: false, reason: "duplicate" }
 * on a retry the ledger has already seen.
 *
 * Callers should treat any non-claimed result as "already handled" and return
 * a 2xx response so the provider stops retrying.
 */
export async function claimWebhookEvent(
  source: WebhookSource,
  eventId: string,
  eventType?: string,
  fallbackBody?: string
): Promise<ClaimResult> {
  // R-15: if no provider-assigned id was supplied, we previously returned
  // `{ claimed: true }` without recording anything, which silently re-ran
  // every retry. Callers that can pass a `fallbackBody` (the raw request body
  // or a canonical preview) now get a stable sha256(source|body) synthetic id
  // so retries dedupe. Callers without access still fall open, but we log
  // loudly so Wave 2-D (LB-7) can surface it to Sentry.
  if (!eventId) {
    if (fallbackBody) {
      const hash = createHash("sha256")
        .update(source)
        .update("|")
        .update(fallbackBody)
        .digest("hex")
      eventId = `fallback:${hash}`
    } else {
      log.warn("[webhook-idempotency] fail-open: no eventId", { source })
      return { claimed: true }
    }
  }

  const supabase = getServiceClient()

  const { data, error } = await supabase
    .from("webhook_events")
    .insert({
      source,
      event_id: eventId,
      event_type: eventType ?? null,
      status: "received",
    })
    .select("id")
    .single()

  if (!error && data) {
    return { claimed: true, rowId: data.id as string }
  }

  // Postgres unique violation = duplicate delivery. PostgREST surfaces this as
  // error.code "23505".
  if (error && (error as { code?: string }).code === "23505") {
    return { claimed: false, reason: "duplicate" }
  }

  // Any other error is unexpected. Log it and let the handler proceed — we'd
  // rather risk a rare double-process than silently drop a legitimate event.
  log.error(`[webhook-idempotency] unexpected insert error for ${source}/${eventId}:`, error)
  return { claimed: true, reason: "error" }
}

/**
 * Mark a previously-claimed event as processed. Failure here is non-fatal for
 * the webhook response — the side effects have already succeeded, this is
 * just bookkeeping.
 */
export async function markWebhookEventProcessed(
  rowId: string | undefined,
  outcome: "processed" | "failed",
  errorMessage?: string
): Promise<void> {
  if (!rowId) return
  const supabase = getServiceClient()
  await supabase
    .from("webhook_events")
    .update({
      status: outcome,
      processed_at: new Date().toISOString(),
      error: errorMessage ?? null,
    })
    .eq("id", rowId)
}
