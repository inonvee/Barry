import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { effectiveGraph } from "@/lib/policy/effective";
import { whatsappConfig, whatsappNumbersFor } from "@/lib/channels/whatsapp";
import { loadEntitlement } from "@/lib/commercial/account";
import { hasFeature } from "@/lib/commercial/entitlements";
import { PLAN_CATALOG } from "@/lib/commercial/plans";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { getReasoner } from "@/lib/reasoner";
import { describeBusinessConnections, type ConnectionView } from "@/lib/connections/status";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { withLifecycle, type ApprovalWithLifecycle } from "@/lib/runtime/owner-requests";
import { readLedger, termsAmount, termsOf } from "@/lib/runtime/ledger";
import { readHandoffs, type HandoffRecord } from "@/lib/runtime/handoff";
import { outcomeEvents, revenueEvidence, revenueSummary, type OutcomeEvent, type RevenueEvidence, type RevenueSummary } from "./revenue";
import { buildInterventions, type Intervention } from "./interventions";
import { revenueOpportunities, type Opportunity, type OpportunitySummary } from "./opportunities";
import { reconcileObligations, type Obligation } from "@/lib/operator/obligations";
import { followUpPolicyFor, OBLIGATION_FOLLOW_UP } from "@/lib/operator/policy";
import type { ObligationKind } from "@/lib/operator/obligation-model";
import { attemptCounts, listAttempts } from "@/lib/operator/attempts";
import { assessCapabilities, capabilitySummary } from "./capabilities";
import { listOperations, operationView } from "./operations";
import type { OwnerOperationView } from "./operation-model";
import { whatsappOwnerConfig } from "@/lib/channels/whatsapp";
import { linkActive, listOwnerIdentities, maskedIdentity } from "@/lib/owner-channel/identity";
import { visibleInitiatives } from "@/lib/initiative/store";
import type { InitiativeView } from "@/lib/initiative/model";

/**
 * THE OWNER'S VIEW OF THEIR BUSINESS — read model for the owner dashboard (and for Owner Barry).
 *
 * Everything is derived from authoritative records only: conversation state and its effect ledger,
 * owner requests with their lifecycle (incl. "held"), provider-verified payments, confirmed bookings,
 * orders, handoffs, and each turn's trace (for AI health). Tenant-scoped: every read takes ONE business.
 * No internal ids, capability names, traces or secrets are exposed at this level.
 */

export type AttentionReason = "approval_waiting" | "approval_held" | "handoff_open" | "ai_unavailable" | "action_failed" | "blocked";

export type OwnerConversationRow = {
  id: string;
  customer: string;
  channel: "whatsapp" | "web" | "instagram" | "simulator";
  lastActivityAt: string;
  lastMessage: { from: "customer" | "barry" | "system"; text: string } | null;
  status: "needs_you" | "waiting_on_customer" | "completed" | "lost" | "in_progress";
  attention: AttentionReason[];
  outcomes: OutcomeEvent["kind"][];
  /** Operations BARRY carried out (reads excluded). */
  barryActions: number;
  handledAutonomously: boolean;
};

export type AiHealth = {
  status: "healthy" | "degraded" | "unavailable" | "not_configured" | "no_traffic";
  /** Plain-language line for the owner. */
  summary: string;
  mode: "live_model" | "simulated";
  model: string | null;
  configError?: string;
  turnsSampled: number;
  understandingFailures: number;
  composerFailures: number;
  /** The most recent failure, classified (operator detail — no secrets). */
  lastFailure?: { at: string; kind: string; status?: number; code?: string };
};

export type SystemHealth = {
  domain: string;
  provider: string | null;
  state: "healthy" | "simulated" | "degraded" | "disconnected" | "not_configured";
  lastVerifiedAt: string | null;
  /** OWNER words. */
  blockers: string[];
  /** BARRY TEAM technical detail (setting keys). */
  technical: string[];
};

export type OwnerApproval = {
  id: string;
  conversationId: string;
  customer: string;
  what: string;
  amount?: string;
  whyApproval: string;
  lifecycle: ApprovalWithLifecycle["lifecycle"];
  revision: number;
  createdAt: string;
  /** Pending and safe to decide now (never true for a held or stale request). */
  actionable: boolean;
  /** The customer said something after this request that matters (held requests). */
  newerContext?: string;
  result?: string;
  /** The exact terms the request would run with (customer-safe: references, reasons, quantities, items). */
  terms: Record<string, string | number>;
  /** The business action in plain words. */
  action: string;
  /** The business reference an executed request produced (e.g. the ticket number). */
  resultReference?: string;
};

