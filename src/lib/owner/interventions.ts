import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { PaymentRequestRecord } from "@/lib/store/types";
import { getCapability } from "@/lib/fabric/capability";
import { readLedger, termsAmount, termsOf, type LedgerEntry } from "@/lib/runtime/ledger";
import { readHandoffs, handoffPath, type HandoffRecord } from "@/lib/runtime/handoff";
import type { ApprovalWithLifecycle } from "@/lib/runtime/owner-requests";
import { readDeliveries } from "@/lib/channels/gateway";
import { money } from "@/lib/reasoner/deterministic-compose";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import { conversationStory } from "./story";

/**
 * THE INTERVENTION QUEUE — the one list of everything that needs the owner, whatever kind of record
 * it comes from: a request waiting for approval, a request held until the customer confirms, a
 * customer handed to the team, an operation that failed, a checkout the customer's own limits blocked,
 * a message BARRY couldn't understand, a reply the channel couldn't deliver.
 *
 * Each item answers, from records only: why BARRY escalated, what it already did, exactly what
 * decision is needed, what each option causes, what BARRY resumes afterwards, and whether the item is
 * still current. Nothing here executes anything: the actions point at the existing owner endpoints,
 * which re-check everything (customer intent, the final-write gate) before an effect.
 */

export type InterventionKind = "approval" | "held_approval" | "handoff" | "failed_action" | "blocked_write" | "not_understood" | "delivery_failed";
export type InterventionAction = "approve" | "decline" | "recheck" | "acknowledge" | "resolve" | "open_conversation";

export type InterventionOption = {
  action: InterventionAction;
  label: string;
  /** What happens if the owner picks this (plain words, from how the runtime really behaves). */
  consequence: string;
  primary?: boolean;
  destructive?: boolean;
};

export type Intervention = {
  /** Stable across reloads: kind + the record it stands for. */
  id: string;
  kind: InterventionKind;
  /** 1 = a decision a customer or a sale is waiting on; 2 = something broke; 3 = worth knowing. */
  priority: 1 | 2 | 3;
  customer: string;
  conversationId: string;
  since: string;
  /** One line: what needs the owner. */
  title: string;
  /** Why BARRY escalated (your rule, the customer's ask, the failure). */
  why: string;
  /** What BARRY already did in this conversation, oldest first. */
  tried: string[];
  /** Exactly what is needed from the owner. */
  decision: string;
  options: InterventionOption[];
  /** What happens after / what BARRY resumes on its own. */
  then: string;
  /** Is the item still current, and how BARRY knows. */
  freshness: string;
  amount?: string;
  terms?: Record<string, string | number>;
  /** The records this item stands on. */
  evidence: string[];
  refs: { approvalId?: string; handoffId?: string; paymentRequestId?: string; seq?: number };
};

export type InterventionInput = {
  graph: BusinessGraph;
  conversations: ConversationState[];
  approvals: ApprovalWithLifecycle[];
  payments: PaymentRequestRecord[];
  customerLabel: (c: ConversationState) => string;
  now?: Date;
};

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const RECHECK_NOTE = "Before anything runs, BARRY re-reads what the customer said since and re-checks their own limits; if something changed, it holds instead of running.";

/** The owner's own rule behind an approval, in their words — never a capability id or rule syntax. */
export function whyApproval(graph: BusinessGraph, a: ApprovalWithLifecycle): string {
  const input = (a.requestedInput ?? {}) as Record<string, unknown>;
  const currency = typeof input.currency === "string" ? input.currency : (graph.offers[0]?.currency ?? "USD");
  const rule = graph.authority.find((r) => r.id === a.policyId);
  if (rule) return rule.reason?.trim() ? `Your rule: ${rule.reason.trim()}` : "Your authority rules say you approve this first.";
  const policy = graph.policies.find((p) => p.rule.type === a.policyId);
  switch (policy?.rule.type) {
    case "max_auto_payment_amount":
      return `Above your automatic payment limit of ${money(policy.rule.value, currency)}.`;
    case "max_auto_discount_pct":
      return policy.provenance?.source === "owner_trained" ? `Above the ${policy.rule.value}% you taught BARRY it may give on its own.` : `Above the ${policy.rule.value}% discount BARRY may give on its own.`;
    case "custom_pricing_requires_approval":
      return "Your rules: any custom price needs your approval.";
    case "bookings_auto_allowed":
      return "Your rules: every booking needs your approval.";
    case "refund_requires_approval":
      return "Your rules: refunds need your approval.";
  }
  return a.reason?.trim() ? a.reason : "Your rules say you approve this before BARRY does it.";
}

