import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import { applyControlChange, loadControls, isNoop, type ControlChange, type BusinessControls } from "./controls";
import { fleetTenantIds } from "./fleet";

/**
 * ASK HQ BARRY V2 — STRUCTURED CHANGE PROPOSALS. A free-text instruction never mutates anything: it
 * becomes a proposal with a scope (GLOBAL / CAPABILITY / BUSINESS / TEMPORARY), the affected
 * businesses, conflicts with current state, a risk level, a diff, and a versioned lifecycle:
 * proposed → approved → activated (or rejected / rolled back). Only BUSINESS and TEMPORARY proposals
 * of founder-control changes can be activated today, through the same audited control path; GLOBAL
 * and CAPABILITY proposals stay approved-but-gated until a global activation model exists.
 */

export type ProposalScope = "GLOBAL" | "CAPABILITY" | "BUSINESS" | "TEMPORARY";
export type ProposalStatus = "proposed" | "approved" | "rejected" | "activated" | "rolled_back";
export type ProposalRisk = "low" | "medium" | "high";

export type ChangeProposal = {
  id: string;
  version: number;
  instruction: string;
  scope: ProposalScope;
  change: ControlChange;
  /** For CAPABILITY scope: the capability id / family the change is about. */
  capability?: string;
  /** For TEMPORARY scope: when it should be rolled back. */
  until?: string;
  affectedBusinesses: string[];
  conflicts: string[];
  risk: ProposalRisk;
  diff: { businessId: string; before: Partial<BusinessControls>; after: Partial<BusinessControls> }[];
  status: ProposalStatus;
  activation: "gated" | "available";
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  activatedAt?: string;
  rolledBackAt?: string;
  history: { at: string; by: string; status: ProposalStatus; note?: string }[];
};

const KEYS: (keyof ControlChange)[] = ["mode", "pauseConsequentialWrites", "approvalRequiredForAll", "pausedCapabilities", "disabledChannels", "pausedBusiness", "safeMode"];

export function riskOf(change: ControlChange, scope: ProposalScope, affected: number): ProposalRisk {
  if (change.pausedBusiness || change.mode === "live" || (scope === "GLOBAL" && affected > 1)) return "high";
  if (change.pauseConsequentialWrites || change.safeMode || change.disabledChannels?.length || change.pausedCapabilities?.length) return "medium";
  return "low";
}

