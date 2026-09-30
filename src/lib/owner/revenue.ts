import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { ApprovalRecord, BookingRecord, CommerceOrderRecord, PaymentRequestRecord } from "@/lib/store/types";
import { readLedger, type LedgerEntry } from "@/lib/runtime/ledger";
import { readHandoffs } from "@/lib/runtime/handoff";

/**
 * REVENUE & OUTCOME ATTRIBUTION — evidence only, never a blended ROI number.
 *
 * Three separate kinds of money, always reported apart (and per currency):
 *  - DIRECT: money BARRY collected. A payment request BARRY created that the payment provider reported
 *    PAID and that was verified (status "paid" + verifiedAt). Nothing else counts — not a link sent,
 *    not a customer saying "I paid", not an owner approval.
 *  - INFLUENCED: value BARRY secured but did not collect: a confirmed booking BARRY made for an offer
 *    with a price in the Genome, minus any deposit BARRY collected for it (that part is direct).
 *  - POTENTIAL: open opportunity only: payment links sent but not paid, and payment requests waiting on
 *    the owner. Never revenue.
 * "Recovered" is a SUBSET of direct: paid in a conversation where an earlier payment attempt failed,
 * was cancelled, or was blocked. Simulated providers are counted separately and never mixed in.
 */

export type Money = Record<string, number>;

export type OutcomeKind =
  | "paid"
  | "booked"
  | "order_created"
  | "case_created"
  | "checkout_abandoned"
  | "blocked"
  | "failed"
  | "handoff"
  | "declined_by_owner";

export type OutcomeEvent = {
  at: string;
  conversationId: string;
  kind: OutcomeKind;
  /** Plain words for the owner. */
  label: string;
  amount?: number;
  currency?: string;
  reference?: string;
  /** Where this came from — the record that proves it. */
  evidence: string;
  simulated?: boolean;
};

export type RevenueSummary = {
  direct: Money;
  directPayments: number;
  recovered: Money;
  influenced: Money;
  influencedBookings: number;
  potential: Money;
  potentialItems: number;
  /** Simulated-provider payments and bookings (test/demo) — never part of direct or influenced. */
  simulatedPaid: Money;
  simulatedInfluenced: Money;
  discounts: { granted: number; refused: number };
  /** Conversations that reached purchase/booking intent (a cart, a payment link, a booking or an owner request for money). */
  purchaseIntentConversations: number;
  /** Of those, how many ended with verified payment or a confirmed booking. */
  convertedConversations: number;
  /** Conversations with an opportunity that was lost: withdrawn, declined, payment failed/cancelled, or abandoned. */
  lostOpportunities: number;
  /** Conversations that needed the owner (an approval or a handoff), of all active conversations. */
  ownerInterventions: number;
  activeConversations: number;
};

const add = (m: Money, currency: string, amount: number) => {
  m[currency] = Math.round(((m[currency] ?? 0) + amount) * 100) / 100;
};

export function isSimulatedPayment(p: PaymentRequestRecord): boolean {
  return !p.provider || /^(memory|mock|simulat)/i.test(p.provider);
}

export function isSimulatedBooking(b: BookingRecord): boolean {
  return !b.provider || /^(memory|mock|simulat)/i.test(b.provider);
}

/** A payment counts as revenue only when the provider reported it paid AND it was verified. */
export function isVerifiedPaid(p: PaymentRequestRecord): boolean {
  return p.status === "paid" && Boolean(p.verifiedAt);
}

const ABANDON_AFTER_MS = 24 * 3600 * 1000;

export type AttributionInput = {
  graph: BusinessGraph;
  conversations: ConversationState[];
  payments: PaymentRequestRecord[];
  bookings: BookingRecord[];
  orders: CommerceOrderRecord[];
  approvals: ApprovalRecord[];
  /** Only records at/after this instant count (e.g. start of today in the business timezone). */
  since?: string;
  now?: Date;
};

const after = (iso: string | undefined, since?: string) => !since || (iso !== undefined && iso >= since);

function paymentApprovalAmount(a: ApprovalRecord): { amount: number; currency: string } | undefined {
  const i = (a.requestedInput ?? {}) as Record<string, unknown>;
  return typeof i.amount === "number" && typeof i.currency === "string" ? { amount: i.amount, currency: i.currency } : undefined;
}

