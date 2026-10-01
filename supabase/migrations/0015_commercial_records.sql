-- Additive, ordered after 0014. Not applied automatically. Never apply to Production from the build lane.
--
-- COMMERCIAL OPERABILITY (design partner V1): BARRY's OWN commercial state and cost-to-serve, kept as
-- tenant-scoped JSON operator records. Server-only: the table already has RLS on with no policies and no
-- privileges for anon / authenticated (0012), so these stay founder/server records.
--   commercial_account  plan, plan version + feature snapshot, prices, setup status, founding price lock,
--                       subscription state, free period / recurring / cancellation dates (one per business)
--   commercial_event    append-only commercial audit (who, when, why, before → after)
--   commercial_request  owner upgrade / contact requests (no plan change happens from the owner side)
--   cost_record         provider-independent cost-to-serve records (measured / estimated / unavailable)
--   model_usage         per-turn model usage (model, role, tokens, versioned estimated cost rate)
--   support_time        founder / support minutes per business (cost is an ESTIMATE)
-- Separate from the business's own customer payments / orders: BARRY subscription billing never reuses
-- payment_requests or commerce records. Never customer message content, never credentials.

alter table public.operator_records drop constraint if exists operator_records_kind_check;
alter table public.operator_records
  add constraint operator_records_kind_check
  check (kind in (
    'controls', 'audit', 'incident', 'obligation', 'release', 'qa_scenario', 'founder_state',
    'learning_source', 'learning_change', 'cost_evidence', 'customer_memory', 'runtime_assignment',
    'hq_proposal', 'execution_attempt', 'channel_identity',
    'commercial_account', 'commercial_event', 'commercial_request', 'cost_record', 'model_usage', 'support_time'
  ));
