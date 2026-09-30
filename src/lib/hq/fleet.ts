import type { BusinessGraph } from "@/lib/business-graph";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { listBusinessSummaries } from "@/lib/fixtures";
import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { resolveCapabilityProfiles, type CapabilityProfiles } from "@/lib/capabilities";
import { describeBusinessConnections, type ConnectionView } from "@/lib/connections/status";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { readHandoffs } from "@/lib/runtime/handoff";
import { buildInterventions, type Intervention } from "@/lib/owner/interventions";
import { revenueOpportunities } from "@/lib/owner/opportunities";
import { aiHealth, customerLabel, type AiHealth } from "@/lib/owner/service";
import { assessPilotReadiness, type PilotLevel } from "@/lib/owner/readiness";
import type { Money } from "@/lib/owner/revenue";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { whatsappConfig, whatsappNumbersFor } from "@/lib/channels/whatsapp";
import { runtimeCommit, BARRY_RUNTIME_VERSION } from "@/lib/runtime/version";
import { environmentLabel } from "@/lib/qa/mode";
import { deriveIncidents, loadIncidentStates, type Incident } from "./incidents";
import { loadControls, listControlAudit, type BusinessControls, type ControlAudit } from "./controls";
import { reconcileObligations, type Obligation } from "@/lib/operator/obligations";

/**
 * FLEET READ MODEL — the founder's view across every business, built from records with ONE query set
 * per business (its conversations, approvals, payments, bookings, orders, connections, controls and
 * incident/obligation records) — never a query per conversation, never a full owner workspace per
 * status dot. Exceptions first: who needs the founder, what broke, what changed, where money is blocked,
 * which businesses are not ready. Nothing here is inferred from a business's type or name.
 */

export type BusinessHealth = "healthy" | "attention" | "unhealthy";
export type OperatingStage = "simulator_only" | "supervised" | "live_ready";

export type BusinessStatus = {
  id: string;
  name: string;
  health: BusinessHealth;
  stage: OperatingStage;
  controls: BusinessControls;
  build: { commit: string | null; runtime: string; environment: string };
  model: { mode: "live_model" | "simulated"; model: string | null; status: AiHealth["status"]; summary: string; lastFailure?: AiHealth["lastFailure"] };
  storage: "durable" | "memory";
  channel: { whatsapp: "live" | "dry_run" | "not_routed" | "missing" };
  providers: { commerce: string; payments: string; scheduling: string };
  readiness: { level: PilotLevel; label: string; blockers: string[] };
  interventions: number;
  approvalsActive: number;
  approvalsHeld: number;
  handoffsOpen: number;
  incidents: { high: number; medium: number; low: number; open: Incident[] };
  obligations: { open: number; needsOwner: number; barryCanAct: number; waitingOnCustomer: number; blocked: number };
  money: { stuckWithOwner: Money; waitingOnCustomer: Money; atRisk: Money; simulated: Money };
  conversations: { total: number; last24h: number; latestActivityAt: string | null };
  /** Founder control changes in the last 24h. */
  recentChanges: ControlAudit[];
  /** Sources that could not be read (shown, never zeroed). */
  unavailable: string[];
};

export type FleetSummary = {
  businesses: number;
  healthy: number;
  needFounder: { id: string; name: string; why: string }[];
  broke: { id: string; name: string; incident: Incident }[];
  changed: { id: string; name: string; what: string; at: string }[];
  moneyBlocked: { id: string; name: string; stuckWithOwner: Money; atRisk: Money }[];
  notReady: { id: string; name: string; level: PilotLevel; blocker: string }[];
};

export type Fleet = { at: string; build: BusinessStatus["build"]; summary: FleetSummary; businesses: BusinessStatus[] };

export type BusinessStatusDetail = BusinessStatus & {
  interventionQueue: Intervention[];
  obligationList: Obligation[];
  audit: ControlAudit[];
};

const D = 24 * 3600_000;

export function fleetTenantIds(): string[] {
  return listBusinessSummaries().map((b) => b.id);
}

export function fleetTenant(businessId: string): BusinessGraph | undefined {
  return fleetTenantIds().includes(businessId) ? resolveBusinessGraph(businessId) : undefined;
}

function providerWords(profiles: CapabilityProfiles | undefined, domain: "commerce" | "payments" | "scheduling"): string {
  const p = profiles?.[domain];
  if (!p?.used) return "not used";
  if (p.status !== "connected") return "missing";
  return p.simulated ? `simulated (${p.provider ?? "mock"})` : `real (${p.provider})`;
}

