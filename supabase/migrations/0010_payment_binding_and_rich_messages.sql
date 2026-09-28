-- Additive, ordered after 0009.
--
-- 1. Payments bound to what they pay for. A commerce payment records the
--    exact cart snapshot it was priced from; an order is only created when
--    the provider cart still hashes to it.
-- 2. The provider's real transaction id, recorded once verified (PayPlus
--    distinguishes the payment page request uid from the transaction uid).
-- 3. Channel-neutral rich payloads (product cards, payment links) stored
--    alongside BARRY's plain-text messages.

alter table payment_requests
  add column if not exists binding jsonb,
  add column if not exists provider_transaction_id text;

alter table payment_requests
  drop constraint if exists payment_requests_binding_shape_chk;
alter table payment_requests
  add constraint payment_requests_binding_shape_chk
  check (
    binding is null
    or (
      binding ->> 'kind' = 'commerce_cart'
      and coalesce(binding ->> 'cartId', '') <> ''
      and coalesce(binding ->> 'snapshotHash', '') ~ '^[0-9a-f]{64}$'
    )
  );

create index if not exists payment_requests_provider_transaction_idx
  on payment_requests (provider, provider_transaction_id)
  where provider_transaction_id is not null;

alter table messages
  add column if not exists rich jsonb;

-- Defense in depth for the tables from 0001-0006. They already have RLS
-- enabled with no policies (so the public API roles see no rows), but
-- Supabase's default grants still give anon/authenticated table
-- privileges. BARRY reads and writes only through the service role, so
-- the public roles need nothing here.
revoke all on table
  conversations,
  messages,
  turn_logs,
  bookings,
  payment_requests,
  approvals,
  follow_ups,
  inventory_adjustments,
  payment_webhook_events
from anon, authenticated;

revoke all on sequence messages_id_seq from anon, authenticated;

-- reserve_inventory is SECURITY INVOKER (RLS would already stop the public
-- roles), but nothing outside the server should be able to call it at all.
revoke execute on function reserve_inventory(text, text, integer, integer) from public, anon, authenticated;
grant execute on function reserve_inventory(text, text, integer, integer) to service_role;
