# BARRY Architecture (Phase 1)

BARRY is a universal AI business operator. The central engineering bet of
Phase 1 is proving that **one runtime** can operate five structurally
different businesses (a spa, an ecommerce store, a garage, a personal
trainer, a furniture store) using only data, not per-industry code.

## Core principle: capabilities, not industries

Nowhere in this codebase does a conditional branch on business type
(`if business.type === "spa"`). Instead, every business is described by a
**Business Graph** (see `docs/BUSINESS_GRAPH.md`): offers, resources,
policies, knowledge, and available actions. The runtime, the policy
engine, and the tool registry only ever read from that structure.

## Folder structure

```
src/
  lib/
    business-graph/   Zod schemas + read-only query helpers over a BusinessGraph
    fixtures/          The 5 test businesses, built as data (BusinessGraph objects)
    tools/             Tool registry: schemas + simulated execution adapters
    policy/            Policy Engine: decide() -> allowed/limited/approval/denied
    state/             ConversationState types + in-memory persistence
    reasoner/          Reasoner interface + MockReasoner (deterministic, no LLM key needed)
    runtime/           The Observe->Update loop that ties everything together
    store/             BarryBackend: simulated bookings/inventory/payments/approvals
  app/
    simulator/         Mobile-first engineering cockpit (chat + inspector + approvals)
    api/simulator/     Route handlers the simulator UI calls
  components/          Simulator UI pieces (chat, inspector, approvals, graph viewer)
docs/                  This documentation
__tests__/             Vitest: policy, tools, and full scenario tests per business
```

## The BARRY runtime loop

Implemented in `src/lib/runtime/engine.ts`, function `handleCustomerMessage`:

1. **Observe** — append the incoming customer message to `ConversationState`.
2. **Understand** — `Reasoner.plan()` extracts intent/entities from the
   message using only the Business Graph (offers, required info) as context.
3. **Retrieve** — the same `plan()` call surfaces which offers and knowledge
   items were relevant, for explainability.
4. **Plan** — the reasoner decides the next `stage` and, if applicable, the
   next tool call (`action: { name, input }`).
5. **Authorize** — `decide()` in the Policy Engine evaluates the action
   against the Business Graph's policies. This is the **only** gate an
   action passes through; nothing in the runtime calls a tool without it.
6. **Act** — if allowed, `callTool()` validates input/output against Zod
   schemas and executes the simulated adapter. If approval is required,
   `requestApproval` is called instead and the action is parked.
7. **Verify** — the tool's output is validated against its output schema;
   failures are surfaced back to the customer as a graceful failure, not a
   crash.
8. **Update** — state (stage, known fields, outcome) is patched and
   persisted; every turn is recorded as a `TurnLog` for the Inspector.

Two additional entry points close the loop for asynchronous events that a
real deployment would receive as webhooks:

- `handlePaymentOutcome()` — simulates a Stripe-style payment webhook and
  resumes the conversation (e.g. triggers `createBooking` once paid).
- `resumeAfterApproval()` — the owner approves/declines a pending action;
  BARRY executes (or explains why it can't) and continues the conversation
  without requiring the customer to repeat themselves.

## Why a mock reasoner instead of calling OpenAI directly

`src/lib/reasoner/mock-reasoner.ts` is a deterministic, rule-based
implementation of the `Reasoner` interface (`src/lib/reasoner/types.ts`).
It reasons purely over Business Graph data — offer keyword matching,
required-info tracking, date/discount extraction — and needs no API key.
This is what lets the simulator, CI, and the test suite run identically
with or without network access to an LLM provider, and it forces the state
machine to be explicit rather than "whatever the last prompt produced."

A real `OpenAIReasoner` can implement the same interface later
(`plan()` + `composeResponse()`) and be swapped in via
`getReasoner()` (`src/lib/reasoner/index.ts`) without touching the runtime,
policy engine, or tools.

## Why the LLM never touches the database directly

The reasoner's `plan()` output is a typed `PlanResult` (Zod-validatable
shape, even though the mock reasoner produces it directly). The runtime is
the only code that turns that plan into a policy check and a tool call.
An LLM-backed reasoner would produce the same shape — it cannot invoke a
tool, mutate state, or bypass the policy engine on its own.

## Persistence strategy for Phase 1

`ConversationStore` (`src/lib/state/memory-store.ts`) and `BarryBackend`
(`src/lib/store/memory-backend.ts`) are in-memory, process-scoped
implementations. Both are defined as interfaces first so a Supabase-backed
implementation is a drop-in replacement — no caller changes. This is a
deliberate Phase 1 simplification: Vercel serverless functions do not
guarantee a warm process between requests, so state may reset between
cold starts. See `docs/DEPLOYMENT.md`.

## Explainability

Every turn is logged as a `TurnLog` (`src/lib/state/types.ts`) capturing
understood intent/entities, retrieved offers/knowledge, the goal, the
selected action, the policy decision, the tool result, and the final
response. The simulator's "Inspector" tab renders this directly — this is
the debugging cockpit called for in the brief.
