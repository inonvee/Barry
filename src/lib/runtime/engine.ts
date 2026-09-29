import type { BusinessGraph } from "@/lib/business-graph";
import { isActionAvailable, knowledgeSearch } from "@/lib/business-graph";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { decide, type PolicyDecision } from "@/lib/policy";
import { getReasoner } from "@/lib/reasoner";
import { callTool, listTools } from "@/lib/tools";
import type { ToolCallResult, ToolContext } from "@/lib/tools";
import { getConversationStore } from "@/lib/state";
import type { ConversationState, TurnLog } from "@/lib/state";
import { getBackend } from "@/lib/store";
import { formatLocalDateTime } from "@/lib/scheduling/resolver";
import type { CustomerFacingLocalDisplay, GroundedContext, ReasonerContext, SchedulingDisplayFacts } from "@/lib/reasoner/types";
import { resolveCapabilityProfiles, actionSupported, ACTION_REQUIREMENTS, type CapabilityProfiles } from "@/lib/capabilities";
import { capabilityDomain } from "@/lib/fabric/capability";
import type { TurnStep, TurnTrace } from "@/lib/state";
import { CONSTITUTION_VERSION } from "@/lib/reasoner/constitution";
import { resolveReplyLanguage, type ReplyLanguage } from "@/lib/reasoner/language";
import { checkInfoRequest, infoRequestFields } from "@/lib/reasoner/reply-contract";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { findInternalLeak, internalVocabulary } from "@/lib/reasoner/reply-hygiene";
import type { ComposeResponseInput } from "@/lib/reasoner/types";
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
import { compile, planCapabilityCall, SCRATCH_KEYS, type CompileOutcome } from "./compiler";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { callFingerprint, INVOKE_CAPABILITY, type CapabilityCallResult } from "@/lib/tools/capability-tool";
import { capabilityFailureMessage, readCapabilityResults, recordCapabilityResult } from "./capability-state";

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
  if (toolName === INVOKE_CAPABILITY) {
    recordCapabilityResult(state, output as CapabilityCallResult);
    return;
  }
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
        // The requested change did NOT happen: the cart still holds what it
        // held before. Nothing may progress toward checkout on that basis.
        delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
        delete known[SCRATCH_KEYS.commerceCheckoutRequested];
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
      // Verified success: a purchase decision made with this change now
      // makes the cart eligible for checkout.
      if (known[SCRATCH_KEYS.commerceCheckoutOnSuccess]) {
        known[SCRATCH_KEYS.commerceCheckoutRequested] = "1";
        delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
      }
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

