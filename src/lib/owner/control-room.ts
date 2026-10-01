import type { OwnerWorkspace } from "./service";
import type { Obligation, ObligationKind } from "@/lib/operator/obligation-model";
import { isOpen } from "@/lib/operator/obligation-model";
import type { Money } from "./revenue";

/**
 * THE CONTROL ROOM READ MODEL (pure, client-safe) — turns the owner workspace into the three things
 * the control room shows about BARRY itself:
 *   - what BARRY is working on right now (open obligations by whose move it is),
 *   - the live activity feed (only recorded events: outcomes, requests, follow-up attempts, closures),
 *   - COMMAND → BARRY → OUTCOME workflows for the proactive operator, counted from the obligations
 *     and their completion evidence.
 * Nothing is estimated or invented: an empty workspace gives empty lists.
 */

export type Tone = "accent" | "violet" | "ok" | "warn" | "bad" | "neutral";
export type ActivityIcon = "money" | "cart" | "clock" | "alert" | "shield" | "chat" | "users" | "check" | "bolt" | "receipt" | "flag";

export type WorkingLine = { id: string; icon: ActivityIcon; tone: Tone; text: string; count: number; state: "working" | "waiting" | "attention" | "blocked" };

const PLURAL: Partial<Record<ObligationKind, [string, string]>> = {
  unpaid_payment_followup: ["unpaid payment link", "unpaid payment links"],
  abandoned_checkout_recovery: ["abandoned checkout", "abandoned checkouts"],
  booking_deposit_missing: ["missing deposit", "missing deposits"],
  appointment_reminder: ["upcoming appointment", "upcoming appointments"],
  failed_action_recovery: ["step to retry", "steps to retry"],
  undelivered_reply: ["undelivered reply", "undelivered replies"],
  unresolved_handoff: ["open handoff", "open handoffs"],
  approval_blocking_transaction: ["sale waiting on you", "sales waiting on you"],
  held_request_recheck: ["held request", "held requests"],
};
const word = (kind: ObligationKind, n: number) => (PLURAL[kind] ?? ["item", "items"])[n === 1 ? 0 : 1];
const ICON: Partial<Record<ObligationKind, ActivityIcon>> = { unpaid_payment_followup: "money", abandoned_checkout_recovery: "cart", booking_deposit_missing: "receipt", appointment_reminder: "clock", failed_action_recovery: "bolt", undelivered_reply: "chat", unresolved_handoff: "users" };

/** What BARRY is doing right now, from open obligations (who moves next) and the intervention queue. */
export function nowWorking(ws: Pick<OwnerWorkspace, "obligations" | "interventions">): WorkingLine[] {
  const open = ws.obligations.filter(isOpen);
  const lines: WorkingLine[] = [];
  const byKind = (pred: (o: Obligation) => boolean) => {
    const m = new Map<ObligationKind, number>();
    for (const o of open.filter(pred)) m.set(o.kind, (m.get(o.kind) ?? 0) + 1);
    return m;
  };
  for (const [kind, n] of byKind((o) => o.nextMove === "barry_can_act")) lines.push({ id: `act:${kind}`, icon: ICON[kind] ?? "bolt", tone: "accent", text: `Following up ${n} ${word(kind, n)}`, count: n, state: "working" });
  // Already followed up (e.g. at the owner's request before the rule's delay) = waiting on the customer, not "scheduled".
  const contacted = (o: Obligation) => (o.attempts ?? 0) > 0;
  for (const [kind, n] of byKind((o) => o.nextMove === "scheduled_for_later" && !contacted(o))) lines.push({ id: `sched:${kind}`, icon: "clock", tone: "violet", text: `${n} ${word(kind, n)} scheduled`, count: n, state: "working" });
  const waiting = open.filter((o) => o.nextMove === "waiting_on_customer" || (o.nextMove === "scheduled_for_later" && contacted(o)));
  const customers = new Set(waiting.map((o) => o.conversationId)).size;
  if (customers) lines.push({ id: "waiting", icon: "users", tone: "neutral", text: `Waiting on ${customers} customer${customers === 1 ? "" : "s"}`, count: customers, state: "waiting" });
  if (ws.interventions.length) lines.push({ id: "needs_you", icon: "shield", tone: "warn", text: `${ws.interventions.length} decision${ws.interventions.length === 1 ? "" : "s"} waiting for you`, count: ws.interventions.length, state: "attention" });
  const blocked = open.filter((o) => o.nextMove === "blocked_by_capability").length;
  if (blocked) lines.push({ id: "blocked", icon: "alert", tone: "bad", text: `${blocked} blocked by a missing capability`, count: blocked, state: "blocked" });
  return lines;
}

