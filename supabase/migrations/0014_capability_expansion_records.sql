-- Additive, ordered after 0013. Not applied automatically.
--
-- CAPABILITY EXPANSION: more operator-record kinds, all tenant-scoped JSON records.
--   learning_source     owner-approved sources Learn Business ingests (id, type, approval, freshness, status, provenance)
--   learning_change     re-learning diffs (consequential changes wait for owner review; never silent)
--   cost_evidence       normalized, provider-independent cost evidence for the profit / margin operator
--   customer_memory     CRM-lite commerce memory per customer (observed history apart from inferred preference)
--   runtime_assignment  which runtime / constitution / reasoner / composer / capability profile / genome revision a business runs
--   hq_proposal         Ask HQ V2 structured change proposals (versioned; activation gated)
--   execution_attempt   proactive operator attempts (bounded retries, idempotent per obligation)
--   channel_identity    verified cross-channel identity links (never name similarity)
-- Never customer message content, never credentials.

alter table public.operator_records drop constraint if exists operator_records_kind_check;
alter table public.operator_records
  add constraint operator_records_kind_check
  check (kind in (
    'controls', 'audit', 'incident', 'obligation', 'release', 'qa_scenario', 'founder_state',
    'learning_source', 'learning_change', 'cost_evidence', 'customer_memory', 'runtime_assignment',
    'hq_proposal', 'execution_attempt', 'channel_identity'
  ));