function prefersTwentyFourHourDisplay(customerMessage: string, businessLocale: string, language?: ReplyLanguage): boolean {
  if (language) return language.code === "he";
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
  customerMessage: string,
  language?: ReplyLanguage
): SchedulingDisplayFacts | undefined {
  const timeZone = graph.business.timezone;
  const useTwentyFourHour = prefersTwentyFourHourDisplay(customerMessage, graph.business.locale, language);

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
  // Reply language: from the latest customer message that has WORDS (a
  // phone number, email, code or emoji never switches it), then what this
  // conversation already used, then the business locale.
  const language = resolveReplyLanguage({
    customerMessages: state.messages.filter((m) => m.role === "customer").map((m) => m.content),
    stored: state.knownFields[SCRATCH_KEYS.conversationLanguage],
    businessLocale: graph.business.locale,
  });
  if (language.basis === "current_turn" || language.basis === "recent_turn") state.knownFields[SCRATCH_KEYS.conversationLanguage] = language.code;

  const reasoner = getReasoner();
  const ctx: ToolContext = { graph, conversationId, customerId };

  const profiles = await resolveCapabilityProfiles(graph).catch((err) => {
    console.error("[barry:engine] capability profiles unavailable", err instanceof Error ? err.message : err);
    return undefined;
  });
  const grounded: GroundedContext = (await buildGroundedContext(graph, state, ctx, profiles)) ?? {};
  // The business's OWN capability surface (beyond the typed flows) and what earlier calls returned:
  // the model reasons over these; it never selects a system and never grants itself authority.
  grounded.capabilities = await buildCapabilitySurface(graph).catch((err) => {
    console.error("[barry:engine] capability surface unavailable", err instanceof Error ? err.message : err);
    return [];
  });
  grounded.capabilityResults = readCapabilityResults(state);
  const rawIr = await reasoner.understand({ graph, state, customerMessage: message, grounded });
  // The model owns understanding; verifyIR() only GROUNDS it — evidence
  // for persisted facts, consistency with current state, structural
  // ranges. It never adds a semantic value of its own.
  const { verified: ir, verification } = verifyIR(graph, message, rawIr, state, { catalog: grounded.catalog, capabilities: grounded.capabilities, capabilityResults: grounded.capabilityResults });
  const prevStage = state.stage;
  let outcome = compile(graph, state, ir, { profiles, shownProducts: grounded?.shownProducts });

  state.detectedIntent = ir.intent;
  // Non-action outcomes describe where the conversation now is. An
  // action's stage only applies once its tool actually succeeds.
  if (outcome.kind !== "action") state.stage = outcome.stage;
  state.missingFields = outcome.kind === "needs_info" || outcome.kind === "checkout_needs_info" || outcome.kind === "capability_needs_input" ? outcome.missingFields : [];

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
      // Same gate for every step, customer-triggered or continued: never
      // attempt an operation the connected provider says it can't perform.
      const support = actionSupported(profiles, current.action.name);
      if (!support.ok) {
        const unavailable: CompileOutcome = { kind: "capability_unavailable", action: current.action.name, missing: support.missing, stage: state.stage };
        if (steps.length === 0) {
          state.stage = prevStage;
          outcome = unavailable;
        } else {
          next = unavailable;
        }
        stop = { reason: "capability_unavailable", outcome: current.action.name };
        break;
      }
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
      // A call can succeed while the requested change did not happen (e.g.
      // the variant is unavailable). That ends the chain: nothing that
      // follows may build on a change that never occurred.
      if (!requestedChangeApplied(current.action.name, step.toolResult.output)) {
        stop = { reason: "requested_change_not_applied", outcome: current.action.name };
        break;
      }
      if (steps.length >= MAX_STEPS_PER_TURN) {
        stop = { reason: "step_budget", outcome: current.action.name };
        break;
      }
      // After a generic capability call, the next step is the MODEL's to propose from the result
      // (when the result shows something another capability exists to handle) — grounded, compiled and
      // authorized exactly like the first. Otherwise the typed goal planner continues from state.
      const candidate =
        current.action.name === INVOKE_CAPABILITY
          ? await continueFromCapabilityResult(reasoner, graph, state, message, grounded)
          : compile(graph, state, CONTINUE_IR, { profiles });
      if (candidate.kind !== "action") {
        if (NEEDS_CUSTOMER_OUTCOMES.has(candidate.kind)) next = candidate;
        stop = { reason: NEEDS_CUSTOMER_OUTCOMES.has(candidate.kind) ? "needs_customer" : "goal_idle", outcome: candidate.kind };
        break;
      }
      const name = candidate.action.name;
      if (CUSTOMER_CHOICE_ACTIONS.has(name) || steps.some((s) => sameCall(s.outcome.action, candidate.action))) {
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
    if (steps.length > 0) outcome = steps[steps.length - 1].outcome;
  }

  if (next) {
    state.stage = next.stage;
    if (next.kind === "checkout_needs_info" || next.kind === "needs_info") state.missingFields = next.missingFields;
  }

  const last = steps[steps.length - 1];
  const policyDecision: PolicyDecision | undefined = last?.policyDecision;
  const toolResult: ToolCallResult | null = last?.toolResult ?? null;
  const composed = await composeTurn(reasoner, { graph, state, customerMessage: message, grounded }, outcome, steps, next, message, language);
  const response = composed.text;
  const rich = mergeRich(steps.map((st) => buildRichPayload(st.outcome, st.toolResult)));
  state.messages.push({ role: "barry", content: response, at: new Date().toISOString(), ...(rich ? { rich } : {}) });

  const knowledgeIds = knowledgeSearch(graph, message).map((k) => k.id);
  const offerIds = ir.selectedOfferId ? [ir.selectedOfferId] : ir.offerCandidateIds ?? [];
  // Recomputed (not reused from above) since it's cheap, pure, and the two
  // call sites above are in different branches — this is the single
  // source of truth for what the Inspector's "Response facts" show.
  const schedulingDisplay = buildSchedulingDisplay(graph, outcome, toolResult, message, language);

  const turn: TurnLog = {
    id: turnId(),
    at: new Date().toISOString(),
    customerMessage: message,
    understood: {
      intent: ir.intent,
      entities: ir.entities,
      customerInfo: ir.customerInfo,
      schedulingWindow: ir.constraints.schedulingWindow,
      ...(ir.commerce ? { commerce: ir.commerce } : {}),
      ...(ir.purchaseDecision !== undefined ? { purchaseDecision: ir.purchaseDecision } : {}),
      ...(ir.customerClaims ? { customerClaims: ir.customerClaims } : {}),
      ...(ir.knowledgeTopic ? { knowledgeTopic: ir.knowledgeTopic } : {}),
      ...(ir.capabilityRequest ? { capabilityRequest: ir.capabilityRequest } : {}),
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
        composerModel: reasoner.composerModel ?? null,
        reasoningEffort: reasoner.reasoningEffort ?? null,
        composerReasoningEffort: reasoner.composerReasoningEffort ?? null,
        ...(reasoner.configError ? { configError: reasoner.configError } : {}),
      },
      rejectedClaims: verification.rejected.map((r) => ({ claim: r.claim, reason: r.reason })),
      steps: steps.map((st) => st.trace),
      stop,
      reply: { language: language.code, basis: language.basis, ...(composed.fallback ? { fallback: composed.fallback } : {}) },
      missingFields: state.missingFields,
      ...(grounded?.shownResults?.length || grounded?.cart
        ? {
            context: {
              shown: (grounded.shownResults ?? []).map((p) => ({ position: p.position, title: p.title })),
              ...(grounded.cart ? { cart: { lines: grounded.cart, total: grounded.cartTotal ?? null } } : {}),
            },
          }
        : {}),
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
    // Positions stay aligned with what the customer saw, even if a product
    // has since disappeared from the provider (it is simply omitted).
    grounded.shownProducts = products.flatMap((product, index) =>
      product
        ? [{
            id: product.id,
            position: index + 1,
            title: product.title,
            variants: product.variants.map((v) => ({ options: v.options, price: `${v.price.amount} ${v.price.currency}`, inStock: v.inventory.available > 0 })),
          }]
        : []
    );
    grounded.shownResults = grounded.shownProducts.map(({ id: _id, ...shown }) => {
      void _id;
      return shown;
    });
    if (cartId) {
      const cart = await getOwnedCart({ graph, customerId: ctx.customerId, conversationId: ctx.conversationId }, cartId);
      grounded.cart = cart.lines.map((line, index) => ({ position: index + 1, title: line.title, options: line.options, quantity: line.quantity }));
      grounded.cartTotal = `${cart.total.amount} ${cart.total.currency}`;
    }
  } catch (err) {
    console.error("[barry:engine] grounded context unavailable", err instanceof Error ? err.message : err);
  }
  return grounded;
}

