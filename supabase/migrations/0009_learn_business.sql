-- Learn Business: owner-approved learning runs, learned facts with
-- provenance and owner review state, and generated operating strategies.

create table if not exists public.business_learning_runs (
  id text primary key,
  business_id text not null,
  status text not null check (status in ('fetching', 'extracting', 'needs_owner', 'ready', 'failed')),
  -- [{ url, approvedBy, approvedAt }] — the exact sources the owner approved.
  approved_sources jsonb not null default '[]'::jsonb,
  -- Fetch outcomes, learner used, discarded candidates with reasons. Never raw page content.
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists business_learning_runs_business_idx
  on public.business_learning_runs (business_id, created_at desc);

create table if not exists public.learned_business_facts (
  id text primary key,
  business_id text not null,
  run_id text references public.business_learning_runs (id) on delete set null,
  fact_key text not null,
  fact_value jsonb not null,
  classification text not null check (classification in ('fact', 'inference', 'recommendation', 'policy')),
  -- { kind: 'web', url, title?, quote } | { kind: 'owner' }
  source jsonb not null,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  status text not null default 'candidate' check (status in ('candidate', 'verified', 'corrected', 'rejected')),
  owner_verified boolean not null default false,
  corrected_from text,
  reviewed_by text,
  reviewed_at timestamptz,
  discovered_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now(),
  -- Owner-verified means an owner decision exists.
  constraint learned_business_facts_owner_verified_chk
    check (owner_verified = (status in ('verified', 'corrected')))
);

create unique index if not exists learned_business_facts_business_key_uidx
  on public.learned_business_facts (business_id, fact_key);

create table if not exists public.business_operating_strategies (
  id text primary key,
  business_id text not null,
  strategy jsonb not null,
  readiness jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

create index if not exists business_operating_strategies_business_idx
  on public.business_operating_strategies (business_id, generated_at desc);

-- Server-only tables: RLS on with no policies, and no privileges for the
-- public API roles. Only the service role (server) reads or writes them.
alter table public.business_learning_runs enable row level security;
alter table public.learned_business_facts enable row level security;
alter table public.business_operating_strategies enable row level security;
revoke all on table public.business_learning_runs from anon, authenticated;
revoke all on table public.learned_business_facts from anon, authenticated;
revoke all on table public.business_operating_strategies from anon, authenticated;