/**
 * Channels, owner-safe: how customers reach BARRY on WhatsApp for this business (from the real routing
 * configuration), and whether the owner can command BARRY by WhatsApp — not built in this version, so
 * always "not_connected" until the Owner Command Channel ships.
 */
export type OwnerChannels = {
  customerWhatsapp: "live" | "dry_run" | "not_routed" | "not_configured";
  /** connected = BARRY's owner line is configured AND this business has an active owner link; not_linked = line ready, no link yet. */
  ownerCommands: "connected" | "not_linked" | "not_connected";
  /** The linked owner number(s), masked. */
  ownerNumbers?: string[];
  /** wa.me number for "Open BARRY in WhatsApp" (only when connected). */
  ownerLine?: string;
  ownerSendMode?: "live" | "dry_run";
};

export function ownerChannels(businessId: string, activeOwnerLinks: string[] = []): OwnerChannels {
  const wa = whatsappConfig();
  const owner = whatsappOwnerConfig();
  const routed = whatsappNumbersFor(businessId).length > 0;
  const ownerCommands = !owner.configured ? "not_connected" : activeOwnerLinks.length ? "connected" : "not_linked";
  return {
    customerWhatsapp: !wa.configured ? "not_configured" : !routed ? "not_routed" : wa.sendMode === "live" ? "live" : "dry_run",
    ownerCommands,
    ...(ownerCommands === "connected" ? { ownerNumbers: activeOwnerLinks, ownerSendMode: owner.sendMode, ...(owner.display ? { ownerLine: owner.display } : {}) } : {}),
  };
}

/** A recent owner command, as the Control Room shows it (same record the WhatsApp channel wrote). */
export type OwnerCommandSummary = { id: string; at: string; source: "web" | "whatsapp" | "voice"; text: string; intent: string; operationId?: string; reply: string };

export type OwnerOperator = {
  included: boolean;
  rules: { kind: ObligationKind; enabled: boolean; afterHours: number; maxAttempts: number; intervalHours: number }[];
};

export type OwnerTrend = {
  /** Local dates (YYYY-MM-DD), oldest first. */
  days: string[];
  /** The currency the series are in (the business's most-used verified currency); null with no verified money. */
  currency: string | null;
  /** Provider-verified collected per day (the only revenue). */
  made: number[];
  /** The part of it paid after an earlier failed / cancelled / blocked attempt (a subset of made). */
  recovered: number[];
};

/** Verified money per local day for the last `days` days — real provider only. */
export function revenueTrend(evidence: Pick<RevenueEvidence, "category" | "amount" | "currency" | "at" | "simulated">[], timeZone: string, now = new Date(), days = 7): OwnerTrend {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const keys = Array.from({ length: days }, (_, i) => fmt.format(new Date(now.getTime() - (days - 1 - i) * 24 * 3600 * 1000)));
  const real = evidence.filter((e) => !e.simulated && (e.category === "collected" || e.category === "recovered"));
  const totals = new Map<string, number>();
  for (const e of real) if (e.category === "collected") totals.set(e.currency, (totals.get(e.currency) ?? 0) + e.amount);
  const currency = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const made = keys.map(() => 0);
  const recovered = keys.map(() => 0);
  for (const e of real) {
    if (e.currency !== currency) continue;
    const i = keys.indexOf(fmt.format(new Date(e.at)));
    if (i < 0) continue;
    if (e.category === "collected") made[i] = Math.round((made[i] + e.amount) * 100) / 100;
    else recovered[i] = Math.round((recovered[i] + e.amount) * 100) / 100;
  }
  return { days: keys, currency, made, recovered };
}

