import type { Obligation, ObligationKind } from "@/lib/operator/obligation-model";
import { isOpen } from "@/lib/operator/obligation-model";
import type { Money } from "./revenue";
import type { CommandSource } from "./command";
import { PROACTIVE } from "./control-room";

/**
 * OWNER OPERATIONS (pure, client-safe types + grounding + progress) — a batch of work an owner command
 * started, on an EXACT cohort. Nothing is "sent to everyone": the cohort is grounded from the recorded
 * obligations before anything runs, every excluded customer carries a reason, and execution goes through
 * the same bounded proactive executor as scheduled work. Results are read back from the records:
 * contacted from the executor's attempts, replied from the conversation, purchased / paid from the
 * obligation's verified closure, recovered money only when the payment provider verified it.
 *
 *   proposed → running → waiting_on_customers → completed
 *                  ↘ stopped (by the owner)   ↘ blocked (plan / rule / pause)   ↘ failed
 */

export type OperationState = "proposed" | "running" | "waiting_on_customers" | "completed" | "stopped" | "blocked" | "failed";

export type OperationTarget = {
  key: string;
  conversationId: string;
  customer: string;
  amount?: number;
  currency?: string;
  simulated?: boolean;
  eligibility: "eligible" | "excluded";
  /** Why excluded — or a note on an eligible one ("not due yet — now, because you asked"). */
  reason?: string;
  /** Already closed before the operation (purchased / paid / came back). */
  alreadyDone?: boolean;
  /** How BARRY would reach them. */
  delivery?: "whatsapp_live" | "whatsapp_dry_run" | "in_conversation";
  result?: { outcome: "sent" | "dry_run" | "skipped" | "failed" | "cancelled"; why: string; at: string; attempt?: number };
};

export type OwnerOperation = {
  id: string;
  businessId: string;
  commandId: string;
  workflow: ObligationKind;
  title: string;
  command: string;
  scope: { kind: "today" | "open"; since?: string; label: string };
  requestedBy: { source: CommandSource; actor: string };
  plannedAction: string;
  rule: { afterHours: number; maxAttempts: number; intervalHours: number } | null;
  authority: string;
  entitlement: "included" | "not_included";
  state: OperationState;
  blockedReason?: string;
  targets: OperationTarget[];
  /** Single-use token a "Start" / "Stop" action must carry (forged actions fail). */
  actionToken: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  stoppedAt?: string;
  stoppedBy?: string;
  events: { at: string; what: string }[];
};

export type OperationProgress = {
  cohort: number;
  eligible: number;
  excluded: number;
  alreadyDone: number;
  contacted: number;
  replied: number;
  purchased: number;
  stillTalking: number;
  waiting: number;
  failed: number;
  recovered: Money;
  test: number;
};

export type OwnerOperationView = Omit<OwnerOperation, "actionToken" | "targets"> & { targets: Omit<OperationTarget, "result">[]; progress: OperationProgress; derivedState: OperationState };

/** Workflows an owner can start: those with a real customer-facing follow-up. */
export const STARTABLE: ObligationKind[] = ["abandoned_checkout_recovery", "unpaid_payment_followup", "appointment_reminder"];

const DONE_WORDS: Partial<Record<ObligationKind, string>> = { unpaid_payment_followup: "already paid", abandoned_checkout_recovery: "already came back and bought", appointment_reminder: "appointment already passed" };

export type GroundingInput = {
  workflow: ObligationKind;
  scope: { kind: "today" | "open"; since: string };
  obligations: Obligation[];
  conversations: { id: string; channel: string; attention: string[] }[];
  rule: { enabled: boolean; afterHours: number; maxAttempts: number; intervalHours: number } | undefined;
  disabledChannels: string[];
  /** conversationId → the customer's last message time (for WhatsApp's 24-hour window). */
  lastCustomerAt: Record<string, string | undefined>;
  whatsappLive: boolean;
  now: Date;
};