const CONTINUE_IR: BarryIR = { intent: "continue", entities: {}, constraints: {}, customerInfo: {} };

/** The same action twice in one turn — for the generic action, the same capability with the same input. */
function sameCall(a: { name: string; input: Record<string, unknown> }, b: { name: string; input: Record<string, unknown> }): boolean {
  if (a.name !== b.name) return false;
  if (a.name !== INVOKE_CAPABILITY) return true;
  const x = a.input as { capability: string; input: Record<string, unknown> };
  const y = b.input as { capability: string; input: Record<string, unknown> };
  return x.capability === y.capability && callFingerprint(x.capability, x.input) === callFingerprint(y.capability, y.input);
}

/**
 * Reasoning continuation: re-ask the model, same customer message, now with
 * the capability results this turn produced. Only a capability proposal can
 * come back; it is grounded and compiled like any other.
 */
async function continueFromCapabilityResult(
  reasoner: ReturnType<typeof getReasoner>,
  graph: BusinessGraph,
  state: ConversationState,
  message: string,
  grounded: GroundedContext
): Promise<CompileOutcome> {
  const context: GroundedContext = { ...grounded, capabilityResults: readCapabilityResults(state) };
  const raw = await reasoner.understand({ graph, state, customerMessage: message, grounded: context });
  const { verified } = verifyIR(graph, message, { ...raw, customerInfo: {}, evidence: {} }, state, { capabilities: context.capabilities, capabilityResults: context.capabilityResults });
  if (!verified.capabilityRequest) return { kind: "generic_confirm", stage: state.stage };
  return planCapabilityCall(verified.capabilityRequest, state.stage) ?? { kind: "generic_confirm", stage: state.stage };
}

