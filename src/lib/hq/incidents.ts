import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { PaymentRequestRecord } from "@/lib/store/types";
import type { ConnectionView } from "@/lib/connections/status";
import type { ApprovalWithLifecycle } from "@/lib/runtime/owner-requests";
import { readLedger } from "@/lib/runtime/ledger";
import { readDeliveries } from "@/lib/channels/gateway";
import type { AiHealth } from "@/lib/owner/service";
import { getBackend } from "@/lib/store";

/**
 * FLEET INCIDENTS — one read model of what is broken or stuck in a business, derived from records only
 * (ledger effects, approvals, deliveries, connections, AI health). Severity is a deterministic rule per
 * kind, never a judgment. Repeated symptoms collapse into ONE incident per (business, kind, subject)
 * with first/last seen and an occurrence count. The founder acknowledges or resolves an incident in HQ;
 * a resolved incident whose symptom is seen again AFTER the resolution reopens.
 */

export type IncidentSeverity = "high" | "medium" | "low";
export type IncidentKind =
  | "ai_unavailable"
  | "ai_degraded"
  | "repeated_not_understood"
  | "held_approval_stuck"
  | "failed_write"
  | "unverified_effect"
  | "undelivered_reply"
  | "connection_unhealthy"
  | "blocked_write"
  | "stale_unpaid_link";

export type IncidentStatus = "current" | "acknowledged" | "resolved";

export type Incident = {
  /** Stable: `${kind}:${subject}` within the business. */
  key: string;
  businessId: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  title: string;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  status: IncidentStatus;
  /** The records this stands on. */
  evidence: string[];
  /** Capability id / domain affected, when one is. */
  capability?: string;
  impact: string;
  nextAction: string;
  links: { conversationId?: string; interventionId?: string; capability?: string; provider?: string };
  acknowledged?: { by: string; at: string; note?: string };
  resolved?: { by: string; at: string; note?: string };
};

export type IncidentInput = {
  graph: BusinessGraph;
  conversations: ConversationState[];
  approvals: ApprovalWithLifecycle[];
  payments: PaymentRequestRecord[];
  connections: ConnectionView[];
  ai: AiHealth;
  now: Date;
  /** Founder acknowledgements / resolutions (operator records of kind "incident"). */
  states?: IncidentState[];
};

export type IncidentState = { key: string; acknowledged?: { by: string; at: string; note?: string }; resolved?: { by: string; at: string; note?: string } };

const H = 3600_000;
const D = 24 * H;

/** Deterministic severity per kind (age-sensitive where the rule says so). */
export function incidentSeverity(kind: IncidentKind, ageMs: number): IncidentSeverity {
  switch (kind) {
    case "ai_unavailable":
    case "undelivered_reply":
    case "connection_unhealthy":
      return "high";
    case "held_approval_stuck":
      return ageMs > D ? "high" : "medium";
    case "failed_write":
    case "unverified_effect":
    case "repeated_not_understood":
    case "ai_degraded":
      return "medium";
    case "blocked_write":
    case "stale_unpaid_link":
      return "low";
  }
}

type Draft = Omit<Incident, "status" | "severity" | "businessId" | "acknowledged" | "resolved" | "occurrences"> & { occurrences?: number };

