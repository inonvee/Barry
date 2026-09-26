# The BARRY Runtime

`src/lib/runtime/engine.ts` is the only place that connects the Reasoner,
Policy Engine, and Tool Registry. See `docs/ARCHITECTURE.md` for the
Observe→Update loop overview. This document covers the moving parts in
more detail.

## Reasoner interface

```ts
interface Reasoner {
  plan(ctx: ReasonerContext): Promise<PlanResult>;
  composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string>;
}
```

`plan()` never executes a tool. It returns, at most, one proposed
`action: { name, input }`. `composeResponse()` turns a tool's result (or a
policy rejection) into the actual customer-facing message. This
separation is what makes it possible to unit test "what BARRY decided to
do" independently of "how BARRY phrased it."

Phase 1 ships `MockReasoner` (deterministic, keyword/regex-based over
Business Graph data — see `src/lib/reasoner/mock-reasoner.ts` and
`entities.ts`). It intentionally has no knowledge of business "type": it
finds an offer by scoring keyword overlap against `offer.name` +
`offer.description`, and branches purely on `offer.requiresScheduling` /
`requiresInventory` / `requiresPayment` / `price === null`.

## Conversation state machine

`ConversationState.stage` moves through:

```
discovery -> offer_selection (implicit) -> info_gathering -> scheduling
  -> payment -> confirmation -> closed
                    \-> escalated (policy required approval)
```

Internal "scratch" fields are stored in `knownFields` under `__`-prefixed
keys (e.g. `__offeredSlotStart`, `__paymentRequestId`, `__paid`,
`__slotAccepted`). These are runtime bookkeeping, never shown to the
customer, and are what let a stateless-per-message reasoner still behave
like it remembers the conversation.

## Policy Engine

`src/lib/policy/engine.ts` exports `decide(graph, request)`, returning one
of `allowed | allowed_within_limits | requires_approval | denied`. The
runtime calls this immediately before every tool execution and:

- `denied` → tool is never called; the reason is explained to the customer.
- `requires_approval` → the runtime calls the `requestApproval` tool
  instead, parking the original action on an `ApprovalRecord`
  (`requestedAction` + `requestedInput`), and sets
  `state.pendingApprovalId`.
- `allowed` / `allowed_within_limits` → the tool is called with
  `decision.adjustedParams ?? action.input`.

## Tool registry

`src/lib/tools/registry.ts`'s `callTool(name, rawInput, ctx)`:
1. Looks up the tool by name.
2. Validates `rawInput` against `tool.inputSchema` (Zod) — rejects before
   any side effect if invalid.
3. Executes the tool's simulated adapter.
4. Validates the adapter's return value against `tool.outputSchema`.

Every adapter in `src/lib/tools/definitions.ts` is simulated against
`BarryBackend` (`src/lib/store/memory-backend.ts`) — no real Stripe,
calendar, or POS integration exists yet, by design (see the "Do NOT Build
Yet" section of the project brief). Swapping in a real adapter means
changing `definitions.ts` only.

## Owner approval flow

`resumeAfterApproval(graph, approvalId, decision, decidedBy, alternateValue?)`:
- Resolves the `ApprovalRecord` in the backend.
- On `declined`: composes a decline message; no tool runs.
- On `approved`: calls the originally-requested tool directly (bypassing
  the Policy Engine, since a human just authorized it) with either the
  approver's `alternateValue` or the original `requestedInput`.
- Either way, clears `pendingApprovalId`/`pendingAction` and appends a new
  BARRY message to the conversation — the customer sees a natural
  continuation, not a dead end.

## Asynchronous events

`handlePaymentOutcome(graph, conversationId, paymentRequestId, outcome)`
simulates what a payment webhook would deliver. On `"paid"`, it sets the
`__paid` scratch flag and re-invokes `handleCustomerMessage` with a
synthetic `"(payment received)"` message, letting the normal `plan()`
logic decide the next step (usually `createBooking` or `fulfillOrder`).
This is what proves the 24/7 principle: no human step is required between
payment and fulfillment.
