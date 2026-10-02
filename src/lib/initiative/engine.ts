import crypto from "node:crypto";
import type { OwnerLang } from "@/lib/owner/lang";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { readLedger } from "@/lib/runtime/ledger";
import { isSimulatedPayment } from "@/lib/owner/revenue";
import { getOwnerWorkspace, startOfLocalDay } from "@/lib/owner/service";
import { listCostEvidence } from "@/lib/finance/evidence";
import { listOperations, operationView } from "@/lib/owner/operations";
import { executeOwnerCommand, type OwnerReply } from "@/lib/owner/command-service";
import type { Money } from "@/lib/owner/revenue";
import { DETECTORS, type Candidate, type Snapshot } from "./detectors";
import { isOpenInitiative, materiallyNew, toView, type Initiative, type InitiativeView } from "./model";
import { listInitiatives, listScans, saveInitiative as save, saveScan, visibleInitiatives, type ScanRecord } from "./store";

export { listInitiatives, listScans, visibleInitiatives, type ScanRecord };

/**
 * THE INITIATIVE ENGINE — bounded scans over ONE business's trusted records.
 *
 *   observe (snapshot) → detect (candidates) → verify (every number recomputed from its record
 *   references; money only from real records) → dedupe (stable fingerprint; dismissed / snoozed stay
 *   quiet unless evidence is materially new) → rank (evidence first) → persist only what clears the bar.
 *
 * Up to SCANS_PER_DAY scans per business-local day; a scan quota is not a notification quota — at most
 * SURFACE_PER_DAY new initiatives are surfaced a day, at most SURFACED_AT_ONCE are on show at once, and
 * an empty scan surfaces nothing. Scans never send anything; the owner sees initiatives in the Control
 * Room (and later, through the existing brief system).
 */

export const SCANS_PER_DAY = 3;
export const SURFACE_PER_DAY = 2;
export const SURFACED_AT_ONCE = 3;
export const DISMISS_QUIET_DAYS = 14;


const day = (tz: string, d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const daysBefore = (iso: string, n: number) => new Date(Date.parse(iso) - n * 24 * 3600_000).toISOString();
const productOf = (item: string) => item.replace(/\s*\([^)]*\)\s*$/, "").trim();

// ── observe ──────────────────────────────────────────────────────────────────────────────────────

export async function buildSnapshot(graph: BusinessGraph, now = new Date()): Promise<Snapshot> {
  const businessId = graph.business.id;
  const tz = graph.business.timezone;
  const ws = await getOwnerWorkspace(graph, { now });
  const [conversations, orders, payments, costs, ops] = await Promise.all([
    getConversationStore().listByBusiness(businessId),
    getBackend().listCommerceOrders(businessId).catch(() => []),
    getBackend().listPaymentRequests(businessId).catch(() => []),
    listCostEvidence(businessId).catch(() => []),
    listOperations(businessId).catch(() => []),
  ]);
  const today = startOfLocalDay(tz, now);
  const simulatedConv = new Set(payments.filter(isSimulatedPayment).map((p) => p.conversationId));
  const opViews = ops.map((o) => operationView(o, ws.obligations, conversations));
  const topics = new Set(graph.knowledge.map((k) => k.topic));
  return {
    businessId,
    timezone: tz,
    now,
    window: { d7: daysBefore(today, 6), d14: daysBefore(today, 13), d30: daysBefore(today, 29), d60: daysBefore(today, 59), localDate: day(tz, now) },
    knowledgeTopics: graph.knowledge.map((k) => k.topic),
    plan: { proactive: ws.operator.included, margins: ws.plan.marginsIncluded, name: ws.plan.name },
    rules: ws.operator.rules.map((r) => ({ kind: r.kind, enabled: r.enabled })),
    obligations: ws.obligations,
    approvals: ws.approvals.map((a) => ({ id: a.id, action: a.action, lifecycle: a.lifecycle === "active" ? "active" : a.lifecycle, createdAt: a.createdAt, terms: a.terms })),
    conversations: conversations
      .filter((c) => c.businessId === businessId)
      .map((c) => ({
        id: c.id,
        simulated: simulatedConv.has(c.id) || c.id.startsWith("qa:"),
        turns: c.turns.map((t) => {
          const asks = (t.trace?.asks ?? []).map((a) => ({ kind: a.kind, status: a.status, ...(a.topic ? { topic: a.topic } : {}) }));
          // The turn's knowledge topic counts only when it is one of the business's own topics (the same
          // grounding the compiler answers from) and the asks don't already carry it.
          const kt = t.understood.knowledgeTopic;
          if (kt && topics.has(kt) && !asks.some((a) => a.topic === kt)) asks.push({ kind: "question", status: "answered", topic: kt });
          return { id: t.id, at: t.at, asks };
        }),
        cartAdds: readLedger(c)
          .filter((e) => (e.effect === "cart.line_added" || e.effect === "cart.line_replaced") && e.status === "effected" && typeof e.terms.item === "string")
          .map((e) => ({ at: e.at, product: productOf(String(e.terms.item)), seq: e.seq })),
      })),
    orders: orders.map((o) => ({ id: o.id, conversationId: o.conversationId, createdAt: o.createdAt, simulated: simulatedConv.has(o.conversationId) })),
    opportunities: ws.opportunities.items,
    activeWorkflows: opViews.filter((o) => o.derivedState === "running" || o.derivedState === "waiting_on_customers" || o.derivedState === "proposed").map((o) => o.workflow),
    costEvidence: costs,
    simulatedSystems: ws.health.systems.filter((x) => x.state === "simulated").map((x) => x.domain),
  };
}

