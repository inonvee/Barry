import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import { appendLedger, ledgerView, readLedger } from "./ledger";

/**
 * HUMAN HANDOFF — a real, recorded state, never a phrase.
 *
 * A handoff is created by the runtime (the model only signals that the customer wants a person or
 * needs something BARRY can't do; repeated understanding failures also hand off). It lands in the
 * owner's inbox with a context summary built from BARRY's records — who, why, how urgent, what the
 * customer asked that is still unresolved, and where the transaction really stands.
 *
 * Honesty: the customer may be told that a person will get back to them ONLY when the business has
 * declared how its team responds (Genome `playbook.handoff`). Otherwise BARRY says the team can see
 * the conversation but it can't promise when or how they'll reply.
 */

export type HandoffTrigger = "customer_asked" | "barry_cannot_help" | "ai_unavailable";

export type HandoffRecord = {
  id: string;
  businessId: string;
  conversationId: string;
  customerId: string;
  trigger: HandoffTrigger;
  reason: string;
  urgency: "normal" | "urgent";
  /** Deterministic context for the person picking it up (from records, not model prose). */
  summary: string;
  unresolved: string[];
  transaction: string[];
  /** The business declared how its team responds — only then may BARRY promise a reply. */
  responseCommitted: boolean;
  /** open → acknowledged (the team has seen it) → resolved. BARRY never replies on the team's behalf. */
  status: "open" | "acknowledged" | "resolved";
  acknowledgedAt?: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

export const HANDOFFS_KEY = "__handoffs";

export function readHandoffs(state: ConversationState): HandoffRecord[] {
  try {
    const parsed = JSON.parse(state.knownFields[HANDOFFS_KEY] ?? "[]");
    return Array.isArray(parsed) ? (parsed as HandoffRecord[]) : [];
  } catch {
    return [];
  }
}

function writeHandoffs(state: ConversationState, all: HandoffRecord[]): void {
  state.knownFields[HANDOFFS_KEY] = JSON.stringify(all);
}

export function openHandoff(state: ConversationState): HandoffRecord | undefined {
  return readHandoffs(state).find((h) => h.status === "open" || h.status === "acknowledged");
}

/** The team has seen it (it stays open until resolved). */
export function acknowledgeHandoff(state: ConversationState, handoffId: string, by: string): HandoffRecord | undefined {
  const all = readHandoffs(state);
  const h = all.find((x) => x.id === handoffId);
  if (!h || h.status !== "open") return undefined;
  h.status = "acknowledged";
  h.acknowledgedAt = new Date().toISOString();
  h.resolvedBy = by;
  writeHandoffs(state, all);
  return h;
}

/** How this business's team responds to a handoff, when it declared one. */
export function handoffPath(graph: BusinessGraph): string | undefined {
  return graph.playbook.handoff?.trim() || undefined;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Where the transaction stands, from the ledger's current view — customer-safe words only. */
export function transactionSnapshot(state: ConversationState): string[] {
  const view = ledgerView(readLedger(state));
  const out: string[] = [];
  const lastCart = [...view].reverse().find((e) => e.outcome && typeof e.outcome.cartAfter === "string");
  if (lastCart && lastCart.outcome!.cartAfter !== "empty") out.push(`Cart: ${lastCart.outcome!.cartAfter}`);
  for (const e of view) {
    if (e.status === "awaiting_owner") out.push(`Waiting on owner: ${e.describes}`);
    else if (e.effect === "payment.link_created") out.push("Payment link sent (not verified paid)");
    else if (e.effect === "payment.settled") out.push("Payment verified");
    else if (e.effect === "booking.created") out.push(`Booked${e.reference ? ` (${e.reference})` : ""}`);
    else if (e.effect === "order.created") out.push(`Order placed${e.reference ? ` (${e.reference})` : ""}`);
    else if (e.effect === "write.blocked") out.push(`Blocked: ${e.describes}`);
    // A follow-up message is outreach, not where the transaction stands (and a legacy dry run was never sent).
    else if (e.status === "effected" && e.reference && !e.effect.startsWith("followup.")) out.push(`${e.describes} (${e.reference})`);
  }
  return [...new Set(out)].slice(-8);
}

/**
 * Create a handoff (or return the one already open — never two at once for a conversation). The
 * effect is recorded in the ledger so replies can be checked against it.
 */
export function createHandoff(
  graph: BusinessGraph,
  state: ConversationState,
  input: { trigger: HandoffTrigger; reason: string; urgency?: "normal" | "urgent"; unresolved?: string[] }
): { handoff: HandoffRecord; created: boolean } {
  const existing = openHandoff(state);
  if (existing) return { handoff: existing, created: false };
  const name = state.knownFields.name;
  const recent = state.messages.filter((m) => m.role === "customer").slice(-3).map((m) => `“${clip(m.content)}”`);
  const transaction = transactionSnapshot(state);
  const handoff: HandoffRecord = {
    id: `ho_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    businessId: graph.business.id,
    conversationId: state.id,
    customerId: state.customerId,
    trigger: input.trigger,
    reason: clip(input.reason, 300),
    urgency: input.urgency ?? "normal",
    summary: [`${name ? `${name}` : "The customer"} — ${clip(input.reason, 200)}`, recent.length ? `Latest messages: ${recent.join(" / ")}` : ""].filter(Boolean).join(". "),
    unresolved: (input.unresolved ?? []).slice(0, 6),
    transaction,
    responseCommitted: Boolean(handoffPath(graph)),
    status: "open",
    createdAt: new Date().toISOString(),
  };
  writeHandoffs(state, [...readHandoffs(state), handoff]);
  appendLedger(state, {
    operation: "handoff",
    effect: "handoff.created",
    status: "effected",
    describes: "handed to the business's team",
    terms: {},
    outcome: { responseCommitted: handoff.responseCommitted, urgent: handoff.urgency === "urgent" },
  });
  return { handoff, created: true };
}

/** The owner/team closed it. */
export function resolveHandoff(state: ConversationState, handoffId: string, by: string): HandoffRecord | undefined {
  const all = readHandoffs(state);
  const h = all.find((x) => x.id === handoffId);
  if (!h || h.status === "resolved") return undefined;
  h.status = "resolved";
  h.resolvedAt = new Date().toISOString();
  h.resolvedBy = by;
  writeHandoffs(state, all);
  appendLedger(state, { operation: "handoff", effect: "handoff.resolved", status: "effected", describes: "the team resolved the handoff", terms: {} });
  return h;
}
