import type { BusinessGraph } from "@/lib/business-graph";
import { getFleet, type BusinessStatus, type Fleet } from "@/lib/hq/fleet";
import { getBusinessStatus } from "@/lib/hq/fleet";
import { listProposals, type ChangeProposal } from "@/lib/hq/proposals";
import { CONTROL_ACTIONS, describeChange } from "@/lib/hq/controls";
import { currentAssignment } from "@/lib/hq/runtime-assignment";
import { currentRelease, type ReleaseState } from "@/lib/release/manifest";
import { commercialStage, listCommercialAccounts, STAGE_WORDS, type CommercialAccount, type CommercialStage } from "@/lib/commercial/account";
import { getCommercialBusiness } from "@/lib/commercial/service";
import { listInitiatives } from "@/lib/initiative/store";
import { isOpenInitiative, type Initiative } from "@/lib/initiative/model";
import { hasMoney, moneyWords } from "@/lib/format/money";
import { isDemoBusiness } from "@/lib/fixtures";
import type { Money } from "@/lib/owner/revenue";

/**
 * FOUNDER READ MODEL — the grounded facts Founder BARRY answers from. Everything here is derived from the
 * existing HQ read models (fleet status, incidents, controls, obligations), commercial records, persisted
 * initiatives, proposals and the release manifest. Nothing is estimated, scored or invented: when a source
 * can't be read it is named as unavailable, never zeroed.
 *
 * CANONICAL HEALTH (one vocabulary, every state explained by its reasons — no percentages):
 *   paused · degraded · blocked · needs_attention · onboarding · not_enough_evidence · healthy
 */

export type FounderHealthState = "paused" | "degraded" | "blocked" | "needs_attention" | "onboarding" | "not_enough_evidence" | "healthy";

export const HEALTH_WORDS: Record<FounderHealthState, string> = {
  paused: "paused",
  degraded: "degraded",
  blocked: "blocked",
  needs_attention: "needs attention",
  onboarding: "onboarding",
  not_enough_evidence: "not enough evidence",
  healthy: "healthy",
};

/** The state as a predicate: "Rina Studio needs attention", "Acme is paused". */
export const HEALTH_PHRASE: Record<FounderHealthState, string> = {
  paused: "is paused",
  degraded: "is degraded",
  blocked: "is blocked",
  needs_attention: "needs attention",
  onboarding: "is onboarding",
  not_enough_evidence: "doesn't have enough evidence yet",
  healthy: "is healthy",
};

export type FounderHealth = { state: FounderHealthState; words: string; reasons: string[] };

/** Incident kinds that mean a provider / integration / model is not working (→ degraded). */
const DEGRADING = new Set(["ai_unavailable", "ai_degraded", "connection_unhealthy", "undelivered_reply"]);
const ONBOARDING_STAGES: CommercialStage[] = ["plan_selected", "setup_quoted", "setup_settled"];

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : w.endsWith("s") ? "es" : "s"}`;

/** The canonical health of one business, with the record-backed reasons for it. Pure. */
export function founderHealth(b: BusinessStatus, extra: { commercialStage?: CommercialStage | null } = {}): FounderHealth {
  const open = b.incidents.open;
  const degrading = open.filter((i) => DEGRADING.has(i.kind));
  const highOther = open.filter((i) => i.severity === "high" && !DEGRADING.has(i.kind));
  const mediumOther = open.filter((i) => i.severity === "medium" && !DEGRADING.has(i.kind));
  const make = (state: FounderHealthState, reasons: string[]): FounderHealth => ({ state, words: HEALTH_WORDS[state], reasons: reasons.filter(Boolean) });
  if (b.controls.pausedBusiness) return make("paused", [`Paused by ${b.controls.updatedBy ?? "the founder"}${b.controls.updatedAt ? ` at ${b.controls.updatedAt}` : ""}${b.controls.reason ? ` — ${b.controls.reason}` : ""}.`]);
  if (degrading.length || b.model.status === "unavailable") {
    return make("degraded", [...degrading.map((i) => `${i.title} (${i.severity}).`), b.model.status === "unavailable" && !degrading.some((i) => i.kind === "ai_unavailable") ? `AI unavailable: ${b.model.summary}` : ""]);
  }
  if (highOther.length || b.approvalsHeld || b.obligations.blocked) {
    return make("blocked", [...highOther.map((i) => `${i.title} (high).`), b.approvalsHeld ? `${plural(b.approvalsHeld, "request")} held for the owner to re-check.` : "", b.obligations.blocked ? `${plural(b.obligations.blocked, "follow-up")} blocked by a missing capability.` : ""]);
  }
  const attention = [
    ...mediumOther.map((i) => `${i.title} (medium).`),
    b.interventions ? `${plural(b.interventions, "conversation")} waiting on the owner.` : "",
    hasMoney(b.money.stuckWithOwner) ? `${moneyWords(b.money.stuckWithOwner)} waits on an owner decision.` : "",
    hasMoney(b.money.atRisk) ? `${moneyWords(b.money.atRisk)} at risk.` : "",
  ].filter(Boolean);
  if (attention.length) return make("needs_attention", attention);
  if (extra.commercialStage && ONBOARDING_STAGES.includes(extra.commercialStage)) return make("onboarding", [`Commercial stage: ${STAGE_WORDS[extra.commercialStage]}.`]);
  if (b.unavailable.length) return make("not_enough_evidence", [`Couldn't read: ${b.unavailable.join(", ")}.`]);
  if (b.conversations.total === 0) return make("not_enough_evidence", ["No conversations yet — nothing to judge health on."]);
  return make("healthy", [`No open incidents above low, nothing waiting on the owner; ${b.conversations.last24h ? `${plural(b.conversations.last24h, "customer conversation")} in the last 24 hours` : "no customer conversations in the last 24 hours"}.${b.controls.safeMode ? " Safe mode is on." : ""}`]);
}