// ── verify ───────────────────────────────────────────────────────────────────────────────────────

/** Re-derive the claim from its references. Anything that doesn't check out is rejected, never softened. */
export function verifyCandidate(c: Candidate, s: Snapshot): { ok: true } | { ok: false; reason: string } {
  if (c.impact.type === "evidence_needed") return c.evidence.length === 0 && !c.impact.amount ? { ok: true } : { ok: false, reason: "an evidence-needed note can't carry figures" };
  if (!c.evidence.length) return { ok: false, reason: "no evidence" };
  const known: Record<string, Set<string>> = {
    conversation: new Set(s.conversations.map((x) => x.id)),
    turn: new Set(s.conversations.flatMap((x) => x.turns.map((t) => t.id))),
    approval: new Set(s.approvals.map((a) => a.id)),
    obligation: new Set(s.obligations.map((o) => o.key)),
    payment: new Set(s.opportunities.map((o) => o.id)),
    order: new Set(s.orders.map((o) => o.id)),
    cost_record: new Set(s.costEvidence.filter((e) => e.businessId === s.businessId && e.verified).map((e) => e.id)),
    operation: new Set<string>(),
  };
  for (const r of c.evidence) if (!known[r.kind]?.has(r.id)) return { ok: false, reason: `evidence ${r.kind} ${r.id} is not a record of this business` };
  const counted = new Set(c.evidence.filter((r) => r.kind === c.counts).map((r) => r.id)).size;
  if (counted !== c.metric.count) return { ok: false, reason: `stated ${c.metric.count}, records show ${counted}` };
  if (c.metric.amount && Object.keys(c.metric.amount).length) {
    if (!c.amountFrom) return { ok: false, reason: "an amount without its source records" };
    const refs = new Set(c.evidence.filter((r) => r.kind === c.amountFrom).map((r) => r.id));
    const real = (id: string) =>
      c.amountFrom === "obligation" ? s.obligations.some((o) => o.key === id && !o.simulated && !s.simulatedSystems.includes(o.kind === "unpaid_payment_followup" ? "payments" : "commerce")) : c.amountFrom === "payment" ? s.opportunities.some((o) => o.id === id && !o.simulated) : c.amountFrom === "cost_record" ? s.costEvidence.some((e) => e.id === id && e.verified) : false;
    if (![...refs].some(real)) return { ok: false, reason: "money only from test or unverified records" };
  }
  // Research boundary: an external (public / benchmark) claim never carries a business money figure.
  if (c.external?.length && c.impact.amount) return { ok: false, reason: "an external claim can't carry a business figure" };
  return { ok: true };
}

// ── rank (internal; the owner sees words, never this number) ─────────────────────────────────────

export function score(c: Pick<Initiative, "importance" | "confidence" | "metric" | "canAct" | "alreadyHandled" | "impact" | "testData">, ctx: { recentDismissalsInCategory: number }): number {
  const money = Object.values(c.metric.amount ?? {}).reduce((s, v) => s + v, 0);
  let x = { high: 60, medium: 35, low: 15 }[c.importance] + { high: 15, medium: 8, low: 0 }[c.confidence];
  x += Math.min(15, Math.log2(1 + c.metric.count) * 4);
  x += money > 0 ? Math.min(20, Math.log10(1 + money) * 5) : 0;
  if (c.canAct) x += 8;
  if (c.alreadyHandled) x -= 40;
  if (c.testData) x -= 10;
  x -= ctx.recentDismissalsInCategory * 12;
  return Math.round(x * 10) / 10;
}

