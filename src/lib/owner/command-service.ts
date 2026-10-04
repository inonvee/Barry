import crypto from "node:crypto";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { HumanHoldsConversationError, resumeAfterApproval } from "@/lib/runtime";
import { humanHolds } from "@/lib/runtime/control";
import { OwnerModeError, ownerMode, ownerPause, ownerResume } from "./mode";
import { OwnerControlError, ownerReply, ownerReturnToBarry, ownerTakeOver } from "./human-control";
import { isContextRecordKey, loadSession, saveSession, type OwnerSession } from "./session";
import { draftCustomerReply, interpretWithModel } from "./command-llm";
import { readControl } from "@/lib/runtime/control";
import { listJobRuns } from "@/lib/background/runner";
import { moneyWords, hasMoney } from "@/lib/format/money";
import type { OwnerOutbound } from "@/lib/owner-channel/transport";
import { getOwnerWorkspace, type OwnerWorkspace } from "./service";
import { askOwnerBarry } from "./ask";
import { nowWorking } from "./control-room";
import { interpretCommand, type CommandIntent, type CommandSource, type MoneyFocus } from "./command";
import { STARTABLE, STATE_WORDS, operationTitle, type OwnerOperation, type OwnerOperationView } from "./operation-model";
import { ACTIVE, CONFIRM_ABOVE, listOperations, operationView, proposeOperation, runOperation, saveOperation, stopOperation } from "./operations";
import { proactiveWords } from "./control-room";
import { L, money as moneyIn, type OwnerLang } from "./lang";

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
  return (await getBackend().listOperatorRecords(businessId, "owner_command")).map((r) => r.data as unknown as OwnerCommandRecord).filter((c) => c && c.key && !isContextRecordKey(c.key)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
export async function approvalPrompt(ws: OwnerWorkspace, interventionId: string, to: string, source: CommandSource, now = new Date(), lang: OwnerLang = "en"): Promise<OwnerOutbound | undefined> {
  const T = (en: string, he: string) => L(lang, en, he);
  const item = ws.interventions.find((i) => i.id === interventionId);
  const approval = item?.refs.approvalId ? ws.approvals.find((a) => a.id === item.refs.approvalId) : undefined;
  if (!item || !approval || !approval.actionable) return undefined;
  const p: OwnerPrompt = { key: `pr_${crypto.randomBytes(8).toString("hex")}`, businessId: ws.business.id, kind: "approval", approvalId: approval.id, revision: approval.revision, interventionId, customer: item.customer, to, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PROMPT_HOURS * 3600_000).toISOString() };
  await savePrompt(p);
  return {
    text: `${T("Needs your approval", "צריך את האישור שלך")}\n\n${item.customer}: ${item.title}${item.amount && !item.title.includes(item.amount) ? `\n${item.amount}` : ""}\n\n${T("Why you", "למה אתה")}: ${item.why}\n${T("If you approve", "אם תאשר")}: ${item.options.find((o) => o.action === "approve")?.consequence ?? item.then}`,
    actions: [{ id: `d:${p.key}:approve`, title: T("Approve", "לאשר") }, { id: `d:${p.key}:decline`, title: T("Decline", "לדחות") }],
    links: links(source, [{ label: T("Review", "לפרטים"), path: `/owner?tab=work&intervention=${encodeURIComponent(interventionId)}` }]),
  };
}

// ── Reads (from the owner read model only) ──────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function nameMatches(label: string, subject: string): boolean {
  const s = subject.toLowerCase();
  return label.toLowerCase().split(/[^\p{L}]+/u).includes(s);
}

