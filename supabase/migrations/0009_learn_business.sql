create table if not exists public.business_learning_runs (
  id text primary key,
  business_id text not null,
  status text not null check (status in ('discovering', 'ingesting', 'extracting', 'needs_owner', 'ready', 'failed')),
  approved_sources jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists business_learning_runs_business_idx
  on public.business_learning_runs (business_id, created_at desc);

create table if not exists public.learned_business_facts (
  id text primary key,
  business_id text not null,
  fact_key text not null,
  fact_value jsonb not null,
  classification text not null check (classification in ('fact', 'inference', 'recommendation', 'policy')),
  source jsonb not null,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  owner_verified boolean not null default false,
  discovered_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now()
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
