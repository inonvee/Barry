import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";

/**
 * WHAT SUPERVISED LETS BARRY DO ON ITS OWN — the explicit list of reversible, low-risk operational actions.
 * Everything consequential that is NOT on this list (money, checkout / payment requests, orders, booking
 * confirmation, refunds, shipments, outbound messages through a capability, any capability added later)
 * needs the owner's approval in SUPERVISED. The list only ever loosens SUPERVISED back toward the business's
 * own rules: an action the rules deny or send for approval stays exactly that.
 *
 *   addToCart / updateCartLine          a cart is a draft: no money moves, the customer or BARRY can undo it
 *   commerce.cart.create / .update      the same through the generic capability path
 *   support.ticket.create               opens a case for the team to look at (an internal record)
 *
 * A price, discount or amount in the request takes it off the list (a policy exception is never "low-risk").
 */
const LOW_RISK_ACTIONS = new Set(["addToCart", "updateCartLine"]);
const LOW_RISK_CAPABILITIES = new Set(["commerce.cart.create", "commerce.cart.update", "support.ticket.create"]);
const MONEY_PARAM = /discount|price|amount|refund|override|exception/i;

export function supervisedLowRisk(action: string, params: Record<string, unknown>): boolean {
  if (Object.keys(params).some((k) => MONEY_PARAM.test(k))) return false;
  if (action === INVOKE_CAPABILITY) {
    const id = String((params as { capability?: unknown }).capability ?? "");
    const inner = (params as { input?: Record<string, unknown> }).input;
    if (inner && Object.keys(inner).some((k) => MONEY_PARAM.test(k))) return false;
    return LOW_RISK_CAPABILITIES.has(id);
  }
  return LOW_RISK_ACTIONS.has(action);
}

/** For docs / the owner's rules view: what SUPERVISED does on its own vs. what it asks for. */
export const SUPERVISED_AUTONOMOUS = { actions: [...LOW_RISK_ACTIONS], capabilities: [...LOW_RISK_CAPABILITIES] };
