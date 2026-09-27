-- Phase 2 real scheduling metadata. Google Calendar is the first real
-- scheduling provider, but these columns are provider-generic so retries,
-- reconciliation, and audits do not depend on process memory.

alter table bookings
  add column if not exists provider text,
  add column if not exists provider_event_id text,
  add column if not exists idempotency_key text,
  add column if not exists verified_at timestamptz;

create index if not exists bookings_provider_event_idx
  on bookings (provider, provider_event_id)
  where provider_event_id is not null;

create unique index if not exists bookings_idempotency_key_confirmed_uidx
  on bookings (idempotency_key)
  where status = 'confirmed' and idempotency_key is not null;
