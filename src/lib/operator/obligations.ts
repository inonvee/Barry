import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { BookingRecord, CommerceCartRecord, OperatorRecord, PaymentRequestRecord } from "@/lib/store/types";
import type { Cart } from "@/lib/commerce/types";
import { DEFAULT_FOLLOW_UP_POLICY, ruleFor, type FollowUpPolicy } from "./policy";
import { getBackend } from "@/lib/store";
import type { ApprovalWithLifecycle } from "@/lib/runtime/owner-requests";
import { readHandoffs } from "@/lib/runtime/handoff";
import { readLedger } from "@/lib/runtime/ledger";
import { readDeliveries } from "@/lib/channels/gateway";
import { isSimulatedPayment } from "@/lib/owner/revenue";

/**
 * OPERATIONAL OBLIGATIONS — the durable, first-class model of future work BARRY owes the business or a
 * customer: an unpaid link to follow up, an approval blocking a sale, a handoff nobody resolved, a
 * held request to re-check, a failed action with a recovery step, a reply that never arrived, a booking
 * without its deposit.
 *
 * DERIVED from trusted records only (payments, approvals, handoffs, ledger, deliveries, bookings) with an
 * injected clock, then RECONCILED with the stored records: one record per idempotency key, created when
 * the condition appears, updated when its state changes, closed with EVIDENCE when the condition is gone
 * (payment verified → completed; approval declined → cancelled; newer revision → superseded). No
 * immortal follow-ups, no duplicates, no invented conditions. The model may later explain or prioritise
 * an obligation; it never establishes one.
 */

export type { ObligationKind, ObligationStatus, NextMove, Obligation } from "./obligation-model";
export { OPEN_STATUSES, NEXT_MOVE_WORDS, isOpen } from "./obligation-model";
import { OPEN_STATUSES, type NextMove, type Obligation } from "./obligation-model";

export type ObligationInput = {
  graph: BusinessGraph;
  conversations: ConversationState[];
  approvals: ApprovalWithLifecycle[];
  payments: PaymentRequestRecord[];
  bookings: BookingRecord[];
  /** Carts (for abandoned-checkout recovery); absent = not derived. */
  carts?: CommerceCartRecord[];
  /** The business's follow-up policy (defaults when absent) and the attempts already made per obligation key. */
  policy?: FollowUpPolicy;
  attempts?: Record<string, { count: number; lastAt?: string; sent?: number; dryRun?: number }>;
  now: Date;
  /** Optional: an owner-words label for a conversation's customer (falls back to the stored name or "Customer"). */
  customerLabel?: (c: ConversationState) => string;
};

const H = 3600_000;
const D = 24 * H;
const FOLLOW_UP_AFTER_MS = D;
const ABANDON_AFTER_MS = 7 * D;
const RECENT_MS = 7 * D;

type Derived = Omit<Obligation, "businessId" | "createdAt" | "updatedAt" | "completion" | "cancellation" | "supersededBy">;

function label(c: ConversationState | undefined, fn?: (c: ConversationState) => string): string {
  if (!c) return "Customer";
  if (fn) return fn(c);
  return c.knownFields.name?.trim() || "Customer";
}

const money = (amount: number, currency: string) => `${amount} ${currency}`;