function systemWords(graph: BusinessGraph, a: ApprovalWithLifecycle): string {
  const input = (a.requestedInput ?? {}) as Record<string, unknown>;
  if (a.requestedAction === INVOKE_CAPABILITY) {
    const purpose = getCapability(String(input.capability))?.purpose;
    return purpose ? purpose.toLowerCase() : "the request";
  }
  return a.summary;
}

/** What BARRY does once the owner approves — by the kind of operation, from how the runtime resumes. */
export function afterApproval(graph: BusinessGraph, a: ApprovalWithLifecycle): string {
  const amount = termsAmount(termsOf(a.requestedAction, a.requestedInput));
  switch (a.requestedAction) {
    case "createCommerceCheckout":
    case "createPaymentRequest":
      return `BARRY sends the payment link${amount ? ` for ${amount}` : ""} in the chat and waits for the payment provider to confirm payment — it counts as collected only once verified. Nothing else runs on its own.`;
    case "grantDiscount":
      return (a.requestedInput as { cartId?: unknown })?.cartId
        ? "BARRY tells the customer the discount is approved and prices their checkout with exactly it, once — nothing is sent or charged by the approval itself."
        : "BARRY tells the customer the discount is approved. Nothing is added to a cart, sent or charged: it applies only if they order this item at this price — if the price changes, it needs a fresh look.";
    case "createBooking":
      return "BARRY books the appointment through your scheduling system and confirms it to the customer.";
    case "refund":
      return "BARRY issues the refund through your payment provider and confirms it to the customer.";
    case INVOKE_CAPABILITY:
      return `BARRY runs it once — ${systemWords(graph, a)} — through your connected system and tells the customer the result, with the reference it returns. If the system doesn't confirm it, the customer is told it isn't confirmed.`;
    default:
      return "BARRY carries it out once and tells the customer the result.";
  }
}

/** The action in a few owner words, from the real proposal — for button labels ("Approve ₪2480 payment link"). */
export function actionWords(graph: BusinessGraph, a: ApprovalWithLifecycle): string {
  const terms = termsOf(a.requestedAction, a.requestedInput);
  const amount = termsAmount(terms);
  switch (a.requestedAction) {
    case "createCommerceCheckout":
    case "createPaymentRequest":
      return `${amount ? `${amount} ` : ""}payment link${typeof terms.discountPct === "number" && terms.discountPct > 0 ? ` with ${terms.discountPct}% off` : ""}`;
    case "grantDiscount": {
      const pct = Number(terms.discountPct);
      const list = typeof terms.listAmount === "number" && typeof terms.currency === "string" ? ` (${money(terms.listAmount, terms.currency)} → ${money(Math.round(terms.listAmount * (100 - pct)) / 100, terms.currency)})` : "";
      return `${pct}% off ${terms.item === "the whole cart" ? "the whole cart" : String(terms.item ?? "the cart")}${list}`;
    }
    case "createBooking":
      return "booking";
    case "refund":
      return `${amount ? `${amount} ` : ""}refund`;
    case INVOKE_CAPABILITY: {
      const purpose = systemWords(graph, a).replace(/\.$/, "");
      const ref = Object.values(terms).find((v) => typeof v === "string" && /\d/.test(v));
      return `${purpose}${ref ? ` (${ref})` : ""}`;
    }
    default:
      return a.summary.length > 40 ? `${a.summary.slice(0, 39)}…` : a.summary;
  }
}

