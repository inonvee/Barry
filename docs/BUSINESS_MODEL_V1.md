# BARRY Business Model V1 (design partner)

> Prices and guardrails here are **internal launch targets**, not legal contract text. The code's single
> source of truth is `src/lib/commercial/plans.ts` (catalog version `2026-10-v1`).

## Plans (three standard plans; custom is priced per deal)

| Plan | Promise | Monthly | Setup from | Includes |
|---|---|---|---|---|
| **BARRY Core** | "BARRY talks." | $399 | $750 | Business knowledge, customer questions, Inbox / handoffs, basic selling and recommendations, basic approvals, Train BARRY, owner visibility |
| **BARRY Operator** | "BARRY works." | $899 | $1,500 | Core + carts / orders / discounts, bookings, payment links, consequential approvals, proactive follow-ups, recovery, multiple connected systems, operational execution |
| **BARRY Intelligence** | "BARRY improves." | $1,799 | $3,000 | Operator + BARRY Margins: cost intelligence, margin leakage, supplier / fee / shipping / SaaS / inventory opportunities **where cost evidence exists**, BARRY MADE + BARRY SAVED |
| Custom / enterprise | scoped | agreed | agreed | Intelligence features by default; scope agreed per deal. Not a fourth standard plan. |

## Commercial rules

- **Fixed monthly pricing.** No revenue share, no % of generated revenue, no % of savings, no overage billing.
- **Setup / integration fee is paid** (or explicitly waived by the founder). It should cover onboarding /
  integration **and** the expected direct operating cost of the free month.
- **First 30 days of subscription free** — the free month starts **only when the founder activates the
  business**, never at contract signature. Delayed integrations do not burn it (the account stays
  `pre_activation`); a pause inside the free month stops its clock (the end moves by the paused time).
- **Founding customers** may get a 12-month price lock (`foundingCustomer`, `priceLockUntil`,
  `lockedMonthlyPrice`). The catalog can evolve, but a founding customer's purchased features are never
  removed without an explicit founder review (the change is refused until confirmed, and audited).
- Plan changes are founder-controlled, versioned (`planVersion` + feature snapshot) and audited. An owner
  "upgrade" is a **request** to the BARRY team only.
- **No automatic charging.** V1 billing is manual behind a vendor-neutral boundary
  (`createSetupInvoice`, `markSetupPaid`, `createSubscription`, `startFreePeriod`, `activateRecurring`,
  `pauseSubscription`, `cancelSubscription`). No vendor is chosen. BARRY subscription billing is entirely
  separate from the tenant business's own customer payments / orders.
- Cancellation is recorded; BARRY never shuts a customer down automatically (the founder uses Controls).

## Plan entitlement vs authority

Two independent questions, both must pass:

| Plan ("did they buy it?") | Authority ("may BARRY do it now?") | Result |
|---|---|---|
| not included | allows | **UNAVAILABLE** — never an owner request |
| included | denies | **DENIED** — the plan never loosens authority |
| included | allows / requires approval | **EXECUTABLE** (authority still decides approval) |

The plan can only remove availability. It never weakens business rules, founder controls, approvals,
grounding, provider verification, idempotency or tenant isolation. Reads stay on every plan; an action the
catalog doesn't know needs the broadest execution feature (fail closed). A business with no commercial
account (internal / demo) has no plan restriction — and can't start a free month without a plan. QA mode
may emulate a plan explicitly (audited, never in production).

## Commercial lifecycle

`no plan → plan selected → setup quoted / invoiced → setup paid or waived → onboarding (readiness) →
free month (30 days) → free month ending → confirm recurring start → paid active → paused / cancelled`

**Activation condition (deterministic):** plan selected and `pre_activation`; setup **paid or waived** (never
overridable); the design-partner commercial readiness gate **READY TO START FREE MONTH** — or a founder
override with a reason (recorded as `OVERRIDE:` in the audit). The gate is recomputed on the server.

