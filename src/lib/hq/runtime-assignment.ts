import { createHash } from "node:crypto";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";
import { BARRY_RUNTIME_VERSION, runtimeCommit } from "@/lib/runtime/version";
import { CONSTITUTION_VERSION } from "@/lib/reasoner/constitution";
import { modelFor, reasoningEffortFor } from "@/lib/reasoner/model-config";
import { resolveCapabilityProfiles } from "@/lib/capabilities";

/**
 * RUNTIME / VERSION ASSIGNMENT — which runtime version, Constitution, reasoner, composer, capability
 * profile and playbook / Genome revision a business runs, as an auditable record: a new entry is
 * written only when something changed, with the previous assignment kept.
 */

export type RuntimeAssignment = {
  businessId: string;
  at: string;
  runtime: { version: string; commit: string | null };
  constitution: string;
  reasoner: { model: string; effort: string | null };
  composer: { model: string; effort: string | null };
  capabilityProfile: Record<string, { provider: string | null; simulated: boolean; capabilities: number }>;
  genomeRevision: string;
  playbookRevision: string;
  fingerprint: string;
};

export function genomeRevision(graph: BusinessGraph): string {
  const { playbook: _p, ...rest } = graph;
  void _p;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 12);
}

export function playbookRevision(graph: BusinessGraph): string {
  return createHash("sha256").update(JSON.stringify(graph.playbook)).digest("hex").slice(0, 12);
}

export async function currentAssignment(graph: BusinessGraph, now = new Date()): Promise<RuntimeAssignment> {
  const profiles = await resolveCapabilityProfiles(graph).catch(() => undefined);
  const capabilityProfile: RuntimeAssignment["capabilityProfile"] = {};
  if (profiles) for (const p of Object.values(profiles)) if (p.used || p.status === "connected") capabilityProfile[p.capability] = { provider: p.provider, simulated: p.simulated, capabilities: p.capabilities.length };
  const base = {
    businessId: graph.business.id,
    runtime: { version: BARRY_RUNTIME_VERSION, commit: runtimeCommit() },
    constitution: CONSTITUTION_VERSION,
    reasoner: { model: modelFor("reasoner"), effort: reasoningEffortFor("reasoner") ?? null },
    composer: { model: modelFor("composer"), effort: reasoningEffortFor("composer") ?? null },
    capabilityProfile,
    genomeRevision: genomeRevision(graph),
    playbookRevision: playbookRevision(graph),
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 16);
  return { ...base, at: now.toISOString(), fingerprint };
}

export async function listAssignments(businessId: string): Promise<RuntimeAssignment[]> {
  const records = await getBackend().listOperatorRecords(businessId, "runtime_assignment");
  return records.map((r: OperatorRecord) => r.data as unknown as RuntimeAssignment).filter((a) => a && typeof a.fingerprint === "string").sort((a, b) => b.at.localeCompare(a.at));
}

/** Record the current assignment when it differs from the latest recorded one. Returns whether it changed. */
export async function trackAssignment(graph: BusinessGraph, now = new Date()): Promise<{ assignment: RuntimeAssignment; changed: boolean; previous: RuntimeAssignment | null }> {
  const current = await currentAssignment(graph, now);
  const [latest] = await listAssignments(graph.business.id);
  if (latest && latest.fingerprint === current.fingerprint) return { assignment: latest, changed: false, previous: null };
  await getBackend().upsertOperatorRecord({ businessId: graph.business.id, kind: "runtime_assignment", key: `${current.at}:${current.fingerprint}`, data: current });
  return { assignment: current, changed: true, previous: latest ?? null };
}
