-- HOW TO APPLY: review, then `supabase db push` or paste into SQL editor.
-- LB-5b: atomic post-payment booking confirmation.
-- Catches 23P01 (exclusion_violation from LB-5a overlap constraint) and
-- raises a user-facing error the route handler can detect.
--
-- Column names were verified against the existing code paths:
--   bookings: user_id, vehicle_id, lead_id, start_date, end_date,
--             total_amount, deposit_amount, currency (added by LB-12 in
--             20260405140100_businesses_currency.sql — if not yet applied,
--             this RPC still stores whatever string the caller passes so
--             the column must exist by the time this function is called),
--             status, stripe_session_id, stripe_payment_intent,
--             customer_name, customer_email, customer_phone, deposit_paid,
--             created_at
--   leads:    status, notes, updated_at
--   messages: user_id, lead_id, content, direction, created_at
--
-- p_lead_id is nullable: the Instagram/SMS flow sometimes cannot resolve a
-- lead (e.g. checkout from a cold link). When null, we still insert the
-- booking but skip the lead + confirmation-message steps. Caller logs.

CREATE OR REPLACE FUNCTION confirm_booking_and_lead(
  p_lead_id uuid,
  p_user_id uuid,
  p_vehicle_id uuid,
  p_start_date date,
  p_end_date date,
  p_total_amount numeric,
  p_deposit_amount numeric,
  p_currency text,
  p_stripe_session_id text,
  p_stripe_payment_intent text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_confirmation_message text,
  p_lead_notes text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking_id uuid;
BEGIN
  -- 1. Create the booking (overlap constraint will throw 23P01 if conflict).
  INSERT INTO bookings (
    user_id, vehicle_id, lead_id, start_date, end_date,
    total_amount, deposit_amount, currency,
    deposit_paid, status,
    stripe_session_id, stripe_payment_intent,
    customer_name, customer_email, customer_phone,
    created_at
  ) VALUES (
    p_user_id, p_vehicle_id, p_lead_id, p_start_date, p_end_date,
    p_total_amount, p_deposit_amount, COALESCE(p_currency, 'USD'),
    true, 'confirmed',
    p_stripe_session_id, p_stripe_payment_intent,
    p_customer_name, p_customer_email, p_customer_phone,
    now()
  )
  RETURNING id INTO v_booking_id;

  -- 2. Mark the lead as booked (only if caller supplied one).
  IF p_lead_id IS NOT NULL THEN
    UPDATE leads
    SET status = 'booked',
        notes = COALESCE(p_lead_notes, notes),
        updated_at = now()
    WHERE id = p_lead_id AND user_id = p_user_id;

    -- 3. Persist the outbound confirmation message (only when we have a
    -- lead to hang it off of — messages.lead_id is NOT NULL in practice).
    IF p_confirmation_message IS NOT NULL AND length(p_confirmation_message) > 0 THEN
      INSERT INTO messages (
        user_id, lead_id, direction, content, created_at
      ) VALUES (
        p_user_id, p_lead_id, 'outbound', p_confirmation_message, now()
      );
    END IF;
  END IF;

  RETURN v_booking_id;
EXCEPTION
  WHEN SQLSTATE '23P01' THEN
    RAISE EXCEPTION 'booking_conflict: vehicle already booked for those dates';
END;
$$;

COMMENT ON FUNCTION confirm_booking_and_lead IS
  'LB-5b: atomic post-payment confirmation — bookings INSERT + leads UPDATE + messages INSERT in one txn. Raises booking_conflict on 23P01 so the webhook handler can return 409.';
