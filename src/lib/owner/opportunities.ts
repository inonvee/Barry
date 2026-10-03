import type { BusinessGraph } from "@/lib/business-graph";
import { lastSaid } from "@/lib/operator/execution-state";
import type { ConversationState } from "@/lib/state";
import type { BookingRecord, CommerceOrderRecord, PaymentRequestRecord } from "@/lib/store/types";
import { readLedger } from "@/lib/runtime/ledger";
import { readHandoffs } from "@/lib/runtime/handoff";
import { SCRATCH_KEYS } from "@/lib/runtime/compiler";
import type { ApprovalWithLifecycle } from "@/lib/runtime/owner-requests";
import { money } from "@/lib/reasoner/deterministic-compose";
import { isSimulatedBooking, isSimulatedPayment, isVerifiedPaid, type Money } from "./revenue";

/**
 * REVENUE OPPORTUNITIES — where money is stuck, at risk or waiting, and what moves it.
 *
 * Every item stands on records (a payment request, a request to the owner, a cart receipt, a booking,
 * an enquiry, a blocked write) and says whose move it is: the owner's, the customer's, or BARRY's.
 * Amounts are the records' own; nothing is projected or invented. Simulated providers are shown but
 * never counted in the money totals.
 */

export type OpportunityKind = "unpaid_link" | "approval_blocking_sale" | "held_blocking_sale" | "stalled_purchase" | "payment_failed" | "unpaid_deposit" | "enquiry_open" | "blocked_by_limit";

export type Opportunity = {
  id: string;
  kind: OpportunityKind;
  customer: string;
  conversationId: string;
  since: string;
  ageHours: number;
  amount?: number;
  currency?: string;
  simulated: boolean;
  /** The records this stands on. */
  evidence: string[];
  /** Why this is an opportunity (or a risk), from those records. */
  reasoning: string;
  /** Whose move it is and what that move is; a link into the intervention queue when it's the owner's decision. */
  next: { who: "you" | "customer" | "barry"; action: string; interventionId?: string };
  /** Money that can still be won by acting (as opposed to merely waiting). */
  recoverable: boolean;
};

export type OpportunitySummary = {
  /** Amounts whose next move is the owner's (per currency; simulated excluded). */
  stuckWithYou: Money;
  /** Amounts whose next move is the customer's. */
  waitingOnCustomer: Money;
  /** Amounts likely lost unless someone acts (old unpaid links, failed payments, stalled purchases). */
  atRisk: Money;
  items: number;
  simulatedItems: number;
  /** Test money in motion (simulated providers): shown and labelled, never inside the three real figures. */
  simulated: Money;
};

export type OpportunityInput = {
  graph: BusinessGraph;
  conversations: ConversationState[];
  approvals: ApprovalWithLifecycle[];
  payments: PaymentRequestRecord[];
  bookings: BookingRecord[];
  orders: CommerceOrderRecord[];
  customerLabel: (c: ConversationState) => string;
  now?: Date;
};

const HOUR = 3600 * 1000;
const ABANDON_AFTER_H = 24;
const MAX_AGE_DAYS = 30;
export { isAtRisk } from "./opportunity-risk";
import { isAtRisk } from "./opportunity-risk";

const add = (m: Money, currency: string, amount: number) => {
  m[currency] = Math.round(((m[currency] ?? 0) + amount) * 100) / 100;
};
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function paymentAmount(a: ApprovalWithLifecycle): { amount: number; currency: string } | undefined {
  const i = (a.requestedInput ?? {}) as Record<string, unknown>;
  return typeof i.amount === "number" && typeof i.currency === "string" ? { amount: i.amount, currency: i.currency } : undefined;
}

function cartTotal(c: ConversationState): { amount: number; currency: string } | undefined {
  try {
    const raw = c.knownFields[SCRATCH_KEYS.commerceCartTotal];
    if (!raw) return undefined;
    const t = JSON.parse(raw) as { amount?: unknown; currency?: unknown };
    return typeof t.amount === "number" && t.amount > 0 && typeof t.currency === "string" ? { amount: t.amount, currency: t.currency } : undefined;
  } catch {
    return undefined;
  }
}

