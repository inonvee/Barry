import type { BusinessGraph } from "@/lib/business-graph";
import { truthfulLedger } from "@/lib/operator/execution-state";
import type { ConversationState } from "@/lib/state";
import type { PaymentRequestRecord } from "@/lib/store/types";
import type { ApprovalWithLifecycle } from "@/lib/runtime/owner-requests";
import type { LedgerEntry } from "@/lib/runtime/ledger";
import { readHandoffs } from "@/lib/runtime/handoff";
import { readDeliveries } from "@/lib/channels/gateway";
import { customerLabel } from "@/lib/owner/service";
import { isSimulatedPayment, isVerifiedPaid } from "@/lib/owner/revenue";
import type { Obligation } from "@/lib/operator/obligation-model";
import type { Incident } from "./incidents";
import { describeChange, type ControlAudit } from "./controls";

/**
 * LIVE ACTIVITY — one read model of what BARRY and people did, for the founder and the owner alike:
 * effects, approvals, payments, handoffs, obligations, incidents, outcomes and founder control changes.
 * Every row says WHAT happened, FOR WHOM, WHO did it, whether it is VERIFIED and what is STILL NEEDED,
 * and links to its evidence (the conversation or record). Derived from records only — never raw logs,
 * never model prose. Nothing here is inferred from a business's type or name.
 */

export type ActivityKind = "effect" | "approval" | "payment" | "handoff" | "obligation" | "incident" | "outcome" | "founder_control" | "delivery";
export type ActivityActor = "barry" | "owner" | "customer" | "founder" | "provider" | "team";

export type ActivityEvent = {
  /** Stable within a business: `${kind}:${record}` (dedupes across reloads). */
  id: string;
  at: string;
  businessId: string;
  businessName: string;
  kind: ActivityKind;
  what: string;
  forWhom?: string;
  by: ActivityActor;
  verified: "verified" | "unverified" | "n/a";
  stillNeeded?: string;
  /** Where the proof lives. */
  evidence: string;
  conversationId?: string;
  simulated?: boolean;
  /** Consequential: a write toward the world (or a founder control). */
  consequential: boolean;
};

export type ActivityInput = {
  graph: BusinessGraph;
  conversations: ConversationState[];
  approvals: ApprovalWithLifecycle[];
  payments: PaymentRequestRecord[];
  obligations?: Obligation[];
  incidents?: Incident[];
  audit?: ControlAudit[];
  since?: string;
  limit?: number;
};

const ACTOR_WORDS: Record<ActivityActor, string> = { barry: "BARRY", owner: "the owner", customer: "the customer", founder: "the founder", provider: "the provider", team: "the team" };
export const actorWords = (a: ActivityActor) => ACTOR_WORDS[a];

function effectEvent(c: ConversationState, e: LedgerEntry, business: BusinessGraph["business"]): ActivityEvent | null {
  if (e.effect.startsWith("request.") || e.effect.startsWith("understanding.")) return null;
  const customer = customerLabel(c);
  const base = { id: `effect:${c.id}:${e.seq}`, at: e.at, businessId: business.id, businessName: business.name, kind: "effect" as const, forWhom: customer, evidence: `ledger #${e.seq} (${e.effect})`, conversationId: c.id, consequential: e.effect !== "read" && !e.effect.endsWith(".read") };
  // A sent follow-up is "sent": the channel took it; delivery to the phone is not confirmed by any recorded provider status.
  if (e.effect === "followup.sent") return { ...base, what: `${e.describes} — sent (delivery not confirmed by the provider)`, by: "barry", verified: "unverified" };
  if (e.effect === "followup.dry_run") return { ...base, what: `${e.describes} — test mode: recorded, NOT sent`, by: "barry", verified: "n/a", consequential: false };
  switch (e.status) {
    case "effected":
      return { ...base, what: e.describes, by: "barry", verified: e.reference || e.effect.includes("read") ? "verified" : "verified" };
    case "effected_unconfirmed":
      return { ...base, what: `${e.describes} — submitted, not confirmed`, by: "barry", verified: "unverified", stillNeeded: "confirmation from the system" };
    case "failed":
      return { ...base, what: `${e.describes} — failed, nothing changed`, by: "barry", verified: "n/a", stillNeeded: "a retry or a person" };
    case "no_effect":
      return { ...base, what: e.effect === "write.blocked" ? `${e.describes} — stopped before anything ran` : `${e.describes} — did not happen`, by: "barry", verified: "n/a" };
    default:
      return null;
  }
}