async function answerQuery(intent: Extract<CommandIntent, { kind: "query" }>, ws: OwnerWorkspace, ops: OwnerOperationView[], ctx: { graph: BusinessGraph; source: CommandSource; actor: OwnerActor; text: string; now: Date; lang: OwnerLang; session: OwnerSession }): Promise<OwnerOutbound> {
  const lang = ctx.lang;
  const T = (en: string, he: string) => L(lang, en, he);
  const m = (x: Record<string, number>, empty = "none") => (lang === "he" ? moneyIn("he", x, empty === "none" ? "אין" : empty) : moneyWords(x, { empty }));
  switch (intent.topic) {
    case "initiatives": {
      // Only what scans persisted with evidence — never a new "insight" made up on demand.
      const money = intent.subject === "money";
      const list = ws.initiatives.filter((i) => !money || i.category === "money_leakage" || i.category === "abandoned_demand" || i.category === "cost_margin");
      if (!list.length) return { text: money ? T("I don't see money slipping away in your records right now — nothing at risk or left without a follow-up that I can prove.", "אני לא רואה כרגע כסף שבורח ברשומות שלך — אין משהו בסיכון או בלי מעקב שאני יכול להוכיח.") : T("Nothing stood out in my last look at your records. I'll tell you when something does — I won't make things up to fill the space.", "שום דבר לא בלט בבדיקה האחרונה של הרשומות. אגיד לך כשמשהו יבלוט — לא אמציא דברים כדי למלא את המקום."), links: links(ctx.source, [{ label: T("Today", "היום"), path: "/owner?tab=today" }]) };
      const { noticedCard } = await import("./os");
      const lines = list.slice(0, 3).map((i) => {
        const c = noticedCard(i, lang);
        return `• ${c.what}\n  ${c.observation}\n  → ${c.next}`;
      });
      return { text: `${T(`What I noticed${money ? " about money" : ""}:`, `מה ששמתי לב${money ? " לגבי כסף" : ""}:`)}\n${lines.join("\n")}${list.length > 3 ? T(`\n…and ${list.length - 3} more in Work.`, `\n…ועוד ${list.length - 3} ב״עבודה״.`) : ""}`, links: links(ctx.source, [{ label: T("See it in Work", "לראות ב״עבודה״"), path: "/owner?tab=work#noticed" }]) };
    }
    case "needs_you": {
      if (!ws.interventions.length) return { text: T("Nothing needs you right now. I'm handling everything inside your rules.", "שום דבר לא מחכה לך כרגע. אני מטפל בהכול בתוך הכללים שלך.") };
      const lines = ws.interventions.slice(0, 5).map((i, n) => `${n + 1}. ${i.customer} — ${i.title}`);
      const first = ws.interventions.find((i) => i.refs.approvalId && ws.approvals.some((a) => a.id === i.refs.approvalId && a.actionable));
      const prompt = first ? await approvalPrompt(ws, first.id, actorId(ctx.actor), ctx.source, ctx.now, lang) : undefined;
      // "Yes" / "approve" next refers to the request shown here; otherwise to the first customer waiting on the owner.
      if (prompt && first) focusApproval(ctx.session, ws, first.id, prompt);
      else if (ws.interventions[0]) ctx.session.focus = { kind: "conversation", conversationId: ws.interventions[0].conversationId, customer: ws.interventions[0].customer };
      const more = ws.interventions.length > 5 ? T(`\n…and ${ws.interventions.length - 5} more.`, `\n…ועוד ${ws.interventions.length - 5}.`) : "";
      // The first decidable request carries its why / consequence and Approve / Decline (no repeated title).
      const marker = T("\n\nWhy you:", "\n\nלמה אתה:");
      const detail = prompt ? `${marker}${prompt.text.split(marker)[1] ?? ""}` : "";
      const head = T(`${plural(ws.interventions.length, "thing")} need${ws.interventions.length === 1 ? "s" : ""} you:`, ws.interventions.length === 1 ? "דבר אחד מחכה לך:" : `${ws.interventions.length} דברים מחכים לך:`);
      return { text: `${head}\n${lines.join("\n")}${more}${detail}`, actions: prompt?.actions, links: [...(prompt?.links ?? []), ...links(ctx.source, [{ label: T("All decisions", "כל ההחלטות"), path: "/owner?tab=work" }])].slice(0, 2) };
    }
    case "working": {
      const lines = nowWorking(ws, lang).map((l) => `• ${l.text}`);
      const active = ops.filter((o) => (ACTIVE as readonly string[]).includes(o.derivedState));
      const owned = ws.conversations.filter((c) => c.status === "in_progress" || c.status === "waiting_on_customer").length;
      const withPeople = ws.conversations.filter((c) => c.attention.includes("handoff_open")).length;
      if (owned) lines.push(T(`• Handling ${plural(owned, "customer conversation")} myself`, `• מטפל בעצמי ב־${owned === 1 ? "שיחה אחת" : `${owned} שיחות`} עם לקוחות`));
      if (withPeople) lines.push(T(`• ${plural(withPeople, "conversation")} with you or your team — I stay quiet there`, `• ${withPeople === 1 ? "שיחה אחת" : `${withPeople} שיחות`} אצלך או אצל הצוות — שם אני שותק`));
      const scheduled = (await listJobRuns(ctx.graph.business.id).catch(() => [])).filter((j) => j.job === "followups").slice(0, 1);
      for (const j of scheduled) lines.push(T(`• Scheduled follow-ups last ran ${hoursAgo(j.finishedAt ?? j.claimedAt, ctx.now, lang)} ago${j.status === "failed" ? " — it failed and is visible in Work" : j.summary ? ` (sent ${j.summary.sent ?? 0}${j.summary.dryRun ? `, test runs ${j.summary.dryRun}` : ""})` : ""}${j.note ? ` — ${j.note}` : ""}`, `• מעקבים מתוזמנים רצו לאחרונה ${hoursAgo(j.finishedAt ?? j.claimedAt, ctx.now, lang)}${j.status === "failed" ? " — נכשלו, מופיע ב״עבודה״" : j.summary ? ` (נשלחו ${j.summary.sent ?? 0}${j.summary.dryRun ? `, הרצות בדיקה ${j.summary.dryRun}` : ""})` : ""}`));
      for (const o of active) lines.unshift(lang === "he" ? `• ${proactiveWords(o.workflow, "he").title} (ביקשת${o.requestedBy.source === "whatsapp" ? " בוואטסאפ" : ""}) — ${STATE_WORDS_HE[o.derivedState]}: ${progressWords(o, lang)}` : `• ${o.title} (you asked${o.requestedBy.source === "whatsapp" ? " on WhatsApp" : ""}) — ${STATE_WORDS[o.derivedState].toLowerCase()}: ${progressWords(o)}`);
      return { text: lines.length ? `${T("Right now:", "כרגע:")}\n${lines.join("\n")}` : T("Nothing open right now — I'm watching for the next customer.", "אין כרגע משהו פתוח — אני מחכה ללקוח הבא."), links: links(ctx.source, [{ label: T("Work", "עבודה"), path: "/owner?tab=work" }]) };
    }
    case "money": {
      if (intent.money) return moneyDetail(intent.money, ws, ctx.source, lang);
      const r = ws.revenue;
      const s = ws.opportunities.summary;
      const lines = [T(`Made (verified by your payment provider): ${m(r.direct, "nothing yet")}${r.directPayments ? ` from ${plural(r.directPayments, "payment")}` : ""}.`, `נגבה (אומת מול ספק התשלומים): ${m(r.direct, "עוד כלום")}${r.directPayments ? ` מ־${r.directPayments === 1 ? "תשלום אחד" : `${r.directPayments} תשלומים`}` : ""}.`)];
      if (hasMoney(r.recovered)) lines.push(T(`Recovered (inside made): ${m(r.recovered)}.`, `הוחזר (כלול בנגבה): ${m(r.recovered)}.`));
      lines.push(T(`Pending — not revenue yet: ${m(r.potential)}.`, `ממתין — עוד לא הכנסה: ${m(r.potential)}.`));
      if (hasMoney(s.atRisk)) lines.push(T(`At risk: ${m(s.atRisk)}.`, `בסיכון: ${m(s.atRisk)}.`));
      if (hasMoney(r.simulatedPaid) || r.potentialSimulatedItems) lines.push(T(`Test money (simulator, never counted): ${m(r.simulatedPaid, "none paid")}${r.potentialSimulatedItems ? `, ${m(r.potentialSimulated)} pending` : ""}.`, `כסף של בדיקות (סימולטור, לא נספר): ${m(r.simulatedPaid, "לא שולם")}${r.potentialSimulatedItems ? `, ${m(r.potentialSimulated)} ממתין` : ""}.`));
      const when = ws.window.label === "today" || ws.window.label === "היום" ? T("Today", "היום") : ws.window.label;
      return { text: `${when}:\n${lines.join("\n")}`, links: links(ctx.source, [{ label: T("Money", "כסף"), path: "/owner?tab=money" }]) };
    }
    case "waiting_customers": {
      const onYou = ws.conversations.filter((c) => c.status === "needs_you");
      const onThem = ws.conversations.filter((c) => c.status === "waiting_on_customer");
      const live = ws.conversations.filter((c) => c.status === "in_progress");
      const name = (c: { customer: string; lastActivityAt: string }) => `${c.customer} (${hoursAgo(c.lastActivityAt, ctx.now, lang)})`;
      const lines = [onYou.length ? `${T("Waiting on you", "מחכים לך")}: ${onYou.slice(0, 5).map(name).join(", ")}` : T("Nobody is waiting on you.", "אף אחד לא מחכה לך."), live.length ? `${T("Talking with BARRY now", "מדברים עם BARRY עכשיו")}: ${live.slice(0, 5).map(name).join(", ")}` : "", onThem.length ? `${T("BARRY is waiting to hear back from", "BARRY מחכה לתשובה מ")}: ${onThem.slice(0, 5).map(name).join(", ")}` : ""].filter(Boolean);
      return { text: lines.join("\n"), links: links(ctx.source, [{ label: T("Customers", "לקוחות"), path: "/owner?tab=customers" }]) };
    }
    case "waiting":
      return waitingOn(ws, ops, ctx.source, ctx.now, lang);
    case "customer": {
      const focused = !intent.subject ? focusConversationId(ctx.session) : undefined;
      if (!intent.subject && !focused) return { text: T("Which customer? Tell me their name.", "על איזה לקוח? תגיד לי את השם.") };
      const subject = intent.subject ?? "";
      const found = focused ? ws.conversations.filter((c) => c.id === focused) : ws.conversations.filter((c) => nameMatches(c.customer, subject));
      if (found.length === 0) return { text: T(`I don't see a customer called ${subject} in your conversations.`, `אני לא רואה לקוח בשם ${subject} בשיחות שלך.`) };
      if (found.length > 1) return { text: T(`${plural(found.length, "customer")} match “${subject}”: ${found.slice(0, 5).map((c) => c.customer).join(", ")}. Which one?`, `${found.length} לקוחות מתאימים ל“${subject}”: ${found.slice(0, 5).map((c) => c.customer).join(", ")}. איזה מהם?`) };
      const c = found[0];
      ctx.session.focus = { kind: "conversation", conversationId: c.id, customer: c.customer };
      ctx.session.draft = undefined;
      const money = ws.revenueEvidence.filter((e) => e.conversationId === c.id);
      const paid = money.filter((e) => e.category === "collected");
      const pending = money.filter((e) => e.category === "open_opportunity");
      const test = money.filter((e) => e.category === "simulated");
      const payment = paid.length ? T(`Paid: ${m(sum(paid))}, verified by your payment provider.`, `שילם: ${m(sum(paid))}, אומת מול ספק התשלומים.`) : pending.length ? T(`Not paid yet — ${m(sum(pending))} link still open.`, `עוד לא שילם — קישור של ${m(sum(pending))} עדיין פתוח.`) : test.length ? T(`Only test money (simulator): ${m(sum(test))} — not counted.`, `רק כסף של בדיקות (סימולטור): ${m(sum(test))} — לא נספר.`) : T("No payment from them yet.", "עוד לא התקבל תשלום.");
      const needs = ws.interventions.filter((i) => i.conversationId === c.id).map((i) => `${T("Needs you", "מחכה לך")}: ${i.title}`);
      const state = await getConversationStore().get(c.id);
      const story = state ? (await import("./story")).conversationStory(state, lang) : undefined;
      const lastSaid = state ? [...state.messages].reverse().find((x) => x.role === "customer") : undefined;
      const holder = state ? readControl(state).holder : "barry";
      const lines = [`${c.customer} — ${(lang === "he" ? STATUS_WORDS_HE : STATUS_WORDS)[c.status]}${holder === "human" ? T(" (you hold this conversation)", " (השיחה אצלך)") : ""}`, ...(story?.standing.slice(0, 2) ?? []), ...(lastSaid ? [T(`Last from them: “${lastSaid.content.slice(0, 160)}”`, `ההודעה האחרונה שלהם: “${lastSaid.content.slice(0, 160)}”`)] : []), payment, ...needs];
      return { text: lines.join("\n"), links: links(ctx.source, [{ label: T("Open conversation", "לפתוח את השיחה"), path: `/owner?tab=customers&conversation=${encodeURIComponent(c.id)}` }]) };
    }
    case "operation": {
      const op = ops.find((o) => !intent.workflow || o.workflow === intent.workflow);
      if (!op) return { text: intent.workflow ? T(`You haven't started ${operationTitle(intent.workflow).command.toLowerCase()} yet. Tell me to, and I'll show you exactly who it would reach first.`, `עוד לא התחלת ${proactiveWords(intent.workflow, "he").command}. תגיד לי, ואראה לך קודם בדיוק למי זה יגיע.`) : T("You haven't started anything from a command yet.", "עוד לא התחלת שום דבר מפקודה.") };
      return { text: operationSummary(op, lang), links: links(ctx.source, [{ label: T("See it live", "לראות בזמן אמת"), path: `/owner?tab=work&operation=${encodeURIComponent(op.id)}` }]) };
    }
    case "capabilities": {
      if (lang === "he") {
        const os = await (await import("./os-service")).getOwnerOs(ctx.graph, "he");
        const real = os.systems.filter((x) => x.used && (x.label === "REAL" || x.label === "SUPERVISED")).flatMap((x) => x.does);
        const sim = os.systems.filter((x) => x.used && x.label === "SIMULATED").map((x) => x.name);
        return { text: `${real.length ? `מה אני עושה באמת עכשיו:\n${real.slice(0, 6).map((c) => `• ${c}`).join("\n")}` : "עוד שום דבר לא רץ באמת."}${sim.length ? `\nעל סימולטור בלבד (שום דבר אמיתי לא קורה): ${sim.join(", ")}` : ""}`, links: links(ctx.source, [{ label: "הגדרת BARRY", path: "/owner/setup" }]) };
      }
      const now = ws.capabilities.now.slice(0, 6);
      return { text: now.length ? `What I do for real now:\n${now.map((c) => `• ${c}`).join("\n")}${ws.capabilities.nowSimulated.length ? `\nOn a simulator only: ${ws.capabilities.nowSimulated.slice(0, 3).join(", ")}` : ""}` : "Nothing runs for real yet — BARRY setup shows what unlocks it.", links: links(ctx.source, [{ label: "BARRY setup", path: "/owner/setup" }]) };
    }
    default: {
      const a = await askOwnerBarry(ctx.graph, ctx.text, { lang });
      if (ctx.source !== "web" && a.source === "briefing") return { text: HELP };
      return { text: ctx.source === "web" ? a.answer : a.answer.slice(0, 1500), links: a.links.interventions[0] ? links(ctx.source, [{ label: T(`Decide: ${a.links.interventions[0].customer}`, `להחליט: ${a.links.interventions[0].customer}`), path: `/owner?tab=work&intervention=${encodeURIComponent(a.links.interventions[0].id)}` }]) : undefined };
    }
  }
}

// ── The owner's context (what "yes" / "send it" / "give it back" refer to) ───────────────────────

/** Point the owner's context at the exact request just shown (its stored, single-use prompt). */
function focusApproval(session: OwnerSession, ws: OwnerWorkspace, interventionId: string, prompt: OwnerOutbound): void {
  const item = ws.interventions.find((i) => i.id === interventionId);
  const promptKey = prompt.actions?.[0]?.id.match(/^d:(pr_[a-f0-9]{16}):/)?.[1];
  if (!item?.refs.approvalId || !promptKey) return;
  session.focus = { kind: "approval", approvalId: item.refs.approvalId, promptKey, customer: item.customer, conversationId: item.conversationId };
  session.draft = undefined;
}
const focusConversationId = (s: OwnerSession) => (s.focus?.kind === "conversation" || s.focus?.kind === "approval" ? s.focus.conversationId : undefined);

