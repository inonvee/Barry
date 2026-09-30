import type { BusinessGraph } from "@/lib/business-graph";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { listBusinessSummaries } from "@/lib/fixtures";
import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState, type ConversationSummary, type TurnActivity, type TurnTrace } from "@/lib/state";
import { resolveCapabilityProfiles, type CapabilityProfiles } from "@/lib/capabilities";
import { describeBusinessConnections, type ConnectionView } from "@/lib/connections/status";
import { getLearningWorkspace } from "@/lib/learn-business/service";
import { buildOperatingStrategy } from "@/lib/learn-business/strategy";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import type { CapabilitySurfaceEntry } from "@/lib/reasoner/types";
import { buildDesignPartnerReadiness, type DesignPartnerSurface } from "./design-partner";
import { assessPilotReadiness, type PilotLevel } from "@/lib/owner/readiness";
import { getOwnerWorkspace } from "@/lib/owner/service";
import type { Money } from "@/lib/owner/revenue";

/**
 * BARRY HQ read model. Read-only: nothing here writes, and every query is
 * scoped to ONE business id through the store's tenant-scoped methods.
 * Readiness and the capability report come from getLearningWorkspace() —
 * the exact code the Learn Business and Connections pages use — so HQ can
 * never disagree with what the owner sees.
 *
 * A source that fails is reported as unavailable, never guessed or zeroed;
 * a metric BARRY does not record is reported as not tracked.
 */

export type Sourced<T> = { ok: true; value: T } | { ok: false; unavailable: string };

async function source<T>(name: string, load: () => Promise<T>): Promise<Sourced<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (err) {
    console.error(`[barry:hq] ${name} unavailable`, err instanceof Error ? err.message : err);
    return { ok: false, unavailable: `${name} unavailable` };
  }
}

type Workspace = Awaited<ReturnType<typeof getLearningWorkspace>>;

const RECENT_TURNS = 200;
const RECENT_CONVERSATIONS = 25;

export type RuntimeSummary = TurnTrace["runtime"] & { at: string };

export type TurnHealth = {
  sampled: number;
  failedSteps: number;
  understandingFailed: number;
  policyBlocked: number;
  contractFallbacks: number;
  groundingRejections: number;
  /** Generic capability calls BARRY planned, and how many were refused by authority or failed at the system. */
  capabilityCalls: number;
  capabilityRefused: number;
  capabilityFailed: number;
  /** Turns persisted before migration 0011 (no trace to inspect). */
  untraced: number;
};

function turnHealth(turns: TurnActivity[]): TurnHealth {
  const health: TurnHealth = { sampled: turns.length, failedSteps: 0, understandingFailed: 0, policyBlocked: 0, contractFallbacks: 0, groundingRejections: 0, capabilityCalls: 0, capabilityRefused: 0, capabilityFailed: 0, untraced: 0 };
  for (const t of turns) {
    if (t.intent === "understanding_failed") health.understandingFailed++;
    if (!t.trace) {
      health.untraced++;
      continue;
    }
    if (t.trace.steps.some((s) => s.result && !s.result.ok)) health.failedSteps++;
    if (t.trace.steps.some((s) => s.policy.status === "denied" || s.policy.status === "requires_approval")) health.policyBlocked++;
    if (t.trace.reply?.fallback) health.contractFallbacks++;
    if (t.trace.rejectedClaims.length > 0) health.groundingRejections++;
    for (const step of t.trace.steps) {
      if (!step.generic) continue;
      health.capabilityCalls++;
      if (step.generic.authority.status !== "allowed") health.capabilityRefused++;
      else if (!step.generic.executed || step.generic.code) health.capabilityFailed++;
    }
  }
  return health;
}

function latestRuntime(turns: TurnActivity[]): RuntimeSummary | null {
  const traced = turns.find((t) => t.trace);
  return traced?.trace ? { ...traced.trace.runtime, at: traced.at } : null;
}

type Mode = "real" | "simulated" | "mixed" | "none";
function providerMode(profiles: CapabilityProfiles): Mode {
  const used = Object.values(profiles).filter((p) => p.used && p.status === "connected");
  if (used.length === 0) return "none";
  const simulated = used.filter((p) => p.simulated).length;
  return simulated === 0 ? "real" : simulated === used.length ? "simulated" : "mixed";
}

