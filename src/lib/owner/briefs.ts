import { loadControls } from "@/lib/hq/controls";
import { operatingMode } from "@/lib/runtime/operating-mode";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { hasMoney, moneyWords } from "@/lib/format/money";
import { whatsappOwnerConfig, whatsappOwnerSender } from "@/lib/channels/whatsapp";
import { linkActive, listOwnerIdentities, maskedIdentity, type OwnerIdentity } from "@/lib/owner-channel/identity";
import { deliverOwner, type OwnerOutbound, type OwnerSender } from "@/lib/owner-channel/transport";
import { getOwnerWorkspace } from "./service";
import { approvalPrompt, focusFromNotification, operationSummary, ownerLink } from "./command-service";
import { loadSession, saveSession } from "./session";
import { L, type OwnerLang } from "./lang";
import crypto from "node:crypto";
import { listOperations, operationView } from "./operations";

/**
 * PROACTIVE OWNER BRIEFS — BARRY tells the owner what matters without being asked: a decision that
 * waits on them, an operation they started that finished, the day's short brief. Each one is a durable
 * record with a dedupe key (a decision is announced once per request revision per owner; a brief once
 * per day), so nothing is ever sent twice. WhatsApp only allows free-form messages within 24 hours of
 * the owner's last message; outside it a pre-approved template is required — none is configured, so
 * BARRY fails closed and records the blocker instead of sending.
 */

export type BriefRecord = { key: string; businessId: string; kind: "decision" | "operation_done" | "daily" | "alert" | "attention"; to: string; at: string; status: "sent" | "dry_run" | "failed" | "blocked"; reason?: string; text: string; /** attention: the exact items this message covered (each is announced once, ever). */ items?: string[] };

const WINDOW_MS = 24 * 3600_000;

async function briefs(businessId: string): Promise<BriefRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "owner_brief")).map((r) => r.data as unknown as BriefRecord);
}

export function ownerSenderOrUndefined(): OwnerSender | undefined {
  return whatsappOwnerConfig().configured ? whatsappOwnerSender() : undefined;
}