function holdWords(a: ApprovalWithLifecycle): string {
  if (a.hold?.reason === "conflicting_reference") return `After this request the customer wrote ${a.hold.detail ?? "a different reference"}, which conflicts with it — BARRY won't run the old terms.`;
  return "After this request the customer sent a message BARRY couldn't understand — it may have changed or withdrawn the request, so BARRY won't run it yet.";
}

function approvalItem(graph: BusinessGraph, a: ApprovalWithLifecycle, convo: ConversationState | undefined, customer: string): Intervention {
  const terms = termsOf(a.requestedAction, a.requestedInput);
  const amount = termsAmount(terms);
  const story = convo ? conversationStory(convo) : undefined;
  const held = a.lifecycle === "held";
  const what = a.summary;
  const evidence = [`request ${a.id.slice(0, 12)} · revision ${a.revision} · ${new Date(a.createdAt).toISOString()}`];
  if (held) {
    return {
      id: `held_approval:${a.id}`,
      kind: "held_approval",
      priority: 1,
      customer,
      conversationId: a.conversationId,
      since: a.createdAt,
      title: `Held: ${what} for ${customer}`,
      why: holdWords(a),
      tried: story?.tried ?? [],
      decision: "Re-check the conversation before deciding. Approve isn't offered while the request may be stale.",
      options: [
        { action: "recheck", label: "Re-check customer correction", primary: true, consequence: "BARRY re-reads the customer's later message. If it changed the request, this one is replaced and the corrected request comes back to you; if it withdrew it, it's cancelled; if unrelated, this request becomes approvable." },
        { action: "decline", label: "Decline", destructive: true, consequence: "BARRY tells the customer this can't be done; nothing is sent or changed." },
      ],
      then: "After a successful re-check BARRY tells the customer what happened to the earlier request and, if there is a corrected one, that it's waiting for you.",
      freshness: "Not current: the customer wrote after this request and BARRY couldn't verify what they meant.",
      ...(amount ? { amount } : {}),
      terms,
      evidence,
      refs: { approvalId: a.id },
    };
  }
  return {
    id: `approval:${a.id}`,
    kind: "approval",
    priority: 1,
    customer,
    conversationId: a.conversationId,
    since: a.createdAt,
    title: `Approve ${what} for ${customer}?`,
    why: whyApproval(graph, a),
    tried: story?.tried ?? [],
    decision: `Approve or decline exactly these terms${amount ? ` (${amount})` : ""}. BARRY can't change them for you; a different ask needs a new request from the customer.`,
    options: [
      { action: "approve", label: `Approve ${actionWords(graph, a)}`, primary: true, consequence: `${afterApproval(graph, a)} ${RECHECK_NOTE}` },
      { action: "decline", label: "Decline", destructive: true, consequence: "BARRY tells the customer this can't be done; nothing is sent or changed. The same terms won't be sent to you again." },
    ],
    then: afterApproval(graph, a),
    freshness: a.revision > 1 ? `Current (revision ${a.revision}: the customer changed the details; older revisions were replaced).` : "Current: nothing the customer said since conflicts with it.",
    ...(amount ? { amount } : {}),
    terms,
    evidence,
    refs: { approvalId: a.id },
  };
}

const TRIGGER_WORDS: Record<HandoffRecord["trigger"], string> = {
  customer_asked: "The customer asked for a person",
  barry_cannot_help: "BARRY couldn't help with what the customer needs",
  ai_unavailable: "BARRY couldn't understand two messages in a row",
};