export type ActivityItem = { id: string; at: string; icon: ActivityIcon; tone: Tone; text: string; sub?: string; conversationId?: string };

/** The live feed: recorded events only, newest first. */
export function activityFeed(ws: Pick<OwnerWorkspace, "outcomes" | "approvals" | "obligations" | "conversations">, limit = 12): ActivityItem[] {
  const customer = (id: string) => ws.conversations.find((c) => c.id === id)?.customer ?? "Customer";
  const money = (amount?: number, currency?: string) => (amount !== undefined && currency ? new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount) : "");
  const out: ActivityItem[] = [];
  for (const e of ws.outcomes) {
    const who = customer(e.conversationId);
    const amt = money(e.amount, e.currency);
    const test = e.simulated ? " · test" : "";
    const base = { at: e.at, conversationId: e.conversationId };
    switch (e.kind) {
      case "paid": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:paid`, icon: "money", tone: "ok", text: `Payment confirmed — ${who}`, sub: `${amt ? `${amt} · ` : ""}${e.evidence}${test}` }); break;
      case "booked": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:booked`, icon: "clock", tone: "ok", text: `${e.label} — ${who}`, sub: `${e.evidence}${test}` }); break;
      case "order_created": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:order`, icon: "receipt", tone: "ok", text: `Order created — ${who}`, sub: `${amt ? `${amt} · ` : ""}${e.reference ?? ""}${test}` }); break;
      case "case_created": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:case`, icon: "flag", tone: "accent", text: `Case opened — ${who}`, sub: e.reference ?? e.evidence }); break;
      case "handoff": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:handoff`, icon: "users", tone: "accent", text: `Handed to your team — ${who}`, sub: e.label.replace(/^Handed to your team:\s*/, "") }); break;
      case "checkout_abandoned": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:abandon`, icon: "cart", tone: "warn", text: `${e.label} — ${who}`, sub: `${amt}${test}` }); break;
      case "declined_by_owner": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:declined`, icon: "shield", tone: "neutral", text: `You declined a request — ${who}` }); break;
      case "blocked": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:blocked`, icon: "alert", tone: "warn", text: `Stopped — ${who}`, sub: e.label }); break;
      case "failed": out.push({ ...base, id: `o:${e.at}:${e.conversationId}:failed`, icon: "alert", tone: "bad", text: `Didn't go through — ${who}`, sub: e.label }); break;
    }
  }
  for (const a of ws.approvals) {
    out.push({ id: `a:${a.id}`, at: a.createdAt, icon: "shield", tone: a.actionable ? "warn" : "neutral", text: `Asked you: ${a.what}`, sub: a.customer, conversationId: a.conversationId });
  }
  for (const o of ws.obligations) {
    if (o.lastAttemptAt && o.attempts) out.push({ id: `f:${o.key}:${o.attempts}`, at: o.lastAttemptAt, icon: "bolt", tone: "accent", text: `Followed up — ${o.customer}`, sub: `${o.subject}${o.attempts > 1 ? ` · attempt ${o.attempts}` : ""}${o.simulated ? " · test" : ""}`, conversationId: o.conversationId });
    if (o.completion && ["unpaid_payment_followup", "abandoned_checkout_recovery", "booking_deposit_missing", "failed_action_recovery"].includes(o.kind)) out.push({ id: `c:${o.key}`, at: o.completion.at, icon: "check", tone: "ok", text: `Closed — ${o.customer}`, sub: o.subject, conversationId: o.conversationId });
  }
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, limit);
}

