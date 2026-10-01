import type { Fleet, BusinessStatus } from "./fleet";

/**
 * BARRY'S PRESENCE — one word and one sentence about what BARRY is doing right now, derived from the
 * same read models the pages use. Not an avatar, not a mood: a status with a reason.
 */
export type PresenceState = "working" | "waiting" | "needs_you" | "degraded" | "paused";
export type PresenceView = { state: PresenceState; text: string; href?: string };

export function businessPresence(b: BusinessStatus): PresenceView {
  const href = `/hq/${encodeURIComponent(b.id)}`;
  if (b.controls.pauseConsequentialWrites) return { state: "paused", text: `Consequential actions are paused — ${b.controls.reason || "by the founder"}`, href: `${href}?view=controls` };
  if (b.model.status === "unavailable") return { state: "degraded", text: "BARRY cannot understand customers right now", href: `${href}?view=capabilities` };
  if (b.incidents.high > 0 || b.model.status === "degraded") return { state: "degraded", text: b.incidents.high ? `${b.incidents.high} high incident${b.incidents.high === 1 ? "" : "s"} open` : b.model.summary, href: `${href}?view=attention` };
  if (b.approvalsActive + b.approvalsHeld + b.handoffsOpen > 0) return { state: "needs_you", text: `${b.approvalsActive + b.approvalsHeld + b.handoffsOpen} thing${b.approvalsActive + b.approvalsHeld + b.handoffsOpen === 1 ? "" : "s"} wait on a person`, href: `${href}?view=attention` };
  if (b.obligations.waitingOnCustomer > 0 && b.obligations.barryCanAct === 0) return { state: "waiting", text: `Waiting on ${b.obligations.waitingOnCustomer} customer${b.obligations.waitingOnCustomer === 1 ? "" : "s"}`, href: `${href}?view=activity` };
  return { state: "working", text: b.conversations.last24h ? `${b.conversations.last24h} conversation${b.conversations.last24h === 1 ? "" : "s"} in the last day` : "Quiet — nothing open", href };
}

export function fleetPresence(fleet: Fleet): PresenceView {
  const s = fleet.summary;
  const paused = fleet.businesses.filter((b) => b.controls.pauseConsequentialWrites);
  const degraded = fleet.businesses.filter((b) => b.model.status === "unavailable" || b.incidents.high > 0);
  if (degraded.length) return { state: "degraded", text: `${degraded.length} business${degraded.length === 1 ? "" : "es"} degraded`, href: "/hq/incidents" };
  if (s.needFounder.length) return { state: "needs_you", text: `${s.needFounder.length} business${s.needFounder.length === 1 ? "" : "es"} need${s.needFounder.length === 1 ? "s" : ""} you`, href: "/hq" };
  if (paused.length) return { state: "paused", text: `${paused.length} business${paused.length === 1 ? "" : "es"} paused`, href: "/hq/fleet" };
  const active = fleet.businesses.reduce((n, b) => n + b.conversations.last24h, 0);
  return { state: "working", text: active ? `${active} conversation${active === 1 ? "" : "s"} across the fleet today` : "Quiet across the fleet" };
}
