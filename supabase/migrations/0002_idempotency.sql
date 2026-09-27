-- Concurrency/idempotency hardening. The application already does
-- check-then-insert for these cases (tools/definitions.ts, supabase-
-- backend.ts), which has a race window under concurrent requests (two
-- simultaneous bookings for the same slot, a retried HTTP request creating
-- a second pending payment request, concurrent fulfillOrder calls racing
-- on inventory). These constraints make the race impossible at the
-- database level instead of merely unlikely.

-- Two confirmed bookings can never occupy the same resource at the same
-- start time. If a second createBooking races past the app-level check,
-- this insert fails with a unique violation instead of silently
-- double-booking.
create unique index if not exists bookings_resource_slot_confirmed_uidx
  on bookings (resource_id, start_at)
  where status = 'confirmed';

-- A conversation should never have more than one payment request awaiting
-- an outcome at a time — this is a real business rule, not just a race
-- guard. Prevents a retried request (e.g. a double-tap, a network retry)
-- from creating two pending payment requests for the same conversation.
create unique index if not exists payment_requests_one_pending_per_conversation_uidx
  on payment_requests (conversation_id)
  where status = 'pending';

-- Atomic inventory consumption. The application previously did
-- select-then-upsert from JS, which has a race window under concurrent
-- fulfillOrder calls for the same SKU. This function does the
-- read-modify-write in a single statement.
create or replace function increment_inventory_consumed(
  p_business_id text,
  p_sku text,
  p_quantity integer
) returns integer
language plpgsql
as $$
declare
  v_new_consumed integer;
begin
  insert into inventory_adjustments (business_id, sku, consumed_quantity)
  values (p_business_id, p_sku, p_quantity)
  on conflict (business_id, sku)
  do update set consumed_quantity = inventory_adjustments.consumed_quantity + excluded.consumed_quantity
  returning consumed_quantity into v_new_consumed;
  return v_new_consumed;
end;
$$;
