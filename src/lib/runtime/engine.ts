import type { BusinessGraph } from "@/lib/business-graph";
import { isActionAvailable, knowledgeSearch } from "@/lib/business-graph";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { decide, type PolicyDecision } from "@/lib/policy";
import { getReasoner } from "@/lib/reasoner";
import { callTool } from "@/lib/tools";
import type { ToolCallResult, ToolContext } from "@/lib/tools";
import { getConversationStore } from "@/lib/state";
import type { ConversationState, TurnLog } from "@/lib/state";
import { getBackend } from "@/lib/store";
import { formatLocalDateTime } from "@/lib/scheduling/resolver";
import type { CustomerFacingLocalDisplay, GroundedContext, ReasonerContext, SchedulingDisplayFacts } from "@/lib/reasoner/types";
import { resolveCapabilityProfiles, ACTION_REQUIREMENTS, type CapabilityProfiles } from "@/lib/capabilities";
import type { TurnStep, TurnTrace } from "@/lib/state";
import { CONSTITUTION_VERSION } from "@/lib/reasoner/constitution";
import { BARRY_RUNTIME_VERSION, runtimeCommit } from "./version";
import { getCatalogSchema, getCommerceProduct, getOwnedCart } from "@/lib/commerce/capability";
import { sanitizeComposeInput } from "@/lib/reasoner/compose-sanitization";
import { verifyIR } from "@/lib/reasoner/verify";
import {
  markPaymentWebhookCompleted,
  markPaymentWebhookFailed,
  processPaymentWebhook,
  type PaymentWebhookResult,
} from "@/lib/payments/capability";
import type { PaymentWebhookHeaders } from "@/lib/payments/adapters/types";
import { cancelPaymentRequest } from "@/lib/payments/capability";
import type { NormalizedOutboundMessage } from "@/lib/channels/types";
import type { Product } from "@/lib/commerce/types";
import type { BarryIR } from "@/lib/reasoner/ir";
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

/**
 * Apply side effects on ConversationState that follow deterministically
 * from a SUCCESSFUL tool's output. Only verified tool/provider results
 * ever reach here — this is the one place transaction state advances.
 * `prevStage` is restored when a tool ran but did not do what was asked
 * (e.g. the requested variant wasn't available): no false transition.
 */
