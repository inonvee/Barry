import type { BusinessGraph } from "@/lib/business-graph";
import { getConversationStore } from "@/lib/state";
import { getBackend } from "@/lib/store";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { readHandoffs, transactionSnapshot } from "@/lib/runtime/handoff";
import { readDeliveries } from "@/lib/channels/gateway";
import { outcomeEvents } from "./revenue";
import { channelOf, customerLabel } from "./service";

/**
 * One conversation for the owner: the messages, what BARRY did for this customer (outcomes from
 * records), where the transaction stands, requests and handoffs. The technical per-turn summary is
 * opt-in ("advanced") — never the default view. Tenant-checked: a conversation of another business
 * is "not found".
 */
export async function getOwnerConversation(graph: BusinessGraph, conversationId: string, advanced = false) {
  const state = await getConversationStore().get(conversationId);
  if (!state || state.businessId !== graph.business.id) return undefined;
  const backend = getBackend();
  const [approvals, payments, bookings, orders] = await Promise.all([
    backend.listApprovals(graph.business.id).then((a) => a.filter((x) => x.conversationId === state.id)),
    backend.listPaymentRequests(graph.business.id).then((p) => p.filter((x) => x.conversationId === state.id)),
    backend.listBookings(graph.business.id).then((b) => b.filter((x) => x.conversationId === state.id)),
    backend.listCommerceOrders(graph.business.id).then((o) => o.filter((x) => x.conversationId === state.id)),
  ]);
  return {
    id: state.id,
    customer: customerLabel(state),
    channel: channelOf(state),
    messages: state.messages.map((m) => ({ from: m.role, text: m.content, at: m.at })),
    outcomes: outcomeEvents({ graph, conversations: [state], payments, bookings, orders, approvals }),
    transaction: transactionSnapshot(state),
    requests: withLifecycle(approvals, new Map([[state.id, state]])).map((a) => ({ id: a.id, what: a.summary, lifecycle: a.lifecycle, createdAt: a.createdAt, ...(a.hold ? { hold: a.hold } : {}) })),
    handoffs: readHandoffs(state),
    deliveries: readDeliveries(state.knownFields),
    ...(advanced
      ? {
          turns: state.turns.map((t) => ({
            at: t.at,
            customerMessage: t.customerMessage,
            understood: t.trace?.understanding ? (t.trace.understanding.valid ? "understood" : `not understood (${t.trace.understanding.failure?.kind ?? "unknown"})`) : t.understood.intent,
            actions: t.trace?.steps.map((s) => `${s.action}: ${s.policy.status}${s.result ? (s.result.ok ? ", done" : ", failed") : ""}`) ?? [],
            stoppedBecause: t.trace?.stop.reason ?? null,
            replyFallback: t.trace?.reply?.fallback ?? null,
          })),
        }
      : {}),
  };
}
