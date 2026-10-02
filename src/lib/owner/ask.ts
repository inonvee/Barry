import OpenAI from "openai";
import type { BusinessGraph } from "@/lib/business-graph";
import { createCompletion, modelFor, samplingParams } from "@/lib/reasoner/model-config";
import { classifyProviderError } from "@/lib/reasoner/openai-reasoner";
import { findUnsupportedClaims, type ClaimEvidence } from "@/lib/reasoner/claim-grounding";
import { money } from "@/lib/reasoner/deterministic-compose";
import type { ModelCallFailure } from "@/lib/reasoner/types";
import { getOwnerWorkspace, type OwnerWorkspace } from "./service";
import { revenueSummary, type Money } from "./revenue";
import { interventionBriefing } from "./interventions";
import { conversationStory } from "./story";
import { NEXT_MOVE_WORDS, isOpen } from "@/lib/operator/obligations";
import { getConversationStore } from "@/lib/state";
import { getBackend } from "@/lib/store";
import { assessPilotReadiness, type PilotReadiness } from "./readiness";
import type { OwnerLang } from "./lang";

/**
 * OWNER BARRY (read-only MVP) — the business owner's assistant, not the customer's.
 *
 * It answers questions about THIS business ("what happened today?", "who needs me?", "how much did you
 * make me this week?", "why did this fail?") from one briefing built by the same read model the owner
 * dashboard uses. It has no tools and no write path: it cannot approve, change a rule, send a message
 * or run anything — a request to do so is answered with where the owner does it. Future mutations
 * become structured proposals through the same authority system, never free-form actions.
 *
 * Every answer is checked before it is shown: each number must come from the briefing, and it may not
 * claim to have done anything. Otherwise (or with no model available) the owner gets the factual
 * briefing itself — never an improvised answer.
 */

export type OwnerBriefing = ReturnType<typeof buildBriefing>;

const fmt = (m: Money) => Object.entries(m).map(([c, v]) => money(v, c)).join(" + ") || "none";

