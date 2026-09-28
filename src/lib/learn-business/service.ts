import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import type { LearnedFactRecord, LearningRunRecord } from "@/lib/store";
import { parseSourceDocument } from "./document";
import { groundCandidateFacts } from "./grounding";
import { getBusinessLearner, type BusinessLearner } from "./learner";
import { safeFetchSource, validateSourceUrl, type HostResolver, type SafeFetchLimits, type SourceTransport } from "./safe-fetch";
import { buildCapabilityReport, buildOperatingStrategy, buildReadiness, enabledCapabilities } from "./strategy";
import { detectStack, stackFactKey } from "./stack";
import { resolveCapabilityProfiles } from "@/lib/capabilities";

/**
 * Learn Business: owner-approved URL -> bounded safe fetch -> parse ->
 * model proposes facts with quotes -> provenance grounding -> persisted
 * CANDIDATES -> owner verifies / corrects / rejects -> operating strategy
 * + readiness. Owner decisions are never overwritten by re-learning.
 */

export const MAX_SOURCES_PER_RUN = 8;

export class LearnBusinessInputError extends Error {}

type FetchOptions = { resolve?: HostResolver; transport?: SourceTransport; limits?: Partial<SafeFetchLimits> };

function ownerApproved(fact: LearnedFactRecord): boolean {
  return fact.ownerVerified && (fact.status === "verified" || fact.status === "corrected");
}

function reviewedClassification(key: string, current: LearnedFactRecord["classification"]): LearnedFactRecord["classification"] {
  // Owner-approved rules become operating POLICY; an inference the owner
  // confirms becomes a FACT; a recommendation stays advisory.
  if (key.startsWith("policy.") || key.startsWith("authority.")) return "policy";
  if (current === "policy" || current === "inference") return "fact";
  return current;
}

export async function runLearning(input: {
  graph: BusinessGraph;
  urls: string[];
  approvedBy: string;
  learner?: BusinessLearner;
  fetch?: FetchOptions;
}): Promise<{ run: LearningRunRecord; workspace: Awaited<ReturnType<typeof getLearningWorkspace>> }> {
  const urls = [...new Set(input.urls.map((u) => u.trim()).filter(Boolean))];
  if (urls.length === 0) throw new LearnBusinessInputError("Approve at least one source URL");
  if (urls.length > MAX_SOURCES_PER_RUN) throw new LearnBusinessInputError(`At most ${MAX_SOURCES_PER_RUN} sources per run`);
  for (const url of urls) {
    try {
      validateSourceUrl(url);
    } catch (err) {
      throw new LearnBusinessInputError(`${url}: ${(err as Error).message}`);
    }
  }

  const backend = getBackend();
  const businessId = input.graph.business.id;
  const approvedAt = new Date().toISOString();
  const learner = input.learner ?? getBusinessLearner();
  let run = await backend.createLearningRun({
    businessId,
    status: "fetching",
    approvedSources: urls.map((url) => ({ url, approvedBy: input.approvedBy, approvedAt })),
    summary: { learner: learner.name },
  });

  const existing = new Map((await backend.listLearnedFacts(businessId)).map((f) => [f.key, f]));
  const sources: Record<string, unknown>[] = [];
  let stored = 0;

  for (const url of urls) {
    try {
      const fetched = await safeFetchSource(url, input.fetch);
      const doc = parseSourceDocument(fetched.finalUrl, fetched.body, fetched.contentType, fetched.truncated);
      const candidates = await learner.extract(doc);
      const { facts, rejected } = groundCandidateFacts(doc, candidates);
      // Learn Stack: which systems the business already runs (fingerprints in the raw page).
      if (fetched.contentType.includes("html")) {
        for (const signal of detectStack(fetched.body)) {
          facts.push({
            key: stackFactKey(signal),
            value: signal.platform,
            classification: "inference",
            quote: signal.evidence,
            confidence: "medium",
            sourceUrl: doc.url,
            sourceTitle: doc.title,
          });
        }
      }
      const skipped: { key: string; reason: string }[] = [];
      for (const fact of facts) {
        const prior = existing.get(fact.key);
        if (prior && ownerApproved(prior)) {
          skipped.push({ key: fact.key, reason: "owner already decided this" });
          continue;
        }
        if (prior && prior.status === "rejected" && prior.value === fact.value) {
          skipped.push({ key: fact.key, reason: "owner rejected this value" });
          continue;
        }
        const now = new Date().toISOString();
        const saved = await backend.upsertLearnedFact({
          businessId,
          runId: run.id,
          key: fact.key,
          value: fact.value,
          classification: fact.classification,
          source: { kind: "web", url: fact.sourceUrl, title: fact.sourceTitle, quote: fact.quote },
          confidence: fact.confidence,
          status: "candidate",
          ownerVerified: false,
          discoveredAt: prior?.discoveredAt ?? now,
          refreshedAt: now,
        });
        existing.set(saved.key, saved);
        stored += 1;
      }
      sources.push({ url, finalUrl: fetched.finalUrl, ok: true, truncated: fetched.truncated, redirects: fetched.redirects, candidates: candidates.length, stored: facts.length - skipped.length, rejected, skipped });
    } catch (err) {
      sources.push({ url, ok: false, error: (err as Error).message });
    }
  }

  const connections = await backend.listBusinessConnections(businessId);
  const profiles = await resolveCapabilityProfiles(input.graph);
  const readiness = buildReadiness({ capabilities: enabledCapabilities(input.graph), facts: [...existing.values()], connections, profiles });
  const anyOk = sources.some((s) => s.ok);
  run = await backend.updateLearningRun(run.id, {
    status: !anyOk ? "failed" : readiness.questions.length + readiness.needsReview.length > 0 ? "needs_owner" : "ready",
    summary: { learner: learner.name, sources, storedFacts: stored },
  });
  return { run, workspace: await getLearningWorkspace(input.graph) };
}

