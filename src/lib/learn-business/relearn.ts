import { getBackend } from "@/lib/store";
import type { LearnedFactRecord, OperatorRecord } from "@/lib/store/types";

/**
 * CONTINUOUS RE-LEARNING — when a source is read again, every difference is a classified CHANGE:
 * consequential (prices, hours, policies, authority, contact, delivery) or informational. A
 * consequential change to something the owner already approved NEVER takes effect by itself: it is
 * recorded as a review item and the approved value keeps operating until the owner decides. Every
 * change is audited (what, from which source, when, what the owner did).
 */

export type ChangeImpact = "consequential" | "informational";
export type ChangeKind = "new" | "updated" | "conflict" | "removed";
export type ChangeDecision = "pending" | "accepted" | "kept_previous" | "auto_applied";

export type LearningChange = {
  id: string;
  businessId: string;
  runId?: string;
  key: string;
  kind: ChangeKind;
  impact: ChangeImpact;
  previous?: string;
  proposed?: string;
  /** Where the proposed value came from (source id / url / system). */
  source: string;
  at: string;
  decision: ChangeDecision;
  decidedBy?: string;
  decidedAt?: string;
  /** Why the owner must look (plain words). */
  why: string;
};

const CONSEQUENTIAL_PREFIXES = ["price", "pricing", "policy", "hours", "authority", "contact", "payment", "shipping", "delivery", "deposit", "cancellation", "refund"];

/** Pure: does a change to this key change how BARRY treats customers or money? */
export function changeImpact(key: string): ChangeImpact {
  const head = key.split(".")[0];
  return CONSEQUENTIAL_PREFIXES.includes(head) || /\.(price|hours|policy|fee|cost)$/.test(key) ? "consequential" : "informational";
}

const approved = (f: LearnedFactRecord | undefined) => Boolean(f && f.ownerVerified && (f.status === "verified" || f.status === "corrected"));

/** Pure: classify one candidate against the prior record for its key. `null` when nothing changed. */
export function classifyChange(prior: LearnedFactRecord | undefined, candidate: { key: string; value: string }, source: string, at: string, runId?: string): LearningChange | null {
  const impact = changeImpact(candidate.key);
  const base = { businessId: prior?.businessId ?? "", runId, key: candidate.key, impact, source, at, proposed: candidate.value, why: "" };
  if (!prior) return { ...base, id: `${candidate.key}:${at}`, kind: "new", decision: impact === "consequential" ? "pending" : "auto_applied", why: impact === "consequential" ? "A new fact that changes how BARRY treats customers or money needs your confirmation before BARRY uses it." : "Informational; BARRY may mention it once it is verified." };
  if (prior.value === candidate.value) return null;
  if (approved(prior)) return { ...base, id: `${candidate.key}:${at}`, kind: "conflict", previous: prior.value, decision: "pending", why: `The source now says “${candidate.value}” but you approved “${prior.value}”. BARRY keeps your approved value until you decide.` };
  return { ...base, id: `${candidate.key}:${at}`, kind: "updated", previous: prior.value, decision: impact === "consequential" ? "pending" : "auto_applied", why: impact === "consequential" ? "The source changed a consequential fact; confirm the new value before BARRY uses it." : "The source changed an informational fact." };
}

export async function recordLearningChanges(businessId: string, changes: LearningChange[]): Promise<void> {
  const backend = getBackend();
  for (const c of changes) await backend.upsertOperatorRecord({ businessId, kind: "learning_change", key: c.id, data: { ...c, businessId } });
}

export async function listLearningChanges(businessId: string): Promise<LearningChange[]> {
  const records = await getBackend().listOperatorRecords(businessId, "learning_change");
  return records.map((r: OperatorRecord) => r.data as unknown as LearningChange).filter((c) => c && typeof c.key === "string").sort((a, b) => b.at.localeCompare(a.at));
}

/** The owner decides a pending consequential change: accept the proposed value, or keep the previous one. */
export async function decideLearningChange(input: { businessId: string; changeId: string; decision: "accepted" | "kept_previous"; by: string; now?: Date }): Promise<LearningChange | undefined> {
  const backend = getBackend();
  const change = (await listLearningChanges(input.businessId)).find((c) => c.id === input.changeId);
  if (!change || change.decision !== "pending") return change;
  const at = (input.now ?? new Date()).toISOString();
  if (input.decision === "accepted" && change.proposed !== undefined) {
    const prior = (await backend.listLearnedFacts(input.businessId)).find((f) => f.key === change.key);
    if (prior) {
      const { id: _id, ...base } = prior;
      void _id;
      await backend.upsertLearnedFact({ ...base, value: change.proposed, correctedFrom: prior.value !== change.proposed ? prior.value : prior.correctedFrom, status: "verified", ownerVerified: true, confidence: "high", reviewedBy: input.by, reviewedAt: at, refreshedAt: at });
    }
  }
  const next: LearningChange = { ...change, decision: input.decision, decidedBy: input.by, decidedAt: at };
  await backend.upsertOperatorRecord({ businessId: input.businessId, kind: "learning_change", key: next.id, data: next });
  return next;
}