async function operations(businessId: string) {
  const backend = getBackend();
  const [approvals, orders, bookings, payments] = await Promise.all([
    source("approvals", () => backend.listApprovals(businessId)),
    source("orders", () => backend.listCommerceOrders(businessId)),
    source("bookings", () => backend.listBookings(businessId)),
    source("payments", () => backend.listPaymentRequests(businessId)),
  ]);
  const count = <T,>(s: Sourced<T[]>, pred: (x: T) => boolean = () => true): number | null => (s.ok ? s.value.filter(pred).length : null);
  return {
    raw: { approvals, orders, bookings, payments },
    counts: {
      approvalsPending: count(approvals, (a) => a.status === "pending"),
      approvalsTotal: count(approvals),
      orders: count(orders),
      bookingsConfirmed: count(bookings, (b) => b.status === "confirmed"),
      paymentsPending: count(payments, (p) => p.status === "pending"),
      paymentsPaid: count(payments, (p) => p.status === "paid"),
      paymentsFailed: count(payments, (p) => p.status === "failed" || p.status === "cancelled"),
    },
  };
}

export type HqBusinessOverview = {
  id: string;
  name: string;
  locale: string;
  timezone: string;
  /** Same object the Learn Business workspace shows (getLearningWorkspace -> buildReadiness). */
  readiness: Sourced<Workspace["readiness"]>;
  capabilities: Sourced<Workspace["capabilityReport"]>;
  mode: Sourced<Mode>;
  connections: Sourced<ConnectionView[]>;
  conversations: Sourced<{ total: number }>;
  health: Sourced<TurnHealth>;
  runtime: Sourced<RuntimeSummary | null>;
  counts: Awaited<ReturnType<typeof operations>>["counts"];
  /** Paid-pilot readiness (the same assessment the owner's Train BARRY page shows). */
  pilot: Sourced<{ level: PilotLevel; label: string; nextBlockers: string[] }>;
  /** Last 7 days from the owner read model: verified revenue (per currency, simulated apart), AI health, who is waiting. */
  week: Sourced<{ collected: Money; simulated: Money; ai: { status: string; summary: string; lastFailure?: string }; needAttention: number; handoffsOpen: number; approvalsWaiting: number; lostOpportunities: number }>;
};

async function overviewFor(graph: BusinessGraph): Promise<HqBusinessOverview & { _profiles: Sourced<CapabilityProfiles>; _ops: Awaited<ReturnType<typeof operations>>; _activity: Sourced<TurnActivity[]> }> {
  const id = graph.business.id;
  const store = getConversationStore();
  const [workspace, profiles, summaries, activity, ops] = await Promise.all([
    source("readiness", () => getLearningWorkspace(graph)),
    source("capability profiles", () => resolveCapabilityProfiles(graph)),
    source("conversations", () => store.listSummariesByBusiness(id, RECENT_CONVERSATIONS)),
    source("turn activity", () => store.listRecentTurnActivity(id, RECENT_TURNS)),
    operations(id),
  ]);
  const connections = await source("connections", () => describeBusinessConnections(id, profiles.ok ? profiles.value : undefined));
  const [pilot, week] = await Promise.all([
    source("pilot readiness", async () => {
      const r = await assessPilotReadiness(graph);
      return { level: r.level, label: r.label, nextBlockers: r.next?.blockers.map((b) => `${b.label}: ${b.detail}`) ?? [] };
    }),
    source("owner view", async () => {
      const ws = await getOwnerWorkspace(graph, { since: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), label: "last 7 days" });
      const f = ws.health.ai.lastFailure;
      return {
        collected: ws.revenue.direct,
        simulated: ws.revenue.simulatedPaid,
        ai: { status: ws.health.ai.status, summary: ws.health.ai.summary, ...(f ? { lastFailure: `${f.kind}${f.status ? ` · HTTP ${f.status}` : ""}${f.code ? ` · ${f.code}` : ""}` } : {}) },
        needAttention: ws.today.needYou,
        handoffsOpen: ws.today.handoffsOpen,
        approvalsWaiting: ws.today.approvalsWaiting,
        lostOpportunities: ws.revenue.lostOpportunities,
      };
    }),
  ]);
  const map = <T, U>(s: Sourced<T>, f: (v: T) => U): Sourced<U> => (s.ok ? { ok: true, value: f(s.value) } : s);
  return {
    id,
    name: graph.business.name,
    locale: graph.business.locale,
    timezone: graph.business.timezone,
    readiness: map(workspace, (w) => w.readiness),
    capabilities: map(workspace, (w) => w.capabilityReport),
    mode: map(profiles, providerMode),
    connections,
    conversations: map(summaries, (s) => ({ total: s.total })),
    health: map(activity, turnHealth),
    runtime: map(activity, latestRuntime),
    counts: ops.counts,
    pilot,
    week,
    _profiles: profiles,
    _ops: ops,
    _activity: activity,
  };
}