export function businessActivity(input: ActivityInput): ActivityEvent[] {
  const { graph } = input;
  const b = graph.business;
  const out: ActivityEvent[] = [];
  const byConversation = new Map(input.conversations.map((c) => [c.id, c]));
  const who = (conversationId: string) => {
    const c = byConversation.get(conversationId);
    return c ? customerLabel(c) : undefined;
  };
  for (const c of input.conversations) {
    for (const e of truthfulLedger(c)) {
      const ev = effectEvent(c, e, b);
      if (ev) out.push(ev);
    }
    for (const h of readHandoffs(c)) {
      out.push({ id: `handoff:${h.id}`, at: h.resolvedAt ?? h.acknowledgedAt ?? h.createdAt, businessId: b.id, businessName: b.name, kind: "handoff", what: h.status === "resolved" ? `Handoff resolved: ${h.reason}` : h.status === "acknowledged" ? `Handoff picked up by the team: ${h.reason}` : `Handed to a person: ${h.reason}`, forWhom: customerLabel(c), by: h.status === "open" ? "barry" : "team", verified: "n/a", ...(h.status !== "resolved" ? { stillNeeded: "the team's reply to the customer" } : {}), evidence: `handoff ${h.id}`, conversationId: c.id, consequential: false });
    }
    for (const d of readDeliveries(c.knownFields)) {
      if (d.status !== "failed") continue;
      out.push({ id: `delivery:${d.inboundId}:${d.at}`, at: d.at, businessId: b.id, businessName: b.name, kind: "delivery", what: `A reply could not be delivered on ${d.channel}`, forWhom: customerLabel(c), by: "provider", verified: "n/a", stillNeeded: "a resend or another channel", evidence: d.error ?? "delivery record", conversationId: c.id, consequential: false });
    }
  }
  for (const a of input.approvals) {
    const decided = a.resolution?.decidedAt;
    const at = decided ?? a.createdAt;
    const what =
      a.lifecycle === "active" ? `Asked the owner: ${a.summary}` : a.lifecycle === "held" ? `Request held (customer may have changed their mind): ${a.summary}` : a.lifecycle === "declined" ? `Owner declined: ${a.summary}` : a.lifecycle === "executed" ? `Owner approved and BARRY completed: ${a.summary}` : a.lifecycle === "executed_unconfirmed" ? `Owner approved; the system has not confirmed: ${a.summary}` : a.lifecycle === "failed" ? `Owner approved but it failed: ${a.summary}` : a.lifecycle === "withdrawn" ? `Customer withdrew: ${a.summary}` : a.lifecycle === "superseded" ? `Replaced by a newer request: ${a.summary}` : `Owner approved: ${a.summary}`;
    out.push({ id: `approval:${a.id}`, at, businessId: b.id, businessName: b.name, kind: "approval", what, forWhom: who(a.conversationId), by: decided ? "owner" : a.lifecycle === "withdrawn" ? "customer" : "barry", verified: a.lifecycle === "executed" ? "verified" : a.lifecycle === "executed_unconfirmed" ? "unverified" : "n/a", ...(a.lifecycle === "active" ? { stillNeeded: "the owner's decision" } : a.lifecycle === "held" ? { stillNeeded: "a re-check by the owner" } : a.lifecycle === "approved" ? { stillNeeded: "BARRY to carry it out" } : {}), evidence: `approval ${a.id}`, conversationId: a.conversationId, consequential: true });
  }
  for (const p of input.payments) {
    const simulated = isSimulatedPayment(p);
    const paid = isVerifiedPaid(p);
    const amount = `${p.amount} ${p.currency}`;
    out.push({ id: `payment:${p.id}`, at: p.verifiedAt ?? p.createdAt, businessId: b.id, businessName: b.name, kind: "payment", what: paid ? `Payment of ${amount} verified${simulated ? " (test provider)" : ""}` : p.status === "pending" ? `Payment link for ${amount} sent, unpaid${simulated ? " (test provider)" : ""}` : p.status === "failed" ? `Payment of ${amount} failed` : `Payment request for ${amount} cancelled`, forWhom: who(p.conversationId), by: paid ? "provider" : "barry", verified: paid ? "verified" : p.status === "paid" ? "unverified" : "n/a", ...(p.status === "pending" ? { stillNeeded: "the customer to pay" } : p.status === "paid" && !paid ? { stillNeeded: "provider verification" } : {}), evidence: `payment request ${p.id}${p.providerTransactionId ? ` · provider tx ${p.providerTransactionId}` : ""}`, conversationId: p.conversationId, simulated, consequential: true });
  }
  for (const o of input.obligations ?? []) {
    if (!o.completion && !o.cancellation && !o.supersededBy) continue;
    out.push({ id: `obligation:${o.key}`, at: o.completion?.at ?? o.cancellation?.at ?? o.updatedAt, businessId: b.id, businessName: b.name, kind: "obligation", what: o.completion ? `Done watching: ${o.subject} — ${o.completion.evidence}` : o.cancellation ? `Stopped watching: ${o.subject} — ${o.cancellation.reason}` : `Watching replaced: ${o.subject}`, forWhom: o.customer, by: "barry", verified: o.completion ? "verified" : "n/a", evidence: o.source, conversationId: o.conversationId, simulated: o.simulated, consequential: false });
  }
  for (const i of input.incidents ?? []) {
    out.push({ id: `incident:${i.key}:${i.status}`, at: i.resolved?.at ?? i.acknowledged?.at ?? i.lastSeen, businessId: b.id, businessName: b.name, kind: "incident", what: i.status === "resolved" ? `Incident resolved: ${i.title}` : i.status === "acknowledged" ? `Incident acknowledged: ${i.title}` : `Incident (${i.severity}): ${i.title}`, by: i.status === "current" ? "barry" : "founder", verified: "n/a", ...(i.status !== "resolved" ? { stillNeeded: i.nextAction } : {}), evidence: i.evidence[0] ?? i.key, conversationId: i.links.conversationId, consequential: false });
  }
  for (const a of input.audit ?? []) {
    out.push({ id: `control:${a.id}`, at: a.at, businessId: b.id, businessName: b.name, kind: "founder_control", what: describeChange(a), by: a.by.startsWith("qa:") ? "team" : "founder", verified: "verified", evidence: `founder audit ${a.id}`, consequential: true });
  }
  const since = input.since ? Date.parse(input.since) : -Infinity;
  return out
    .filter((e) => Date.parse(e.at) >= since)
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, input.limit ?? 200);
}

/** The pulse: counts for the shell / brief, from the same events. */
export function activityPulse(events: ActivityEvent[], now: Date, windowMs = 24 * 3600_000) {
  const recent = events.filter((e) => now.getTime() - Date.parse(e.at) <= windowMs);
  return {
    total: recent.length,
    consequential: recent.filter((e) => e.consequential).length,
    unverified: recent.filter((e) => e.verified === "unverified").length,
    stillNeeded: recent.filter((e) => e.stillNeeded).length,
    latestAt: recent[0]?.at ?? null,
  };
}