export const fingerprintOf = (businessId: string, c: Pick<Candidate, "category" | "detector" | "subject">) => crypto.createHash("sha1").update(`${businessId}|${c.category}|${c.detector}|${c.subject}`).digest("hex").slice(0, 20);

// ── scan ─────────────────────────────────────────────────────────────────────────────────────────

export async function runInitiativeScan(graph: BusinessGraph, opts: { now?: Date; trigger?: ScanRecord["trigger"]; force?: boolean } = {}): Promise<{ scan: ScanRecord; initiatives: InitiativeView[] }> {
  const now = opts.now ?? new Date();
  const businessId = graph.business.id;
  const localDate = day(graph.business.timezone, now);
  const scan: ScanRecord = { id: `scan_${crypto.randomBytes(6).toString("hex")}`, businessId, at: now.toISOString(), localDate, trigger: opts.trigger ?? "manual", candidates: 0, verified: 0, rejected: [], created: 0, updated: 0, surfaced: 0, suppressed: 0, resolved: 0 };
  const today = (await listScans(businessId)).filter((x) => x.localDate === localDate && !x.skipped);
  if (today.length >= SCANS_PER_DAY && !opts.force) {
    scan.skipped = `scan limit reached (${SCANS_PER_DAY} per day)`;
    await saveScan(scan);
    return { scan, initiatives: (await listInitiatives(businessId)).map(toView) };
  }

  const s = await buildSnapshot(graph, now);
  const existing = await listInitiatives(businessId);
  await measure(existing, graph, now);
  const candidates = DETECTORS.flatMap((d) => d.run(s));
  scan.candidates = candidates.length;
  const verified: Candidate[] = [];
  for (const c of candidates) {
    const v = verifyCandidate(c, s);
    if (v.ok) verified.push(c);
    else scan.rejected.push({ detector: c.detector, reason: v.reason });
  }
  scan.verified = verified.length;

  const at = now.toISOString();
  const seen = new Set<string>();
  const dismissalsIn = (category: string) => existing.filter((i) => i.category === category && i.dismissal && Date.parse(i.dismissal.at) > now.getTime() - 30 * 24 * 3600_000).length;
  const touched: Initiative[] = [];
  for (const c of verified) {
    const fp = fingerprintOf(businessId, c);
    seen.add(fp);
    const prior = existing.find((i) => i.fingerprint === fp);
    const content = {
      category: c.category, detector: c.detector, subject: c.subject, title: c.title, observation: c.observation, basis: c.basis, evidence: c.evidence, metric: c.metric,
      confidence: c.confidence, importance: c.importance, impact: c.impact, recommendation: c.recommendation, entitlement: c.entitlement, authority: c.authority, canAct: c.canAct, ownerActionNeeded: c.ownerActionNeeded,
      ...(c.requiredFeature ? { requiredFeature: c.requiredFeature } : {}), alreadyHandled: Boolean(c.alreadyHandled), testData: Boolean(c.testData), ...(c.external ? { external: c.external } : {}),
      provenance: { scanId: scan.id, detectedAt: at, window: c.window, localDate, timezone: graph.business.timezone },
    };
    const rank = score({ ...c, alreadyHandled: Boolean(c.alreadyHandled), testData: Boolean(c.testData) }, { recentDismissalsInCategory: dismissalsIn(c.category) });
    if (!prior) {
      const i: Initiative = { id: `ini_${crypto.randomBytes(6).toString("hex")}`, businessId, ...content, fingerprint: fp, state: "verified", rank, firstSeenAt: at, lastSeenAt: at, scans: 1 };
      touched.push(i);
      scan.created += 1;
      continue;
    }
    // Same idea again: update it in place — never a duplicate.
    let state = prior.state;
    if (prior.state === "dismissed") {
      const quiet = prior.dismissal && now.getTime() - Date.parse(prior.dismissal.at) < DISMISS_QUIET_DAYS * 24 * 3600_000;
      if (prior.dismissal && materiallyNew(prior.dismissal.metric, c.metric) && !quiet) state = "verified";
      else {
        scan.suppressed += 1;
        touched.push({ ...prior, lastSeenAt: at, scans: prior.scans + 1 });
        continue;
      }
    } else if (prior.state === "snoozed") {
      if (prior.snoozedUntil && Date.parse(prior.snoozedUntil) > now.getTime()) {
        scan.suppressed += 1;
        touched.push({ ...prior, lastSeenAt: at, scans: prior.scans + 1 });
        continue;
      }
      state = "verified";
    } else if (prior.state === "resolved" || prior.state === "invalidated" || prior.state === "measured") state = "verified";
    touched.push({ ...prior, ...content, state, rank, lastSeenAt: at, scans: prior.scans + 1 });
    scan.updated += 1;
  }
  // Open ideas whose evidence went away on their own: resolved (not deleted — measurement keeps them).
  for (const i of existing) {
    if (seen.has(i.fingerprint) || !isOpenInitiative(i)) continue;
    touched.push({ ...i, state: "resolved", resolvedAt: at });
    scan.resolved += 1;
  }
  // Surface: few at a time, few per day, best first; already-handled never jumps the queue.
  const all = new Map(existing.map((i) => [i.id, i]));
  for (const t of touched) all.set(t.id, t);
  const surfacedNow = [...all.values()].filter((i) => i.state === "surfaced" || i.state === "reviewed" || i.state === "accepted").length;
  const surfacedToday = [...all.values()].filter((i) => i.surfacedAt && day(graph.business.timezone, new Date(i.surfacedAt)) === localDate).length;
  let room = Math.max(0, Math.min(SURFACED_AT_ONCE - surfacedNow, SURFACE_PER_DAY - surfacedToday));
  for (const i of [...all.values()].filter((x) => x.state === "verified" && !x.alreadyHandled).sort((a, b) => b.rank - a.rank)) {
    if (room <= 0) break;
    const t = { ...i, state: "surfaced" as const, surfacedAt: at };
    all.set(i.id, t);
    if (!touched.some((x) => x.id === t.id)) touched.push(t);
    else touched.splice(touched.findIndex((x) => x.id === t.id), 1, t);
    scan.surfaced += 1;
    room -= 1;
  }
  for (const t of touched) await save(t);
  await saveScan(scan);
  return { scan, initiatives: (await listInitiatives(businessId)).map(toView) };
}

