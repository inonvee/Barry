import { takeoverPending } from "@/lib/channels/human-takeover";
import { customerSendGate } from "@/lib/channels/business-numbers";
import { loadEntitlement } from "@/lib/commercial/account";
import { hasFeature } from "@/lib/commercial/entitlements";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { appendLedger } from "@/lib/runtime/ledger";
import { SCRATCH_KEYS } from "@/lib/runtime/compiler";
import { humanHolds } from "@/lib/runtime/control";
import { resolveReplyLanguage } from "@/lib/reasoner/language";
import { money } from "@/lib/reasoner/deterministic-compose";
import { loadControls, type BusinessControls } from "@/lib/hq/controls";
import { proactiveGate } from "@/lib/runtime/operating-mode";
import { CHANNEL_DELIVERY_KEY, type DeliveryRecord, type OutboundSender } from "@/lib/channels/gateway";
import { reconcileObligations, isOpen, type Obligation } from "./obligations";
import { followUpPolicyFor, ruleFor } from "./policy";
import { attemptCounts, attemptId, listAttempts, recordAttempt, type ExecutionAttempt } from "./attempts";
import { ownerHeldKeys } from "./holds";
import { ConversationBusyError, withConversationLock } from "@/lib/state/lock";

/** WhatsApp only lets a business message a customer freely within 24 hours of the customer's last message. */
export const WHATSAPP_WINDOW_MS = 24 * 3600_000;

/**
 * OBLIGATION EXECUTOR — the bounded runner for "BARRY CAN ACT" obligations. At execution time it
 * re-reads the latest state, re-checks authority (founder controls, playbook policy), re-checks the
 * capability (a channel to send on), cancels stale items, enforces idempotency per attempt, records
 * evidence, bounds retries and hard-limits attempts. One pass per call; no loops, no timers. Messages
 * are deterministic, in the conversation's language; a dry-run sender records what would be sent and
 * sends nothing. The model never decides to follow up; the records and the policy do.
 */

export type ExecutorResult = { key: string; kind: Obligation["kind"]; outcome: "sent" | "dry_run" | "skipped" | "failed" | "cancelled"; why: string; attempt?: number };
export type ExecutorRun = { businessId: string; at: string; considered: number; acted: number; results: ExecutorResult[]; blocked?: string };

const dryRun = (channel: OutboundSender["channel"]): OutboundSender => ({ channel, mode: "dry_run", send: async () => ({}) });

export type SenderResolver = (conversation: ConversationState) => OutboundSender | undefined;

function channelOf(conversationId: string): OutboundSender["channel"] {
  return conversationId.startsWith("wa:") ? "whatsapp" : conversationId.startsWith("ig:") ? "instagram" : "web";
}

/** Deterministic, locale-safe follow-up texts. */
export function followUpText(kind: Obligation["kind"], o: Obligation, lang: string): string | null {
  const he = lang.startsWith("he");
  const amount = o.amount !== undefined && o.currency ? money(o.amount, o.currency, lang) : "";
  switch (kind) {
    case "unpaid_payment_followup":
      return he ? `היי, רק תזכורת: קישור התשלום על ${amount} עדיין פתוח. אם זה כבר לא רלוונטי, אפשר להתעלם.` : `Hi — just a reminder that the payment link for ${amount} is still open. If it's no longer relevant, feel free to ignore this.`;
    case "abandoned_checkout_recovery":
      return he ? `היי, ראיתי שהשארת פריטים בעגלה (${amount}). רוצה שאשלים את ההזמנה? שום דבר לא חויב.` : `Hi — I noticed you left items in your cart (${amount}). Would you like to complete the order? Nothing has been charged.`;
    case "appointment_reminder":
      return he ? `תזכורת: התור שלך מתקיים ב-${o.dueAt ?? ""}. אם צריך לשנות, אפשר לכתוב לי.` : `Reminder: your appointment is at ${o.dueAt ?? ""}. If you need to change it, just reply here.`;
    default:
      return null;
  }
}