// ── Fleet view ──────────────────────────────────────────────────────────────────────────────────

export type FleetBusinessView = BusinessStatus & { founderHealth: FounderHealth; account: CommercialAccount | null; commercialStage: CommercialStage; openInitiatives: Pick<Initiative, "id" | "title" | "importance" | "category" | "state" | "firstSeenAt">[]; /** A demo / simulated tenant (canonical demo registry) — kept out of the daily brief. */ demo: boolean };

export type FounderFleetView = {
  at: string;
  fleet: Fleet;
  businesses: FleetBusinessView[];
  proposals: ChangeProposal[];
  release: ReleaseState | null;
  unavailable: string[];
};

export async function loadFounderFleet(opts: { now?: Date; fleet?: Fleet } = {}): Promise<FounderFleetView> {
  const now = opts.now ?? new Date();
  const unavailable: string[] = [];
  const safe = async <T,>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      unavailable.push(label);
      return fallback;
    }
  };
  const fleet = opts.fleet ?? (await getFleet({ now }));
  const [accounts, proposals, release] = await Promise.all([safe("commercial accounts", () => listCommercialAccounts(), [] as CommercialAccount[]), safe("proposals", () => listProposals(), [] as ChangeProposal[]), safe("release", () => currentRelease(), null)]);
  const businesses = await Promise.all(
    fleet.businesses.map(async (b) => {
      const account = accounts.find((a) => a.businessId === b.id) ?? null;
      const stage = commercialStage(account, now);
      const initiatives = await safe(`initiatives (${b.name})`, () => listInitiatives(b.id), [] as Initiative[]);
      const openInitiatives = initiatives.filter(isOpenInitiative).map((i) => ({ id: i.id, title: i.title, importance: i.importance, category: i.category, state: i.state, firstSeenAt: i.firstSeenAt }));
      return { ...b, founderHealth: founderHealth(b, { commercialStage: account ? stage : null }), account, commercialStage: stage, openInitiatives, demo: isDemoBusiness(b.id) };
    })
  );
  return { at: now.toISOString(), fleet, businesses, proposals, release, unavailable };
}

// ── The Founder Brief ───────────────────────────────────────────────────────────────────────────

export type BriefSeverity = "high" | "medium" | "low";
export type BriefItem = { key: string; severity: BriefSeverity; kind: "health" | "commercial" | "initiative" | "proposal" | "release"; businessId?: string; businessName?: string; title: string; why: string; move: string; href: string };
/** One business's brief items told as ONE short paragraph (the facts are the items' own words — nothing added). */
export type BriefStory = { businessId: string; businessName: string; severity: BriefSeverity; text: string };
export type FounderBrief = { at: string; headline: string; quiet: boolean; items: BriefItem[]; stories: BriefStory[]; fleetNotes: string[]; healthy: string[]; counts: Record<FounderHealthState, number>; unavailable: string[]; /** Demo / simulated tenants left out of the daily brief (still visible elsewhere and when asked about). */ excludedDemo: string[] };

const SEV: Record<BriefSeverity, number> = { high: 0, medium: 1, low: 2 };
const bizHref = (id: string, view?: string) => `/hq/${encodeURIComponent(id)}${view ? `?view=${view}` : ""}`;