/**
 * A notification just showed this owner a request: a short "approve" / "yes" may now refer to it — but only
 * when the owner isn't in the middle of something else (a reply draft, another request, a proposed operation).
 */
export async function focusFromNotification(businessId: string, actor: string, ws: OwnerWorkspace, interventionId: string, prompt: OwnerOutbound, now = new Date()): Promise<void> {
  const session = await loadSession(businessId, actor, now);
  if (session.focus || session.draft) return;
  focusApproval(session, ws, interventionId, prompt);
  if (session.focus) await saveSession(session, now);
}

type ConvoRow = OwnerWorkspace["conversations"][number];
/**
 * Which conversation the owner means: a name grounded against records, else the one in context, else the
 * only candidate. Never a guess — zero or several matches come back as a question.
 */
function resolveConversation(subject: string | undefined, session: OwnerSession, ws: OwnerWorkspace, candidates: ConvoRow[], lang: OwnerLang, none: string): { c: { id: string; customer: string } } | { ask: string } {
  const T = (en: string, he: string) => L(lang, en, he);
  if (subject) {
    const found = ws.conversations.filter((c) => nameMatches(c.customer, subject));
    if (found.length === 1) return { c: found[0] };
    if (!found.length) return { ask: T(`I don't see a customer called ${subject} in your conversations.`, `אני לא רואה לקוח בשם ${subject} בשיחות שלך.`) };
    return { ask: T(`${plural(found.length, "customer")} match “${subject}”: ${found.slice(0, 5).map((c) => c.customer).join(", ")}. Which one?`, `${found.length} לקוחות מתאימים ל“${subject}”: ${found.slice(0, 5).map((c) => c.customer).join(", ")}. איזה מהם?`) };
  }
  const focused = focusConversationId(session);
  if (focused) return { c: { id: focused, customer: session.focus && "customer" in session.focus ? session.focus.customer : ws.conversations.find((c) => c.id === focused)?.customer ?? "the customer" } };
  if (candidates.length === 1) return { c: candidates[0] };
  if (!candidates.length) return { ask: none };
  return { ask: T(`Which customer? ${candidates.slice(0, 5).map((c) => c.customer).join(", ")}`, `איזה לקוח? ${candidates.slice(0, 5).map((c) => c.customer).join(", ")}`) };
}

// ── Money detail and "what are we waiting on" (records only) ────────────────────────────────────

function moneyDetail(focus: MoneyFocus, ws: OwnerWorkspace, source: CommandSource, lang: OwnerLang): OwnerOutbound {
  const T = (en: string, he: string) => L(lang, en, he);
  const m = (x: Record<string, number>) => (lang === "he" ? moneyIn("he", x, "אין") : moneyWords(x, { empty: "none" }));
  const amount = (o: { amount?: number; currency?: string }) => (o.amount !== undefined && o.currency ? m({ [o.currency]: o.amount }) : T("amount not recorded", "סכום לא רשום"));
  const real = ws.opportunities.items.filter((o) => !o.simulated);
  const test = ws.opportunities.items.filter((o) => o.simulated);
  const line = (o: (typeof real)[number]) => `• ${o.customer} — ${amount(o)} — ${o.next.action}`;
  const link = links(source, [{ label: T("Money", "כסף"), path: "/owner?tab=money" }]);
  const testNote = (rows: unknown[]) => (rows.length ? T(`\n(${plural(rows.length, "test item")} on a simulator — never counted.)`, `\n(${rows.length} פריטי בדיקה בסימולטור — לא נספרים.)`) : "");
  if (focus === "stuck") {
    const s = ws.opportunities.summary;
    if (!real.length) return { text: `${T("No money is stuck right now — nothing unpaid, failed or waiting on a decision in your records.", "אין כרגע כסף תקוע — אין ברשומות שום דבר שלא שולם, נכשל או מחכה להחלטה.")}${testNote(test)}`, links: link };
    const head = [hasMoney(s.stuckWithYou) ? T(`Waiting on you: ${m(s.stuckWithYou)}`, `מחכה לך: ${m(s.stuckWithYou)}`) : "", hasMoney(s.waitingOnCustomer) ? T(`Waiting on customers: ${m(s.waitingOnCustomer)}`, `מחכה ללקוחות: ${m(s.waitingOnCustomer)}`) : "", hasMoney(s.atRisk) ? T(`At risk: ${m(s.atRisk)}`, `בסיכון: ${m(s.atRisk)}`) : ""].filter(Boolean);
    return { text: `${T("Money not in yet (not revenue):", "כסף שעוד לא נכנס (לא הכנסה):")}\n${head.join("\n")}\n${real.slice(0, 5).map(line).join("\n")}${real.length > 5 ? T(`\n…and ${real.length - 5} more.`, `\n…ועוד ${real.length - 5}.`) : ""}${testNote(test)}`, links: link };
  }
  if (focus === "awaiting") {
    const awaiting = real.filter((o) => o.kind === "unpaid_link" || o.kind === "unpaid_deposit");
    if (!awaiting.length) return { text: `${T("Nothing is awaiting payment — no open payment links in your records.", "שום דבר לא ממתין לתשלום — אין ברשומות קישורי תשלום פתוחים.")}${testNote(test.filter((o) => o.kind === "unpaid_link" || o.kind === "unpaid_deposit"))}`, links: link };
    return { text: `${T(`Awaiting payment (${awaiting.length}):`, `ממתינים לתשלום (${awaiting.length}):`)}\n${awaiting.slice(0, 6).map((o) => `• ${o.customer} — ${amount(o)} — ${T(`open ${o.ageHours < 1 ? "<1h" : `${Math.floor(o.ageHours)}h`}`, `פתוח ${o.ageHours < 1 ? "פחות משעה" : `${Math.floor(o.ageHours)} שע׳`}`)}`).join("\n")}${testNote(test.filter((o) => o.kind === "unpaid_link" || o.kind === "unpaid_deposit"))}`, links: link };
  }
  const failedPayments = real.filter((o) => o.kind === "payment_failed");
  const failedActions = ws.outcomes.filter((o) => o.kind === "failed" && !o.simulated);
  if (!failedPayments.length && !failedActions.length) return { text: T("Nothing failed — no failed payments or actions in your records for this period.", "שום דבר לא נכשל — אין ברשומות תשלומים או פעולות שנכשלו בתקופה הזאת."), links: link };
  const name = (id: string) => ws.conversations.find((c) => c.id === id)?.customer ?? T("a customer", "לקוח");
  const lines = [...failedPayments.map((o) => `• ${o.customer} — ${T("payment failed", "התשלום נכשל")} — ${amount(o)}`), ...failedActions.slice(0, 5).map((o) => `• ${name(o.conversationId)} — ${o.label}`)];
  return { text: `${T("What failed:", "מה נכשל:")}\n${lines.slice(0, 6).join("\n")}`, links: links(source, [{ label: T("Work", "עבודה"), path: "/owner?tab=work" }]) };
}

function waitingOn(ws: OwnerWorkspace, ops: OwnerOperationView[], source: CommandSource, now: Date, lang: OwnerLang): OwnerOutbound {
  const T = (en: string, he: string) => L(lang, en, he);
  const names = (rows: { customer: string }[]) => rows.slice(0, 4).map((r) => r.customer).join(", ") + (rows.length > 4 ? T(` +${rows.length - 4} more`, ` ועוד ${rows.length - 4}`) : "");
  const approvals = ws.interventions.filter((i) => i.refs.approvalId && ws.approvals.some((a) => a.id === i.refs.approvalId && a.actionable));
  const withYou = ws.conversations.filter((c) => c.attention.includes("handoff_open"));
  const onCustomers = ws.conversations.filter((c) => c.status === "waiting_on_customer");
  const payments = ws.opportunities.items.filter((o) => !o.simulated && (o.kind === "unpaid_link" || o.kind === "unpaid_deposit"));
  const unresolved = ws.interventions.filter((i) => !i.refs.approvalId);
  const opsWaiting = ops.filter((o) => o.derivedState === "waiting_on_customers");
  const lines = [
    approvals.length ? T(`Your approval: ${names(approvals)}`, `האישור שלך: ${names(approvals)}`) : "",
    withYou.length ? T(`Conversations you hold (BARRY is quiet): ${names(withYou)}`, `שיחות אצלך (BARRY שותק): ${names(withYou)}`) : "",
    onCustomers.length ? T(`Customer replies: ${onCustomers.slice(0, 4).map((c) => `${c.customer} (${hoursAgo(c.lastActivityAt, now, lang)})`).join(", ")}`, `תשובה מלקוחות: ${onCustomers.slice(0, 4).map((c) => `${c.customer} (${hoursAgo(c.lastActivityAt, now, lang)})`).join(", ")}`) : "",
    payments.length ? T(`Payments: ${names(payments)}`, `תשלומים: ${names(payments)}`) : "",
    ...opsWaiting.map((o) => T(`${o.title}: waiting on ${o.progress.stillTalking || o.progress.contacted} customers`, `${proactiveWords(o.workflow, "he").title}: מחכה ל־${o.progress.stillTalking || o.progress.contacted} לקוחות`)),
    unresolved.length ? T(`Open items: ${unresolved.slice(0, 3).map((i) => `${i.customer} — ${i.title}`).join("; ")}`, `פריטים פתוחים: ${unresolved.slice(0, 3).map((i) => `${i.customer} — ${i.title}`).join("; ")}`) : "",
  ].filter(Boolean);
  if (!lines.length) return { text: T("We're not waiting on anything right now — no open approvals, replies or payments.", "אנחנו לא מחכים כרגע לשום דבר — אין אישורים, תשובות או תשלומים פתוחים.") };
  return { text: `${T("We're waiting on:", "אנחנו מחכים ל:")}\n${lines.map((l) => `• ${l}`).join("\n")}`, links: links(source, [{ label: T("Work", "עבודה"), path: "/owner?tab=work" }]) };
}