export async function reviewLearnedFact(input: {
  businessId: string;
  factId: string;
  action: "verify" | "correct" | "reject";
  value?: string;
  reviewedBy: string;
}): Promise<LearnedFactRecord> {
  const backend = getBackend();
  const fact = (await backend.listLearnedFacts(input.businessId)).find((f) => f.id === input.factId);
  if (!fact) throw new LearnBusinessInputError("Fact not found for this business");
  const reviewedAt = new Date().toISOString();
  const { id: _id, ...base } = fact;
  void _id;
  switch (input.action) {
    case "verify":
      return backend.upsertLearnedFact({ ...base, status: "verified", ownerVerified: true, classification: reviewedClassification(fact.key, fact.classification), reviewedBy: input.reviewedBy, reviewedAt });
    case "correct": {
      const value = input.value?.trim();
      if (!value || value.length > 500) throw new LearnBusinessInputError("A corrected value is required");
      return backend.upsertLearnedFact({
        ...base,
        value,
        correctedFrom: fact.correctedFrom ?? fact.value,
        status: "corrected",
        ownerVerified: true,
        confidence: "high",
        classification: reviewedClassification(fact.key, fact.classification),
        reviewedBy: input.reviewedBy,
        reviewedAt,
      });
    }
    case "reject":
      return backend.upsertLearnedFact({ ...base, status: "rejected", ownerVerified: false, reviewedBy: input.reviewedBy, reviewedAt });
  }
}

const OWNER_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;

/** The owner answers a gap question directly — owner-sourced, verified by definition. */
export async function answerOwnerQuestion(input: { businessId: string; key: string; value: string; answeredBy: string }): Promise<LearnedFactRecord> {
  const key = input.key.trim();
  const value = input.value.trim();
  if (!OWNER_KEY.test(key) || key.length > 64) throw new LearnBusinessInputError("Invalid key");
  if (!value || value.length > 1000) throw new LearnBusinessInputError("An answer is required");
  const backend = getBackend();
  const prior = (await backend.listLearnedFacts(input.businessId)).find((f) => f.key === key);
  const now = new Date().toISOString();
  return backend.upsertLearnedFact({
    businessId: input.businessId,
    key,
    value,
    classification: reviewedClassification(key, "fact"),
    source: { kind: "owner" },
    confidence: "high",
    status: "verified",
    ownerVerified: true,
    correctedFrom: prior && prior.value !== value ? prior.value : undefined,
    reviewedBy: input.answeredBy,
    reviewedAt: now,
    discoveredAt: prior?.discoveredAt ?? now,
    refreshedAt: now,
  });
}

export async function getLearningWorkspace(graph: BusinessGraph) {
  const backend = getBackend();
  const businessId = graph.business.id;
  const [run, facts, connections, strategy] = await Promise.all([
    backend.getLatestLearningRun(businessId),
    backend.listLearnedFacts(businessId),
    backend.listBusinessConnections(businessId),
    backend.getLatestOperatingStrategy(businessId),
  ]);
  const capabilities = enabledCapabilities(graph);
  const profiles = await resolveCapabilityProfiles(graph);
  const readiness = buildReadiness({ capabilities, facts, connections, profiles });
  return {
    business: { id: businessId, name: graph.business.name },
    capabilities,
    run: run ?? null,
    facts: facts.sort((a, b) => a.key.localeCompare(b.key)),
    questions: readiness.questions,
    needsReview: readiness.needsReview,
    readiness: { understanding: readiness.understanding, operational: readiness.operational },
    strategy: strategy ?? null,
    capabilityReport: buildCapabilityReport({ graph, facts, profiles }),
  };
}

export async function generateOperatingStrategy(graph: BusinessGraph) {
  const backend = getBackend();
  const businessId = graph.business.id;
  const [facts, connections] = await Promise.all([backend.listLearnedFacts(businessId), backend.listBusinessConnections(businessId)]);
  const profiles = await resolveCapabilityProfiles(graph);
  const strategy = { ...buildOperatingStrategy({ graph, facts, connections }), capabilityReport: buildCapabilityReport({ graph, facts, profiles }) };
  const readiness = buildReadiness({ capabilities: enabledCapabilities(graph), facts, connections, profiles });
  return backend.saveOperatingStrategy({
    businessId,
    strategy,
    readiness: { understanding: readiness.understanding, operational: readiness.operational },
  });
}
