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
import { ApprovalAlreadyResolvedError, type ApprovalRecord } from "@/lib/store/types";
import { formatLocalDateTime } from "@/lib/scheduling/resolver";
import type { CustomerFacingLocalDisplay, GroundedContext, ModelCallFailure, Reasoner, ReasonerContext, SchedulingDisplayFacts, UnderstandingResult } from "@/lib/reasoner/types";
import { resolveCapabilityProfiles, actionSupported, ACTION_REQUIREMENTS, type CapabilityProfiles } from "@/lib/capabilities";
import { capabilityDomain } from "@/lib/fabric/capability";
import type { TurnStep, TurnTrace } from "@/lib/state";
import { CONSTITUTION_VERSION } from "@/lib/reasoner/constitution";
import { resolveReplyLanguage, type ReplyLanguage } from "@/lib/reasoner/language";
import { checkInfoRequest, infoRequestFields } from "@/lib/reasoner/reply-contract";
import { composeDeterministic, understandingUnavailableText, intentHeldText } from "@/lib/reasoner/deterministic-compose";
import { findInternalLeak, internalVocabulary } from "@/lib/reasoner/reply-hygiene";
import { claimEvidence, findMisattributedReferences, findUnsupportedClaims, languageMismatch, trimClosers } from "@/lib/reasoner/claim-grounding";
import { renderStatus } from "@/lib/reasoner/status-render";
import { appendLedger, classifyBlocked, classifyExecution, readLedger, requestEntry, type CartLineSnapshot, type LedgerEntry } from "./ledger";
import { currentQuote } from "./pricing";
import { finalWriteGate, type WriteBlock } from "./write-gate";
import { conversationApprovals, customerIntentHold, describeRequest, findSameRequest, recordReconfirmed, settleChangedTerms, supersedeOlderRevisions, ownerRequestViews, recordOwnerRequestResult, withdrawPendingRequests, type ExistingRequest, type IntentHold } from "./owner-requests";
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
        known[SCRATCH_KEYS.checkoutScope] = JSON.stringify("all");
        delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
      } else {
        // The cart changed without a decision to buy it as it now is: earlier checkout consent was
        // for the earlier cart revision and no longer applies.
        delete known[SCRATCH_KEYS.commerceCheckoutRequested];
        delete known[SCRATCH_KEYS.checkoutScope];
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
      // Stock is checked FOR a quantity: enough for what the customer wants, or not checked at all.
      const { quantityAvailable } = output as { quantityAvailable: number };
      const wanted = Number(known[SCRATCH_KEYS.quantity] ?? 1);
      if (quantityAvailable >= wanted) known[SCRATCH_KEYS.inventoryChecked] = String(wanted);
      else delete known[SCRATCH_KEYS.inventoryChecked];
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
  grounded.ownerRequests = ownerRequestViews(await conversationApprovals(graph.business.id, conversationId), state);
  // Effects recorded after this point happened in THIS turn (e.g. a lookup that can back an availability claim).
  grounded.turnStartSeq = readLedger(state).length;
  // Model-call failures the reasoner recovers from (e.g. a composer call that fell back) land here for the trace.
  const diagnostics = { composerFailures: [] as ModelCallFailure[] };
  const understanding = await understandTurn(reasoner, { graph, state, customerMessage: message, grounded, diagnostics });
  // An understanding that failed is NOT a turn to compile: an empty IR would read as "the customer
  // said nothing" and become a generic greeting. Nothing is done, the reply says so truthfully, and
  // the reason is in the trace.
  if (!understanding.valid) return understandingUnavailableTurn({ graph, state, message, language, reasoner, grounded, understanding, diagnostics });
  const rawIr = understanding.ir;
  // The model owns understanding; verifyIR() only GROUNDS it — evidence
  // for persisted facts, consistency with current state, structural
  // ranges. It never adds a semantic value of its own.
  const { verified: ir, verification } = verifyIR(graph, message, rawIr, state, { catalog: grounded.catalog, capabilities: grounded.capabilities, capabilityResults: grounded.capabilityResults, cartLineCount: grounded.cartLines?.length });
  const prevStage = state.stage;
  // The customer's current intent controls requests still waiting on the owner: withdrawing, or
  // changing their terms, withdraws them before anything else happens this turn.
  // A withdrawal happens now (scoped to the requests it names). Changed terms are settled AFTER this
  // turn's steps (atomically): the old request is superseded only once we know whether a valid
  // replacement exists — never leaving a phantom "the owner is reviewing it".
  delete state.knownFields.__reusedApprovalThisTurn;
  const withdrawnRequests = ir.withdrawsRequest ? await withdrawPendingRequests(graph, state, "withdrawn", ir.withdrawScope) : 0;
  const pendingBeforeChange = ir.changesPendingRequest && !ir.withdrawsRequest ? (await conversationApprovals(graph.business.id, conversationId)).filter((a) => a.status === "pending") : [];
  if (withdrawnRequests > 0) grounded.ownerRequests = ownerRequestViews(await conversationApprovals(graph.business.id, conversationId), state);
  state.knownFields.__focusOfferId = ir.selectedOfferId ?? "";
  let outcome = compile(graph, state, ir, { profiles, shownProducts: grounded?.shownProducts, cartLines: grounded.cartLines });
  // The customer changed a pending request's terms but this understanding proposed no replacement:
  // ask the model ONCE more, now told exactly which request is being replaced, for the replacement
  // (if the customer asked for one). It is grounded, compiled and authorized like any proposal; when
  // none comes back, atomic revision below says truthfully that nothing is waiting on the owner.
  if (pendingBeforeChange.length > 0 && ir.advancesTransaction !== false && outcome.kind !== "action") {
    const replacement = await proposeReplacement(reasoner, graph, state, message, grounded, pendingBeforeChange);
    if (replacement) outcome = replacement;
  }
  if (outcome.kind === "withdrawn") outcome = { ...outcome, withdrawnRequests };

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

  // The cart as it stands before each step (re-read at turn start, then taken from each mutation's
  // returned cart) — every cart receipt freezes the exact line and its before/after quantity.
  let cartNow: CartLineSnapshot[] | undefined = grounded.cartLines;
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
      const step = await runStep(graph, state, current, ctx, trigger === "customer" ? prevStage : state.stage, trigger, profiles, cartNow);
      steps.push(step);
      const returnedCart = (step.toolResult?.ok ? (step.toolResult.output as { cart?: { lines: { id: string; title: string; options: Record<string, string>; quantity: number }[] } }).cart : undefined)?.lines;
      if (returnedCart) cartNow = returnedCart.map((l, i) => ({ position: i + 1, id: l.id, title: l.title, options: l.options, quantity: l.quantity }));
      if (step.policyDecision.status !== "allowed") {
        stop = { reason: step.blocked ? "write_blocked" : step.policyDecision.status === "denied" ? "policy_denied" : "owner_approval_required", outcome: current.action.name };
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
          : compile(graph, state, ir.advancesTransaction === false ? { ...CONTINUE_IR, advancesTransaction: false } : CONTINUE_IR, { profiles });
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

  // A salvaged understanding lost a field that could carry a decision: recorded (after any steps) so a
  // request pending on the owner is held until the customer's intent is re-established.
  if (understanding.failClosed) appendLedger(state, understandingEntry("partial"));

  if (pendingBeforeChange.length > 0) {
    const settled = await settleChangedTerms(graph, state, pendingBeforeChange);
    if (!settled.replacement) grounded.revisionWithoutReplacement = true;
  }

  if (next) {
    state.stage = next.stage;
    if (next.kind === "checkout_needs_info" || next.kind === "needs_info") state.missingFields = next.missingFields;
  }

  const last = steps[steps.length - 1];
  const policyDecision: PolicyDecision | undefined = last?.policyDecision;
  const toolResult: ToolCallResult | null = last?.toolResult ?? null;
  const composed = await composeTurn(reasoner, { graph, state, customerMessage: message, grounded, diagnostics }, outcome, steps, next, message, language);
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
      signals: {
        advancesTransaction: rawIr.advancesTransaction ?? null,
        withdrawsRequest: rawIr.withdrawsRequest ?? null,
        changesPendingRequest: rawIr.changesPendingRequest ?? null,
        readRequested: rawIr.readRequested ?? null,
        checkoutConsent: rawIr.checkoutConsent ?? null,
        quantity: rawIr.constraints.quantity ?? null,
      },
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
      runtime: runtimeTrace(reasoner),
      understanding: understandingTrace(understanding),
      rejectedClaims: verification.rejected.map((r) => ({ claim: r.claim, reason: r.reason })),
      steps: steps.map((st) => st.trace),
      stop,
      reply: { language: language.code, basis: language.basis, ...(composed.fallback ? { fallback: composed.fallback } : {}), ...(diagnostics.composerFailures.length ? { composerFailures: diagnostics.composerFailures } : {}) },
      effects: ledgerForTrace(readLedger(state).slice(grounded.turnStartSeq ?? 0)),
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

/** Understanding with its outcome. A reasoner without detailed reporting is taken at its word. */
async function understandTurn(reasoner: Reasoner, ctx: ReasonerContext): Promise<UnderstandingResult> {
  if (reasoner.understandDetailed) return reasoner.understandDetailed(ctx);
  const started = Date.now();
  const ir = await reasoner.understand(ctx);
  return { ir, valid: true, attempts: 1, latencyMs: Date.now() - started, usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }, model: reasoner.model ?? reasoner.name };
}

function understandingTrace(u: UnderstandingResult): NonNullable<TurnTrace["understanding"]> {
  return {
    valid: u.valid,
    attempts: u.attempts,
    latencyMs: u.latencyMs,
    ...(u.failure ? { failure: u.failure } : {}),
    ...(u.salvagedFields?.length ? { salvagedFields: u.salvagedFields } : {}),
    ...(u.failClosed ? { failClosed: true } : {}),
  };
}

/** A customer message BARRY could not (fully) understand — a ledger fact: nothing was done for it. */
function understandingEntry(kind: "failed" | "partial"): Omit<LedgerEntry, "seq" | "at"> {
  return {
    operation: "understand",
    effect: `understanding.${kind}`,
    status: "no_effect",
    describes: kind === "failed" ? "the customer's message could not be understood" : "the customer's message was only partly understood",
    terms: {},
  };
}

function runtimeTrace(reasoner: Reasoner): TurnTrace["runtime"] {
  return {
    barryVersion: BARRY_RUNTIME_VERSION,
    commit: runtimeCommit(),
    constitutionVersion: CONSTITUTION_VERSION,
    reasoner: reasoner.name,
    model: reasoner.model ?? null,
    composerModel: reasoner.composerModel ?? null,
    reasoningEffort: reasoner.reasoningEffort ?? null,
    composerReasoningEffort: reasoner.composerReasoningEffort ?? null,
    ...(reasoner.configError ? { configError: reasoner.configError } : {}),
  };
}

/**
 * The turn when understanding failed: no withdrawal, no compile, no step, no write. The reply is
 * deterministic and truthful — the message wasn't processed, nothing changed — plus where things
 * really stand when anything is pending or done, and that a request waiting on the owner is now held
 * until the customer confirms it. The classified reason is in the trace (and the Inspector).
 */
async function understandingUnavailableTurn(args: {
  graph: BusinessGraph;
  state: ConversationState;
  message: string;
  language: ReplyLanguage;
  reasoner: Reasoner;
  grounded: GroundedContext;
  understanding: UnderstandingResult;
  diagnostics: { composerFailures: ModelCallFailure[] };
}): Promise<TurnOutcome> {
  const { graph, state, message, language, reasoner, grounded, understanding } = args;
  const store = getConversationStore();
  const startSeq = readLedger(state).length;
  appendLedger(state, understandingEntry("failed"));
  const requests = ownerRequestViews(await conversationApprovals(graph.business.id, state.id), state);
  const ledger = readLedger(state);
  const consequential = ledger.some((e) => e.status === "effected" && !/\.(read|searched)$|^(availability|stock|catalog)\./.test(e.effect));
  const status = requests.length > 0 || consequential ? renderStatus({ requests, ledger, lang: language.code }) : undefined;
  const response = understandingUnavailableText(language.code, { status, held: requests.some((r) => r.lifecycle === "held") });
  state.messages.push({ role: "barry", content: response, at: new Date().toISOString() });
  const turn: TurnLog = {
    id: turnId(),
    at: new Date().toISOString(),
    customerMessage: message,
    understood: {
      intent: understanding.ir.intent,
      entities: {},
      signals: { advancesTransaction: null, withdrawsRequest: null, changesPendingRequest: null, readRequested: null, checkoutConsent: null, quantity: null },
    },
    retrieved: { offerIds: [], knowledgeIds: [] },
    selectedAction: null,
    response,
    stateAfter: { stage: state.stage, selectedOfferId: state.selectedOfferId, outcome: state.outcome },
    reasoner: reasoner.name,
    trace: {
      runtime: runtimeTrace(reasoner),
      understanding: understandingTrace(understanding),
      rejectedClaims: [],
      steps: [],
      stop: { reason: "understanding_unavailable", outcome: understanding.failure?.kind ?? "unknown" },
      reply: { language: language.code, basis: language.basis, fallback: "understanding unavailable -> deterministic" },
      effects: ledgerForTrace(readLedger(state).slice(startSeq)),
      missingFields: state.missingFields,
      ...(grounded.cart ? { context: { shown: (grounded.shownResults ?? []).map((p) => ({ position: p.position, title: p.title })), cart: { lines: grounded.cart, total: grounded.cartTotal ?? null } } } : {}),
    },
  };
  state.turns.push(turn);
  await store.save(state);
  return { state, turn, response };
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
      grounded.cartLines = cart.lines.map((line, index) => ({ position: index + 1, id: line.id, title: line.title, options: line.options, quantity: line.quantity }));
      grounded.cart = grounded.cartLines.map(({ id: _id, ...line }) => {
        void _id;
        return line;
      });
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

/**
 * Revision continuation: the same customer message, re-understood with the request being replaced made
 * explicit. Only a capability proposal is taken from it (the replacement request); everything else in
 * the first understanding stands.
 */
async function proposeReplacement(
  reasoner: Reasoner,
  graph: BusinessGraph,
  state: ConversationState,
  message: string,
  grounded: GroundedContext,
  replacing: ApprovalRecord[]
): Promise<CompileOutcome | undefined> {
  const context: GroundedContext = { ...grounded, replacingRequests: ownerRequestViews(replacing, state) };
  const u = await understandTurn(reasoner, { graph, state, customerMessage: message, grounded: context });
  if (!u.valid || u.failClosed) return undefined;
  const { verified } = verifyIR(graph, message, { ...u.ir, customerInfo: {}, evidence: {} }, state, { capabilities: context.capabilities, capabilityResults: context.capabilityResults });
  if (!verified.capabilityRequest) return undefined;
  const planned = planCapabilityCall(verified.capabilityRequest, state.stage);
  return planned?.kind === "action" ? planned : undefined;
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
  /** When approval was required and the same request already existed (nothing new was sent). */
  existing?: ExistingRequest["state"];
  /** The final-write gate stopped this write (scope, cap, unknown shipping) — nothing was proposed or executed. */
  blocked?: WriteBlock;
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
  profiles: CapabilityProfiles | undefined,
  cartBefore?: CartLineSnapshot[]
): Promise<ExecutedStep> {
  const before = { ...state.knownFields };
  const stageBefore = state.stage;
  // The final-write gate runs BEFORE approval creation or execution: scope, cart revision and hard cap
  // are re-derived now and must match the customer's current consent — no model signal overrides it.
  const blocked = await finalWriteGate(graph, state, outcome.action.name, outcome.action.input, ctx);
  const { policyDecision, toolResult, existing, requestId } = blocked
    ? { policyDecision: { status: "denied" as const, reason: `final-write gate: ${blocked.reason}` }, toolResult: null, existing: undefined, requestId: undefined }
    : await authorizeAndExecute(graph, state, outcome, ctx, restoreStage);
  if (blocked) {
    state.stage = restoreStage;
    appendLedger(state, { ...classifyBlocked(outcome.action.name, outcome.action.input), outcome: { reason: blocked.reason, ...(blocked.total !== undefined ? { total: blocked.total } : {}), ...(blocked.cap !== undefined ? { cap: blocked.cap } : {}) } });
  }
  // The domain effect of this step, frozen in the ledger — transport success is never recorded as a business effect.
  if (toolResult) appendLedger(state, classifyExecution(outcome.action.name, outcome.action.input, toolResult, cartBefore));
  else if (requestId) appendLedger(state, requestEntry(outcome.action.name, outcome.action.input, requestId, "awaiting_owner"));
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
    ...(existing ? { existing } : {}),
    ...(blocked ? { blocked } : {}),
    trace: {
      trigger,
      action: outcome.action.name,
      ...(existing ? { ownerRequest: existing } : policyDecision.status === "requires_approval" ? { ownerRequest: "requested" as const } : {}),
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
  // The composer and every check see the ledger as it stands after this turn's steps, the current
  // owner requests, and the one authoritative quote.
  rctx.grounded = { ...(rctx.grounded ?? {}), ledger: readLedger(rctx.state), ownerRequests: ownerRequestViews(await conversationApprovals(graph.business.id, rctx.state.id), rctx.state) };
  // The quote follows the offer the customer is asking about NOW (not a stale earlier one).
  const quote = currentQuote(graph, { ...rctx.state, selectedOfferId: rctx.state.knownFields.__focusOfferId || rctx.state.selectedOfferId });
  // A write the final-write gate stopped is told exactly, from records: what really happened before it
  // this turn, and why this one was not created. A model is never asked to narrate around a blocked
  // write (live, it narrated an unexecuted add as done).
  const blockedStep = steps.find((st) => st.blocked);
  if (blockedStep) {
    const before = steps.slice(0, steps.indexOf(blockedStep));
    input = {
      outcome,
      toolResult: null,
      writeBlocked: blockedStep.blocked,
      language,
      quote,
      ...(before.length ? { steps: before.map((st) => ({ outcome: st.outcome, toolResult: st.toolResult, existingOwnerRequest: st.existing })) } : {}),
    };
    return { text: composeDeterministic(input), fallback: "write blocked -> deterministic" };
  }
  if (steps.length <= 1 && !next) {
    if (last?.policyDecision.status === "denied") {
      // The rule's text stays in the trace; the customer hears what it means for them.
      input = { outcome, toolResult: null, refused: true, language, quote };
      return await guardReply(reasoner, rctx, input, await reasoner.composeResponse(rctx, input));
    }
    if (last?.policyDecision.status === "requires_approval") {
      input = last.existing
        ? { outcome, toolResult: null, existingOwnerRequest: last.existing, language, quote }
        : { outcome, toolResult: null, policyReason: last.policyDecision.reason, language, quote };
      return await guardReply(reasoner, rctx, input, await reasoner.composeResponse(rctx, input));
    }
    input = sanitizeComposeInput({ outcome, toolResult: last?.toolResult ?? null, scheduling: buildSchedulingDisplay(graph, outcome, last?.toolResult ?? null, message, language), language, quote });
  } else {
    input = sanitizeComposeInput({
      outcome,
      toolResult: last?.toolResult ?? null,
      policyReason: last?.policyDecision.status === "requires_approval" && !last.existing ? last.policyDecision.reason : undefined,
      ...(last?.existing ? { existingOwnerRequest: last.existing } : {}),
      ...(last?.blocked ? { writeBlocked: last.blocked } : {}),
      scheduling: buildSchedulingDisplay(graph, outcome, last?.toolResult ?? null, message, language),
      steps: steps.map((st) => ({
        outcome: st.outcome,
        toolResult: st.toolResult,
        policyReason: st.policyDecision.status === "requires_approval" && !st.existing ? st.policyDecision.reason : undefined,
        refused: st.policyDecision.status === "denied" ? true : undefined,
        existingOwnerRequest: st.existing,
      })),
      next,
      language,
      quote,
    });
  }
  if (outcome.kind === "conversation" && rctx.grounded?.ownerRequests?.length) input = { ...input, ownerRequests: rctx.grounded.ownerRequests };
  if (rctx.grounded?.revisionWithoutReplacement) input = { ...input, revisionWithoutReplacement: true };
  const guarded = await guardReply(reasoner, rctx, input, await reasoner.composeResponse(rctx, input));
  if (guarded.fallback) return guarded;
  const text = guarded.text;
  // The details BARRY asks for are the compiler's truth. A reply that asks
  // for anything else (or something stricter, or drops one) is replaced by
  // the localized deterministic request — correct, just plainer.
  const fields = infoRequestFields(next ?? outcome);
  if (fields && reasoner.name === "llm") {
    const violation = checkInfoRequest(text, fields, language.code);
    if (violation) {
      // A reply that answered the customer but left out the question keeps its answer: the exact
      // request is added after it. Anything else (asking for the wrong thing) is replaced.
      if (violation.reason.startsWith("does not ask")) {
        const combined = `${text} ${composeDeterministic({ outcome: next ?? outcome, language })}`;
        if (!checkInfoRequest(combined, fields, language.code)) return { text: combined, fallback: `missing-field contract: ${violation.reason} (request appended)` };
      }
      return { text: composeDeterministic(input), fallback: `missing-field contract: ${violation.reason}` };
    }
  }
  return { text };
}

/**
 * Reply hygiene: a customer never sees BARRY's machinery. A model-written reply that names an
 * internal identifier (a capability id, an action/tool name, an authority or policy rule id, a raw
 * enum value from this turn's system results) or quotes the rule text behind an approval/refusal is
 * replaced by the deterministic reply — plainer, but clean — and the swap is recorded in the trace.
 */
/**
 * Every model-written reply is checked against BARRY's records before it can reach the customer:
 * internal leaks, effect/owner/amount/measurement claims (evidence = the effect ledger and facts),
 * receipt identity, and the reply language. A failing draft is REGENERATED as a whole from the
 * trusted facts (the composer is told exactly what it can't support, so dependent conclusions go
 * with it); if the regenerated reply still fails, the deterministic reply renders the real state.
 */
async function guardReply(
  reasoner: ReturnType<typeof getReasoner>,
  rctx: ReasonerContext,
  input: ComposeResponseInput,
  text: string
): Promise<{ text: string; fallback?: string }> {
  if (reasoner.name !== "llm") return { text };
  const problems = replyProblems(rctx, input, text);
  if (problems.length === 0) return { text: trimClosers(text) };
  let repaired: string | undefined;
  try {
    repaired = await reasoner.composeResponse(rctx, { ...input, repair: { draft: text, problems } });
  } catch {
    repaired = undefined;
  }
  if (repaired && replyProblems(rctx, input, repaired).length === 0) return { text: trimClosers(repaired), fallback: `${problems.join("; ")} -> regenerated` };
  return { text: composeDeterministic(withStatus(rctx, input)), fallback: `${problems.join("; ")} -> deterministic` };
}

function replyProblems(rctx: ReasonerContext, input: ComposeResponseInput, text: string): string[] {
  const problems: string[] = [];
  const leak = findInternalLeak(text, internalVocabulary(rctx, input, listTools().map((t) => t.name)));
  if (leak) problems.push(`reply hygiene: ${leak}`);
  const ledger = rctx.grounded?.ledger ?? readLedger(rctx.state);
  const bad = [
    ...findUnsupportedClaims(text, claimEvidence(rctx, input, ledger, rctx.grounded?.turnStartSeq ?? 0)),
    ...findMisattributedReferences(text, rctx.grounded?.ownerRequests ?? []),
  ];
  if (bad.length) problems.push(`claim grounding: ${[...new Set(bad.map((b) => b.why))].join("; ")}`);
  const lang = languageMismatch(text, input.language?.code);
  if (lang) problems.push(`language: ${lang}`);
  return problems;
}

/** The input with the deterministic state rendering attached (requests, booking, payment, quote). */
function withStatus(rctx: ReasonerContext, input: ComposeResponseInput): ComposeResponseInput {
  const ledger = rctx.grounded?.ledger ?? readLedger(rctx.state);
  return { ...input, statusText: renderStatus({ requests: rctx.grounded?.ownerRequests ?? [], ledger, quote: input.quote, lang: input.language?.code ?? "en" }) };
}

function ledgerForTrace(entries: LedgerEntry[]): NonNullable<TurnTrace["effects"]> {
  return entries.map((e) => ({ seq: e.seq, operation: e.operation, effect: e.effect, status: e.status, terms: e.terms, ...(e.reference ? { reference: e.reference } : {}), ...(e.requestId ? { requestId: e.requestId } : {}) }));
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
): Promise<{ policyDecision: PolicyDecision; toolResult: ToolCallResult | null; existing?: ExistingRequest["state"]; requestId?: string }> {
  const policyDecision = decide(graph, { action: outcome.action.name, params: outcome.action.input });
  if (policyDecision.status === "denied") {
    state.stage = prevStage;
    return { policyDecision, toolResult: null };
  }
  if (policyDecision.status === "requires_approval") {
    // One live request per (conversation, operation, terms): a status question or a repeated ask
    // reuses the one still waiting; terms the owner already declined are not re-sent.
    const same = findSameRequest(await conversationApprovals(graph.business.id, ctx.conversationId), outcome.action.name, outcome.action.input);
    if (same) {
      if (same.state === "still_pending") {
        // A validly understood turn re-proposed exactly these terms: the customer's intent is current again.
        recordReconfirmed(state, same.approval);
        state.knownFields.__reusedApprovalThisTurn = same.approval.id;
        state.pendingApprovalId = same.approval.id;
        state.pendingAction = outcome.action;
        state.stage = "escalated";
      } else {
        state.stage = prevStage;
      }
      return { policyDecision, toolResult: null, existing: same.state };
    }
    // A new revision (e.g. a corrected quantity) supersedes the older one still waiting.
    await supersedeOlderRevisions(graph, state, outcome.action.name, outcome.action.input);
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
      return { policyDecision, toolResult: null, requestId: approvalId };
    }
    state.stage = prevStage;
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

/**
 * An approved request that is held because the customer's intent after it is unverified: nothing is
 * resolved or executed; the customer is asked (once) to confirm; the owner sees why.
 */
async function intentHeldTurn(state: ConversationState, approval: ApprovalRecord, hold: IntentHold): Promise<TurnOutcome> {
  const store = getConversationStore();
  const reasoner = getReasoner();
  const language = resolveReplyLanguage({
    customerMessages: state.messages.filter((m) => m.role === "customer").map((m) => m.content),
    stored: state.knownFields[SCRATCH_KEYS.conversationLanguage],
    businessLocale: undefined,
  });
  const response = intentHeldText(language.code, describeRequest(approval.requestedAction, approval.requestedInput), hold.detail);
  if (state.messages.at(-1)?.content !== response) state.messages.push({ role: "barry", content: response, at: new Date().toISOString() });
  const reason = hold.reason === "conflicting_reference" ? `the customer later wrote ${hold.detail}, which conflicts with this request's own reference` : "a later customer message could not be understood, so the customer's current intent is unverified";
  const turn: TurnLog = {
    id: turnId(),
    at: new Date().toISOString(),
    customerMessage: "(owner approval held)",
    understood: { intent: "approval_held", entities: { reason: hold.reason } },
    retrieved: { offerIds: [], knowledgeIds: [] },
    selectedAction: { name: approval.requestedAction, input: approval.requestedInput as Record<string, unknown> },
    response,
    stateAfter: { stage: state.stage, outcome: state.outcome },
    reasoner: reasoner.name,
    trace: {
      runtime: runtimeTrace(reasoner),
      rejectedClaims: [],
      steps: [],
      stop: { reason: "approval_held_customer_intent_unverified", outcome: approval.requestedAction },
      reply: { language: language.code, basis: language.basis },
      hold: { requestId: approval.id, reason },
      effects: [],
    },
  };
  state.turns.push(turn);
  await store.save(state);
  return { state, turn, response };
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
  const alreadyResolved = async (): Promise<TurnOutcome> => {
    const current = (await backend.getApproval(approvalId)) ?? existing;
    const store = getConversationStore();
    const state = await store.get(existing.conversationId);
    if (!state) throw new Error(`Conversation ${existing.conversationId} not found`);
    const response = `This request was already ${current.status} — nothing more to do here.`;
    return {
      state,
      turn: {
        id: turnId(),
        at: new Date().toISOString(),
        customerMessage: "(duplicate owner approval resolution)",
        understood: { intent: "approval_already_resolved", entities: { decision: current.status } },
        retrieved: { offerIds: [], knowledgeIds: [] },
        response,
        stateAfter: { stage: state.stage },
        reasoner: getReasoner().name,
      },
      response,
    };
  };
  if (existing.status !== "pending") return alreadyResolved();

  // The owner's approval is not the customer's consent: before anything executes, the request is
  // revalidated against what the customer said AFTER it was made. If that intent is unverified, the
  // request is held — not resolved, not executed — and the customer is asked to confirm.
  if (decision === "approved") {
    const convo = await getConversationStore().get(existing.conversationId);
    const hold = convo ? customerIntentHold(convo, existing) : undefined;
    if (convo && hold) return intentHeldTurn(convo, existing, hold);
  }

  // Compare-and-set in the backend: a concurrent or stale resolution loses here and executes nothing.
  let approval: ApprovalRecord;
  try {
    approval = await backend.resolveApproval(approvalId, decision, decidedBy, alternateValue);
  } catch (err) {
    if (err instanceof ApprovalAlreadyResolvedError) return alreadyResolved();
    throw err;
  }

  const store = getConversationStore();
  const state = await store.get(approval.conversationId);
  if (!state) throw new Error(`Conversation ${approval.conversationId} not found`);

  const ctx: ToolContext = { graph, conversationId: approval.conversationId, customerId: approval.customerId };
  const reasoner = getReasoner();

  let toolResult: ToolCallResult | null = null;
  let response: string;
  let approvalStep: TurnStep | undefined;
  let resumeFallback: string | undefined;
  // The customer hears back in the conversation's own language, and BARRY is no longer waiting on the owner.
  const language = resolveReplyLanguage({
    customerMessages: state.messages.filter((m) => m.role === "customer").map((m) => m.content),
    stored: state.knownFields[SCRATCH_KEYS.conversationLanguage],
    businessLocale: graph.business.locale,
  });
  state.pendingApprovalId = null;
  state.pendingAction = null;
  const resumeCtx: ReasonerContext = { graph, state, customerMessage: "(approval resumed)", grounded: { turnStartSeq: readLedger(state).length } };
  const refreshOwnerRequests = async () => {
    resumeCtx.grounded!.ownerRequests = ownerRequestViews(await conversationApprovals(graph.business.id, state.id), state);
    resumeCtx.grounded!.ledger = readLedger(state);
  };

  // An owner's approval is not the customer's consent: the final-write gate re-checks scope, cart
  // revision and hard cap NOW, against the customer's current constraints, before anything executes.
  const resumeBlock =
    decision === "approved" ? await finalWriteGate(graph, state, approval.requestedAction, (alternateValue ?? approval.requestedInput) as Record<string, unknown>, ctx) : undefined;

  if (decision === "declined") {
    appendLedger(state, requestEntry(approval.requestedAction, approval.requestedInput, approvalId, "owner_declined"));
    await refreshOwnerRequests();
    const declinedOutcome: CompileOutcome = { kind: "action", action: { name: approval.requestedAction, input: {} }, stage: state.stage };
    const declinedInput: ComposeResponseInput = { outcome: declinedOutcome, toolResult: null, ownerDecision: "declined", language };
    const guarded = await guardReply(reasoner, resumeCtx, declinedInput, await reasoner.composeResponse(resumeCtx, declinedInput));
    response = guarded.text;
    resumeFallback = guarded.fallback;
  } else if (resumeBlock) {
    appendLedger(state, { ...classifyBlocked(approval.requestedAction, approval.requestedInput), requestId: approvalId, outcome: { reason: resumeBlock.reason, ...(resumeBlock.total !== undefined ? { total: resumeBlock.total } : {}), ...(resumeBlock.cap !== undefined ? { cap: resumeBlock.cap } : {}) } });
    recordOwnerRequestResult(state, approvalId, { result: "failed" });
    await refreshOwnerRequests();
    const blockedOutcome: CompileOutcome = { kind: "action", action: { name: approval.requestedAction, input: {} }, stage: state.stage };
    const blockedInput: ComposeResponseInput = { outcome: blockedOutcome, toolResult: null, writeBlocked: resumeBlock, language };
    const guarded = await guardReply(reasoner, resumeCtx, blockedInput, await reasoner.composeResponse(resumeCtx, blockedInput));
    response = guarded.text;
    resumeFallback = guarded.fallback;
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
    // What really happened, kept for later turns ("any news?") — approval alone is not execution,
    // and execution of a write is not confirmation unless the system confirmed it.
    // The executed effect is frozen with THIS request's id, terms and reference — later turns can't re-attribute it.
    const effect = appendLedger(state, { ...classifyExecution(approval.requestedAction, input, toolResult), requestId: approvalId });
    recordOwnerRequestResult(state, approvalId, {
      result: effect.status === "effected" ? "done" : effect.status === "effected_unconfirmed" ? "done_unconfirmed" : "failed",
      ...(effect.reference ? { reference: effect.reference } : {}),
    });
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
    await refreshOwnerRequests();
    // The reply describes exactly the approved operation's receipt — never anything else the customer asked for.
    const approvedInput = sanitizeComposeInput({ outcome: syntheticOutcome, toolResult, scheduling, ownerDecision: "approved", language });
    const guarded = await guardReply(reasoner, resumeCtx, approvedInput, await reasoner.composeResponse(resumeCtx, approvedInput));
    response = guarded.text;
    resumeFallback = guarded.fallback;
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
            reply: { language: language.code, basis: language.basis, ...(resumeFallback ? { fallback: resumeFallback } : {}) },
            effects: ledgerForTrace(readLedger(state).slice(resumeCtx.grounded?.turnStartSeq ?? 0)),
          },
        }
      : {}),
  };
  state.turns.push(turn);

  await store.save(state);
  return { state, turn, response };
}
