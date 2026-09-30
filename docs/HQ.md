# BARRY HQ

BARRY HQ (`/hq`) is the founder's control plane across every business BARRY
serves: read models across the fleet plus a small set of bounded, audited
founder controls.

## Data plane vs control plane

- **Data plane** — the per-business runtime: customer message -> model IR ->
  grounding -> compiler -> policy -> capability gate -> provider tools ->
  state -> reply, recorded as a turn trace. Tenant-scoped by construction;
  owners reach their own business through owner routes.
- **Control plane** — HQ: reads what the data plane recorded (Genome,
  connections, capability profiles, conversations, traces, approvals,
  payments, orders, bookings) across tenants. It does not execute turns and,
  today, changes nothing.

## Access

- HQ exists only when `BARRY_FOUNDER_TOKEN` is configured, in every
  environment (no "open in dev" mode). Unset, too short (< 32 chars) or equal
  to `BARRY_OWNER_TOKEN` => every HQ page and API returns 404.
- `/hq/login` exchanges the token for a 12-hour session cookie: an HMAC of
  the token and an expiry — never the token itself; `httpOnly`,
  `SameSite=Strict`, `Secure` in deployments. Rotating the token ends every
  session. HQ APIs also accept the token as a bearer header.
- Pages are evaluated per request (never prerendered), so a configuration
  change can't be frozen into a build.

## Pages

| Route | Shows |
|---|---|
| `/hq` | every tenant: operational readiness + blockers, needed capabilities, provider mode (real / simulated / mixed), conversation count, recent turn failures (failed steps, not understood, reply-contract fallbacks), pending approvals, orders, bookings, payments, runtime + model from the latest trace |
| `/hq/[businessId]` | readiness and capability report; design-partner readiness; Genome (identity, goals, playbook, policies, authority, learned facts with classification, provenance, confidence, owner verification); connections; recent conversations and turns; approvals, payments, orders, bookings; disabled controls |
| `/hq/[businessId]/conversations/[id]` | the messages and every turn's persisted trace (models, understanding, customer-fact verdicts, what BARRY saw, operator steps, stop reason, reply contract) |

## Data sources and tenant isolation

`src/lib/hq/service.ts` is the read model. Every query takes one business id
and uses the store's tenant-scoped methods (`listSummariesByBusiness`,
`listRecentTurnActivity`, `listApprovals(businessId)`, ...). A conversation
is shown only if its stored `businessId` equals the business in the URL;
anything else is "not found". Business ids come from the Genome registry
(today the code fixtures — there is no tenant table yet).

Readiness and the capability report are `getLearningWorkspace()` — the same
function the Learn Business page uses — so HQ can't disagree with the owner
view. A source that fails is shown as *unavailable* (never 0); metrics BARRY
does not record are listed as *not tracked*. Payment links, requested
approval inputs and customer fields are not rendered outside the
conversation view; the conversation view receives only transaction flags
from state.

## Design-partner readiness