export type OwnerWorkspace = {
  business: { id: string; name: string; timezone: string; locale: string };
  window: { since: string; label: string };
  today: {
    conversations: number;
    handledAutonomously: number;
    needYou: number;
    /** Items in the intervention queue right now (not limited to the window). */
    interventions: number;
    approvalsWaiting: number;
    handoffsOpen: number;
    completedOutcomes: number;
    blockedOrFailed: number;
  };
  revenue: RevenueSummary;
  /** Every amount behind the money figures, with the record that proves it. */
  revenueEvidence: RevenueEvidence[];
  /** THE queue: everything that needs the owner, with why / what BARRY did / the decision / what follows. */
  interventions: Intervention[];
  /** Where money is stuck, at risk or waiting — and whose move it is. Current state, not window-bound. */
  opportunities: { items: Opportunity[]; summary: OpportunitySummary };
  /** What BARRY is watching: the durable obligations (open first, then recently closed with evidence). */
  obligations: Obligation[];
  conversations: OwnerConversationRow[];
  approvals: OwnerApproval[];
  outcomes: OutcomeEvent[];
  handoffs: (HandoffRecord & { customer: string })[];
  health: { ai: AiHealth; systems: SystemHealth[] };
  /** What BARRY can do for this business right now, what works only on a simulator, and the setup steps with what they unlock. */
  capabilities: ReturnType<typeof capabilitySummary>;
  /** The plan (owner-safe): its name and whether BARRY Margins is included. Never economics. */
  plan: { name: string | null; marginsIncluded: boolean };
  channels: OwnerChannels;
  /**
   * The proactive operator as the owner's rules and plan define it: whether follow-ups run at all for
   * this plan, and each follow-up rule (on/off, when, how many attempts). Read-only — the executor
   * enforces the same policy and plan.
   */
  operator: OwnerOperator;
  /** Verified money per local day, last 7 days (real provider only; test money never included). */
  trend: OwnerTrend;
  /** Operations started by owner commands (web or WhatsApp) — the same records the command service runs. */
  ownerOperations: OwnerOperationView[];
  /** The latest owner commands from every surface. */
  ownerCommands: OwnerCommandSummary[];
  /** What BARRY noticed (persisted by scans; never detected on read). Best first. */
  initiatives: InitiativeView[];
  /** Sources that could not be read (shown, never zeroed). */
  unavailable: string[];
};

/** Start of "today" in the business's own timezone, as an ISO instant. */
export function startOfLocalDay(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const elapsed = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - elapsed).toISOString();
}

export function customerLabel(c: ConversationState): string {
  const name = c.knownFields.name?.trim();
  if (name) return name;
  // The name the channel shows for this contact (e.g. a WhatsApp profile name) — a label, not a verified customer fact.
  const profile = c.knownFields.__channelProfileName?.trim();
  if (profile) return profile;
  const id = c.customerId.replace(/^[a-z]+:/i, "");
  return id.length > 4 ? `Customer ···${id.slice(-4)}` : "Customer";
}

export function channelOf(c: ConversationState): OwnerConversationRow["channel"] {
  if (/^wa[:_]/.test(c.id)) return "whatsapp";
  if (/^ig[:_]/.test(c.id)) return "instagram";
  if (/^web[:_]/.test(c.id)) return "web";
  return "simulator";
}

/** AI understanding/reply health from the traces BARRY recorded — never a guess. */
export function aiHealth(conversations: ConversationState[], now = new Date()): AiHealth {
  const reasoner = safeReasoner();
  const mode = reasoner?.name === "llm" ? "live_model" : "simulated";
  const base = { mode, model: reasoner?.model ?? null, ...(reasoner?.configError ? { configError: reasoner.configError } : {}) } as const;
  const recent = conversations
    .flatMap((c) => c.turns)
    .filter((t) => t.trace && now.getTime() - Date.parse(t.at) < 24 * 3600 * 1000)
    .sort((a, b) => b.at.localeCompare(a.at));
  const failures = recent.filter((t) => t.trace?.understanding?.valid === false);
  const composerFailures = recent.filter((t) => t.trace?.reply?.composerFailures?.length).length;
  const last = failures[0];
  const lastFailure = last?.trace?.understanding?.failure ? { at: last.at, kind: last.trace.understanding.failure.kind, ...(last.trace.understanding.failure.status ? { status: last.trace.understanding.failure.status } : {}), ...(last.trace.understanding.failure.code ? { code: last.trace.understanding.failure.code } : {}) } : undefined;
  const common = { ...base, turnsSampled: recent.length, understandingFailures: failures.length, composerFailures, ...(lastFailure ? { lastFailure } : {}) };
  if (reasoner?.configError) return { ...common, status: "unavailable", summary: "AI understanding is misconfigured — BARRY can't understand customers until it is fixed." };
  if (mode === "simulated") return { ...common, status: "not_configured", summary: "Running on BARRY's simulator, not the live AI model." };
  if (recent.length === 0) return { ...common, status: "no_traffic", summary: "No customer messages in the last 24 hours." };
  const latestThree = recent.slice(0, 3);
  if (latestThree.length > 0 && latestThree.every((t) => t.trace?.understanding?.valid === false)) {
    const quota = lastFailure?.kind === "provider_quota_exhausted";
    return { ...common, status: "unavailable", summary: quota ? "AI understanding is unavailable: the AI provider account is out of credit. Customers get a safe \"couldn't process\" reply and nothing is done." : "AI understanding is temporarily unavailable. Customers get a safe \"couldn't process\" reply and nothing is done." };
  }
  if (failures.length > 0 || composerFailures > 0) return { ...common, status: "degraded", summary: `AI had ${failures.length} failed understanding${failures.length === 1 ? "" : "s"} in the last 24 hours; those messages were not acted on.` };
  return { ...common, status: "healthy", summary: "AI understanding is working normally." };
}