/** Hard ceiling on actions per customer message — the loop is bounded no matter what state says. */
export const MAX_STEPS_PER_TURN = 4;
/** Actions that express a customer's choice: never taken on the customer's behalf. */
const CUSTOMER_CHOICE_ACTIONS = new Set(["addToCart", "updateCartLine", "searchProducts", "requestApproval"]);
/** After a chain, these tell the customer the one thing still needed; others are left unsaid. */
const NEEDS_CUSTOMER_OUTCOMES = new Set<CompileOutcome["kind"]>(["checkout_needs_info", "needs_info", "capability_unavailable", "confirm_purchase", "capability_needs_input"]);

/** Did an action that asks for a change actually make it? (Tool success is not the same thing.) */
function requestedChangeApplied(action: string, output: unknown): boolean {
  if (action === "addToCart" || action === "updateCartLine") return (output as { added?: boolean } | undefined)?.added === true;
  return true;
}

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
  const capabilities = (ACTION_REQUIREMENTS[outcome.action.name] ?? []).map((id) => ({
    capability: id,
    provider: (profiles as Record<string, CapabilityProfiles[keyof CapabilityProfiles] | undefined> | undefined)?.[capabilityDomain(id)]?.provider ?? null,
  }));
  return {
    outcome,
    policyDecision,
    toolResult,
    trace: {
      trigger,
      action: outcome.action.name,
      ...(outcome.action.name === INVOKE_CAPABILITY ? { generic: genericStepTrace(outcome.action.input, policyDecision, toolResult) } : {}),
      capabilities: outcome.action.name === INVOKE_CAPABILITY ? genericCapabilities(outcome.action.input, toolResult) : capabilities,
      policy: { status: policyDecision.status, reason: policyDecision.reason, ...(policyDecision.policyId ? { policyId: policyDecision.policyId } : {}) },
      result: toolResult ? (toolResult.ok ? { ok: true } : { ok: false, error: toolResult.error }) : null,
      stageBefore,
      stageAfter: state.stage,
      stateKeysChanged: changed,
    },
  };
}

function genericResult(toolResult: ToolCallResult | null): CapabilityCallResult | undefined {
  if (!toolResult) return undefined;
  return toolResult.ok ? (toolResult.output as CapabilityCallResult) : ((toolResult as { capability?: CapabilityCallResult }).capability ?? undefined);
}

function genericCapabilities(input: Record<string, unknown>, toolResult: ToolCallResult | null): TurnStep["capabilities"] {
  return [{ capability: String(input.capability), provider: genericResult(toolResult)?.provenance?.system ?? null }];
}

/** What a generic step did — capability, why, which input FIELDS (never values), authority, system, execution, verification. */
function genericStepTrace(input: Record<string, unknown>, policy: PolicyDecision, toolResult: ToolCallResult | null): NonNullable<TurnStep["generic"]> {
  const r = genericResult(toolResult);
  return {
    capability: String(input.capability),
    purpose: String(input.purpose ?? ""),
    inputFields: Object.keys((input.input as Record<string, unknown>) ?? {}).sort(),
    authority: { status: policy.status, reason: policy.reason, ...(policy.policyId ? { ruleId: policy.policyId } : {}) },
    executed: r?.executed ?? false,
    verified: r?.verified ?? false,
    ...(r?.code ? { code: r.code } : {}),
    ...(r?.provenance ? { system: r.provenance.system, connector: r.provenance.connector, contractVersion: r.provenance.version, simulated: r.provenance.simulated } : {}),
  };
}

