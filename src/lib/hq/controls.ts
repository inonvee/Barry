import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";
import { ACTION_REQUIREMENTS } from "@/lib/capabilities/model";
import { getCapability } from "@/lib/fabric/capability";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import { withConversationLock } from "@/lib/state/lock";
import { supervisedLowRisk } from "@/lib/runtime/action-risk";

/**
 * FOUNDER CONTROLS — the bounded, audited levers the founder holds over ONE business from HQ.
 *
 *  - mode: SIMULATOR (test: proactive work only dry-runs) / SUPERVISED (BARRY answers and prepares; every
 *    consequential action and proactive message waits for the owner) / LIVE (what the rules permit). Read
 *    at runtime through lib/runtime/operating-mode; the mode never loosens authority by itself.
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
  /** EMERGENCY: the business is paused — no channel is answered, nothing proactive runs, every write is refused. */
  pausedBusiness: boolean;
  /** SAFE MODE: every consequential action needs approval and proactive messages are off (reads and answers continue). */
  safeMode: boolean;
  /** Who paused the business (the identity on the change). An owner may lift only an owner's pause. */
  pausedBy: string | null;
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
  pausedBusiness: false,
  safeMode: false,
  pausedBy: null,
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
    pausedBusiness: d.pausedBusiness === true,
    safeMode: d.safeMode === true,
    pausedBy: d.pausedBusiness === true ? (typeof d.pausedBy === "string" ? d.pausedBy : "founder") : null,
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
    // Fail safe: the last controls this process saw; with none, SAFE MODE (every consequential action
    // waits for approval, nothing proactive) — never a looser reading than the stored record could be.
    console.error("[barry:controls] unavailable — using the last known controls (or safe mode)", err instanceof Error ? err.message : err);
    return cache.get(businessId) ?? { ...DEFAULT_CONTROLS, safeMode: true, reason: "controls unavailable — safe mode until they can be read" };
  }
}

/** Synchronous view for the policy engine: what the last load saw (defaults before any load). */
export function currentControls(businessId: string): BusinessControls {
  return cache.get(businessId) ?? { ...DEFAULT_CONTROLS };
}

export function resetControlsCacheForTests(): void {
  cache.clear();
}

const strip = (c: BusinessControls): ControlAudit["before"] => ({ mode: c.mode, pauseConsequentialWrites: c.pauseConsequentialWrites, approvalRequiredForAll: c.approvalRequiredForAll, pausedCapabilities: [...c.pausedCapabilities], disabledChannels: [...c.disabledChannels], pausedBusiness: c.pausedBusiness, safeMode: c.safeMode, pausedBy: c.pausedBy });

export type ControlChange = Partial<Pick<BusinessControls, "mode" | "pauseConsequentialWrites" | "approvalRequiredForAll" | "pausedCapabilities" | "disabledChannels" | "pausedBusiness" | "safeMode">>;

/**
 * Apply a founder change: durable, audited, reversible (every audit entry carries before/after).
 * `by` is the founder identity HQ authenticated; `reason` is required.
 */
export async function applyControlChange(businessId: string, change: ControlChange, meta: { by: string; reason: string; now?: Date }): Promise<{ controls: BusinessControls; audit: ControlAudit | null; changed: boolean }> {
  if (!meta.reason.trim()) throw new Error("A reason is required for every founder control change");
  // One change at a time per business (a database lease): two changes never overwrite each other.
  return withConversationLock(`controls:${businessId}`, () => applyControlChangeLocked(businessId, change, meta), { waitMs: 10_000 });
}