/** Deliver one brief to one owner, once per key, only where the channel allows it. */
async function deliverOnce(businessId: string, link: OwnerIdentity, key: string, kind: BriefRecord["kind"], message: OwnerOutbound, sender: OwnerSender | undefined, now: Date, items?: string[]): Promise<BriefRecord | undefined> {
  if ((await briefs(businessId)).some((b) => b.key === key)) return undefined;
  const base = { key, businessId, kind, to: maskedIdentity(link), at: now.toISOString(), text: message.text.slice(0, 600), ...(items ? { items } : {}) };
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
      // The owner just saw this exact request: a short "approve" / "yes" may refer to it (unless they're mid-way through something else).
      if (rec && (rec.status === "sent" || rec.status === "dry_run")) await focusFromNotification(graph.business.id, link.id, ws, item.id, prompt, now).catch(() => undefined);
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
export function dailyBriefText(ws: Awaited<ReturnType<typeof getOwnerWorkspace>>, failedToday: number, lang: OwnerLang = "en"): string | undefined {
  const T = (en: string, he: string) => L(lang, en, he);
  const mw = (x: Record<string, number>) => (lang === "he" ? heMoney(x) : moneyWords(x));
  const items: string[] = [];
  // What BARRY handled (from the day's conversations and outcomes — nothing when nothing happened).
  const handled = ws.today.handledAutonomously;
  if (handled) items.push(T(`BARRY handled ${handled} conversation${handled === 1 ? "" : "s"} on its own`, `BARRY טיפל לבד ב־${handled === 1 ? "שיחה אחת" : `${handled} שיחות`}`));
  if (ws.today.completedOutcomes) items.push(T(`${ws.today.completedOutcomes} completed (paid, booked, ordered or a case opened)`, `${ws.today.completedOutcomes} הושלמו (שולם, הוזמן או נפתחה פנייה)`));
  if (hasMoney(ws.revenue.direct)) items.push(T(`${mw(ws.revenue.direct)} made (verified)`, `${mw(ws.revenue.direct)} נגבו (מאומת)`));
  if (hasMoney(ws.revenue.recovered)) items.push(T(`${mw(ws.revenue.recovered)} recovered`, `${mw(ws.revenue.recovered)} הוחזרו`));
  const deciding = ws.conversations.filter((c) => c.status === "waiting_on_customer").length;
  if (deciding) items.push(T(`${deciding} customer${deciding === 1 ? "" : "s"} still deciding`, `${deciding === 1 ? "לקוח אחד עוד מתלבט" : `${deciding} לקוחות עוד מתלבטים`}`));
  const first = ws.interventions[0];
  if (first) items.push(ws.interventions.length === 1 ? T(`${first.customer} needs you: ${first.title}`, `${first.customer} מחכה לך: ${first.title}`) : T(`${ws.interventions.length} things need you (first: ${first.customer})`, `${ws.interventions.length} דברים מחכים לך (הראשון: ${first.customer})`));
  if (failedToday) items.push(T(`${failedToday} thing${failedToday === 1 ? "" : "s"} didn't go through`, `${failedToday === 1 ? "דבר אחד לא עבר" : `${failedToday} דברים לא עברו`}`));
  if (hasMoney(ws.opportunities.summary.atRisk)) items.push(T(`${mw(ws.opportunities.summary.atRisk)} at risk`, `${mw(ws.opportunities.summary.atRisk)} בסיכון`));
  if (!items.length) return undefined;
  return `${T(`${items.length} thing${items.length === 1 ? "" : "s"} from today:`, `${items.length === 1 ? "דבר אחד" : `${items.length} דברים`} מהיום:`)}\n${items.map((i) => `• ${i}`).join("\n")}`;
}
const heMoney = (x: Record<string, number>) => Object.entries(x).filter(([, v]) => v).map(([c, v]) => new Intl.NumberFormat("he-IL", { style: "currency", currency: c }).format(v)).join(" + ");

export async function sendDailyBrief(graph: BusinessGraph, opts: { sender?: OwnerSender; now?: Date } = {}): Promise<BriefRecord[]> {
  const now = opts.now ?? new Date();
  const to = await recipients(graph.business.id);
  if (!to.length) return [];
  const ws = await getOwnerWorkspace(graph, { now });
  const failed = ws.outcomes.filter((o) => o.kind === "failed").length;
  if (!dailyBriefText(ws, failed)) return [];
  // The business's own calendar day (dedupe key): one brief per local day.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: graph.business.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const link = ownerLink("/owner?tab=today", "whatsapp");
  const out: BriefRecord[] = [];
  for (const l of to) {
    const lang = await ownerLang(graph.business.id, l.id, now);
    const text = dailyBriefText(ws, failed, lang)!;
    const rec = await deliverOnce(graph.business.id, l, `daily:${day}:${l.id}`, "daily", { text, ...(link ? { links: [{ label: L(lang, "Today", "היום"), href: link }] } : {}) }, opts.sender ?? ownerSenderOrUndefined(), now);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * A one-off alert to the owner line (e.g. a customer sent something BARRY can't open), once per `key`.
 * Only for a business in SUPERVISED or LIVE mode — a test / practice business never messages a real owner.
 */
export async function notifyOwnerAlert(graph: BusinessGraph, key: string, text: string, opts: { sender?: OwnerSender; now?: Date; conversationId?: string } = {}): Promise<BriefRecord[]> {
  const mode = operatingMode(await loadControls(graph.business.id));
  if (mode !== "supervised" && mode !== "live") return [];
  const now = opts.now ?? new Date();
  const to = await recipients(graph.business.id);
  const link = opts.conversationId ? ownerLink(`/owner?tab=customers&conversation=${encodeURIComponent(opts.conversationId)}`, "whatsapp") : undefined;
  const out: BriefRecord[] = [];
  for (const l of to) {
    const rec = await deliverOnce(graph.business.id, l, `alert:${key}:${l.id}`, "alert", { text, ...(link ? { links: [{ label: "Conversation", href: link }] } : {}) }, opts.sender ?? ownerSenderOrUndefined(), now);
    if (rec) out.push(rec);
  }
  return out;
}

/** The language this owner last wrote to BARRY in (default English). */
async function ownerLang(businessId: string, identityId: string, now: Date): Promise<OwnerLang> {
  return (await loadSession(businessId, identityId, now).catch(() => undefined))?.lang ?? "en";
}

export type AttentionItem = { key: string; category: "customer_needs_human" | "important_failure" | "money_issue"; customer: string; conversationId: string; en: string; he: string };

/** What the owner should hear about now (V1): a customer needs a person, something important broke, a payment failed. Records only. */
export function attentionItems(ws: Awaited<ReturnType<typeof getOwnerWorkspace>>): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const i of ws.interventions) {
    const about = i.title.includes(i.customer) ? i.title : `${i.customer}: ${i.title}`;
    if (i.kind === "handoff") out.push({ key: i.id, category: "customer_needs_human", customer: i.customer, conversationId: i.conversationId, en: `${i.customer} needs a person — ${i.title.includes(i.customer) ? i.why : i.title}`, he: `${i.customer} צריך/ה אדם — ${i.title.includes(i.customer) ? i.why : i.title}` });
    else if (i.kind === "failed_action" || i.kind === "delivery_failed" || i.kind === "blocked_write" || i.kind === "not_understood") out.push({ key: i.id, category: "important_failure", customer: i.customer, conversationId: i.conversationId, en: about, he: about });
  }
  for (const o of ws.opportunities.items) {
    if (o.kind !== "payment_failed" || o.simulated) continue;
    const amount = o.amount !== undefined && o.currency ? ` (${moneyWords({ [o.currency]: o.amount })})` : "";
    out.push({ key: `money:${o.id}`, category: "money_issue", customer: o.customer, conversationId: o.conversationId, en: `${o.customer}'s payment failed${amount}`, he: `התשלום של ${o.customer} נכשל${amount}` });
  }
  return out;
}

/**
 * Proactive owner notifications (V1: a customer needs a person, an important failure, a money issue).
 * SUPERVISED / LIVE only. Every item is announced at most once, ever (sent, test-mode or blocked — a blocked
 * item is recorded truthfully and stays visible in "what needs me", never re-sent later as a duplicate), and
 * the items new in one run are coalesced into ONE message per owner.
 */
export async function notifyOwnerAttention(graph: BusinessGraph, opts: { sender?: OwnerSender; now?: Date } = {}): Promise<BriefRecord[]> {
  const mode = operatingMode(await loadControls(graph.business.id));
  if (mode !== "supervised" && mode !== "live") return [];
  const now = opts.now ?? new Date();
  const to = await recipients(graph.business.id);
  if (!to.length) return [];
  const ws = await getOwnerWorkspace(graph, { now });
  const items = attentionItems(ws);
  if (!items.length) return [];
  const existing = await briefs(graph.business.id);
  const out: BriefRecord[] = [];
  for (const l of to) {
    const masked = maskedIdentity(l);
    const told = new Set(existing.filter((b) => b.kind === "attention" && b.to === masked).flatMap((b) => b.items ?? []));
    const fresh = items.filter((i) => !told.has(i.key));
    if (!fresh.length) continue;
    const lang = await ownerLang(graph.business.id, l.id, now);
    const lines = fresh.slice(0, 5).map((i) => `• ${lang === "he" ? i.he : i.en}`);
    const more = fresh.length > 5 ? L(lang, `\n…and ${fresh.length - 5} more.`, `\n…ועוד ${fresh.length - 5}.`) : "";
    const head = fresh.length === 1 ? L(lang, "Heads up:", "לתשומת לבך:") : L(lang, `${fresh.length} things need your attention:`, `${fresh.length} דברים צריכים את תשומת הלב שלך:`);
    const tail = fresh.some((i) => i.category === "customer_needs_human") ? L(lang, "\n\nSay “I'll take it” to take the conversation, or “what needs me?” for everything.", "\n\nכתוב ״אני לוקח את השיחה״ כדי לקחת אותה, או ״מה צריך אותי?״ לכל השאר.") : "";
    const one = fresh.length === 1 ? fresh[0] : undefined;
    const link = ownerLink(one ? `/owner?tab=customers&conversation=${encodeURIComponent(one.conversationId)}` : "/owner?tab=work", "whatsapp");
    const keys = fresh.map((i) => i.key);
    const key = `attention:${crypto.createHash("sha256").update(keys.join("|")).digest("hex").slice(0, 16)}:${l.id}`;
    const rec = await deliverOnce(graph.business.id, l, key, "attention", { text: `${head}\n${lines.join("\n")}${more}${tail}`, ...(link ? { links: [{ label: L(lang, one ? "Conversation" : "Work", one ? "שיחה" : "עבודה"), href: link }] } : {}) }, opts.sender ?? ownerSenderOrUndefined(), now, keys);
    if (rec) out.push(rec);
    // A single customer who needs a person becomes the owner's context ("I'll take it" → that conversation).
    if (rec && one?.category === "customer_needs_human" && (rec.status === "sent" || rec.status === "dry_run")) {
      const session = await loadSession(graph.business.id, l.id, now);
      if (!session.focus && !session.draft) await saveSession({ ...session, focus: { kind: "conversation", conversationId: one.conversationId, customer: one.customer } }, now);
    }
  }
  return out;
}

export async function listBriefs(businessId: string): Promise<BriefRecord[]> {
  return (await briefs(businessId)).sort((a, b) => b.at.localeCompare(a.at));
}