/**
 * "What do I need to know?" — deterministic: only meaningful, record-backed items, ranked by severity.
 * A healthy fleet produces NO items (quiet); nothing is manufactured to fill the brief.
 */
export function founderBrief(view: FounderFleetView, opts: { limit?: number } = {}): FounderBrief {
  const items: BriefItem[] = [];
  // The daily brief is about REAL businesses: demo / simulated tenants stay visible in HQ and when asked about.
  const real = view.businesses.filter((b) => !b.demo);
  for (const b of real) {
    const h = b.founderHealth;
    if (h.state === "degraded" || h.state === "blocked") items.push({ key: `health:${b.id}`, severity: "high", kind: "health", businessId: b.id, businessName: b.name, title: `${b.name} ${HEALTH_PHRASE[h.state]}`, why: h.reasons.join(" "), move: h.state === "degraded" ? "Open the incident; consider safe mode or pausing the capability until the provider is healthy." : "Open the business; the owner or the BARRY team has a move.", href: bizHref(b.id, "attention") });
    else if (h.state === "needs_attention") items.push({ key: `health:${b.id}`, severity: "medium", kind: "health", businessId: b.id, businessName: b.name, title: `${b.name} needs attention`, why: h.reasons.join(" "), move: "See whose move it is.", href: bizHref(b.id, "attention") });
    else if (h.state === "paused") items.push({ key: `health:${b.id}`, severity: "low", kind: "health", businessId: b.id, businessName: b.name, title: `${b.name} is still paused`, why: h.reasons.join(" "), move: `Say "Resume ${b.name}" when it should run again.`, href: bizHref(b.id, "controls") });
    if (b.account) {
      if (b.commercialStage === "awaiting_recurring") items.push({ key: `commercial:${b.id}:recurring`, severity: "high", kind: "commercial", businessId: b.id, businessName: b.name, title: `${b.name}: free month is over`, why: `Recurring start isn't confirmed (${STAGE_WORDS[b.commercialStage]}).`, move: "Confirm the recurring start, or record a pause / cancellation, in Commercial.", href: `/hq/commercial` });
      else if (b.commercialStage === "free_month_ending") items.push({ key: `commercial:${b.id}:ending`, severity: "medium", kind: "commercial", businessId: b.id, businessName: b.name, title: `${b.name}: free month ending`, why: STAGE_WORDS[b.commercialStage], move: "Review the trial summary with the owner.", href: `/hq/commercial` });
    }
    const high = b.openInitiatives.filter((i) => i.importance === "high");
    if (high.length) items.push({ key: `initiative:${b.id}`, severity: "low", kind: "initiative", businessId: b.id, businessName: b.name, title: `BARRY noticed ${plural(high.length, "thing")} worth acting on at ${b.name}`, why: high.slice(0, 2).map((i) => i.title).join("; "), move: "The owner sees these on Today; nothing is done without them.", href: bizHref(b.id) });
  }
  const pending = view.proposals.filter((p) => p.status === "proposed");
  if (pending.length) items.push({ key: "proposals", severity: "medium", kind: "proposal", title: `${plural(pending.length, "proposal")} wait${pending.length === 1 ? "s" : ""} for your decision`, why: pending.slice(0, 3).map((p) => p.instruction).join("; "), move: "Approve or reject in Proposals; nothing activates without you.", href: "/hq/proposals" });
  if (view.release?.manifest.knownBlockers.length) items.push({ key: "release", severity: "high", kind: "release", title: "The release candidate has known blockers", why: view.release.manifest.knownBlockers.join("; "), move: "Open Releases.", href: "/hq/releases" });
  items.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const limit = opts.limit ?? 6;
  const counts = Object.fromEntries((Object.keys(HEALTH_WORDS) as FounderHealthState[]).map((s) => [s, real.filter((b) => b.founderHealth.state === s).length])) as Record<FounderHealthState, number>;
  const top = items.slice(0, limit);
  const quiet = top.length === 0;
  const n = real.length;
  const stories = briefStories(top);
  const fleetNotes = top.filter((i) => !i.businessId).map((i) => `${i.title}: ${i.why}`);
  const lead = stories[0];
  return {
    at: view.at,
    headline: quiet
      ? counts.healthy === 0 && counts.not_enough_evidence === n
        ? `Nothing needs you right now — none of the ${n} business${n === 1 ? "" : "es"} has enough activity yet to judge.`
        : `Nothing needs you right now. ${counts.healthy} of ${n} business${n === 1 ? "" : "es"} healthy${counts.not_enough_evidence ? `, ${counts.not_enough_evidence} without enough activity yet to judge` : ""}.`
      : lead ? `${lead.businessName} is the main thing to look at${stories.length > 1 ? `, then ${stories.slice(1, 3).map((s) => s.businessName).join(" and ")}` : ""}.` : top[0].title,
    quiet,
    items: top,
    stories,
    fleetNotes,
    healthy: real.filter((b) => b.founderHealth.state === "healthy").map((b) => b.name),
    counts,
    unavailable: [...view.unavailable, ...real.flatMap((b) => b.unavailable.map((u) => `${b.name}: ${u}`))],
    excludedDemo: view.businesses.filter((b) => b.demo).map((b) => b.name),
  };
}

