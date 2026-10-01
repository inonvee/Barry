import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { hasMoney, moneyWords } from "@/lib/format/money";
import { whatsappOwnerConfig, whatsappOwnerSender } from "@/lib/channels/whatsapp";
import { linkActive, listOwnerIdentities, maskedIdentity, type OwnerIdentity } from "@/lib/owner-channel/identity";
import { deliverOwner, type OwnerOutbound, type OwnerSender } from "@/lib/owner-channel/transport";
import { getOwnerWorkspace } from "./service";
import { approvalPrompt, operationSummary, ownerLink } from "./command-service";
import { listOperations, operationView } from "./operations";

/**
 * PROACTIVE OWNER BRIEFS — BARRY tells the owner what matters without being asked: a decision that
 * waits on them, an operation they started that finished, the day's short brief. Each one is a durable
 * record with a dedupe key (a decision is announced once per request revision per owner; a brief once
 * per day), so nothing is ever sent twice. WhatsApp only allows free-form messages within 24 hours of
 * the owner's last message; outside it a pre-approved template is required — none is configured, so
 * BARRY fails closed and records the blocker instead of sending.
 */

export type BriefRecord = { key: string; businessId: string; kind: "decision" | "operation_done" | "daily"; to: string; at: string; status: "sent" | "dry_run" | "failed" | "blocked"; reason?: string; text: string };

const WINDOW_MS = 24 * 3600_000;

async function briefs(businessId: string): Promise<BriefRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "owner_brief")).map((r) => r.data as unknown as BriefRecord);
}

export function ownerSenderOrUndefined(): OwnerSender | undefined {
  return whatsappOwnerConfig().configured ? whatsappOwnerSender() : undefined;
}

/** Deliver one brief to one owner, once per key, only where the channel allows it. */
async function deliverOnce(businessId: string, link: OwnerIdentity, key: string, kind: BriefRecord["kind"], message: OwnerOutbound, sender: OwnerSender | undefined, now: Date): Promise<BriefRecord | undefined> {
  if ((await briefs(businessId)).some((b) => b.key === key)) return undefined;
  const base = { key, businessId, kind, to: maskedIdentity(link), at: now.toISOString(), text: message.text.slice(0, 600) };
  let rec: BriefRecord;
  if (!sender) rec = { ...base, status: "blocked", reason: "BARRY's owner WhatsApp line isn't configured" };
  else if (!link.lastInboundAt || now.getTime() - Date.parse(link.lastInboundAt) > WINDOW_MS) rec = { ...base, status: "blocked", reason: "outside WhatsApp's 24-hour window — needs an approved message template (not configured)" };
  else {
    const d = await deliverOwner(sender, link.channelUserId, message, now);
    rec = { ...base, status: d.status === "blocked" ? "blocked" : d.status, ...(d.error ? { reason: d.error } : {}) };
  }
  await getBackend().upsertOperatorRecord({ businessId, kind: "owner_brief", key, data: rec as unknown as Record<string, unknown> });
  return rec;
}

async function recipients(businessId: string): Promise<OwnerIdentity[]> {
  return (await listOwnerIdentities(businessId)).filter((l) => linkActive(l).ok);
}