function strip<T extends { _profiles: unknown; _ops: unknown; _activity: unknown }>(o: T): Omit<T, "_profiles" | "_ops" | "_activity"> {
  const { _profiles, _ops, _activity, ...rest } = o;
  void _profiles;
  void _ops;
  void _activity;
  return rest;
}

/** The businesses BARRY serves. Today the Genome registry is the code fixture set; there is no tenant table yet. */
export function listTenantIds(): string[] {
  return listBusinessSummaries().map((b) => b.id);
}

export async function getHqOverview(): Promise<{ genomeSource: string; businesses: HqBusinessOverview[] }> {
  const businesses = await Promise.all(listTenantIds().map(async (id) => strip(await overviewFor(resolveBusinessGraph(id)))));
  return { genomeSource: "code fixtures (src/lib/fixtures) — no tenant registry table yet", businesses };
}

/** Resolves a business id from a URL; unknown ids are not found (never another tenant). */
export function findTenant(businessId: string): BusinessGraph | undefined {
  if (!listTenantIds().includes(businessId)) return undefined;
  return resolveBusinessGraph(businessId);
}

export type HqBusinessDetail = HqBusinessOverview & {
  genome: {
    identity: { description: string; tone: unknown; operatingHours: unknown };
    goals: string[];
    playbook: BusinessGraph["playbook"];
    policies: { id: string; description: string; rule: unknown }[];
    authority: Sourced<{ discounts: string; refunds: string; escalation: string }>;
    facts: Sourced<{ key: string; value: string; classification: string; status: string; ownerVerified: boolean; confidence: string; provenance: string; correctedFrom: string | null; reviewedAt: string | null }[]>;
    enabledActions: string[];
  };
  recentConversations: Sourced<ConversationSummary[]>;
  recentTurns: Sourced<{ conversationId: string; at: string; intent: string | null; stop: string | null; actions: string[]; failed: boolean; fallback: boolean; capabilities: { capability: string; authority: string; ruleId: string | null; system: string | null; executed: boolean; verified: boolean; code: string | null }[] }[]>;
  /** What the model may propose for this business beyond the typed flows, and how each is governed. */
  capabilitySurface: Sourced<CapabilitySurfaceEntry[]>;
  authorityRules: BusinessGraph["authority"];
  approvals: Sourced<{ id: string; conversationId: string; requestedAction: string; reason: string; status: string; createdAt: string }[]>;
  orders: Sourced<{ orderId: string; conversationId: string; total: string; status: string; createdAt: string }[]>;
  payments: Sourced<{ id: string; conversationId: string; amount: string; status: string; provider: string | null; createdAt: string; verifiedAt: string | null }[]>;
  bookings: Sourced<{ id: string; conversationId: string; start: string; status: string; provider: string | null }[]>;
  designPartner: Sourced<DesignPartnerSurface[]>;
  notTracked: string[];
};

