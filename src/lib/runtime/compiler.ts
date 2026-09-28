import type { BusinessGraph, Goal, Offer } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { getTool } from "@/lib/tools";
import type { BarryIR, CompileDebugInfo, CompileOutcome, OfferFact } from "@/lib/reasoner/ir";
import { normalizeCustomerInfoField } from "@/lib/reasoner/customer-fields";
import type { ConversationStage, ConversationState } from "@/lib/state";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";

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
  commerceCartId: "__commerceCartId",
  commerceCartLineId: "__commerceCartLineId",
  commerceCheckoutId: "__commerceCheckoutId",
  commerceOrderId: "__commerceOrderId",
};

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
export function compile(graph: BusinessGraph, state: ConversationState, ir: BarryIR): CompileOutcome {
  const debug: CompileDebugInfo = { appliedCustomerInfo: {} };
  const outcome = compileCore(graph, state, ir, debug);
  return { ...outcome, debug };
}

function compileCore(graph: BusinessGraph, state: ConversationState, ir: BarryIR, debug: CompileDebugInfo): CompileOutcome {
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

  if (ir.requestedCapability === "commerce_policy") {
    const returns = graph.knowledge.find((item) => /return|exchange|sale/i.test([item.topic, item.content].join(" ")));
    if (returns) return { kind: "knowledge_answer", answer: returns.content, stage: "discovery" };
  }

  const commerce = ir.constraints.commerce;
  if (commerce?.action === "search") {
    return finalizeAction(
      "searchProducts",
      {
        text: commerce.query?.text,
        category: commerce.query?.category,
        occasion: commerce.query?.occasion,
        color: commerce.query?.color,
        size: commerce.query?.size,
        budgetAmount: commerce.query?.budgetAmount,
        currency: commerce.query?.currency,
      },
      "discovery",
      "completePurchase"
    );
  }
  if (commerce?.action === "add_first") {
    const productIds = known[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
    const productId = productIds[commerce.selectionIndex ?? 0];
    if (productId) {
      return finalizeAction(
        "addToCart",
        { productId, size: commerce.size, quantity: commerce.quantity ?? 1 },
        "payment",
        "completePurchase"
      );
    }
  }
  if (commerce?.action === "update_size" && known[SCRATCH_KEYS.commerceCartId] && known[SCRATCH_KEYS.commerceCartLineId]) {
    return finalizeAction(
      "updateCartLine",
      {
        cartId: known[SCRATCH_KEYS.commerceCartId],
        lineId: known[SCRATCH_KEYS.commerceCartLineId],
        size: commerce.size,
        quantity: commerce.quantity ?? 1,
      },
      "payment",
      "completePurchase"
    );
  }
  if (commerce?.action === "checkout" && known[SCRATCH_KEYS.commerceCartId] && !known[SCRATCH_KEYS.paymentRequestId]) {
    return finalizeAction("createCommerceCheckout", { cartId: known[SCRATCH_KEYS.commerceCartId] }, "payment", "completePurchase");
  }
  if (known[SCRATCH_KEYS.paid] && known[SCRATCH_KEYS.commerceCartId] && !known[SCRATCH_KEYS.commerceOrderId]) {
    return finalizeAction("createCommerceOrder", { cartId: known[SCRATCH_KEYS.commerceCartId] }, "confirmation", "completePurchase");
  }

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
