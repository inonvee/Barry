# The BARRY Runtime

`src/lib/runtime/engine.ts` connects three things: a Reasoner (Understand),
the Action Compiler (Compile), and the Policy Engine + Tool Registry
(Authorize/Act). See `docs/ARCHITECTURE.md` for the loop overview. This
document covers the moving parts in detail — including the Phase 1.5.1
split between **understanding** and **deciding**, introduced to fix a real
bug (below).

## Why understanding and deciding are separate

Early Phase 1.5 had the Reasoner (LLM or mock) directly propose a
`{ name, input }` tool call. In testing, the LLM once proposed
`checkAvailability` with only `{ offerId }` — missing the required
`earliest` — and it reached `callTool()`, which correctly rejected it, but
only after the fact. The customer saw a broken turn instead of a
clarifying question.

The fix is structural, not a patch: **a Reasoner cannot construct a tool
call anymore, even in principle.** It only produces **BARRY IR**
(`src/lib/reasoner/ir.ts`) — understanding, not a decision. A separate,
deterministic **Action Compiler** (`src/lib/runtime/compiler.ts`) is the
only thing that ever assembles a `ToolCall`, and it validates that call
against the tool's real Zod schema before the outcome can even be
`{ kind: "action" }` — an incomplete or invalid call is structurally
unable to leave the compiler.

## BARRY IR v0.1

```ts
type BarryIR = {
  intent: string;
  selectedOfferId?: string;       // one confident match
  offerCandidateIds?: string[];   // ambiguous — compiler asks, never guesses
  entities: Record<string, unknown>; // debug/Inspector only, compiler never reads this
  constraints: {                  // the ONLY typed signals the compiler trusts
    schedulingWindow?: { earliest: string; latest?: string };
    partySize?: number;
    discountPct?: number;
    slotAccepted?: boolean;
  };
  knownFieldsUpdate: Record<string, string>; // name/email/phone-type answers
  requestedCapability?: string;   // advisory only, see below
  goal?: Goal;
};
```

`requestedCapability` is advisory: the compiler decides what BARRY
actually does next from Business Graph capabilities and accumulated
state, the same way it always has — it's free to ignore this hint. The
one value it currently acts on is `"ask_price"`, to answer a "how much?"
question straight from `offer.price` without needing a tool at all.

## The Action Compiler

```ts
function compile(graph: BusinessGraph, state: ConversationState, ir: BarryIR): CompileOutcome
```

