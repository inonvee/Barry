import type { ConversationState } from "@/lib/state";

/**
 * The conversation as sent to the HQ page. The messages are the record the
 * founder is inspecting; the state bag is reduced to the transaction flags
 * the trace view reads — internal ids (cart, checkout, payment, order) are
 * shown as present/absent only, and no other stored field leaves the server.
 */
const FLAGS = ["__commerceCartId", "__commerceCheckoutRequested", "__paymentRequestId", "__paid", "__commerceOrderId"] as const;
const VALUES = ["__commerceCartTotal"] as const;

export function hqConversationView(state: ConversationState): ConversationState {
  const knownFields: Record<string, string> = {};
  for (const key of FLAGS) if (state.knownFields[key]) knownFields[key] = "present";
  for (const key of VALUES) if (state.knownFields[key]) knownFields[key] = state.knownFields[key];
  return { ...state, knownFields, pendingAction: null };
}