**Readiness gate items:** plan selected · setup terms recorded · setup paid / waived · commercial state
known · technical readiness · owner readiness · critical live proof · founder supervision · launch gate ·
free month not already consumed. Output: `READY_TO_START_FREE_MONTH`, `NOT_READY` (exact first blocker) or
`FREE_MONTH_ALREADY_STARTED`.

## Unit economics (founder only)

- **Recurring revenue** = contracted monthly price × share of the period the subscription was paid-active
  (free, paused, cancelled and pre-activation days earn 0). Contracted, not "collected" (manual billing).
- **Setup revenue** is reported **separately** and never mixed into recurring economics.
- **Direct recurring cost-to-serve** = AI reasoner / composer, other model usage, database / storage,
  hosting / compute allocation, messaging / channel fees, external provider fees BARRY pays, support /
  founder time, integration maintenance (where entered).
- **Gross contribution** = recurring revenue − cost-to-serve; **gross margin %** = contribution / recurring
  revenue. Same currency only — never converted silently.
- **Internal recurring gross-margin target: ≥ 70%.**
- **Initial direct-cost guardrails** (until measured data replaces them): Core ~$120/mo, Operator ~$270/mo,
  Intelligence ~$540/mo. A breach creates a founder alert — never an automatic customer shutdown.

## Assumption vs measured data

| Figure | Label | Source |
|---|---|---|
| Model tokens | MEASURED usage | provider-reported per call, metered per turn |
| Model cost | ESTIMATED | tokens × versioned internal rate card (`rates-2026-10-v1`); a model without a rate = UNAVAILABLE |
| Infra / messaging / provider fees | MEASURED or ESTIMATED (with confidence) or UNAVAILABLE | founder-entered cost records; a measured record replaces the estimate for its category |
| Support / founder time | ESTIMATED | minutes × internal hourly assumption (`BARRY_SUPPORT_HOURLY_COST_USD`, default 60) |
| Missing category | UNAVAILABLE | the total is a lower bound — never zero-filled, never a fake bill |

## Value metrics (strict evidence contracts)

- **BARRY HANDLED** — conversations BARRY carried with no owner request, no handoff, no failed
  understanding; plus verified payments / bookings / orders / cases it completed. Test outcomes excluded.
- **BARRY MADE** — GENERATED (provider-verified payments) and RECOVERED (verified money back after a
  loss), separately. Pending / simulated / unverified never count.
- **BARRY SAVED** — only REALIZED, evidence-backed savings. Potential / proposed / negotiated are shown
  apart and never added. Intelligence only; without cost evidence: "BARRY Margins needs connected cost
  evidence" — nothing is fabricated because the customer pays for Intelligence.
- **BARRY NEEDS YOU** — conversations that needed the owner (an approval or a handoff).

## Internal vs owner-visible fields

| Owner sees (Settings → plan + "This month BARRY") | Founder only (HQ → Commercial) |
|---|---|
| Plan name, promise, monthly price, founding lock date | Cost-to-serve and every cost line with its label |
| Subscription state, free-month day / end, recurring start | AI usage, tokens, rate card, estimated model cost |
| What BARRY can do, what is plan-locked, what an upgrade unlocks | Gross contribution, gross margin, guardrails, alerts |
| HANDLED / MADE / SAVED (realised) / NEEDS YOU, working on, blocked, unlock next | Setup revenue economics, free-month coverage, trial summary, commercial audit |

The owner view is built from an explicit allow-list (`getOwnerPlanView`); a test asserts no economics
field leaks into it.

## Storage

Commercial records are tenant-scoped JSON `operator_records` (server-only; RLS on, no policies, no
privileges for `anon` / `authenticated`): `commercial_account`, `commercial_event`, `commercial_request`,
`cost_record`, `model_usage`, `support_time`. Migration `0015_commercial_records.sql` (additive) extends the
kind check; it is not applied automatically and never to Production from the build lane.
