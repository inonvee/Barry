import crypto from "node:crypto";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { loadControls } from "@/lib/hq/controls";
import { runObligationExecutor, type SenderResolver } from "@/lib/operator/executor";
import { whatsappConfig, whatsappSender } from "@/lib/channels/whatsapp";
import type { Obligation, ObligationKind } from "@/lib/operator/obligation-model";
import type { OwnerWorkspace } from "./service";
import type { CommandSource } from "./command";
import { derivedState, groundCohort, operationProgress, operationTitle, type OwnerOperation, type OwnerOperationView } from "./operation-model";

/**
 * OWNER OPERATIONS (server) — persistence, grounding against live records, execution through the
 * bounded proactive executor (restricted to the grounded cohort), stop, and the owner-safe view.
 */

/** Batches above this size wait for the owner's explicit go ("Start"). */
export const CONFIRM_ABOVE = 10;

const PLANNED: Partial<Record<ObligationKind, string>> = {
  abandoned_checkout_recovery: "One friendly reminder in their conversation that their cart is waiting — nothing charged, no discount offered.",
  unpaid_payment_followup: "One reminder that their payment link is still open — nothing charged, no discount offered.",
  appointment_reminder: "One reminder of their upcoming appointment.",
};
const AUTHORITY = "Reminder only — no discount, price change or charge. Anything a customer asks for next goes through your usual limits and approvals.";

export async function listOperations(businessId: string): Promise<OwnerOperation[]> {
  return (await getBackend().listOperatorRecords(businessId, "owner_operation")).map((r) => r.data as unknown as OwnerOperation).filter((o) => o && Array.isArray(o.targets)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveOperation(op: OwnerOperation): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: op.businessId, kind: "owner_operation", key: op.id, data: op as unknown as Record<string, unknown> });
}

function lastCustomerTimes(conversations: ConversationState[]): Record<string, string | undefined> {
  return Object.fromEntries(conversations.map((c) => [c.id, [...c.messages].reverse().find((m) => m.role === "customer")?.at]));
}

/** Ground and persist a new operation (does not run it). */
export async function proposeOperation(input: { graph: BusinessGraph; ws: OwnerWorkspace; workflow: ObligationKind; scope: "today" | "open"; commandId: string; source: CommandSource; actor: string; now?: Date }): Promise<OwnerOperation> {
  const now = input.now ?? new Date();
  const businessId = input.graph.business.id;
  const [controls, conversations] = await Promise.all([loadControls(businessId), getConversationStore().listByBusiness(businessId)]);
  const rule = input.ws.operator.rules.find((r) => r.kind === input.workflow);
  const since = input.ws.window.since;
  const targets = groundCohort({ workflow: input.workflow, scope: { kind: input.scope, since }, obligations: input.ws.obligations, conversations: input.ws.conversations, rule, disabledChannels: controls.disabledChannels, lastCustomerAt: lastCustomerTimes(conversations), whatsappLive: whatsappConfig().sendMode === "live", now });
  const blockedReason = !input.ws.operator.included
    ? "Automatic follow-ups aren't part of your current plan, so BARRY won't contact customers on its own."
    : rule && !rule.enabled
      ? "Your follow-up rules turn this off, so BARRY doesn't do it."
      : controls.pausedBusiness || controls.pauseConsequentialWrites || controls.safeMode
        ? "BARRY's outreach is paused for your business right now by the BARRY team."
        : undefined;
  const t = operationTitle(input.workflow);
  const at = now.toISOString();
  const op: OwnerOperation = {
    id: `op_${crypto.randomBytes(6).toString("hex")}`,
    businessId,
    commandId: input.commandId,
    workflow: input.workflow,
    title: t.title,
    command: t.command,
    scope: { kind: input.scope, since, label: input.scope === "today" ? "today" : "everything still open" },
    requestedBy: { source: input.source, actor: input.actor },
    plannedAction: PLANNED[input.workflow] ?? "One reminder in their conversation.",
    rule: rule ? { afterHours: rule.afterHours, maxAttempts: rule.maxAttempts, intervalHours: rule.intervalHours } : null,
    authority: AUTHORITY,
    entitlement: input.ws.operator.included ? "included" : "not_included",
    state: blockedReason ? "blocked" : "proposed",
    ...(blockedReason ? { blockedReason } : {}),
    targets,
    actionToken: crypto.randomBytes(9).toString("base64url"),
    createdAt: at,
    updatedAt: at,
    events: [{ at, what: blockedReason ? `Blocked: ${blockedReason}` : `Grounded ${targets.length} customer${targets.length === 1 ? "" : "s"}: ${targets.filter((x) => x.eligibility === "eligible").length} eligible` }],
  };
  await saveOperation(op);
  return op;
}

