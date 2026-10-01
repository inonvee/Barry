# Founder BARRY — Control Plane V1

One founder command service over the HQ fleet. **Understand freely, ground deterministically, act only with explicit authority.**

## Path of every command

`POST /api/hq/founder/command` (founder session or founder bearer token only) → `executeFounderCommand` (`src/lib/founder/command-service.ts`):

1. **Identity**: HQ auth. The actor is always `founder`. Owner credentials can't reach this route.
2. **Interpretation** (`src/lib/founder/command.ts`): rules map the text into a closed intent set. A model (`model-interpreter.ts`, only when `BARRY_REASONER=openai`) can help only when the rules don't understand the text. Its JSON is schema-checked, it can't name an action outside the set, and nothing it returns grants authority.
3. **Grounding**: business names resolve only against the fleet directory. A word that fits two businesses is **ambiguous** and never guessed. Every fact comes from the existing read models: fleet status, incidents, controls, obligations, commercial and cost records, value accounts, persisted initiatives, proposals and the release manifest.
4. **Authority**:
   - **Reads** answer.
   - **Founder actions** are limited to the existing controls: pause / resume a business and safe mode on / off. Each returns a confirmation. `POST { confirmKey }` runs it **once** through `applyControlChange` (audited: actor, time, reason), then re-reads the durable controls to verify.
   - **Everything bigger** becomes a proposal. Forbidden requests are refused: SQL, env, secrets, deploys, deciding for an owner, owner/customer policies.
5. **Trace**: one `founder_command` operator record per key (fleet scope). It holds intent, scope, resolution, grounded refs, authority, status, action and verification, proposal ids, stop reason and the step trace. Text is redacted (credential-like strings, phone numbers). There is no chain-of-thought.

The same key returns the recorded result. A second confirmation executes nothing.

## Intents

| Family | Examples | Source |
|---|---|---|
| fleet_read | What do I need to know today? · Which businesses need attention? · What changed since yesterday? | fleet status, proposals, release |
| business_inspect | What's going on with Rina? → Why? / Show incident / What changed? / What can I do? | `getBusinessStatus(detail)`, commercial, initiatives, runtime assignment |
| commercial_read | Which customers are costing us the most to serve? | cost-to-serve: measured / estimated / unavailable, lower bound when incomplete |
| value_read | Which businesses aren't getting enough value? | value accounts: verified MADE, realized SAVED, completed outcomes; simulated money never counts |
| incident_read | Which businesses have broken integrations? | open incidents (connection / re-verification / delivery), channel health |
| initiative_read | What did BARRY notice across the fleet? | persisted initiatives: titles and categories only, never evidence ids or customer text |
| initiative_scan | Run an initiative scan for Rina Studio · Scan Rina for initiatives · Force an initiative scan for Rina for QA | `runInitiativeScan` (the Initiative Engine, one business, trigger `manual`); normal runs keep the daily limit; only explicit "force" wording uses the engine's founder-only bypass; a model can never request force; reply says ran / found nothing / skipped (limit) / failed |
| release_read | What's the release state? | acceptance manifest, gates, Work verdict |
| founder_action | Pause BARRY for Spa · Resume Spa · Put Rina in safe mode | existing founder controls |
| proposal | Prepare a rollout to Rina and Spa | `proposePlan` (HQ proposals) |
| handle_safe | Handle what you safely can and leave me what needs approval | see below |

## Canonical health

`paused · degraded · blocked · needs attention · onboarding · not enough evidence · healthy`. Every state carries its record-backed reasons. There are no percentages or scores.

## Founder Brief

Items appear only for: degraded or blocked businesses (high), needs-attention (medium), a free month over or ending, open proposals, release blockers, high-importance initiatives, and still-paused businesses (low). **A healthy fleet produces no items.**

## Proposals

These reuse `src/lib/hq/proposals.ts`. Plan proposals (`kind` rollout / runtime / capability / configuration) carry goal, current state, proposed change, expected effect, risks, blockers, required approval, rollback and evidence. They have **no control diff** and are **always activation-gated**: no per-business rollout mechanism exists, so approving one changes nothing. Proposals are idempotent through `dedupeKey`.

Lifecycle mapping:
- draft / ready → `proposed`
- approved → `approved`
- executing / verified → `activated` (control proposals only)
- rolled_back → `rolled_back`

## Handle what you safely can

- **Done without approval:** observational bookkeeping only (records changed runtime assignments).
- **Prepared as proposals:** safe mode for a degraded or blocked business (dedupe per business).
- **Left for the founder:** held owner requests, an unconfirmed recurring start, pending proposals.

It never changes a business's behaviour, an owner rule or a customer policy.

## UI

`/hq/ask` ("Ask BARRY") has one command field with suggestions. By default it shows What needs you, What BARRY handled and What changed. Controls render a Confirm button. Follow-ups carry the business being discussed.

## Storage

Migration `0018_founder_command.sql` adds the `founder_command` kind. It is **not applied**.
