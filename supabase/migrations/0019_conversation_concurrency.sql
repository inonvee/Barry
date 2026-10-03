-- Additive, ordered after 0018. Not applied automatically. Never apply to Production from the build lane.
--
-- CONVERSATION CONCURRENCY GUARD (paid-pilot P0 phase 3). A customer can send several WhatsApp messages
-- in a burst; every message is its own webhook request, possibly on a different server instance. Before
-- this migration each request read the whole conversation, worked for seconds, and wrote the whole row
-- back — the last writer silently erased the others' ledger, handoffs, dedupe and delivery records.
--
--   conversations.version      optimistic concurrency: a save succeeds only at the version it read.
--   barry_save_conversation    ONE transaction: version check + row update + new messages + new turns
--                              (all or nothing — never a row without its messages, or the reverse).
--   conversation_locks         one lease per conversation (holder + expiry); taken atomically, taken over
--                              only when expired, released only by its holder.
--   conversation_inbox         every inbound channel message, once (unique per provider message id), in
--                              arrival order, with the stage it reached (processing → reply ready →
--                              sending → sent). A provider retry can never re-run a turn or re-send a
--                              reply; an interrupted send is never repeated.
-- Server-only, like every BARRY table: RLS on, no policies, no privileges for anon / authenticated.

alter table public.conversations add column if not exists version bigint not null default 0;

create or replace function public.barry_save_conversation(
  p_id text,
  p_expected_version bigint,
  p_row jsonb,
  p_messages jsonb,
  p_turns jsonb
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new bigint;
begin
  update public.conversations set
    stage = p_row->>'stage',
    detected_intent = p_row->>'detected_intent',
    selected_offer_id = p_row->>'selected_offer_id',
    known_fields = coalesce(p_row->'known_fields', '{}'::jsonb),
    missing_fields = coalesce(array(select jsonb_array_elements_text(p_row->'missing_fields')), '{}'),
    objections = coalesce(array(select jsonb_array_elements_text(p_row->'objections')), '{}'),
    pending_action = p_row->'pending_action',
    pending_approval_id = p_row->>'pending_approval_id',
    outcome = p_row->>'outcome',
    updated_at = (p_row->>'updated_at')::timestamptz,
    version = version + 1
  where id = p_id and version = p_expected_version
  returning version into v_new;

  if v_new is null then
    return null; -- someone else saved first (or the conversation is gone): nothing written
  end if;

  insert into public.messages (conversation_id, role, content, at, rich)
  select p_id, m->>'role', m->>'content', (m->>'at')::timestamptz, m->'rich'
  from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) as m;

  insert into public.turn_logs (id, conversation_id, at, customer_message, understood, retrieved, goal, selected_action, policy_decision, tool_result, response, state_after, reasoner, trace, verification, compiled)
  select t->>'id', p_id, (t->>'at')::timestamptz, t->>'customer_message', t->'understood', t->'retrieved', t->>'goal', t->'selected_action', t->'policy_decision', t->'tool_result', t->>'response', t->'state_after', coalesce(t->>'reasoner', 'mock'), t->'trace', t->'verification', t->'compiled'
  from jsonb_array_elements(coalesce(p_turns, '[]'::jsonb)) as t;

  return v_new;
end;
$$;

create table if not exists public.conversation_locks (
  conversation_id text primary key,
  holder text not null,
  expires_at timestamptz not null,
  acquired_at timestamptz not null default now()
);

create or replace function public.barry_try_conversation_lock(p_conversation_id text, p_holder text, p_ttl_ms integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.conversation_locks (conversation_id, holder, expires_at, acquired_at)
  values (p_conversation_id, p_holder, now() + make_interval(secs => p_ttl_ms / 1000.0), now())
  on conflict (conversation_id) do update
    set holder = excluded.holder, expires_at = excluded.expires_at, acquired_at = excluded.acquired_at
    where public.conversation_locks.expires_at < now() or public.conversation_locks.holder = excluded.holder;
  return found;
end;
$$;

create or replace function public.barry_release_conversation_lock(p_conversation_id text, p_holder text)
returns void
language sql
security definer
set search_path = public
as $$
  -- Releasing = expiring the holder's own lease (an expired lease is free to take); never another holder's.
  update public.conversation_locks set expires_at = now() - interval '1 second' where conversation_id = p_conversation_id and holder = p_holder;
$$;

create table if not exists public.conversation_inbox (
  id text primary key,
  seq bigserial not null,
  business_id text not null,
  conversation_id text not null,
  channel text not null,
  provider_message_id text not null,
  customer_id text not null,
  body text not null,
  meta jsonb not null default '{}'::jsonb,
  status text not null check (status in ('received', 'processing', 'failed', 'reply_ready', 'sending', 'sent', 'dry_run', 'send_failed', 'failed_final', 'delivery_unknown', 'skipped')),
  attempts integer not null default 0,
  reply text,
  reply_at text,
  provider_reply_id text,
  error text,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_inbox_pending_idx on public.conversation_inbox (conversation_id, seq);
create index if not exists conversation_inbox_business_idx on public.conversation_inbox (business_id, created_at desc);

alter table public.conversation_locks enable row level security;
alter table public.conversation_inbox enable row level security;
revoke all on table public.conversation_locks from anon, authenticated;
revoke all on table public.conversation_inbox from anon, authenticated;
revoke all on function public.barry_save_conversation(text, bigint, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.barry_try_conversation_lock(text, text, integer) from public, anon, authenticated;
revoke all on function public.barry_release_conversation_lock(text, text) from public, anon, authenticated;
grant execute on function public.barry_save_conversation(text, bigint, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.barry_try_conversation_lock(text, text, integer) to service_role;
grant execute on function public.barry_release_conversation_lock(text, text) to service_role;