export function revenueOpportunities(input: OpportunityInput): { items: Opportunity[]; summary: OpportunitySummary } {
  const now = input.now ?? new Date();
  const byId = new Map(input.conversations.map((c) => [c.id, c]));
  const label = (id: string) => (byId.get(id) ? input.customerLabel(byId.get(id)!) : "Customer");
  const age = (iso: string) => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / HOUR));
  const tooOld = (iso: string) => now.getTime() - Date.parse(iso) > MAX_AGE_DAYS * 24 * HOUR;
  const paidIn = (conversationId: string, after?: string) => input.payments.some((p) => p.conversationId === conversationId && isVerifiedPaid(p) && (!after || p.createdAt >= after));
  const items: Opportunity[] = [];

  for (const p of input.payments) {
    if (tooOld(p.createdAt) || paidIn(p.conversationId, p.createdAt)) continue;
    const base = { customer: label(p.conversationId), conversationId: p.conversationId, since: p.createdAt, ageHours: age(p.createdAt), amount: p.amount, currency: p.currency, simulated: isSimulatedPayment(p) };
    const ref = `payment request ${p.id.slice(0, 12)} · ${p.provider ?? "no provider"} · ${p.status}`;
    if (p.status === "pending") {
      const old = base.ageHours > ABANDON_AFTER_H;
      items.push({
        id: `unpaid_link:${p.id}`,
        kind: "unpaid_link",
        ...base,
        evidence: [ref, `created ${p.createdAt}`],
        reasoning: old ? `The payment link for ${money(p.amount, p.currency)} has been unpaid for ${Math.round(base.ageHours / 24)} day${Math.round(base.ageHours / 24) === 1 ? "" : "s"}. The provider hasn't reported a payment.` : `The customer has a payment link for ${money(p.amount, p.currency)}; the provider hasn't reported a payment yet.`,
        next: old
          ? { who: "you", action: "Follow up with the customer in your channel and ask whether they still want it. BARRY can't send reminders yet; it will send a fresh link if they ask." }
          : { who: "customer", action: "Waiting for the customer to pay. If it isn't paid within a day it shows here as at risk." },
        recoverable: old,
      });
    } else if (p.status === "failed" || p.status === "cancelled") {
      items.push({
        id: `payment_failed:${p.id}`,
        kind: "payment_failed",
        ...base,
        evidence: [ref],
        reasoning: p.status === "failed" ? `The customer's payment of ${money(p.amount, p.currency)} failed at the provider, and no later payment succeeded.` : `The payment link for ${money(p.amount, p.currency)} was cancelled, and no later payment succeeded.`,
        next: { who: "you", action: "Reach out: the customer got as far as paying. Ask whether they want a new link; BARRY sends one when they ask." },
        recoverable: true,
      });
    }
  }

  for (const a of input.approvals) {
    const m = paymentAmount(a);
    if (!m || (a.lifecycle !== "active" && a.lifecycle !== "held")) continue;
    const held = a.lifecycle === "held";
    items.push({
      id: `${held ? "held_blocking_sale" : "approval_blocking_sale"}:${a.id}`,
      kind: held ? "held_blocking_sale" : "approval_blocking_sale",
      customer: label(a.conversationId),
      conversationId: a.conversationId,
      since: a.createdAt,
      ageHours: age(a.createdAt),
      amount: m.amount,
      currency: m.currency,
      simulated: false,
      evidence: [`request ${a.id.slice(0, 12)} · ${a.lifecycle} · revision ${a.revision}`],
      reasoning: held ? `${money(m.amount, m.currency)} is waiting on a request that can't run until the customer's later message is re-checked.` : `${money(m.amount, m.currency)} is waiting on your approval; nothing is sent to the customer until you decide.`,
      next: held ? { who: "you", action: "Re-check the conversation, then decide.", interventionId: `held_approval:${a.id}` } : { who: "you", action: "Approve or decline the request.", interventionId: `approval:${a.id}` },
      recoverable: true,
    });
  }

  for (const b of input.bookings) {
    if (b.status !== "confirmed" || tooOld(b.createdAt)) continue;
    const offer = input.graph.offers.find((o) => o.id === b.offerId);
    if (!offer?.depositAmount || paidIn(b.conversationId)) continue;
    items.push({
      id: `unpaid_deposit:${b.id}`,
      kind: "unpaid_deposit",
      customer: label(b.conversationId),
      conversationId: b.conversationId,
      since: b.createdAt,
      ageHours: age(b.createdAt),
      amount: offer.depositAmount,
      currency: offer.currency,
      simulated: isSimulatedBooking(b),
      evidence: [`booking ${b.id.slice(0, 12)} · ${offer.name} · ${b.provider ?? "no provider"} · confirmed`, "no verified payment in this conversation"],
      reasoning: `${offer.name} is booked for ${new Date(b.start).toISOString().slice(0, 16).replace("T", " ")} but the ${money(offer.depositAmount, offer.currency)} deposit hasn't been paid — a no-show costs you the slot.`,
      next: { who: "you", action: "Confirm with the customer or collect the deposit in your channel; BARRY sends a deposit link when the customer asks." },
      recoverable: true,
    });
  }

  for (const c of input.conversations) {
    const lastMsg = lastSaid(c);
    if (!lastMsg || tooOld(lastMsg.at)) continue;
    const ledger = readLedger(c);
    const hasOrder = input.orders.some((o) => o.conversationId === c.id);
    const openPayment = input.payments.some((p) => p.conversationId === c.id && p.status === "pending");
    const requestPending = input.approvals.some((a) => a.conversationId === c.id && (a.lifecycle === "active" || a.lifecycle === "held"));
    const lastAge = age(lastMsg.at);

    // A purchase in progress that went quiet: a cart with value (or a chosen priced offer) and no link, no request, no order.
    const cart = cartTotal(c);
    const offer = c.selectedOfferId ? input.graph.offers.find((o) => o.id === c.selectedOfferId) : undefined;
    const value = cart ?? (offer?.price && c.knownFields[SCRATCH_KEYS.purchaseDecided] ? { amount: offer.price, currency: offer.currency } : undefined);
    const lost = c.outcome === "lost" || ledger.at(-1)?.status === "withdrawn";
    if (value && !hasOrder && !openPayment && !requestPending && !paidIn(c.id) && !lost && lastMsg.role === "barry" && lastAge > ABANDON_AFTER_H) {
      const missing = c.missingFields.filter((f) => !f.startsWith("__"));
      items.push({
        id: `stalled_purchase:${c.id}`,
        kind: "stalled_purchase",
        customer: input.customerLabel(c),
        conversationId: c.id,
        since: lastMsg.at,
        ageHours: lastAge,
        amount: value.amount,
        currency: value.currency,
        simulated: false,
        evidence: [cart ? `cart total ${money(cart.amount, cart.currency)} (provider cart)` : `chose ${offer!.name} at ${money(value.amount, value.currency)}`, `last message from BARRY ${lastMsg.at}`],
        reasoning: missing.length ? `BARRY asked for ${missing.join(" and ")} and the customer hasn't answered in ${Math.round(lastAge / 24)} day${Math.round(lastAge / 24) === 1 ? "" : "s"}.` : `The customer stopped replying after BARRY said “${clip(lastMsg.content, 90)}”.`,
        next: { who: "you", action: "Nudge the customer in your channel — what they chose is still there, and BARRY continues the moment they reply." },
        recoverable: true,
      });
    }

    // An enquiry recorded for the team with no outcome since.
    const enquiry = ledger.filter((e) => e.effect === "enquiry.created").at(-1);
    if (enquiry && !ledger.some((e) => e.seq > enquiry.seq && (e.status === "effected" || e.status === "effected_unconfirmed") && /^(payment|booking|order)\./.test(e.effect)) && !readHandoffs(c).some((h) => h.status === "resolved" && h.createdAt > enquiry.at)) {
      items.push({
        id: `enquiry_open:${c.id}:${enquiry.seq}`,
        kind: "enquiry_open",
        customer: input.customerLabel(c),
        conversationId: c.id,
        since: enquiry.at,
        ageHours: age(enquiry.at),
        simulated: false,
        evidence: [`effect #${enquiry.seq} · enquiry.created${enquiry.reference ? ` · ${enquiry.reference}` : ""}`],
        reasoning: "BARRY recorded this enquiry for your team; nothing has been booked, paid or closed since.",
        next: { who: "you", action: "Follow up with the customer; BARRY doesn't chase enquiries on its own." },
        recoverable: true,
      });
    }

    // A checkout the customer's own limits stopped, still where the conversation stands.
    const blocked = ledger.filter((e) => e.effect === "write.blocked").at(-1);
    if (blocked && lastMsg.role === "barry" && !ledger.some((e) => e.seq > blocked.seq && /^payment\.link_created$|^order\./.test(e.effect))) {
      const currency = typeof blocked.terms.currency === "string" ? blocked.terms.currency : (input.graph.offers[0]?.currency ?? "USD");
      const total = typeof blocked.outcome?.total === "number" ? blocked.outcome.total : undefined;
      const reason = String(blocked.outcome?.reason ?? "");
      items.push({
        id: `blocked_by_limit:${c.id}:${blocked.seq}`,
        kind: "blocked_by_limit",
        customer: input.customerLabel(c),
        conversationId: c.id,
        since: blocked.at,
        ageHours: age(blocked.at),
        ...(total !== undefined ? { amount: total, currency } : {}),
        simulated: false,
        evidence: [`effect #${blocked.seq} · write.blocked (${reason || "limit"})`],
        reasoning: reason === "shipping_unknown" ? "The customer's budget includes shipping and BARRY doesn't know your shipping cost, so no link was sent." : reason === "over_budget" ? "The total is above the budget the customer stated, so no link was sent." : "The cart held items the customer hadn't agreed to buy, so BARRY asked first.",
        next:
          reason === "shipping_unknown"
            ? { who: "you", action: "Tell the BARRY team your shipping fee so BARRY can quote totals within a budget.", interventionId: `blocked_write:${c.id}:${blocked.seq}` }
            : { who: "customer", action: "BARRY asked the customer how to proceed; it continues when they answer." },
        recoverable: reason === "shipping_unknown",
      });
    }
  }

  items.sort((x, y) => (y.amount ?? 0) - (x.amount ?? 0) || x.since.localeCompare(y.since));
  const summary: OpportunitySummary = { stuckWithYou: {}, waitingOnCustomer: {}, atRisk: {}, items: items.length, simulatedItems: items.filter((i) => i.simulated).length, simulated: {} };
  for (const i of items) {
    if (i.amount === undefined || !i.currency) continue;
    if (i.simulated) {
      add(summary.simulated, i.currency, i.amount);
      continue;
    }
    if (i.next.who === "you") add(summary.stuckWithYou, i.currency, i.amount);
    if (i.next.who === "customer") add(summary.waitingOnCustomer, i.currency, i.amount);
    if (isAtRisk(i)) add(summary.atRisk, i.currency, i.amount);
  }
  return { items, summary };
}
