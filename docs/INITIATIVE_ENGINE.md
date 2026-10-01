# Initiative Engine V1

BARRY notices things before the owner does — **only with evidence**. A scan quota is not a
notification quota: an empty scan is a successful scan.

```
POST /api/owner/initiatives/scan  (owner or founder; cron-ready; ≤ 3 per business-local day)
  observe   buildSnapshot — ONE business's records (owner read model, conversation turns, ledger, orders, cost evidence)
  detect    src/lib/initiative/detectors.ts (pure)
  verify    every count recomputed from record references; money only from real (non-test) records
  dedupe    stable fingerprint (business · category · detector · subject); updated in place, never duplicated
  fatigue   dismissed: quiet 14 days, then only materially new evidence; snoozed until its date;
            ≤ 2 newly surfaced per local day, ≤ 3 on show; recent dismissals lower a category's rank
  rank      internal score (importance, confidence, customers, money, can-act, already-handled, dismissals)
  persist   operator records `initiative`, `initiative_scan` (migration 0017)
```

## V1 detectors (only where the repository has reliable data)

| Detector | Category | Evidence |
|---|---|---|
| repeated_question | customer_experience / sales_friction | runtime-grounded knowledge topics per turn (≥ 5 conversations / 7 days); friction when ≥ 3 and ≥ 40 % reached a cart after asking and didn't buy |
| unanswered_questions | customer_experience | turns the runtime recorded as unanswered questions (≥ 3 conversations / 7 days) |
| abandoned_demand | abandoned_demand | open recovery / unpaid obligations not yet followed up (≥ 2); money only from real systems |
| repeat_approvals | owner_friction | ≥ 3 owner requests of one kind in 14 days, ≥ 75 % approved → suggest a standing rule (never applied) |
| product_interest | sales_friction | cart adds the provider confirmed (≥ 5 conversations / 7 days) vs orders (≤ 25 %) |
| money_at_risk | money_leakage | real at-risk opportunities (same rule as the Money "At risk" figure) |
| cost_signals | cost_margin | verified cost records, last 30 vs previous 30 days (≥ 15 % rise); no saving is ever claimed; "evidence needed" only on a plan that includes cost analysis |

Not built (no reliable records yet): handoff-reason clustering, discount leakage beyond recorded approvals,
supplier / shipping comparisons, external research (`src/lib/initiative/research.ts` — explicit boundary,
no connector).

## Plans

Every plan observes and recommends. The plan decides what BARRY can **do**: "Do this" (e.g. follow up
abandoned checkouts) is offered only when the plan and the owner's rule allow it, and even then it runs
through the owner command service (plan → authority → grounding → executor → verification → idempotency).

## Surfaces

- Today: one "BARRY noticed" card (Review · Ask BARRY · Do this / link · Snooze · Dismiss); nothing when there is nothing.
- Ask BARRY: "What did you notice?", "What would you improve?", "Where am I losing money?" — from persisted initiatives only.
- WhatsApp: `initiativeMessage()` renders the same initiative ("I noticed something worth looking at…"); not wired to sending.
- HQ: `GET /api/hq/initiatives?businessId=` — initiatives, scans (with rejected candidates), quality metrics.

## Scheduler (autonomous scans)

`src/lib/initiative/scheduler.ts` + `GET|POST /api/cron/initiative-scan` decide **which business is due and when**; `runInitiativeScan` still decides everything else (never forced; the daily limit wins; nothing is sent).

- **Slots** (business-local, from the business's own timezone via Intl): morning 08–13, afternoon 13–18, evening 18–22; nothing 22–08. A missed window is not made up.
- **Idempotency:** one `founder_state` record per (business, local date, slot) — `claimed` before the scan, then `ran` / `failed`. A repeated tick skips a `ran` slot; a `claimed` record under 10 min old means a run is in flight; a failed slot retries at most twice.
- **Audit:** each tick writes a fleet-scope `founder_state` record (`initiative_tick:<iso>`): evaluated / due / ran / skipped / failed with a reason per business.
- **Failure isolation:** every business is evaluated in its own try/catch.
- **Skips:** demo businesses, paused businesses ("nothing proactive runs").
- **Auth:** `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or a founder session/token. Founder-only: `?businessId=` and `?at=<ISO>`.
- **Cron:** `vercel.json` runs the route hourly (`0 * * * *`). Vercel runs crons only on the Production deployment; hourly needs a plan that allows it.