async function patchStateAfterTool(state: ConversationState, toolName: string, output: unknown, prevStage: ConversationState["stage"]): Promise<void> {
  const known = state.knownFields;
  switch (toolName) {
    case "checkAvailability": {
      const { slots } = output as { slots: { resourceId: string; start: string; end: string }[] };
      if (slots.length > 0) {
        known[SCRATCH_KEYS.offeredStart] = slots[0].start;
        known[SCRATCH_KEYS.offeredEnd] = slots[0].end;
        known[SCRATCH_KEYS.offeredResource] = slots[0].resourceId;
      }
      break;
    }
    case "createPaymentRequest": {
      const { paymentRequestId } = output as { paymentRequestId: string };
      known[SCRATCH_KEYS.paymentRequestId] = paymentRequestId;
      state.stage = "payment";
      break;
    }
    case "searchProducts": {
      const { products } = output as { products: { id: string }[] };
      if (products.length > 0) {
        known[SCRATCH_KEYS.commerceLastProductIds] = products.map((product) => product.id).join(",");
        delete known[SCRATCH_KEYS.commercePendingProductId];
        delete known[SCRATCH_KEYS.commercePendingReplaceLineId];
      }
      break;
    }
    case "addToCart":
    case "updateCartLine": {
      const result = output as {
        added: boolean;
        cart?: { id: string; total: { amount: number; currency: string }; lines: unknown[] };
        lineId?: string;
        notAdded?: { productId: string; replacesLineId?: string };
      };
      if (!result.added) {
        if (toolName === "addToCart" && result.notAdded) {
          known[SCRATCH_KEYS.commercePendingProductId] = result.notAdded.productId;
          if (result.notAdded.replacesLineId) known[SCRATCH_KEYS.commercePendingReplaceLineId] = result.notAdded.replacesLineId;
          else delete known[SCRATCH_KEYS.commercePendingReplaceLineId];
        }
        state.stage = prevStage;
        break;
      }
      delete known[SCRATCH_KEYS.commercePendingProductId];
      delete known[SCRATCH_KEYS.commercePendingReplaceLineId];
      if (result.cart) {
        known[SCRATCH_KEYS.commerceCartId] = result.cart.id;
        known[SCRATCH_KEYS.commerceCartTotal] = JSON.stringify(result.cart.total);
      }
      if (result.lineId) known[SCRATCH_KEYS.commerceCartLineId] = result.lineId;
      else delete known[SCRATCH_KEYS.commerceCartLineId];
      // The cart changed: any checkout/payment priced from the old cart no
      // longer applies. Cancel it so it can never become this order.
      if (known[SCRATCH_KEYS.paymentRequestId] && !known[SCRATCH_KEYS.paid]) {
        await cancelPaymentRequest(known[SCRATCH_KEYS.paymentRequestId]);
        delete known[SCRATCH_KEYS.paymentRequestId];
      }
      delete known[SCRATCH_KEYS.commerceCheckoutId];
      delete known[SCRATCH_KEYS.commerceCartSnapshot];
      state.stage = "offer_selection";
      break;
    }
    case "createCommerceCheckout": {
      const { checkoutId, cartId, paymentRequestId, snapshotHash, amount } = output as {
        checkoutId: string;
        cartId: string;
        paymentRequestId: string;
        snapshotHash: string;
        amount: { amount: number; currency: string };
      };
      known[SCRATCH_KEYS.commerceCheckoutId] = checkoutId;
      known[SCRATCH_KEYS.commerceCartId] = cartId;
      known[SCRATCH_KEYS.commerceCartSnapshot] = snapshotHash;
      known[SCRATCH_KEYS.commerceCartTotal] = JSON.stringify(amount);
      known[SCRATCH_KEYS.paymentRequestId] = paymentRequestId;
      state.stage = "payment";
      break;
    }
    case "verifyPayment": {
      const { paymentRequestId, status } = output as { paymentRequestId: string; status: string };
      if (status === "paid" && known[SCRATCH_KEYS.paymentRequestId] === paymentRequestId) known[SCRATCH_KEYS.paid] = "1";
      if ((status === "failed" || status === "cancelled") && known[SCRATCH_KEYS.paymentRequestId] === paymentRequestId) {
        delete known[SCRATCH_KEYS.paymentRequestId];
      }
      state.stage = "payment";
      break;
    }
    case "createCommerceOrder": {
      const { orderId } = output as { orderId: string };
      known[SCRATCH_KEYS.commerceOrderId] = orderId;
      state.outcome = "won";
      state.stage = "closed";
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
      if (quantityAvailable > 0) known[SCRATCH_KEYS.inventoryChecked] = "1";
      break;
    }
    case "createLead": {
      state.outcome = "pending";
      state.stage = "closed";
      break;
    }
  }
}

type RichProduct = NonNullable<NonNullable<NormalizedOutboundMessage["rich"]>["products"]>[number];

function optionLabel(options: Record<string, string>): string {
  return Object.values(options).join(" / ");
}

/**
 * Channel-neutral rich payload built ONLY from verified tool output —
 * product cards and payment links are rendered by the channel, so the
 * text reply never needs to carry markdown, image syntax or raw URLs.
 */
export function buildRichPayload(outcome: CompileOutcome, toolResult: ToolCallResult | null): NormalizedOutboundMessage["rich"] | undefined {
  if (outcome.kind !== "action" || !toolResult?.ok) return undefined;
  const output = toolResult.output as Record<string, unknown>;
  switch (outcome.action.name) {
    case "searchProducts": {
      const { products, requestedOptions } = output as {
        products: Product[];
        requestedOptions?: Record<string, string>;
      };
      if (products.length === 0) return undefined;
      return {
        products: products.slice(0, 5).map((product): RichProduct => {
          const wanted = product.variants.filter((v) =>
            Object.entries(requestedOptions ?? {}).every(([k, val]) => v.options[k]?.toLowerCase() === val.toLowerCase())
          );
          const inStock = wanted.filter((v) => v.inventory.available > 0);
          const priced = (inStock[0] ?? wanted[0] ?? product.variants[0]);
          const availability = requestedOptions && Object.keys(requestedOptions).length > 0
            ? `${optionLabel(requestedOptions)}: ${inStock.length > 0 ? "in stock" : "out of stock"}`
            : `In stock: ${product.variants.filter((v) => v.inventory.available > 0).map((v) => optionLabel(v.options)).join(", ") || "none"}`;
          return {
            title: product.title,
            imageUrl: product.media[0]?.url,
            price: priced ? `${priced.price.amount} ${priced.price.currency}` : undefined,
            url: product.url,
            availability,
          };
        }),
      };
    }
    case "createCommerceCheckout":
    case "createPaymentRequest": {
      const url = (output.checkoutUrl as string | undefined) || undefined;
      return url ? { paymentUrl: url } : undefined;
    }
    default:
      return undefined;
  }
}

