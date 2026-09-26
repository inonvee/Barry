import type { BusinessGraph } from "@/lib/business-graph";
import { knowledgeSearch } from "@/lib/business-graph";
import { decide, type PolicyDecision } from "@/lib/policy";
import { getReasoner } from "@/lib/reasoner";
import { callTool } from "@/lib/tools";
import type { ToolCallResult, ToolContext } from "@/lib/tools";
import { getConversationStore } from "@/lib/state";
import type { ConversationState, TurnLog } from "@/lib/state";
import { getBackend } from "@/lib/store";
import { compile, SCRATCH_KEYS, type CompileOutcome } from "./compiler";

/**
 * The BARRY runtime: Observe -> Understand -> Retrieve -> Compile ->
 * Authorize -> Act -> Verify -> Update.
 *
 * A Reasoner (mock or LLM) only ever produces BARRY IR (Understand). The
 * deterministic Action Compiler turns that into at most one proposed tool
 * call, already validated against the tool's own schema (Compile). This
 * module is the ONLY place allowed to call the Policy Engine and the tool
 * registry together — no other layer executes an action without going
 * through here, so policy can never be bypassed.
 */

function turnId(): string {
  return `turn_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Apply side effects on ConversationState that follow deterministically from a tool's output. */
function patchStateAfterTool(state: ConversationState, toolName: string, output: unknown): void {
  switch (toolName) {
    case "checkAvailability": {
      const { slots } = output as { slots: { resourceId: string; start: string; end: string }[] };
      if (slots.length > 0) {
        state.knownFields[SCRATCH_KEYS.offeredStart] = slots[0].start;
        state.knownFields[SCRATCH_KEYS.offeredEnd] = slots[0].end;
        state.knownFields[SCRATCH_KEYS.offeredResource] = slots[0].resourceId;
      }
      break;
    }
    case "createPaymentRequest": {
      const { paymentRequestId } = output as { paymentRequestId: string };
      state.knownFields[SCRATCH_KEYS.paymentRequestId] = paymentRequestId;
      state.stage = "payment";
      break;
    }
    case "createBooking": {
      state.outcome = "won";
      state.stage = "closed";
      break;
    }
    case "fulfillOrder": {
      state.outcome = "won";
      state.stage = "closed";
      break;
    }
    case "checkInventory": {
      const { quantityAvailable } = output as { quantityAvailable: number };
      if (quantityAvailable > 0) state.knownFields[SCRATCH_KEYS.inventoryChecked] = "1";
      break;
    }
    case "createLead": {
      state.outcome = "pending";
      state.stage = "closed";
      break;
    }
  }
}

export type TurnOutcome = {
  state: ConversationState;
  turn: TurnLog;
  response: string;
};

export async function handleCustomerMessage(
  graph: BusinessGraph,
  conversationId: string,
  customerId: string,
  message: string
): Promise<TurnOutcome> {
  const store = getConversationStore();
  const state = await store.getOrCreate(conversationId, graph.business.id, customerId);
  const now = new Date().toISOString();
  state.messages.push({ role: "customer", content: message, at: now });

  const reasoner = getReasoner();
  const ctx: ToolContext = { graph, conversationId, customerId };

  const ir = await reasoner.understand({ graph, state, customerMessage: message });
  const outcome = compile(graph, state, ir);

  state.detectedIntent = ir.intent;
  state.stage = outcome.stage;
  state.missingFields = outcome.kind === "needs_info" ? outcome.missingFields : [];

  let policyDecision: PolicyDecision | undefined;
  let toolResult: ToolCallResult | null = null;
  let response: string;

  if (outcome.kind === "action") {
    policyDecision = decide(graph, { action: outcome.action.name, params: outcome.action.input });

    if (policyDecision.status === "denied") {
      response = `I'm not able to do that: ${policyDecision.reason}`;
    } else if (policyDecision.status === "requires_approval") {
      const approvalCall = await callTool(
        "requestApproval",
        {
          requestedAction: outcome.action.name,
          requestedInput: outcome.action.input,
          reason: policyDecision.reason,
          policyId: policyDecision.policyId ?? "unknown",
          proposedValue: outcome.action.input,
        },
        ctx
      );
      if (approvalCall.ok) {
        const { approvalId } = approvalCall.output as { approvalId: string };
        state.pendingApprovalId = approvalId;
        state.pendingAction = outcome.action;
        state.stage = "escalated";
      }
      response = await reasoner.composeResponse(
        { graph, state, customerMessage: message },
        { outcome, toolResult: null, policyReason: policyDecision.reason }
      );
    } else {
      const input = policyDecision.adjustedParams ?? outcome.action.input;
      toolResult = await callTool(outcome.action.name, input, ctx);
      if (toolResult.ok) patchStateAfterTool(state, outcome.action.name, toolResult.output);
      response = await reasoner.composeResponse({ graph, state, customerMessage: message }, { outcome, toolResult });
    }
  } else {
    response = await reasoner.composeResponse({ graph, state, customerMessage: message }, { outcome });
  }

  state.messages.push({ role: "barry", content: response, at: new Date().toISOString() });

  const knowledgeIds = knowledgeSearch(graph, message).map((k) => k.id);
  const offerIds = ir.selectedOfferId ? [ir.selectedOfferId] : ir.offerCandidateIds ?? [];

  const turn: TurnLog = {
    id: turnId(),
    at: new Date().toISOString(),
    customerMessage: message,
    understood: { intent: ir.intent, entities: ir.entities },
    retrieved: { offerIds, knowledgeIds },
    goal: outcome.kind === "action" ? outcome.goal : ir.goal,
    selectedAction: outcome.kind === "action" ? outcome.action : null,
    policyDecision,
    toolResult: toolResult
      ? { ok: toolResult.ok, output: toolResult.ok ? toolResult.output : undefined, error: toolResult.ok ? undefined : toolResult.error }
      : undefined,
    response,
    stateAfter: { stage: state.stage, selectedOfferId: state.selectedOfferId, outcome: state.outcome },
    reasoner: reasoner.name,
  };
  state.turns.push(turn);

  await store.save(state);
  return { state, turn, response };
}