function handoffItem(graph: BusinessGraph, h: HandoffRecord, convo: ConversationState, customer: string): Intervention {
  const path = handoffPath(graph);
  const story = conversationStory(convo);
  return {
    id: `handoff:${h.id}`,
    kind: "handoff",
    priority: h.urgency === "urgent" ? 1 : 2,
    customer,
    conversationId: h.conversationId,
    since: h.createdAt,
    title: `${customer} needs a person${h.urgency === "urgent" ? " — urgent" : ""}`,
    why: `${TRIGGER_WORDS[h.trigger]}: ${h.reason}`,
    tried: story.tried,
    decision: h.unresolved.length ? `Reply to the customer in your own channel about: ${h.unresolved.join("; ")}. Then mark it resolved.` : "Reply to the customer in your own channel, then mark it resolved.",
    options: [
      ...(h.status === "open" ? [{ action: "acknowledge" as const, label: "Acknowledge handoff", consequence: "Marks it as seen by your team. The customer is not messaged." }] : []),
      { action: "resolve", label: "Mark resolved", primary: true, consequence: "Closes it in your inbox. BARRY keeps handling the conversation as usual; it won't claim you replied." },
    ],
    then: h.responseCommitted && path ? `The customer was told your team follows up as your playbook says: “${path}”. BARRY can't send your reply for you yet.` : "The customer was told your team can see this, with no promised reply time. BARRY can't send your reply for you yet.",
    freshness: h.status === "acknowledged" ? `Acknowledged ${h.acknowledgedAt ? new Date(h.acknowledgedAt).toISOString() : ""} — still open until resolved.` : "Open: your team hasn't acknowledged it yet.",
    evidence: [`handoff ${h.id.slice(0, 12)} · ${h.trigger.replace(/_/g, " ")} · ${h.createdAt}`, ...(h.transaction.length ? [`where things stand: ${h.transaction.join(" · ")}`] : [])],
    refs: { handoffId: h.id },
  };
}

const FAILURE_WORDS: Record<string, string> = {
  provider_quota_exhausted: "the AI provider account is out of credit",
  provider_rate_limited: "the AI provider rate-limited BARRY",
  qa_forced_understanding_failure: "a QA test forced this failure",
  provider_unavailable: "the AI provider was unavailable",
  semantic_validation_error: "the AI's understanding wasn't usable",
};

function stepError(convo: ConversationState, e: LedgerEntry): string | undefined {
  for (const t of [...convo.turns].reverse()) {
    if (!t.trace?.effects?.some((x) => x.seq === e.seq)) continue;
    const failed = t.trace.steps.find((s) => s.result && !s.result.ok);
    if (failed?.result && !failed.result.ok) return failed.result.error ? clip(failed.result.error, 160) : undefined;
    if (t.toolResult && !t.toolResult.ok) return t.toolResult.error ? clip(t.toolResult.error, 160) : undefined;
  }
  return undefined;
}

