import crypto from "node:crypto";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { resumeAfterApproval } from "@/lib/runtime";
import { moneyWords, hasMoney } from "@/lib/format/money";
import type { OwnerOutbound } from "@/lib/owner-channel/transport";
import { getOwnerWorkspace, type OwnerWorkspace } from "./service";
import { askOwnerBarry } from "./ask";
import { nowWorking } from "./control-room";
import { interpretCommand, type CommandIntent, type CommandSource } from "./command";
import { STARTABLE, STATE_WORDS, operationTitle, type OwnerOperation, type OwnerOperationView } from "./operation-model";
import { ACTIVE, CONFIRM_ABOVE, listOperations, operationView, proposeOperation, runOperation, saveOperation, stopOperation } from "./operations";

/**
 * THE OWNER COMMAND SERVICE — the single pipeline behind the web command bar and the Owner WhatsApp
 * channel (and voice later). The transport only delivers text or a tapped action; this service:
 *
 *   idempotency key → interpretation (semantic intent) → current business state (the owner read model)
 *   → grounding (exact cohort / exact request / exact customer) → plan entitlement → owner rules and
 *   founder controls → plan → approval where required → bounded execution (the proactive executor, the
 *   approval resume path) → verification from records → reply → durable command record with trace.
 *
 * Free-form text never mutates consequential state directly: a batch is grounded first (and waits for an
 * explicit "Start" above CONFIRM_ABOVE customers); an approval executes only against an exact request
 * revision the owner was shown (a stored, single-use prompt); a rule becomes a proposal for the reviewed
 * Train BARRY path. Every reply is built from records — never from a model guess.
 */

export type OwnerActor = { kind: "web" } | { kind: "whatsapp"; identityId: string; masked: string };
const actorId = (a: OwnerActor) => (a.kind === "web" ? "web" : a.identityId);
export const actorLabel = (a: OwnerActor) => (a.kind === "web" ? "the owner (web)" : `the owner on WhatsApp ${a.masked}`);

export type TraceStep = { step: "identity" | "business" | "interpretation" | "state" | "grounding" | "entitlement" | "authority" | "plan" | "approval" | "execution" | "verification" | "reply" | "delivery"; outcome: "ok" | "blocked" | "failed" | "info"; detail: string; at: string };

export type OwnerReply = OwnerOutbound & { intent: CommandIntent["kind"]; operation?: OwnerOperationView };

export type OwnerCommandRecord = {
  id: string;
  key: string;
  businessId: string;
  source: CommandSource;
  actor: string;
  text: string;
  intent?: CommandIntent;
  status: "received" | "done" | "failed";
  trace: TraceStep[];
  reply?: OwnerReply;
  operationId?: string;
  createdAt: string;
  updatedAt: string;
  delivery?: { status: string; at: string; reason?: string };
};

export type OwnerPrompt = { key: string; businessId: string; kind: "approval"; approvalId: string; revision: number; interventionId: string; customer: string; to: string; createdAt: string; expiresAt: string; usedAt?: string; usedFor?: string };

const PROMPT_HOURS = 24;

/** Absolute links for message channels; relative on the web. Links never carry authority — the page still requires owner sign-in. */
export function ownerLink(path: string, source: CommandSource): string | undefined {
  if (source === "web") return path;
  const base = process.env.BARRY_PUBLIC_URL?.replace(/\/$/, "") || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return base ? `${base}${path}` : undefined;
}
const links = (source: CommandSource, items: { label: string; path: string }[]) => items.flatMap((i) => (ownerLink(i.path, source) ? [{ label: i.label, href: ownerLink(i.path, source)! }] : []));

export async function getCommandRecord(businessId: string, key: string): Promise<OwnerCommandRecord | undefined> {
  return (await getBackend().listOperatorRecords(businessId, "owner_command")).map((r) => r.data as unknown as OwnerCommandRecord).find((c) => c.key === key);
}
export async function listCommandRecords(businessId: string): Promise<OwnerCommandRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "owner_command")).map((r) => r.data as unknown as OwnerCommandRecord).filter((c) => c && c.key).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function saveCommand(c: OwnerCommandRecord): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: c.businessId, kind: "owner_command", key: c.key, data: c as unknown as Record<string, unknown> });
}
export async function recordDelivery(businessId: string, key: string, delivery: OwnerCommandRecord["delivery"]): Promise<void> {
  const c = await getCommandRecord(businessId, key);
  if (!c) return;
  c.delivery = delivery;
  c.trace.push({ step: "delivery", outcome: delivery?.status === "failed" || delivery?.status === "blocked" ? "failed" : "ok", detail: `${delivery?.status}${delivery?.reason ? ` — ${delivery.reason}` : ""}`, at: delivery?.at ?? new Date().toISOString() });
  await saveCommand(c);
}