/**
 * Run a proposed operation exactly once: compare-and-set proposed → running, then one bounded executor
 * pass over the eligible keys only. A second call (double tap, retry) finds it no longer proposed.
 */
let sendersForTests: SenderResolver | undefined;
/** Tests only: a capturing "live" sender so the real-send path is exercised without anything leaving. */
export function setOperationSendersForTests(resolver: SenderResolver | undefined): void {
  sendersForTests = resolver;
}

export async function runOperation(graph: BusinessGraph, opId: string, now = new Date()): Promise<{ ok: true; op: OwnerOperation } | { ok: false; reason: "not_found" | "not_proposed"; op?: OwnerOperation }> {
  const businessId = graph.business.id;
  const op = (await listOperations(businessId)).find((o) => o.id === opId);
  if (!op) return { ok: false, reason: "not_found" };
  if (op.state !== "proposed") return { ok: false, reason: "not_proposed", op };
  const at = now.toISOString();
  op.state = "running";
  op.startedAt = at;
  op.updatedAt = at;
  op.events.push({ at, what: "Started" });
  await saveOperation(op);
  const eligible = op.targets.filter((t) => t.eligibility === "eligible").map((t) => t.key);
  const wa = whatsappConfig();
  try {
    const run = eligible.length ? await runObligationExecutor(graph, { now, only: eligible, dueNow: true, limit: eligible.length, senders: sendersForTests ?? ((c) => (c.id.startsWith("wa:") && wa.sendMode === "live" ? whatsappSender() : undefined)) }) : { results: [], acted: 0, blocked: undefined as string | undefined };
    for (const t of op.targets) {
      const r = run.results.find((x) => x.key === t.key);
      if (r) t.result = { outcome: r.outcome, why: r.why, at, ...(r.attempt ? { attempt: r.attempt } : {}) };
      else if (t.eligibility === "eligible") t.result = { outcome: "skipped", why: "no longer due when BARRY re-checked the records", at };
    }
    // Only a message that really left is contact; a test-mode run is recorded as exactly that.
    const sent = op.targets.filter((t) => t.result?.outcome === "sent").length;
    const dry = op.targets.filter((t) => t.result?.outcome === "dry_run").length;
    const failed = op.targets.filter((t) => t.result?.outcome === "failed").length;
    op.state = run.blocked ? "blocked" : sent > 0 ? "waiting_on_customers" : failed > 0 ? "failed" : "completed";
    if (run.blocked) op.blockedReason = "BARRY's outreach is paused or not included for your business right now.";
    if (op.state === "completed" || op.state === "failed" || op.state === "blocked") op.finishedAt = at;
    op.events.push({ at, what: `Contacted ${sent}${dry ? ` · test mode: ${dry} recorded, not sent` : ""}${failed ? ` · ${failed} failed` : ""}` });
  } catch (err) {
    op.state = "failed";
    op.finishedAt = at;
    op.events.push({ at, what: `Failed: ${err instanceof Error ? err.message.slice(0, 120) : "error"}` });
  }
  op.updatedAt = new Date().toISOString();
  await saveOperation(op);
  return { ok: true, op };
}

/** Stop: no new work for this cohort; what was already sent stays sent (and is said so). */
export async function stopOperation(businessId: string, opId: string, by: string, now = new Date()): Promise<OwnerOperation | undefined> {
  const op = (await listOperations(businessId)).find((o) => o.id === opId);
  if (!op) return undefined;
  if (op.state === "stopped" || op.state === "completed" || op.state === "failed" || op.state === "blocked") return op;
  const at = now.toISOString();
  op.state = "stopped";
  op.stoppedAt = at;
  op.stoppedBy = by;
  op.updatedAt = at;
  op.events.push({ at, what: `Stopped by ${by}` });
  await saveOperation(op);
  return op;
}

export const ACTIVE = ["proposed", "running", "waiting_on_customers"] as const;

/** The owner-safe view: no action token, live progress from the records. */
export function operationView(op: OwnerOperation, obligations: Obligation[], conversations: { id: string; messages: { role: string; at: string }[] }[]): OwnerOperationView {
  const customerMessages = Object.fromEntries(conversations.map((c) => [c.id, c.messages.filter((m) => m.role === "customer").map((m) => m.at)]));
  const progress = operationProgress(op, obligations, customerMessages);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { actionToken, targets, ...rest } = op;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return { ...rest, targets: targets.map(({ result, ...t }) => t), progress, derivedState: derivedState(op, progress) };
}
