-- Phase 2 real payment metadata. Payment providers are adapter-owned, but
-- BARRY persists provider ids/urls/status verification so retries and
-- webhooks remain durable across server restarts.

alter table payment_requests
  add column if not exists provider text,
  add column if not exists provider_payment_id text,
  add column if not exists provider_checkout_url text,
  add column if not exists idempotency_key text,
  add column if not exists verified_at timestamptz,
  add column if not exists provider_event_id text;

create index if not exists payment_requests_provider_payment_idx
  on payment_requests (provider, provider_payment_id)
  where provider_payment_id is not null;

create unique index if not exists payment_requests_idempotency_active_uidx
  on payment_requests (business_id, idempotency_key)
  where status in ('pending', 'paid') and idempotency_key is not null;

create table if not exists payment_webhook_events (
  id bigserial primary key,
  provider text not null,
  provider_event_id text not null,
  payment_request_id text not null references payment_requests (id) on delete cascade,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processing', 'completed', 'failed')),
  attempts integer not null default 1,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  unique (provider, provider_event_id)
);

create index if not exists payment_webhook_events_payment_request_idx
  on payment_webhook_events (payment_request_id);

alter table payment_webhook_events enable row level security;
