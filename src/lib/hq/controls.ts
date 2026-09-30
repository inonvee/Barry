import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";
import { ACTION_REQUIREMENTS } from "@/lib/capabilities/model";
import { getCapability } from "@/lib/fabric/capability";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";

/**
 * FOUNDER CONTROLS — the bounded, audited levers the founder holds over ONE business from HQ.
 *
 *  - mode: SIMULATOR (mock systems only) / SUPERVISED (real systems may be connected; the founder watches
 *    closely) / LIVE. The mode never loosens authority by itself: it changes readiness and visibility.
 *  - pauseConsequentialWrites: every consequential action is DENIED (reads still work). Approval creation
 *    is a write toward an effect and is paused too.
 *  - approvalRequiredForAll: every consequential action the business's own rules would allow needs the
 *    owner's approval instead (human-only operation). Nothing the rules deny is loosened.
 *  - pausedCapabilities: capability ids ("commerce.checkout.create", "support.*") or typed action names
 *    that are DENIED until unpaused (an unhealthy provider, an incident).
 *  - disabledChannels: inbound channels BARRY does not answer on ("whatsapp").
 *
 * Every change is a durable record with a founder audit entry (who, when, why, before → after). Controls
 * only ever TIGHTEN what the policy engine decides: `applyFounderControls` runs after the business's own
 * rules and can turn allowed into requires_approval or denied, never the reverse.
 */

export type BusinessMode = "simulator" | "supervised" | "live";

