-- Additive, ordered after 0016. Not applied automatically. Never apply to Production from the build lane.
--
-- INITIATIVE ENGINE V1: what BARRY noticed in a business's own records, kept as tenant-scoped JSON
-- operator records on the existing server-only table (RLS on, no policies, no anon / authenticated
-- privileges since 0012).
--   initiative       one evidence-backed initiative: category, detector, subject, owner-facing observation,
--                    record references (ids only — no message text), metric, confidence, importance, impact,
--                    recommendation, plan entitlement / authority / can-act, dedupe fingerprint, lifecycle
--                    (verified → surfaced → reviewed → accepted | dismissed | snoozed → acting → measured;
--                    resolved / invalidated), result measured from records
--   initiative_scan  one scan: business-local date, trigger, candidates, verified, rejected (with reasons),
--                    created / updated / surfaced / suppressed / resolved, or skipped (daily scan limit)

alter table public.operator_records drop constraint if exists operator_records_kind_check;
alter table public.operator_records
  add constraint operator_records_kind_check
  check (kind in (
    'controls', 'audit', 'incident', 'obligation', 'release', 'qa_scenario', 'founder_state',
    'learning_source', 'learning_change', 'cost_evidence', 'customer_memory', 'runtime_assignment',
    'hq_proposal', 'execution_attempt', 'channel_identity',
    'commercial_account', 'commercial_event', 'commercial_request', 'cost_record', 'model_usage', 'support_time',
    'owner_identity', 'owner_link_code', 'owner_command', 'owner_operation', 'owner_prompt', 'owner_brief',
    'initiative', 'initiative_scan'
  ));