function conversationItems(graph: BusinessGraph, convo: ConversationState, customer: string, approvalsHere: ApprovalWithLifecycle[], hasOpenHandoff: boolean): Intervention[] {
  const out: Intervention[] = [];
  const ledger = readLedger(convo);
  const lastMsg = convo.messages.at(-1);
  const lastTurn = convo.turns.at(-1);
  const story = () => conversationStory(convo);

  // An operation that failed and hasn't since succeeded — the customer was told; nobody retried.
  const failures = ledger.filter((e) => e.status === "failed" && e.operation !== "understand");
  const latestFailure = failures.at(-1);
  if (latestFailure && !ledger.some((e) => e.seq > latestFailure.seq && e.operation === latestFailure.operation && (e.status === "effected" || e.status === "effected_unconfirmed"))) {
    const approved = latestFailure.requestId ? approvalsHere.find((a) => a.id === latestFailure.requestId) : undefined;
    const error = stepError(convo, latestFailure);
    out.push({
      id: `failed_action:${convo.id}:${latestFailure.seq}`,
      kind: "failed_action",
      priority: 2,
      customer,
      conversationId: convo.id,
      since: latestFailure.at,
      title: approved ? `Your approved request didn't go through for ${customer}` : `${latestFailure.describes[0].toUpperCase()}${latestFailure.describes.slice(1)} failed for ${customer}`,
      why: error ? `The system reported: ${error}` : "The connected system didn't complete it; BARRY recorded the failure and did not pretend otherwise.",
      tried: story().tried,
      decision: approved ? "Check the system it runs through, then tell the customer or ask them to try again. BARRY didn't retry on its own." : "Check the system, then tell the customer if needed. The customer was told it didn't go through; BARRY did not retry.",
      options: [{ action: "open_conversation", label: "Open conversation", primary: true, consequence: "Shows the messages and every effect, with the failure." }],
      then: "If the customer asks again, BARRY tries again through the normal path (your rules and approvals apply as usual).",
      freshness: "Current: nothing of this kind has succeeded since.",
      ...(termsAmount(latestFailure.terms) ? { amount: termsAmount(latestFailure.terms) } : {}),
      terms: latestFailure.terms,
      evidence: [`effect #${latestFailure.seq} · ${latestFailure.effect} · ${latestFailure.at}`, ...(approved ? [`request ${approved.id.slice(0, 12)} approved, then failed`] : [])],
      refs: { seq: latestFailure.seq, ...(approved ? { approvalId: approved.id } : {}) },
    });
  }

  // A write the customer's own limits blocked, still the state of play (the customer hasn't moved on).
  const blocked = ledger.filter((e) => e.effect === "write.blocked").at(-1);
  if (blocked && lastMsg?.role === "barry" && !ledger.some((e) => e.seq > blocked.seq && /^payment\.link_created$|^order\.|^booking\./.test(e.effect))) {
    const reason = String(blocked.outcome?.reason ?? "");
    const cur = typeof blocked.terms.currency === "string" ? blocked.terms.currency : (graph.offers[0]?.currency ?? "USD");
    const total = typeof blocked.outcome?.total === "number" ? money(blocked.outcome.total, cur) : undefined;
    const limit = typeof blocked.outcome?.cap === "number" ? money(blocked.outcome.cap, cur) : undefined;
    const why =
      reason === "shipping_unknown"
        ? `The customer set a budget${limit ? ` of ${limit}` : ""} including shipping, and BARRY doesn't know your shipping cost — so it couldn't promise the total.`
        : reason === "over_budget"
          ? `The total${total ? ` (${total})` : ""} is above the budget the customer stated${limit ? ` (${limit})` : ""}.`
          : "The cart holds items the customer didn't agree to buy, so BARRY asked which ones before sending anything.";
    out.push({
      id: `blocked_write:${convo.id}:${blocked.seq}`,
      kind: "blocked_write",
      priority: 3,
      customer,
      conversationId: convo.id,
      since: blocked.at,
      title: `Checkout for ${customer} stopped by their own limits`,
      why,
      tried: story().tried,
      decision: reason === "shipping_unknown" ? "Tell the BARRY team your shipping fee (or free-shipping rule) so BARRY can quote totals. Nothing was sent or charged." : "Nothing is required: BARRY asked the customer how to proceed. Step in only if you want to offer something different.",
      options: [{ action: "open_conversation", label: "Open conversation", primary: true, consequence: "Shows what was in the cart and what BARRY told the customer." }],
      then: "When the customer answers, BARRY continues within their limits; a payment link is only sent when the total fits what they agreed to.",
      freshness: "Current: the customer hasn't replied since.",
      ...(total ? { amount: total } : {}),
      terms: blocked.terms,
      evidence: [`effect #${blocked.seq} · write.blocked (${reason || "limit"}) · ${blocked.at}`],
      refs: { seq: blocked.seq },
    });
  }

  // BARRY couldn't understand the last message (and no held request or handoff already carries it).
  const u = lastTurn?.trace?.understanding;
  if (u && !u.valid && !hasOpenHandoff && !approvalsHere.some((a) => a.lifecycle === "held")) {
    const kind = u.failure?.kind ?? "unknown";
    const quota = kind === "provider_quota_exhausted";
    out.push({
      id: `not_understood:${convo.id}:${lastTurn!.id}`,
      kind: "not_understood",
      priority: quota ? 1 : 2,
      customer,
      conversationId: convo.id,
      since: lastTurn!.at,
      title: `BARRY couldn't understand ${customer}'s last message`,
      why: `Understanding failed: ${FAILURE_WORDS[kind] ?? kind.replace(/_/g, " ")}. Nothing was done with the message; the customer was told it couldn't be processed.`,
      tried: story().tried,
      decision: quota ? "Add credit to the AI provider account. Until then BARRY can't understand anyone." : "Nothing to decide right now — the customer was asked to try again. If this keeps happening, check Health.",
      options: [{ action: "open_conversation", label: "Open conversation", primary: true, consequence: "Shows the message and the failure classification." }],
      then: "When the customer writes again, BARRY first re-reads the message it missed, then handles the new one.",
      freshness: "Current: this is the latest message in the conversation.",
      evidence: [`turn ${lastTurn!.id} · ${kind} · ${lastTurn!.at}`],
      refs: {},
    });
  }

  // A reply the channel couldn't deliver (the latest delivery attempt).
  const delivery = readDeliveries(convo.knownFields).at(-1);
  if (delivery?.status === "failed") {
    out.push({
      id: `delivery_failed:${convo.id}:${delivery.at}`,
      kind: "delivery_failed",
      priority: 2,
      customer,
      conversationId: convo.id,
      since: delivery.at,
      title: `BARRY's reply to ${customer} wasn't delivered`,
      why: `${delivery.channel === "whatsapp" ? "WhatsApp" : delivery.channel} reported: ${delivery.error ?? "delivery failed"}. The customer didn't get BARRY's last reply.`,
      tried: story().tried,
      decision: "Check the channel connection (Health), and reach the customer another way if it matters now.",
      options: [{ action: "open_conversation", label: "Open conversation", primary: true, consequence: "Shows the reply that wasn't delivered." }],
      then: "BARRY keeps answering; each reply's delivery is recorded, so you'll see if it keeps failing.",
      freshness: "Current: this was the latest delivery attempt.",
      evidence: [`delivery ${delivery.at} · ${delivery.status}${delivery.error ? ` · ${clip(delivery.error, 80)}` : ""}`],
      refs: {},
    });
  }
  return out;
}