/** One reply for everything that happened this turn, in order, plus the single thing still needed. */
async function composeTurn(
  reasoner: ReturnType<typeof getReasoner>,
  rctx: ReasonerContext,
  outcome: CompileOutcome,
  steps: ExecutedStep[],
  next: CompileOutcome | undefined,
  message: string,
  language: ReplyLanguage
): Promise<{ text: string; fallback?: string }> {
  const graph = rctx.graph;
  const last = steps[steps.length - 1];
  let input: ComposeResponseInput;
  if (steps.length <= 1 && !next) {
    if (last?.policyDecision.status === "denied") {
      // The rule's text stays in the trace; the customer hears what it means for them.
      input = { outcome, toolResult: null, refused: true, language };
      return guardReply(reasoner, rctx, input, await reasoner.composeResponse(rctx, input));
    }
    if (last?.policyDecision.status === "requires_approval") {
      input = { outcome, toolResult: null, policyReason: last.policyDecision.reason, language };
      return guardReply(reasoner, rctx, input, await reasoner.composeResponse(rctx, input));
    }
    input = sanitizeComposeInput({ outcome, toolResult: last?.toolResult ?? null, scheduling: buildSchedulingDisplay(graph, outcome, last?.toolResult ?? null, message, language), language });
  } else {
    input = sanitizeComposeInput({
      outcome,
      toolResult: last?.toolResult ?? null,
      policyReason: last?.policyDecision.status === "requires_approval" ? last.policyDecision.reason : undefined,
      scheduling: buildSchedulingDisplay(graph, outcome, last?.toolResult ?? null, message, language),
      steps: steps.map((st) => ({
        outcome: st.outcome,
        toolResult: st.toolResult,
        policyReason: st.policyDecision.status !== "allowed" ? st.policyDecision.reason : undefined,
      })),
      next,
      language,
    });
  }
  const guarded = guardReply(reasoner, rctx, input, await reasoner.composeResponse(rctx, input));
  if (guarded.fallback) return guarded;
  const text = guarded.text;
  // The details BARRY asks for are the compiler's truth. A reply that asks
  // for anything else (or something stricter, or drops one) is replaced by
  // the localized deterministic request — correct, just plainer.
  const fields = infoRequestFields(next ?? outcome);
  if (fields && reasoner.name === "llm") {
    const violation = checkInfoRequest(text, fields, language.code);
    if (violation) return { text: composeDeterministic(input), fallback: `missing-field contract: ${violation.reason}` };
  }
  return { text };
}

/**
 * Reply hygiene: a customer never sees BARRY's machinery. A model-written reply that names an
 * internal identifier (a capability id, an action/tool name, an authority or policy rule id, a raw
 * enum value from this turn's system results) or quotes the rule text behind an approval/refusal is
 * replaced by the deterministic reply — plainer, but clean — and the swap is recorded in the trace.
 */
function guardReply(
  reasoner: ReturnType<typeof getReasoner>,
  rctx: ReasonerContext,
  input: ComposeResponseInput,
  text: string
): { text: string; fallback?: string } {
  if (reasoner.name !== "llm") return { text };
  const leak = findInternalLeak(text, internalVocabulary(rctx, input, listTools().map((t) => t.name)));
  return leak ? { text: composeDeterministic(input), fallback: `reply hygiene: ${leak}` } : { text };
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
  const toolResult = genericFailureAsError(outcome.action.name, await callTool(outcome.action.name, outcome.action.input, ctx), state);
  if (toolResult.ok) {
    state.stage = outcome.stage;
    await patchStateAfterTool(state, outcome.action.name, toolResult.output, prevStage);
  } else {
    state.stage = prevStage;
  }
  return { policyDecision, toolResult };
}

