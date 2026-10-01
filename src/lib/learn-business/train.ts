import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { enabledCapabilities } from "./strategy";
import { listSources, sourceFreshness, sourceWords } from "./sources";
import { listLearningChanges } from "./relearn";
import { detectLearningBlockers } from "./conflicts";
import { effectiveGenome } from "./genome";
import { operatingPlays } from "./plays";

/**
 * TRAIN BARRY — the owner's view of teaching: what BARRY understands, what it is unsure about, what
 * changed, what needs confirmation, what it can do now / after setup, and what to teach next. Owner
 * words only; no internal setting names. Everything is derived from the same records the runtime uses.
 */
export async function trainBarryView(graph: BusinessGraph, now = new Date()) {
  const backend = getBackend();
  const businessId = graph.business.id;
  const [facts, sources, changes, profiles] = await Promise.all([backend.listLearnedFacts(businessId), listSources(businessId), listLearningChanges(businessId), resolveCapabilityProfiles(graph)]);
  const capabilities = enabledCapabilities(graph);
  const blockers = detectLearningBlockers({ facts, sources, changes, capabilities, now });
  const genome = effectiveGenome({ graph, facts, sources, profiles, now });
  const plays = operatingPlays({ graph, facts, profiles });
  const words = (key: string) => key.replace(/\./g, " ").replace(/_/g, " ");
  const understands = genome.filter((g) => g.effective && g.origin !== "connected_system").map((g) => ({ key: g.key, label: words(g.key), value: g.value, why: g.why, from: g.from, lastChecked: g.lastChecked, ownerApproved: g.ownerApproved, freshness: g.freshness }));
  const unsure = facts.filter((f) => f.status === "candidate").map((f) => ({ factId: f.id, key: f.key, label: words(f.key), value: f.value, from: sourceWords(f), confidence: f.confidence, classification: f.classification }));
  const recent = changes.filter((c) => now.getTime() - Date.parse(c.at) <= 30 * 24 * 3600_000).slice(0, 20).map((c) => ({ changeId: c.id, key: c.key, label: words(c.key), kind: c.kind, impact: c.impact, previous: c.previous ?? null, proposed: c.proposed ?? null, decision: c.decision, why: c.why, at: c.at }));
  const needsConfirmation = blockers.filter((b) => b.kind !== "missing").map((b) => ({ id: b.id, kind: b.kind, label: b.key ? words(b.key) : "a source", question: b.question, explanation: b.explanation, severity: b.severity, refs: b.refs }));
  const teachNext = blockers.filter((b) => b.kind === "missing").map((b) => ({ id: b.id, key: b.key!, label: words(b.key!), question: b.question, why: b.explanation, severity: b.severity }));
  return {
    business: { id: businessId, name: graph.business.name },
    sources: sources.map((s) => ({ id: s.id, type: s.type, ref: s.ref, status: s.status, freshness: sourceFreshness(s, now), approvedBy: s.approvedBy, approvedAt: s.approvedAt, lastSucceededAt: s.lastSucceededAt ?? null, lastResult: s.lastResult ?? null })),
    understands,
    unsure,
    changed: recent,
    needsConfirmation,
    canDoNow: plays.filter((p) => p.availability === "can_do_now"),
    afterSetup: plays.filter((p) => p.availability === "after_setup" || p.availability === "simulator_only"),
    notSupported: plays.filter((p) => p.availability === "not_supported"),
    teachNext,
    counts: { understands: understands.length, unsure: unsure.length, needsConfirmation: needsConfirmation.length, teachNext: teachNext.length },
  };
}

export type TrainBarryView = Awaited<ReturnType<typeof trainBarryView>>;
