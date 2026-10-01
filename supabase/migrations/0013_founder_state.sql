-- Additive, ordered after 0012. Not applied automatically.
--
-- FOUNDER STATE: one more operator-record kind for HQ operability — the founder's durable
-- "last visit" snapshot (so "since you were here" is derived, never guessed), pinned
-- businesses and recent surfaces. Fleet-scoped records use business_id = 'fleet'.
-- Never customer data, never credentials.

alter table public.operator_records drop constraint if exists operator_records_kind_check;
alter table public.operator_records
  add constraint operator_records_kind_check
  check (kind in ('controls', 'audit', 'incident', 'obligation', 'release', 'qa_scenario', 'founder_state'));
