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
    reasoner/          Reasoner interface (understand -> BARRY IR) + MockReasoner + OpenAIReasoner
    runtime/           The Observe->Update loop + the deterministic Action Compiler
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
2. **Understand** — `Reasoner.understand()` turns the message into
   **BARRY IR** (`src/lib/reasoner/ir.ts`): intent, entities, constraints
   (a day/time, party size, discount %...), known-field updates, and at
   most a *candidate* offer. A Reasoner never decides what tool to call —
   see `docs/BARRY_RUNTIME.md` for why that split exists.
3. **Retrieve** — relevant offers/knowledge are surfaced for the Inspector.
4. **Compile** — the deterministic Action Compiler
   (`src/lib/runtime/compiler.ts`) takes that IR plus accumulated
   `ConversationState` plus the Business Graph and decides what happens
   next: either a fully-assembled, schema-validated tool call, or exactly
   what's still missing to ask for.
5. **Authorize** — `decide()` in the Policy Engine evaluates the compiled
   action against the Business Graph's policies. This is the **only** gate
   an action passes through; nothing in the runtime calls a tool without it.
6. **Act** — if allowed, `callTool()` validates input/output against Zod
   schemas (again — defense in depth) and executes the simulated adapter.
   If approval is required, `requestApproval` is called instead and the
   action is parked.
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
with or without network access to an LLM provider.

`OpenAIReasoner` (`src/lib/reasoner/openai-reasoner.ts`) implements the
same interface and can be swapped in via `getReasoner()`
(`src/lib/reasoner/index.ts`, env-driven) without touching the runtime,
compiler, policy engine, or tools.

## Why the LLM never touches the database — or constructs a tool call

A Reasoner's `understand()` output is BARRY IR: intent, entities,
constraints, candidate offers. There is no field for a tool name or tool
input anywhere in that shape — an LLM literally cannot express "call this
tool with this input," even if it tried. The deterministic Action
Compiler (`docs/BARRY_RUNTIME.md`) is the only code that ever turns IR
into a `ToolCall`, and it validates that call against the tool's real Zod
schema before the runtime acts on it. This is a structural guarantee, not
a filter applied after the fact — see `docs/BARRY_RUNTIME.md` for the
real bug this was built to make impossible.

## Persistence strategy for Phase 1

`ConversationStore` (`src/lib/state/memory-store.ts`) and `BarryBackend`
(`src/lib/store/memory-backend.ts`) are in-memory, process-scoped
implementations. Both are defined as interfaces first so a Supabase-backed
implementation is a drop-in replacement — no caller changes. This is a
deliberate Phase 1 simplification: Vercel serverless functions do not
guarantee a warm process between requests, so state may reset between
cold starts. See `docs/DEPLOYMENT.md`.

## Phase 1.5: persistence and the LLM reasoner

Two things changed in Phase 1.5, both behind the interfaces Phase 1 already
had in place — no runtime/policy/tool code changed to support either:

- **Supabase persistence.** `SupabaseConversationStore`
  (`src/lib/state/supabase-store.ts`) and `SupabaseBackend`
  (`src/lib/store/supabase-backend.ts`) implement the same
  `ConversationStore` / `BarryBackend` interfaces the in-memory versions
  do. `getConversationStore()` / `getBackend()` pick Supabase when
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise memory —
  so `npm test` and local dev without those vars are unaffected. See
  `docs/DEPLOYMENT.md` for the schema and env vars.
- **`OpenAIReasoner`** (`src/lib/reasoner/openai-reasoner.ts`) implements
  the same `Reasoner` interface as `MockReasoner`. `getReasoner()` picks it
  when `BARRY_REASONER=openai` and `OPENAI_API_KEY` are both set.

Every `TurnLog` records which reasoner produced it (`"mock" | "llm"`),
surfaced in the simulator's Inspector tab.

## Phase 1.5.1: BARRY IR and the Action Compiler

A real failure surfaced testing `OpenAIReasoner` against the live
deployment: the model proposed `checkAvailability` with an incomplete
input (missing the required `earliest`), and it reached `callTool()`
before being rejected — a broken turn instead of a clarifying question.
See `docs/BARRY_RUNTIME.md` ("Why understanding and deciding are
separate") for the full fix: Reasoners now produce BARRY IR only, and a
new deterministic Action Compiler (`src/lib/runtime/compiler.ts`) is the
sole author of any tool call, validated against the tool's real schema
before it can exist as an `"action"` outcome at all.

## Explainability

Every turn is logged as a `TurnLog` (`src/lib/state/types.ts`) capturing
understood intent/entities, retrieved offers/knowledge, the goal, the
selected action, the policy decision, the tool result, and the final
response. The simulator's "Inspector" tab renders this directly — this is
the debugging cockpit called for in the brief.