/**
 * The generic action always returns a structured result; one that did not
 * succeed is a FAILED step (with a customer-safe message) — and is still
 * recorded, so the next reasoning step knows it failed.
 */
function genericFailureAsError(action: string, result: ToolCallResult, state: ConversationState): ToolCallResult {
  if (action !== INVOKE_CAPABILITY || !result.ok) return result;
  const out = result.output as CapabilityCallResult;
  if (out.ok) return result;
  recordCapabilityResult(state, out);
  return { ok: false, error: capabilityFailureMessage(out.code), capability: out } as ToolCallResult;
}

/**
 * Simulate a payment outcome (as a verified provider event would report it) and
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
  let approvalStep: TurnStep | undefined;
  // The customer hears back in the conversation's own language, and BARRY is no longer waiting on the owner.
  const language = resolveReplyLanguage({
    customerMessages: state.messages.filter((m) => m.role === "customer").map((m) => m.content),
    stored: state.knownFields[SCRATCH_KEYS.conversationLanguage],
    businessLocale: graph.business.locale,
  });
  state.pendingApprovalId = null;
  state.pendingAction = null;
  const resumeCtx: ReasonerContext = { graph, state, customerMessage: "(approval resumed)" };

  if (decision === "declined") {
    const declinedOutcome: CompileOutcome = { kind: "action", action: { name: approval.requestedAction, input: {} }, stage: state.stage };
    response = await reasoner.composeResponse(resumeCtx, { outcome: declinedOutcome, toolResult: null, ownerDecision: "declined", language });
  } else {
    // A generic capability call resumes EXACTLY as approved: the owner can't substitute another
    // call, and the tool re-checks the approval (this business and conversation, same capability and
    // input, approved, unexpired) and current authority before executing — once.
    const generic = approval.requestedAction === INVOKE_CAPABILITY;
    const input = generic
      ? { ...(approval.requestedInput as Record<string, unknown>), approvalId }
      : ((alternateValue ?? approval.requestedInput) as Record<string, unknown>);
    toolResult = genericFailureAsError(approval.requestedAction, await callTool(approval.requestedAction, input, ctx), state);
    if (toolResult.ok) await patchStateAfterTool(state, approval.requestedAction, toolResult.output, state.stage);
    if (generic) {
      approvalStep = {
        trigger: "approval",
        action: INVOKE_CAPABILITY,
        generic: genericStepTrace(input, { status: "allowed", reason: `Owner approval ${approvalId}` }, toolResult),
        capabilities: genericCapabilities(input, toolResult),
        policy: { status: "allowed", reason: `Owner approval ${approvalId}` },
        result: toolResult.ok ? { ok: true } : { ok: false, error: toolResult.error },
        stageBefore: state.stage,
        stageAfter: state.stage,
        stateKeysChanged: toolResult.ok || genericResult(toolResult) ? [SCRATCH_KEYS.capabilityResults] : [],
      };
    }

    const syntheticOutcome: CompileOutcome = {
      kind: "action",
      action: { name: approval.requestedAction, input },
      stage: state.stage,
    };
    const scheduling = buildSchedulingDisplay(graph, syntheticOutcome, toolResult, "(approval resumed)", language);
    response = await reasoner.composeResponse(resumeCtx, sanitizeComposeInput({ outcome: syntheticOutcome, toolResult, scheduling, ownerDecision: "approved", language }));
  }

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
    ...(approvalStep
      ? {
          trace: {
            runtime: { barryVersion: BARRY_RUNTIME_VERSION, commit: runtimeCommit(), constitutionVersion: CONSTITUTION_VERSION, reasoner: reasoner.name, model: reasoner.model ?? null },
            rejectedClaims: [],
            steps: [approvalStep],
            stop: { reason: toolResult?.ok ? "approval_executed" : "approval_execution_failed", outcome: INVOKE_CAPABILITY },
          },
        }
      : {}),
  };
  state.turns.push(turn);

  await store.save(state);
  return { state, turn, response };
}
