import type { BusinessGraph, Goal, Offer } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { getTool } from "@/lib/tools";
import type { BarryIR, CompileDebugInfo, CompileOutcome, OfferFact } from "@/lib/reasoner/ir";
import { normalizeCustomerInfoField } from "@/lib/reasoner/customer-fields";
import type { ConversationStage, ConversationState } from "@/lib/state";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";
import { actionSupported, type CapabilityProfiles } from "@/lib/capabilities/model";

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
  lastSchedulingDate: "__lastSchedulingDate",
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
};

/**
 * Grounds commerce semantics against what BARRY actually showed/holds.
 * The model says "the first one"; the ids come ONLY from persisted state
 * written by real tool results. Never trusts a product/line id from IR.
 */
function compileCommerce(ir: BarryIR, known: Record<string, string>): CompileOutcome | undefined {
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
      let productId: string | undefined;
      if (commerce.reference?.type === "previous_result") {
        productId = lastIds[commerce.reference.index];
        if (!productId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      } else {
        productId = known[SCRATCH_KEYS.commercePendingProductId] ?? (lastIds.length === 1 ? lastIds[0] : undefined);
        if (!productId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      }
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

    case "replace": {
      // Without an item in the cart there is nothing to replace: it is a plain selection.
      if (!cartId || !lineId) return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select" } }, known);
      const productId = commerce.reference?.type === "previous_result" ? lastIds[commerce.reference.index] : undefined;
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
      // BARRY just asked which option the customer wants for a pending
      // item; an option named without pointing at a cart line answers it.
      if (commerce.intent === "change_variant" && known[SCRATCH_KEYS.commercePendingProductId] && commerce.reference?.type !== "cart_line") {
        return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select", reference: undefined } }, known);
      }
      if (!cartId || !lineId) {
        // Nothing in the cart yet: a variant choice completes a pending selection.
        if (commerce.intent === "change_variant" && (known[SCRATCH_KEYS.commercePendingProductId] || lastIds.length === 1)) {
          return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select", reference: undefined } }, known);
        }
        return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      }
      return finalizeAction(
        "updateCartLine",
        {
          cartId,
          lineId,
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
};

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
  }
  if (ir.constraints.partySize && ir.constraints.partySize > 1) {
    scratchUpdate[SCRATCH_KEYS.mentionedPartySize] = String(ir.constraints.partySize);
  }
  if (ir.constraints.discountPct) {
    scratchUpdate[SCRATCH_KEYS.discountPct] = String(ir.constraints.discountPct);
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

  if (state.stage === "closed") {
    return { kind: "generic_confirm", stage: "closed" };
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

  // Knowledge answers come verbatim from the business's own stored item
  // for the topic the model named — BARRY never paraphrases policy.
  if (ir.knowledgeTopic) {
    const item = graph.knowledge.find((k) => k.topic === ir.knowledgeTopic);
    if (item) return { kind: "knowledge_answer", answer: item.content, stage: state.stage };
  }

  if (ir.commerce) {
    // Record the customer's purchase decision (the model's judgment, applied
    // per the business playbook). A new search means they're browsing again.
    const c = ir.commerce;
    if (c.intent === "search") {
      delete known[SCRATCH_KEYS.commerceCheckoutRequested];
      delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
    }
    if (c.intent === "checkout") known[SCRATCH_KEYS.commerceCheckoutRequested] = "1";
    if (c.intent === "select" || c.intent === "replace" || c.intent === "change_variant" || c.intent === "change_quantity") {
      // A decision attached to a cart change is only INTENT here: checkout
      // eligibility follows the verified result of that change (see the
      // runtime's state patch), never the customer's words alone.
      if (ir.purchaseDecision === true && graph.playbook.commerce.advanceToCheckout === "on_purchase_decision") {
        known[SCRATCH_KEYS.commerceCheckoutOnSuccess] = "1";
      } else {
        delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
      }
      if (ir.purchaseDecision === false) delete known[SCRATCH_KEYS.commerceCheckoutRequested];
    }
    const commerceOutcome = compileCommerce(ir, known);
    if (commerceOutcome) return commerceOutcome;
  }

  // Nothing new to act on from the customer's words: take the next safe
  // step toward the commerce goal, if one is in progress.
  const commerceStep = planCommerceGoal(graph, known, options);
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
  const fact = resolveOfferFact(ir.requestedCapability, offer);
  if (fact) {
    return { kind: "offer_fact", offerName: offer.name, fact, stage: state.stage };
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
        { offerId: offer.id, earliest, latest: known[SCRATCH_KEYS.mentionedLatest], partySize },
        "scheduling",
        "bookAppointment"
      );
    }

    if (!known[SCRATCH_KEYS.slotAccepted]) {
      return { kind: "ask_slot_confirm", offeredStart, stage: "scheduling" };
    }

    if (offer.requiresPayment) {
      if (!known[SCRATCH_KEYS.paymentRequestId]) {
        const discountPct = Number(known[SCRATCH_KEYS.discountPct] ?? 0);
        const baseAmount = offer.depositAmount ?? offer.price ?? 0;
        return finalizeAction(
          "createPaymentRequest",
          {
            amount: round2(baseAmount * (1 - discountPct / 100)),
            currency: offer.currency,
            reason: `Deposit for ${offer.name}`,
            discountPct,
            isCustomPrice: false,
          },
          "payment",
          "collectDeposit"
        );
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
    if (!known[SCRATCH_KEYS.inventoryChecked]) {
      return finalizeAction("checkInventory", { offerId: offer.id }, "payment", "completePurchase");
    }
    if (offer.requiresPayment && !known[SCRATCH_KEYS.paymentRequestId]) {
      // A payment link needs the customer's decision, not just their interest.
      if (!known[SCRATCH_KEYS.purchaseDecided]) {
        return { kind: "confirm_purchase", offerName: offer.name, stage: "offer_selection" };
      }
      const discountPct = Number(known[SCRATCH_KEYS.discountPct] ?? 0);
      return finalizeAction(
        "createPaymentRequest",
        {
          amount: round2((offer.price ?? 0) * (1 - discountPct / 100)),
          currency: offer.currency,
          reason: `Payment for ${offer.name}`,
          discountPct,
          isCustomPrice: false,
        },
        "payment",
        "completePurchase"
      );
    }
    if (!known[SCRATCH_KEYS.paid]) {
      return { kind: "waiting_payment", stage: "payment" };
    }
    return finalizeAction("fulfillOrder", { offerId: offer.id }, "confirmation", "completePurchase");
  }

  return { kind: "generic_confirm", stage: "confirmation" };
}