export type TurnOutcome = {
  state: ConversationState;
  turn: TurnLog;
  response: string;
  /** Channel-neutral rich content (product cards, payment link) accompanying `response`. */
  rich?: NormalizedOutboundMessage["rich"];
};

const HEBREW_LETTERS = /[\u0590-\u05ff]/;

function prefersTwentyFourHourDisplay(customerMessage: string, businessLocale: string): boolean {
  return HEBREW_LETTERS.test(customerMessage) || /^he(?:-|$)/i.test(businessLocale);
}

function customerFacingDisplay(
  iso: string,
  timeZone: string,
  useTwentyFourHour: boolean
): CustomerFacingLocalDisplay {
  const display = formatLocalDateTime(iso, timeZone);
  return {
    localDate: display.localDate,
    localTime: useTwentyFourHour ? display.localTime24 : display.localTime,
    timeZone: display.timeZone,
  };
}

/**
 * Deterministically computes business-timezone-local display facts for
 * whatever scheduling instant this turn's outcome/toolResult involves —
 * the ONE place a raw UTC ISO string is ever converted for a
 * customer-facing reply. Never let a Reasoner (LLM or deterministic)
 * interpret `offeredStart`/`slots[].start` itself; that silently defaults
 * to the server's runtime timezone, not the business's.
 */
