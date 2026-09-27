import type { ComposeResponseInput } from "./types";

/**
 * Friendly singular labels for known customer-info field keys — a
 * "needs_info" reply must ask for EXACTLY what `missingFields` names,
 * one per real-world field, never invented or pluralized based on
 * unrelated context (a live bug: partySize=2 made BARRY ask for "names
 * and phone numbers" — plural, as if collecting two people's contact
 * info — when only ONE customer's info was actually missing).
 */
const FIELD_LABELS: Record<string, string> = {
  name: "name",
  phone: "phone number",
  email: "email address",
};

function formatMissingFieldsList(missingFields: string[]): string {
  const labels = missingFields.map((f) => FIELD_LABELS[f] ?? f);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Canned, deterministic phrasing for every CompileOutcome. This is
 * MockReasoner's entire composeResponse() — and also what OpenAIReasoner
 * falls back to if the LLM call for phrasing a reply fails, so a natural-
 * language provider outage degrades to "correct but plain" instead of
 * losing the conversation.
 */
export function composeDeterministic(input: ComposeResponseInput): string {
  const { outcome, toolResult, policyReason, scheduling } = input;

  if (policyReason) {
    return `Thanks! That needs a quick sign-off from the owner — ${policyReason} I've sent it over and will follow up as soon as it's approved.`;
  }

  switch (outcome.kind) {
    case "ask_general":
      return `Happy to help! Could you tell me a bit more about what you're looking for? We offer: ${outcome.offerNames.join(", ")}.`;
    case "clarify_offer":
      return `Sure — is that for ${outcome.offerNames.join(" or ")}?`;
    case "needs_info":
      return `Great choice — ${outcome.offerName}. Could you share your ${formatMissingFieldsList(outcome.missingFields)}?`;
    case "ask_datetime":
      return `When would you like to come in for your ${outcome.offerName}?`;
    case "ask_slot_confirm":
      // Never interpret outcome.offeredStart (a raw UTC ISO string)
      // directly — it must always be rendered in the business's own
      // local timezone, via the display facts the runtime computed
      // deterministically before calling composeResponse.
      return scheduling?.offeredSlot
        ? `Does ${scheduling.offeredSlot.localDate} at ${scheduling.offeredSlot.localTime} work for you?`
        : `Does that time work for you?`;
    case "waiting_payment":
      return `Just waiting on your payment to confirm this.`;
    case "offer_fact":
      switch (outcome.fact.type) {
        case "price":
          return `${outcome.offerName} is ${outcome.fact.price} ${outcome.fact.currency}.`;
        case "duration":
          return `${outcome.offerName} takes about ${outcome.fact.minutes} minutes.`;
        case "deposit":
          return outcome.fact.required
            ? `Yes, ${outcome.offerName} requires a deposit${outcome.fact.amount ? ` of ${outcome.fact.amount} ${outcome.fact.currency}` : ""}.`
            : `No deposit is required for ${outcome.offerName}.`;
      }
    case "generic_confirm":
      return `Let me get that finalized for you.`;
    case "compiler_error":
      return `Sorry — I need a little more information before I can do that. Could you tell me more?`;
    case "action": {
      if (!toolResult) return "Got it.";
      if (!toolResult.ok) {
        return `Sorry — I ran into an issue (${toolResult.error}). Could we try a different option?`;
      }
      switch (outcome.action.name) {
        case "checkAvailability": {
          const output = toolResult.output as { slots: { resourceId: string; start: string; end: string }[] };
          if (output.slots.length === 0) {
            return `I don't see any open slots in that window — want to try another day or time?`;
          }
          // Never interpret a raw UTC ISO string directly — always the
          // business-local display fact the runtime already computed.
          const slot = scheduling?.availableSlots?.[0];
          return slot
            ? `${slot.localDate} at ${slot.localTime} is available — does that work for you?`
            : `I found an available time — does that work for you?`;
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
        case "createLead":
          return `Thanks for the details — I've passed this along and we'll follow up with a quote shortly.`;
        case "createFollowUp":
          return `No problem, I'll follow up with you soon.`;
        default:
          return "Done!";
      }
    }
    default:
      return "Got it.";
  }
}