export function buildBriefing(ws: OwnerWorkspace, week: ReturnType<typeof revenueSummary>, readiness: PilotReadiness, stories: { customer: string; story: ReturnType<typeof conversationStory> }[] = []) {
  return {
    business: ws.business.name,
    today: {
      conversations: ws.today.conversations,
      handledWithoutYou: ws.today.handledAutonomously,
      needYourAttention: ws.today.needYou,
      approvalsWaiting: ws.today.approvalsWaiting,
      handoffsOpen: ws.today.handoffsOpen,
      completedOutcomes: ws.today.completedOutcomes,
      blockedOrFailed: ws.today.blockedOrFailed,
    },
    revenueToday: revenueWords(ws.revenue),
    revenueLast7Days: revenueWords(week),
    // THE intervention queue — the same items, in the same order, as the dashboard.
    waitingForYou: interventionBriefing(ws.interventions),
    // Where money is stuck, at risk or waiting, and whose move it is (simulated items marked, never counted).
    moneyInMotion: {
      stuckWithYou: fmt(ws.opportunities.summary.stuckWithYou),
      waitingOnCustomer: fmt(ws.opportunities.summary.waitingOnCustomer),
      atRisk: fmt(ws.opportunities.summary.atRisk),
      simulatedTestMoney: fmt(ws.opportunities.summary.simulated),
      items: ws.opportunities.items.slice(0, 12).map((o) => ({ kind: o.kind.replace(/_/g, " "), customer: o.customer, ...(o.amount !== undefined && o.currency ? { amount: money(o.amount, o.currency) } : {}), why: o.reasoning, nextMove: `${o.next.who === "you" ? "you" : o.next.who === "customer" ? "the customer" : "BARRY"}: ${o.next.action}`, ...(o.simulated ? { simulated: true } : {}) })),
    },
    // What BARRY is watching (durable obligations): whose move it is, what it is waiting for, when it is due.
    watching: ws.obligations.filter(isOpen).slice(0, 12).map((o) => ({ customer: o.customer, what: o.subject, kind: o.kind.replace(/_/g, " "), whoseMove: NEXT_MOVE_WORDS[o.nextMove], next: o.nextAction, ...(o.dueAt ? { due: o.dueAt } : {}), ...(o.amount !== undefined && o.currency ? { amount: money(o.amount, o.currency) } : {}), ...(o.simulated ? { simulated: true } : {}) })),
    conversationsNeedingAttention: ws.conversations.filter((c) => c.status === "needs_you").slice(0, 10).map((c) => ({ customer: c.customer, why: c.attention, lastMessage: c.lastMessage?.text })),
    recentOutcomes: ws.outcomes.slice(0, 20).map((o) => ({ what: o.label, customer: ws.conversations.find((c) => c.id === o.conversationId)?.customer ?? "a customer", ...(o.amount !== undefined && o.currency ? { amount: money(o.amount, o.currency) } : {}), ...(o.reference ? { reference: o.reference } : {}), when: o.at, ...(o.simulated ? { simulated: true } : {}) })),
    // What happened in the conversations that need the owner (and the latest ones): asked → BARRY did → outcome, from records.
    whatHappened: stories.slice(0, 8).map((s) => ({
      customer: s.customer,
      steps: s.story.steps.slice(-6).map((st) => ({ customerAsked: st.customer, barryDid: st.barry, outcome: st.outcome.replace(/_/g, " "), ...(st.stopped ? { stoppedBecause: st.stopped } : {}) })),
      whereThingsStand: s.story.standing,
    })),
    aiHealth: ws.health.ai.summary,
    systems: ws.health.systems.map((s) => `${s.domain}: ${s.state}${s.blockers.length ? ` (${s.blockers.join("; ")})` : ""}`),
    readiness: { level: readiness.label, blockers: readiness.next?.blockers.map((b) => `${b.label}: ${b.detail}`) ?? [] },
    // What BARRY can do for this business right now, what only works on a simulator, and what each setup step would unlock.
    capabilities: { canDoNow: ws.capabilities.now, onSimulatorOnly: ws.capabilities.nowSimulated, afterSetup: ws.capabilities.steps.map((s) => ({ step: s.title, who: s.who === "you" ? "you" : "the BARRY team", unlocks: s.unlocks })) },
  };
}

function revenueWords(r: ReturnType<typeof revenueSummary>) {
  return {
    collectedByBarry: fmt(r.direct),
    paymentsCollected: r.directPayments,
    recoveredAfterAFailedAttempt: fmt(r.recovered),
    bookedValueNotYetCollected: fmt(r.influenced),
    openOpportunities: fmt(r.potential),
    /** Unpaid links on a simulated provider: pending test money (labelled, never revenue, never inside openOpportunities). */
    pendingSimulatedTestMoney: fmt(r.potentialSimulated),
    pendingSimulatedItems: r.potentialSimulatedItems,
    simulatedTestMoney: fmt(r.simulatedPaid),
    conversationsWithPurchaseIntent: r.purchaseIntentConversations,
    converted: r.convertedConversations,
    lostOpportunities: r.lostOpportunities,
    discountsGranted: r.discounts.granted,
    discountsRefused: r.discounts.refused,
    conversationsThatNeededYou: r.ownerInterventions,
    activeConversations: r.activeConversations,
  };
}

