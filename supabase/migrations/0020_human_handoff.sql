-- Additive, ordered after 0019. Not applied automatically. Never apply to Production from the build lane.
--
-- HUMAN HANDOFF (paid-pilot P0 phase 4). When a person owns a conversation, the messages they send through
-- BARRY's channel are THEIR messages — stored as role 'owner' with the author who sent them — never as
-- BARRY's. The conversation's control state (who holds it, since when, by whom) and its audit log live in
-- the conversation's known_fields, written through the version-checked save of 0019.
--
--   messages.role    + 'owner' (a person on the business's side, sending through BARRY's channel)
--   messages.author  who sent an owner message (owner session / owner line identity); null for others
--   barry_save_conversation  now also stores messages.author (same signature, same guarantees)

alter table public.messages drop constraint if exists messages_role_check;
alter table public.messages add constraint messages_role_check check (role in ('customer', 'barry', 'system', 'owner'));
alter table public.messages add column if not exists author text;

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
    return null;
  end if;

  insert into public.messages (conversation_id, role, content, at, rich, author)
  select p_id, m->>'role', m->>'content', (m->>'at')::timestamptz, m->'rich', m->>'author'
  from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) as m;

  insert into public.turn_logs (id, conversation_id, at, customer_message, understood, retrieved, goal, selected_action, policy_decision, tool_result, response, state_after, reasoner, trace, verification, compiled)
  select t->>'id', p_id, (t->>'at')::timestamptz, t->>'customer_message', t->'understood', t->'retrieved', t->>'goal', t->'selected_action', t->'policy_decision', t->'tool_result', t->>'response', t->'state_after', coalesce(t->>'reasoner', 'mock'), t->'trace', t->'verification', t->'compiled'
  from jsonb_array_elements(coalesce(p_turns, '[]'::jsonb)) as t;

  return v_new;
end;
$$;

revoke all on function public.barry_save_conversation(text, bigint, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.barry_save_conversation(text, bigint, jsonb, jsonb, jsonb) to service_role;