function safeReasoner() {
  try {
    return getReasoner();
  } catch {
    return undefined;
  }
}

function systemHealth(v: ConnectionView): SystemHealth {
  const state: SystemHealth["state"] =
    v.status === "not_configured" ? "not_configured" : v.status === "disconnected" ? "disconnected" : v.status === "error" || v.missing.length > 0 ? "degraded" : v.simulated ? "simulated" : "healthy";
  return { domain: v.capability, provider: v.provider, state, lastVerifiedAt: v.lastVerifiedAt, blockers: v.missing.length ? [`${v.missing.length} setting${v.missing.length === 1 ? "" : "s"} for the BARRY team to add`] : [], technical: v.missing.map((m) => `Missing setting: ${m}`) };
}

const REASON_FOR_APPROVAL = "Your rules say you approve this before BARRY does it.";

function approvalView(a: ApprovalWithLifecycle, customer: string): OwnerApproval {
  const input = (a.requestedInput ?? {}) as Record<string, unknown>;
  const amount = typeof input.amount === "number" && typeof input.currency === "string" ? termsAmount({ amount: input.amount, currency: input.currency }) : undefined;
  const held = a.lifecycle === "held";
  return {
    id: a.id,
    conversationId: a.conversationId,
    customer,
    what: a.summary,
    ...(amount ? { amount } : {}),
    whyApproval: a.reason?.trim() ? a.reason : REASON_FOR_APPROVAL,
    lifecycle: a.lifecycle,
    revision: a.revision,
    createdAt: a.createdAt,
    actionable: a.lifecycle === "active",
    ...(held
      ? {
          newerContext:
            a.hold?.reason === "conflicting_reference"
              ? `The customer later wrote ${a.hold.detail ?? "a different reference"}, which conflicts with this request. Held until they confirm.`
              : "The customer sent a message after this request that BARRY couldn't understand. Held until it is re-checked.",
        }
      : {}),
    ...(a.result ? { result: a.result.result, ...(a.result.reference ? { resultReference: a.result.reference } : {}) } : {}),
    terms: termsOf(a.requestedAction, a.requestedInput),
    action: a.requestedAction === "invokeCapability" ? String(((a.requestedInput ?? {}) as Record<string, unknown>).capability ?? "") : a.requestedAction,
  };
}