/**
 * `only` restricts the pass to an exact, grounded cohort (an owner operation); `dueNow` lets those
 * obligations run before the rule's delay because the owner asked now. Every other check — plan,
 * founder controls, the rule being on, attempt limits and intervals, idempotency, stale state, handoffs,
 * disabled channels, owner holds, the WhatsApp 24-hour window — applies exactly as for scheduled work.
 */
export async function runObligationExecutor(graph: BusinessGraph, opts: { now?: Date; senders?: SenderResolver; limit?: number; only?: string[]; dueNow?: boolean } = {}): Promise<ExecutorRun> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const businessId = graph.business.id;
  const backend = getBackend();
  const results: ExecutorResult[] = [];
  const controls: BusinessControls = await loadControls(businessId);
  const policy = followUpPolicyFor(graph);
  const store = getConversationStore();
  const [conversations, approvalsRaw, payments, bookings, carts, attempts] = await Promise.all([store.listByBusiness(businessId), backend.listApprovals(businessId), backend.listPaymentRequests(businessId), backend.listBookings(businessId), backend.listCommerceCarts(businessId), listAttempts(businessId)]);
  const approvals = withLifecycle(approvalsRaw, new Map(conversations.map((c) => [c.id, c])));
  const counts = attemptCounts(attempts);
  const obligations = await reconcileObligations({ graph, conversations, approvals, payments, bookings, carts, policy, attempts: counts, now });
  const only = opts.only ? new Set(opts.only) : undefined;
  const due = (o: Obligation) => o.nextMove === "barry_can_act" || (Boolean(opts.dueNow && only) && (o.nextMove === "scheduled_for_later" || o.nextMove === "waiting_on_customer"));
  const candidates = obligations.filter((o) => isOpen(o) && (!only || only.has(o.key)) && due(o) && ruleFor(policy, o.kind)?.enabled !== false && ruleFor(policy, o.kind)).slice(0, opts.limit ?? 10);
  const held = await ownerHeldKeys(businessId);

  // Authority re-check, through the ONE operating-mode gate: paused / safe mode / writes paused send nothing;
  // SUPERVISED sends only what the owner asked for (an owner operation); SIMULATOR only ever dry-runs.
  // The plan: proactive follow-ups are an Operator feature — a plan without them sends nothing proactive.
  const planBlocked = !hasFeature(await loadEntitlement(businessId), "proactive_followups") ? "proactive follow-ups are not included in this business's plan" : undefined;
  const gate = proactiveGate(controls, { ownerInitiated: Boolean(only) });
  const blocked = planBlocked ?? (!gate.allowed ? gate.reason : controls.disabledChannels.length && candidates.every((o) => controls.disabledChannels.includes(channelOf(o.conversationId))) && candidates.length ? "every channel is disabled" : undefined);
  const liveAllowed = gate.allowed && gate.live;
  if (blocked) return { businessId, at, considered: candidates.length, acted: 0, results: candidates.map((o) => ({ key: o.key, kind: o.kind, outcome: "skipped", why: blocked })), blocked };

  let acted = 0;
  for (const o of candidates) {
    const rule = ruleFor(policy, o.kind)!;
    const prior = counts[o.key] ?? { count: 0 };
    const n = prior.count + 1;
    const id = attemptId(o.key, n);
    if (attempts.some((a) => a.id === id)) {
      results.push({ key: o.key, kind: o.kind, outcome: "skipped", why: "this attempt already ran (idempotent)" });
      continue;
    }
    if (prior.count >= rule.maxAttempts) {
      results.push({ key: o.key, kind: o.kind, outcome: "skipped", why: `attempt limit reached (${rule.maxAttempts})` });
      continue;
    }
    if (held.has(o.key) && !only) {
      results.push({ key: o.key, kind: o.kind, outcome: "skipped", why: "the owner stopped outreach to this customer" });
      continue;
    }
    if (prior.lastAt && now.getTime() - Date.parse(prior.lastAt) < rule.intervalHours * 3600_000) {
      results.push({ key: o.key, kind: o.kind, outcome: "skipped", why: `too soon after the last attempt (every ${rule.intervalHours}h)` });
      continue;
    }
    const conversation = conversations.find((c) => c.id === o.conversationId);
    if (!conversation) {
      results.push({ key: o.key, kind: o.kind, outcome: "cancelled", why: "the conversation no longer exists" });
      continue;
    }
    // Stale re-check against the LATEST records (the reconcile above already re-derived, but a payment may have landed).
    const freshPayments = await backend.listPaymentRequests(businessId);
    if (o.kind === "unpaid_payment_followup" && freshPayments.some((p) => `unpaid_payment_followup:${p.id}` === o.key && p.status !== "pending")) {
      results.push({ key: o.key, kind: o.kind, outcome: "cancelled", why: "the payment is no longer pending" });
      continue;
    }
    const channel = channelOf(conversation.id);
    if (controls.disabledChannels.includes(channel)) {
      results.push({ key: o.key, kind: o.kind, outcome: "skipped", why: `channel ${channel} is disabled by the founder` });
      continue;
    }
    // Check, send and record holding the conversation's lock, on its LATEST copy: a customer turn running
    // right now finishes first (or this obligation waits for the next pass) — never a stale overwrite.
    let result: ExecutorResult;
    try {
      result = await withConversationLock(conversation.id, () => followUpOne(o, rule, n, id), { waitMs: 5_000 });
    } catch (err) {
      if (!(err instanceof ConversationBusyError)) throw err;
      results.push({ key: o.key, kind: o.kind, outcome: "skipped", why: "the customer's conversation is busy right now; tried again on the next pass" });
      continue;
    }
    if (result.outcome === "sent" || result.outcome === "dry_run" || result.outcome === "failed") acted += 1;
    results.push(result);
  }

  async function followUpOne(o: Obligation, rule: NonNullable<ReturnType<typeof ruleFor>>, n: number, id: string): Promise<ExecutorResult> {
    const conversation = await store.get(o.conversationId);
    if (!conversation) return { key: o.key, kind: o.kind, outcome: "cancelled", why: "the conversation no longer exists" };
    const channel = channelOf(conversation.id);
    if (humanHolds(conversation) && o.kind !== "unresolved_handoff") return { key: o.key, kind: o.kind, outcome: "skipped", why: "a person holds this conversation; BARRY stays quiet" };
    // A team member's takeover waiting to be applied (e.g. they just replied from the WhatsApp Business app) wins too,
    // and so does a business number that isn't safe to send on. Fails safe: unreadable → skipped.
    if (o.kind !== "unresolved_handoff" && (await takeoverPending(conversation).catch(() => true))) return { key: o.key, kind: o.kind, outcome: "skipped", why: "a team member just took this conversation; BARRY stays quiet" };
    if (channel === "whatsapp") {
      const gate = await customerSendGate(businessId).catch(() => ({ allowed: false as const, reason: "the WhatsApp number state couldn't be read" }));
      if (!gate.allowed) return { key: o.key, kind: o.kind, outcome: "skipped", why: `not sent: ${gate.reason}` };
    }
    const lang = resolveReplyLanguage({ customerMessages: conversation.messages.filter((m) => m.role === "customer").map((m) => m.content), stored: conversation.knownFields[SCRATCH_KEYS.conversationLanguage], businessLocale: graph.business.locale }).code;
    const text = followUpText(o.kind, o, lang);
    if (!text) return { key: o.key, kind: o.kind, outcome: "skipped", why: "no customer-facing follow-up exists for this kind; it stays on the owner's list" };
    // Never a real send unless the mode allows it (a test / simulator business only ever dry-runs).
    const resolved = opts.senders?.(conversation);
    const sender = resolved && (liveAllowed || resolved.mode !== "live") ? resolved : dryRun(channel);
    // Under the lock: another pass that already started this exact attempt wins — never a second send.
    if ((await listAttempts(businessId)).some((a) => a.id === id)) return { key: o.key, kind: o.kind, outcome: "skipped", why: "this attempt already ran (idempotent)" };
    // WhatsApp's customer-service window: a free-form message only within 24h of the customer's last message.
    const lastCustomer = [...conversation.messages].reverse().find((m) => m.role === "customer")?.at;
    if (channel === "whatsapp" && sender.mode === "live" && (!lastCustomer || now.getTime() - Date.parse(lastCustomer) > WHATSAPP_WINDOW_MS)) return { key: o.key, kind: o.kind, outcome: "skipped", why: "outside WhatsApp's 24-hour window — an approved message template is needed" };
    const to = conversation.id.split(":").slice(2).join(":") || conversation.customerId;
    const base = { id, businessId, obligationKey: o.key, kind: o.kind, n, at, evidence: [...o.evidence, `attempt ${n} of ${rule.maxAttempts} · policy ${rule.intervalHours}h apart`], channel, idempotencyKey: id };
    // The attempt is recorded BEFORE the send: if anything dies between the send and its result, the attempt
    // id already exists and the next pass never sends again (it stays "attempted" — result unknown — honestly).
    await recordAttempt({ ...base, status: "attempted", what: `Sending (result not recorded yet): “${text}”` });
    let status: ExecutionAttempt["status"];
    let providerMessageId: string | undefined;
    let error: string | undefined;
    try {
      const sent = sender.mode === "live" ? await sender.send(to, text, { businessId }) : {};
      status = sender.mode === "live" ? "sent" : "dry_run";
      providerMessageId = sent.providerMessageId;
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message.slice(0, 200) : "send failed";
    }
    await recordAttempt({ ...base, status, what: status === "failed" ? `Follow-up could not be sent: ${error}` : `${status === "dry_run" ? "Would send" : "Sent"}: “${text}”`, ...(providerMessageId ? { providerMessageId } : {}) });
    // The conversation keeps the proof: a ledger entry and a delivery record — and a BARRY message in the
    // transcript ONLY when the message really left (a dry run or a failed send is never "said").
    if (status === "sent") conversation.messages.push({ role: "barry", content: text, at });
    appendLedger(conversation, { operation: "followUp", effect: status === "sent" ? "followup.sent" : status === "dry_run" ? "followup.dry_run" : "followup.failed", status: status === "sent" ? "effected" : status === "dry_run" ? "no_effect" : "failed", describes: `follow-up (${o.kind.replace(/_/g, " ")})`, terms: { attempt: n }, reference: id });
    const delivery: DeliveryRecord = { at, channel, inboundId: id, status, ...(status === "sent" ? { messageAt: at } : {}), ...(providerMessageId ? { providerMessageId } : {}), ...(error ? { error } : {}) };
    const deliveries = JSON.parse(conversation.knownFields[CHANNEL_DELIVERY_KEY] ?? "[]") as DeliveryRecord[];
    conversation.knownFields[CHANNEL_DELIVERY_KEY] = JSON.stringify([...deliveries, delivery].slice(-50));
    await store.save(conversation);
    return { key: o.key, kind: o.kind, outcome: status === "failed" ? "failed" : status, why: status === "failed" ? error! : `attempt ${n} of ${rule.maxAttempts}`, attempt: n };
  }
  // Re-reconcile so the obligations reflect the attempts (nextMove → waiting on the customer, attempts count).
  await reconcileObligations({ graph, conversations: await store.listByBusiness(businessId), approvals, payments, bookings, carts, policy, attempts: attemptCounts(await listAttempts(businessId)), now });
  return { businessId, at, considered: candidates.length, acted, results };
}