function buildSchedulingDisplay(
  graph: BusinessGraph,
  outcome: CompileOutcome,
  toolResult: ToolCallResult | null,
  customerMessage: string
): SchedulingDisplayFacts | undefined {
  const timeZone = graph.business.timezone;
  const useTwentyFourHour = prefersTwentyFourHourDisplay(customerMessage, graph.business.locale);

  if (outcome.kind === "ask_slot_confirm") {
    return { offeredSlot: customerFacingDisplay(outcome.offeredStart, timeZone, useTwentyFourHour) };
  }

  if (outcome.kind === "action" && outcome.action.name === "checkAvailability" && toolResult?.ok) {
    const { slots } = toolResult.output as { slots: { start: string }[] };
    return { availableSlots: slots.map((s) => customerFacingDisplay(s.start, timeZone, useTwentyFourHour)) };
  }

  return undefined;
}

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

  const profiles = await resolveCapabilityProfiles(graph).catch((err) => {
    console.error("[barry:engine] capability profiles unavailable", err instanceof Error ? err.message : err);
    return undefined;
  });
  const grounded = await buildGroundedContext(graph, state, ctx, profiles);
  const rawIr = await reasoner.understand({ graph, state, customerMessage: message, grounded });
  // The model owns understanding; verifyIR() only GROUNDS it — evidence
  // for persisted facts, consistency with current state, structural
  // ranges. It never adds a semantic value of its own.
  const { verified: ir, verification } = verifyIR(graph, message, rawIr, state, { catalog: grounded?.catalog });
  const prevStage = state.stage;
  let outcome = compile(graph, state, ir, { profiles });

  state.detectedIntent = ir.intent;
  // Non-action outcomes describe where the conversation now is. An
  // action's stage only applies once its tool actually succeeds.
  if (outcome.kind !== "action") state.stage = outcome.stage;
  state.missingFields = outcome.kind === "needs_info" ? outcome.missingFields : [];

  // ── Goal-driven operator loop ─────────────────────────────────────────
  // The customer's message yields at most ONE customer-triggered action.
  // After it succeeds, BARRY re-plans from real state alone (no new
  // customer words) and keeps going while the next step toward the
  // business goal is safe: state-derived, supported by a connected
  // provider, enabled, policy-allowed, not already done this turn, and
  // within a small step budget. It stops the moment a human is needed.
  const steps: ExecutedStep[] = [];
  let next: CompileOutcome | undefined;
  let stop: TurnTrace["stop"] = { reason: "no_action", outcome: outcome.kind };

  if (outcome.kind === "action") {
    let current: Extract<CompileOutcome, { kind: "action" }> = outcome;
    let trigger: TurnStep["trigger"] = "customer";
    for (;;) {
      const step = await runStep(graph, state, current, ctx, trigger === "customer" ? prevStage : state.stage, trigger, profiles);
      steps.push(step);
      if (step.policyDecision.status !== "allowed") {
        stop = { reason: step.policyDecision.status === "denied" ? "policy_denied" : "owner_approval_required", outcome: current.action.name };
        break;
      }
      if (!step.toolResult?.ok) {
        stop = { reason: "tool_failed", outcome: current.action.name };
        break;
      }
      if (steps.length >= MAX_STEPS_PER_TURN) {
        stop = { reason: "step_budget", outcome: current.action.name };
        break;
      }
      const candidate = compile(graph, state, CONTINUE_IR, { profiles });
      if (candidate.kind !== "action") {
        if (NEEDS_CUSTOMER_OUTCOMES.has(candidate.kind)) next = candidate;
        stop = { reason: NEEDS_CUSTOMER_OUTCOMES.has(candidate.kind) ? "needs_customer" : "goal_idle", outcome: candidate.kind };
        break;
      }
      const name = candidate.action.name;
      if (CUSTOMER_CHOICE_ACTIONS.has(name) || steps.some((s) => s.outcome.action.name === name)) {
        stop = { reason: "no_safe_next_step", outcome: name };
        break;
      }
      if (decide(graph, { action: name, params: candidate.action.input }).status === "denied") {
        stop = { reason: "next_step_not_enabled", outcome: name };
        break;
      }
      current = candidate;
      trigger = "continuation";
    }
    outcome = steps[steps.length - 1].outcome;
  }

  if (next) {
    state.stage = next.stage;
    if (next.kind === "checkout_needs_info" || next.kind === "needs_info") state.missingFields = next.missingFields;
  }

  const last = steps[steps.length - 1];
  const policyDecision: PolicyDecision | undefined = last?.policyDecision;
  const toolResult: ToolCallResult | null = last?.toolResult ?? null;
  const response = await composeTurn(reasoner, { graph, state, customerMessage: message }, outcome, steps, next, message);
  const rich = mergeRich(steps.map((st) => buildRichPayload(st.outcome, st.toolResult)));
  state.messages.push({ role: "barry", content: response, at: new Date().toISOString(), ...(rich ? { rich } : {}) });

  const knowledgeIds = knowledgeSearch(graph, message).map((k) => k.id);
  const offerIds = ir.selectedOfferId ? [ir.selectedOfferId] : ir.offerCandidateIds ?? [];
  // Recomputed (not reused from above) since it's cheap, pure, and the two
  // call sites above are in different branches — this is the single
  // source of truth for what the Inspector's "Response facts" show.
  const schedulingDisplay = buildSchedulingDisplay(graph, outcome, toolResult, message);

  const turn: TurnLog = {
    id: turnId(),
    at: new Date().toISOString(),
    customerMessage: message,
    understood: {
      intent: ir.intent,
      entities: ir.entities,
      customerInfo: ir.customerInfo,
      schedulingWindow: ir.constraints.schedulingWindow,
    },
    retrieved: { offerIds, knowledgeIds },
    verification,
    compiled: outcome.debug,
    goal: outcome.kind === "action" ? outcome.goal : ir.goal,
    selectedAction: outcome.kind === "action" ? outcome.action : null,
    policyDecision,
    toolResult: toolResult
      ? { ok: toolResult.ok, output: toolResult.ok ? toolResult.output : undefined, error: toolResult.ok ? undefined : toolResult.error }
      : undefined,
    responseFacts: schedulingDisplay ? { timezone: graph.business.timezone, ...schedulingDisplay } : undefined,
    response,
    stateAfter: { stage: state.stage, selectedOfferId: state.selectedOfferId, outcome: state.outcome },
    reasoner: reasoner.name,
    trace: {
      runtime: {
        barryVersion: BARRY_RUNTIME_VERSION,
        commit: runtimeCommit(),
        constitutionVersion: CONSTITUTION_VERSION,
        reasoner: reasoner.name,
        model: reasoner.model ?? null,
      },
      rejectedClaims: verification.rejected.map((r) => ({ claim: r.claim, reason: r.reason })),
      steps: steps.map((st) => st.trace),
      stop,
    },
  };
  state.turns.push(turn);

  await store.save(state);
  return { state, turn, response, rich };
}