/** Every business outcome, derived from authoritative records (provider-verified records + the effect ledger). */
export function outcomeEvents(input: AttributionInput): OutcomeEvent[] {
  const { graph, conversations, payments, bookings, orders, approvals, since } = input;
  const now = input.now ?? new Date();
  const events: OutcomeEvent[] = [];
  for (const p of payments) {
    if (isVerifiedPaid(p) && after(p.verifiedAt, since)) {
      events.push({ at: p.verifiedAt!, conversationId: p.conversationId, kind: "paid", label: "Payment received", amount: p.amount, currency: p.currency, evidence: "verified by the payment provider", simulated: isSimulatedPayment(p) });
    } else if ((p.status === "failed" || p.status === "cancelled") && after(p.createdAt, since)) {
      events.push({ at: p.createdAt, conversationId: p.conversationId, kind: "checkout_abandoned", label: p.status === "failed" ? "Payment failed" : "Payment link cancelled", amount: p.amount, currency: p.currency, evidence: `payment ${p.status}`, simulated: isSimulatedPayment(p) });
    } else if (p.status === "pending" && now.getTime() - Date.parse(p.createdAt) > ABANDON_AFTER_MS && after(p.createdAt, since)) {
      events.push({ at: p.createdAt, conversationId: p.conversationId, kind: "checkout_abandoned", label: "Payment link not paid after 24h", amount: p.amount, currency: p.currency, evidence: "payment still pending", simulated: isSimulatedPayment(p) });
    }
  }
  for (const b of bookings) {
    if (b.status !== "confirmed" || !after(b.createdAt, since)) continue;
    const offer = graph.offers.find((o) => o.id === b.offerId);
    events.push({ at: b.createdAt, conversationId: b.conversationId, kind: "booked", label: `Booked: ${offer?.name ?? "appointment"}`, ...(offer?.price ? { amount: offer.price, currency: offer.currency } : {}), evidence: b.verifiedAt ? "confirmed by the scheduling system" : "booking record" });
  }
  for (const o of orders) {
    if (!after(o.createdAt, since)) continue;
    events.push({ at: o.createdAt, conversationId: o.conversationId, kind: "order_created", label: "Order created", amount: o.totalAmount, currency: o.currency, reference: o.orderId, evidence: "created after verified payment" });
  }
  for (const a of approvals) {
    if (a.status === "declined" && !a.resolution?.decidedBy.startsWith("customer:") && !a.resolution?.decidedBy.startsWith("runtime:") && after(a.resolution?.decidedAt, since)) {
      events.push({ at: a.resolution!.decidedAt, conversationId: a.conversationId, kind: "declined_by_owner", label: "You declined a request", evidence: "owner decision" });
    }
  }
  for (const c of conversations) {
    for (const e of readLedger(c)) {
      if (!after(e.at, since)) continue;
      const ev = ledgerOutcome(e);
      if (ev) events.push({ ...ev, at: e.at, conversationId: c.id });
    }
    for (const h of readHandoffs(c)) {
      if (after(h.createdAt, since)) events.push({ at: h.createdAt, conversationId: c.id, kind: "handoff", label: `Handed to your team: ${h.reason}`, evidence: h.status === "open" ? "open handoff" : "handoff resolved" });
    }
  }
  return events.sort((x, y) => y.at.localeCompare(x.at));
}

/** Outcomes the ledger alone proves (the typed money/booking effects come from provider records above). */
function ledgerOutcome(e: LedgerEntry): Omit<OutcomeEvent, "at" | "conversationId"> | undefined {
  if (e.effect === "write.blocked") return { kind: "blocked", label: `Blocked by the customer's own limits: ${e.describes}`, ...(typeof e.outcome?.total === "number" ? { amount: e.outcome.total } : {}), evidence: "final-write check" };
  if (e.status === "failed" && e.operation !== "understand") return { kind: "failed", label: `Didn't go through: ${e.describes}`, evidence: "system result" };
  // A confirmed consequential operation on the business's own system that produced a reference (a case, a ticket…).
  if (e.status === "effected" && e.reference && !/^(booking|order|payment|cart|availability|stock|catalog|handoff)\./.test(e.effect) && !e.effect.endsWith(".read")) {
    return { kind: "case_created", label: `${e.describes}`, reference: e.reference, evidence: "confirmed by the business's system" };
  }
  return undefined;
}