/**
 * Simulate a payment outcome (Phase 1 has no real Stripe integration) and
 * resume the conversation exactly as a webhook would in production.
 */
export async function handlePaymentOutcome(
  graph: BusinessGraph,
  conversationId: string,
  paymentRequestId: string,
  outcome: "paid" | "failed"
): Promise<TurnOutcome> {
  const backend = getBackend();
  await backend.simulatePaymentOutcome(paymentRequestId, outcome);

  const store = getConversationStore();
  const state = await store.get(conversationId);
  if (!state) throw new Error(`Conversation ${conversationId} not found`);

  if (outcome === "failed") {
    const response = `Your payment didn't go through. Want to try again or use a different method?`;
    state.messages.push({ role: "system", content: `Payment ${paymentRequestId} failed`, at: new Date().toISOString() });
    state.messages.push({ role: "barry", content: response, at: new Date().toISOString() });
    await store.save(state);
    return {
      state,
      turn: {
        id: turnId(),
        at: new Date().toISOString(),
        customerMessage: "(payment failed)",
        understood: { intent: "payment_failed", entities: {} },
        retrieved: { offerIds: [], knowledgeIds: [] },
        response,
        stateAfter: { stage: state.stage },
        reasoner: getReasoner().name,
      },
      response,
    };
  }

  state.knownFields[SCRATCH_KEYS.paid] = "1";
  return handleCustomerMessage(graph, conversationId, state.customerId, "(payment received)");
}

/** Owner resolves a pending approval; BARRY resumes the conversation with the decision. */
export async function resumeAfterApproval(
  graph: BusinessGraph,
  approvalId: string,
  decision: "approved" | "declined",
  decidedBy: string,
  alternateValue?: unknown
): Promise<TurnOutcome> {
  const backend = getBackend();
  const approval = await backend.resolveApproval(approvalId, decision, decidedBy, alternateValue);

  const store = getConversationStore();
  const state = await store.get(approval.conversationId);
  if (!state) throw new Error(`Conversation ${approval.conversationId} not found`);

  const ctx: ToolContext = { graph, conversationId: approval.conversationId, customerId: approval.customerId };
  const reasoner = getReasoner();

  let toolResult: ToolCallResult | null = null;
  let response: string;

  if (decision === "declined") {
    response = `Thanks for waiting — unfortunately the owner wasn't able to approve that. Is there anything else I can help with?`;
  } else {
    const input = (alternateValue ?? approval.requestedInput) as Record<string, unknown>;
    toolResult = await callTool(approval.requestedAction, input, ctx);
    if (toolResult.ok) patchStateAfterTool(state, approval.requestedAction, toolResult.output);

    const syntheticOutcome: CompileOutcome = {
      kind: "action",
      action: { name: approval.requestedAction, input },
      stage: state.stage,
    };
    response = await reasoner.composeResponse(
      { graph, state, customerMessage: "(approval resumed)" },
      { outcome: syntheticOutcome, toolResult }
    );
  }

  state.pendingApprovalId = null;
  state.pendingAction = null;
  state.messages.push({ role: "barry", content: response, at: new Date().toISOString() });

  const turn: TurnLog = {
    id: turnId(),
    at: new Date().toISOString(),
    customerMessage: "(owner approval resolved)",
    understood: { intent: "approval_resumed", entities: { decision } },
    retrieved: { offerIds: [], knowledgeIds: [] },
    selectedAction: { name: approval.requestedAction, input: (alternateValue ?? approval.requestedInput) as Record<string, unknown> },
    toolResult: toolResult
      ? { ok: toolResult.ok, output: toolResult.ok ? toolResult.output : undefined, error: toolResult.ok ? undefined : toolResult.error }
      : undefined,
    response,
    stateAfter: { stage: state.stage, outcome: state.outcome },
    reasoner: reasoner.name,
  };
  state.turns.push(turn);

  await store.save(state);
  return { state, turn, response };
}
