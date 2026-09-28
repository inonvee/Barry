-- Additive, ordered after 0010. Not applied automatically.
--
-- Every turn becomes explainable from the database alone (for BARRY HQ):
--   trace        which runtime / constitution / model ran; each step BARRY took
--                (customer-triggered or goal continuation) with its capability,
--                provider, policy decision, result and the NAMES of state keys
--                it changed; and why the turn stopped.
--   verification what grounding rejected from the model's understanding.
--   compiled     what the compiler resolved (applied customer info, schedule).
-- No customer secrets or provider credentials are written here.

alter table turn_logs
  add column if not exists trace jsonb,
  add column if not exists verification jsonb,
  add column if not exists compiled jsonb;

-- Fleet questions ("why did checkout stop?", "which provider failed?") read these.
create index if not exists turn_logs_trace_stop_idx
  on turn_logs ((trace -> 'stop' ->> 'reason'))
  where trace is not null;

-- turn_logs already has RLS enabled (0001) and public-role privileges revoked (0010).
revoke all on table turn_logs from anon, authenticated;