// ── Prompts: the exact request an owner may decide from a message ────────────────────────────────

export async function listPrompts(businessId: string): Promise<OwnerPrompt[]> {
  return (await getBackend().listOperatorRecords(businessId, "owner_prompt")).map((r) => r.data as unknown as OwnerPrompt).filter((p) => p && p.approvalId);
}
async function savePrompt(p: OwnerPrompt): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: p.businessId, kind: "owner_prompt", key: p.key, data: p as unknown as Record<string, unknown> });
}

/** A decision prompt for one exact, current request (approval id + revision), for one recipient. */
export async function approvalPrompt(ws: OwnerWorkspace, interventionId: string, to: string, source: CommandSource, now = new Date()): Promise<OwnerOutbound | undefined> {
  const item = ws.interventions.find((i) => i.id === interventionId);
  const approval = item?.refs.approvalId ? ws.approvals.find((a) => a.id === item.refs.approvalId) : undefined;
  if (!item || !approval || !approval.actionable) return undefined;
  const p: OwnerPrompt = { key: `pr_${crypto.randomBytes(8).toString("hex")}`, businessId: ws.business.id, kind: "approval", approvalId: approval.id, revision: approval.revision, interventionId, customer: item.customer, to, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PROMPT_HOURS * 3600_000).toISOString() };
  await savePrompt(p);
  return {
    text: `Needs your approval\n\n${item.customer}: ${item.title}${item.amount && !item.title.includes(item.amount) ? `\n${item.amount}` : ""}\n\nWhy you: ${item.why}\nIf you approve: ${item.options.find((o) => o.action === "approve")?.consequence ?? item.then}`,
    actions: [{ id: `d:${p.key}:approve`, title: "Approve" }, { id: `d:${p.key}:decline`, title: "Decline" }],
    links: links(source, [{ label: "Review", path: `/owner?tab=actions&intervention=${encodeURIComponent(interventionId)}` }]),
  };
}

// ── Reads (from the owner read model only) ──────────────────────────────────────────────────────

const m = (x: Record<string, number>, empty = "none") => moneyWords(x, { empty });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function nameMatches(label: string, subject: string): boolean {
  const s = subject.toLowerCase();
  return label.toLowerCase().split(/[^\p{L}]+/u).includes(s);
}