/** The obligations the records imply RIGHT NOW (pure; deterministic in `now`). */
export function deriveObligations(input: ObligationInput): Derived[] {
  const { graph, conversations, approvals, payments, bookings, now } = input;
  const t = now.getTime();
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const who = (id: string) => label(byId.get(id), input.customerLabel);
  const out: Derived[] = [];
  const paidIn = (conversationId: string) => payments.some((p) => p.conversationId === conversationId && p.status === "paid" && p.verifiedAt);
  const policy = input.policy ?? DEFAULT_FOLLOW_UP_POLICY;
  /** count = the policy budget; sent = what really reached the customer (callers that predate the split mean sent). */
  const attemptsOf = (key: string) => {
    const a = input.attempts?.[key] ?? { count: 0 };
    return { count: a.count, lastAt: a.lastAt, sent: a.sent ?? (a.dryRun ? Math.max(0, a.count - a.dryRun) : a.count), dryRun: a.dryRun ?? 0 };
  };
  const tried = (a: ReturnType<typeof attemptsOf>) => (a.count ? { attempts: a.count, sentAttempts: a.sent, lastAttemptAt: a.lastAt } : {});
  /** Can BARRY act on this key under the policy (enabled, attempts left, interval elapsed)? */
  const barryCanAct = (key: string, kind: Parameters<typeof ruleFor>[1]) => {
    const rule = ruleFor(policy, kind);
    if (!rule || !rule.enabled) return { can: false, exhausted: false, rule };
    const a = attemptsOf(key);
    if (a.count >= rule.maxAttempts) return { can: false, exhausted: true, rule };
    if (a.lastAt && t - Date.parse(a.lastAt) < rule.intervalHours * H) return { can: false, exhausted: false, rule, waiting: true };
    return { can: true, exhausted: false, rule };
  };

  // 1. Unpaid payment links.
  for (const p of payments) {
    if (p.status !== "pending" || t - Date.parse(p.createdAt) > ABANDON_AFTER_MS) continue;
    const key = `unpaid_payment_followup:${p.id}`;
    const act = barryCanAct(key, "unpaid_payment_followup");
    const eligibleAt = new Date(Date.parse(p.createdAt) + (act.rule ? act.rule.afterHours * H : FOLLOW_UP_AFTER_MS)).toISOString();
    const due = t >= Date.parse(eligibleAt);
    const a = attemptsOf(key);
    const move: NextMove = !due ? "waiting_on_customer" : act.can ? "barry_can_act" : act.exhausted ? "needs_owner" : "waiting_on_customer";
    out.push({
      key,
      kind: "unpaid_payment_followup",
      source: `payment request ${p.id}`,
      evidence: [`payment request ${p.id.slice(0, 12)} · pending · created ${p.createdAt}${isSimulatedPayment(p) ? " · simulated provider" : ""}`],
      conversationId: p.conversationId,
      customer: who(p.conversationId),
      subject: `${money(p.amount, p.currency)} payment link`,
      reason: due ? (a.sent ? `BARRY reminded the customer ${a.sent} time${a.sent === 1 ? "" : "s"}; the provider still hasn't reported a payment.` : a.dryRun ? "Test mode: BARRY prepared a reminder but sent nothing; the provider still hasn't reported a payment." : "The payment link has been unpaid past the follow-up delay.") : "A payment link was sent and the provider hasn't reported a payment.",
      desiredOutcome: "The provider reports the payment as paid.",
      nextAction: move === "barry_can_act" ? "BARRY sends one reminder with the same link (bounded by your follow-up rules)." : move === "needs_owner" ? "BARRY's reminders are used up; ask the customer yourself whether they still want it." : a.sent ? "Waiting for the customer after BARRY's reminder." : a.dryRun ? "Test mode: the reminder was recorded, not sent — the customer hasn't been contacted." : "Wait for the customer to pay; BARRY follows up after the delay in your rules.",
      nextMove: move,
      owner: move === "barry_can_act" ? "barry" : move === "needs_owner" ? "owner" : "customer",
      eligibleAt,
      dueAt: eligibleAt,
      status: move === "barry_can_act" || move === "needs_owner" ? "actionable" : "waiting_on_customer",
      authority: "none",
      capability: "payments.create_request",
      amount: p.amount,
      currency: p.currency,
      simulated: isSimulatedPayment(p),
      ...tried(a),
    });
  }

  // 1b. Abandoned checkouts: a cart with lines that reached checkout (or sat open) with no payment after it.
  for (const r of input.carts ?? []) {
    const cart = r.data as Cart | undefined;
    if (!cart || !cart.lines?.length || r.status === "ordered") continue;
    if (t - Date.parse(r.updatedAt) > ABANDON_AFTER_MS) continue;
    const paymentAfter = payments.some((p) => p.conversationId === r.conversationId && p.createdAt >= r.updatedAt);
    if (paymentAfter || paidIn(r.conversationId)) continue;
    const key = `abandoned_checkout_recovery:${r.cartId}`;
    const act = barryCanAct(key, "abandoned_checkout_recovery");
    if (!act.rule || !act.rule.enabled) continue;
    const eligibleAt = new Date(Date.parse(r.updatedAt) + act.rule.afterHours * H).toISOString();
    const due = t >= Date.parse(eligibleAt);
    const a = attemptsOf(key);
    const move: NextMove = !due ? "scheduled_for_later" : act.can ? "barry_can_act" : "waiting_on_customer";
    out.push({
      key,
      kind: "abandoned_checkout_recovery",
      source: `cart ${r.cartId}`,
      evidence: [`cart ${r.cartId.slice(0, 12)} · ${r.status} · ${cart.lines.length} line${cart.lines.length === 1 ? "" : "s"} · last change ${r.updatedAt}`, "no payment request after the last cart change"],
      conversationId: r.conversationId,
      customer: who(r.conversationId),
      subject: `${money(cart.total.amount, cart.total.currency)} cart left ${r.status === "checkout" ? "at checkout" : "open"}`,
      reason: a.sent ? "BARRY sent one recovery message; the customer hasn't come back." : a.dryRun ? "Test mode: BARRY prepared a recovery message but sent nothing; the customer hasn't been contacted." : "The customer built a cart and did not continue to payment.",
      desiredOutcome: "The customer completes the checkout or says they don't want it.",
      nextAction: move === "barry_can_act" ? "BARRY asks once whether they'd like to complete it (nothing is charged)." : move === "scheduled_for_later" ? "BARRY waits the delay in your rules before asking." : a.sent ? "Waiting for the customer after BARRY's message." : "Test mode: the message was recorded, not sent — the customer hasn't been contacted.",
      nextMove: move,
      owner: move === "barry_can_act" ? "barry" : "customer",
      eligibleAt,
      dueAt: eligibleAt,
      status: move === "barry_can_act" ? "actionable" : move === "scheduled_for_later" ? "scheduled" : "waiting_on_customer",
      authority: "none",
      capability: "commerce.checkout.create",
      amount: cart.total.amount,
      currency: cart.total.currency,
      ...tried(a),
    });
  }

  // 2. Approvals: active (owner decides) and held (owner re-checks).
  for (const a of approvals) {
    if (a.lifecycle !== "active" && a.lifecycle !== "held") continue;
    const held = a.lifecycle === "held";
    const input_ = (a.requestedInput ?? {}) as Record<string, unknown>;
    const amount = typeof input_.amount === "number" ? input_.amount : undefined;
    const currency = typeof input_.currency === "string" ? input_.currency : undefined;
    out.push({
      key: `${held ? "held_request_recheck" : "approval_blocking_transaction"}:${a.id}`,
      kind: held ? "held_request_recheck" : "approval_blocking_transaction",
      source: `approval ${a.id}`,
      evidence: [`request ${a.id.slice(0, 12)} · ${a.lifecycle} · revision ${a.revision} · ${a.createdAt}`],
      conversationId: a.conversationId,
      customer: who(a.conversationId),
      subject: a.summary,
      reason: held ? "The customer wrote after this request and BARRY couldn't verify what they meant; it must be re-checked before anything runs." : "The business's rules require the owner's approval before this runs.",
      desiredOutcome: held ? "The request is re-checked, then decided." : "The owner approves or declines; BARRY resumes exactly the approved action once.",
      nextAction: held ? "Re-check customer correction on the Today card, then decide." : "Approve or decline on the Today card.",
      nextMove: "needs_owner",
      owner: "owner",
      eligibleAt: a.createdAt,
      status: "waiting_on_owner",
      authority: "owner_approval",
      approvalId: a.id,
      capability: a.requestedAction,
      ...(amount !== undefined && currency ? { amount, currency } : {}),
    });
  }

  for (const c of conversations) {
    // 3. Handoffs.
    for (const h of readHandoffs(c).filter((h) => h.status !== "resolved")) {
      out.push({
        key: `unresolved_handoff:${h.id}`,
        kind: "unresolved_handoff",
        source: `handoff ${h.id}`,
        evidence: [`handoff ${h.id.slice(0, 12)} · ${h.status} · ${h.trigger} · ${h.createdAt}`],
        conversationId: c.id,
        customer: who(c.id),
        subject: h.reason,
        reason: h.trigger === "customer_asked" ? "The customer asked for a person." : h.trigger === "ai_unavailable" ? "BARRY couldn't understand the customer twice in a row." : "BARRY couldn't help with what the customer needs.",
        desiredOutcome: "A person replies to the customer and resolves the handoff.",
        nextAction: h.status === "open" ? "Read the conversation and reply from your own channel, then mark it resolved." : "Reply to the customer, then mark it resolved.",
        nextMove: "needs_owner",
        owner: "owner",
        eligibleAt: h.createdAt,
        ...(h.urgency === "urgent" ? { dueAt: new Date(Date.parse(h.createdAt) + 2 * H).toISOString() } : {}),
        status: "waiting_on_owner",
        authority: "none",
      });
    }
    // 4. Failed consequential action with a recovery step (the most recent effect of that operation failed).
    const ledger = readLedger(c);
    const lastByOp = new Map<string, (typeof ledger)[number]>();
    for (const e of ledger) if (e.operation !== "understand" && e.status !== "no_effect") lastByOp.set(e.operation, e);
    for (const e of lastByOp.values()) {
      if (e.status !== "failed" || t - Date.parse(e.at) > RECENT_MS) continue;
      out.push({
        key: `failed_action_recovery:${c.id}:${e.operation}`,
        kind: "failed_action_recovery",
        source: `ledger #${e.seq}`,
        evidence: [`ledger #${e.seq} ${e.effect} · failed · ${e.at}`],
        conversationId: c.id,
        customer: who(c.id),
        subject: e.describes,
        reason: "BARRY tried it and the system did not go through; the customer was told.",
        desiredOutcome: `${e.describes} succeeds on a retry, or the customer is served another way.`,
        nextAction: "BARRY retries when the customer asks again; check the system if it keeps failing.",
        nextMove: "barry_can_act",
        owner: "barry",
        eligibleAt: e.at,
        status: "actionable",
        authority: "none",
        capability: e.operation,
      });
    }
    // 5. Undelivered reply.
    const deliveries = readDeliveries(c.knownFields);
    const lastDelivery = deliveries.at(-1);
    if (lastDelivery?.status === "failed" && t - Date.parse(lastDelivery.at) <= RECENT_MS) {
      out.push({
        key: `undelivered_reply:${c.id}:${lastDelivery.inboundId}`,
        kind: "undelivered_reply",
        source: `delivery ${lastDelivery.inboundId}`,
        evidence: [`delivery failed at ${lastDelivery.at} on ${lastDelivery.channel}${lastDelivery.error ? ` · ${lastDelivery.error}` : ""}`],
        conversationId: c.id,
        customer: who(c.id),
        subject: `Reply on ${lastDelivery.channel}`,
        reason: "BARRY's reply was not delivered.",
        desiredOutcome: "The customer receives an answer.",
        nextAction: "Reply from your own channel; BARRY team checks the channel.",
        nextMove: "needs_owner",
        owner: "owner",
        eligibleAt: lastDelivery.at,
        status: "actionable",
        authority: "none",
        capability: `channel.${lastDelivery.channel}`,
      });
    }
  }

  // 6. Booking without its required deposit.
  for (const b of bookings) {
    if (b.status !== "confirmed") continue;
    const offer = graph.offers.find((o) => o.id === b.offerId);
    if (!offer?.depositAmount || paidIn(b.conversationId) || Date.parse(b.start) < t) continue;
    const soon = Date.parse(b.start) - t <= 2 * D;
    out.push({
      key: `booking_deposit_missing:${b.id}`,
      kind: "booking_deposit_missing",
      source: `booking ${b.id}`,
      evidence: [`booking ${b.id.slice(0, 12)} · ${offer.name} · confirmed · starts ${b.start}`, "no verified payment in this conversation"],
      conversationId: b.conversationId,
      customer: who(b.conversationId),
      subject: `${offer.name} deposit (${money(offer.depositAmount, offer.currency)})`,
      reason: "The booking is confirmed but its deposit hasn't been paid.",
      desiredOutcome: "The deposit is paid before the appointment.",
      nextAction: soon ? "Confirm with the customer or collect the deposit in your channel." : "BARRY sends a deposit link when the customer asks; follow up if it isn't paid two days before.",
      nextMove: soon ? "needs_owner" : "waiting_on_customer",
      owner: soon ? "owner" : "customer",
      eligibleAt: b.createdAt,
      dueAt: b.start,
      status: soon ? "actionable" : "waiting_on_customer",
      authority: "none",
      amount: offer.depositAmount,
      currency: offer.currency,
    });
  }

  // 7. Appointment reminders (when the business allows them): a confirmed booking within the next day.
  for (const b of bookings) {
    if (b.status !== "confirmed" || Date.parse(b.start) < t || Date.parse(b.start) - t > D) continue;
    const key = `appointment_reminder:${b.id}`;
    const act = barryCanAct(key, "appointment_reminder");
    if (!act.rule || !act.rule.enabled) continue;
    const a = attemptsOf(key);
    const offer = graph.offers.find((o) => o.id === b.offerId);
    out.push({
      key,
      kind: "appointment_reminder",
      source: `booking ${b.id}`,
      evidence: [`booking ${b.id.slice(0, 12)} · confirmed · starts ${b.start}`],
      conversationId: b.conversationId,
      customer: who(b.conversationId),
      subject: `${offer?.name ?? "appointment"} reminder`,
      reason: a.sent ? "BARRY sent the reminder." : a.dryRun ? "Test mode: the reminder was recorded, not sent." : "The appointment is within a day.",
      desiredOutcome: "The customer shows up (or reschedules in time).",
      nextAction: act.can ? "BARRY sends one reminder with the time." : a.sent ? "Reminder sent; nothing else to do." : a.dryRun ? "Test mode: the reminder was recorded, not sent." : "Reminders are off in your rules.",
      nextMove: act.can ? "barry_can_act" : "waiting_on_customer",
      owner: act.can ? "barry" : "customer",
      eligibleAt: new Date(Date.parse(b.start) - D).toISOString(),
      dueAt: b.start,
      status: act.can ? "actionable" : "waiting_on_customer",
      authority: "none",
      ...tried(a),
    });
  }
  return out;
}