export type BusinessControls = {
  mode: BusinessMode;
  pauseConsequentialWrites: boolean;
  approvalRequiredForAll: boolean;
  pausedCapabilities: string[];
  disabledChannels: string[];
  reason: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type ControlAudit = {
  id: string;
  at: string;
  by: string;
  reason: string;
  change: Partial<Omit<BusinessControls, "reason" | "updatedAt" | "updatedBy">>;
  before: Omit<BusinessControls, "reason" | "updatedAt" | "updatedBy">;
  after: Omit<BusinessControls, "reason" | "updatedAt" | "updatedBy">;
};

export const DEFAULT_CONTROLS: BusinessControls = {
  mode: "simulator",
  pauseConsequentialWrites: false,
  approvalRequiredForAll: false,
  pausedCapabilities: [],
  disabledChannels: [],
  reason: "",
  updatedAt: null,
  updatedBy: null,
};

const CONTROLS_KEY = "current";
const cache = new Map<string, BusinessControls>();

function fromRecord(r: OperatorRecord | undefined): BusinessControls {
  if (!r) return { ...DEFAULT_CONTROLS };
  const d = r.data as Partial<BusinessControls>;
  return {
    mode: d.mode === "supervised" || d.mode === "live" ? d.mode : "simulator",
    pauseConsequentialWrites: d.pauseConsequentialWrites === true,
    approvalRequiredForAll: d.approvalRequiredForAll === true,
    pausedCapabilities: Array.isArray(d.pausedCapabilities) ? d.pausedCapabilities.filter((x): x is string => typeof x === "string") : [],
    disabledChannels: Array.isArray(d.disabledChannels) ? d.disabledChannels.filter((x): x is string => typeof x === "string") : [],
    reason: typeof d.reason === "string" ? d.reason : "",
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : r.updatedAt,
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : null,
  };
}

/** The durable controls for a business (cached per process; every turn reloads before deciding). */
export async function loadControls(businessId: string): Promise<BusinessControls> {
  try {
    const records = await getBackend().listOperatorRecords(businessId, "controls");
    const c = fromRecord(records.find((r) => r.key === CONTROLS_KEY));
    cache.set(businessId, c);
    return c;
  } catch (err) {
    console.error("[barry:controls] unavailable — using the last known controls", err instanceof Error ? err.message : err);
    return cache.get(businessId) ?? { ...DEFAULT_CONTROLS };
  }
}

/** Synchronous view for the policy engine: what the last load saw (defaults before any load). */
export function currentControls(businessId: string): BusinessControls {
  return cache.get(businessId) ?? { ...DEFAULT_CONTROLS };
}

export function resetControlsCacheForTests(): void {
  cache.clear();
}

const strip = (c: BusinessControls): ControlAudit["before"] => ({ mode: c.mode, pauseConsequentialWrites: c.pauseConsequentialWrites, approvalRequiredForAll: c.approvalRequiredForAll, pausedCapabilities: [...c.pausedCapabilities], disabledChannels: [...c.disabledChannels] });

export type ControlChange = Partial<Pick<BusinessControls, "mode" | "pauseConsequentialWrites" | "approvalRequiredForAll" | "pausedCapabilities" | "disabledChannels">>;

/**
 * Apply a founder change: durable, audited, reversible (every audit entry carries before/after).
 * `by` is the founder identity HQ authenticated; `reason` is required.
 */
export async function applyControlChange(businessId: string, change: ControlChange, meta: { by: string; reason: string; now?: Date }): Promise<{ controls: BusinessControls; audit: ControlAudit }> {
  if (!meta.reason.trim()) throw new Error("A reason is required for every founder control change");
  const before = await loadControls(businessId);
  const at = (meta.now ?? new Date()).toISOString();
  const after: BusinessControls = {
    ...before,
    ...(change.mode ? { mode: change.mode } : {}),
    ...(typeof change.pauseConsequentialWrites === "boolean" ? { pauseConsequentialWrites: change.pauseConsequentialWrites } : {}),
    ...(typeof change.approvalRequiredForAll === "boolean" ? { approvalRequiredForAll: change.approvalRequiredForAll } : {}),
    ...(change.pausedCapabilities ? { pausedCapabilities: [...new Set(change.pausedCapabilities.map((s) => s.trim()).filter(Boolean))] } : {}),
    ...(change.disabledChannels ? { disabledChannels: [...new Set(change.disabledChannels.map((s) => s.trim().toLowerCase()).filter(Boolean))] } : {}),
    reason: meta.reason.trim().slice(0, 500),
    updatedAt: at,
    updatedBy: meta.by,
  };
  const backend = getBackend();
  await backend.upsertOperatorRecord({ businessId, kind: "controls", key: CONTROLS_KEY, data: after });
  const audit: ControlAudit = { id: `ctl_${Date.parse(at).toString(36)}_${Math.random().toString(36).slice(2, 8)}`, at, by: meta.by, reason: after.reason, change, before: strip(before), after: strip(after) };
  await backend.upsertOperatorRecord({ businessId, kind: "audit", key: audit.id, data: audit });
  cache.set(businessId, after);
  return { controls: after, audit };
}

export async function listControlAudit(businessId: string): Promise<ControlAudit[]> {
  const records = await getBackend().listOperatorRecords(businessId, "audit");
  return records
    .map((r) => r.data as unknown as ControlAudit)
    .filter((a) => a && typeof a.at === "string")
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ── Enforcement (policy engine) ──────────────────────────────────────────

/** Typed actions that only read; every other typed action is consequential. */
const READ_ACTIONS = new Set(["searchProducts", "checkAvailability", "checkInventory", "verifyPayment"]);

function pausedMatches(paused: string[], id: string): boolean {
  return paused.some((p) => p === id || (p.endsWith(".*") && id.startsWith(p.slice(0, -1))));
}

export type FounderControlDecision = { status: "allowed" } | { status: "requires_approval" | "denied"; reason: string; policyId: string };

/**
 * What the founder's controls say about one action, given the business's own decision. Only ever
 * tightens: allowed → requires_approval / denied; requires_approval → denied; denied stays denied.
 */
export function applyFounderControls(controls: BusinessControls, action: string, params: Record<string, unknown>, base: { status: "allowed" | "requires_approval" | "denied" }): FounderControlDecision {
  if (base.status === "denied") return { status: "allowed" };
  const generic = action === INVOKE_CAPABILITY;
  const capabilityId = generic ? String((params as { capability?: unknown }).capability ?? "") : "";
  const contract = generic ? getCapability(capabilityId) : undefined;
  const isRead = generic ? contract?.effect === "read" : READ_ACTIONS.has(action);
  const ids = generic ? [capabilityId] : [action, ...(ACTION_REQUIREMENTS[action] ?? [])];
  if (ids.some((id) => pausedMatches(controls.pausedCapabilities, id))) {
    return { status: "denied", reason: "This capability is paused by the founder until it is healthy again.", policyId: "founder_control:paused_capability" };
  }
  if (isRead) return { status: "allowed" };
  if (controls.pauseConsequentialWrites) {
    return { status: "denied", reason: "Consequential actions are paused by the founder for this business.", policyId: "founder_control:writes_paused" };
  }
  if (controls.approvalRequiredForAll && base.status === "allowed") {
    return { status: "requires_approval", reason: "Founder supervision: every consequential action needs the owner's approval right now.", policyId: "founder_control:supervised" };
  }
  return { status: "allowed" };
}

export function channelDisabled(controls: BusinessControls, channel: string): boolean {
  return controls.disabledChannels.includes(channel.toLowerCase());
}