/** Every request waiting on the owner, announced once per exact revision, with Approve / Decline. */
export async function notifyOwnerDecisions(graph: BusinessGraph, opts: { sender?: OwnerSender; now?: Date } = {}): Promise<BriefRecord[]> {
  const now = opts.now ?? new Date();
  const to = await recipients(graph.business.id);
  if (!to.length) return [];
  const ws = await getOwnerWorkspace(graph, { now });
  const out: BriefRecord[] = [];
  for (const item of ws.interventions) {
    const approval = item.refs.approvalId ? ws.approvals.find((a) => a.id === item.refs.approvalId && a.actionable) : undefined;
    if (!approval) continue;
    for (const link of to) {
      const key = `decision:${approval.id}:r${approval.revision}:${link.id}`;
      if ((await briefs(graph.business.id)).some((b) => b.key === key)) continue;
      const prompt = await approvalPrompt(ws, item.id, link.id, "whatsapp", now);
      if (!prompt) continue;
      const rec = await deliverOnce(graph.business.id, link, key, "decision", prompt, opts.sender ?? ownerSenderOrUndefined(), now);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/** "BARRY finished the cart recovery you started" — once per operation. */
export async function notifyFinishedOperations(graph: BusinessGraph, opts: { sender?: OwnerSender; now?: Date } = {}): Promise<BriefRecord[]> {
  const now = opts.now ?? new Date();
  const to = await recipients(graph.business.id);
  if (!to.length) return [];
  const ws = await getOwnerWorkspace(graph, { now });
  const conversations = await getConversationStore().listByBusiness(graph.business.id);
  const out: BriefRecord[] = [];
  for (const op of await listOperations(graph.business.id)) {
    const v = operationView(op, ws.obligations, conversations);
    if (v.derivedState !== "completed" || !op.startedAt) continue;
    const link = ownerLink(`/owner?tab=today&operation=${encodeURIComponent(op.id)}`, "whatsapp");
    for (const l of to) {
      const rec = await deliverOnce(graph.business.id, l, `operation_done:${op.id}:${l.id}`, "operation_done", { text: `BARRY finished the ${op.title.toLowerCase()} you started.\n\n${operationSummary(v)}`, ...(link ? { links: [{ label: "See it", href: link }] } : {}) }, opts.sender ?? ownerSenderOrUndefined(), now);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/** The day's brief: only what the records say, only what matters, once per day. */
export function dailyBriefText(ws: Awaited<ReturnType<typeof getOwnerWorkspace>>, failedToday: number): string | undefined {
  const items: string[] = [];
  if (hasMoney(ws.revenue.direct)) items.push(`${moneyWords(ws.revenue.direct)} made (verified)`);
  if (hasMoney(ws.revenue.recovered)) items.push(`${moneyWords(ws.revenue.recovered)} recovered`);
  const deciding = ws.conversations.filter((c) => c.status === "waiting_on_customer").length;
  if (deciding) items.push(`${deciding} customer${deciding === 1 ? "" : "s"} still deciding`);
  const first = ws.interventions[0];
  if (first) items.push(ws.interventions.length === 1 ? `${first.customer} needs you: ${first.title}` : `${ws.interventions.length} things need you (first: ${first.customer})`);
  if (failedToday) items.push(`${failedToday} thing${failedToday === 1 ? "" : "s"} didn't go through`);
  if (hasMoney(ws.opportunities.summary.atRisk)) items.push(`${moneyWords(ws.opportunities.summary.atRisk)} at risk`);
  if (!items.length) return undefined;
  return `${items.length} thing${items.length === 1 ? "" : "s"} from today:\n${items.map((i) => `• ${i}`).join("\n")}`;
}

export async function sendDailyBrief(graph: BusinessGraph, opts: { sender?: OwnerSender; now?: Date } = {}): Promise<BriefRecord[]> {
  const now = opts.now ?? new Date();
  const to = await recipients(graph.business.id);
  if (!to.length) return [];
  const ws = await getOwnerWorkspace(graph, { now });
  const failed = ws.outcomes.filter((o) => o.kind === "failed").length;
  const text = dailyBriefText(ws, failed);
  if (!text) return [];
  // The business's own calendar day (dedupe key): one brief per local day.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: graph.business.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const link = ownerLink("/owner?tab=today", "whatsapp");
  const out: BriefRecord[] = [];
  for (const l of to) {
    const rec = await deliverOnce(graph.business.id, l, `daily:${day}:${l.id}`, "daily", { text, ...(link ? { links: [{ label: "Today", href: link }] } : {}) }, opts.sender ?? ownerSenderOrUndefined(), now);
    if (rec) out.push(rec);
  }
  return out;
}

export async function listBriefs(businessId: string): Promise<BriefRecord[]> {
  return (await briefs(businessId)).sort((a, b) => b.at.localeCompare(a.at));
}
