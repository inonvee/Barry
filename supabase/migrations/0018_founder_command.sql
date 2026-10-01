-- Additive, ordered after 0017. Not applied automatically. Never apply to Production from the build lane.
--
-- FOUNDER BARRY CONTROL PLANE V1: one durable trace per founder command, kept as a fleet-scoped JSON
-- operator record (business_id = 'fleet') on the existing server-only table (RLS on, no policies, no
-- anon / authenticated privileges since 0012).
--   founder_command  founder (auth method only), redacted text, interpreted intent (rules / model),
--                    scope (fleet / business ids), business resolution (matched / ambiguous), grounded
--                    record references, authority, status (answered / clarify / needs_confirmation /
--                    executed / no_change / proposed / handled / refused / failed), the pending or executed
--                    founder control (change, before, control audit id, verified), proposal ids, the
--                    verification read-back, stop reason and the step trace. No chain-of-thought, no
--                    secrets (credential-like strings and phone numbers are masked before storage).
-- Plan proposals (rollout / runtime / capability / configuration) reuse the existing 'hq_proposal' kind.

alter table public.operator_records drop constraint if exists operator_records_kind_check;
alter table public.operator_records
  add constraint operator_records_kind_check
  check (kind in (
    'controls', 'audit', 'incident', 'obligation', 'release', 'qa_scenario', 'founder_state',
    'learning_source', 'learning_change', 'cost_evidence', 'customer_memory', 'runtime_assignment',
    'hq_proposal', 'execution_attempt', 'channel_identity',
    'commercial_account', 'commercial_event', 'commercial_request', 'cost_record', 'model_usage', 'support_time',
    'owner_identity', 'owner_link_code', 'owner_command', 'owner_operation', 'owner_prompt', 'owner_brief',
    'initiative', 'initiative_scan',
    'founder_command'
  ));