/** The exact cohort for a workflow and scope, with a reason for every exclusion. Pure. */
export function groundCohort(g: GroundingInput): OperationTarget[] {
  const inScope = g.obligations.filter((o) => o.kind === g.workflow && o.status !== "superseded" && (g.scope.kind === "open" ? isOpen(o) || (o.status === "completed" && (o.completion?.at ?? "") >= g.scope.since) : o.createdAt >= g.scope.since));
  return inScope.map((o): OperationTarget => {
    const base = { key: o.key, conversationId: o.conversationId, customer: o.customer, ...(o.amount !== undefined ? { amount: o.amount } : {}), ...(o.currency ? { currency: o.currency } : {}), ...(o.simulated ? { simulated: true } : {}) };
    const ex = (reason: string, alreadyDone = false): OperationTarget => ({ ...base, eligibility: "excluded", reason, ...(alreadyDone ? { alreadyDone } : {}) });
    if (o.status === "completed") return ex(DONE_WORDS[o.kind] ?? "already done", true);
    if (o.status === "cancelled") return ex(`no longer relevant${o.cancellation?.reason ? ` (${o.cancellation.reason})` : ""}`);
    if (o.nextMove === "needs_owner") return ex("waiting on your decision first");
    if (o.nextMove === "blocked_by_capability") return ex("BARRY can't reach them yet (a capability is missing)");
    const row = g.conversations.find((c) => c.id === o.conversationId);
    if (!row) return ex("the conversation no longer exists");
    if (row.attention.includes("handoff_open")) return ex("a person on your team has this conversation");
    if (g.disabledChannels.includes(row.channel === "simulator" ? "web" : row.channel)) return ex(`the ${row.channel} channel is turned off`);
    const attempts = o.attempts ?? 0;
    if (g.rule && attempts >= g.rule.maxAttempts) return ex(`already followed up ${attempts} time${attempts === 1 ? "" : "s"} — your limit`);
    if (g.rule && o.lastAttemptAt && g.now.getTime() - Date.parse(o.lastAttemptAt) < g.rule.intervalHours * 3600_000) return ex(`contacted recently (your rule: every ${g.rule.intervalHours}h)`);
    const wa = row.channel === "whatsapp";
    if (wa && g.whatsappLive) {
      const last = g.lastCustomerAt[o.conversationId];
      if (!last || g.now.getTime() - Date.parse(last) > 24 * 3600_000) return ex("can't be messaged now — outside WhatsApp's 24-hour window");
    }
    const early = o.nextMove === "scheduled_for_later" || Date.parse(o.eligibleAt) > g.now.getTime();
    return { ...base, eligibility: "eligible", delivery: wa ? (g.whatsappLive ? "whatsapp_live" : "whatsapp_dry_run") : "in_conversation", ...(early && g.rule ? { reason: `not due yet under your ${g.rule.afterHours}h rule — now, because you asked` } : {}) };
  });
}

/** Results read back from records: attempts (contacted), conversation (replied), verified closures (purchased / recovered). */
export function operationProgress(op: Pick<OwnerOperation, "targets">, current: Obligation[], customerMessages: Record<string, string[]>): OperationProgress {
  const p: OperationProgress = { cohort: op.targets.length, eligible: 0, excluded: 0, alreadyDone: 0, contacted: 0, replied: 0, purchased: 0, stillTalking: 0, waiting: 0, failed: 0, recovered: {}, test: 0 };
  for (const t of op.targets) {
    if (t.simulated) p.test += 1;
    if (t.eligibility === "excluded") {
      p.excluded += 1;
      if (t.alreadyDone) p.alreadyDone += 1;
      continue;
    }
    p.eligible += 1;
    const r = t.result;
    if (!r) continue;
    if (r.outcome === "failed") {
      p.failed += 1;
      continue;
    }
    if (r.outcome !== "sent" && r.outcome !== "dry_run") continue;
    p.contacted += 1;
    const now = current.find((o) => o.key === t.key);
    const replied = (customerMessages[t.conversationId] ?? []).some((at) => at > r.at);
    const closed = now?.status === "completed" && (now.completion?.at ?? "") >= r.at;
    if (replied) p.replied += 1;
    if (closed) {
      p.purchased += 1;
      if (!now?.simulated && now?.currency && now.amount !== undefined && /verified paid/.test(now.completion?.evidence ?? "")) p.recovered[now.currency] = Math.round(((p.recovered[now.currency] ?? 0) + now.amount) * 100) / 100;
    } else if (replied) p.stillTalking += 1;
    else p.waiting += 1;
  }
  return p;
}

/** The state the records imply now (a running batch becomes completed when every contacted customer closed). */
export function derivedState(op: Pick<OwnerOperation, "state">, p: OperationProgress): OperationState {
  if (op.state !== "waiting_on_customers") return op.state;
  return p.contacted > 0 && p.waiting === 0 && p.stillTalking === 0 ? "completed" : "waiting_on_customers";
}

export function operationTitle(kind: ObligationKind): { title: string; command: string } {
  const m = PROACTIVE.find((p) => p.kind === kind);
  return { title: m?.title ?? kind.replace(/_/g, " "), command: m?.command ?? kind.replace(/_/g, " ") };
}

export const STATE_WORDS: Record<OperationState, string> = {
  proposed: "Waiting for your go",
  running: "Running",
  waiting_on_customers: "Waiting on customers",
  completed: "Done",
  stopped: "Stopped by you",
  blocked: "Blocked",
  failed: "Failed",
};
