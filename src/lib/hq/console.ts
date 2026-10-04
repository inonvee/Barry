import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { lastSaid } from "@/lib/operator/execution-state";
import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { readHandoffs } from "@/lib/runtime/handoff";
import { readLedger } from "@/lib/runtime/ledger";
import { customerLabel } from "@/lib/owner/service";
import { isSimulatedPayment, isVerifiedPaid } from "@/lib/owner/revenue";
import { authoritySummary } from "@/lib/policy/authority";
import { listBusinessSystems } from "@/lib/fabric/registry";
import { reverificationStatus } from "@/lib/fabric/reverify";
import { fleetTenantIds } from "./fleet";
import type { Cart, Order } from "@/lib/commerce/types";

/**
 * HQ V2 FLEET OPERATIONS — founder-only, read-only cross-business read models: the conversation
 * console (filter by business, status, needs-owner, money, incident-linked, time, channel), the
 * transaction views (carts, payments, orders, bookings with verified state and failures), global
 * approvals (business, policy, action, age — never a bypass of the owner's authority) and connection
 * health (provider, capability, status, last verification, expiry, drift, last failure, blocker).
 */

export type ConsoleFilter = { businessId?: string; status?: "needs_owner" | "waiting_on_customer" | "in_progress" | "completed"; needsOwner?: boolean; moneyInvolved?: boolean; incidentLinked?: boolean; sinceHours?: number; channel?: "web" | "whatsapp" | "instagram"; limit?: number };
export type ConsoleRow = { businessId: string; businessName: string; conversationId: string; customer: string; channel: "web" | "whatsapp" | "instagram"; status: "needs_owner" | "waiting_on_customer" | "in_progress" | "completed"; needsOwner: boolean; money: { amount: number; currency: string; state: string } | null; incidentLinked: boolean; lastActivityAt: string; messages: number; lastFrom: "customer" | "barry" | null };

const channelOf = (id: string): ConsoleRow["channel"] => (id.startsWith("wa:") ? "whatsapp" : id.startsWith("ig:") ? "instagram" : "web");