async function answerQuery(intent: Extract<CommandIntent, { kind: "query" }>, ws: OwnerWorkspace, ops: OwnerOperationView[], ctx: { graph: BusinessGraph; source: CommandSource; actor: OwnerActor; text: string; now: Date }): Promise<OwnerOutbound> {
  switch (intent.topic) {
    case "initiatives": {
      // Only what scans persisted with evidence — never a new "insight" made up on demand.
      const money = intent.subject === "money";
      const list = ws.initiatives.filter((i) => !money || i.category === "money_leakage" || i.category === "abandoned_demand" || i.category === "cost_margin");
      if (!list.length) return { text: money ? "I don't see money slipping away in your records right now — nothing at risk or left without a follow-up that I can prove." : "Nothing stood out in my last look at your records. I'll tell you when something does — I won't make things up to fill the space.", links: links(ctx.source, [{ label: "Today", path: "/owner?tab=today" }]) };
      const lines = list.slice(0, 3).map((i) => `• ${i.title}\n  ${i.observation}\n  → ${i.recommendation.text}`);
      return { text: `What I noticed${money ? " about money" : ""}:\n${lines.join("\n")}${list.length > 3 ? `\n…and ${list.length - 3} more on Today.` : ""}`, links: links(ctx.source, [{ label: "See it on Today", path: "/owner?tab=today" }]) };
    }
    case "needs_you": {
      if (!ws.interventions.length) return { text: "Nothing needs you right now. I'm handling everything inside your rules." };
      const lines = ws.interventions.slice(0, 5).map((i, n) => `${n + 1}. ${i.customer} — ${i.title}`);
      const first = ws.interventions.find((i) => i.refs.approvalId && ws.approvals.some((a) => a.id === i.refs.approvalId && a.actionable));
      const prompt = first ? await approvalPrompt(ws, first.id, actorId(ctx.actor), ctx.source, ctx.now) : undefined;
      const more = ws.interventions.length > 5 ? `\n…and ${ws.interventions.length - 5} more.` : "";
      // The first decidable request carries its why / consequence and Approve / Decline (no repeated title).
      const detail = prompt ? `\n\nWhy you:${prompt.text.split("\n\nWhy you:")[1] ?? ""}` : "";
      return { text: `${plural(ws.interventions.length, "thing")} need${ws.interventions.length === 1 ? "s" : ""} you:\n${lines.join("\n")}${more}${detail}`, actions: prompt?.actions, links: [...(prompt?.links ?? []), ...links(ctx.source, [{ label: "All decisions", path: "/owner?tab=actions" }])].slice(0, 2) };
    }
    case "working": {
      const lines = nowWorking(ws).map((l) => `• ${l.text}`);
      const active = ops.filter((o) => (ACTIVE as readonly string[]).includes(o.derivedState));
      for (const o of active) lines.unshift(`• ${o.title} (you asked${o.requestedBy.source === "whatsapp" ? " on WhatsApp" : ""}) — ${STATE_WORDS[o.derivedState].toLowerCase()}: ${progressWords(o)}`);
      return { text: lines.length ? `Right now:\n${lines.join("\n")}` : "Nothing open right now — I'm watching for the next customer.", links: links(ctx.source, [{ label: "Today", path: "/owner?tab=today" }]) };
    }
    case "money": {
      const r = ws.revenue;
      const s = ws.opportunities.summary;
      const lines = [`Made (verified by your payment provider): ${m(r.direct, "nothing yet")}${r.directPayments ? ` from ${plural(r.directPayments, "payment")}` : ""}.`];
      if (hasMoney(r.recovered)) lines.push(`Recovered (inside made): ${m(r.recovered)}.`);
      lines.push(`Pending — not revenue yet: ${m(r.potential)}.`);
      if (hasMoney(s.atRisk)) lines.push(`At risk: ${m(s.atRisk)}.`);
      if (hasMoney(r.simulatedPaid) || r.potentialSimulatedItems) lines.push(`Test money (simulator, never counted): ${m(r.simulatedPaid, "none paid")}${r.potentialSimulatedItems ? `, ${m(r.potentialSimulated)} pending` : ""}.`);
      return { text: `${ws.window.label === "today" ? "Today" : ws.window.label}:\n${lines.join("\n")}`, links: links(ctx.source, [{ label: "Money", path: "/owner?tab=money" }]) };
    }
    case "waiting_customers": {
      const onYou = ws.conversations.filter((c) => c.status === "needs_you");
      const onThem = ws.conversations.filter((c) => c.status === "waiting_on_customer");
      const live = ws.conversations.filter((c) => c.status === "in_progress");
      const name = (c: { customer: string; lastActivityAt: string }) => `${c.customer} (${hoursAgo(c.lastActivityAt, ctx.now)})`;
      const lines = [onYou.length ? `Waiting on you: ${onYou.slice(0, 5).map(name).join(", ")}` : "Nobody is waiting on you.", live.length ? `Talking with BARRY now: ${live.slice(0, 5).map(name).join(", ")}` : "", onThem.length ? `BARRY is waiting to hear back from: ${onThem.slice(0, 5).map(name).join(", ")}` : ""].filter(Boolean);
      return { text: lines.join("\n"), links: links(ctx.source, [{ label: "Inbox", path: "/owner?tab=inbox" }]) };
    }
    case "customer": {
      const subject = intent.subject ?? "";
      const found = ws.conversations.filter((c) => nameMatches(c.customer, subject));
      if (found.length === 0) return { text: `I don't see a customer called ${subject} in your conversations.` };
      if (found.length > 1) return { text: `${plural(found.length, "customer")} match “${subject}”: ${found.slice(0, 5).map((c) => c.customer).join(", ")}. Which one?` };
      const c = found[0];
      const money = ws.revenueEvidence.filter((e) => e.conversationId === c.id);
      const paid = money.filter((e) => e.category === "collected");
      const pending = money.filter((e) => e.category === "open_opportunity");
      const test = money.filter((e) => e.category === "simulated");
      const payment = paid.length ? `Paid: ${m(sum(paid))}, verified by your payment provider.` : pending.length ? `Not paid yet — ${m(sum(pending))} link still open.` : test.length ? `Only test money (simulator): ${m(sum(test))} — not counted.` : "No payment from them yet.";
      const needs = ws.interventions.filter((i) => i.conversationId === c.id).map((i) => `Needs you: ${i.title}`);
      const state = await getConversationStore().get(c.id);
      const story = state ? (await import("./story")).conversationStory(state) : undefined;
      const lines = [`${c.customer} — ${STATUS_WORDS[c.status]}`, ...(story?.standing.slice(0, 2) ?? []), payment, ...needs];
      return { text: lines.join("\n"), links: links(ctx.source, [{ label: "Open conversation", path: `/owner?tab=inbox&conversation=${encodeURIComponent(c.id)}` }]) };
    }
    case "operation": {
      const op = ops.find((o) => !intent.workflow || o.workflow === intent.workflow);
      if (!op) return { text: intent.workflow ? `You haven't started ${operationTitle(intent.workflow).command.toLowerCase()} yet. Tell me to, and I'll show you exactly who it would reach first.` : "You haven't started anything from a command yet." };
      return { text: operationSummary(op), links: links(ctx.source, [{ label: "See it live", path: `/owner?tab=today&operation=${encodeURIComponent(op.id)}` }]) };
    }
    case "capabilities": {
      const now = ws.capabilities.now.slice(0, 6);
      return { text: now.length ? `What I do for real now:\n${now.map((c) => `• ${c}`).join("\n")}${ws.capabilities.nowSimulated.length ? `\nOn a simulator only: ${ws.capabilities.nowSimulated.slice(0, 3).join(", ")}` : ""}` : "Nothing runs for real yet — Train BARRY shows what unlocks it.", links: links(ctx.source, [{ label: "Train BARRY", path: "/owner/train" }]) };
    }
    default: {
      const a = await askOwnerBarry(ctx.graph, ctx.text);
      if (ctx.source !== "web" && a.source === "briefing") return { text: HELP };
      return { text: ctx.source === "web" ? a.answer : a.answer.slice(0, 1500), links: a.links.interventions[0] ? links(ctx.source, [{ label: `Decide: ${a.links.interventions[0].customer}`, path: `/owner?tab=actions&intervention=${encodeURIComponent(a.links.interventions[0].id)}` }]) : undefined };
    }
  }
}

