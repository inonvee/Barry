import type { BusinessGraph, Goal, Offer } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { getTool } from "@/lib/tools";
import type { BarryIR, CompileDebugInfo, CompileOutcome, OfferFact } from "@/lib/reasoner/ir";
import { normalizeCustomerInfoField } from "@/lib/reasoner/customer-fields";
import type { ConversationStage, ConversationState } from "@/lib/state";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";
import { actionSupported, type CapabilityProfiles } from "@/lib/capabilities/model";
import { getCapability } from "@/lib/fabric/capability";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import type { GroundedContext } from "@/lib/reasoner/types";
import { paymentTermsFromQuote, quoteOffer } from "./pricing";

export type { CompileOutcome, CompileDebugInfo } from "@/lib/reasoner/ir";

/**
 * Internal scratch keys BARRY threads through ConversationState.knownFields
 * between turns. Never shown to the customer. Owned by the compiler — this
 * is the ONE place that reads and writes them; no reasoner (mock or LLM)
 * touches them directly.
 */
export const SCRATCH_KEYS = {
  offeredStart: "__offeredSlotStart",
  offeredEnd: "__offeredSlotEnd",
  offeredResource: "__offeredSlotResource",
  paymentRequestId: "__paymentRequestId",
  paid: "__paid",
  discountPct: "__discountPct",
  mentionedEarliest: "__mentionedEarliest",
  mentionedLatest: "__mentionedLatest",
  mentionedPartySize: "__mentionedPartySize",
  slotAccepted: "__slotAccepted",
  inventoryChecked: "__inventoryChecked",
  /** Units the customer wants of the offer under discussion (latest correction wins). */
  quantity: "__quantity",
  /** The customer's hard spending cap: {amount, currency?, includesShipping} — enforced at every payment write. */
  budgetCap: "__budgetCap",
  /** Exactly which cart lines the customer consented to check out (line ids) — "all" when they meant the whole cart. */
  checkoutScope: "__checkoutScope",
  lastSchedulingDate: "__lastSchedulingDate",
  /** The last time-of-day the customer set ("after 3", "morning") — kept when a later turn only names a day. */
  lastSchedulingTime: "__lastSchedulingTime",
  /** The customer's window has an explicit end: a slot must END by it, not just start before it. */
  windowEndIsHard: "__windowEndIsHard",
  commerceLastProductIds: "__commerceLastProductIds",
  commercePendingProductId: "__commercePendingProductId",
  commercePendingReplaceLineId: "__commercePendingReplaceLineId",
  commerceCartId: "__commerceCartId",
  commerceCartLineId: "__commerceCartLineId",
  commerceCartTotal: "__commerceCartTotal",
  commerceCheckoutId: "__commerceCheckoutId",
  commerceCartSnapshot: "__commerceCartSnapshot",
  commerceOrderId: "__commerceOrderId",
  /** The customer decided to buy (or asked to check out): BARRY carries the cart forward to checkout. */
  commerceCheckoutRequested: "__commerceCheckoutRequested",
  /**
   * The customer decided to buy what they're choosing THIS turn. Only an
   * intent: it becomes checkout eligibility (commerceCheckoutRequested)
   * solely when the requested cart mutation verifiably succeeds.
   */
  commerceCheckoutOnSuccess: "__commerceCheckoutOnSuccess",
  /** The customer decided to buy the selected offer (consent to send a payment link). */
  purchaseDecided: "__purchaseDecided",
  /** The language this conversation is held in (from the latest customer message with words). */
  conversationLanguage: "__conversationLanguage",
  /** Recent results of generic capability calls (JSON), for the next reasoning step. */
  capabilityResults: "__capabilityResults",
};

/**
 * Grounds commerce semantics against what BARRY actually showed/holds.
 * The model says "the first one"; the ids come ONLY from persisted state
 * written by real tool results. Never trusts a product/line id from IR.
 */
/**
 * Which shown product does the customer mean? DETERMINISTIC grounding of a
 * reference the model already understood — never language interpretation:
 *  - an explicit position the model gave -> that result, if it exists;
 *  - an explicit position that grounding rejected -> nothing (ask, never guess);
 *  - no position ("it", "that one", "I'll take it"): the item BARRY is
 *    currently waiting on (a pending variant choice), else the ONLY shown
 *    result when exactly one was shown; with several, nothing (ask).
 */