/** Pure: one row per conversation from loaded records. */
export function consoleRows(input: { businessId: string; businessName: string; conversations: ConversationState[]; approvals: ReturnType<typeof withLifecycle>; payments: Awaited<ReturnType<ReturnType<typeof getBackend>["listPaymentRequests"]>> }): ConsoleRow[] {
  return input.conversations.map((c) => {
    const active = input.approvals.filter((a) => a.conversationId === c.id && (a.lifecycle === "active" || a.lifecycle === "held"));
    const handoff = readHandoffs(c).some((h) => h.status !== "resolved");
    const ledger = readLedger(c);
    const failed = ledger.some((e) => e.status === "failed" || e.status === "effected_unconfirmed");
    const payment = input.payments.filter((p) => p.conversationId === c.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const paid = input.payments.some((p) => p.conversationId === c.id && isVerifiedPaid(p));
    const lastMsg = lastSaid(c);
    const needsOwner = active.length > 0 || handoff;
    const status: ConsoleRow["status"] = needsOwner ? "needs_owner" : paid ? "completed" : lastMsg?.role === "barry" || lastMsg?.role === "owner" ? "waiting_on_customer" : "in_progress";
    return {
      businessId: input.businessId,
      businessName: input.businessName,
      conversationId: c.id,
      customer: customerLabel(c),
      channel: channelOf(c.id),
      status,
      needsOwner,
      money: payment ? { amount: payment.amount, currency: payment.currency, state: `${payment.status}${isSimulatedPayment(payment) ? " (test)" : ""}` } : null,
      incidentLinked: failed || c.turns.some((t) => t.trace?.understanding?.valid === false),
      lastActivityAt: c.updatedAt,
      messages: c.messages.length,
      lastFrom: lastMsg ? (lastMsg.role === "customer" ? "customer" : "barry") : null,
    };
  });
}

export function applyConsoleFilter(rows: ConsoleRow[], f: ConsoleFilter, now = new Date()): ConsoleRow[] {
  return rows
    .filter((r) => (!f.businessId || r.businessId === f.businessId) && (!f.status || r.status === f.status) && (f.needsOwner === undefined || r.needsOwner === f.needsOwner) && (f.moneyInvolved === undefined || Boolean(r.money) === f.moneyInvolved) && (f.incidentLinked === undefined || r.incidentLinked === f.incidentLinked) && (!f.channel || r.channel === f.channel) && (!f.sinceHours || now.getTime() - Date.parse(r.lastActivityAt) <= f.sinceHours * 3600_000))
    .sort((a, b) => Number(b.needsOwner) - Number(a.needsOwner) || b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, f.limit ?? 100);
}

export async function fleetConsole(filter: ConsoleFilter = {}, now = new Date()): Promise<ConsoleRow[]> {
  const backend = getBackend();
  const ids = filter.businessId ? fleetTenantIds().filter((id) => id === filter.businessId) : fleetTenantIds();
  const rows: ConsoleRow[] = [];
  for (const id of ids) {
    const graph = resolveBusinessGraph(id);
    const [conversations, approvalsRaw, payments] = await Promise.all([getConversationStore().listByBusiness(id).catch(() => [] as ConversationState[]), backend.listApprovals(id).catch(() => []), backend.listPaymentRequests(id).catch(() => [])]);
    rows.push(...consoleRows({ businessId: id, businessName: graph.business.name, conversations, approvals: withLifecycle(approvalsRaw, new Map(conversations.map((c) => [c.id, c]))), payments }));
  }
  return applyConsoleFilter(rows, filter, now);
}

// ── Transactions ──────────────────────────────────────────────────────────────────────────────────

export type TransactionRow = { businessId: string; businessName: string; kind: "cart" | "payment" | "order" | "booking"; id: string; conversationId: string; state: string; verified: boolean; failed: boolean; simulated: boolean; amount?: number; currency?: string; at: string };

export async function fleetTransactions(opts: { businessId?: string; kind?: TransactionRow["kind"]; failedOnly?: boolean; limit?: number } = {}): Promise<TransactionRow[]> {
  const backend = getBackend();
  const ids = opts.businessId ? fleetTenantIds().filter((id) => id === opts.businessId) : fleetTenantIds();
  const rows: TransactionRow[] = [];
  for (const id of ids) {
    const name = resolveBusinessGraph(id).business.name;
    const [carts, payments, orders, bookings] = await Promise.all([backend.listCommerceCarts(id).catch(() => []), backend.listPaymentRequests(id).catch(() => []), backend.listCommerceOrders(id).catch(() => []), backend.listBookings(id).catch(() => [])]);
    for (const c of carts) {
      const cart = c.data as Cart | undefined;
      rows.push({ businessId: id, businessName: name, kind: "cart", id: c.cartId, conversationId: c.conversationId, state: c.status, verified: false, failed: false, simulated: true, ...(cart ? { amount: cart.total.amount, currency: cart.total.currency } : {}), at: c.updatedAt });
    }
    for (const p of payments) rows.push({ businessId: id, businessName: name, kind: "payment", id: p.id, conversationId: p.conversationId, state: p.status, verified: isVerifiedPaid(p), failed: p.status === "failed" || (p.status === "paid" && !p.verifiedAt), simulated: isSimulatedPayment(p), amount: p.amount, currency: p.currency, at: p.verifiedAt ?? p.createdAt });
    for (const o of orders) {
      const order = o.data as Order | undefined;
      rows.push({ businessId: id, businessName: name, kind: "order", id: o.orderId, conversationId: o.conversationId, state: o.status, verified: Boolean(o.verifiedAt), failed: o.status === "cancelled", simulated: !order?.providerOrderId, amount: o.totalAmount, currency: o.currency, at: o.createdAt });
    }
    for (const b of bookings) rows.push({ businessId: id, businessName: name, kind: "booking", id: b.id, conversationId: b.conversationId, state: b.status, verified: Boolean(b.verifiedAt), failed: b.status === "cancelled", simulated: !b.provider || /^(memory|mock|simulat)/i.test(b.provider), at: b.createdAt });
  }
  return rows.filter((r) => (!opts.kind || r.kind === opts.kind) && (!opts.failedOnly || r.failed)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, opts.limit ?? 200);
}

// ── Global approvals (read-only) ───────────────────────────────────────────────────────────────────

export type GlobalApproval = { businessId: string; businessName: string; approvalId: string; conversationId: string; customer: string; action: string; summary: string; policyId: string; authority: ReturnType<typeof authoritySummary> | "business_rule"; lifecycle: string; ageHours: number; createdAt: string; owner: "owner" };

export async function globalApprovals(opts: { businessId?: string; openOnly?: boolean; now?: Date } = {}): Promise<GlobalApproval[]> {
  const now = opts.now ?? new Date();
  const backend = getBackend();
  const ids = opts.businessId ? fleetTenantIds().filter((id) => id === opts.businessId) : fleetTenantIds();
  const out: GlobalApproval[] = [];
  for (const id of ids) {
    const graph = resolveBusinessGraph(id);
    const [conversations, approvalsRaw] = await Promise.all([getConversationStore().listByBusiness(id).catch(() => [] as ConversationState[]), backend.listApprovals(id).catch(() => [])]);
    const byId = new Map(conversations.map((c) => [c.id, c]));
    for (const a of withLifecycle(approvalsRaw, byId)) {
      if (opts.openOnly !== false && a.lifecycle !== "active" && a.lifecycle !== "held") continue;
      const c = byId.get(a.conversationId);
      out.push({ businessId: id, businessName: graph.business.name, approvalId: a.id, conversationId: a.conversationId, customer: c ? customerLabel(c) : "Customer", action: a.requestedAction, summary: a.summary, policyId: a.policyId, authority: a.requestedAction.includes(".") ? authoritySummary(graph, a.requestedAction) : "business_rule", lifecycle: a.lifecycle, ageHours: Math.max(0, Math.round((now.getTime() - Date.parse(a.createdAt)) / 3600_000)), createdAt: a.createdAt, owner: "owner" });
    }
  }
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

// ── Connection health across businesses ────────────────────────────────────────────────────────────

export type ConnectionHealthRow = { businessId: string; businessName: string; systemId: string; provider: string; domain: string; capabilities: { id: string; status: string; version: string }[]; status: "active" | "proposed" | "disabled"; health: string; simulated: boolean; lastVerifiedAt: string | null; authExpiresAt: string | null; schemaDrift: boolean; lastFailure: string | null; reverificationDue: boolean; reasons: string[]; setupBlocker: string | null };

export async function fleetConnectionHealth(now = new Date()): Promise<ConnectionHealthRow[]> {
  const out: ConnectionHealthRow[] = [];
  for (const id of fleetTenantIds()) {
    const name = resolveBusinessGraph(id).business.name;
    const systems = await listBusinessSystems(id).catch(() => []);
    for (const s of systems) {
      const r = reverificationStatus(s, { now });
      out.push({ businessId: id, businessName: name, systemId: s.id, provider: s.system.name, domain: s.domain, capabilities: s.capabilities.map((c) => ({ id: c.id, status: c.status, version: c.version })), status: s.activation, health: s.health.state, simulated: s.simulated, lastVerifiedAt: s.lastVerifiedAt ?? null, authExpiresAt: r.authExpiry.expiresAt, schemaDrift: r.schemaDrift, lastFailure: s.health.error ?? null, reverificationDue: r.due, reasons: r.reasons, setupBlocker: s.activation !== "active" ? `mapping ${s.activation}` : s.health.state === "down" ? "system down" : null });
    }
  }
  return out.sort((a, b) => Number(b.reverificationDue) - Number(a.reverificationDue) || a.businessName.localeCompare(b.businessName));
}