/** The whole owner workspace for one business, for a time window (default: today, business time). */
export async function getOwnerWorkspace(staticGraph: BusinessGraph, opts: { since?: string; label?: string; now?: Date } = {}): Promise<OwnerWorkspace> {
  // The owner sees the rules the runtime enforces (static profile + approved owner-trained overlay).
  const graph = await effectiveGraph(staticGraph);
  const now = opts.now ?? new Date();
  const businessId = graph.business.id;
  const since = opts.since ?? startOfLocalDay(graph.business.timezone, now);
  const backend = getBackend();
  const unavailable: string[] = [];
  const safe = async <T,>(name: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (err) {
      console.error(`[barry:owner] ${name} unavailable`, err instanceof Error ? err.message : err);
      unavailable.push(name);
      return fallback;
    }
  };
  const [conversations, approvalsRaw, payments, bookings, orders, carts, attempts] = await Promise.all([
    safe("conversations", () => getConversationStore().listByBusiness(businessId), [] as ConversationState[]),
    safe("approvals", () => backend.listApprovals(businessId), []),
    safe("payments", () => backend.listPaymentRequests(businessId), []),
    safe("bookings", () => backend.listBookings(businessId), []),
    safe("orders", () => backend.listCommerceOrders(businessId), []),
    safe("carts", () => backend.listCommerceCarts(businessId), []),
    safe("operator attempts", () => listAttempts(businessId), []),
  ]);
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const approvals = withLifecycle(approvalsRaw, new Map(conversations.map((c) => [c.id, c])));
  const attribution = { graph, conversations, payments, bookings, orders, approvals: approvalsRaw, now };
  const outcomes = outcomeEvents({ ...attribution, since });
  const revenue = revenueSummary({ ...attribution, since });
  const evidence = revenueEvidence({ ...attribution, since }).map((e) => ({ ...e, customer: byId.get(e.conversationId) ? customerLabel(byId.get(e.conversationId)!) : "Customer" }));

  const rows: OwnerConversationRow[] = conversations
    .map((c): OwnerConversationRow => {
      const mine = approvals.filter((a) => a.conversationId === c.id);
      const handoffs = readHandoffs(c);
      const ledger = readLedger(c);
      const lastTurn = c.turns.at(-1);
      const attention: AttentionReason[] = [];
      if (mine.some((a) => a.lifecycle === "active")) attention.push("approval_waiting");
      if (mine.some((a) => a.lifecycle === "held")) attention.push("approval_held");
      if (handoffs.some((h) => h.status !== "resolved")) attention.push("handoff_open");
      if (lastTurn?.trace?.understanding?.valid === false) attention.push("ai_unavailable");
      const lastEffect = ledger.at(-1);
      if (lastEffect?.status === "failed" && lastEffect.operation !== "understand") attention.push("action_failed");
      if (lastEffect?.effect === "write.blocked") attention.push("blocked");
      const kinds = [...new Set(outcomes.filter((o) => o.conversationId === c.id).map((o) => o.kind))];
      const completed = kinds.some((k) => k === "paid" || k === "booked" || k === "order_created" || k === "case_created") || c.outcome === "won";
      const lastMsg = c.messages.at(-1);
      const status: OwnerConversationRow["status"] =
        attention.length > 0 ? "needs_you" : c.outcome === "lost" || ledger.at(-1)?.status === "withdrawn" ? "lost" : completed ? "completed" : lastMsg?.role === "barry" ? "waiting_on_customer" : "in_progress";
      return {
        id: c.id,
        customer: customerLabel(c),
        channel: channelOf(c),
        lastActivityAt: c.updatedAt,
        lastMessage: lastMsg ? { from: lastMsg.role, text: lastMsg.content.length > 140 ? `${lastMsg.content.slice(0, 140)}…` : lastMsg.content } : null,
        status,
        attention,
        outcomes: kinds,
        barryActions: ledger.filter((e) => (e.status === "effected" || e.status === "effected_unconfirmed") && !/\.read$|^catalog\.|^availability\.|^stock\.|^handoff\./.test(e.effect)).length,
        handledAutonomously: mine.length === 0 && handoffs.length === 0 && !c.turns.some((t) => t.trace?.understanding?.valid === false) && c.messages.some((m) => m.role === "customer"),
      };
    })
    .sort((a, b) => Number(b.status === "needs_you") - Number(a.status === "needs_you") || b.lastActivityAt.localeCompare(a.lastActivityAt));

  const inWindow = rows.filter((r) => byId.get(r.id)!.messages.some((m) => m.role === "customer" && m.at >= since));
  const handoffs = conversations.flatMap((c) => readHandoffs(c).map((h) => ({ ...h, customer: customerLabel(c) }))).sort((a, b) => Number(b.status !== "resolved") - Number(a.status !== "resolved") || b.createdAt.localeCompare(a.createdAt));
  const interventions = buildInterventions({ graph, conversations, approvals, payments, customerLabel, now });
  const opportunities = revenueOpportunities({ graph, conversations, approvals, payments, bookings, orders, customerLabel, now });
  const policy = followUpPolicyFor(graph);
  const entitlement = await safe("plan", () => loadEntitlement(businessId), undefined);
  const weekEvidence = revenueEvidence({ ...attribution, since: new Date(Date.parse(startOfLocalDay(graph.business.timezone, now)) - 6 * 24 * 3600 * 1000).toISOString() });
  const obligations = await safe("obligations", () => reconcileObligations({ graph, conversations, approvals, payments, bookings, carts, policy, attempts: attemptCounts(attempts), now, customerLabel }), [] as Obligation[]);
  const profiles = await safe("capability profiles", () => resolveCapabilityProfiles(graph), undefined);
  const connections = await safe("connections", () => describeBusinessConnections(businessId, profiles), [] as ConnectionView[]);
  const capabilities = capabilitySummary(await safe("capabilities", () => assessCapabilities(graph, { profiles, connections }), { needs: [], steps: [], now: [], nowSimulated: [], afterSetup: [] }));

  return {
    business: { id: businessId, name: graph.business.name, timezone: graph.business.timezone, locale: graph.business.locale },
    window: { since, label: opts.label ?? "today" },
    today: {
      conversations: inWindow.length,
      handledAutonomously: inWindow.filter((r) => r.handledAutonomously).length,
      needYou: rows.filter((r) => r.status === "needs_you").length,
      interventions: interventions.length,
      approvalsWaiting: approvals.filter((a) => a.lifecycle === "active" || a.lifecycle === "held").length,
      handoffsOpen: handoffs.filter((h) => h.status !== "resolved").length,
      completedOutcomes: outcomes.filter((o) => (o.kind === "paid" || o.kind === "booked" || o.kind === "order_created" || o.kind === "case_created") && !o.simulated).length,
      blockedOrFailed: outcomes.filter((o) => o.kind === "blocked" || o.kind === "failed").length,
    },
    revenue,
    revenueEvidence: evidence,
    interventions,
    opportunities,
    obligations,
    conversations: rows,
    approvals: approvals
      .map((a) => approvalView(a, byId.get(a.conversationId) ? customerLabel(byId.get(a.conversationId)!) : "Customer"))
      .sort((x, y) => Number(y.actionable || y.lifecycle === "held") - Number(x.actionable || x.lifecycle === "held") || y.createdAt.localeCompare(x.createdAt)),
    outcomes,
    handoffs,
    health: { ai: aiHealth(conversations, now), systems: connections.map(systemHealth) },
    capabilities,
    plan: { name: entitlement?.plan ? PLAN_CATALOG[entitlement.plan].name : null, marginsIncluded: entitlement ? hasFeature(entitlement, "margins") : false },
    channels: ownerChannels(businessId, (await safe("owner links", () => listOwnerIdentities(businessId), [])).filter((l) => linkActive(l).ok).map(maskedIdentity)),
    ownerOperations: (await safe("owner operations", () => listOperations(businessId), [])).slice(0, 10).map((o) => operationView(o, obligations, conversations)),
    ownerCommands: (await safe("owner commands", () => backend.listOperatorRecords(businessId, "owner_command"), []))
      .map((r) => r.data as { id?: string; key?: string; createdAt?: string; source?: OwnerCommandSummary["source"]; text?: string; intent?: { kind?: string }; operationId?: string; reply?: { text?: string } })
      .filter((c) => c.id && c.key && !c.key.startsWith("pending:"))
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 8)
      .map((c) => ({ id: c.id!, at: c.createdAt ?? "", source: c.source ?? "web", text: (c.text ?? "").slice(0, 200), intent: c.intent?.kind ?? "query", ...(c.operationId ? { operationId: c.operationId } : {}), reply: (c.reply?.text ?? "").split("\n")[0].slice(0, 200) })),
    initiatives: await safe("initiatives", () => visibleInitiatives(businessId), []),
    operator: {
      // Unreadable plan → shown as not included (the executor fails closed the same way).
      included: entitlement ? hasFeature(entitlement, "proactive_followups") : false,
      rules: (Object.entries(OBLIGATION_FOLLOW_UP) as [ObligationKind, keyof typeof policy][]).map(([kind, k]) => ({ kind, enabled: policy[k].enabled, afterHours: policy[k].afterHours, maxAttempts: policy[k].maxAttempts, intervalHours: policy[k].intervalHours })),
    },
    trend: revenueTrend(weekEvidence, graph.business.timezone, now),
    unavailable,
  };
}