export function deriveIncidents(input: IncidentInput): Incident[] {
  const { graph, conversations, approvals, payments, connections, ai, now } = input;
  const t = now.getTime();
  const drafts = new Map<string, Draft>();
  const add = (d: Draft) => {
    const prev = drafts.get(d.key);
    if (!prev) {
      drafts.set(d.key, { ...d, occurrences: d.occurrences ?? 1 });
      return;
    }
    prev.firstSeen = prev.firstSeen < d.firstSeen ? prev.firstSeen : d.firstSeen;
    prev.lastSeen = prev.lastSeen > d.lastSeen ? prev.lastSeen : d.lastSeen;
    prev.occurrences = (prev.occurrences ?? 1) + (d.occurrences ?? 1);
    prev.evidence = [...new Set([...prev.evidence, ...d.evidence])].slice(0, 8);
  };
  const recent = (iso: string) => t - Date.parse(iso) <= 7 * D;
  const nowIso = now.toISOString();

  // AI
  if (ai.status === "unavailable" || ai.status === "degraded") {
    const at = ai.lastFailure?.at ?? nowIso;
    add({
      key: `${ai.status === "unavailable" ? "ai_unavailable" : "ai_degraded"}:model`,
      kind: ai.status === "unavailable" ? "ai_unavailable" : "ai_degraded",
      title: ai.status === "unavailable" ? "BARRY cannot understand customers (AI unavailable)" : "AI understanding is degraded",
      firstSeen: at,
      lastSeen: at,
      evidence: [ai.summary, ...(ai.lastFailure ? [`last failure ${ai.lastFailure.kind}${ai.lastFailure.status ? ` HTTP ${ai.lastFailure.status}` : ""}${ai.lastFailure.code ? ` ${ai.lastFailure.code}` : ""} at ${ai.lastFailure.at}`] : [])],
      capability: "ai.understanding",
      impact: ai.status === "unavailable" ? "Customers get a fallback reply; requests pending on the owner are held." : "Some messages fall back; more requests may be held for re-check.",
      nextAction: ai.lastFailure?.kind === "provider_quota_exhausted" ? "Add credit to the AI provider account." : "Check the AI provider status and the model configuration.",
      links: { capability: "ai.understanding" },
      occurrences: ai.understandingFailures || 1,
    });
  }

  // Held approvals (stuck re-checks)
  for (const a of approvals) {
    if (a.lifecycle !== "held") continue;
    const age = t - Date.parse(a.createdAt);
    if (age < 2 * H) continue;
    add({
      key: `held_approval_stuck:${a.id}`,
      kind: "held_approval_stuck",
      title: `Held request waiting ${Math.round(age / H)}h for a re-check (${a.summary})`,
      firstSeen: a.createdAt,
      lastSeen: nowIso,
      evidence: [`request ${a.id.slice(0, 12)} · held · revision ${a.revision}`, a.hold?.reason ?? "intent hold"],
      impact: "A customer's request (and any money behind it) is stuck until the owner re-checks.",
      nextAction: "Owner: Re-check customer correction on the Today card, then decide.",
      links: { conversationId: a.conversationId, interventionId: `held_approval:${a.id}` },
    });
  }

  // Ledger: failed writes, unverified effects, blocked writes, repeated not-understood
  for (const c of conversations) {
    const ledger = readLedger(c);
    const failures = ledger.filter((e) => e.status === "failed" && e.operation !== "understand" && recent(e.at));
    for (const e of failures) {
      add({
        key: `failed_write:${c.id}:${e.operation}`,
        kind: "failed_write",
        title: `${e.describes} failed`,
        firstSeen: e.at,
        lastSeen: e.at,
        evidence: [`ledger #${e.seq} ${e.effect} · ${e.describes}`],
        capability: e.operation,
        impact: "The customer was told it didn't go through; nothing was created.",
        nextAction: "Check the provider / system for this operation; the customer can retry once it is healthy.",
        links: { conversationId: c.id, capability: e.operation },
      });
    }
    for (const e of ledger.filter((e) => e.status === "effected_unconfirmed" && recent(e.at))) {
      add({
        key: `unverified_effect:${c.id}:${e.operation}`,
        kind: "unverified_effect",
        title: `${e.describes} was submitted but not confirmed by the system`,
        firstSeen: e.at,
        lastSeen: e.at,
        evidence: [`ledger #${e.seq} ${e.effect} · effected_unconfirmed${e.reference ? ` · ${e.reference}` : ""}`],
        capability: e.operation,
        impact: "BARRY told the customer it is submitted but not confirmed; the business must confirm it happened.",
        nextAction: "Confirm in the system whether the effect exists; BARRY never claims it did.",
        links: { conversationId: c.id, capability: e.operation },
      });
    }
    for (const e of ledger.filter((e) => e.effect === "write.blocked" && recent(e.at))) {
      add({
        key: `blocked_write:${c.id}`,
        kind: "blocked_write",
        title: `A payment write was blocked by the customer's own limits`,
        firstSeen: e.at,
        lastSeen: e.at,
        evidence: [`ledger #${e.seq} write.blocked · ${e.describes}${e.outcome?.reason ? ` (${String(e.outcome.reason)})` : ""}`],
        impact: "No payment was created; the customer was told why.",
        nextAction: "Nothing to fix: the final-write check worked. Worth knowing if it repeats.",
        links: { conversationId: c.id },
      });
    }
    const notUnderstood = c.turns.filter((turn) => turn.trace?.understanding?.valid === false && t - Date.parse(turn.at) <= D);
    if (notUnderstood.length >= 2) {
      add({
        key: `repeated_not_understood:${c.id}`,
        kind: "repeated_not_understood",
        title: `${notUnderstood.length} messages not understood in 24h`,
        firstSeen: notUnderstood[0].at,
        lastSeen: notUnderstood[notUnderstood.length - 1].at,
        evidence: notUnderstood.map((turn) => `turn ${turn.id} · ${turn.trace?.understanding?.failure?.kind ?? "understanding failed"}`),
        capability: "ai.understanding",
        impact: "This customer is not being served; requests may be held.",
        nextAction: "Read the conversation; if the AI is healthy, the messages may need a person.",
        links: { conversationId: c.id, capability: "ai.understanding" },
        occurrences: notUnderstood.length,
      });
    }
    const deliveries = readDeliveries(c.knownFields);
    const last = deliveries.at(-1);
    if (last?.status === "failed" && recent(last.at)) {
      add({
        key: `undelivered_reply:${c.id}`,
        kind: "undelivered_reply",
        title: `BARRY's reply was not delivered on ${last.channel}`,
        firstSeen: last.at,
        lastSeen: last.at,
        evidence: [`delivery ${last.status} at ${last.at}${last.error ? ` · ${last.error}` : ""}`],
        capability: `channel.${last.channel}`,
        impact: "The customer never received BARRY's answer.",
        nextAction: "Check the channel provider; reply to the customer from your own channel meanwhile.",
        links: { conversationId: c.id, capability: `channel.${last.channel}` },
        occurrences: deliveries.filter((d) => d.status === "failed").length,
      });
    }
  }

  // Connections
  for (const v of connections) {
    if (v.status === "error" || (v.status === "connected" && v.missing.length > 0) || v.status === "disconnected") {
      add({
        key: `connection_unhealthy:${v.capability}`,
        kind: "connection_unhealthy",
        title: `${v.capability} connection is ${v.status === "connected" ? "incomplete" : v.status}${v.provider ? ` (${v.provider})` : ""}`,
        firstSeen: v.lastVerifiedAt ?? nowIso,
        lastSeen: nowIso,
        evidence: [`connection ${v.capability} · ${v.status}${v.missing.length ? ` · ${v.missing.length} missing setting${v.missing.length === 1 ? "" : "s"}` : ""}`],
        capability: v.capability,
        impact: `Every ${v.capability} action fails closed until it is healthy.`,
        nextAction: "BARRY team: complete the connection settings / run a connection test; consider pausing the capability meanwhile.",
        links: { capability: v.capability, ...(v.provider ? { provider: v.provider } : {}) },
      });
    }
  }

  // Stale unpaid links (money signal, low)
  for (const p of payments) {
    if (p.status !== "pending" || t - Date.parse(p.createdAt) <= D || t - Date.parse(p.createdAt) > 7 * D) continue;
    add({
      key: `stale_unpaid_link:${p.id}`,
      kind: "stale_unpaid_link",
      title: `Payment link unpaid for ${Math.round((t - Date.parse(p.createdAt)) / D)} day(s) (${p.amount} ${p.currency})`,
      firstSeen: p.createdAt,
      lastSeen: nowIso,
      evidence: [`payment request ${p.id.slice(0, 12)} · pending · ${p.provider ?? "no provider"}`],
      capability: "payments.create_request",
      impact: "Money the customer intended to pay is at risk.",
      nextAction: "Owner: follow up with the customer.",
      links: { conversationId: p.conversationId },
    });
  }

  const states = new Map((input.states ?? []).map((s) => [s.key, s]));
  return [...drafts.values()]
    .map((d): Incident => {
      const st = states.get(d.key);
      const resolvedStill = st?.resolved && st.resolved.at >= d.lastSeen;
      // A recurrence AFTER a resolution is a new episode: the old acknowledgement no longer applies.
      const reopened = Boolean(st?.resolved) && !resolvedStill;
      const acknowledged = st?.acknowledged && !reopened ? st.acknowledged : undefined;
      const status: IncidentStatus = resolvedStill ? "resolved" : acknowledged ? "acknowledged" : "current";
      return {
        ...d,
        businessId: graph.business.id,
        occurrences: d.occurrences ?? 1,
        severity: incidentSeverity(d.kind, t - Date.parse(d.firstSeen)),
        status,
        ...(acknowledged ? { acknowledged } : {}),
        ...(st?.resolved ? { resolved: st.resolved } : {}),
      };
    })
    .sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.lastSeen.localeCompare(a.lastSeen));
}

