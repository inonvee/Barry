# BARRY HQ

BARRY HQ (`/hq`) is the founder's control plane across every business BARRY
serves. The MVP is **read-only**.

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
catalog search, variants, live inventory, cart, checkout, orders, PayPlus):

| Status | Meaning |
|---|---|
| live proven | a real provider completed it and the provider verified it in a persisted transaction (today only derivable for PayPlus: a provider-verified paid payment) |
| ready | a real provider is connected and declares the operation; not yet proven |
| simulated | works on BARRY's simulator/fixtures only |
| needs client's provider | BARRY's side exists; the retailer must connect their system (their store API to the custom-commerce contract, PayPlus credentials) |
| not built | BARRY has no adapter for the surface (messaging channels today) |

Commerce is never auto-marked live proven: order records don't store which
provider created them.

## Controls

Pause, disable-capability and safe mode are shown disabled. They will only
ship as explicit, permission-checked, audited and reversible actions. HQ has
no free-form mutation, no raw SQL and never displays secrets.
