import { getBackend } from "@/lib/store";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import type { Fleet, BusinessStatus } from "./fleet";

/**
 * SINCE YOU WERE HERE — the founder's last visit is a durable snapshot (operator record, kind
 * "founder_state", fleet scope). On the next visit the brief lists ONLY derived differences between
 * that snapshot and the fleet now: incidents opened or resolved, money newly blocked, approvals that
 * started needing the owner, payments verified, capabilities degraded or recovered, readiness changes
 * and consequential founder actions. Nothing is guessed; no snapshot → no claims.
 */

export type VisitSnapshot = {
  at: string;
  businesses: Record<
    string,
    {
      name: string;
      openIncidents: string[];
      moneyBlocked: boolean;
      approvalsWaiting: number;
      readiness: string;
      degraded: boolean;
      mode: string;
      lastAuditId: string | null;
      verifiedPayments: number;
    }
  >;
};

export type VisitChange = { businessId: string; businessName: string; kind: "incident_new" | "incident_resolved" | "money_blocked" | "approval_required" | "payment_verified" | "capability_degraded" | "capability_recovered" | "readiness_changed" | "founder_action"; what: string; href: string };

const KEY = "last_visit";
const PINS_KEY = "pins";
const RECENT_KEY = "recent";

export function snapshotOf(fleet: Fleet): VisitSnapshot {
  const businesses: VisitSnapshot["businesses"] = {};
  for (const b of fleet.businesses) {
    businesses[b.id] = {
      name: b.name,
      openIncidents: b.incidents.open.map((i) => i.key).sort(),
      moneyBlocked: Object.values(b.money.stuckWithOwner).some((v) => v > 0) || Object.values(b.money.atRisk).some((v) => v > 0),
      approvalsWaiting: b.approvalsActive + b.approvalsHeld,
      readiness: b.readiness.level,
      degraded: b.model.status === "degraded" || b.model.status === "unavailable" || b.health === "unhealthy",
      mode: b.controls.mode,
      lastAuditId: b.recentChanges[0]?.id ?? null,
      verifiedPayments: b.money.verifiedPayments,
    };
  }
  return { at: fleet.at, businesses };
}

const href = (b: BusinessStatus | { id: string }, view?: string) => `/hq/${encodeURIComponent(b.id)}${view ? `?view=${view}` : ""}`;

/** Derived differences only. Pure. */
export function changesSince(previous: VisitSnapshot | null, fleet: Fleet): VisitChange[] {
  if (!previous) return [];
  const now = snapshotOf(fleet);
  const out: VisitChange[] = [];
  for (const b of fleet.businesses) {
    const was = previous.businesses[b.id];
    const is = now.businesses[b.id];
    if (!was) continue;
    for (const i of b.incidents.open) if (!was.openIncidents.includes(i.key)) out.push({ businessId: b.id, businessName: b.name, kind: "incident_new", what: `New incident: ${i.title}`, href: href(b, "attention") });
    for (const k of was.openIncidents) if (!is.openIncidents.includes(k)) out.push({ businessId: b.id, businessName: b.name, kind: "incident_resolved", what: `Incident resolved: ${k.split(":")[0].replace(/_/g, " ")}`, href: href(b, "activity") });
    if (is.moneyBlocked && !was.moneyBlocked) out.push({ businessId: b.id, businessName: b.name, kind: "money_blocked", what: "Money is now blocked (waiting on the owner or at risk)", href: href(b, "money") });
    if (is.approvalsWaiting > was.approvalsWaiting) out.push({ businessId: b.id, businessName: b.name, kind: "approval_required", what: `${is.approvalsWaiting - was.approvalsWaiting} new request${is.approvalsWaiting - was.approvalsWaiting === 1 ? " waits" : "s wait"} on the owner`, href: href(b, "attention") });
    if (is.verifiedPayments > was.verifiedPayments) out.push({ businessId: b.id, businessName: b.name, kind: "payment_verified", what: `${is.verifiedPayments - was.verifiedPayments} payment${is.verifiedPayments - was.verifiedPayments === 1 ? "" : "s"} verified`, href: href(b, "money") });
    if (is.degraded && !was.degraded) out.push({ businessId: b.id, businessName: b.name, kind: "capability_degraded", what: `Degraded: ${b.model.summary}`, href: href(b, "capabilities") });
    if (!is.degraded && was.degraded) out.push({ businessId: b.id, businessName: b.name, kind: "capability_recovered", what: "Recovered: BARRY is healthy again", href: href(b, "capabilities") });
    if (is.readiness !== was.readiness) out.push({ businessId: b.id, businessName: b.name, kind: "readiness_changed", what: `Readiness: ${was.readiness.replace(/_/g, " ").toLowerCase()} → ${is.readiness.replace(/_/g, " ").toLowerCase()}`, href: href(b, "launch") });
    const newAudit = b.recentChanges.filter((a) => a.at > previous.at);
    for (const a of newAudit) out.push({ businessId: b.id, businessName: b.name, kind: "founder_action", what: `${a.by}: ${a.change.mode ? `mode → ${a.change.mode}` : typeof a.change.pauseConsequentialWrites === "boolean" ? (a.change.pauseConsequentialWrites ? "paused consequential actions" : "resumed consequential actions") : "changed founder controls"}`, href: href(b, "controls") });
  }
  return out;
}

export async function loadLastVisit(): Promise<VisitSnapshot | null> {
  try {
    const r = (await getBackend().listOperatorRecords(FLEET_SCOPE, "founder_state")).find((x) => x.key === KEY);
    return r ? (r.data as unknown as VisitSnapshot) : null;
  } catch {
    return null;
  }
}

/** Record this visit (after the brief was computed against the previous one). */
export async function markVisit(snapshot: VisitSnapshot): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "founder_state", key: KEY, data: snapshot });
}

// ── Pins and recents ──────────────────────────────────────────────────────────────────────────────

export type FounderPins = { businessIds: string[] };
export type RecentEntry = { href: string; label: string; at: string };

export async function loadPins(): Promise<FounderPins> {
  try {
    const r = (await getBackend().listOperatorRecords(FLEET_SCOPE, "founder_state")).find((x) => x.key === PINS_KEY);
    const d = r?.data as Partial<FounderPins> | undefined;
    return { businessIds: Array.isArray(d?.businessIds) ? d.businessIds.filter((x): x is string => typeof x === "string") : [] };
  } catch {
    return { businessIds: [] };
  }
}

export function togglePin(pins: FounderPins, businessId: string): FounderPins {
  return { businessIds: pins.businessIds.includes(businessId) ? pins.businessIds.filter((x) => x !== businessId) : [...pins.businessIds, businessId] };
}

export async function savePins(pins: FounderPins): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "founder_state", key: PINS_KEY, data: pins });
}

export async function loadRecent(): Promise<RecentEntry[]> {
  try {
    const r = (await getBackend().listOperatorRecords(FLEET_SCOPE, "founder_state")).find((x) => x.key === RECENT_KEY);
    const d = r?.data as { items?: RecentEntry[] } | undefined;
    return Array.isArray(d?.items) ? d.items : [];
  } catch {
    return [];
  }
}

/** Most recent first, one entry per href, at most 8. Pure. */
export function pushRecent(items: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...items.filter((x) => x.href !== entry.href)].slice(0, 8);
}

export async function saveRecent(items: RecentEntry[]): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "founder_state", key: RECENT_KEY, data: { items } });
}
