create table if not exists public.commerce_carts (
  id text primary key,
  business_id text not null,
  conversation_id text not null,
  customer_id text not null,
  cart_id text not null,
  status text not null check (status in ('open', 'checkout', 'ordered')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists commerce_carts_business_cart_uidx
  on public.commerce_carts (business_id, cart_id);

create index if not exists commerce_carts_conversation_idx
  on public.commerce_carts (business_id, conversation_id)
  where status <> 'ordered';

create table if not exists public.commerce_orders (
  id text primary key,
  business_id text not null,
  conversation_id text not null,
  customer_id text not null,
  order_id text not null,
  cart_id text not null,
  total_amount numeric not null,
  currency text not null,
  status text not null check (status in ('created', 'paid', 'fulfilled', 'cancelled')),
  idempotency_key text not null,
  verified_at timestamptz not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists commerce_orders_idempotency_uidx
  on public.commerce_orders (business_id, idempotency_key);

create unique index if not exists commerce_orders_provider_order_uidx
  on public.commerce_orders (business_id, order_id);

create index if not exists commerce_orders_conversation_idx
  on public.commerce_orders (business_id, conversation_id);

-- Server-only tables: RLS on with no policies, and no privileges for the
-- public API roles. Only the service role (server) reads or writes them.
alter table public.commerce_carts enable row level security;
alter table public.commerce_orders enable row level security;
revoke all on table public.commerce_carts from anon, authenticated;
revoke all on table public.commerce_orders from anon, authenticated;