Per surface a clothing retailer needs (website chat, WhatsApp, Instagram,
catalog search, variants, live inventory, cart, checkout, orders, and the business's own payment system):

| Status | Meaning |
|---|---|
| live proven | a real provider completed it and the provider verified it in a persisted transaction (today only derivable for payments: a paid payment the connected payment system verified) |
| ready | a real provider is connected and declares the operation; not yet proven |
| simulated | works on BARRY's simulator/fixtures only |
| needs client's provider | BARRY's side exists; the retailer must connect their system (their store API, their payment system's credentials) |
| not built | BARRY has no adapter for the surface (messaging channels today) |

Commerce is never auto-marked live proven: order records don't store which
provider created them.

## Connected systems

The business page lists each connected system as the capability fabric sees it:

- kind and connector;
- health and activation;
- setup blockers, by variable name only;
- every capability mapping, with its contract version, lifecycle status (proposed / validated / conformance passed / active / disabled), provenance, conformance record, and whether owner activation is still needed.

## Fleet view (`/hq`)

Exceptions first, from `src/lib/hq/fleet.ts` (one query set per business —
conversations, approvals, payments, bookings, orders, connections, controls,
incident and obligation records — never a query per conversation):

- **Who needs me?** high incidents, held requests, AI unavailable; on a
  SUPERVISED / LIVE business any open incident.
- **What broke?** open incidents (medium and high; every severity when
  supervised).
- **What changed (24h)?** founder control changes and active conversations.
- **Where is money blocked?** money waiting on an owner or at risk.
- **Not ready.** businesses below a supervised pilot.
- One status row per business: health, stage · mode, model, storage,
  WhatsApp, payments, readiness, interventions · held, incidents, what BARRY
  is watching, money with the owner, last activity.
- **Release cockpit**: the candidate SHA, environment, Preview, gates, the
  acceptance manifest's live checks, do-not-retest and known-unverified
  lists, and the form to record Work's verdict.

## Incidents (`src/lib/hq/incidents.ts`)

One read model of what is broken or stuck, derived from records only:
AI unavailable / degraded, repeated not-understood messages, held requests
older than 2h, failed writes, effects the system did not confirm,
undelivered replies, unhealthy connections, blocked writes, stale unpaid
links. Severity is a deterministic rule per kind (age-aware only for held
requests). Repeated symptoms collapse into one incident per subject with
first / last seen and an occurrence count. The founder acknowledges or
resolves an incident (durable, with who / when / note); a recurrence after
the resolution reopens it.

## Founder controls (`src/lib/hq/controls.ts`)

Bounded levers per business, each with a required reason, an explicit
confirmation, a durable record and an audit entry (before → after), and
reversible:

| Control | Effect |
|---|---|
| mode: SIMULATOR / SUPERVISED / LIVE | readiness, launch gate and founder visibility; never authority by itself |
| pause consequential writes | every consequential action is DENIED (reads still run) |
| human-only | every consequential action the business's rules would allow needs the owner's approval |
| paused capabilities | capability ids / action names (wildcards `support.*`) are DENIED |
| disabled channels | inbound messages on that channel are not processed and nothing is sent |

Controls run AFTER the business's own rules in the policy engine and can
only tighten a decision (`applyFounderControls`). There is no deploy
button, no free-form configuration, no SQL.

## Design-partner launch checklist and gate (`src/lib/hq/launch.ts`)

Evidence-based items (business understanding, owner access, channel,
commerce / payments provider, payments proven, authority, handoff, readiness,
storage, model, critical capabilities, QA / live proof for this build,
founder supervision) with status ready / blocked / unknown, evidence, the
blocker and the next action, and who is responsible. The gate is
READY FOR SUPERVISED DESIGN PARTNER only when every required item has
evidence; unknown stays UNKNOWN / NEEDS PROOF. Train BARRY remains the
owner's view.

## Obligations (`src/lib/operator/obligations.ts`)

What BARRY still owes: unpaid links, approvals blocking a transaction, held
requests, unresolved handoffs, failed actions with a recovery, undelivered
replies, bookings without their deposit. Derived from records with an
injected clock, reconciled with durable records (one per idempotency key),
closed with evidence (payment verified → completed; declined → cancelled;
newer revision → superseded). Each carries whose move it is: BARRY can act /
needs owner / waiting on customer / blocked by capability / scheduled. The
owner sees the same items on Today ("BARRY is watching"), in each
conversation ("Next expected action"), on Money and in Ask BARRY.

## Ask HQ BARRY (`/hq/ask`)

Read-only founder operator over the fleet read models. Every figure must
appear in the briefing (the answer is otherwise replaced by the fleet
summary); answers link to businesses, incidents, conversations and the
release candidate.

## Release lane (`src/lib/release/`)

`current.ts` holds the acceptance manifest for the candidate build (domains
changed, risk areas, implemented, deterministically proven, locally proven,
live proof required, known unverified, do not retest, known blockers).
The state machine — IMPLEMENTED → DETERMINISTICALLY PROVEN → LOCALLY PROVEN
→ LIVE PROOF REQUIRED → LIVE PASSED / BLOCKED — reaches LIVE PASSED only
through a Work verdict the founder records for that exact SHA. `/qa` shows
the manifest; `/api/qa/manifest` serves it.

## QA fast lane (`src/lib/qa/`)

Preview / QA mode only: a scenario factory builds acceptance states through
the real runtime with a scripted understanding, tagging every record with a
`qa:` conversation prefix; a reset removes only those; a test-owner sign-in
issues the ordinary owner session for a test business with its own token
(never revealing it; unavailable on Production; `BARRY_QA_TEST_OWNER_SIGNIN=0`
disables it).

## Storage

Founder controls, audit, incident states, obligations, release verdicts and
scenario runs live in `operator_records` (migration 0012): one JSON record
per (business, kind, key), server-only. Founder cross-business reads use
`listOperatorRecordsAcrossBusinesses`; owner routes never do.