const HELP = "You can ask me things like:\n• Who needs me?\n• What are you working on?\n• How much did we make today?\n• What happened with Maya?\nOr tell me: “Recover today's abandoned carts”, “Stop the recovery”, “Don't offer more than 5% today”.";
const STATUS_WORDS: Record<OwnerWorkspace["conversations"][number]["status"], string> = { needs_you: "waiting on you", waiting_on_customer: "BARRY is waiting to hear back", completed: "done", lost: "lost", in_progress: "talking with BARRY now" };
const STATUS_WORDS_HE: Record<OwnerWorkspace["conversations"][number]["status"], string> = { needs_you: "מחכה לך", waiting_on_customer: "BARRY מחכה לתשובה", completed: "הסתיים", lost: "לא נסגר", in_progress: "מדבר עם BARRY עכשיו" };
const STATE_WORDS_HE: Record<OwnerOperationView["derivedState"], string> = { proposed: "מחכה לאישור שלך", running: "רץ", waiting_on_customers: "מחכה ללקוחות", completed: "הסתיים", stopped: "נעצר על ידך", blocked: "חסום", failed: "נכשל" };
const sum = (rows: { amount: number; currency: string }[]) => rows.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.currency]: Math.round(((acc[e.currency] ?? 0) + e.amount) * 100) / 100 }), {});
function hoursAgo(iso: string, now: Date, lang: OwnerLang = "en"): string {
  const h = Math.floor((now.getTime() - Date.parse(iso)) / 3600_000);
  if (lang === "he") return h < 1 ? "עכשיו" : h < 24 ? `לפני ${h} שע׳` : `לפני ${Math.floor(h / 24)} ימים`;
  return h < 1 ? "just now" : h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function progressWords(o: OwnerOperationView, lang: OwnerLang = "en"): string {
  const p = o.progress;
  const mw = (x: Record<string, number>) => (lang === "he" ? moneyIn("he", x) : moneyWords(x, { empty: "none" }));
  if (lang === "he") {
    const parts = [`נשלחו ${p.contacted}`, `ענו ${p.replied}`, `קנו ${p.purchased}`];
    if (hasMoney(p.recovered)) parts.push(`הוחזרו ${mw(p.recovered)}`);
    if (p.stillTalking) parts.push(`עדיין מדברים ${p.stillTalking}`);
    if (p.failed) parts.push(`נכשלו ${p.failed}`);
    if (p.dryRun) parts.push(`מצב בדיקה: ${p.dryRun} נרשמו ולא נשלחו`);
    return parts.join(" · ");
  }
  const parts = [`contacted ${p.contacted}`, `replied ${p.replied}`, `purchased ${p.purchased}`];
  if (hasMoney(p.recovered)) parts.push(`recovered ${mw(p.recovered)}`);
  if (p.stillTalking) parts.push(`still talking ${p.stillTalking}`);
  if (p.failed) parts.push(`failed ${p.failed}`);
  if (p.dryRun) parts.push(`test mode: ${p.dryRun} recorded, not sent`);
  return parts.join(" · ");
}

export function operationSummary(o: OwnerOperationView, lang: OwnerLang = "en"): string {
  const p = o.progress;
  if (lang === "he") {
    const head = `${proactiveWords(o.workflow, "he").title} — ${STATE_WORDS_HE[o.derivedState]}`;
    if (o.derivedState === "blocked") return `${head}\nלא ניתן להתחיל — הפרטים ב״עבודה״.`;
    const lines = [head, `נשלחו: ${p.contacted}`, `ענו: ${p.replied}`, `קנו: ${p.purchased}`];
    if (hasMoney(p.recovered)) lines.push(`הוחזרו: ${moneyIn("he", p.recovered)} (מאומת)`);
    if (p.stillTalking) lines.push(`עדיין מדברים: ${p.stillTalking}`);
    if (p.failed) lines.push(`נכשלו: ${p.failed}`);
    if (p.dryRun) lines.push(`מצב בדיקה: ${p.dryRun} נרשמו ולא נשלחו ללקוח.`);
    if (o.stoppedAt) lines.push("נעצר על ידך — הודעות שכבר נשלחו נשארות.");
    if (p.test) lines.push(`${p.test === 1 ? "לקוח אחד" : `${p.test} לקוחות`} במצב בדיקה (סימולטור) — אף פעם לא נספר ככסף.`);
    return lines.join("\n");
  }
  const head = `${o.title} — ${STATE_WORDS[o.derivedState]}`;
  if (o.derivedState === "blocked") return `${head}\n${o.blockedReason ?? ""}`;
  const lines = [head, `Contacted: ${p.contacted}`, `Replied: ${p.replied}`, `Purchased: ${p.purchased}`];
  if (hasMoney(p.recovered)) lines.push(`Recovered: ${moneyWords(p.recovered, { empty: "none" })} (verified)`);
  if (p.stillTalking) lines.push(`Still talking: ${p.stillTalking}`);
  if (p.failed) lines.push(`Failed: ${p.failed}`);
  if (p.dryRun) lines.push(`Test mode: ${p.dryRun} recorded, not sent to the customer.`);
  if (o.stoppedAt) lines.push(`Stopped by you — messages already sent stay sent.`);
  if (p.test) lines.push(`${plural(p.test, "customer")} in test mode (simulator) — never counted as money.`);
  return lines.join("\n");
}

/** "Found 47 … 35 eligible · 8 already purchased · 4 can't be contacted (reasons)". */
export function groundingSummary(op: OwnerOperation, lang: OwnerLang = "en"): string {
  const eligible = op.targets.filter((t) => t.eligibility === "eligible");
  const done = op.targets.filter((t) => t.alreadyDone);
  const other = op.targets.filter((t) => t.eligibility === "excluded" && !t.alreadyDone);
  const early = eligible.filter((t) => t.reason).length;
  if (lang === "he") {
    const lines = [`מצאתי ${op.targets.length} ${op.scope.kind === "today" ? "מהיום" : "שעדיין פתוחים"}.`, `${eligible.length} מתאימים למעקב.`];
    if (done.length) lines.push(`${done.length} כבר טופלו.`);
    if (other.length) lines.push(`${other.length} אי אפשר לפנות אליהם כרגע.`);
    if (early) lines.push(`${early} עוד לא הגיע זמנם לפי הכלל שלך — נכללו כי ביקשת עכשיו.`);
    return lines.join("\n");
  }
  const reasons = new Map<string, number>();
  for (const t of other) reasons.set(t.reason ?? "excluded", (reasons.get(t.reason ?? "excluded") ?? 0) + 1);
  const noun = operationTitle(op.workflow).command.toLowerCase().replace(/^\w+ /, "");
  const lines = [`Found ${plural(op.targets.length, singular(noun), noun)} ${op.scope.kind === "today" ? "from today" : "still open"}.`, `${eligible.length} ${eligible.length === 1 ? "is" : "are"} eligible for a follow-up.`];
  if (done.length) lines.push(`${done.length} already done (${done[0].reason}).`);
  if (other.length) lines.push(`${other.length} can't be contacted now: ${[...reasons.entries()].map(([r, n]) => `${n} ${r}`).join("; ")}.`);
  if (early) lines.push(`${early} ${early === 1 ? "isn't" : "aren't"} due yet under your rule — included because you asked now.`);
  return lines.join("\n");
}
const singular = (noun: string) => noun.replace(/ies$/, "y").replace(/s$/, "");

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────────

export type ExecuteInput = { graph: BusinessGraph; source: CommandSource; actor: OwnerActor; key: string; text?: string; actionId?: string; now?: Date; trace?: TraceStep[]; /** The owner's chosen language for the reply's words (web only; the WhatsApp channel never sets it). Presentation only. */ lang?: OwnerLang };

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
    record.reply = { text: L(input.lang ?? "en", "Something went wrong on my side — nothing was changed. Try again in a moment.", "משהו השתבש אצלי — שום דבר לא השתנה. נסה שוב עוד רגע."), intent: record.intent?.kind ?? "query" };
    record.trace.push({ step: "execution", outcome: "failed", detail: err instanceof Error ? err.message.slice(0, 200) : "error", at: at() });
  }
  record.updatedAt = at();
  await saveCommand(record);
  return { record, reply: record.reply!, duplicate: false };
}

async function dispatch(input: ExecuteInput, record: OwnerCommandRecord, now: Date): Promise<OwnerReply> {
  const session = await loadSession(input.graph.business.id, actorId(input.actor), now);
  try {
    return await dispatchIn(input, record, now, session);
  } finally {
    await saveSession(session, now).catch(() => undefined);
  }
}

const HEBREW = /[\u0590-\u05FF]/;
/** What a language-model interpretation may become (never a decision, a confirmation, outreach or a rule). */
const MODEL_INTENTS = ["query", "mode_query", "mode_change", "approval_explain", "conversation_takeover", "conversation_giveback", "conversation_reply"] as const;