export type Workflow = {
  kind: ObligationKind;
  command: string;
  /** The same work as it is happening ("Recovering abandoned checkouts"). */
  title: string;
  /** What the cohort is ("abandoned checkouts"). */
  noun: string;
  commandBy: string;
  /** running = the rule is on and the plan includes follow-ups; off = the owner's rule turns it off; not_in_plan = the plan has no proactive follow-ups. */
  state: "running" | "off" | "not_in_plan";
  eligible: number;
  contacted: number;
  open: number;
  /** Open, already followed up — waiting for the customer. */
  waiting: number;
  /** Open, not contacted yet (not due, or scheduled). */
  queued: number;
  excluded: number;
  closed: number;
  closedLabel: string;
  /** Verified money closed after BARRY acted (non-test), per currency — only where closure is a verified payment. */
  recovered: Money;
  /** Open (non-test) money still at stake, per currency. */
  atStake: Money;
  testItems: number;
};

export const PROACTIVE: { kind: ObligationKind; command: string; title: string; closedLabel: string; paidClosure: boolean }[] = [
  { kind: "unpaid_payment_followup", command: "Follow up unpaid payment links", title: "Following up unpaid payment links", closedLabel: "Paid (verified)", paidClosure: true },
  { kind: "abandoned_checkout_recovery", command: "Recover abandoned checkouts", title: "Recovering abandoned checkouts", closedLabel: "Came back to checkout", paidClosure: false },
  { kind: "booking_deposit_missing", command: "Collect missing deposits", title: "Collecting missing deposits", closedLabel: "Deposit paid (verified)", paidClosure: true },
  { kind: "appointment_reminder", command: "Remind customers before appointments", title: "Reminding customers before appointments", closedLabel: "Appointment reached", paidClosure: false },
  { kind: "failed_action_recovery", command: "Retry what didn't go through", title: "Retrying what didn't go through", closedLabel: "Done on retry", paidClosure: false },
];

/** Whether the proactive operator runs this kind of work for this business (rule + plan). Unknown operator → running. */
export function workflowState(kind: ObligationKind, operator?: OwnerWorkspace["operator"]): Workflow["state"] {
  if (!operator) return "running";
  if (!operator.included) return "not_in_plan";
  return operator.rules.find((r) => r.kind === kind)?.enabled === false ? "off" : "running";
}

const add = (m: Money, c: string | undefined, v: number | undefined) => {
  if (!c || v === undefined) return;
  m[c] = Math.round(((m[c] ?? 0) + v) * 100) / 100;
};

/** COMMAND → BARRY → OUTCOME for each proactive rule that has recorded work. */
export function workflows(ws: Pick<OwnerWorkspace, "obligations"> & Partial<Pick<OwnerWorkspace, "operator">>): Workflow[] {
  const out: Workflow[] = [];
  for (const w of PROACTIVE) {
    const items = ws.obligations.filter((o) => o.kind === w.kind && o.status !== "superseded");
    if (items.length === 0) continue;
    const real = items.filter((o) => !o.simulated);
    const recovered: Money = {};
    const atStake: Money = {};
    for (const o of real) {
      if (isOpen(o)) add(atStake, o.currency, o.amount);
      if (w.paidClosure && o.status === "completed" && (o.attempts ?? 0) > 0 && /verified paid/.test(o.completion?.evidence ?? "")) add(recovered, o.currency, o.amount);
    }
    out.push({
      kind: w.kind,
      command: w.command,
      title: w.title,
      noun: word(w.kind, 2),
      commandBy: "Your follow-up rule",
      state: workflowState(w.kind, ws.operator),
      eligible: items.length,
      contacted: items.filter((o) => (o.attempts ?? 0) > 0).length,
      open: items.filter(isOpen).length,
      waiting: items.filter((o) => isOpen(o) && (o.attempts ?? 0) > 0).length,
      queued: items.filter((o) => isOpen(o) && !(o.attempts ?? 0)).length,
      excluded: items.filter((o) => o.status === "cancelled").length,
      closed: items.filter((o) => o.status === "completed").length,
      closedLabel: w.closedLabel,
      recovered,
      atStake,
      testItems: items.length - real.length,
    });
  }
  return out;
}

/** Conversations per hour today (local hours of the viewer), for the "since you left" bars. Real counts only. */
export function activityByHour(ws: Pick<OwnerWorkspace, "conversations">, now = new Date()): { values: number[]; labels: string[] } {
  const values = Array.from({ length: 24 }, () => 0);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (const c of ws.conversations) {
    const t = new Date(c.lastActivityAt);
    if (t >= start && t <= now) values[t.getHours()]++;
  }
  return { values, labels: values.map((_, h) => `${String(h).padStart(2, "0")}:00`) };
}