const SEV: Record<IncidentSeverity, number> = { high: 0, medium: 1, low: 2 };

export async function loadIncidentStates(businessId: string): Promise<IncidentState[]> {
  const records = await getBackend().listOperatorRecords(businessId, "incident");
  return records.map((r) => ({ key: r.key, ...(r.data as Omit<IncidentState, "key">) }));
}

/** Founder acknowledges or resolves an incident (durable, audited by the record itself: who/when/note). */
export async function setIncidentState(businessId: string, key: string, action: "acknowledge" | "resolve" | "reopen", meta: { by: string; note?: string; now?: Date }): Promise<IncidentState> {
  const at = (meta.now ?? new Date()).toISOString();
  const existing = (await loadIncidentStates(businessId)).find((s) => s.key === key) ?? { key };
  const next: IncidentState =
    action === "acknowledge"
      ? { ...existing, acknowledged: { by: meta.by, at, ...(meta.note ? { note: meta.note } : {}) } }
      : action === "resolve"
        ? { ...existing, resolved: { by: meta.by, at, ...(meta.note ? { note: meta.note } : {}) } }
        : { key, ...(existing.acknowledged ? { acknowledged: existing.acknowledged } : {}) };
  const { key: k, ...data } = next;
  await getBackend().upsertOperatorRecord({ businessId, kind: "incident", key: k, data });
  return next;
}