/** Why a stored, still-open obligation is closed now, from the records — or undefined when it is still live. */
function closure(o: Obligation, input: ObligationInput): Pick<Obligation, "status" | "completion" | "cancellation" | "supersededBy"> | undefined {
  const at = input.now.toISOString();
  const byId = new Map(input.conversations.map((c) => [c.id, c]));
  switch (o.kind) {
    case "unpaid_payment_followup": {
      const p = input.payments.find((x) => `unpaid_payment_followup:${x.id}` === o.key);
      if (!p) return { status: "cancelled", cancellation: { at, reason: "payment request no longer exists" } };
      if (p.status === "paid" && p.verifiedAt) return { status: "completed", completion: { at: p.verifiedAt, evidence: `payment request ${p.id.slice(0, 12)} verified paid ${p.verifiedAt}` } };
      if (p.status === "failed" || p.status === "cancelled") return { status: "cancelled", cancellation: { at, reason: `payment ${p.status}` } };
      if (input.now.getTime() - Date.parse(p.createdAt) > ABANDON_AFTER_MS) return { status: "cancelled", cancellation: { at, reason: "unpaid for more than 7 days: treated as abandoned" } };
      return undefined;
    }
    case "approval_blocking_transaction":
    case "held_request_recheck": {
      const a = input.approvals.find((x) => x.id === o.approvalId);
      if (!a) return { status: "cancelled", cancellation: { at, reason: "request no longer exists" } };
      if (a.lifecycle === "active" || a.lifecycle === "held") return undefined;
      if (a.lifecycle === "superseded") {
        const newer = input.approvals.filter((x) => x.conversationId === a.conversationId && x.id !== a.id && (x.lifecycle === "active" || x.lifecycle === "held")).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
        return { status: "superseded", ...(newer ? { supersededBy: `${newer.lifecycle === "held" ? "held_request_recheck" : "approval_blocking_transaction"}:${newer.id}` } : {}) };
      }
      if (["approved", "executed", "executed_unconfirmed", "failed"].includes(a.lifecycle)) {
        return { status: "completed", completion: { at: a.resolution?.decidedAt ?? at, evidence: `request ${a.id.slice(0, 12)} ${a.lifecycle}${a.result?.reference ? ` · ${a.result.reference}` : ""}` } };
      }
      return { status: "cancelled", cancellation: { at: a.resolution?.decidedAt ?? at, reason: `request ${a.lifecycle}` } };
    }
    case "unresolved_handoff": {
      const id = o.key.slice("unresolved_handoff:".length);
      const c = byId.get(o.conversationId);
      const h = c ? readHandoffs(c).find((x) => x.id === id) : undefined;
      if (!h) return { status: "cancelled", cancellation: { at, reason: "handoff no longer exists" } };
      if (h.status === "resolved") return { status: "completed", completion: { at: h.resolvedAt ?? at, evidence: `handoff ${h.id.slice(0, 12)} resolved${h.resolvedBy ? ` by ${h.resolvedBy}` : ""}` } };
      return undefined;
    }
    case "failed_action_recovery": {
      const c = byId.get(o.conversationId);
      if (!c) return { status: "cancelled", cancellation: { at, reason: "conversation no longer exists" } };
      const later = readLedger(c).find((e) => e.operation === o.capability && (e.status === "effected" || e.status === "effected_unconfirmed") && e.at > o.eligibleAt);
      if (later) return { status: "completed", completion: { at: later.at, evidence: `ledger #${later.seq} ${later.effect} · ${later.status}` } };
      if (input.now.getTime() - Date.parse(o.eligibleAt) > RECENT_MS) return { status: "cancelled", cancellation: { at, reason: "no retry within 7 days" } };
      return undefined;
    }
    case "undelivered_reply": {
      const c = byId.get(o.conversationId);
      const later = c ? readDeliveries(c.knownFields).find((d) => d.at > o.eligibleAt && d.status !== "failed") : undefined;
      if (later) return { status: "completed", completion: { at: later.at, evidence: `a later reply was ${later.status} on ${later.channel}` } };
      if (input.now.getTime() - Date.parse(o.eligibleAt) > RECENT_MS) return { status: "cancelled", cancellation: { at, reason: "no later delivery within 7 days" } };
      return undefined;
    }
    case "abandoned_checkout_recovery": {
      const later = input.payments.find((p) => p.conversationId === o.conversationId && p.createdAt >= o.createdAt);
      if (later) return { status: "completed", completion: { at, evidence: `payment request ${later.id} created after the recovery (${later.status})` } };
      return { status: "cancelled", cancellation: { at, reason: "the cart was ordered, emptied or aged out" } };
    }
    case "appointment_reminder":
      return { status: "completed", completion: { at, evidence: "the appointment time passed or the booking changed" } };
    case "booking_deposit_missing": {
      const b = input.bookings.find((x) => `booking_deposit_missing:${x.id}` === o.key);
      if (!b || b.status !== "confirmed") return { status: "cancelled", cancellation: { at, reason: "booking cancelled or gone" } };
      const paid = input.payments.find((p) => p.conversationId === b.conversationId && p.status === "paid" && p.verifiedAt);
      if (paid) return { status: "completed", completion: { at: paid.verifiedAt!, evidence: `payment request ${paid.id.slice(0, 12)} verified paid` } };
      if (Date.parse(b.start) < input.now.getTime()) return { status: "cancelled", cancellation: { at, reason: "appointment time passed" } };
      return undefined;
    }
  }
}