// ── owner actions ────────────────────────────────────────────────────────────────────────────────

export type InitiativeAction = { kind: "review" } | { kind: "accept" } | { kind: "dismiss" } | { kind: "snooze"; days: number } | { kind: "invalid"; reason: string } | { kind: "acting"; commandId: string; operationId?: string };

export async function applyInitiativeAction(businessId: string, id: string, action: InitiativeAction, now = new Date()): Promise<Initiative | undefined> {
  const i = (await listInitiatives(businessId)).find((x) => x.id === id);
  if (!i) return undefined;
  const at = now.toISOString();
  switch (action.kind) {
    case "review":
      if (i.state === "surfaced") Object.assign(i, { state: "reviewed", reviewedAt: at });
      break;
    case "accept":
      Object.assign(i, { state: "accepted", decidedAt: at });
      break;
    case "dismiss":
      Object.assign(i, { state: "dismissed", decidedAt: at, dismissal: { at, metric: i.metric } });
      break;
    case "snooze":
      Object.assign(i, { state: "snoozed", decidedAt: at, snoozedUntil: new Date(now.getTime() + Math.min(Math.max(action.days, 1), 30) * 24 * 3600_000).toISOString() });
      break;
    case "invalid":
      Object.assign(i, { state: "invalidated", invalidated: { at, reason: action.reason.slice(0, 200) } });
      break;
    case "acting":
      Object.assign(i, { state: "acting", decidedAt: i.decidedAt ?? at, result: { ...(i.result ?? {}), commandId: action.commandId, ...(action.operationId ? { operationId: action.operationId } : {}), startedAt: at } });
      break;
  }
  await save(i);
  return i;
}

/**
 * "Do this": the initiative's recommended command runs through the SAME owner command service as the
 * command bar and WhatsApp (plan → authority → grounding → bounded execution → verification →
 * idempotency). An initiative is never permission; if BARRY can't act on it, nothing runs.
 */