const HELP = "You can ask me things like:\n• Who needs me?\n• What are you working on?\n• How much did we make today?\n• What happened with Maya?\nOr tell me: “Recover today's abandoned carts”, “Stop the recovery”, “Don't offer more than 5% today”.";
const STATUS_WORDS: Record<OwnerWorkspace["conversations"][number]["status"], string> = { needs_you: "waiting on you", waiting_on_customer: "BARRY is waiting to hear back", completed: "done", lost: "lost", in_progress: "talking with BARRY now" };
const sum = (rows: { amount: number; currency: string }[]) => rows.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.currency]: Math.round(((acc[e.currency] ?? 0) + e.amount) * 100) / 100 }), {});
function hoursAgo(iso: string, now: Date): string {
  const h = Math.floor((now.getTime() - Date.parse(iso)) / 3600_000);
  return h < 1 ? "just now" : h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function progressWords(o: OwnerOperationView): string {
  const p = o.progress;
  const parts = [`contacted ${p.contacted}`, `replied ${p.replied}`, `purchased ${p.purchased}`];
  if (hasMoney(p.recovered)) parts.push(`recovered ${m(p.recovered)}`);
  if (p.stillTalking) parts.push(`still talking ${p.stillTalking}`);
  if (p.failed) parts.push(`failed ${p.failed}`);
  return parts.join(" · ");
}

export function operationSummary(o: OwnerOperationView): string {
  const p = o.progress;
  const head = `${o.title} — ${STATE_WORDS[o.derivedState]}`;
  if (o.derivedState === "blocked") return `${head}\n${o.blockedReason ?? ""}`;
  const lines = [head, `Contacted: ${p.contacted}`, `Replied: ${p.replied}`, `Purchased: ${p.purchased}`];
  if (hasMoney(p.recovered)) lines.push(`Recovered: ${m(p.recovered)} (verified)`);
  if (p.stillTalking) lines.push(`Still talking: ${p.stillTalking}`);
  if (p.failed) lines.push(`Failed: ${p.failed}`);
  if (o.stoppedAt) lines.push(`Stopped by you — messages already sent stay sent.`);
  if (p.test) lines.push(`${plural(p.test, "customer")} in test mode (simulator) — never counted as money.`);
  return lines.join("\n");
}

/** "Found 47 … 35 eligible · 8 already purchased · 4 can't be contacted (reasons)". */
export function groundingSummary(op: OwnerOperation): string {
  const eligible = op.targets.filter((t) => t.eligibility === "eligible");
  const done = op.targets.filter((t) => t.alreadyDone);
  const other = op.targets.filter((t) => t.eligibility === "excluded" && !t.alreadyDone);
  const reasons = new Map<string, number>();
  for (const t of other) reasons.set(t.reason ?? "excluded", (reasons.get(t.reason ?? "excluded") ?? 0) + 1);
  const noun = operationTitle(op.workflow).command.toLowerCase().replace(/^\w+ /, "");
  const lines = [`Found ${plural(op.targets.length, singular(noun), noun)} ${op.scope.kind === "today" ? "from today" : "still open"}.`, `${eligible.length} ${eligible.length === 1 ? "is" : "are"} eligible for a follow-up.`];
  if (done.length) lines.push(`${done.length} already done (${done[0].reason}).`);
  if (other.length) lines.push(`${other.length} can't be contacted now: ${[...reasons.entries()].map(([r, n]) => `${n} ${r}`).join("; ")}.`);
  const early = eligible.filter((t) => t.reason).length;
  if (early) lines.push(`${early} ${early === 1 ? "isn't" : "aren't"} due yet under your rule — included because you asked now.`);
  return lines.join("\n");
}
const singular = (noun: string) => noun.replace(/ies$/, "y").replace(/s$/, "");

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────────

export type ExecuteInput = { graph: BusinessGraph; source: CommandSource; actor: OwnerActor; key: string; text?: string; actionId?: string; now?: Date; trace?: TraceStep[] };

export async function executeOwnerCommand(input: ExecuteInput): Promise<{ record: OwnerCommandRecord; reply: OwnerReply; duplicate: boolean }> {
  const now = input.now ?? new Date();
  const at = () => new Date().toISOString();
  const businessId = input.graph.business.id;
  // Idempotency: the same key (provider message id / web request id) never runs twice — the stored reply is returned.
  const existing = await getCommandRecord(businessId, input.key);
  if (existing) return { record: existing, reply: existing.reply ?? { text: "Already received — still working on it.", intent: existing.intent?.kind ?? "query" }, duplicate: true };
  const record: OwnerCommandRecord = { id: `cmd_${crypto.randomBytes(6).toString("hex")}`, key: input.key, businessId, source: input.source, actor: actorLabel(input.actor), text: (input.text ?? input.actionId ?? "").slice(0, 1000), status: "received", trace: [...(input.trace ?? []), { step: "business", outcome: "ok", detail: `business ${businessId}`, at: at() }], createdAt: now.toISOString(), updatedAt: now.toISOString() };
  // Marked received BEFORE anything runs: at-most-once execution even if the process dies mid-way.
  await saveCommand(record);
  try {
    const reply = await dispatch(input, record, now);
    record.reply = reply;
    record.status = "done";
    record.trace.push({ step: "reply", outcome: "ok", detail: reply.text.split("\n")[0].slice(0, 160), at: at() });
  } catch (err) {
    record.status = "failed";
    record.reply = { text: "Something went wrong on my side — nothing was changed. Try again in a moment.", intent: record.intent?.kind ?? "query" };
    record.trace.push({ step: "execution", outcome: "failed", detail: err instanceof Error ? err.message.slice(0, 200) : "error", at: at() });
  }
  record.updatedAt = at();
  await saveCommand(record);
  return { record, reply: record.reply!, duplicate: false };
}

async function dispatch(input: ExecuteInput, record: OwnerCommandRecord, now: Date): Promise<OwnerReply> {
  const { graph, source, actor } = input;
  const t = () => new Date().toISOString();
  const step = (s: TraceStep["step"], outcome: TraceStep["outcome"], detail: string) => record.trace.push({ step: s, outcome, detail, at: t() });

  // A tapped action resolves to an exact stored object; free text is interpreted semantically.
  const action = input.actionId ? parseAction(input.actionId) : undefined;
  if (input.actionId && !action) {
    step("interpretation", "blocked", "unrecognised action id");
    return { text: "I couldn't match that button to anything I sent you — nothing was done.", intent: "unsupported" };
  }
  const intent: CommandIntent = action ? (action.type === "decision" ? { kind: "approval_response", decision: action.decision } : action.type === "start" ? { kind: "operation_confirm" } : { kind: "operation_stop" }) : interpretCommand(input.text ?? "", source).intent;
  record.intent = intent;
  step("interpretation", "ok", `${intent.kind}${"topic" in intent ? `:${intent.topic}` : ""}${"workflow" in intent && intent.workflow ? `:${intent.workflow}` : ""}${action ? " (exact action)" : ""}`);

  const ws = await getOwnerWorkspace(graph, { now });
  step("state", ws.unavailable.length ? "info" : "ok", ws.unavailable.length ? `records unavailable: ${ws.unavailable.join(", ")}` : "current records loaded");
  const conversations = await getConversationStore().listByBusiness(graph.business.id);
  const views = (await listOperations(graph.business.id)).map((o) => operationView(o, ws.obligations, conversations));

  switch (intent.kind) {
    case "query":
      return { ...(await answerQuery(intent, ws, views, { graph, source, actor, text: input.text ?? "", now })), intent: "query" };

    case "operation_request": {
      if (!STARTABLE.includes(intent.workflow)) {
        step("grounding", "blocked", `no customer-facing follow-up for ${intent.workflow}`);
        return { text: `I can't start that on my own — there's no message BARRY can send customers for ${operationTitle(intent.workflow).command.toLowerCase()} yet. It stays on your list instead.`, intent: intent.kind };
      }
      if (ws.unavailable.includes("obligations") || ws.unavailable.includes("conversations")) {
        step("grounding", "blocked", "records unavailable — cohort can't be grounded");
        return { text: "I can't read your records right now, so I can't tell exactly who this would reach. Nothing was started — try again in a moment.", intent: intent.kind };
      }
      const op = await proposeOperation({ graph, ws, workflow: intent.workflow, scope: intent.scope, commandId: record.id, source, actor: actorLabel(actor), now });
      record.operationId = op.id;
      const eligible = op.targets.filter((x) => x.eligibility === "eligible").length;
      step("grounding", "ok", `cohort ${op.targets.length}: ${eligible} eligible, ${op.targets.length - eligible} excluded`);
      step("entitlement", op.entitlement === "included" ? "ok" : "blocked", op.entitlement === "included" ? "proactive follow-ups included" : "not included in the plan");
      step("authority", op.state === "blocked" ? "blocked" : "ok", op.state === "blocked" ? op.blockedReason ?? "blocked" : `${op.authority} Rule: ${op.rule ? `after ${op.rule.afterHours}h, max ${op.rule.maxAttempts}, every ${op.rule.intervalHours}h` : "none"}`);
      const link = links(source, [{ label: "See it live", path: `/owner?tab=today&operation=${encodeURIComponent(op.id)}` }]);
      if (op.state === "blocked") return { text: `${op.blockedReason}${op.entitlement === "not_included" ? "" : ""} Nothing was started.`, intent: intent.kind, links: op.entitlement === "not_included" ? links(source, [{ label: "Your plan", path: "/owner/settings#plan" }]) : undefined, operation: operationView(op, ws.obligations, conversations) };
      const summary = groundingSummary(op);
      if (eligible === 0) {
        op.state = "completed";
        op.finishedAt = t();
        op.events.push({ at: t(), what: "Nothing eligible — nothing sent" });
        await saveOperation(op);
        step("plan", "info", "nothing eligible");
        return { text: `${summary}\n\nNobody to contact right now — nothing was sent.`, intent: intent.kind, links: link, operation: operationView(op, ws.obligations, conversations) };
      }
      if (eligible > CONFIRM_ABOVE) {
        step("plan", "info", `waiting for the owner's go (${eligible} > ${CONFIRM_ABOVE})`);
        return { text: `${summary}\n\n${op.plannedAction}\nShall I start with the ${eligible} eligible customers?`, actions: [{ id: `o:${op.id}:${op.actionToken}:start`, title: "Start" }, { id: `o:${op.id}:${op.actionToken}:stop`, title: "Cancel" }], links: link, intent: intent.kind, operation: operationView(op, ws.obligations, conversations) };
      }
      step("plan", "ok", `starting now with ${eligible}`);
      return { ...(await start(op.id, `${summary}\n\nStarting with the ${eligible} eligible customer${eligible === 1 ? "" : "s"}.`)), intent: intent.kind };
    }

    case "operation_confirm": {
      const ops = await listOperations(graph.business.id);
      const target = action?.type === "start" ? ops.find((o) => o.id === action.opId) : ops.filter((o) => o.state === "proposed" && Date.parse(o.createdAt) > now.getTime() - 30 * 60_000)[0];
      if (action?.type === "start" && (!target || target.actionToken !== action.token)) {
        step("grounding", "blocked", "start action does not match a stored operation token");
        return { text: "That button doesn't match anything waiting for you — nothing was started.", intent: intent.kind };
      }
      if (!target || target.state !== "proposed") {
        step("grounding", "info", target ? `operation already ${target.state}` : "nothing proposed");
        return { text: target ? `That one is already ${STATE_WORDS[target.state].toLowerCase()} — nothing new was started.` : "Nothing is waiting for your go right now.", intent: intent.kind };
      }
      return { ...(await start(target.id, `Starting ${target.title.toLowerCase()} for ${target.targets.filter((x) => x.eligibility === "eligible").length} customers.`)), intent: intent.kind };
    }

    case "operation_stop": {
      const ops = await listOperations(graph.business.id);
      const activeOps = ops.filter((o) => (ACTIVE as readonly string[]).includes(o.state) && views.find((v) => v.id === o.id)?.derivedState !== "completed");
      let chosen: OwnerOperation[];
      if (action?.type === "stop") {
        const o = ops.find((x) => x.id === action.opId);
        if (!o || o.actionToken !== action.token) {
          step("grounding", "blocked", "stop action does not match a stored operation token");
          return { text: "That button doesn't match anything running — nothing was changed.", intent: intent.kind };
        }
        chosen = [o];
      } else {
        const matching = intent.workflow ? activeOps.filter((o) => o.workflow === intent.workflow) : activeOps;
        if (matching.length === 0) {
          step("grounding", "info", "no active owner operation");
          return { text: "Nothing you started is running right now, so there's nothing to stop. Your automatic follow-up rules still run on their own — you can change them in Train BARRY.", intent: intent.kind, links: links(source, [{ label: "Train BARRY", path: "/owner/train" }]) };
        }
        if (matching.length > 1 && !intent.everything) {
          step("grounding", "info", `ambiguous: ${matching.length} active operations`);
          return { text: `${plural(matching.length, "thing")} you started ${matching.length === 1 ? "is" : "are"} running:\n${matching.map((o, i) => `${i + 1}. ${o.title}`).join("\n")}\nWhich should I stop? (Or say “stop everything”.)`, actions: matching.slice(0, 3).map((o) => ({ id: `o:${o.id}:${o.actionToken}:stop`, title: `Stop ${o.title.split(" ").slice(0, 2).join(" ")}`.slice(0, 20) })), intent: intent.kind };
        }
        chosen = matching;
      }
      const lines: string[] = [];
      for (const o of chosen) {
        const stopped = await stopOperation(graph.business.id, o.id, actorLabel(actor), now);
        if (!stopped) continue;
        const v = operationView(stopped, ws.obligations, conversations);
        step("execution", "ok", `stopped ${o.id}`);
        lines.push(stopped.state === "stopped" ? `Stopped ${stopped.title.toLowerCase()}. ${v.progress.contacted ? `${plural(v.progress.contacted, "customer")} already contacted — those messages stay sent. ` : ""}BARRY won't contact anyone else in it.` : `${stopped.title} was already ${STATE_WORDS[stopped.state].toLowerCase()}.`);
      }
      return { text: lines.join("\n"), intent: intent.kind };
    }

    case "approval_response": {
      const prompts = await listPrompts(graph.business.id);
      let prompt: OwnerPrompt | undefined;
      if (action?.type === "decision") {
        prompt = prompts.find((p) => p.key === action.promptKey);
        if (!prompt || prompt.to !== actorId(actor)) {
          step("approval", "blocked", prompt ? "prompt belongs to another recipient" : "unknown prompt");
          return { text: "That decision doesn't match a request I sent you — nothing was done.", intent: intent.kind };
        }
      } else {
        // Text decides only a request this owner was shown, still current, unambiguous.
        const mine = prompts.filter((p) => p.to === actorId(actor) && !p.usedAt && Date.parse(p.expiresAt) > now.getTime() && ws.approvals.some((a) => a.id === p.approvalId && a.actionable && a.revision === p.revision));
        const bySubject = intent.subject ? mine.filter((p) => nameMatches(p.customer, intent.subject!)) : mine;
        const distinct = [...new Map(bySubject.map((p) => [p.approvalId, p])).values()];
        if (distinct.length === 1 && source !== "web") prompt = distinct.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        else {
          const pending = ws.interventions.filter((i) => i.refs.approvalId && ws.approvals.some((a) => a.id === i.refs.approvalId && a.actionable) && (!intent.subject || nameMatches(i.customer, intent.subject)));
          step("approval", "info", pending.length ? "shown the exact request to decide" : "no matching request");
          if (!pending.length) return { text: intent.subject ? `Nothing from ${intent.subject} is waiting for your decision.` : "Nothing is waiting for your decision right now.", intent: intent.kind };
          const p = await approvalPrompt(ws, pending[0].id, actorId(actor), source, now);
          return { ...(p ?? { text: "That request isn't open any more." }), text: `${pending.length > 1 ? `${pending.length} requests are waiting — here's the first.\n\n` : ""}${p?.text ?? ""}`, intent: intent.kind };
        }
      }
      if (prompt.usedAt) {
        step("approval", "info", "prompt already used (duplicate)");
        return { text: "Already done — that decision was made once and won't run again.", intent: intent.kind };
      }
      if (Date.parse(prompt.expiresAt) < now.getTime()) {
        step("approval", "blocked", "prompt expired");
        return { text: "That request is too old to decide from here — open it to see where it stands.", links: links(source, [{ label: "Review", path: `/owner?tab=actions&intervention=${encodeURIComponent(prompt.interventionId)}` }]), intent: intent.kind };
      }
      const approval = ws.approvals.find((a) => a.id === prompt!.approvalId);
      if (!approval || !approval.actionable || approval.revision !== prompt.revision) {
        step("approval", "blocked", !approval ? "request not found" : !approval.actionable ? `request is ${approval.lifecycle}` : `revision changed ${prompt.revision} → ${approval.revision}`);
        const current = ws.interventions.find((i) => i.refs.approvalId === prompt!.approvalId);
        const again = approval?.actionable && current ? await approvalPrompt(ws, current.id, actorId(actor), source, now) : undefined;
        return { text: `That request changed or was already decided since I sent it — nothing was done.${again ? `\n\nHere's the current one:\n\n${again.text}` : ""}`, actions: again?.actions, links: again?.links, intent: intent.kind };
      }
      // Single use, marked BEFORE execution: a double tap or replay finds it used.
      await savePrompt({ ...prompt, usedAt: now.toISOString(), usedFor: `${intent.decision} by ${actorLabel(actor)}` });
      step("approval", "ok", `${intent.decision} ${approval.id} rev ${approval.revision}`);
      const outcome = await resumeAfterApproval(graph, approval.id, intent.decision === "approve" ? "approved" : "declined", actorLabel(actor));
      const held = outcome.turn.trace?.hold;
      step("execution", held ? "blocked" : "ok", held ? `held: ${held.reason}` : `${outcome.turn.trace?.stop.reason ?? "resumed"}`);
      step("verification", "ok", "approval resolved through the runtime resume path (revalidation, final-write gate, compare-and-set)");
      if (held) return { text: `Not carried out: ${held.reason}. The customer was asked to confirm first.`, intent: intent.kind };
      return { text: intent.decision === "approve" ? `Approved. BARRY told ${prompt.customer}: “${outcome.response.slice(0, 220)}”` : `Declined — ${prompt.customer} was told; nothing was sent or charged.`, links: links(source, [{ label: "Conversation", path: `/owner?tab=inbox&conversation=${encodeURIComponent(approval.conversationId)}` }]), intent: intent.kind };
    }

    case "policy_change_request": {
      step("plan", "info", `rule proposal prepared (not applied): ${intent.text.slice(0, 120)}`);
      return { text: `I've prepared this as a rule: “${intent.text.replace(/[.!]+$/, "")}”.\nRules take effect only after you review how I'll apply them — nothing has changed yet.`, links: links(source, [{ label: "Review the rule", path: `/owner/train?rule=${encodeURIComponent(intent.text)}#teach-rule` }]), intent: intent.kind };
    }

    case "unsupported":
      step("plan", "blocked", "unsupported");
      return { text: `${intent.reason} Nothing was started.`, intent: intent.kind };
  }

  async function start(opId: string, lead: string): Promise<Omit<OwnerReply, "intent">> {
    const res = await runOperation(graph, opId, now);
    if (!res.ok) {
      step("execution", "info", `not started: ${res.reason}`);
      return { text: res.op ? `That one is already ${STATE_WORDS[res.op.state].toLowerCase()} — nothing new was started.` : "I couldn't find that operation — nothing was started." };
    }
    const fresh = await getOwnerWorkspace(graph, { now });
    const view = operationView(res.op, fresh.obligations, await getConversationStore().listByBusiness(graph.business.id));
    const dry = res.op.targets.some((x) => x.result?.outcome === "dry_run");
    step("execution", res.op.state === "failed" || res.op.state === "blocked" ? "failed" : "ok", `${res.op.state}: contacted ${view.progress.contacted}, failed ${view.progress.failed}`);
    step("verification", "ok", "per-target attempts recorded by the executor; results will be read from records");
    return {
      text: `${lead}\n\n${operationSummary(view)}${dry ? "\n\n(Test mode: messages were recorded in each conversation, not sent over WhatsApp.)" : ""}`,
      actions: (ACTIVE as readonly string[]).includes(res.op.state) ? [{ id: `o:${res.op.id}:${res.op.actionToken}:stop`, title: "Stop" }] : undefined,
      links: links(source, [{ label: "See it live", path: `/owner?tab=today&operation=${encodeURIComponent(res.op.id)}` }]),
      operation: view,
    };
  }
}

type ParsedAction = { type: "decision"; promptKey: string; decision: "approve" | "decline" } | { type: "start" | "stop"; opId: string; token: string };
export function parseAction(id: string): ParsedAction | undefined {
  const d = id.match(/^d:(pr_[a-f0-9]{16}):(approve|decline)$/);
  if (d) return { type: "decision", promptKey: d[1], decision: d[2] as "approve" | "decline" };
  const o = id.match(/^o:(op_[a-f0-9]{12}):([A-Za-z0-9_-]{8,20}):(start|stop)$/);
  if (o) return { type: o[3] as "start" | "stop", opId: o[1], token: o[2] };
  return undefined;
}
