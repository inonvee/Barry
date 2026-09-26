-- BARRY Phase 1.5 persistence: conversations, messages, turn logs, and the
-- simulated backend's bookings/payments/approvals/follow-ups/inventory.
--
-- These mirror the shapes already defined in TypeScript
-- (src/lib/state/types.ts, src/lib/store/types.ts) so the Supabase-backed
-- implementations of ConversationStore / BarryBackend are a drop-in swap
-- for the in-memory ones — no caller changes.
--
-- RLS is enabled on every table with NO policies: only the server-side
-- service-role key (never shipped to the browser) can read/write. There is
-- no anonymous or authenticated client access to this data.

create table if not exists conversations (
  id text primary key,
  business_id text not null,
  customer_id text not null,
  stage text not null default 'discovery',
  detected_intent text,
  selected_offer_id text,
  known_fields jsonb not null default '{}'::jsonb,
  missing_fields text[] not null default '{}',
  objections text[] not null default '{}',
  pending_action jsonb,
  pending_approval_id text,
  outcome text default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_business_id_idx on conversations (business_id);

create table if not exists messages (
  id bigserial primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  role text not null check (role in ('customer', 'barry', 'system')),
  content text not null,
  at timestamptz not null default now()
);
create index if not exists messages_conversation_id_idx on messages (conversation_id, at);

create table if not exists turn_logs (
  id text primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  at timestamptz not null default now(),
  customer_message text,
  understood jsonb,
  retrieved jsonb,
  goal text,
  selected_action jsonb,
  policy_decision jsonb,
  tool_result jsonb,
  response text,
  state_after jsonb,
  reasoner text not null default 'mock'
);
create index if not exists turn_logs_conversation_id_idx on turn_logs (conversation_id, at);

create table if not exists bookings (
  id text primary key,
  business_id text not null,
  offer_id text not null,
  resource_id text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  customer_id text not null,
  conversation_id text not null,
  party_size integer not null default 1,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists bookings_business_id_idx on bookings (business_id);
create index if not exists bookings_resource_slot_idx on bookings (resource_id, start_at);

create table if not exists payment_requests (
  id text primary key,
  business_id text not null,
  conversation_id text not null,
  customer_id text not null,
  amount numeric not null,
  currency text not null default 'USD',
  reason text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists payment_requests_business_id_idx on payment_requests (business_id);

create table if not exists approvals (
  id text primary key,
  business_id text not null,
  conversation_id text not null,
  customer_id text not null,
  requested_action text not null,
  requested_input jsonb,
  reason text,
  policy_id text,
  proposed_value jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  resolution jsonb,
  created_at timestamptz not null default now()
);
create index if not exists approvals_business_id_idx on approvals (business_id);

create table if not exists follow_ups (
  id text primary key,
  business_id text not null,
  conversation_id text not null,
  customer_id text not null,
  reason text,
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists follow_ups_business_id_idx on follow_ups (business_id);

create table if not exists inventory_adjustments (
  business_id text not null,
  sku text not null,
  consumed_quantity integer not null default 0,
  primary key (business_id, sku)
);

alter table conversations enable row level security;
alter table messages enable row level security;
alter table turn_logs enable row level security;
alter table bookings enable row level security;
alter table payment_requests enable row level security;
alter table approvals enable row level security;
alter table follow_ups enable row level security;
alter table inventory_adjustments enable row level security;
