import type { BusinessGraph } from "@/lib/business-graph";
import { getOwnedCart, StaleCartError } from "@/lib/commerce/capability";
import type { ConversationState } from "@/lib/state";
import type { ToolContext } from "@/lib/tools";
import { buildQuote } from "./pricing";
import { SCRATCH_KEYS } from "./compiler";

/**
 * THE FINAL-WRITE CONSENT GATE.
 *
 * Immediately before a payment-bearing write is proposed to the owner, executed, or executed after
 * an owner's approval, the exact thing about to happen is re-derived from the provider/Genome and
 * checked against what the customer actually consented to:
 *  - scope: every cart line being charged is one the customer consented to (and in the consented
 *    quantity) — a checkout for "only the Onyx" can never charge the rest of the cart;
 *  - hard cap: the authoritative total (quantity × price × discount + the business's own shipping)
 *    is within the customer's hard maximum; when the cap includes shipping and the shipping cost is
 *    unknown, compliance can't be proven, so nothing is created.
 * No model signal can override this: it reads state and the provider, not the IR.
 */

export type WriteBlock = {
  reason: "outside_consent_scope" | "over_budget" | "shipping_unknown" | "stale_cart";
  total?: number;
  currency?: string;
  cap?: number;
  /** Items that would have been charged without consent. */
  extraItems?: string[];
};

const PAYMENT_WRITES = new Set(["createPaymentRequest", "createCommerceCheckout"]);

type Cap = { amount: number; includesShipping: boolean };

function readCap(state: ConversationState): Cap | undefined {
  try {
    const raw = state.knownFields[SCRATCH_KEYS.budgetCap];
    return raw ? (JSON.parse(raw) as Cap) : undefined;
  } catch {
    return undefined;
  }
}

function readScope(state: ConversationState): { lineIds: string[]; quantity: number | null } | "all" {
  try {
    const raw = state.knownFields[SCRATCH_KEYS.checkoutScope];
    return raw ? (JSON.parse(raw) as { lineIds: string[]; quantity: number | null } | "all") : "all";
  } catch {
    return "all";
  }
}

function capCheck(cap: Cap | undefined, total: number, goods: number, shippingKnown: boolean, currency: string): WriteBlock | undefined {
  if (!cap) return undefined;
  if (cap.includesShipping && !shippingKnown) return { reason: "shipping_unknown", total: goods, currency, cap: cap.amount };
  const charged = cap.includesShipping ? total : goods;
  return charged > cap.amount + 1e-9 ? { reason: "over_budget", total: charged, currency, cap: cap.amount } : undefined;
}

export async function finalWriteGate(graph: BusinessGraph, state: ConversationState, action: string, input: Record<string, unknown>, ctx: ToolContext): Promise<WriteBlock | undefined> {
  if (!PAYMENT_WRITES.has(action)) return undefined;
  const cap = readCap(state);

  if (action === "createCommerceCheckout") {
    const cartId = String(input.cartId ?? state.knownFields[SCRATCH_KEYS.commerceCartId] ?? "");
    let cart;
    try {
      cart = await getOwnedCart({ graph, customerId: ctx.customerId, conversationId: ctx.conversationId }, cartId);
    } catch (err) {
      // The provider served a cart older than the recorded revision: nothing is priced from it.
      if (err instanceof StaleCartError) return { reason: "stale_cart" };
      throw err;
    }
    const label = (l: { title: string; options: Record<string, string>; quantity: number }) => `${l.quantity} × ${l.title}${Object.keys(l.options).length ? ` (${Object.values(l.options).join(" / ")})` : ""}`;
    const scope = readScope(state);
    if (scope !== "all") {
      const extra = cart.lines.filter((l) => !scope.lineIds.includes(l.id));
      const wrongQty = scope.quantity !== null && cart.lines.some((l) => scope.lineIds.includes(l.id) && l.quantity !== scope.quantity);
      if (extra.length > 0 || wrongQty || cart.lines.length === 0) return { reason: "outside_consent_scope", extraItems: (extra.length ? extra : cart.lines).map(label) };
    }
    const quote = buildQuote(graph, cart.lines.map((l) => ({ item: l.title, itemRef: l.id, unitPrice: l.unitPrice.amount, quantity: l.quantity })), cart.total.currency);
    return capCheck(cap, quote.total, quote.goodsTotal, quote.complete, quote.currency);
  }

  // Offer payments carry their authoritative quote terms (amount = goods after discount + known shipping).
  const amount = Number(input.amount ?? 0);
  const shipping = input.shipping === undefined ? 0 : (input.shipping as number | null);
  const goods = shipping === null ? amount : amount - shipping;
  return capCheck(cap, amount, goods, shipping !== null, String(input.currency ?? ""));
}
