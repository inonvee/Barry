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
    case "knowledge_answer":
      return outcome.answer;
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
      // stage "closed" means this is a duplicate-webhook/replayed-message
      // guard (compileCore already completed this transaction earlier) —
      // never claim to be "finalizing" something that's already done.
      return outcome.stage === "closed"
        ? `You're all set — this is already confirmed! Let me know if there's anything else.`
        : `Let me get that finalized for you.`;
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
          const output = toolResult.output as { paymentRequestId: string; checkoutUrl?: string };
          return output.checkoutUrl
            ? `Here's your secure payment link: ${output.checkoutUrl}. Once the payment is verified, I'll confirm everything.`
            : `Here's your payment request (${output.paymentRequestId}) — once the payment is verified, I'll confirm everything.`;
        }
        case "searchProducts": {
          const output = toolResult.output as {
            products: {
              title: string;
              variants: { price: { amount: number; currency: string }; options: Record<string, string>; inventory: { available: number } }[];
            }[];
          };
          if (output.products.length === 0) {
            return `I don't see a grounded match in the catalog yet. Want to adjust the color, size, or budget?`;
          }
          const lines = output.products.slice(0, 3).map((product, index) => {
            const variant = product.variants.find((v) => v.inventory.available > 0) ?? product.variants[0];
            const size = variant?.options.size ? `, size ${variant.options.size}` : "";
            const price = variant ? `${variant.price.amount} ${variant.price.currency}` : "price unavailable";
            return `${index + 1}. ${product.title}${size} - ${price}`;
          });
          return `I found these grounded options:\n${lines.join("\n")}`;
        }
        case "addToCart": {
          const output = toolResult.output as {
            cart: { lines: { title: string; options: Record<string, string> }[]; total: { amount: number; currency: string } };
            requestedAvailable: boolean;
            selectedSize?: string;
          };
          const line = output.cart.lines[output.cart.lines.length - 1];
          const prefix = output.requestedAvailable
            ? `Added ${line.title}${line.options.size ? ` in ${line.options.size}` : ""} to your cart.`
            : `That exact size is not available, so I added the available alternative${output.selectedSize ? ` in ${output.selectedSize}` : ""}.`;
          return `${prefix} Cart total is ${output.cart.total.amount} ${output.cart.total.currency}.`;
        }
        case "updateCartLine": {
          const output = toolResult.output as {
            cart: { lines: { title: string; options: Record<string, string> }[]; total: { amount: number; currency: string } };
            selectedSize?: string;
          };
          const line = output.cart.lines[0];
          return `Updated ${line?.title ?? "the item"}${output.selectedSize ? ` to ${output.selectedSize}` : ""}. Cart total is ${output.cart.total.amount} ${output.cart.total.currency}.`;
        }
        case "createCommerceCheckout": {
          const output = toolResult.output as { checkoutUrl?: string; amount: { amount: number; currency: string } };
          return output.checkoutUrl
            ? `Your cart is ready: ${output.amount.amount} ${output.amount.currency}. Here's the secure payment link: ${output.checkoutUrl}. I'll create the order only after payment is verified.`
            : `Your cart is ready: ${output.amount.amount} ${output.amount.currency}. I'll create the order only after payment is verified.`;
        }
        case "createCommerceOrder": {
          const output = toolResult.output as { orderId: string };
          return `Payment verified and your order is confirmed (${output.orderId}).`;
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