/** Build the proposal from a structured instruction; never applies anything. */
export async function proposeChange(input: { instruction: string; scope: ProposalScope; change: ControlChange; businessIds?: string[]; capability?: string; until?: string; by: string; now?: Date }): Promise<ChangeProposal> {
  const at = (input.now ?? new Date()).toISOString();
  const affected = input.scope === "GLOBAL" || input.scope === "CAPABILITY" ? fleetTenantIds() : (input.businessIds ?? []).filter((id) => fleetTenantIds().includes(id));
  if (!affected.length) throw new Error("A proposal must affect at least one known business");
  const change: ControlChange = Object.fromEntries(Object.entries(input.change).filter(([k, v]) => KEYS.includes(k as keyof ControlChange) && v !== undefined)) as ControlChange;
  if (input.scope === "CAPABILITY" && input.capability) change.pausedCapabilities = [...new Set([...(change.pausedCapabilities ?? []), input.capability])];
  if (!Object.keys(change).length) throw new Error("A proposal must change at least one control");
  const diff: ChangeProposal["diff"] = [];
  const conflicts: string[] = [];
  for (const id of affected) {
    const before = await loadControls(id);
    if (isNoop(before, change)) conflicts.push(`${id}: already in that state`);
    if (change.pausedBusiness === false && !before.pausedBusiness) conflicts.push(`${id}: not paused`);
    if (change.mode === "live" && before.mode === "simulator") conflicts.push(`${id}: jumps from SIMULATOR straight to LIVE`);
    const after = { ...before, ...change };
    diff.push({ businessId: id, before: Object.fromEntries(Object.keys(change).map((k) => [k, before[k as keyof BusinessControls]])), after: Object.fromEntries(Object.keys(change).map((k) => [k, after[k as keyof BusinessControls]])) });
  }
  const proposal: ChangeProposal = {
    id: `prop_${Date.parse(at).toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    version: 1,
    instruction: input.instruction.trim().slice(0, 1000),
    scope: input.scope,
    change,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.until ? { until: input.until } : {}),
    affectedBusinesses: affected,
    conflicts,
    risk: riskOf(change, input.scope, affected.length),
    diff,
    status: "proposed",
    activation: input.scope === "BUSINESS" || input.scope === "TEMPORARY" ? "available" : "gated",
    proposedBy: input.by,
    proposedAt: at,
    history: [{ at, by: input.by, status: "proposed" }],
  };
  await save(proposal);
  return proposal;
}

async function save(p: ChangeProposal): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "hq_proposal", key: p.id, data: p });
}

export async function listProposals(): Promise<ChangeProposal[]> {
  const records = await getBackend().listOperatorRecords(FLEET_SCOPE, "hq_proposal");
  return records.map((r: OperatorRecord) => r.data as unknown as ChangeProposal).filter((p) => p && typeof p.id === "string").sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
}

export async function decideProposal(input: { id: string; decision: "approved" | "rejected"; by: string; note?: string; now?: Date }): Promise<ChangeProposal | undefined> {
  const p = (await listProposals()).find((x) => x.id === input.id);
  if (!p || p.status !== "proposed") return p;
  const at = (input.now ?? new Date()).toISOString();
  const next: ChangeProposal = { ...p, status: input.decision, decidedBy: input.by, decidedAt: at, history: [...p.history, { at, by: input.by, status: input.decision, ...(input.note ? { note: input.note } : {}) }] };
  await save(next);
  return next;
}

/** Activation: approved + available scope → the audited control change per business, with the reason stamped. GLOBAL / CAPABILITY stay gated. */
export async function activateProposal(input: { id: string; by: string; now?: Date }): Promise<{ proposal: ChangeProposal | undefined; applied: string[]; refused?: string }> {
  const p = (await listProposals()).find((x) => x.id === input.id);
  if (!p) return { proposal: undefined, applied: [] };
  if (p.status !== "approved") return { proposal: p, applied: [], refused: `proposal is ${p.status}, not approved` };
  if (p.activation !== "available") return { proposal: p, applied: [], refused: `${p.scope} activation is gated: no fleet-wide activation model yet` };
  const at = (input.now ?? new Date()).toISOString();
  const applied: string[] = [];
  for (const id of p.affectedBusinesses) {
    const r = await applyControlChange(id, p.change, { by: input.by, reason: `proposal ${p.id} v${p.version}: ${p.instruction}`.slice(0, 500), now: input.now });
    if (r.changed) applied.push(id);
  }
  const next: ChangeProposal = { ...p, status: "activated", version: p.version + 1, activatedAt: at, history: [...p.history, { at, by: input.by, status: "activated", note: `${applied.length} business(es) changed` }] };
  await save(next);
  return { proposal: next, applied };
}

/** Roll back an activated proposal by restoring each business's recorded `before` values. */
export async function rollbackProposal(input: { id: string; by: string; now?: Date }): Promise<{ proposal: ChangeProposal | undefined; restored: string[] }> {
  const p = (await listProposals()).find((x) => x.id === input.id);
  if (!p || p.status !== "activated") return { proposal: p, restored: [] };
  const at = (input.now ?? new Date()).toISOString();
  const restored: string[] = [];
  for (const d of p.diff) {
    const r = await applyControlChange(d.businessId, d.before as ControlChange, { by: input.by, reason: `rollback of proposal ${p.id}`, now: input.now });
    if (r.changed) restored.push(d.businessId);
  }
  const next: ChangeProposal = { ...p, status: "rolled_back", version: p.version + 1, rolledBackAt: at, history: [...p.history, { at, by: input.by, status: "rolled_back", note: `${restored.length} business(es) restored` }] };
  await save(next);
  return { proposal: next, restored };
}