const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "";
};

/**
 * Group the brief by business: one short paragraph per business, most important first, built ONLY from the items'
 * own facts (their reasons are the records' words). Separate records stay separate items underneath. Pure.
 */
export function briefStories(items: BriefItem[]): BriefStory[] {
  const order: string[] = [];
  const by = new Map<string, BriefItem[]>();
  for (const i of items) {
    if (!i.businessId) continue;
    if (!by.has(i.businessId)) order.push(i.businessId);
    by.set(i.businessId, [...(by.get(i.businessId) ?? []), i]);
  }
  return order.map((id, idx) => {
    const its = by.get(id)!;
    const name = its[0].businessName ?? id;
    const severity = its.reduce<BriefSeverity>((m, i) => (SEV[i.severity] < SEV[m] ? i.severity : m), "low");
    const health = its.find((i) => i.kind === "health");
    const commercial = its.filter((i) => i.kind === "commercial");
    const initiative = its.find((i) => i.kind === "initiative");
    const parts: string[] = [];
    const state = health ? health.title.slice(name.length).trim() : "";
    if (health) parts.push(idx === 0 && severity !== "low" ? `${name} is the main thing I'd look at first — it ${state.replace(/^is /, "is ")}.` : `${name} ${state}.`);
    else parts.push(`${name}:`);
    if (health?.why) parts.push(health.why.split(/(?<=\.)\s+/).map(sentence).join(" "));
    for (const c of commercial) parts.push(sentence(`${c.title.slice(name.length + 1).trim()} — ${c.why.replace(/\.$/, "")}`));
    if (initiative) parts.push(sentence(`BARRY also noticed: ${initiative.why}`));
    return { businessId: id, businessName: name, severity, text: parts.join(" ").replace(/\s+/g, " ").trim() };
  });
}

// ── Business drilldown ──────────────────────────────────────────────────────────────────────────

export type BusinessDrilldown = {
  id: string;
  name: string;
  health: FounderHealth;
  controls: { mode: string; paused: boolean; safeMode: boolean; pausedCapabilities: string[]; disabledChannels: string[] };
  doing: string[];
  waitingOn: string[];
  incidents: { key: string; title: string; severity: string; status: string; nextAction: string; since: string }[];
  interventions: number;
  initiatives: { title: string; importance: string; state: string }[];
  commercial: { stage: string; plan: string | null; price: string | null; alerts: string[] } | null;
  capabilities: string[];
  value: { made: string; savedRealized: string; handled: string; basis: string } | null;
  runtime: { version: string; commit: string | null; reasoner: string; composer: string; genome: string } | null;
  changed: string[];
  options: { action: string; title: string; effect: string; available: boolean; why?: string }[];
  unavailable: string[];
};

const moneyOr = (m: Money, none: string) => (hasMoney(m) ? moneyWords(m) : none);

