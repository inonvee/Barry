import type { LearnedFactRecord } from "@/lib/store/types";
import { assessRequirements, type OperatingCapability } from "./strategy";
import { factSourceId, sourceFreshness, type LearnedSource } from "./sources";
import type { LearningChange } from "./relearn";

/**
 * CONFLICT / STALENESS ENGINE — explainable blockers over the learned facts and their sources:
 * conflicting values on a consequential key, stale facts behind a critical requirement, missing
 * critical facts, low-confidence critical facts, and sources that disappeared. Every blocker carries
 * the ONE question that resolves it. Pure; deterministic in `now`.
 */

export type BlockerKind = "conflict" | "stale" | "missing" | "low_confidence" | "source_disappeared" | "unreviewed";

export type LearningBlocker = {
  id: string;
  kind: BlockerKind;
  severity: "high" | "medium" | "low";
  key?: string;
  capability?: OperatingCapability | "core";
  explanation: string;
  question: string;
  /** Record ids the owner can act on (fact id or change id). */
  refs: { factId?: string; changeId?: string; sourceId?: string };
};

const STALE_AFTER_MS = 45 * 24 * 3600_000;
const CRITICAL = (key: string) => /^(price|pricing|policy|hours|authority|contact|payment|shipping|delivery)\./.test(key) || key === "business.name";

export function detectLearningBlockers(input: { facts: LearnedFactRecord[]; sources: LearnedSource[]; changes?: LearningChange[]; capabilities: OperatingCapability[]; now: Date }): LearningBlocker[] {
  const { facts, sources, now } = input;
  const out: LearningBlocker[] = [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  // 1. Conflicts and consequential updates waiting for a decision.
  for (const c of input.changes ?? []) {
    if (c.decision !== "pending") continue;
    if (c.kind === "conflict") out.push({ id: `conflict:${c.id}`, kind: "conflict", severity: "high", key: c.key, explanation: `${c.key.replace(/\./g, " ")}: the source now says “${c.proposed}”, you approved “${c.previous}”.`, question: `Which is right for ${c.key.replace(/\./g, " ")}: “${c.previous}” (yours) or “${c.proposed}” (the source)?`, refs: { changeId: c.id } });
    else if (c.impact === "consequential") out.push({ id: `change:${c.id}`, kind: "unreviewed", severity: "medium", key: c.key, explanation: `${c.key.replace(/\./g, " ")} ${c.kind === "new" ? "was learned" : "changed"}: “${c.proposed}”.`, question: `Confirm ${c.key.replace(/\./g, " ")} = “${c.proposed}”?`, refs: { changeId: c.id } });
  }

  // 2. Missing critical facts (the minimum question each).
  const req = assessRequirements(input.capabilities, facts);
  for (const q of req.questions) out.push({ id: `missing:${q.key}`, kind: "missing", severity: q.kind === "owner_decision" ? "high" : "medium", key: q.key, capability: q.capability, explanation: q.reason, question: q.question, refs: {} });
  for (const r of req.needsReview) {
    const f = facts.find((x) => x.id === r.factId);
    if (!f) continue;
    if (out.some((b) => b.key === f.key)) continue;
    out.push({ id: `unreviewed:${f.key}`, kind: "unreviewed", severity: "medium", key: f.key, capability: r.capability, explanation: `“${f.value}” was learned but you have not confirmed it.`, question: `Is “${f.value}” right for ${f.key.replace(/\./g, " ")}?`, refs: { factId: f.id } });
  }

  // 3. Low confidence on a critical, unverified fact.
  for (const f of facts) {
    if (!CRITICAL(f.key) || f.ownerVerified || f.status === "rejected" || f.confidence !== "low") continue;
    if (out.some((b) => b.key === f.key)) continue;
    out.push({ id: `low_confidence:${f.key}`, kind: "low_confidence", severity: "medium", key: f.key, explanation: `BARRY is not sure about ${f.key.replace(/\./g, " ")} (“${f.value}”).`, question: `Is “${f.value}” right for ${f.key.replace(/\./g, " ")}?`, refs: { factId: f.id } });
  }

  // 4. Stale critical facts and disappeared sources.
  for (const f of facts) {
    if (!CRITICAL(f.key) || f.status === "rejected") continue;
    const sid = factSourceId(f);
    const src = sid ? sourceById.get(sid) : undefined;
    if (src && (src.status === "disappeared" || src.status === "revoked")) {
      if (!out.some((b) => b.id === `source:${src.id}`)) out.push({ id: `source:${src.id}`, kind: "source_disappeared", severity: "medium", explanation: `The source “${src.ref}” can no longer be read; facts learned from it cannot be refreshed.`, question: `Is “${src.ref}” still the right source, or should BARRY learn from another one?`, refs: { sourceId: src.id } });
      continue;
    }
    const freshness = src ? sourceFreshness(src, now) : null;
    const age = now.getTime() - Date.parse(f.refreshedAt);
    if ((freshness === "stale" || age > STALE_AFTER_MS) && f.source.kind !== "owner") {
      if (out.some((b) => b.key === f.key)) continue;
      out.push({ id: `stale:${f.key}`, kind: "stale", severity: "low", key: f.key, explanation: `${f.key.replace(/\./g, " ")} (“${f.value}”) was last checked ${Math.round(age / 86_400_000)} days ago.`, question: `Is “${f.value}” still right for ${f.key.replace(/\./g, " ")}?`, refs: { factId: f.id, ...(src ? { sourceId: src.id } : {}) } });
    }
  }
  const sev = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id));
}
