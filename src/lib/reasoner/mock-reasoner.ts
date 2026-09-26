import type { Offer } from "@/lib/business-graph";
import { findOffer, knowledgeSearch } from "@/lib/business-graph";
import { extractEntities, findOfferCandidates } from "./entities";
import type { ComposeResponseInput, PlanResult, Reasoner, ReasonerContext } from "./types";

/**
 * Deterministic, rule-based reasoner. Needs no API key, so the simulator
 * and test suite work offline. It reasons purely over Business Graph data
 * (offers, policies, required info) — never over a business "type" — which
 * is what proves the capability-driven architecture actually works.
 *
 * A real deployment swaps this for `openai-reasoner.ts`, which implements
 * the same `Reasoner` interface using an LLM for understanding + planning.
 */

// Internal scratch keys stored in ConversationState.knownFields. Never shown to the customer.
const K = {
  offeredStart: "__offeredSlotStart",
  offeredEnd: "__offeredSlotEnd",
  offeredResource: "__offeredSlotResource",
  paymentRequestId: "__paymentRequestId",
  paid: "__paid",
  discountPct: "__discountPct",
};

function missingCustomerInfo(offer: Offer, known: Record<string, string>): string[] {
  return offer.requiredCustomerInfo.filter((field) => !known[field]);
}

export class MockReasoner implements Reasoner {
  async plan(ctx: ReasonerContext): Promise<PlanResult> {
    const { graph, state, customerMessage } = ctx;
    const entities = extractEntities(customerMessage);
    const known = state.knownFields;

    let selectedOfferId = state.selectedOfferId;
    let retrievedOfferIds: string[] = [];

    if (!selectedOfferId) {
      const candidates = findOfferCandidates(graph, customerMessage);
      retrievedOfferIds = candidates.map((o) => o.id);
      if (candidates.length >= 1) selectedOfferId = candidates[0].id;
    }

    const retrievedKnowledgeIds = knowledgeSearch(graph, customerMessage).map((k) => k.id);

    const base = {
      intent: selectedOfferId ? "offer_interest" : "discovery",
      entities: entities as Record<string, unknown>,
      retrievedOfferIds,
      retrievedKnowledgeIds,
      knownFieldsUpdate: {} as Record<string, string>,
      missingFields: [] as string[],
      action: null,
    };

    if (!selectedOfferId) {
      const hint =
        retrievedKnowledgeIds.length > 0
          ? " " + graph.knowledge.find((k) => retrievedKnowledgeIds.includes(k.id))?.content
          : ` We offer: ${graph.offers
              .filter((o) => o.active)
              .slice(0, 5)
              .map((o) => o.name)
              .join(", ")}.`;
      return {
        ...base,
        stage: "discovery",
        directResponse: `Happy to help! Could you tell me a bit more about what you're looking for?${hint}`,
      };
    }

    const offer = findOffer(graph, selectedOfferId)!;

    // Merge simple field extraction (email/phone) into known fields for any offer that needs them.
    const knownFieldsUpdate: Record<string, string> = {};
    if (entities.earliest) knownFieldsUpdate.__mentionedEarliest = entities.earliest;
    if (entities.latest) knownFieldsUpdate.__mentionedLatest = entities.latest;
    if (entities.partySize > 1) knownFieldsUpdate.__mentionedPartySize = String(entities.partySize);
    if (entities.discountPct) knownFieldsUpdate[K.discountPct] = String(entities.discountPct);
    if (entities.accepted) knownFieldsUpdate.__slotAccepted = "1";
    if (entities.email && offer.requiredCustomerInfo.includes("email")) knownFieldsUpdate.email = entities.email;
    if (entities.phone && offer.requiredCustomerInfo.includes("phone")) knownFieldsUpdate.phone = entities.phone;
    if (
      offer.requiredCustomerInfo.includes("name") &&
      !known.name &&
      !knownFieldsUpdate.email &&
      !knownFieldsUpdate.phone &&
      !entities.accepted &&
      !entities.earliest &&
      customerMessage.trim().split(/\s+/).length <= 4
    ) {
      knownFieldsUpdate.name = customerMessage.trim();
    }

    const mergedKnown = { ...known, ...knownFieldsUpdate };
    const missing = missingCustomerInfo(offer, mergedKnown);

    if (missing.length > 0) {
      return {
        ...base,
        selectedOfferId,
        stage: "info_gathering",
        knownFieldsUpdate,
        missingFields: missing,
        directResponse: `Great choice — ${offer.name}. Could you share your ${missing[0]}?`,
      };
    }

    // Quote / lead-only offers: no scheduling, no inventory, no fixed price.
    if (!offer.requiresScheduling && !offer.requiresInventory && offer.price === null) {
      return {
        ...base,
        selectedOfferId,
        stage: "confirmation",
        knownFieldsUpdate,
        goal: "qualifyLead",
        action: {
          name: "createLead",
          input: { summary: `${offer.name} inquiry from customer ${ctx.state.customerId}`, contactInfo: mergedKnown.email ?? mergedKnown.phone },
        },
      };
    }

    // Scheduling branch
    if (offer.requiresScheduling) {
      const offeredStart = mergedKnown[K.offeredStart];
      if (!offeredStart) {
        const earliest = entities.earliest ?? mergedKnown.__mentionedEarliest;
        const latest = entities.latest ?? mergedKnown.__mentionedLatest;
        const partySize = entities.partySize > 1 ? entities.partySize : Number(mergedKnown.__mentionedPartySize ?? 1);
        if (!earliest) {
          return {
            ...base,
            selectedOfferId,
            stage: "scheduling",
            knownFieldsUpdate,
            goal: "bookAppointment",
            directResponse: `When would you like to come in for your ${offer.name}?`,
          };
        }
        return {
          ...base,
          selectedOfferId,
          stage: "scheduling",
          knownFieldsUpdate,
          goal: "bookAppointment",
          action: {
            name: "checkAvailability",
            input: { offerId: offer.id, earliest, latest, partySize },
          },
        };
      }

      if (!entities.accepted && !mergedKnown.__slotAccepted) {
        return {
          ...base,
          selectedOfferId,
          stage: "scheduling",
          knownFieldsUpdate,
          goal: "bookAppointment",
          directResponse: `Does ${new Date(offeredStart).toLocaleString()} work for you?`,
        };
      }

      // Slot accepted.
      if (offer.requiresPayment) {
        if (!mergedKnown[K.paymentRequestId]) {
          const discountPct = Number(mergedKnown[K.discountPct] ?? 0);
          const baseAmount = offer.depositAmount ?? offer.price ?? 0;
          const amount = Math.round(baseAmount * (1 - discountPct / 100) * 100) / 100;
          return {
            ...base,
            selectedOfferId,
            stage: "payment",
            knownFieldsUpdate,
            goal: "collectDeposit",
            action: {
              name: "createPaymentRequest",
              input: { amount, currency: offer.currency, reason: `Deposit for ${offer.name}`, discountPct, isCustomPrice: false },
            },
          };
        }
        if (!mergedKnown[K.paid]) {
          return {
            ...base,
            selectedOfferId,
            stage: "payment",
            knownFieldsUpdate,
            directResponse: `Just waiting on your payment to confirm the booking.`,
          };
        }
      }

      return {
        ...base,
        selectedOfferId,
        stage: "confirmation",
        knownFieldsUpdate,
        goal: "bookAppointment",
        action: {
          name: "createBooking",
          input: {
            offerId: offer.id,
            resourceId: mergedKnown[K.offeredResource],
            start: offeredStart,
            end: mergedKnown[K.offeredEnd],
            partySize: entities.partySize,
          },
        },
      };
    }

    // Inventory / purchase branch
    if (offer.requiresInventory) {
      if (!mergedKnown.__inventoryChecked) {
        return {
          ...base,
          selectedOfferId,
          stage: "payment",
          knownFieldsUpdate,
          goal: "completePurchase",
          action: { name: "checkInventory", input: { offerId: offer.id } },
        };
      }
      if (offer.requiresPayment && !mergedKnown[K.paymentRequestId]) {
        const discountPct = Number(mergedKnown[K.discountPct] ?? 0);
        const baseAmount = offer.price ?? 0;
        const amount = Math.round(baseAmount * (1 - discountPct / 100) * 100) / 100;
        return {
          ...base,
          selectedOfferId,
          stage: "payment",
          knownFieldsUpdate,
          goal: "completePurchase",
          action: {
            name: "createPaymentRequest",
            input: { amount, currency: offer.currency, reason: `Payment for ${offer.name}`, discountPct, isCustomPrice: false },
          },
        };
      }
      if (!mergedKnown[K.paid]) {
        return {
          ...base,
          selectedOfferId,
          stage: "payment",
          knownFieldsUpdate,
          directResponse: `Just waiting on your payment to complete the order.`,
        };
      }

      return {
        ...base,
        selectedOfferId,
        stage: "confirmation",
        knownFieldsUpdate,
        goal: "completePurchase",
        action: { name: "fulfillOrder", input: { offerId: offer.id } },
      };
    }

    return {
      ...base,
      selectedOfferId,
      stage: "confirmation",
      knownFieldsUpdate,
      directResponse: `Let me get that finalized for you.`,
    };
  }

  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    const { plan, toolResult, policyReason } = input;