async function applyControlChangeLocked(businessId: string, change: ControlChange, meta: { by: string; reason: string; now?: Date }): Promise<{ controls: BusinessControls; audit: ControlAudit | null; changed: boolean }> {
  const before = await loadControls(businessId);
  const at = (meta.now ?? new Date()).toISOString();
  // NO-OP: a change that leaves every lever where it is writes nothing — no controls record, no audit entry.
  if (isNoop(before, change)) return { controls: before, audit: null, changed: false };
  const after: BusinessControls = {
    ...before,
    ...(change.mode ? { mode: change.mode } : {}),
    ...(typeof change.pauseConsequentialWrites === "boolean" ? { pauseConsequentialWrites: change.pauseConsequentialWrites } : {}),
    ...(typeof change.approvalRequiredForAll === "boolean" ? { approvalRequiredForAll: change.approvalRequiredForAll } : {}),
    ...(change.pausedCapabilities ? { pausedCapabilities: [...new Set(change.pausedCapabilities.map((s) => s.trim()).filter(Boolean))] } : {}),
    ...(change.disabledChannels ? { disabledChannels: [...new Set(change.disabledChannels.map((s) => s.trim().toLowerCase()).filter(Boolean))] } : {}),
    ...(typeof change.pausedBusiness === "boolean" ? { pausedBusiness: change.pausedBusiness, pausedBy: change.pausedBusiness ? (before.pausedBusiness ? before.pausedBy : meta.by) : null } : {}),
    ...(typeof change.safeMode === "boolean" ? { safeMode: change.safeMode } : {}),
    reason: meta.reason.trim().slice(0, 500),
    updatedAt: at,
    updatedBy: meta.by,
  };
  const backend = getBackend();
  await backend.upsertOperatorRecord({ businessId, kind: "controls", key: CONTROLS_KEY, data: after });
  const audit: ControlAudit = { id: `ctl_${Date.parse(at).toString(36)}_${Math.random().toString(36).slice(2, 8)}`, at, by: meta.by, reason: after.reason, change, before: strip(before), after: strip(after) };
  await backend.upsertOperatorRecord({ businessId, kind: "audit", key: audit.id, data: audit });
  cache.set(businessId, after);
  return { controls: after, audit, changed: true };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** True when applying `change` to `before` would leave every lever as it is. */
export function isNoop(before: BusinessControls, change: ControlChange): boolean {
  if (change.mode !== undefined && change.mode !== before.mode) return false;
  if (typeof change.pauseConsequentialWrites === "boolean" && change.pauseConsequentialWrites !== before.pauseConsequentialWrites) return false;
  if (typeof change.approvalRequiredForAll === "boolean" && change.approvalRequiredForAll !== before.approvalRequiredForAll) return false;
  if (change.pausedCapabilities && !sameList([...new Set(change.pausedCapabilities.map((s) => s.trim()).filter(Boolean))], before.pausedCapabilities)) return false;
  if (change.disabledChannels && !sameList([...new Set(change.disabledChannels.map((s) => s.trim().toLowerCase()).filter(Boolean))], before.disabledChannels)) return false;
  if (typeof change.pausedBusiness === "boolean" && change.pausedBusiness !== before.pausedBusiness) return false;
  if (typeof change.safeMode === "boolean" && change.safeMode !== before.safeMode) return false;
  return true;
}

/** Plain words for each founder control: what it does, its scope, its effect and how it is reversed. */
export const CONTROL_ACTIONS = {
  pause_writes: { title: "Pause consequential actions", effect: "Every consequential action (carts, checkouts, bookings, tickets, approval requests) is refused for this business. Reads and answers continue.", reversibility: "Resume with one action; the audit shows both." },
  require_approval: { title: "Require approval for everything", effect: "Every consequential action the business's own rules would allow now waits for the owner's approval. Nothing the rules deny is loosened.", reversibility: "Lift with one action; pending requests stay pending." },
  pause_capability: { title: "Pause a capability", effect: "The named capability (or family, e.g. support.*) is refused until unpaused — for an unhealthy provider or an incident.", reversibility: "Unpause by name." },
  disable_channel: { title: "Disable a channel", effect: "BARRY stops answering on that channel; inbound messages are refused and logged. Nothing is sent.", reversibility: "Enable the channel again." },
  pause_business: { title: "Pause the business", effect: "BARRY stops answering on every channel, refuses every consequential action and sends nothing proactive. Nothing is deleted.", reversibility: "Resume with one action; the audit shows both." },
  safe_mode: { title: "Safe mode", effect: "Every consequential action needs the owner's approval, and BARRY sends nothing proactive. Reads and answers continue.", reversibility: "Leave safe mode with one action." },
  change_mode: { title: "Change the operating mode", effect: "SIMULATOR: test only — proactive work is a dry run, nothing reaches a customer or owner line on its own. SUPERVISED: BARRY answers and prepares; every consequential action and every proactive message waits for the owner. LIVE: what the business's rules permit. The mode never loosens the rules themselves.", reversibility: "Set another mode." },
} as const;

export async function listControlAudit(businessId: string): Promise<ControlAudit[]> {
  const records = await getBackend().listOperatorRecords(businessId, "audit");
  return records
    .map((r) => r.data as unknown as ControlAudit)
    .filter((a) => a && typeof a.at === "string")
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** One line for an audit entry: what changed and why. */
export function describeChange(a: ControlAudit): string {
  const parts: string[] = [];
  if (a.change.mode) parts.push(`mode → ${a.change.mode}`);
  if (typeof a.change.pauseConsequentialWrites === "boolean") parts.push(a.change.pauseConsequentialWrites ? "consequential writes paused" : "writes resumed");
  if (typeof a.change.approvalRequiredForAll === "boolean") parts.push(a.change.approvalRequiredForAll ? "human-only (approval for everything)" : "approval-for-everything lifted");
  if (a.change.pausedCapabilities) parts.push(a.change.pausedCapabilities.length ? `paused: ${a.change.pausedCapabilities.join(", ")}` : "no capabilities paused");
  if (a.change.disabledChannels) parts.push(a.change.disabledChannels.length ? `channels disabled: ${a.change.disabledChannels.join(", ")}` : "all channels enabled");
  if (typeof a.change.pausedBusiness === "boolean") parts.push(a.change.pausedBusiness ? "business paused" : "business resumed");
  if (typeof a.change.safeMode === "boolean") parts.push(a.change.safeMode ? "safe mode on" : "safe mode off");
  return parts.length ? `${parts.join("; ")} — ${a.reason}` : a.reason;
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
  if (controls.pausedBusiness) {
    return { status: "denied", reason: "This business is paused by the founder.", policyId: "founder_control:business_paused" };
  }
  if (isRead) return { status: "allowed" };
  if (controls.pauseConsequentialWrites) {
    return { status: "denied", reason: "Consequential actions are paused by the founder for this business.", policyId: "founder_control:writes_paused" };
  }
  if ((controls.approvalRequiredForAll || controls.safeMode) && base.status === "allowed") {
    return { status: "requires_approval", reason: controls.safeMode ? "Safe mode: every consequential action needs the owner's approval right now." : "Founder supervision: every consequential action needs the owner's approval right now.", policyId: controls.safeMode ? "founder_control:safe_mode" : "founder_control:supervised" };
  }
  // SUPERVISED: reversible, low-risk operational work (a cart, a support case) runs on the business's own
  // rules; money, checkout, orders, bookings, refunds and anything else consequential wait for the owner.
  if (controls.mode === "supervised" && base.status === "allowed" && !supervisedLowRisk(action, params)) {
    return { status: "requires_approval", reason: "Supervised mode: this action involves money or a commitment, so it needs the owner's approval.", policyId: "operating_mode:supervised" };
  }
  return { status: "allowed" };
}

export function channelDisabled(controls: BusinessControls, channel: string): boolean {
  return controls.pausedBusiness || controls.disabledChannels.includes(channel.toLowerCase());
}