/** The briefing as plain text — the answer when a model can't be used or its answer can't be verified. */
export function briefingText(b: OwnerBriefing): string {
  return briefingTextEn(b);
}
function briefingTextEn(b: OwnerBriefing): string {
  const lines = [
    "I can report on your business, but I'm read-only: I can't change settings, approve requests or run actions from here (use Approvals, or ask the BARRY team for rule changes).",
    `Today at ${b.business}: ${b.today.conversations} customer conversation${b.today.conversations === 1 ? "" : "s"}, ${b.today.handledWithoutYou} handled without you, ${b.today.needYourAttention} need you.`,
    `Collected by BARRY today: ${b.revenueToday.collectedByBarry} (${b.revenueToday.paymentsCollected} payment${b.revenueToday.paymentsCollected === 1 ? "" : "s"}). Last 7 days: ${b.revenueLast7Days.collectedByBarry}.`,
    b.revenueToday.bookedValueNotYetCollected !== "none" ? `Booked but not yet collected: ${b.revenueToday.bookedValueNotYetCollected}.` : "",
    b.revenueToday.openOpportunities !== "none" ? `Open opportunities (not revenue yet): ${b.revenueToday.openOpportunities}.` : "",
    b.revenueToday.pendingSimulatedTestMoney !== "none" ? `Pending on a simulated provider (test money, unpaid, not revenue): ${b.revenueToday.pendingSimulatedTestMoney} across ${b.revenueToday.pendingSimulatedItems} link${b.revenueToday.pendingSimulatedItems === 1 ? "" : "s"}.` : "",
    b.waitingForYou.length ? `Waiting for you: ${b.waitingForYou.map((w) => `${w.customer} — ${w.what}${w.amount ? ` (${w.amount})` : ""} → ${w.youDecide}`).join("; ")}.` : "Nothing is waiting for you.",
    b.watching.length ? `BARRY is watching: ${b.watching.slice(0, 5).map((w) => `${w.customer}: ${w.what}${w.amount ? ` (${w.amount})` : ""} — ${w.whoseMove}: ${w.next}`).join("; ")}.` : "",
    b.moneyInMotion.items.length ? `Money in motion: ${b.moneyInMotion.stuckWithYou} waits on you, ${b.moneyInMotion.waitingOnCustomer} on customers, ${b.moneyInMotion.atRisk} at risk${b.moneyInMotion.simulatedTestMoney !== "none" ? `, ${b.moneyInMotion.simulatedTestMoney} is test money on a simulated provider` : ""}. ${b.moneyInMotion.items.slice(0, 4).map((o) => `${o.customer}: ${o.kind}${o.amount ? ` ${o.amount}` : ""}${o.simulated ? " (simulated, test)" : ""} — ${o.nextMove}`).join("; ")}.` : "",
    `AI: ${b.aiHealth}`,
    `Readiness: ${b.readiness.level}.`,
    b.capabilities.canDoNow.length ? `BARRY can do now: ${b.capabilities.canDoNow.slice(0, 8).join("; ")}.` : "",
    b.capabilities.afterSetup.length ? `After setup: ${b.capabilities.afterSetup.slice(0, 4).map((s) => `${s.step} → ${s.unlocks.join(", ")}`).join("; ")}.` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The factual briefing in Hebrew — the same figures, shown when a model can't be used or verified. */
export function briefingTextHe(b: OwnerBriefing): string {
  const none = (v: string) => (v === "none" ? "אין" : v);
  const lines = [
    "אני יכול לדווח על העסק, אבל אני לקריאה בלבד: מכאן אני לא משנה הגדרות, לא מאשר בקשות ולא מבצע פעולות (אישורים נמצאים ב״עבודה״; שינויי כללים — עם צוות BARRY).",
    `היום ב־${b.business}: ${b.today.conversations} שיחות עם לקוחות, ${b.today.handledWithoutYou} בלי צורך בך, ${b.today.needYourAttention} צריכות אותך.`,
    `נגבה היום: ${none(b.revenueToday.collectedByBarry)} (${b.revenueToday.paymentsCollected} תשלומים מאומתים). ב־7 הימים האחרונים: ${none(b.revenueLast7Days.collectedByBarry)}.`,
    b.revenueToday.openOpportunities !== "none" ? `הזדמנויות פתוחות (עוד לא הכנסה): ${b.revenueToday.openOpportunities}.` : "",
    b.revenueToday.pendingSimulatedTestMoney !== "none" ? `ממתין בסימולטור (כסף של בדיקות, לא הכנסה): ${b.revenueToday.pendingSimulatedTestMoney}.` : "",
    b.waitingForYou.length ? `מחכה לך: ${b.waitingForYou.map((w) => `${w.customer}${w.amount ? ` (${w.amount})` : ""}`).join("; ")}.` : "שום דבר לא מחכה לך.",
    b.moneyInMotion.items.length ? `כסף בתנועה: ${none(b.moneyInMotion.stuckWithYou)} מחכה לך, ${none(b.moneyInMotion.waitingOnCustomer)} מחכה ללקוחות, ${none(b.moneyInMotion.atRisk)} בסיכון.` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const OWNER_PROMPT = `You are BARRY's owner assistant: you help the owner of ONE business understand what BARRY did for them. You are READ-ONLY.
Answer the owner's question using ONLY the JSON briefing. Rules:
- Every number, amount, name and status you state must appear in the briefing. If the briefing doesn't contain it, say you don't have that information.
- Keep money categories apart: "collectedByBarry" is money actually collected and verified; "bookedValueNotYetCollected" is value secured but not collected; "openOpportunities" is NOT revenue; "pendingSimulatedTestMoney" is an unpaid link on a simulated provider (say it exists, that it is pending and test money, never revenue); "simulatedTestMoney" is test money, never revenue. Never add them together. When asked about pending or unpaid payments, mention every pending link, including simulated ones, labelled as such.
- "watching" is what BARRY keeps track of until the records show it's done (unpaid links, missing deposits, failed actions, undelivered replies): say whose move it is and what happens next; never promise BARRY will send reminders unless "next" says so.
- "waitingForYou" is the owner's queue: for each item say what it is, why BARRY escalated (its "why"), what the owner decides ("youDecide") and what follows ("ifApproved"). "moneyInMotion" says where money is stuck and whose move it is — recommend that move, never invent another.
- To explain WHY something happened or failed, use "whatHappened": the customer's asks, what BARRY did ("barryDid"), the outcome and "stoppedBecause" — quote those, never guess a cause.
- "What can you do for me?" is answered from "capabilities": canDoNow (real), onSimulatorOnly (nothing real happens yet), and afterSetup (each step and what it unlocks). Never promise a capability that isn't listed.
- You cannot do anything: you never approve, decline, change rules, send messages, give discounts or run actions. If asked to, say you can't do that from here and where the owner does it (Approvals, the inbox, or with the BARRY team for rule changes).
- Never say you did, changed, sent or approved something.
- Be brief and concrete: lead with the answer, then at most a few supporting lines. Plain text, no JSON, no headers. Reply in the owner's language.`;

export type OwnerAnswer = { answer: string; source: "model" | "briefing"; reason?: string; failure?: ModelCallFailure };
/** Where the answer's subjects live in the product, so the owner can jump there. */
export type OwnerAnswerLinks = { interventions: { id: string; title: string; customer: string }[]; opportunities: { id: string; conversationId: string; customer: string; kind: string }[]; steps: { id: string; title: string }[] };
function linksOf(ws: OwnerWorkspace): OwnerAnswerLinks {
  return {
    interventions: ws.interventions.slice(0, 5).map((i) => ({ id: i.id, title: i.title, customer: i.customer })),
    opportunities: ws.opportunities.items.slice(0, 5).map((o) => ({ id: o.id, conversationId: o.conversationId, customer: o.customer, kind: o.kind.replace(/_/g, " ") })),
    steps: ws.capabilities.steps.slice(0, 3).map((s) => ({ id: s.id, title: s.title })),
  };
}

const FIRST_PERSON_ACTION = /\bI(?:'ve| have|'ll| will)?\s+(?:just\s+|now\s+|already\s+)?(?:applied|changed|updated|set|approved|declined|sent|given|gave|created|cancell?ed|raised|lowered|refunded|booked|made|turned on|enabled|disabled|added|removed)\b|(?:^|\s)(?:החלתי|עדכנתי|שיניתי|אישרתי|דחיתי|שלחתי|נתתי|יצרתי|ביטלתי|הפעלתי|הוספתי|הסרתי)(?:\s|$|[.,!])/i;

function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
}

/** Every figure in the answer must be one the briefing (or the question) contains; no action claims. */
export function checkOwnerAnswer(answer: string, briefing: OwnerBriefing, question: string): string | undefined {
  return checkAnswerAgainstBriefing(answer, briefing, question);
}

/** The same verification for any read-only briefing (owner or founder): figures must come from the briefing; no action claims. */
export function checkAnswerAgainstBriefing(answer: string, briefing: unknown, question: string): string | undefined {
  const allowed = new Set([...numbersIn(JSON.stringify(briefing)), ...numbersIn(question)]);
  const stray = numbersIn(answer).filter((n) => !allowed.has(n) && !allowed.has(String(Number(n))));
  if (stray.length) return `figures not in the briefing: ${[...new Set(stray)].join(", ")}`;
  const none: ClaimEvidence = { kinds: new Set(), ownerRequestExists: false, ownerRequestWaiting: false, amounts: [], mentioned: [], percentages: [], factText: "", customerText: "", reportedText: "", knownItems: [], addedThisTurn: [], times: [] };
  const claims = findUnsupportedClaims(answer, { ...none, amounts: numbersIn(JSON.stringify(briefing)).map(Number), times: [] }).filter((c) => c.why.startsWith("claims a"));
  if (claims.length) return `claims an action: ${claims[0].why}`;
  // Owner Barry is read-only: a first-person claim of having DONE something is never true.
  if (FIRST_PERSON_ACTION.test(answer)) return "claims an action: a read-only assistant can't have done that";
  return undefined;
}

export async function askOwnerBarry(graph: BusinessGraph, question: string, opts: { client?: Pick<OpenAI, "chat">; now?: Date; lang?: OwnerLang } = {}): Promise<OwnerAnswer & { briefing: OwnerBriefing; links: OwnerAnswerLinks }> {
  const now = opts.now ?? new Date();
  const briefingText = (b: OwnerBriefing) => (opts.lang === "he" ? briefingTextHe(b) : briefingTextEn(b));
  const ws = await getOwnerWorkspace(graph, { now });
  const weekSince = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const [conversations, payments, bookings, orders, approvals] = await Promise.all([
    getConversationStore().listByBusiness(graph.business.id).catch(() => []),
    getBackend().listPaymentRequests(graph.business.id).catch(() => []),
    getBackend().listBookings(graph.business.id).catch(() => []),
    getBackend().listCommerceOrders(graph.business.id).catch(() => []),
    getBackend().listApprovals(graph.business.id).catch(() => []),
  ]);
  const week = revenueSummary({ graph, conversations, payments, bookings, orders, approvals, since: weekSince, now });
  const readiness = await assessPilotReadiness(graph, { conversations });
  // Stories for the conversations that need the owner first, then the most recent ones — so "why?" is answerable.
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const storyIds = [...new Set([...ws.interventions.map((i) => i.conversationId), ...ws.conversations.map((c) => c.id)])].slice(0, 8);
  const stories = storyIds.flatMap((id) => (byId.get(id) ? [{ customer: ws.conversations.find((c) => c.id === id)?.customer ?? "Customer", story: conversationStory(byId.get(id)!) }] : []));
  const briefing = buildBriefing(ws, week, readiness, stories);
  const client = opts.client ?? (process.env.BARRY_REASONER === "openai" && process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 }) : undefined);
  const links = linksOf(ws);
  if (!client) return { answer: briefingText(briefing), source: "briefing", reason: "no AI model configured — showing the factual summary", briefing, links };
  const model = modelFor("composer");
  try {
    const completion = await createCompletion(client as OpenAI, {
      model,
      messages: [
        { role: "system", content: OWNER_PROMPT },
        { role: "user", content: JSON.stringify({ briefing, question: question.slice(0, 1000), ...(opts.lang === "he" ? { replyLanguage: "Hebrew — the owner's interface is in Hebrew; answer in natural Israeli Hebrew" } : {}) }) },
      ],
      ...samplingParams(model, "composer", 0.2),
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return { answer: briefingText(briefing), source: "briefing", reason: "the AI returned nothing — showing the factual summary", briefing, links };
    const problem = checkOwnerAnswer(text, briefing, question);
    if (problem) return { answer: briefingText(briefing), source: "briefing", reason: `the AI's answer couldn't be verified (${problem}) — showing the factual summary`, briefing, links };
    return { answer: text, source: "model", briefing, links };
  } catch (err) {
    const failure = classifyProviderError(err);
    return { answer: briefingText(briefing), source: "briefing", reason: "AI unavailable — showing the factual summary", failure, briefing, links };
  }
}
