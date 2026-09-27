import type { BusinessGraph, Goal, Offer } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { getTool } from "@/lib/tools";
import type { BarryIR, CompileOutcome } from "@/lib/reasoner/ir";
import type { ConversationStage, ConversationState } from "@/lib/state";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";

export type { CompileOutcome } from "@/lib/reasoner/ir";

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
 */
export function compile(graph: BusinessGraph, state: ConversationState, ir: BarryIR): CompileOutcome {
  const scratchUpdate: Record<string, string> = {};
  // The ONLY place a semantic scheduling constraint ("Sunday", "at 2pm")
  // becomes an absolute timestamp — using the business's own timezone,
  // never the server's or a hardcoded one. Neither Reasoner is ever asked
  // to compute this itself.
  if (ir.constraints.schedulingWindow) {
    const resolved = resolveSchedulingWindow(ir.constraints.schedulingWindow, graph.business.timezone);
    if (resolved) {
      scratchUpdate[SCRATCH_KEYS.mentionedEarliest] = resolved.earliest;
      scratchUpdate[SCRATCH_KEYS.mentionedLatest] = resolved.latest;
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
  // `knownFieldsUpdate` is a free-form key/value bag (customer-info answers
  // like name/email/phone) — a reasoner controls the KEY NAMES, not just
  // the values. `__`-prefixed keys are the compiler's own scratch
  // namespace (booking slots, payment/approval state, discount %, ...);
  // never let untrusted IR set one directly, or a hallucinating/adversarial
  // model could fabricate e.g. `{ key: "__paid", value: "1" }` and have it
  // treated as a verified payment confirmation without the payment tool
  // ever having run. Only the runtime (patchStateAfterTool, webhook
  // handlers) may ever write a scratch key.
  const safeKnownFieldsUpdate = Object.fromEntries(
    Object.entries(ir.knownFieldsUpdate).filter(([key]) => !key.startsWith("__"))
  );
  Object.assign(state.knownFields, scratchUpdate, safeKnownFieldsUpdate);
  const known = state.knownFields;

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

  const missing = missingCustomerInfo(offer, known);
  if (missing.length > 0) {
    return { kind: "needs_info", offerName: offer.name, missingFields: missing, stage: "info_gathering" };
  }

  if (ir.requestedCapability === "ask_price" && offer.price !== null) {
    return { kind: "price_fact", offerName: offer.name, price: offer.price, currency: offer.currency, stage: state.stage };
  }

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