export async function getHqBusiness(businessId: string): Promise<HqBusinessDetail | undefined> {
  const graph = findTenant(businessId);
  if (!graph) return undefined;
  const o = await overviewFor(graph);
  const backend = getBackend();
  const [facts, connectionRecords, summaries] = await Promise.all([
    source("learned facts", () => backend.listLearnedFacts(businessId)),
    source("connection records", () => backend.listBusinessConnections(businessId)),
    source("conversations", () => getConversationStore().listSummariesByBusiness(businessId, RECENT_CONVERSATIONS)),
  ]);
  const { raw } = o._ops;
  const newestFirst = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);

  return {
    ...strip(o),
    genome: {
      identity: { description: graph.business.description, tone: graph.business.tone, operatingHours: graph.business.operatingHours },
      goals: graph.goals,
      playbook: graph.playbook,
      policies: graph.policies.map((p) => ({ id: p.id, description: p.description, rule: p.rule })),
      authority:
        facts.ok && connectionRecords.ok
          ? { ok: true, value: buildOperatingStrategy({ graph, facts: facts.value, connections: connectionRecords.value }).authority }
          : { ok: false, unavailable: "authority unavailable" },
      facts: facts.ok
        ? {
            ok: true,
            value: [...facts.value]
              .sort((a, b) => a.key.localeCompare(b.key))
              .map((f) => ({
                key: f.key,
                value: f.value,
                classification: f.classification,
                status: f.status,
                ownerVerified: f.ownerVerified,
                confidence: f.confidence,
                provenance: f.source.kind === "web" ? f.source.url : "owner",
                correctedFrom: f.correctedFrom ?? null,
                reviewedAt: f.reviewedAt ?? null,
              })),
          }
        : facts,
      enabledActions: graph.availableActions.filter((a) => a.enabled).map((a) => a.name),
    },
    recentConversations: summaries.ok ? { ok: true, value: summaries.value.conversations } : summaries,
    recentTurns: o._activity.ok
      ? {
          ok: true,
          value: o._activity.value.slice(0, 30).map((t) => ({
            conversationId: t.conversationId,
            at: t.at,
            intent: t.intent,
            stop: t.trace ? `${t.trace.stop.reason} (${t.trace.stop.outcome})` : null,
            actions: t.trace?.steps.map((s) => s.action) ?? [],
            failed: !!t.trace?.steps.some((s) => s.result && !s.result.ok),
            fallback: !!t.trace?.reply?.fallback,
            // Generic capability steps: what was planned, authority, system, outcome — no input values.
            capabilities: (t.trace?.steps ?? []).flatMap((st) =>
              st.generic
                ? [{ capability: st.generic.capability, authority: st.generic.authority.status, ruleId: st.generic.authority.ruleId ?? null, system: st.generic.system ?? null, executed: st.generic.executed, verified: st.generic.verified, code: st.generic.code ?? null }]
                : []
            ),
          })),
        }
      : o._activity,
    // Owner-facing summaries only: no requested inputs, customer details or payment links.
    approvals: raw.approvals.ok
      ? { ok: true, value: newestFirst(raw.approvals.value).map((a) => ({ id: a.id, conversationId: a.conversationId, requestedAction: a.requestedAction, reason: a.reason, status: a.status, createdAt: a.createdAt })) }
      : raw.approvals,
    orders: raw.orders.ok
      ? { ok: true, value: newestFirst(raw.orders.value).map((x) => ({ orderId: x.orderId, conversationId: x.conversationId, total: `${x.totalAmount} ${x.currency}`, status: x.status, createdAt: x.createdAt })) }
      : raw.orders,
    payments: raw.payments.ok
      ? {
          ok: true,
          value: newestFirst(raw.payments.value).map((p) => ({ id: p.id, conversationId: p.conversationId, amount: `${p.amount} ${p.currency}`, status: p.status, provider: p.provider ?? null, createdAt: p.createdAt, verifiedAt: p.verifiedAt ?? null })),
        }
      : raw.payments,
    bookings: raw.bookings.ok
      ? { ok: true, value: newestFirst(raw.bookings.value).map((b) => ({ id: b.id, conversationId: b.conversationId, start: b.start, status: b.status, provider: b.provider ?? null })) }
      : raw.bookings,
    designPartner: o._profiles.ok
      ? { ok: true, value: buildDesignPartnerReadiness({ profiles: o._profiles.value, payments: raw.payments.ok ? raw.payments.value : null }) }
      : { ok: false, unavailable: "design-partner readiness unavailable" },
    capabilitySurface: await source("capability surface", () => buildCapabilitySurface(graph)),
    authorityRules: graph.authority,
    notTracked: ["revenue / GMV over time", "customer satisfaction", "response latency per turn", "messaging channel delivery"],
  };
}

/**
 * One conversation's messages and per-turn traces — only when it belongs to
 * the business in the URL. A conversation id from another tenant is simply
 * not found.
 */
export async function getHqConversation(businessId: string, conversationId: string): Promise<{ business: { id: string; name: string }; conversation: ConversationState } | undefined> {
  const graph = findTenant(businessId);
  if (!graph) return undefined;
  const state = await getConversationStore().get(conversationId);
  if (!state || state.businessId !== businessId) return undefined;
  return { business: { id: businessId, name: graph.business.name }, conversation: state };
}