export async function actOnInitiative(graph: BusinessGraph, id: string, requestId: string, lang: OwnerLang = "en"): Promise<{ ok: true; reply: OwnerReply } | { ok: false; reason: string }> {
  const businessId = graph.business.id;
  const i = (await listInitiatives(businessId)).find((x) => x.id === id);
  if (!i) return { ok: false, reason: "not_found" };
  const a = i.recommendation.action;
  if (!i.canAct || a?.kind !== "command" || !isOpenInitiative(i)) return { ok: false, reason: "BARRY can't do this one for you — the recommendation says who does." };
  const at = new Date().toISOString();
  const result = await executeOwnerCommand({ graph, source: "web", actor: { kind: "web" }, key: `initiative:${id}:${requestId}`, text: a.command, lang, trace: [{ step: "identity", outcome: "ok", detail: `signed-in owner session · from initiative ${id}`, at }] });
  if (result.reply.operation && !result.duplicate) await applyInitiativeAction(businessId, id, { kind: "acting", commandId: result.record.id, operationId: result.reply.operation.id });
  return { ok: true, reply: result.reply };
}

// ── measure: results read back from records (verified value only) ───────────────────────────────

async function measure(list: Initiative[], graph: BusinessGraph, now: Date): Promise<void> {
  const acting = list.filter((i) => i.state === "acting" && i.result?.operationId);
  if (!acting.length) return;
  const ws = await getOwnerWorkspace(graph, { now });
  const conversations = await getConversationStore().listByBusiness(graph.business.id);
  const ops = await listOperations(graph.business.id);
  for (const i of acting) {
    const op = ops.find((o) => o.id === i.result!.operationId);
    if (!op) continue;
    const v = operationView(op, ws.obligations, conversations);
    const done = v.derivedState === "completed" || v.derivedState === "stopped" || v.derivedState === "failed" || v.derivedState === "blocked";
    i.result = { ...i.result, verifiedValue: v.progress.recovered, note: `${v.progress.contacted} contacted · ${v.progress.purchased} purchased` };
    if (done) Object.assign(i, { state: "measured", result: { ...i.result, measuredAt: now.toISOString() } });
    await save(i);
  }
}

// ── quality metrics ──────────────────────────────────────────────────────────────────────────────

export type InitiativeMetrics = { scans: number; scansSkipped: number; candidates: number; verified: number; rejected: number; surfaced: number; reviewed: number; accepted: number; dismissed: number; snoozed: number; actionsStarted: number; actionsCompleted: number; verifiedValue: Money; verifiedSavings: Money; invalidated: number; resolved: number; repeatedDismissals: number; suppressed: number };

export async function initiativeMetrics(businessId: string): Promise<InitiativeMetrics> {
  const [list, scans] = await Promise.all([listInitiatives(businessId), listScans(businessId)]);
  const value: Money = {};
  for (const i of list) for (const [c, v] of Object.entries(i.result?.verifiedValue ?? {})) value[c] = Math.round(((value[c] ?? 0) + v) * 100) / 100;
  const dismissedByCategory = new Map<string, number>();
  for (const i of list) if (i.dismissal) dismissedByCategory.set(i.category, (dismissedByCategory.get(i.category) ?? 0) + 1);
  const ran = scans.filter((x) => !x.skipped);
  return {
    scans: ran.length,
    scansSkipped: scans.length - ran.length,
    candidates: ran.reduce((s, x) => s + x.candidates, 0),
    verified: ran.reduce((s, x) => s + x.verified, 0),
    rejected: ran.reduce((s, x) => s + x.rejected.length, 0),
    surfaced: list.filter((i) => i.surfacedAt).length,
    reviewed: list.filter((i) => i.reviewedAt).length,
    accepted: list.filter((i) => i.state === "accepted" || i.state === "acting" || i.state === "measured").length,
    dismissed: list.filter((i) => i.state === "dismissed").length,
    snoozed: list.filter((i) => i.state === "snoozed").length,
    actionsStarted: list.filter((i) => i.result?.startedAt).length,
    actionsCompleted: list.filter((i) => i.result?.measuredAt).length,
    verifiedValue: value,
    // Savings are realised only by a later verified cost record; V1 never claims one.
    verifiedSavings: {},
    invalidated: list.filter((i) => i.state === "invalidated").length,
    resolved: list.filter((i) => i.state === "resolved").length,
    repeatedDismissals: [...dismissedByCategory.values()].filter((n) => n >= 2).length,
    suppressed: ran.reduce((s, x) => s + x.suppressed, 0),
  };
}