function resolveShownProduct(commerce: NonNullable<BarryIR["commerce"]>, known: Record<string, string>): string | undefined {
  const lastIds = known[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
  if (commerce.referenceInvalid) return undefined;
  if (commerce.reference?.type === "previous_result") return lastIds[commerce.reference.index];
  const pending = known[SCRATCH_KEYS.commercePendingProductId];
  if (pending) return pending;
  return lastIds.length === 1 ? lastIds[0] : undefined;
}

function compileCommerce(ir: BarryIR, known: Record<string, string>, options: CompileOptions = {}): CompileOutcome | undefined {
  const commerce = ir.commerce!;
  const lastIds = known[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
  const cartId = known[SCRATCH_KEYS.commerceCartId];
  const lineId = known[SCRATCH_KEYS.commerceCartLineId];

  switch (commerce.intent) {
    case "search":
      return finalizeAction(
        "searchProducts",
        {
          text: commerce.query?.text,
          category: commerce.query?.category,
          attributes: commerce.query?.attributes,
          options: commerce.variant,
          budgetAmount: commerce.query?.budget?.amount,
          currency: commerce.query?.budget?.currency,
        },
        "discovery",
        "completePurchase"
      );

    case "select": {
      const productId = resolveShownProduct(commerce, known);
      if (!productId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      // Completing a swap that was waiting on a variant choice.
      const pendingReplace =
        !commerce.reference && productId === known[SCRATCH_KEYS.commercePendingProductId] ? known[SCRATCH_KEYS.commercePendingReplaceLineId] : undefined;
      return finalizeAction(
        "addToCart",
        {
          productId,
          options: commerce.variant,
          quantity: commerce.quantity ?? 1,
          ...(pendingReplace && cartId ? { replaceLine: { cartId, lineId: pendingReplace } } : {}),
        },
        "offer_selection",
        "completePurchase"
      );
    }

    case "inquire": {
      // A question about a shown product is answered from the provider's
      // real data re-read this turn — never from the model's belief.
      const productId = resolveShownProduct(commerce, known);
      const product = productId ? options.shownProducts?.find((p) => p.id === productId) : undefined;
      if (!product) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      return { kind: "product_info", productTitle: product.title, variants: product.variants, asked: commerce.variant, stage: "offer_selection" };
    }

    case "replace": {
      // Without an item in the cart there is nothing to replace: it is a plain selection.
      if (!cartId || !lineId) return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select" } }, known, options);
      const productId = !commerce.referenceInvalid && commerce.reference?.type === "previous_result" ? lastIds[commerce.reference.index] : undefined;
      if (!productId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      return finalizeAction(
        "addToCart",
        { productId, options: commerce.variant, quantity: commerce.quantity ?? 1, replaceLine: { cartId, lineId } },
        "offer_selection",
        "completePurchase"
      );
    }

    case "change_variant":
    case "change_quantity":
    case "remove": {
      const targetLine = resolveCartLine(commerce, known, options);
      // BARRY just asked which option the customer wants for a pending
      // item; an option named without pointing at a cart line answers it.
      if (commerce.intent === "change_variant" && known[SCRATCH_KEYS.commercePendingProductId] && commerce.reference?.type !== "cart_line") {
        return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select", reference: undefined } }, known, options);
      }
      if (!cartId || !targetLine) {
        // Nothing in the cart yet: a variant choice completes a pending selection.
        const cartEmpty = !cartId || (options.cartLines ? options.cartLines.length === 0 : !lineId);
        if (cartEmpty && commerce.intent === "change_variant" && (known[SCRATCH_KEYS.commercePendingProductId] || lastIds.length === 1)) {
          return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select", reference: undefined } }, known, options);
        }
        return { kind: "clarify_reference", available: options.cartLines?.length ?? lastIds.length, stage: "offer_selection" };
      }
      return finalizeAction(
        "updateCartLine",
        {
          cartId,
          lineId: targetLine,
          options: commerce.intent === "change_variant" ? commerce.variant : undefined,
          quantity: commerce.intent === "remove" ? 0 : commerce.quantity,
        },
        "offer_selection",
        "completePurchase"
      );
    }

    case "checkout":
      if (!cartId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      // The request is recorded in compileCore; the goal planner decides what checkout still needs.
      return undefined;

    case "negotiate_price": {
      const total = known[SCRATCH_KEYS.commerceCartTotal] ? (JSON.parse(known[SCRATCH_KEYS.commerceCartTotal]) as { amount: number; currency: string }) : undefined;
      if (!commerce.requestedPrice) return undefined;
      return { kind: "price_request", requested: commerce.requestedPrice, current: total, stage: "offer_selection" };
    }
  }
}

/**
 * STATE-DRIVEN commerce goal planner: once the customer has decided to
 * buy (or asked to check out), the next safe step toward completePurchase
 * is derived from real state alone — never from new customer words — so
 * the runtime can run it as a continuation. It stops at anything that
 * needs a human: missing customer details, or a provider that can't do it.
 */
function planCommerceGoal(graph: BusinessGraph, known: Record<string, string>, options: CompileOptions): CompileOutcome | undefined {
  const cartId = known[SCRATCH_KEYS.commerceCartId];
  if (!cartId || !known[SCRATCH_KEYS.commerceCheckoutRequested]) return undefined;
  if (known[SCRATCH_KEYS.paymentRequestId] || known[SCRATCH_KEYS.paid] || known[SCRATCH_KEYS.commerceOrderId]) return undefined;

  const missingFields = graph.playbook.commerce.checkoutRequires.filter((field) => !known[field]);
  if (missingFields.length > 0) return { kind: "checkout_needs_info", missingFields, stage: "info_gathering" };

  const supported = actionSupported(options.profiles, "createCommerceCheckout");
  if (!supported.ok) return { kind: "capability_unavailable", action: "createCommerceCheckout", missing: supported.missing, stage: "offer_selection" };

  const total = known[SCRATCH_KEYS.commerceCartTotal] ? (JSON.parse(known[SCRATCH_KEYS.commerceCartTotal]) as { amount: number; currency: string }) : undefined;
  return finalizeAction(
    "createCommerceCheckout",
    // expectedTotal lets policy judge the real amount; the tool refuses if the provider's total differs.
    { cartId, ...(total ? { expectedTotal: total, amount: total.amount } : {}) },
    "payment",
    "completePurchase"
  );
}

/** One generic capability call as an action — or what the customer still needs to provide for it. */
export function planCapabilityCall(request: NonNullable<BarryIR["capabilityRequest"]>, stage: ConversationStage): CompileOutcome | undefined {
  const contract = getCapability(request.capability);
  if (!contract) return undefined;
  const { idempotencyKey: _k, ...semantic } = request.input;
  void _k;
  const probe = contract.idempotency === "key_required" ? { ...semantic, idempotencyKey: "probe-key-00000000" } : semantic;
  const parsed = contract.input.safeParse(probe);
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.filter((i) => i.path.length > 0 && semantic[String(i.path[0])] === undefined).map((i) => String(i.path[0])))];
    if (missing.length > 0) return { kind: "capability_needs_input", capability: request.capability, missingFields: missing, stage };
    return { kind: "compiler_error", reason: `The ${request.capability} request does not fit its contract`, stage };
  }
  return finalizeAction(INVOKE_CAPABILITY, { capability: request.capability, input: semantic, purpose: request.purpose.slice(0, 300) }, stage);
}


/** Validate a deterministically-assembled input against the tool's real Zod schema before it can ever become an "action" outcome. */
function finalizeAction(
  name: string,
  input: Record<string, unknown>,
  stage: ConversationStage,
  goal?: Goal
): CompileOutcome {
  const tool = getTool(name);
  if (!tool) {
    return { kind: "compiler_error", reason: `Unknown tool "${name}"`, stage };
  }
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    console.error("[barry:compiler] assembled input failed schema validation", {
      tool: name,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
    });
    return { kind: "compiler_error", reason: `Could not assemble a complete "${name}" call yet`, stage };
  }
  // Return the original assembled input, not the Zod-stripped `parsed.data`
  // — some fields (discountPct, isCustomPrice) are policy-relevant metadata
  // the tool's own schema doesn't declare but decide() still needs to see.
  // `callTool()` re-validates against the tool schema at execution time
  // regardless, so this loses no safety.
  return { kind: "action", action: { name, input }, stage, goal };
}

/** The read an offer supports (open times for bookable services, stock for stocked goods) — never a write. */
function plannedRead(offer: Offer, known: Record<string, string>, stage: ConversationStage): CompileOutcome | undefined {
  if (offer.requiresScheduling) {
    const earliest = known[SCRATCH_KEYS.mentionedEarliest];
    if (!earliest) return { kind: "ask_datetime", offerName: offer.name, stage };
    return finalizeAction(
      "checkAvailability",
      { offerId: offer.id, earliest, latest: known[SCRATCH_KEYS.mentionedLatest], partySize: Number(known[SCRATCH_KEYS.mentionedPartySize] ?? 1), ...(known[SCRATCH_KEYS.windowEndIsHard] ? { endBy: known[SCRATCH_KEYS.mentionedLatest] } : {}) },
      stage
    );
  }
  if (offer.requiresInventory) return finalizeAction("checkInventory", { offerId: offer.id, quantity: Number(known[SCRATCH_KEYS.quantity] ?? 1) }, stage);
  return undefined;
}

function missingCustomerInfo(offer: Offer, known: Record<string, string>): string[] {
  return offer.requiredCustomerInfo.filter((field) => !known[field]);
}

/**
 * Answers a small, recognized set of fact questions straight from the
 * resolved Offer — never invented, never requiring any transaction-gate
 * field first. `requestedCapability` is advisory (a reasoner's best guess
 * at intent); an unrecognized value or a fact the offer doesn't have
 * (e.g. price on a quote-only offer) simply returns nothing, and the
 * normal flow continues.
 */
function resolveOfferFact(requestedCapability: string | undefined, offer: Offer): OfferFact | undefined {
  switch (requestedCapability) {
    case "ask_price":
      return offer.price !== null ? { type: "price", price: offer.price, currency: offer.currency } : undefined;
    case "ask_duration":
      return offer.durationMinutes !== undefined ? { type: "duration", minutes: offer.durationMinutes } : undefined;
    case "ask_deposit":
      return {
        type: "deposit",
        required: offer.requiresPayment,
        amount: offer.depositAmount,
        currency: offer.currency,
      };
    default:
      return undefined;
  }
}

function resolveOfferId(graph: BusinessGraph, state: ConversationState, ir: BarryIR): string | undefined {
  // The CURRENT task wins over stale context: when the customer names another offer and nothing is
  // committed on the old one (no link, slot, decision or pending request), the named offer is the subject.
  const k = state.knownFields;
  const committed = Boolean(k[SCRATCH_KEYS.paymentRequestId] || k[SCRATCH_KEYS.offeredStart] || k[SCRATCH_KEYS.purchaseDecided] || state.pendingApprovalId);
  if (ir.selectedOfferId && ir.selectedOfferId !== state.selectedOfferId && findOffer(graph, ir.selectedOfferId) && !committed) {
    delete k[SCRATCH_KEYS.inventoryChecked];
    return ir.selectedOfferId;
  }
  // Sticky: once an offer is chosen for this conversation, new candidate
  // guesses from later turns never override it.
  if (state.selectedOfferId && findOffer(graph, state.selectedOfferId)) {
    return state.selectedOfferId;
  }

  if (ir.selectedOfferId && findOffer(graph, ir.selectedOfferId)) {
    return ir.selectedOfferId;
  }

  return undefined;
}

/**
 * The deterministic Action Compiler. Takes BARRY IR (what the customer
 * seems to want, per whichever Reasoner produced it) plus the accumulated
 * ConversationState plus the Business Graph, and decides what BARRY does
 * next. Never performs I/O. Never trusts IR enough to skip validating a
 * compiled tool input against the tool's own schema.
 *
 * Thin wrapper so every return point inside `compileCore` stays a plain
 * `CompileOutcome` (existing tests destructure `outcome.kind` etc. and
 * must keep working) while still attaching debug/observability info
 * uniformly at the one exit point, instead of touching every return.
 */
export type CompileOptions = {
  /** What the business's connected providers can actually do (planning never promises what they can't). */
  profiles?: CapabilityProfiles;
  /** What BARRY last showed, re-read from the provider this turn (real ids, real stock). */
  shownProducts?: ShownProduct[];
  /** The cart's lines as the provider holds them now, with real ids, in the order shown to the customer. */
  cartLines?: NonNullable<GroundedContext["cartLines"]>;
};

/**
 * The exact cart line a mutation targets: the line the customer's reference grounds to — by its
 * position in the REAL cart — or the only line when there is exactly one. Several lines and no
 * reference: nothing is guessed (the customer is asked). Never "the last line BARRY touched".
 */
function resolveCartLine(commerce: NonNullable<BarryIR["commerce"]>, known: Record<string, string>, options: CompileOptions): string | undefined {
  const lines = options.cartLines;
  if (!lines) return known[SCRATCH_KEYS.commerceCartLineId];
  if (commerce.referenceInvalid) return undefined;
  if (commerce.reference?.type === "cart_line") return lines[commerce.reference.index]?.id;
  return lines.length === 1 ? lines[0].id : undefined;
}

type ShownProduct = NonNullable<GroundedContext["shownProducts"]>[number];

export function compile(graph: BusinessGraph, state: ConversationState, ir: BarryIR, options: CompileOptions = {}): CompileOutcome {
  const debug: CompileDebugInfo = { appliedCustomerInfo: {} };
  const outcome = compileCore(graph, state, ir, debug, options);
  return { ...outcome, debug };
}

function compileCore(graph: BusinessGraph, state: ConversationState, ir: BarryIR, debug: CompileDebugInfo, options: CompileOptions): CompileOutcome {
  const known = state.knownFields;
  const scratchUpdate: Record<string, string> = {};
  // The ONLY place a semantic scheduling constraint ("Sunday", "at 2pm")
  // becomes an absolute timestamp — using the business's own timezone,
  // never the server's or a hardcoded one. Neither Reasoner is ever asked
  // to compute this itself.
  if (ir.constraints.schedulingWindow) {
    let window = ir.constraints.schedulingWindow;
    // A TIME-ONLY constraint (e.g. "actually 5pm instead" — a correction
    // that never re-states the day) must not silently reset the day to
    // today when a day was already established earlier in this same
    // conversation. Carry the last EXPLICIT date forward only when this
    // turn's constraint supplied none itself; a turn that does name a
    // date always wins outright and becomes the new carryover value.
    if (!window.date && state.knownFields[SCRATCH_KEYS.lastSchedulingDate]) {
      const lastDate = JSON.parse(state.knownFields[SCRATCH_KEYS.lastSchedulingDate]);
      window = { ...window, date: lastDate };
    }
    // Symmetrically, a DAY-ONLY mention ("Friday", or a later turn restating the day) keeps the
    // time the customer already set — it never silently widens back to the whole day.
    if (!window.time && state.knownFields[SCRATCH_KEYS.lastSchedulingTime]) {
      const last = JSON.parse(state.knownFields[SCRATCH_KEYS.lastSchedulingTime]);
      // Stored as the whole time constraint (start, explicit end, exclusivity) — carried together.
      window = "kind" in last ? { ...window, time: last } : { ...window, ...last };
    }
    const resolved = resolveSchedulingWindow(window, graph.business.timezone);
    if (resolved) {
      if (
        known[SCRATCH_KEYS.offeredStart] &&
        known[SCRATCH_KEYS.offeredStart] !== resolved.earliest &&
        !ir.constraints.slotAccepted
      ) {
        delete known[SCRATCH_KEYS.offeredStart];
        delete known[SCRATCH_KEYS.offeredEnd];
        delete known[SCRATCH_KEYS.offeredResource];
        delete known[SCRATCH_KEYS.slotAccepted];
      }
      scratchUpdate[SCRATCH_KEYS.mentionedEarliest] = resolved.earliest;
      scratchUpdate[SCRATCH_KEYS.mentionedLatest] = resolved.latest;
      debug.resolvedSchedulingWindow = resolved;
    }
    if (window.date) {
      scratchUpdate[SCRATCH_KEYS.lastSchedulingDate] = JSON.stringify(window.date);
    }
    if (window.time) {
      scratchUpdate[SCRATCH_KEYS.lastSchedulingTime] = JSON.stringify({ time: window.time, ...(window.end ? { end: window.end } : {}), ...(window.startExclusive ? { startExclusive: true } : {}) });
    }
    if (resolved?.explicitEnd) scratchUpdate[SCRATCH_KEYS.windowEndIsHard] = "1";
    else if (resolved) scratchUpdate[SCRATCH_KEYS.windowEndIsHard] = "";
  }
  if (ir.constraints.partySize && ir.constraints.partySize > 1) {
    scratchUpdate[SCRATCH_KEYS.mentionedPartySize] = String(ir.constraints.partySize);
  } else if (ir.constraints.partySize === 1) {
    delete known[SCRATCH_KEYS.mentionedPartySize];
  }
  if (ir.constraints.discountPct) {
    scratchUpdate[SCRATCH_KEYS.discountPct] = String(ir.constraints.discountPct);
  }
  // A stated hard cap (or a search budget) binds every later payment write until the customer changes it.
  const cap = ir.constraints.budgetMax ?? ir.commerce?.query?.budget?.amount;
  if (cap && cap > 0) {
    scratchUpdate[SCRATCH_KEYS.budgetCap] = JSON.stringify({ amount: cap, includesShipping: ir.constraints.budgetIncludesShipping === true });
  }
  if (ir.constraints.quantity && Number.isInteger(ir.constraints.quantity) && ir.constraints.quantity > 0 && ir.constraints.quantity <= 1000) {
    scratchUpdate[SCRATCH_KEYS.quantity] = String(ir.constraints.quantity);
  }
  if (ir.constraints.slotAccepted) {
    scratchUpdate[SCRATCH_KEYS.slotAccepted] = "1";
  }
  if (ir.purchaseDecision === true) {
    scratchUpdate[SCRATCH_KEYS.purchaseDecided] = "1";
  }
  // `customerInfo` is THE single authoritative key/value bag for
  // customer-provided identity fields (name/email/phone/...) — a
  // reasoner controls the KEY NAMES, not just the values. `__`-prefixed
  // keys are the compiler's own scratch namespace (booking slots,
  // payment/approval state, discount %, ...); never let untrusted IR set
  // one directly, or a hallucinating/adversarial model could fabricate
  // e.g. `{ key: "__paid", value: "1" }` and have it treated as a
  // verified payment confirmation without the payment tool ever having
  // run. Only the runtime (patchStateAfterTool, webhook handlers) may
  // ever write a scratch key.
  //
  // Live bug: a strict-JSON-schema Reasoner sometimes literalizes a
  // sentinel string ("null", "undefined", ...) in place of actually
  // omitting a key/value pair it has nothing new to report for.
  // normalizeCustomerInfoField() rejects those (and empty/whitespace
  // values) BEFORE they ever reach persistent state — an empty/sentinel
  // value must never overwrite a real one already on file. This is the
  // ONE place ANY reasoner's customer-info values are trusted from, and
  // it runs BEFORE missingCustomerInfo() below computes what's still
  // missing — a value supplied this turn must count immediately.
  const appliedCustomerInfo: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(ir.customerInfo)) {
    if (key.startsWith("__")) continue;
    const value = normalizeCustomerInfoField(key, rawValue);
    if (value !== undefined) appliedCustomerInfo[key] = value;
  }
  debug.appliedCustomerInfo = appliedCustomerInfo;
  Object.assign(state.knownFields, scratchUpdate, appliedCustomerInfo);

  // The customer's CURRENT intent is authoritative over any transaction in progress. A withdrawal
  // clears every consent BARRY holds (the runtime also withdraws requests waiting on the owner);
  // a message that doesn't advance the transaction never runs the funnel (details, availability,
  // payment) — questions, status checks and recaps are answered, not converted into a next step.
  if (ir.withdrawsRequest) {
    for (const key of [
      SCRATCH_KEYS.purchaseDecided,
      SCRATCH_KEYS.commerceCheckoutRequested,
      SCRATCH_KEYS.commerceCheckoutOnSuccess,
      SCRATCH_KEYS.slotAccepted,
      SCRATCH_KEYS.offeredStart,
      SCRATCH_KEYS.offeredEnd,
      SCRATCH_KEYS.offeredResource,
      SCRATCH_KEYS.discountPct,
    ]) {
      delete known[key];
    }
    const somethingElse = ir.capabilityRequest || ir.knowledgeTopic || (ir.commerce && ir.commerce.intent !== "checkout") || ir.offerChangeRequested;
    if (!somethingElse) return { kind: "withdrawn", withdrawnRequests: 0, stage: state.stage === "closed" ? "closed" : "discovery" };
  }
  const advancing = ir.withdrawsRequest ? false : ir.advancesTransaction;
  // Checkout consent is its own signal: "don't check out" blocks every step toward payment this turn.
  const checkoutBlocked = ir.checkoutConsent === false;
  if (checkoutBlocked) {
    delete known[SCRATCH_KEYS.commerceCheckoutRequested];
    delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
  }

  if (state.stage === "closed") {
    return advancing === false ? { kind: "conversation", stage: "closed" } : { kind: "generic_confirm", stage: "closed" };
  }

  // A customer ASSERTING payment is a claim, never a fact. The only thing
  // BARRY does with it is ask the trusted provider (verifyPayment); paid
  // state can only come from that tool's result or a verified webhook.
  if (ir.customerClaims?.paymentCompleted && !known[SCRATCH_KEYS.paid]) {
    if (known[SCRATCH_KEYS.paymentRequestId]) {
      return finalizeAction("verifyPayment", { paymentRequestId: known[SCRATCH_KEYS.paymentRequestId] }, "payment");
    }
    return { kind: "no_payment_to_verify", stage: state.stage };
  }

  // Verified payment for a cart -> exactly one order, re-verified by the
  // tool against the payment's bound cart snapshot.
  if (known[SCRATCH_KEYS.paid] && known[SCRATCH_KEYS.commerceCartId] && !known[SCRATCH_KEYS.commerceOrderId] && known[SCRATCH_KEYS.paymentRequestId]) {
    return finalizeAction(
      "createCommerceOrder",
      { cartId: known[SCRATCH_KEYS.commerceCartId], paymentRequestId: known[SCRATCH_KEYS.paymentRequestId] },
      "confirmation",
      "completePurchase"
    );
  }

  // A proposal to use one of the business's own capabilities (already
  // grounded: on this business's surface, inputs stated by the customer or
  // known). The compiler only checks the contract's required inputs are
  // present — asking for what's missing, never guessing it. Authority and
  // system selection happen later, deterministically.
  if (ir.capabilityRequest) {
    const planned = planCapabilityCall(ir.capabilityRequest, state.stage);
    if (planned) return planned;
  }

  // Knowledge answers come verbatim from the business's own stored item
  // for the topic the model named — BARRY never paraphrases policy.
  // A message that both changes the cart and asks a question does BOTH: the mutation is executed
  // here, and the question is answered from the business's knowledge in the reply's facts.
  const mutatesCart = ir.commerce && ["select", "replace", "change_variant", "change_quantity", "remove", "checkout"].includes(ir.commerce.intent);
  if (ir.knowledgeTopic && !mutatesCart) {
    const item = graph.knowledge.find((k) => k.topic === ir.knowledgeTopic);
    if (item) return { kind: "knowledge_answer", answer: item.content, stage: state.stage };
  }

  if (ir.commerce) {
    // Live failure (gpt-4o-mini, "I'll take it in medium" with ONE shown item):
    // the model filed "I'll take it" as CHECKOUT while the cart was still
    // empty, and checkout-without-cart asked "which item?". Structurally,
    // asking to buy with nothing in the cart IS a decided selection of the
    // item under discussion — resolved by the same deterministic grounding
    // as any other reference (unique shown item or explicit position; else ask).
    const cartlessCheckout = ir.commerce.intent === "checkout" && !known[SCRATCH_KEYS.commerceCartId];
    if (cartlessCheckout) ir = { ...ir, commerce: { ...ir.commerce, intent: "select" } };
    // Record the customer's purchase decision (the model's judgment, applied
    // per the business playbook). A new search means they're browsing again.
    const c = ir.commerce!;
    if (c.intent === "search") {
      delete known[SCRATCH_KEYS.commerceCheckoutRequested];
      delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
    }
    if ((c.intent === "checkout" || ir.checkoutConsent === true) && !checkoutBlocked) {
      // Consent is SCOPED: an item the customer pointed at is the whole consent; a reference that
      // doesn't ground to anything real is no consent at all (ask, never check out the whole cart).
      if (c.referenceInvalid) {
        delete known[SCRATCH_KEYS.commerceCheckoutRequested];
        delete known[SCRATCH_KEYS.checkoutScope];
        return { kind: "clarify_reference", available: options.cartLines?.length ?? 0, stage: "offer_selection" };
      }
      const scopeLine =
        c.reference?.type === "cart_line"
          ? options.cartLines?.[c.reference.index]?.id
          : c.reference?.type === "previous_result"
            ? options.cartLines?.find((l) => l.title === options.shownProducts?.find((p) => p.position === c.reference!.index + 1)?.title)?.id
            : undefined;
      if (c.reference && !scopeLine) {
        delete known[SCRATCH_KEYS.commerceCheckoutRequested];
        return { kind: "clarify_reference", available: options.cartLines?.length ?? 0, stage: "offer_selection" };
      }
      known[SCRATCH_KEYS.checkoutScope] = JSON.stringify(scopeLine ? { lineIds: [scopeLine], quantity: c.quantity ?? null } : "all");
      if (c.intent === "checkout") known[SCRATCH_KEYS.commerceCheckoutRequested] = "1";
    }
    if (c.intent === "select" || c.intent === "replace" || c.intent === "change_variant" || c.intent === "change_quantity") {
      // A decision attached to a cart change is only INTENT here: checkout
      // eligibility follows the verified result of that change (see the
      // runtime's state patch), never the customer's words alone.
      // An explicit request to buy it now needs no playbook permission to advance.
      // A cart change never implies checkout by itself: only a decision to buy (per the playbook) or an
      // explicit checkout — and never when the customer said not to check out.
      if (!checkoutBlocked && (cartlessCheckout || (ir.purchaseDecision === true && graph.playbook.commerce.advanceToCheckout === "on_purchase_decision"))) {
        known[SCRATCH_KEYS.commerceCheckoutOnSuccess] = "1";
      } else {
        delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
      }
      if (ir.purchaseDecision === false) delete known[SCRATCH_KEYS.commerceCheckoutRequested];
    }
    const commerceOutcome = compileCommerce(ir, known, options);
    if (commerceOutcome) return commerceOutcome;
  }

  // Nothing new to act on from the customer's words: take the next safe
  // step toward the commerce goal, if one is in progress — unless this
  // message doesn't advance it (a question mid-checkout is answered).
  const commerceStep = advancing === false || checkoutBlocked ? undefined : planCommerceGoal(graph, known, options);
  if (commerceStep) return commerceStep;

  // An explicit decline of a previously offered slot ("no"/"לא") only
  // means anything when there's actually a slot on file to decline —
  // otherwise it's a no-op, never a spurious state change. Clears the
  // offer so the compiler falls through to `ask_datetime` again on this
  // same turn, prompting for an alternative instead of silently
  // re-asking about the same rejected slot forever.
  if (ir.constraints.slotDeclined && known[SCRATCH_KEYS.offeredStart]) {
    delete known[SCRATCH_KEYS.offeredStart];
    delete known[SCRATCH_KEYS.offeredEnd];
    delete known[SCRATCH_KEYS.offeredResource];
    delete known[SCRATCH_KEYS.slotAccepted];
    delete known[SCRATCH_KEYS.mentionedEarliest];
    delete known[SCRATCH_KEYS.mentionedLatest];
  }

  // Explicit change-of-mind ("actually, solo instead") is the ONE way the
  // sticky offer selection can be replaced mid-conversation. Ordinary
  // selectedOfferId/offerCandidateIds guesses from later turns never
  // override it (see resolveOfferId) — only this dedicated signal can,
  // and only when it actually names a different, real offer.
  if (
    ir.offerChangeRequested &&
    findOffer(graph, ir.offerChangeRequested) &&
    ir.offerChangeRequested !== state.selectedOfferId
  ) {
    state.selectedOfferId = ir.offerChangeRequested;
    // The old offer's booking/payment progress doesn't apply to the new
    // one — clear it so the new offer starts its own flow from scratch.
    // Customer identity (name/email/phone) and scheduling PREFERENCES
    // (day/time/party size the customer already stated) are kept; they're
    // not specific to which service was chosen.
    delete known[SCRATCH_KEYS.offeredStart];
    delete known[SCRATCH_KEYS.offeredEnd];
    delete known[SCRATCH_KEYS.offeredResource];
    delete known[SCRATCH_KEYS.slotAccepted];
    delete known[SCRATCH_KEYS.paymentRequestId];
    delete known[SCRATCH_KEYS.paid];
    delete known[SCRATCH_KEYS.inventoryChecked];
    delete known[SCRATCH_KEYS.purchaseDecided];
    // The party size belonged to the old service (e.g. a couples booking): the new one starts from
    // what the customer says now, never a stale party.
    if (!ir.constraints.partySize) delete known[SCRATCH_KEYS.mentionedPartySize];
  }

  let selectedOfferId = resolveOfferId(graph, state, ir);

  if (!selectedOfferId && ir.offerCandidateIds && ir.offerCandidateIds.length > 0) {
    const validCandidates = ir.offerCandidateIds.filter((id) => findOffer(graph, id));
    if (validCandidates.length === 1) {
      selectedOfferId = validCandidates[0];
    } else if (validCandidates.length > 1) {
      return {
        kind: "clarify_offer",
        offerNames: validCandidates.map((id) => findOffer(graph, id)!.name),
        stage: "discovery",
      };
    }
  }

  if (!selectedOfferId && known[SCRATCH_KEYS.mentionedEarliest]) {
    // No offer named yet, but scheduling intent is clear (a day/time was
    // mentioned). Narrow by which offers actually require scheduling
    // instead of asking a generic "what are you looking for?" again.
    const schedulable = graph.offers.filter((o) => o.active && o.requiresScheduling);
    if (schedulable.length === 1) {
      selectedOfferId = schedulable[0].id;
    } else if (schedulable.length > 1) {
      return { kind: "clarify_offer", offerNames: schedulable.map((o) => o.name), stage: "discovery" };
    }
  }

  if (!selectedOfferId) {
    if (advancing === false) return { kind: "conversation", stage: state.stage };
    return {
      kind: "ask_general",
      offerNames: graph.offers.filter((o) => o.active).map((o) => o.name).slice(0, 5),
      stage: "discovery",
    };
  }

  // Persist the resolved offer immediately — every subsequent turn's
  // resolveOfferId() call reads state.selectedOfferId, not the IR.
  state.selectedOfferId = selectedOfferId;

  const offer = findOffer(graph, selectedOfferId)!;

  // Safe Business Graph facts are answerable BEFORE any transaction-gate
  // field is collected: requiredCustomerInfo means "needed to fulfill a
  // booking/purchase," not "needed before BARRY may state a price." A
  // "How much is it?" must never be blocked on a phone number.
  // Correcting a pending request's terms is a transaction step, not a fact question.
  const fact = ir.changesPendingRequest ? undefined : resolveOfferFact(ir.requestedCapability, offer);
  if (fact) {
    return { kind: "offer_fact", offerName: offer.name, fact, stage: state.stage };
  }
  // Not advancing: nothing is asked for or bought — but an explicitly requested READ still runs
  // (open times, stock), because looking something up is not committing to anything.
  if (advancing === false) {
    if (ir.readRequested) {
      const read = plannedRead(offer, known, state.stage);
      if (read) return read;
    }
    return { kind: "conversation", stage: state.stage };
  }

  const missing = missingCustomerInfo(offer, known);
  if (missing.length > 0) {
    return { kind: "needs_info", offerName: offer.name, missingFields: missing, stage: "info_gathering" };
  }

  // This conversation's transaction already completed (booking created,
  // order fulfilled, or lead filed) — never re-issue createBooking/
  // fulfillOrder/createLead a second time. Without this guard, a
  // DUPLICATE payment webhook (the same paymentRequestId reported "paid"
  // twice — a real, expected occurrence with any real payment provider,
  // not just a test artifact) re-entered this exact code path and
  // attempted a second createBooking for the identical resource/start,
  // which the tool's own conflict check correctly rejected — but as a
  // customer-facing ERROR ("Slot no longer available... try a different
  // option?") on a booking that had, in fact, already succeeded.
  // Quote / lead-only offers: no scheduling, no inventory, no fixed price.
  if (!offer.requiresScheduling && !offer.requiresInventory && offer.price === null) {
    return finalizeAction(
      "createLead",
      { summary: `${offer.name} inquiry from customer ${state.customerId}`, contactInfo: known.email ?? known.phone },
      "confirmation",
      "qualifyLead"
    );
  }

  if (offer.requiresScheduling) {
    const offeredStart = known[SCRATCH_KEYS.offeredStart];

    if (!offeredStart) {
      const earliest = known[SCRATCH_KEYS.mentionedEarliest];
      if (!earliest) {
        return { kind: "ask_datetime", offerName: offer.name, stage: "scheduling" };
      }
      const partySize = Number(known[SCRATCH_KEYS.mentionedPartySize] ?? 1);
      return finalizeAction(
        "checkAvailability",
        { offerId: offer.id, earliest, latest: known[SCRATCH_KEYS.mentionedLatest], partySize, ...(known[SCRATCH_KEYS.windowEndIsHard] ? { endBy: known[SCRATCH_KEYS.mentionedLatest] } : {}) },
        "scheduling",
        "bookAppointment"
      );
    }

    if (!known[SCRATCH_KEYS.slotAccepted]) {
      return { kind: "ask_slot_confirm", offeredStart, stage: "scheduling" };
    }

    if (offer.requiresPayment) {
      if (!known[SCRATCH_KEYS.paymentRequestId]) {
        if (checkoutBlocked) return { kind: "conversation", stage: state.stage };
        const quote = quoteOffer(graph, offer, 1, Number(known[SCRATCH_KEYS.discountPct] ?? 0), "deposit");
        if (!quote) return { kind: "compiler_error", reason: `No deposit or price for ${offer.name}`, stage: state.stage };
        return finalizeAction("createPaymentRequest", paymentTermsFromQuote(quote, `Deposit for ${offer.name}`), "payment", "collectDeposit");
      }
      if (!known[SCRATCH_KEYS.paid]) {
        return { kind: "waiting_payment", stage: "payment" };
      }
    }

    const partySize = Number(known[SCRATCH_KEYS.mentionedPartySize] ?? 1);
    return finalizeAction(
      "createBooking",
      {
        offerId: offer.id,
        resourceId: known[SCRATCH_KEYS.offeredResource],
        start: offeredStart,
        end: known[SCRATCH_KEYS.offeredEnd],
        partySize,
      },
      "confirmation",
      "bookAppointment"
    );
  }

  if (offer.requiresInventory) {
    // Stock is checked for the quantity the customer wants now; a changed quantity re-checks.
    const quantity = Number(known[SCRATCH_KEYS.quantity] ?? 1);
    if (known[SCRATCH_KEYS.inventoryChecked] !== String(quantity) && !(quantity === 1 && known[SCRATCH_KEYS.inventoryChecked] === "1")) {
      return finalizeAction("checkInventory", { offerId: offer.id, quantity }, "payment", "completePurchase");
    }
    if (offer.requiresPayment && !known[SCRATCH_KEYS.paymentRequestId]) {
      // A payment link needs the customer's decision, not just their interest.
      if (!known[SCRATCH_KEYS.purchaseDecided]) {
        return { kind: "confirm_purchase", offerName: offer.name, stage: "offer_selection" };
      }
      if (checkoutBlocked) return { kind: "conversation", stage: state.stage };
      // ONE quantity-aware quote is the amount the owner reviews, the link charges and the reply states.
      const quote = quoteOffer(graph, offer, quantity, Number(known[SCRATCH_KEYS.discountPct] ?? 0));
      if (!quote) return { kind: "compiler_error", reason: `No price for ${offer.name}`, stage: state.stage };
      return finalizeAction("createPaymentRequest", paymentTermsFromQuote(quote, `Payment for ${offer.name}`), "payment", "completePurchase");
    }
    if (!known[SCRATCH_KEYS.paid]) {
      return { kind: "waiting_payment", stage: "payment" };
    }
    return finalizeAction("fulfillOrder", { offerId: offer.id }, "confirmation", "completePurchase");
  }

  return { kind: "generic_confirm", stage: "confirmation" };
}
