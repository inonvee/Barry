-- Additive, ordered after 0011. Not applied automatically.
--
-- OPERATOR RECORDS: one durable, tenant-scoped, keyed JSON record per
-- (business, kind, key). Used by the founder control plane (business
-- controls, founder audit, incident acknowledgements), the proactive
-- operator (operational obligations), the release lane (Work verdicts)
-- and the QA scenario factory (what a scenario created). Never customer
-- data, never credentials.

create table if not exists public.operator_records (
  id text primary key,
  business_id text not null,
  kind text not null check (kind in ('controls', 'audit', 'incident', 'obligation', 'release', 'qa_scenario')),
  key text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists operator_records_business_kind_key_uidx
  on public.operator_records (business_id, kind, key);

create index if not exists operator_records_kind_idx
  on public.operator_records (kind, updated_at desc);

-- Server-only: RLS on with no policies; no privileges for the public API roles.
alter table public.operator_records enable row level security;
revoke all on table public.operator_records from anon, authenticated;