async function dispatchIn(input: ExecuteInput, record: OwnerCommandRecord, now: Date, session: OwnerSession): Promise<OwnerReply> {
  const { graph, source, actor } = input;
  // The owner's language: chosen on the web; on a message channel, the language they wrote in (else the last one).
  const lang: OwnerLang = input.lang ?? (input.text && HEBREW.test(input.text) ? "he" : input.text && /[a-z]{2}/i.test(input.text) ? "en" : session.lang ?? "en");
  session.lang = lang;
  const T = (en: string, he: string) => L(lang, en, he);
  const t = () => new Date().toISOString();
  const step = (s: TraceStep["step"], outcome: TraceStep["outcome"], detail: string) => record.trace.push({ step: s, outcome, detail, at: t() });

  // A tapped action resolves to an exact stored object; free text is interpreted semantically.
  const action = input.actionId ? parseAction(input.actionId) : undefined;
  if (input.actionId && !action) {
    step("interpretation", "blocked", "unrecognised action id");
    return { text: T("I couldn't match that button to anything I sent you — nothing was done.", "לא מצאתי למה הכפתור הזה שייך — לא נעשה כלום."), intent: "unsupported" };
  }
  let intent: CommandIntent = action ? (action.type === "decision" ? { kind: "approval_response", decision: action.decision } : action.type === "reply" ? (action.send ? { kind: "affirm" } : { kind: "negate" }) : action.type === "start" ? { kind: "operation_confirm" } : { kind: "operation_stop" }) : interpretCommand(input.text ?? "", source).intent;
  let byModel = false;
  // Only what the deterministic interpreter couldn't place goes to the model — into a closed set of intents that
  // can never decide, start outreach or change a rule. Execution below is the same deterministic path.
  if (!action && intent.kind === "query" && intent.topic === "general" && (input.text ?? "").trim().length > 2) {
    const m = await interpretWithModel(input.text ?? "");
    // The service enforces the closed set itself (whatever an adapter returns): a model never decides a request,
    // confirms anything, starts or stops outreach, or changes a rule — and a reply it read is always shown first.
    if (m && (MODEL_INTENTS as readonly string[]).includes(m.kind)) {
      intent = m.kind === "conversation_reply" ? { ...m, exact: false } : m;
      byModel = true;
    } else if (m) step("interpretation", "blocked", `language model proposed ${m.kind} — not allowed from a model; ignored`);
  }
  // A bare "yes" / "no" means something only against the owner's current, fresh context: the request just shown
  // (→ the exact approval path), or a proposed operation / a reply draft (handled below). Never a guess.
  if ((intent.kind === "affirm" || intent.kind === "negate") && !action && !session.draft && session.focus?.kind === "approval") {
    step("interpretation", "info", `short reply "${(input.text ?? "").slice(0, 20)}" → the request in context`);
    intent = { kind: "approval_response", decision: intent.kind === "affirm" ? "approve" : "decline" };
  }
  record.intent = intent;
  step("interpretation", "ok", `${intent.kind}${"topic" in intent ? `:${intent.topic}` : ""}${"workflow" in intent && intent.workflow ? `:${intent.workflow}` : ""}${action ? " (exact action)" : ""}${byModel ? " (language model, validated)" : ""}`);

  const ws = await getOwnerWorkspace(graph, { now, lang });
  step("state", ws.unavailable.length ? "info" : "ok", ws.unavailable.length ? `records unavailable: ${ws.unavailable.join(", ")}` : "current records loaded");
  const conversations = await getConversationStore().listByBusiness(graph.business.id);
  const views = (await listOperations(graph.business.id)).map((o) => operationView(o, ws.obligations, conversations));

  // A new, unrelated request replaces the owner's context — a later "yes" can never land on an earlier action.
  const keepsContext = (["affirm", "negate", "approval_response", "approval_explain", "operation_confirm", "conversation_takeover", "conversation_reply", "conversation_giveback"] as CommandIntent["kind"][]).includes(intent.kind) || (intent.kind === "query" && intent.topic === "customer" && !intent.subject);
  if (!keepsContext) {
    session.focus = undefined;
    session.draft = undefined;
  }

  switch (intent.kind) {
    case "query":
      return { ...(await answerQuery(intent, ws, views, { graph, source, actor, text: input.text ?? "", now, lang, session })), intent: "query" };

    case "operation_request": {
      if (!STARTABLE.includes(intent.workflow)) {
        step("grounding", "blocked", `no customer-facing follow-up for ${intent.workflow}`);
        return { text: T(`I can't start that on my own — there's no message BARRY can send customers for ${operationTitle(intent.workflow).command.toLowerCase()} yet. It stays on your list instead.`, `אני לא יכול להתחיל את זה לבד — עוד אין הודעה ש־BARRY יכול לשלוח ללקוחות עבור ${proactiveWords(intent.workflow, "he").command}. זה נשאר ברשימה שלך.`), intent: intent.kind };
      }
      if (ws.unavailable.includes("obligations") || ws.unavailable.includes("conversations")) {
        step("grounding", "blocked", "records unavailable — cohort can't be grounded");
        return { text: T("I can't read your records right now, so I can't tell exactly who this would reach. Nothing was started — try again in a moment.", "אני לא מצליח לקרוא את הרשומות כרגע, אז אני לא יכול לדעת בדיוק למי זה יגיע. שום דבר לא התחיל — נסה שוב עוד רגע."), intent: intent.kind };
      }
      const op = await proposeOperation({ graph, ws, workflow: intent.workflow, scope: intent.scope, commandId: record.id, source, actor: actorLabel(actor), now });
      record.operationId = op.id;
      const eligible = op.targets.filter((x) => x.eligibility === "eligible").length;
      step("grounding", "ok", `cohort ${op.targets.length}: ${eligible} eligible, ${op.targets.length - eligible} excluded`);
      step("entitlement", op.entitlement === "included" ? "ok" : "blocked", op.entitlement === "included" ? "proactive follow-ups included" : "not included in the plan");
      step("authority", op.state === "blocked" ? "blocked" : "ok", op.state === "blocked" ? op.blockedReason ?? "blocked" : `${op.authority} Rule: ${op.rule ? `after ${op.rule.afterHours}h, max ${op.rule.maxAttempts}, every ${op.rule.intervalHours}h` : "none"}`);
      const link = links(source, [{ label: T("See it live", "לראות בזמן אמת"), path: `/owner?tab=${source === "web" ? "work" : "today"}&operation=${encodeURIComponent(op.id)}` }]);
      if (op.state === "blocked") return { text: lang === "he" ? (op.entitlement === "not_included" ? "מעקבים יזומים לא כלולים בתוכנית שלך. שום דבר לא התחיל." : "אי אפשר להתחיל את זה כרגע לפי הכללים או ההגבלות הקיימות. שום דבר לא התחיל.") : `${op.blockedReason} Nothing was started.`, intent: intent.kind, links: op.entitlement === "not_included" ? links(source, [{ label: T("Your plan", "התוכנית שלך"), path: "/owner/settings#plan" }]) : undefined, operation: operationView(op, ws.obligations, conversations) };
      const summary = groundingSummary(op, lang);
      if (eligible === 0) {
        op.state = "completed";
        op.finishedAt = t();
        op.events.push({ at: t(), what: "Nothing eligible — nothing sent" });
        await saveOperation(op);
        step("plan", "info", "nothing eligible");
        return { text: `${summary}\n\n${T("Nobody to contact right now — nothing was sent.", "אין כרגע למי לפנות — שום דבר לא נשלח.")}`, intent: intent.kind, links: link, operation: operationView(op, ws.obligations, conversations) };
      }
      if (eligible > CONFIRM_ABOVE) {
        step("plan", "info", `waiting for the owner's go (${eligible} > ${CONFIRM_ABOVE})`);
        session.focus = { kind: "operation", opId: op.id };
        return { text: `${summary}\n\n${lang === "he" ? `להתחיל עם ${eligible} הלקוחות המתאימים?` : `${op.plannedAction}\nShall I start with the ${eligible} eligible customers?`}`, actions: [{ id: `o:${op.id}:${op.actionToken}:start`, title: T("Start", "להתחיל") }, { id: `o:${op.id}:${op.actionToken}:stop`, title: T("Cancel", "לבטל") }], links: link, intent: intent.kind, operation: operationView(op, ws.obligations, conversations) };
      }
      step("plan", "ok", `starting now with ${eligible}`);
      return { ...(await start(op.id, `${summary}\n\n${T(`Starting with the ${eligible} eligible customer${eligible === 1 ? "" : "s"}.`, eligible === 1 ? "מתחיל עם הלקוח המתאים." : `מתחיל עם ${eligible} הלקוחות המתאימים.`)}`)), intent: intent.kind };
    }

    case "operation_confirm": {
      const ops = await listOperations(graph.business.id);
      const inContext = session.focus?.kind === "operation" ? session.focus.opId : undefined;
      const target = action?.type === "start" ? ops.find((o) => o.id === action.opId) : inContext ? ops.find((o) => o.id === inContext) : ops.filter((o) => o.state === "proposed" && Date.parse(o.createdAt) > now.getTime() - 30 * 60_000)[0];
      session.focus = undefined;
      if (action?.type === "start" && (!target || target.actionToken !== action.token)) {
        step("grounding", "blocked", "start action does not match a stored operation token");
        return { text: T("That button doesn't match anything waiting for you — nothing was started.", "הכפתור הזה לא מתאים לשום דבר שמחכה לך — שום דבר לא התחיל."), intent: intent.kind };
      }
      if (!target || target.state !== "proposed") {
        step("grounding", "info", target ? `operation already ${target.state}` : "nothing proposed");
        return { text: target ? T(`That one is already ${STATE_WORDS[target.state].toLowerCase()} — nothing new was started.`, `זה כבר במצב "${STATE_WORDS_HE[target.state]}" — שום דבר חדש לא התחיל.`) : T("Nothing is waiting for your go right now.", "שום דבר לא מחכה לאישור שלך כרגע."), intent: intent.kind };
      }
      return { ...(await start(target.id, T(`Starting ${target.title.toLowerCase()} for ${target.targets.filter((x) => x.eligibility === "eligible").length} customers.`, `מתחיל: ${proactiveWords(target.workflow, "he").command}, ל־${target.targets.filter((x) => x.eligibility === "eligible").length} לקוחות.`))), intent: intent.kind };
    }

    case "operation_stop": {
      const ops = await listOperations(graph.business.id);
      const activeOps = ops.filter((o) => (ACTIVE as readonly string[]).includes(o.state) && views.find((v) => v.id === o.id)?.derivedState !== "completed");
      let chosen: OwnerOperation[];
      if (action?.type === "stop") {
        const o = ops.find((x) => x.id === action.opId);
        if (!o || o.actionToken !== action.token) {
          step("grounding", "blocked", "stop action does not match a stored operation token");
          return { text: T("That button doesn't match anything running — nothing was changed.", "הכפתור הזה לא מתאים לשום דבר שרץ — שום דבר לא השתנה."), intent: intent.kind };
        }
        chosen = [o];
      } else {
        const matching = intent.workflow ? activeOps.filter((o) => o.workflow === intent.workflow) : activeOps;
        if (matching.length === 0) {
          step("grounding", "info", "no active owner operation");
          return { text: T("Nothing you started is running right now, so there's nothing to stop. Your automatic follow-up rules still run on their own — the BARRY team changes them with you.", "שום דבר שהתחלת לא רץ כרגע, אז אין מה לעצור. כללי המעקב האוטומטיים ממשיכים לרוץ לבד — צוות BARRY משנה אותם איתך."), intent: intent.kind, links: links(source, [{ label: T("Rules", "כללים"), path: "/owner/rules" }]) };
        }
        if (matching.length > 1 && !intent.everything) {
          step("grounding", "info", `ambiguous: ${matching.length} active operations`);
          return { text: lang === "he" ? `${matching.length} דברים שהתחלת רצים עכשיו:\n${matching.map((o, i) => `${i + 1}. ${proactiveWords(o.workflow, "he").title}`).join("\n")}\nאיזה לעצור? (או ״לעצור הכול״.)` : `${plural(matching.length, "thing")} you started ${matching.length === 1 ? "is" : "are"} running:\n${matching.map((o, i) => `${i + 1}. ${o.title}`).join("\n")}\nWhich should I stop? (Or say “stop everything”.)`, actions: matching.slice(0, 3).map((o) => ({ id: `o:${o.id}:${o.actionToken}:stop`, title: lang === "he" ? `לעצור ${proactiveWords(o.workflow, "he").command.split(" ").slice(0, 2).join(" ")}`.slice(0, 20) : `Stop ${o.title.split(" ").slice(0, 2).join(" ")}`.slice(0, 20) })), intent: intent.kind };
        }
        chosen = matching;
      }
      const lines: string[] = [];
      for (const o of chosen) {
        const stopped = await stopOperation(graph.business.id, o.id, actorLabel(actor), now);
        if (!stopped) continue;
        const v = operationView(stopped, ws.obligations, conversations);
        step("execution", "ok", `stopped ${o.id}`);
        lines.push(lang === "he" ? (stopped.state === "stopped" ? `עצרתי: ${proactiveWords(stopped.workflow, "he").title}. ${v.progress.contacted ? `${v.progress.contacted} לקוחות כבר קיבלו הודעה — ההודעות האלה נשארות. ` : ""}BARRY לא יפנה לאף אחד נוסף במסגרת הזאת.` : `זה כבר היה במצב "${STATE_WORDS_HE[stopped.state]}".`) : stopped.state === "stopped" ? `Stopped ${stopped.title.toLowerCase()}. ${v.progress.contacted ? `${plural(v.progress.contacted, "customer")} already contacted — those messages stay sent. ` : ""}BARRY won't contact anyone else in it.` : `${stopped.title} was already ${STATE_WORDS[stopped.state].toLowerCase()}.`);
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
          return { text: T("That decision doesn't match a request I sent you — nothing was done.", "ההחלטה הזאת לא מתאימה לבקשה ששלחתי לך — לא נעשה כלום."), intent: intent.kind };
        }
      } else {
        // Text decides only the exact request in the owner's current context ("approve" / "yes" right after it
        // was shown), or — when the owner names the customer — the one request for that customer they were
        // shown. Anything else is SHOWN, never decided: a stale or ambiguous "yes" never acts.
        const current = (p: OwnerPrompt) => p.to === actorId(actor) && !p.usedAt && Date.parse(p.expiresAt) > now.getTime() && ws.approvals.some((a) => a.id === p.approvalId && a.actionable && a.revision === p.revision);
        const focus = session.focus?.kind === "approval" ? session.focus : undefined;
        if (!intent.subject && focus) {
          prompt = prompts.find((p) => p.key === focus.promptKey && p.to === actorId(actor));
          if (prompt) step("grounding", "ok", `the request in context: ${prompt.approvalId}`);
        } else if (intent.subject && source !== "web") {
          const distinct = [...new Map(prompts.filter((p) => current(p) && nameMatches(p.customer, intent.subject!)).map((p) => [p.approvalId, p])).values()];
          if (distinct.length === 1) prompt = distinct[0];
        }
        if (!prompt) {
          const pending = ws.interventions.filter((i) => i.refs.approvalId && ws.approvals.some((a) => a.id === i.refs.approvalId && a.actionable) && (!intent.subject || nameMatches(i.customer, intent.subject)));
          step("approval", "info", pending.length ? `shown the exact request to decide (${pending.length} pending; nothing decided)` : "no matching request");
          if (!pending.length) return { text: intent.subject ? T(`Nothing from ${intent.subject} is waiting for your decision.`, `שום דבר מ־${intent.subject} לא מחכה להחלטה שלך.`) : T("Nothing is waiting for your decision right now.", "שום דבר לא מחכה להחלטה שלך כרגע."), intent: intent.kind };
          const p = await approvalPrompt(ws, pending[0].id, actorId(actor), source, now, lang);
          if (p) focusApproval(session, ws, pending[0].id, p);
          const several = pending.length > 1 ? T(`${pending.length} requests are waiting (${pending.slice(0, 5).map((i) => i.customer).join(", ")}) — I won't guess which. Here's ${pending[0].customer}'s; decide it, or name the customer you meant.\n\n`, `${pending.length} בקשות מחכות (${pending.slice(0, 5).map((i) => i.customer).join(", ")}) — אני לא מנחש. הנה של ${pending[0].customer}; תחליט עליה, או תגיד לאיזה לקוח התכוונת.\n\n`) : T("Here's the request — nothing was decided yet:\n\n", "הנה הבקשה — עוד לא הוחלט כלום:\n\n");
          return { ...(p ?? { text: T("That request isn't open any more.", "הבקשה הזאת כבר לא פתוחה.") }), text: `${several}${p?.text ?? ""}`, intent: intent.kind };
        }
      }
      session.focus = undefined;
      if (prompt.usedAt) {
        step("approval", "info", "prompt already used (duplicate)");
        return { text: T("Already done — that decision was made once and won't run again.", "כבר בוצע — ההחלטה הזאת התקבלה פעם אחת ולא תרוץ שוב."), intent: intent.kind };
      }
      if (Date.parse(prompt.expiresAt) < now.getTime()) {
        step("approval", "blocked", "prompt expired");
        return { text: T("That request is too old to decide from here — open it to see where it stands.", "הבקשה הזאת ישנה מדי כדי להחליט עליה מכאן — פתח אותה כדי לראות איפה היא עומדת."), links: links(source, [{ label: T("Review", "לפרטים"), path: `/owner?tab=actions&intervention=${encodeURIComponent(prompt.interventionId)}` }]), intent: intent.kind };
      }
      const approval = ws.approvals.find((a) => a.id === prompt!.approvalId);
      if (!approval || !approval.actionable || approval.revision !== prompt.revision) {
        step("approval", "blocked", !approval ? "request not found" : !approval.actionable ? `request is ${approval.lifecycle}` : `revision changed ${prompt.revision} → ${approval.revision}`);
        const current = ws.interventions.find((i) => i.refs.approvalId === prompt!.approvalId);
        const again = approval?.actionable && current ? await approvalPrompt(ws, current.id, actorId(actor), source, now, lang) : undefined;
        if (again && current) focusApproval(session, ws, current.id, again);
        return { text: `${T("That request changed or was already decided since I sent it — nothing was done.", "הבקשה השתנתה או כבר הוחלטה מאז ששלחתי אותה — לא נעשה כלום.")}${again ? `\n\n${T("Here's the current one:", "הנה הבקשה העדכנית:")}\n\n${again.text}` : ""}`, actions: again?.actions, links: again?.links, intent: intent.kind };
      }
      // A person holds this conversation: BARRY can't act in it until it's returned (the request stays open).
      const convo = await getConversationStore().get(approval.conversationId);
      if (convo && humanHolds(convo)) {
        step("approval", "blocked", "a person holds the conversation");
        return { text: T(`You (or your team) hold the conversation with ${prompt.customer} — return it to BARRY first, then decide. Nothing was done.`, `השיחה עם ${prompt.customer} אצלך (או אצל הצוות) — החזירו אותה ל-BARRY ואז תחליטו. לא נעשה כלום.`), intent: intent.kind };
      }
      // Single use, marked BEFORE execution: a double tap or replay finds it used.
      await savePrompt({ ...prompt, usedAt: now.toISOString(), usedFor: `${intent.decision} by ${actorLabel(actor)}` });
      step("approval", "ok", `${intent.decision} ${approval.id} rev ${approval.revision}`);
      const heldText = T(`You (or your team) hold the conversation with ${prompt.customer} — return it to BARRY first, then decide. Nothing was done.`, `השיחה עם ${prompt.customer} אצלך (או אצל הצוות) — החזירו אותה ל-BARRY ואז תחליטו. לא נעשה כלום.`);
      const outcome = await resumeAfterApproval(graph, approval.id, intent.decision === "approve" ? "approved" : "declined", actorLabel(actor)).catch((err) => {
        // Taken over between the check above and the resume (which re-checks under the lock): nothing ran.
        if (err instanceof HumanHoldsConversationError) return undefined;
        throw err;
      });
      if (!outcome) {
        step("execution", "blocked", "a person holds the conversation");
        return { text: heldText, intent: intent.kind };
      }
      const held = outcome.turn.trace?.hold;
      step("execution", held ? "blocked" : "ok", held ? `held: ${held.reason}` : `${outcome.turn.trace?.stop.reason ?? "resumed"}`);
      step("verification", "ok", "approval resolved through the runtime resume path (revalidation, final-write gate, compare-and-set)");
      if (held) return { text: T(`Not carried out: ${held.reason}. The customer was asked to confirm first.`, "לא בוצע: הלקוח התבקש לאשר קודם."), intent: intent.kind };
      return { text: intent.decision === "approve" ? T(`Approved. BARRY told ${prompt.customer}: “${outcome.response.slice(0, 220)}”`, `אושר. BARRY כתב ל${/^[\u0590-\u05FF]/.test(prompt.customer) ? "" : "־"}${prompt.customer}: “${outcome.response.slice(0, 220)}”`) : T(`Declined — ${prompt.customer} was told; nothing was sent or charged.`, `נדחה — ${prompt.customer} קיבל עדכון; שום דבר לא נשלח ולא נגבה.`), links: links(source, [{ label: T("Conversation", "לשיחה"), path: `/owner?tab=${source === "web" ? "customers" : "inbox"}&conversation=${encodeURIComponent(approval.conversationId)}` }]), intent: intent.kind };
    }

    case "mode_change": {
      // Channel-independent: the same owner pause as the web control (durable, audited, this business only).
      try {
        const view = intent.to === "paused" ? await ownerPause(graph, actorLabel(actor)) : await ownerResume(graph, actorLabel(actor));
        step("execution", "ok", `mode ${view.mode}${view.pausedBy ? ` (paused by ${view.pausedBy})` : ""}`);
        return {
          text:
            intent.to === "paused"
              ? T("Paused. BARRY won't answer customers, send anything or change anything for this business until you resume it (say “resume BARRY”). Nothing was deleted.", "הושהה. BARRY לא יענה ללקוחות, לא ישלח ולא ישנה כלום בעסק הזה עד שתחדש (כתוב ״תחזור לעבוד״). שום דבר לא נמחק.")
              : T(`Resumed. BARRY is back in ${view.mode === "live" ? "live" : view.mode === "supervised" ? "supervised" : "practice"} mode.`, `חזרנו. BARRY חזר למצב ${view.mode === "live" ? "פעיל" : view.mode === "supervised" ? "מפוקח" : "תרגול"}.`),
          intent: intent.kind,
        };
      } catch (err) {
        if (!(err instanceof OwnerModeError)) throw err;
        step("execution", "blocked", err.code);
        return { text: T(err.message, "צוות BARRY השהה את העסק — הם יחדשו אותו איתך. שום דבר לא השתנה."), intent: intent.kind };
      }
    }

    case "mode_query": {
      const v = await ownerMode(graph);
      step("state", "ok", `mode ${v.mode}${v.pausedBy ? ` (paused by ${v.pausedBy})` : ""}`);
      const words: Record<Exclude<typeof v.mode, "paused">, [string, string]> = {
        simulator: ["Practice mode — BARRY talks with customers, but payments, bookings and orders run on a simulator; nothing real is charged or committed.", "מצב תרגול — BARRY מדבר עם לקוחות, אבל תשלומים, הזמנות ותורים רצים על סימולטור; שום דבר אמיתי לא נגבה או מתחייב."],
        supervised: ["Supervised — BARRY handles routine, reversible steps on its own and asks you before anything that moves money or commits the business.", "מפוקח — BARRY מטפל לבד בצעדים שגרתיים והפיכים, ושואל אותך לפני כל דבר שמזיז כסף או מחייב את העסק."],
        live: ["Live — BARRY acts within your rules; anything your rules flag still comes to you first.", "פעיל — BARRY פועל בתוך הכללים שלך; כל מה שהכללים מסמנים עדיין מגיע אליך קודם."],
      };
      const text =
        v.mode === "paused"
          ? v.pausedBy === "owner"
            ? T("Paused — by you. BARRY isn't answering customers, sending or changing anything; customer messages are kept. Say “resume BARRY” to continue.", "מושהה — על ידך. BARRY לא עונה ללקוחות, לא שולח ולא משנה כלום; הודעות של לקוחות נשמרות. כתוב ״תחזור לעבוד״ כדי להמשיך.")
            : T("Paused by the BARRY team. BARRY isn't answering customers or sending anything; customer messages are kept. The team resumes it with you.", "מושהה על ידי צוות BARRY. BARRY לא עונה ללקוחות ולא שולח כלום; הודעות של לקוחות נשמרות. הצוות יחדש את זה איתך.")
          : T(words[v.mode][0], words[v.mode][1]);
      return { text, intent: intent.kind, links: links(source, [{ label: T("Settings", "הגדרות"), path: "/owner?tab=more" }]) };
    }

    case "approval_explain": {
      const pending = ws.interventions.filter((i) => i.refs.approvalId && ws.approvals.some((a) => a.id === i.refs.approvalId && a.actionable));
      const focus = session.focus?.kind === "approval" ? session.focus : undefined;
      const matching = intent.subject ? pending.filter((i) => nameMatches(i.customer, intent.subject!)) : focus ? pending.filter((i) => i.refs.approvalId === focus.approvalId) : pending;
      if (!matching.length) {
        step("grounding", "info", "no matching request");
        return { text: focus && !intent.subject ? T(`The request for ${focus.customer} isn't open any more — nothing is waiting on it.`, `הבקשה של ${focus.customer} כבר לא פתוחה — שום דבר לא מחכה לה.`) : T("Nothing is waiting for your decision right now.", "שום דבר לא מחכה להחלטה שלך כרגע."), intent: intent.kind };
      }
      if (matching.length > 1) {
        step("grounding", "info", `ambiguous: ${matching.length} requests`);
        return { text: T(`${matching.length} requests are waiting: ${matching.slice(0, 5).map((i) => `${i.customer} — ${i.title}`).join("; ")}. Which one?`, `${matching.length} בקשות מחכות: ${matching.slice(0, 5).map((i) => `${i.customer} — ${i.title}`).join("; ")}. איזו מהן?`), intent: intent.kind };
      }
      const item = matching[0];
      const p = await approvalPrompt(ws, item.id, actorId(actor), source, now, lang);
      if (!p) return { text: T("That request isn't open any more.", "הבקשה הזאת כבר לא פתוחה."), intent: intent.kind };
      focusApproval(session, ws, item.id, p);
      step("grounding", "ok", `explained ${item.refs.approvalId}`);
      const tried = item.tried.slice(-3);
      return { ...p, text: `${p.text}${tried.length ? `\n\n${T("What BARRY did so far", "מה BARRY עשה עד עכשיו")}:\n${tried.map((x) => `• ${x}`).join("\n")}` : ""}`, intent: intent.kind };
    }

    case "affirm":
    case "negate": {
      const yes = intent.kind === "affirm";
      const draft = session.draft;
      if (action?.type === "reply" && (!draft || draft.requestId !== action.requestId)) {
        step("grounding", "blocked", "reply button does not match the draft in context");
        return { text: T("That message isn't waiting to be sent any more — nothing was sent.", "ההודעה הזאת כבר לא מחכה לשליחה — שום דבר לא נשלח."), intent: intent.kind };
      }
      if (draft) {
        session.draft = undefined;
        if (!yes) {
          step("plan", "info", "reply draft discarded");
          return { text: T(`OK — not sent. Nothing went to ${draft.customer}.`, `בסדר — לא נשלח. שום דבר לא הגיע ל${draft.customer}.`), intent: intent.kind };
        }
        return { ...(await sendReply(draft.conversationId, draft.customer, draft.text, draft.requestId)), intent: intent.kind };
      }
      if (session.focus?.kind === "operation") {
        const opId = session.focus.opId;
        session.focus = undefined;
        const op = (await listOperations(graph.business.id)).find((o) => o.id === opId);
        if (!op || op.state !== "proposed") {
          step("grounding", "info", op ? `operation already ${op.state}` : "operation not found");
          return { text: op ? T(`That one is already ${STATE_WORDS[op.state].toLowerCase()} — nothing new was started.`, `זה כבר במצב "${STATE_WORDS_HE[op.state]}" — שום דבר חדש לא התחיל.`) : T("Nothing is waiting for your go right now.", "שום דבר לא מחכה לאישור שלך כרגע."), intent: intent.kind };
        }
        if (yes) return { ...(await start(op.id, T(`Starting ${op.title.toLowerCase()} for ${op.targets.filter((x) => x.eligibility === "eligible").length} customers.`, `מתחיל: ${proactiveWords(op.workflow, "he").command}, ל־${op.targets.filter((x) => x.eligibility === "eligible").length} לקוחות.`))), intent: intent.kind };
        await stopOperation(graph.business.id, op.id, actorLabel(actor), now);
        step("execution", "ok", `cancelled proposed ${op.id}`);
        return { text: T("Cancelled — nothing was sent.", "בוטל — שום דבר לא נשלח."), intent: intent.kind };
      }
      step("grounding", "info", "a short reply with nothing in context — nothing done");
      return { text: yes ? T("I'm not sure what that refers to, so I didn't do anything. Tell me what you'd like — e.g. “what needs me?”", "אני לא בטוח למה זה מתייחס, אז לא עשיתי כלום. תגיד לי מה אתה רוצה — למשל ״מה צריך אותי?״") : T("OK — nothing changed.", "בסדר — שום דבר לא השתנה."), intent: intent.kind };
    }

    case "conversation_takeover": {
      const r = resolveConversation(intent.subject, session, ws, ws.conversations.filter((c) => c.status === "needs_you"), lang, T("Which conversation? Tell me the customer's name.", "איזו שיחה? תגיד לי את שם הלקוח."));
      if ("ask" in r) {
        step("grounding", "info", "conversation not resolved — asked");
        return { text: r.ask, intent: intent.kind };
      }
      try {
        await ownerTakeOver(graph, r.c.id, actorLabel(actor));
      } catch (err) {
        if (!(err instanceof OwnerControlError)) throw err;
        step("execution", "blocked", err.code);
        return { text: T("I couldn't find that conversation — nothing changed.", "לא מצאתי את השיחה הזאת — שום דבר לא השתנה."), intent: intent.kind };
      }
      session.focus = { kind: "conversation", conversationId: r.c.id, customer: r.c.customer };
      session.draft = undefined;
      step("execution", "ok", `taken over ${r.c.id}`);
      step("verification", "ok", "conversation control: human (the same handoff state as the web)");
      return { text: T(`You have the conversation with ${r.c.customer}. BARRY won't reply to them until you give it back — their messages are kept. Tell me what to send (“tell her …”), or say “give it back to BARRY”.`, `השיחה עם ${r.c.customer} אצלך. BARRY לא יענה להם עד שתחזיר אותה — ההודעות שלהם נשמרות. תגיד לי מה לשלוח (״תענה לה ש…״), או ״תחזיר לברי״.`), intent: intent.kind, links: links(source, [{ label: T("Open conversation", "לפתוח את השיחה"), path: `/owner?tab=customers&conversation=${encodeURIComponent(r.c.id)}` }]) };
    }

    case "conversation_giveback": {
      const r = resolveConversation(intent.subject, session, ws, ws.conversations.filter((c) => c.attention.includes("handoff_open")), lang, T("You're not holding any conversation right now.", "אין כרגע שיחה שאצלך."));
      if ("ask" in r) {
        step("grounding", "info", "conversation not resolved — asked");
        return { text: r.ask, intent: intent.kind };
      }
      try {
        await ownerReturnToBarry(graph, r.c.id, actorLabel(actor));
      } catch (err) {
        if (!(err instanceof OwnerControlError)) throw err;
        step("execution", "blocked", err.code);
        return { text: T("I couldn't find that conversation — nothing changed.", "לא מצאתי את השיחה הזאת — שום דבר לא השתנה."), intent: intent.kind };
      }
      session.draft = undefined;
      step("execution", "ok", `returned ${r.c.id} to BARRY`);
      step("verification", "ok", "conversation control: barry; open handoffs closed");
      return { text: T(`BARRY has the conversation with ${r.c.customer} again and will handle their next message.`, `השיחה עם ${r.c.customer} חזרה ל־BARRY, והוא יטפל בהודעה הבאה שלהם.`), intent: intent.kind };
    }

    case "conversation_reply": {
      const r = resolveConversation(intent.subject, session, ws, ws.conversations.filter((c) => c.attention.includes("handoff_open") || c.status === "needs_you"), lang, T("Who should I send that to? Tell me the customer's name.", "למי לשלוח את זה? תגיד לי את שם הלקוח."));
      if ("ask" in r) {
        step("grounding", "info", "recipient not resolved — asked, nothing sent");
        return { text: r.ask, intent: intent.kind };
      }
      session.focus = { kind: "conversation", conversationId: r.c.id, customer: r.c.customer };
      // The owner's exact words (after a colon) go as written; anything else is drafted and shown first.
      if (intent.exact) return { ...(await sendReply(r.c.id, r.c.customer, intent.text, record.id)), intent: intent.kind };
      const text = await draftCustomerReply(intent.text, r.c.customer, lang);
      const requestId = `rq_${crypto.randomBytes(8).toString("hex")}`;
      session.draft = { conversationId: r.c.id, customer: r.c.customer, text, requestId, at: now.toISOString() };
      step("plan", "info", `reply drafted for ${r.c.id} — waiting for the owner's send`);
      return { text: T(`I'll send ${r.c.customer}:\n“${text}”\n\nSend it?`, `אשלח ל${r.c.customer}:\n“${text}”\n\nלשלוח?`), actions: [{ id: `r:${requestId}:send`, title: T("Send", "לשלוח") }, { id: `r:${requestId}:cancel`, title: T("Don't send", "לא לשלוח") }], intent: intent.kind };
    }

    case "policy_change_request": {
      step("plan", "info", `rule proposal prepared (not applied): ${intent.text.slice(0, 120)}`);
      return { text: T(`I've prepared this as a rule: “${intent.text.replace(/[.!]+$/, "")}”.\nRules take effect only after you review how I'll apply them — nothing has changed yet.`, `הכנתי את זה ככלל: “${intent.text.replace(/[.!]+$/, "")}”.\nכלל נכנס לתוקף רק אחרי שתבדוק איך אני אפעל לפיו — עוד שום דבר לא השתנה.`), links: links(source, [{ label: T("Review the rule", "לבדוק את הכלל"), path: `/owner/train?rule=${encodeURIComponent(intent.text)}#teach-rule` }]), intent: intent.kind };
    }

    case "unsupported":
      step("plan", "blocked", "unsupported");
      return { text: lang === "he" ? "BARRY שולח הודעות רק ללקוחות שכבר מדברים עם העסק, בתוך השיחה שלהם — קמפיינים או הודעות תפוצה הוא לא יכול להריץ. שום דבר לא התחיל." : `${intent.reason} Nothing was started.`, intent: intent.kind };
  }

  /** The owner's message to the customer — the same service (and at-most-once request id) as the web reply box. */
  async function sendReply(conversationId: string, customer: string, text: string, requestId: string): Promise<Omit<OwnerReply, "intent">> {
    try {
      const r = await ownerReply(graph, conversationId, { requestId, text, by: actorLabel(actor) }, { now });
      session.focus = { kind: "conversation", conversationId, customer };
      step("execution", r.status === "failed" ? "failed" : r.status === "unknown" ? "info" : "ok", `owner reply ${requestId}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
      step("verification", "ok", "recorded as the owner's message with its delivery; the owner holds the conversation");
      const tail = T("\nYou hold the conversation — BARRY stays quiet there until you say “give it back to BARRY”.", "\nהשיחה אצלך — BARRY שותק שם עד שתגיד ״תחזיר לברי״.");
      const words: Record<typeof r.status, string> = {
        sent: T(`Sent to ${customer}: “${r.text.slice(0, 300)}”`, `נשלח ל${customer}: “${r.text.slice(0, 300)}”`),
        dry_run: T(`Test mode — recorded in ${customer}'s conversation but NOT sent (WhatsApp sending is off): “${r.text.slice(0, 300)}”`, `מצב בדיקה — נרשם בשיחה עם ${customer} אבל לא נשלח (שליחה בוואטסאפ כבויה): “${r.text.slice(0, 300)}”`),
        failed: T(`Couldn't send it — nothing reached ${customer}${r.error ? ` (${r.error})` : ""}.`, `לא הצלחתי לשלוח — שום דבר לא הגיע ל${customer}.`),
        unknown: T(`That send was interrupted — I can't confirm it reached ${customer}, and I won't send it again. Check the conversation.`, `השליחה נקטעה — אני לא יכול לאשר שהגיעה ל${customer}, ולא אשלח שוב. בדוק את השיחה.`),
        sending: T("Still sending — check the conversation.", "עדיין נשלח — בדוק את השיחה."),
      };
      return { text: `${words[r.status]}${r.status === "failed" || r.status === "unknown" ? "" : tail}`, links: links(source, [{ label: T("Open conversation", "לפתוח את השיחה"), path: `/owner?tab=customers&conversation=${encodeURIComponent(conversationId)}` }]) };
    } catch (err) {
      if (!(err instanceof OwnerControlError)) throw err;
      step("execution", "blocked", err.code);
      const text = err.code === "outside_whatsapp_window" ? T(err.message, "עברו יותר מ־24 שעות מאז שהלקוח כתב, אז וואטסאפ מאפשר רק הודעת תבנית מאושרת. שום דבר לא נשלח.") : err.code === "not_found" ? T("I couldn't find that conversation — nothing was sent.", "לא מצאתי את השיחה הזאת — שום דבר לא נשלח.") : T("There's nothing to send — nothing was sent.", "אין מה לשלוח — שום דבר לא נשלח.");
      return { text };
    }
  }

  async function start(opId: string, lead: string): Promise<Omit<OwnerReply, "intent">> {
    const res = await runOperation(graph, opId, now);
    if (!res.ok) {
      step("execution", "info", `not started: ${res.reason}`);
      return { text: res.op ? T(`That one is already ${STATE_WORDS[res.op.state].toLowerCase()} — nothing new was started.`, `זה כבר במצב "${STATE_WORDS_HE[res.op.state]}" — שום דבר חדש לא התחיל.`) : T("I couldn't find that operation — nothing was started.", "לא מצאתי את הפעולה הזאת — שום דבר לא התחיל.") };
    }
    const fresh = await getOwnerWorkspace(graph, { now, lang });
    const view = operationView(res.op, fresh.obligations, await getConversationStore().listByBusiness(graph.business.id));
    const dry = res.op.targets.some((x) => x.result?.outcome === "dry_run");
    step("execution", res.op.state === "failed" || res.op.state === "blocked" ? "failed" : "ok", `${res.op.state}: contacted ${view.progress.contacted}, failed ${view.progress.failed}`);
    step("verification", "ok", "per-target attempts recorded by the executor; results will be read from records");
    return {
      text: `${lead}\n\n${operationSummary(view, lang)}${dry ? T("\n\n(Test mode: the messages were recorded as test runs — nothing was sent, and nothing was added to the customers' conversations.)", "\n\n(מצב בדיקה: ההודעות נרשמו כהרצת בדיקה — שום דבר לא נשלח ושום דבר לא נוסף לשיחות עם הלקוחות.)") : ""}`,
      actions: (ACTIVE as readonly string[]).includes(res.op.state) ? [{ id: `o:${res.op.id}:${res.op.actionToken}:stop`, title: T("Stop", "לעצור") }] : undefined,
      links: links(source, [{ label: T("See it live", "לראות בזמן אמת"), path: `/owner?tab=${source === "web" ? "work" : "today"}&operation=${encodeURIComponent(res.op.id)}` }]),
      operation: view,
    };
  }
}

type ParsedAction = { type: "decision"; promptKey: string; decision: "approve" | "decline" } | { type: "start" | "stop"; opId: string; token: string } | { type: "reply"; requestId: string; send: boolean };
export function parseAction(id: string): ParsedAction | undefined {
  const d = id.match(/^d:(pr_[a-f0-9]{16}):(approve|decline)$/);
  if (d) return { type: "decision", promptKey: d[1], decision: d[2] as "approve" | "decline" };
  const o = id.match(/^o:(op_[a-f0-9]{12}):([A-Za-z0-9_-]{8,20}):(start|stop)$/);
  if (o) return { type: o[3] as "start" | "stop", opId: o[1], token: o[2] };
  const r = id.match(/^r:(rq_[a-f0-9]{16}):(send|cancel)$/);
  if (r) return { type: "reply", requestId: r[1], send: r[2] === "send" };
  return undefined;
}