function fromRecord(r: OperatorRecord): Obligation {
  return r.data as unknown as Obligation;
}

const LIVE_FIELDS: (keyof Derived)[] = ["status", "nextMove", "nextAction", "owner", "reason", "dueAt", "eligibleAt", "subject", "customer", "amount", "currency", "evidence", "attempts", "sentAttempts", "lastAttemptAt"];

/**
 * Reconcile the derived obligations with the stored ones: create, update (only when something changed),
 * close with evidence. Returns every obligation still open plus those closed in the last 7 days.
 */
export async function reconcileObligations(input: ObligationInput): Promise<Obligation[]> {
  const businessId = input.graph.business.id;
  const backend = getBackend();
  const at = input.now.toISOString();
  const stored = new Map((await backend.listOperatorRecords(businessId, "obligation")).map((r) => [r.key, fromRecord(r)]));
  const derived = deriveObligations(input);
  const result: Obligation[] = [];
  const writes: Obligation[] = [];
  const seen = new Set<string>();
  for (const d of derived) {
    seen.add(d.key);
    const prev = stored.get(d.key);
    if (!prev) {
      const o: Obligation = { ...d, businessId, createdAt: at, updatedAt: at };
      writes.push(o);
      result.push(o);
      continue;
    }
    if (!OPEN_STATUSES.includes(prev.status)) {
      // A closed obligation whose condition is back (e.g. a payment reopened): the record is reopened, never duplicated.
      const o: Obligation = { ...prev, ...d, businessId, updatedAt: at, completion: undefined, cancellation: undefined, supersededBy: undefined };
      writes.push(o);
      result.push(o);
      continue;
    }
    const changed = LIVE_FIELDS.some((f) => JSON.stringify(prev[f as keyof Obligation]) !== JSON.stringify(d[f]));
    const o: Obligation = changed ? { ...prev, ...d, businessId, updatedAt: at } : prev;
    if (changed) writes.push(o);
    result.push(o);
  }
  for (const prev of stored.values()) {
    if (seen.has(prev.key)) continue;
    if (OPEN_STATUSES.includes(prev.status)) {
      const close = closure(prev, input) ?? { status: "cancelled" as const, cancellation: { at, reason: "the condition is no longer present in the records" } };
      const o: Obligation = { ...prev, ...close, updatedAt: at };
      writes.push(o);
      result.push(o);
    } else if (input.now.getTime() - Date.parse(prev.updatedAt) <= RECENT_MS) {
      result.push(prev);
    }
  }
  for (const o of writes) await backend.upsertOperatorRecord({ businessId, kind: "obligation", key: o.key, data: o as unknown as Record<string, unknown> });
  return result.sort((a, b) => Number(!OPEN_STATUSES.includes(a.status)) - Number(!OPEN_STATUSES.includes(b.status)) || MOVE_ORDER[a.nextMove] - MOVE_ORDER[b.nextMove] || (a.dueAt ?? a.eligibleAt).localeCompare(b.dueAt ?? b.eligibleAt));
}

const MOVE_ORDER: Record<NextMove, number> = { needs_owner: 0, barry_can_act: 1, blocked_by_capability: 2, waiting_on_customer: 3, scheduled_for_later: 4 };
