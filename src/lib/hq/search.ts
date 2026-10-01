import type { Fleet } from "./fleet";
import type { ConversationState } from "@/lib/state";
import type { PaymentRequestRecord, ApprovalRecord } from "@/lib/store/types";
import { customerLabel } from "@/lib/owner/service";

/**
 * COMMAND-BAR SEARCH (HQ scope = the whole fleet; owner scope = one business). Results are REAL
 * records and surfaces only: businesses, incidents, conversations (by customer / id), approvals,
 * payments. Anything else is not pretended searchable. Pure ranking over inputs the caller loaded
 * within its authority; the API never reaches past that scope.
 */

export type SearchResult = { id: string; kind: "business" | "incident" | "conversation" | "approval" | "payment" | "surface"; title: string; subtitle?: string; href: string; status?: "ok" | "attention" | "blocked" | "degraded" | "not_ready" | "simulator" | "unknown" | "neutral"; keywords?: string[] };

const norm = (s: string) => s.toLowerCase();
const words = (q: string) => norm(q).split(/\s+/).filter(Boolean);
const hit = (q: string, ...fields: (string | undefined)[]) => {
  const hay = norm(fields.filter(Boolean).join(" "));
  return words(q).every((w) => hay.includes(w));
};

export const HQ_SURFACES: SearchResult[] = [
  { id: "surface:focus", kind: "surface", title: "Focus", subtitle: "What needs you across the fleet", href: "/hq" },
  { id: "surface:fleet", kind: "surface", title: "Fleet", subtitle: "Every business, one row each", href: "/hq/fleet" },
  { id: "surface:incidents", kind: "surface", title: "Incidents", href: "/hq/incidents" },
  { id: "surface:activity", kind: "surface", title: "Activity", subtitle: "What BARRY and people did", href: "/hq/activity" },
  { id: "surface:money", kind: "surface", title: "Money", subtitle: "Blocked, at risk, verified — per currency", href: "/hq/money" },
  { id: "surface:releases", kind: "surface", title: "Releases", subtitle: "Build, proof, verdicts", href: "/hq/releases" },
  { id: "surface:barry", kind: "surface", title: "BARRY · capabilities", href: "/hq/barry" },
  { id: "surface:settings", kind: "surface", title: "Settings", href: "/hq/settings" },
  { id: "surface:ask", kind: "surface", title: "Ask HQ BARRY", href: "/hq/ask" },
  { id: "surface:console", kind: "surface", title: "Conversation console", href: "/hq/console" },
  { id: "surface:transactions", kind: "surface", title: "Transactions", href: "/hq/transactions" },
  { id: "surface:approvals", kind: "surface", title: "Global approvals", href: "/hq/approvals" },
  { id: "surface:connections", kind: "surface", title: "Connection health", href: "/hq/connections" },
  { id: "surface:proposals", kind: "surface", title: "Change proposals", href: "/hq/proposals" },
];

export function searchFleet(q: string, fleet: Fleet, limit = 10): SearchResult[] {
  const out: SearchResult[] = [];
  for (const b of fleet.businesses) {
    if (hit(q, b.name, b.id)) out.push({ id: `business:${b.id}`, kind: "business", title: b.name, subtitle: `${b.stage.replace(/_/g, " ")} · ${b.controls.mode}`, href: `/hq/${encodeURIComponent(b.id)}`, status: b.health === "healthy" ? "ok" : b.health === "attention" ? "attention" : "blocked", keywords: [b.id] });
    for (const i of b.incidents.open) {
      if (hit(q, i.title, i.kind.replace(/_/g, " "), b.name, i.severity)) out.push({ id: `incident:${b.id}:${i.key}`, kind: "incident", title: i.title, subtitle: `${b.name} · ${i.severity} · ${i.status}`, href: `/hq/${encodeURIComponent(b.id)}?view=attention#${encodeURIComponent(i.key)}`, status: i.severity === "high" ? "blocked" : "attention" });
    }
  }
  return out.slice(0, limit);
}

/** Search within one business's records (the caller loaded them under its own authority). */
export function searchBusinessRecords(q: string, input: { businessId: string; businessName?: string; conversations: ConversationState[]; approvals: ApprovalRecord[]; payments: PaymentRequestRecord[]; hrefs: { conversation: (id: string) => string; approval: (a: ApprovalRecord) => string; payment: (p: PaymentRequestRecord) => string } }, limit = 10): SearchResult[] {
  const out: SearchResult[] = [];
  const customer = (conversationId: string) => {
    const c = input.conversations.find((x) => x.id === conversationId);
    return c ? customerLabel(c) : undefined;
  };
  for (const c of input.conversations) {
    const label = customerLabel(c);
    if (hit(q, label, c.id, c.customerId)) out.push({ id: `conversation:${c.id}`, kind: "conversation", title: label, subtitle: `${input.businessName ?? input.businessId} · conversation`, href: input.hrefs.conversation(c.id), keywords: [c.id] });
  }
  for (const a of input.approvals) {
    if (hit(q, a.id, a.requestedAction, a.reason, customer(a.conversationId))) out.push({ id: `approval:${a.id}`, kind: "approval", title: `${a.requestedAction.replace(/([A-Z])/g, " $1").toLowerCase()} — ${a.status}`, subtitle: `${customer(a.conversationId) ?? "customer"} · ${input.businessName ?? input.businessId}`, href: input.hrefs.approval(a), status: a.status === "pending" ? "attention" : a.status === "declined" ? "blocked" : "ok", keywords: [a.id] });
  }
  for (const p of input.payments) {
    if (hit(q, p.id, p.status, `${p.amount}`, p.currency, customer(p.conversationId), p.providerTransactionId)) out.push({ id: `payment:${p.id}`, kind: "payment", title: `${p.amount} ${p.currency} — ${p.status}`, subtitle: `${customer(p.conversationId) ?? "customer"} · ${input.businessName ?? input.businessId}`, href: input.hrefs.payment(p), status: p.status === "paid" ? "ok" : p.status === "pending" ? "attention" : "blocked", keywords: [p.id] });
  }
  return out.slice(0, limit);
}