export async function businessDrilldown(graph: BusinessGraph, opts: { now?: Date } = {}): Promise<BusinessDrilldown> {
  const now = opts.now ?? new Date();
  const unavailable: string[] = [];
  const safe = async <T,>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      unavailable.push(label);
      return fallback;
    }
  };
  // All four reads at once: on Preview the sequential version took ~16 s for one business — long enough for a
  // phone to drop the response (the live "Load failed").
  const [s, commercial, initiatives, runtime] = await Promise.all([getBusinessStatus(graph, { now, detail: true }), safe("commercial", () => getCommercialBusiness(graph, { now }), null), safe("initiatives", () => listInitiatives(graph.business.id), [] as Initiative[]), safe("runtime assignment", () => currentAssignment(graph, now), null)]);
  const health = founderHealth(s, { commercialStage: commercial?.account ? commercial.stage : null });
  const c = s.controls;
  const v = commercial?.value ?? null;
  const made: Money = { ...(v?.made.generated ?? {}) };
  for (const [cur, n] of Object.entries(v?.made.recovered ?? {})) made[cur] = Math.round(((made[cur] ?? 0) + n) * 100) / 100;
  return {
    id: s.id,
    name: s.name,
    health,
    controls: { mode: c.mode, paused: c.pausedBusiness, safeMode: c.safeMode, pausedCapabilities: c.pausedCapabilities, disabledChannels: c.disabledChannels },
    doing: [
      s.conversations.last24h ? `${plural(s.conversations.last24h, "conversation")} active in the last 24h` : "No customer conversations in the last 24 hours",
      s.obligations.barryCanAct ? `${plural(s.obligations.barryCanAct, "follow-up")} BARRY can act on` : "",
      s.obligations.waitingOnCustomer ? `${plural(s.obligations.waitingOnCustomer, "follow-up")} waiting on customers` : "",
    ].filter(Boolean),
    waitingOn: [
      s.interventions ? `the owner on ${plural(s.interventions, "conversation")}` : "",
      s.approvalsHeld ? `the owner to re-check ${plural(s.approvalsHeld, "held request")}` : "",
      s.obligations.blocked ? `a capability for ${plural(s.obligations.blocked, "follow-up")}` : "",
      hasMoney(s.money.stuckWithOwner) ? `an owner decision on ${moneyWords(s.money.stuckWithOwner)}` : "",
    ].filter(Boolean),
    incidents: s.incidents.open.map((i) => ({ key: i.key, title: i.title, severity: i.severity, status: i.status, nextAction: i.nextAction, since: i.firstSeen })),
    interventions: s.interventions,
    initiatives: initiatives.filter(isOpenInitiative).slice(0, 5).map((i) => ({ title: i.title, importance: i.importance, state: i.state })),
    commercial: commercial?.account ? { stage: commercial.stageWords, plan: commercial.account.plan, price: commercial.effectivePrice !== null ? `${commercial.effectivePrice} ${commercial.account.currency}/month` : null, alerts: commercial.alerts.map((a) => a.title) } : commercial ? { stage: commercial.stageWords, plan: null, price: null, alerts: [] } : null,
    capabilities: [`commerce: ${s.providers.commerce}`, `payments: ${s.providers.payments}`, `scheduling: ${s.providers.scheduling}`, `customer channel: ${s.customerChannel.replace(/_/g, " ")}`, ...(c.pausedCapabilities.length ? [`paused: ${c.pausedCapabilities.join(", ")}`] : []), ...(c.disabledChannels.length ? [`channels off: ${c.disabledChannels.join(", ")}`] : [])],
    value: v ? { made: moneyOr(made, "none verified"), savedRealized: moneyOr(v.saved.realized, "none realized"), handled: `${plural(v.handled.conversations, "conversation")} handled with no human, ${plural(v.handled.outcomes, "verified outcome")}`, basis: `This period (${v.period.label}); provider-verified only, test money excluded${hasMoney(v.made.excludedSimulated) ? ` (${moneyWords(v.made.excludedSimulated)} simulated not counted)` : ""}.` } : null,
    runtime: runtime ? { version: runtime.runtime.version, commit: runtime.runtime.commit, reasoner: runtime.reasoner.model, composer: runtime.composer.model, genome: runtime.genomeRevision } : null,
    changed: [...s.audit.slice(0, 3).map((a) => `${a.at.slice(0, 16).replace("T", " ")} ${a.by}: ${describeChange(a)}`), ...s.activity.slice(0, 4).map((e) => `${e.at.slice(0, 16).replace("T", " ")} ${e.what}`)].slice(0, 6),
    options: [
      { action: c.pausedBusiness ? "resume_business" : "pause_business", title: c.pausedBusiness ? `Resume ${s.name}` : `Pause BARRY for ${s.name}`, effect: c.pausedBusiness ? "BARRY answers and acts again under the business's own rules." : CONTROL_ACTIONS.pause_business.effect, available: true },
      { action: c.safeMode ? "safe_mode_off" : "safe_mode_on", title: c.safeMode ? `Take ${s.name} out of safe mode` : `Put ${s.name} in safe mode`, effect: c.safeMode ? "Consequential actions follow the business's own rules again; proactive messages resume." : CONTROL_ACTIONS.safe_mode.effect, available: !c.pausedBusiness, ...(c.pausedBusiness ? { why: "The business is paused; resume it first." } : {}) },
      { action: "proposal", title: `Prepare a rollout / configuration proposal for ${s.name}`, effect: "A durable proposal for you to approve — nothing changes until then.", available: true },
    ],
    unavailable: [...s.unavailable, ...unavailable, ...(commercial?.unavailable ?? [])],
  };
}