    if (policyReason && plan.action) {
      return `Thanks! That needs a quick sign-off from the owner — ${policyReason} I've sent it over and will follow up as soon as it's approved.`;
    }

    if (!toolResult) return plan.directResponse ?? "Got it.";

    if (!toolResult.ok) {
      return `Sorry — I ran into an issue (${toolResult.error}). Could we try a different option?`;
    }

    switch (plan.action?.name) {
      case "checkAvailability": {
        const output = toolResult.output as { slots: { resourceId: string; start: string; end: string }[] };
        if (output.slots.length === 0) {
          return `I don't see any open slots in that window — want to try another day or time?`;
        }
        const slot = output.slots[0];
        return `${new Date(slot.start).toLocaleString()} is available — does that work for you?`;
      }
      case "checkInventory": {
        const output = toolResult.output as { quantityAvailable: number };
        return output.quantityAvailable > 0
          ? `Good news — that's in stock. Ready to go ahead with payment?`
          : `That item is out of stock right now — want me to notify you when it's back, or pick something else?`;
      }
      case "createPaymentRequest": {
        const output = toolResult.output as { paymentRequestId: string };
        return `Here's your payment request (${output.paymentRequestId}) — once it's paid I'll confirm everything.`;
      }
      case "createBooking": {
        const output = toolResult.output as { bookingId: string };
        return `You're all set! Booking confirmed (${output.bookingId}). See you then.`;
      }
      case "fulfillOrder": {
        const output = toolResult.output as { orderId: string };
        return `Your order (${output.orderId}) is confirmed — thanks for shopping with us!`;
      }
      case "createLead": {
        return `Thanks for the details — I've passed this along and we'll follow up with a quote shortly.`;
      }
      case "createFollowUp": {
        return `No problem, I'll follow up with you soon.`;
      }
      default:
        return plan.directResponse ?? "Done!";
    }
  }
}

export const SCRATCH_KEYS = K;