Pure and synchronous. It merges `ir.constraints` / `knownFieldsUpdate`
into `state.knownFields` using the same `__mentioned*` scratch-key
convention Phase 1 already used (no schema change), resolves the offer
(sticky — once chosen for a conversation, it's never silently swapped),
checks `requiredCustomerInfo`, then walks the exact capability-flag
decision tree `MockReasoner` used to own directly: scheduling → payment →
booking; inventory → payment → fulfill; quote → lead.

It returns exactly one `CompileOutcome`:

- `{ kind: "action", action, stage, goal? }` — **only** after
  `getTool(action.name).inputSchema.safeParse(action.input)` succeeds.
  If it doesn't, this branch is never taken.
- `{ kind: "ask_general" | "clarify_offer" | "needs_info" | "ask_datetime" | "ask_slot_confirm" | "waiting_payment" | "price_fact" | "generic_confirm" }`
  — "ask the customer something," with the exact thing to ask carried as
  data (offer names, missing field, etc.), never left for a Reasoner to
  invent.
- `{ kind: "compiler_error", reason }` — the assembled input failed
  validation. This is a compiler bug signal (logged server-side), not a
  customer data problem, and it never reaches `callTool()`.

## Reasoner interface

```ts
interface Reasoner {
  readonly name: "mock" | "llm";
  understand(ctx: ReasonerContext): Promise<BarryIR>;
  composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string>;
}
```

`understand()` turns free text into IR — nothing else. `composeResponse()`
phrases a `CompileOutcome` (plus a tool result, if one ran) into natural
language; it's told exactly what happened and asked not to describe
anything beyond it. Neither method can reach the Policy Engine or the
tool registry.

`MockReasoner` (`src/lib/reasoner/mock-reasoner.ts` + `entities.ts`) is
deterministic, keyword/regex-based, and needs no API key. Its
`composeResponse()` just delegates to `composeDeterministic()`
(`src/lib/reasoner/deterministic-compose.ts`) — canned phrasing per
`CompileOutcome` kind, which is also what `OpenAIReasoner` falls back to
if a phrasing call fails.

## Conversation state machine

`ConversationState.stage` moves through:

```
discovery -> offer_selection (implicit) -> info_gathering -> scheduling
  -> payment -> confirmation -> closed
                    \-> escalated (policy required approval)
```

driven by `CompileOutcome.stage`, set by the compiler on every turn.

## Policy Engine

`src/lib/policy/engine.ts` exports `decide(graph, request)`, returning one
of `allowed | allowed_within_limits | requires_approval | denied`. The
runtime calls this immediately after compiling an `action` outcome, before
any tool executes:

- `denied` → tool is never called; the reason is explained to the customer.
- `requires_approval` → the runtime calls the `requestApproval` tool
  instead, parking the original action on an `ApprovalRecord`
  (`requestedAction` + `requestedInput`), and sets
  `state.pendingApprovalId`.
- `allowed` / `allowed_within_limits` → the tool is called with
  `decision.adjustedParams ?? action.input`.

Note that the compiler's assembled `action.input` intentionally keeps
policy-relevant fields (`discountPct`, `isCustomPrice`) that a tool's own
Zod schema doesn't declare — the compiler validates against the schema to
gate *completeness*, but hands the Policy Engine the original object, not
the schema-stripped one, so `decide()` can still see them.

## Tool registry

`src/lib/tools/registry.ts`'s `callTool(name, rawInput, ctx)`:
1. Looks up the tool by name.
2. Validates `rawInput` against `tool.inputSchema` (Zod) — rejects before
   any side effect if invalid. This is defense in depth: the compiler
   already validated a shape-compatible input before this ever runs.
3. Executes the tool's simulated adapter.
4. Validates the adapter's return value against `tool.outputSchema`.

Every adapter in `src/lib/tools/definitions.ts` is simulated against
`BarryBackend` — no real Stripe, calendar, or POS integration exists yet,
by design. Swapping in a real adapter means changing `definitions.ts`
only.

## Owner approval flow

`resumeAfterApproval(graph, approvalId, decision, decidedBy, alternateValue?)`:
- Resolves the `ApprovalRecord` in the backend.
- On `declined`: composes a decline message; no tool runs.
- On `approved`: calls the originally-requested tool directly (bypassing
  the Policy Engine, since a human just authorized it) with either the
  approver's `alternateValue` or the original `requestedInput`.
- Either way, clears `pendingApprovalId`/`pendingAction` and appends a new
  BARRY message to the conversation.

## LLM reasoner: what it can and can't do

`OpenAIReasoner.understand()` sends a deliberately small context
(business tone, active offers' user-facing fields, known/missing fields,
current stage, last ~8 messages) and asks for JSON matching `LlmIRSchema`
— which has no "action" or "tool input" field at all, so the bug class
above is structurally impossible now, not just filtered after the fact.
The response is validated three ways: JSON parses, matches the Zod
schema, and (semantically) any `selectedOfferId`/`offerCandidateIds`
actually exist on this business — anything that fails is dropped rather
than passed through. Every failure category (`openai_api_error`,
`json_parse_error`, `schema_validation_error`, `semantic_validation_error`)
is logged via `src/lib/reasoner/diagnostics.ts` (secret-free) instead of
being silently swallowed. After one retry, a total failure degrades to an
empty IR rather than a hardcoded string — the compiler still knows where
the conversation is and asks whatever's actually next.

`composeResponse()` is a second, separate call that phrases a
`CompileOutcome` naturally in the business's tone and the customer's
language; on failure it falls back to `composeDeterministic()` (the same
canned phrasing `MockReasoner` uses) rather than losing the reply.

## Asynchronous events

`handlePaymentOutcome(graph, conversationId, paymentRequestId, outcome)`
simulates what a payment webhook would deliver. On `"paid"`, it sets the
`__paid` scratch flag and re-invokes `handleCustomerMessage` with a
synthetic `"(payment received)"` message, letting the compiler decide the
next step (usually `createBooking` or `fulfillOrder`) from state alone —
no new understanding needed. This is what proves the 24/7 principle: no
human step is required between payment and fulfillment.