/**
 * What BARRY actually showed / holds, re-read from the real provider —
 * the model resolves "the first one" against exactly this, and BARRY maps
 * the position back to the real id. Read-only; failures just omit it.
 */
async function buildGroundedContext(
  graph: BusinessGraph,
  state: ConversationState,
  ctx: ToolContext,
  profiles?: CapabilityProfiles
): Promise<GroundedContext | undefined> {
  const lastIds = state.knownFields[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
  const cartId = state.knownFields[SCRATCH_KEYS.commerceCartId];
  const canSearch = isActionAvailable(graph, "searchProducts");
  if (lastIds.length === 0 && !cartId && !canSearch && !profiles) return undefined;
  const grounded: GroundedContext = { profiles };
  if (canSearch) {
    try {
      grounded.catalog = await getCatalogSchema(graph);
    } catch (err) {
      console.error("[barry:engine] catalog schema unavailable", err instanceof Error ? err.message : err);
    }
  }
  try {
    const products = await Promise.all(lastIds.map((id) => getCommerceProduct(graph, id)));
    grounded.shownResults = products.flatMap((product, index) =>
      product
        ? [{
            index,
            title: product.title,
            options: product.variants.map((v) => ({ options: v.options, price: `${v.price.amount} ${v.price.currency}`, inStock: v.inventory.available > 0 })),
          }]
        : []
    );
    if (cartId) {
      const cart = await getOwnedCart({ graph, customerId: ctx.customerId, conversationId: ctx.conversationId }, cartId);
      grounded.cart = cart.lines.map((line, index) => ({ index, title: line.title, options: line.options, quantity: line.quantity }));
      grounded.cartTotal = `${cart.total.amount} ${cart.total.currency}`;
    }
  } catch (err) {
    console.error("[barry:engine] grounded context unavailable", err instanceof Error ? err.message : err);
  }
  return grounded;
}

const CONTINUE_IR: BarryIR = { intent: "continue", entities: {}, constraints: {}, customerInfo: {} };

/** Hard ceiling on actions per customer message — the loop is bounded no matter what state says. */
export const MAX_STEPS_PER_TURN = 4;
/** Actions that express a customer's choice: never taken on the customer's behalf. */
const CUSTOMER_CHOICE_ACTIONS = new Set(["addToCart", "updateCartLine", "searchProducts", "requestApproval"]);
/** After a chain, these tell the customer the one thing still needed; others are left unsaid. */
const NEEDS_CUSTOMER_OUTCOMES = new Set<CompileOutcome["kind"]>(["checkout_needs_info", "needs_info", "capability_unavailable", "confirm_purchase"]);

type ExecutedStep = {
  outcome: Extract<CompileOutcome, { kind: "action" }>;
  policyDecision: PolicyDecision;
  toolResult: ToolCallResult | null;
  trace: TurnStep;
};

/** Policy -> tool -> state for one action, recorded for audit (key names only — no customer values). */
async function runStep(
  graph: BusinessGraph,
  state: ConversationState,
  outcome: Extract<CompileOutcome, { kind: "action" }>,
  ctx: ToolContext,
  restoreStage: ConversationState["stage"],
  trigger: TurnStep["trigger"],
  profiles: CapabilityProfiles | undefined
): Promise<ExecutedStep> {
  const before = { ...state.knownFields };
  const stageBefore = state.stage;
  const { policyDecision, toolResult } = await authorizeAndExecute(graph, state, outcome, ctx, restoreStage);
  const after = state.knownFields;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
  const capabilities = (ACTION_REQUIREMENTS[outcome.action.name] ?? []).map((r) => ({
    capability: r.capability,
    provider: profiles?.[r.capability]?.provider ?? null,
  }));
  return {
    outcome,
    policyDecision,
    toolResult,
    trace: {
      trigger,
      action: outcome.action.name,
      capabilities,
      policy: { status: policyDecision.status, reason: policyDecision.reason, ...(policyDecision.policyId ? { policyId: policyDecision.policyId } : {}) },
      result: toolResult ? (toolResult.ok ? { ok: true } : { ok: false, error: toolResult.error }) : null,
      stageBefore,
      stageAfter: state.stage,
      stateKeysChanged: changed,
    },
  };
}

/** One reply for everything that happened this turn, in order, plus the single thing still needed. */
async function composeTurn(
  reasoner: ReturnType<typeof getReasoner>,
  rctx: ReasonerContext,
  outcome: CompileOutcome,
  steps: ExecutedStep[],
  next: CompileOutcome | undefined,
  message: string
): Promise<string> {
  const graph = rctx.graph;
  const last = steps[steps.length - 1];
  if (steps.length <= 1 && !next) {
    if (last?.policyDecision.status === "denied") return `I'm not able to do that: ${last.policyDecision.reason}`;
    if (last?.policyDecision.status === "requires_approval") {
      return reasoner.composeResponse(rctx, { outcome, toolResult: null, policyReason: last.policyDecision.reason });
    }
    const scheduling = buildSchedulingDisplay(graph, outcome, last?.toolResult ?? null, message);
    return reasoner.composeResponse(rctx, sanitizeComposeInput({ outcome, toolResult: last?.toolResult ?? null, scheduling }));
  }
  const scheduling = buildSchedulingDisplay(graph, outcome, last?.toolResult ?? null, message);
  return reasoner.composeResponse(
    rctx,
    sanitizeComposeInput({
      outcome,
      toolResult: last?.toolResult ?? null,
      policyReason: last?.policyDecision.status === "requires_approval" ? last.policyDecision.reason : undefined,
      scheduling,
      steps: steps.map((st) => ({
        outcome: st.outcome,
        toolResult: st.toolResult,
        policyReason: st.policyDecision.status !== "allowed" ? st.policyDecision.reason : undefined,
      })),
      next,
    })
  );
}

function mergeRich(parts: (NormalizedOutboundMessage["rich"] | undefined)[]): NormalizedOutboundMessage["rich"] | undefined {
  const merged: NonNullable<NormalizedOutboundMessage["rich"]> = {};
  for (const part of parts) {
    if (!part) continue;
    if (part.products) merged.products = part.products;
    if (part.paymentUrl) merged.paymentUrl = part.paymentUrl;
    if (part.media) merged.media = part.media;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Policy -> tool -> state, for one compiled action. The ONLY path by
 * which an action executes. State advances only on real success.
 */
async function authorizeAndExecute(
  graph: BusinessGraph,
  state: ConversationState,
  outcome: Extract<CompileOutcome, { kind: "action" }>,
  ctx: ToolContext,
  prevStage: ConversationState["stage"]
): Promise<{ policyDecision: PolicyDecision; toolResult: ToolCallResult | null }> {
  const policyDecision = decide(graph, { action: outcome.action.name, params: outcome.action.input });
  if (policyDecision.status === "denied") {
    state.stage = prevStage;
    return { policyDecision, toolResult: null };
  }
  if (policyDecision.status === "requires_approval") {
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
    } else {
      state.stage = prevStage;
    }
    return { policyDecision, toolResult: null };
  }
  const toolResult = await callTool(outcome.action.name, outcome.action.input, ctx);
  if (toolResult.ok) {
    state.stage = outcome.stage;
    await patchStateAfterTool(state, outcome.action.name, toolResult.output, prevStage);
  } else {
    state.stage = prevStage;
  }
  return { policyDecision, toolResult };
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
  const store = getConversationStore();
  const state = await store.get(conversationId);
  if (!state) throw new Error(`Conversation ${conversationId} not found`);

  // The webhook must name THIS conversation's own outstanding payment
  // request — never trust the caller-supplied conversationId/
  // paymentRequestId pairing on its own. Without this check, a webhook
  // that named the wrong (but real) paymentRequestId for this
  // conversationId — a misrouted call, or an adversarial one — would
  // mark this conversation paid off a payment that was never actually
  // requested for it, satisfying `!known[SCRATCH_KEYS.paid]` downstream
  // and letting the transaction complete without genuine payment.
  if (state.knownFields[SCRATCH_KEYS.paymentRequestId] !== paymentRequestId) {
    throw new Error(
      `Payment request ${paymentRequestId} does not belong to conversation ${conversationId}`
    );
  }

  const backend = getBackend();
  await backend.simulatePaymentOutcome(paymentRequestId, outcome);

  if (outcome === "failed") {
    // Clear the dead payment request — without this, `known[SCRATCH_KEYS.
    // paymentRequestId]` stays set to the FAILED id forever, and the
    // compiler's `!known[SCRATCH_KEYS.paymentRequestId]` guard (the one
    // condition that creates a NEW payment request) can never fire again.
    // A customer who says "let's try again" got stuck in a permanent
    // "just waiting on your payment" loop referencing a payment that had
    // already failed, with no way to actually retry.
    delete state.knownFields[SCRATCH_KEYS.paymentRequestId];
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

export async function handlePaymentWebhook(
  rawBody: string,
  headers: PaymentWebhookHeaders
): Promise<PaymentWebhookResult & { result?: TurnOutcome }> {
  const processed = await processPaymentWebhook(rawBody, headers);
  if (processed.duplicate || processed.superseded || processed.payment?.status !== "paid") return processed;
  try {
    const graph = resolveBusinessGraph(processed.payment.businessId);
    const result = await handleCustomerMessage(
      graph,
      processed.payment.conversationId,
      processed.payment.customerId,
      "(payment received)"
    );
    if (result.turn.toolResult && !result.turn.toolResult.ok) {
      throw new Error(result.turn.toolResult.error ?? "Payment webhook resume failed");
    }
    if (result.state.outcome !== "won" || result.state.stage !== "closed") {
      throw new Error("Payment webhook resume did not complete the transaction");
    }
    await markPaymentWebhookCompleted(processed);
    return { ...processed, result };
  } catch (err) {
    console.error("[barry:payment-webhook] resume failed", err);
    await markPaymentWebhookFailed(processed, err);
    throw new Error("Payment webhook resume failed");
  }
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

  // Idempotency guard: resolving the SAME approval twice (a double-click
  // in the owner UI, a retried request) must never execute the
  // requested action twice. Without this check, a second "approved"
  // resolution re-ran callTool() unconditionally — for a
  // createPaymentRequest approval, that meant a SECOND, independent
  // payment request created for the same transaction. Checked BEFORE
  // resolveApproval() mutates the record, so an already-resolved
  // approval never reaches the tool call at all.
  const existing = await backend.getApproval(approvalId);
  if (!existing) throw new Error(`Approval ${approvalId} not found`);
  if (existing.status !== "pending") {
    const store = getConversationStore();
    const state = await store.get(existing.conversationId);
    if (!state) throw new Error(`Conversation ${existing.conversationId} not found`);
    const response = `This request was already ${existing.status} — nothing more to do here.`;
    return {
      state,
      turn: {
        id: turnId(),
        at: new Date().toISOString(),
        customerMessage: "(duplicate owner approval resolution)",
        understood: { intent: "approval_already_resolved", entities: { decision: existing.status } },
        retrieved: { offerIds: [], knowledgeIds: [] },
        response,
        stateAfter: { stage: state.stage },
        reasoner: getReasoner().name,
      },
      response,
    };
  }

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
    if (toolResult.ok) await patchStateAfterTool(state, approval.requestedAction, toolResult.output, state.stage);

    const syntheticOutcome: CompileOutcome = {
      kind: "action",
      action: { name: approval.requestedAction, input },
      stage: state.stage,
    };
    const scheduling = buildSchedulingDisplay(graph, syntheticOutcome, toolResult, "(approval resumed)");
    response = await reasoner.composeResponse(
      { graph, state, customerMessage: "(approval resumed)" },
      sanitizeComposeInput({ outcome: syntheticOutcome, toolResult, scheduling })
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