export async function getBusinessStatus(graph: BusinessGraph, opts: { now?: Date; detail?: boolean } = {}): Promise<BusinessStatusDetail> {
  const now = opts.now ?? new Date();
  const id = graph.business.id;
  const backend = getBackend();
  const unavailable: string[] = [];
  const safe = async <T,>(name: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (err) {
      console.error(`[barry:fleet] ${name} unavailable`, err instanceof Error ? err.message : err);
      unavailable.push(name);
      return fallback;
    }
  };
  const [conversations, approvalsRaw, payments, bookings, orders, controls, incidentStates, profiles] = await Promise.all([
    safe("conversations", () => getConversationStore().listByBusiness(id), [] as ConversationState[]),
    safe("approvals", () => backend.listApprovals(id), []),
    safe("payments", () => backend.listPaymentRequests(id), []),
    safe("bookings", () => backend.listBookings(id), []),
    safe("orders", () => backend.listCommerceOrders(id), []),
    loadControls(id),
    safe("incident states", () => loadIncidentStates(id), []),
    safe("capability profiles", () => resolveCapabilityProfiles(graph), undefined),
  ]);
  const connections = await safe("connections", () => describeBusinessConnections(id, profiles), [] as ConnectionView[]);
  const approvals = withLifecycle(approvalsRaw, new Map(conversations.map((c) => [c.id, c])));
  const ai = aiHealth(conversations, now);
  const incidents = deriveIncidents({ graph, conversations, approvals, payments, connections, ai, now, states: incidentStates });
  const interventions = buildInterventions({ graph, conversations, approvals, payments, customerLabel, now });
  const opportunities = revenueOpportunities({ graph, conversations, approvals, payments, bookings, orders, customerLabel, now });
  const obligations = await safe("obligations", () => reconcileObligations({ graph, conversations, approvals, payments, bookings, now }), [] as Obligation[]);
  const readiness = await safe("readiness", () => assessPilotReadiness(graph, { conversations }), undefined);
  const audit = await safe("founder audit", () => listControlAudit(id), [] as ControlAudit[]);
  const open = incidents.filter((i) => i.status !== "resolved");
  const high = open.filter((i) => i.severity === "high").length;
  const medium = open.filter((i) => i.severity === "medium").length;
  const low = open.filter((i) => i.severity === "low").length;
  const health: BusinessHealth = high > 0 || ai.status === "unavailable" ? "unhealthy" : medium > 0 || interventions.length > 0 ? "attention" : "healthy";
  const wa = whatsappConfig();
  const channel = whatsappNumbersFor(id).length ? (wa.sendMode === "live" ? "live" : "dry_run") : wa.configured ? "not_routed" : "missing";
  const anyReal = (["commerce", "payments", "scheduling"] as const).some((d) => profiles?.[d]?.used && profiles[d].status === "connected" && !profiles[d].simulated);
  const stage: OperatingStage = controls.mode === "live" && readiness?.level === "READY_FOR_CUSTOMER_TRAFFIC" ? "live_ready" : controls.mode === "supervised" || anyReal ? "supervised" : "simulator_only";
  const latest = conversations.map((c) => c.updatedAt).sort().at(-1) ?? null;
  const openObligations = obligations.filter((o) => !["completed", "cancelled", "superseded"].includes(o.status));
  return {
    id,
    name: graph.business.name,
    health,
    stage,
    controls,
    build: { commit: runtimeCommit(), runtime: BARRY_RUNTIME_VERSION, environment: environmentLabel() },
    model: { mode: ai.mode, model: ai.model, status: ai.status, summary: ai.summary, ...(ai.lastFailure ? { lastFailure: ai.lastFailure } : {}) },
    storage: isSupabaseConfigured() ? "durable" : "memory",
    channel: { whatsapp: channel },
    providers: { commerce: providerWords(profiles, "commerce"), payments: providerWords(profiles, "payments"), scheduling: providerWords(profiles, "scheduling") },
    readiness: readiness ? { level: readiness.level, label: readiness.label, blockers: readiness.next?.blockers.map((b) => b.label) ?? [] } : { level: "NOT_READY", label: "Readiness unavailable", blockers: [] },
    interventions: interventions.length,
    approvalsActive: approvals.filter((a) => a.lifecycle === "active").length,
    approvalsHeld: approvals.filter((a) => a.lifecycle === "held").length,
    handoffsOpen: conversations.reduce((n, c) => n + readHandoffs(c).filter((h) => h.status !== "resolved").length, 0),
    incidents: { high, medium, low, open },
    obligations: {
      open: openObligations.length,
      needsOwner: openObligations.filter((o) => o.nextMove === "needs_owner").length,
      barryCanAct: openObligations.filter((o) => o.nextMove === "barry_can_act").length,
      waitingOnCustomer: openObligations.filter((o) => o.nextMove === "waiting_on_customer").length,
      blocked: openObligations.filter((o) => o.nextMove === "blocked_by_capability").length,
    },
    money: { stuckWithOwner: opportunities.summary.stuckWithYou, waitingOnCustomer: opportunities.summary.waitingOnCustomer, atRisk: opportunities.summary.atRisk, simulated: opportunities.summary.simulated },
    conversations: { total: conversations.length, last24h: conversations.filter((c) => now.getTime() - Date.parse(c.updatedAt) <= D).length, latestActivityAt: latest },
    recentChanges: audit.filter((a) => now.getTime() - Date.parse(a.at) <= D),
    unavailable,
    interventionQueue: opts.detail ? interventions : [],
    obligationList: opts.detail ? obligations : [],
    audit: opts.detail ? audit : [],
  };
}