/** Revenue and conversion, attributable by evidence. */
export function revenueSummary(input: AttributionInput): RevenueSummary {
  const { graph, conversations, payments, bookings, approvals, since } = input;
  const now = input.now ?? new Date();
  const r: RevenueSummary = {
    direct: {},
    directPayments: 0,
    recovered: {},
    influenced: {},
    influencedBookings: 0,
    potential: {},
    potentialItems: 0,
    simulatedPaid: {},
    simulatedInfluenced: {},
    discounts: { granted: 0, refused: 0 },
    purchaseIntentConversations: 0,
    convertedConversations: 0,
    lostOpportunities: 0,
    ownerInterventions: 0,
    activeConversations: 0,
  };
  const paidByConversation = new Map<string, PaymentRequestRecord[]>();
  for (const p of payments) {
    if (!isVerifiedPaid(p) || !after(p.verifiedAt, since)) continue;
    if (isSimulatedPayment(p)) {
      add(r.simulatedPaid, p.currency, p.amount);
      continue;
    }
    add(r.direct, p.currency, p.amount);
    r.directPayments++;
    paidByConversation.set(p.conversationId, [...(paidByConversation.get(p.conversationId) ?? []), p]);
  }
  // Recovered: paid after an earlier failed/cancelled attempt or a blocked write in the same conversation.
  for (const [conversationId, paid] of paidByConversation) {
    const convo = conversations.find((c) => c.id === conversationId);
    for (const p of paid) {
      const earlierFailure = payments.some((q) => q.conversationId === conversationId && q.id !== p.id && (q.status === "failed" || q.status === "cancelled") && q.createdAt < p.createdAt);
      const earlierBlock = readLedger(convo ?? ({ knownFields: {} } as ConversationState)).some((e) => e.effect === "write.blocked" && e.at < p.createdAt);
      if (earlierFailure || earlierBlock) add(r.recovered, p.currency, p.amount);
    }
  }
  for (const b of bookings) {
    if (b.status !== "confirmed" || !after(b.createdAt, since)) continue;
    const offer = graph.offers.find((o) => o.id === b.offerId);
    if (!offer?.price) continue;
    const collected = payments.filter((p) => p.conversationId === b.conversationId && isVerifiedPaid(p) && !isSimulatedPayment(p)).reduce((s, p) => s + (p.currency === offer.currency ? p.amount : 0), 0);
    const remaining = Math.max(0, offer.price - collected);
    if (remaining > 0 && isSimulatedBooking(b)) {
      add(r.simulatedInfluenced, offer.currency, remaining);
    } else if (remaining > 0) {
      add(r.influenced, offer.currency, remaining);
      r.influencedBookings++;
    }
  }
  for (const p of payments) {
    if (p.status === "pending" && now.getTime() - Date.parse(p.createdAt) <= ABANDON_AFTER_MS && !isSimulatedPayment(p)) {
      add(r.potential, p.currency, p.amount);
      r.potentialItems++;
    }
  }
  for (const a of approvals) {
    const money = paymentApprovalAmount(a);
    if (a.status === "pending" && money) {
      add(r.potential, money.currency, money.amount);
      r.potentialItems++;
    }
    const pct = Number(((a.requestedInput ?? {}) as Record<string, unknown>).discountPct ?? 0);
    if (pct > 0 && after(a.resolution?.decidedAt, since)) {
      if (a.status === "approved") r.discounts.granted++;
      else if (a.status === "declined" && !a.resolution?.decidedBy.startsWith("customer:") && !a.resolution?.decidedBy.startsWith("runtime:")) r.discounts.refused++;
    }
  }
  for (const c of conversations) {
    const active = c.messages.some((m) => m.role === "customer" && after(m.at, since));
    if (!active) continue;
    r.activeConversations++;
    const ledger = readLedger(c);
    const convoApprovals = approvals.filter((a) => a.conversationId === c.id);
    const convoPayments = payments.filter((p) => p.conversationId === c.id);
    const intent =
      ledger.some((e) => /^cart\.line_(added|updated|replaced)$|^payment\.link_created$|^booking\.created$|^write\.blocked$/.test(e.effect)) ||
      convoPayments.length > 0 ||
      convoApprovals.some((a) => paymentApprovalAmount(a));
    const converted = convoPayments.some(isVerifiedPaid) || bookings.some((b) => b.conversationId === c.id && b.status === "confirmed");
    if (intent) r.purchaseIntentConversations++;
    if (intent && converted) r.convertedConversations++;
    const lost =
      !converted &&
      intent &&
      (c.outcome === "lost" ||
        ledger.some((e) => e.status === "withdrawn") ||
        convoPayments.some((p) => p.status === "failed" || p.status === "cancelled" || (p.status === "pending" && now.getTime() - Date.parse(p.createdAt) > ABANDON_AFTER_MS)));
    if (lost) r.lostOpportunities++;
    if (convoApprovals.length > 0 || readHandoffs(c).length > 0) r.ownerInterventions++;
  }
  return r;
}
