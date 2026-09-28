-- Provider-agnostic per-business connection registry. Secrets are not stored
-- here; credentials_ref points at server-side secret lookup such as env-backed
-- credentials in the current Phase 2 implementation.

create table if not exists business_connections (
  id text primary key,
  business_id text not null,
  capability text not null,
  provider text not null,
  status text not null
    check (status in ('connected', 'disconnected', 'error')),
  config jsonb not null default '{}'::jsonb,
  credentials_ref text not null,
  permissions text[] not null default '{}'::text[],
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, capability)
);

create index if not exists business_connections_business_idx
  on business_connections (business_id);

alter table business_connections enable row level security;