const hasMoney = (m: Money) => Object.values(m).some((v) => v > 0);

export function summarizeFleet(businesses: BusinessStatus[]): FleetSummary {
  return {
    businesses: businesses.length,
    healthy: businesses.filter((b) => b.health === "healthy").length,
    needFounder: businesses
      .filter((b) => b.incidents.high > 0 || b.approvalsHeld > 0 || b.model.status === "unavailable")
      .map((b) => ({ id: b.id, name: b.name, why: [b.incidents.high ? `${b.incidents.high} high incident${b.incidents.high === 1 ? "" : "s"}` : "", b.approvalsHeld ? `${b.approvalsHeld} held request${b.approvalsHeld === 1 ? "" : "s"}` : "", b.model.status === "unavailable" ? "AI unavailable" : ""].filter(Boolean).join(" · ") })),
    broke: businesses.flatMap((b) => b.incidents.open.filter((i) => i.severity !== "low").map((incident) => ({ id: b.id, name: b.name, incident }))),
    changed: businesses.flatMap((b) => [
      ...b.recentChanges.map((a) => ({ id: b.id, name: b.name, what: `founder: ${describeChange(a)}`, at: a.at })),
      ...(b.conversations.last24h ? [{ id: b.id, name: b.name, what: `${b.conversations.last24h} conversation${b.conversations.last24h === 1 ? "" : "s"} active`, at: b.conversations.latestActivityAt ?? "" }] : []),
    ]).sort((x, y) => y.at.localeCompare(x.at)),
    moneyBlocked: businesses.filter((b) => hasMoney(b.money.stuckWithOwner) || hasMoney(b.money.atRisk)).map((b) => ({ id: b.id, name: b.name, stuckWithOwner: b.money.stuckWithOwner, atRisk: b.money.atRisk })),
    notReady: businesses.filter((b) => b.readiness.level === "NOT_READY" || b.readiness.level === "READY_FOR_TESTING").map((b) => ({ id: b.id, name: b.name, level: b.readiness.level, blocker: b.readiness.blockers[0] ?? "" })),
  };
}

export function describeChange(a: ControlAudit): string {
  const parts: string[] = [];
  if (a.change.mode) parts.push(`mode → ${a.change.mode}`);
  if (typeof a.change.pauseConsequentialWrites === "boolean") parts.push(a.change.pauseConsequentialWrites ? "consequential writes paused" : "writes resumed");
  if (typeof a.change.approvalRequiredForAll === "boolean") parts.push(a.change.approvalRequiredForAll ? "human-only (approval for everything)" : "approval-for-everything lifted");
  if (a.change.pausedCapabilities) parts.push(a.change.pausedCapabilities.length ? `paused: ${a.change.pausedCapabilities.join(", ")}` : "no capabilities paused");
  if (a.change.disabledChannels) parts.push(a.change.disabledChannels.length ? `channels disabled: ${a.change.disabledChannels.join(", ")}` : "all channels enabled");
  return `${parts.join("; ") || "no change"} — ${a.reason}`;
}

export async function getFleet(opts: { now?: Date } = {}): Promise<Fleet> {
  const now = opts.now ?? new Date();
  const businesses = await Promise.all(fleetTenantIds().map(async (id) => stripDetail(await getBusinessStatus(resolveBusinessGraph(id), { now }))));
  return { at: now.toISOString(), build: { commit: runtimeCommit(), runtime: BARRY_RUNTIME_VERSION, environment: environmentLabel() }, summary: summarizeFleet(businesses), businesses };
}

function stripDetail(d: BusinessStatusDetail): BusinessStatus {
  const { interventionQueue: _q, obligationList: _o, audit: _a, ...rest } = d;
  void _q;
  void _o;
  void _a;
  return rest;
}
