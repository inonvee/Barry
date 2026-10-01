-- Additive, ordered after 0015. Not applied automatically. Never apply to Production from the build lane.
--
-- OWNER COMMAND CHANNEL (WhatsApp first, provider-neutral): the owner operates BARRY by message. All of it
-- is tenant-scoped JSON operator records on the existing server-only table (RLS on, no policies, no
-- anon / authenticated privileges since 0012) — nothing here is readable from a browser.
--   owner_identity   a verified owner channel identity (e.g. a WhatsApp number) bound to ONE business:
--                    status active / revoked, how it was verified (signed-in owner + one-time code sent from
--                    that number), a fingerprint of the business's owner access at link time (rotating the
--                    owner token revokes it), last inbound time (for the 24-hour messaging window)
--   owner_link_code  a one-time, 15-minute link code — stored as a SHA-256 hash only, marked used once
--   owner_command    one owner command from any surface (web / WhatsApp / voice): idempotency key, the
--                    structured trace (identity → business → intent → grounding → plan → authority →
--                    execution → verification → reply), the reply sent. Never chain-of-thought.
--   owner_operation  a grounded batch operation started by an owner command: cohort with per-target
--                    eligibility / exclusion reasons and results, rule, plan + authority state, lifecycle
--                    (proposed → running → waiting_on_customers → completed | stopped | blocked | failed)
--   owner_prompt     an exact decision sent to an owner (approval id + revision, single use, expiry) —
--                    what a WhatsApp button resolves to; forged or stale references fail
--   owner_brief      a proactive owner notification / brief with its dedupe key and delivery result
--                    (sent / dry_run / blocked with the reason, e.g. outside the 24-hour window)

alter table public.operator_records drop constraint if exists operator_records_kind_check;
alter table public.operator_records
  add constraint operator_records_kind_check
  check (kind in (
    'controls', 'audit', 'incident', 'obligation', 'release', 'qa_scenario', 'founder_state',
    'learning_source', 'learning_change', 'cost_evidence', 'customer_memory', 'runtime_assignment',
    'hq_proposal', 'execution_attempt', 'channel_identity',
    'commercial_account', 'commercial_event', 'commercial_request', 'cost_record', 'model_usage', 'support_time',
    'owner_identity', 'owner_link_code', 'owner_command', 'owner_operation', 'owner_prompt', 'owner_brief'
  ));