export function buildInterventions(input: InterventionInput): Intervention[] {
  const byId = new Map(input.conversations.map((c) => [c.id, c]));
  const items: Intervention[] = [];
  for (const a of input.approvals) {
    if (a.lifecycle !== "active" && a.lifecycle !== "held") continue;
    const convo = byId.get(a.conversationId);
    items.push(approvalItem(input.graph, a, convo, convo ? input.customerLabel(convo) : "Customer"));
  }
  for (const convo of input.conversations) {
    const customer = input.customerLabel(convo);
    const handoffs = readHandoffs(convo).filter((h) => h.status !== "resolved");
    for (const h of handoffs) items.push(handoffItem(input.graph, h, convo, customer));
    items.push(...conversationItems(input.graph, convo, customer, input.approvals.filter((a) => a.conversationId === convo.id), handoffs.length > 0));
  }
  return items.sort((x, y) => x.priority - y.priority || x.since.localeCompare(y.since));
}

/** The queue as Owner Barry sees it (compact, customer-safe). */
export function interventionBriefing(items: Intervention[]) {
  return items.slice(0, 15).map((i) => ({
    kind: i.kind.replace(/_/g, " "),
    customer: i.customer,
    what: i.title,
    why: i.why,
    youDecide: i.decision,
    ...(i.amount ? { amount: i.amount } : {}),
    ifApproved: i.options.find((o) => o.action === "approve")?.consequence,
    since: i.since,
    current: i.freshness,
  }));
}
