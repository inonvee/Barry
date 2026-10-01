import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import type { LearnedFactRecord } from "@/lib/store/types";
import { listBusinessSystems } from "@/lib/fabric/registry";
import { getCatalogSchema } from "@/lib/commerce/capability";
import { parseSourceDocument } from "./document";
import { groundCandidateFacts } from "./grounding";
import { getBusinessLearner, type BusinessLearner } from "./learner";
import { LearnBusinessInputError } from "./service";
import { approveSource, recordSourceRead, sourceIdFor, type LearnedSource } from "./sources";
import { classifyChange, recordLearningChanges, type LearningChange } from "./relearn";

/**
 * INTAKE beyond URLs — the owner supplies structured facts, a policy / price document (text), or
 * approves reading connected-system metadata and the catalog schema. Every path lands in the same
 * fact contract (key, value, source + evidence, confidence, freshness, classification, status) and
 * the same re-learning diff. Nothing here fetches the network: documents arrive as text the owner
 * uploaded; systems and catalogs are read through BARRY's own connectors.
 */

const OWNER_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;
const approved = (f: LearnedFactRecord | undefined) => Boolean(f && f.ownerVerified && (f.status === "verified" || f.status === "corrected"));

type Candidate = { key: string; value: string; classification: LearnedFactRecord["classification"]; confidence: LearnedFactRecord["confidence"]; source: LearnedFactRecord["source"] };

/** Persist candidates through the re-learning diff: approved values are never overwritten; conflicts are recorded. */
async function storeCandidates(businessId: string, candidates: Candidate[], sourceRef: string, at: string, runId?: string): Promise<{ stored: LearnedFactRecord[]; changes: LearningChange[]; skipped: { key: string; reason: string }[] }> {
  const backend = getBackend();
  const existing = new Map((await backend.listLearnedFacts(businessId)).map((f) => [f.key, f]));
  const stored: LearnedFactRecord[] = [];
  const changes: LearningChange[] = [];
  const skipped: { key: string; reason: string }[] = [];
  for (const c of candidates) {
    const prior = existing.get(c.key);
    const change = classifyChange(prior, c, sourceRef, at, runId);
    if (change) changes.push({ ...change, businessId });
    if (prior && approved(prior)) {
      skipped.push({ key: c.key, reason: prior.value === c.value ? "already approved" : "conflicts with your approved value (recorded for review)" });
      continue;
    }
    if (prior && prior.status === "rejected" && prior.value === c.value) {
      skipped.push({ key: c.key, reason: "owner rejected this value" });
      continue;
    }
    const saved = await backend.upsertLearnedFact({ businessId, runId, key: c.key, value: c.value, classification: c.classification === "policy" ? "inference" : c.classification, source: c.source, confidence: c.confidence, status: "candidate", ownerVerified: false, discoveredAt: prior?.discoveredAt ?? at, refreshedAt: at });
    existing.set(saved.key, saved);
    stored.push(saved);
  }
  await recordLearningChanges(businessId, changes);
  return { stored, changes, skipped };
}

/** Owner-typed structured facts: owner-sourced, verified by definition (policy keys become POLICY). */
export async function intakeStructuredFacts(input: { graph: BusinessGraph; facts: { key: string; value: string }[]; approvedBy: string; now?: Date }): Promise<{ source: LearnedSource; facts: LearnedFactRecord[] }> {
  const businessId = input.graph.business.id;
  const at = (input.now ?? new Date()).toISOString();
  if (!input.facts.length || input.facts.length > 50) throw new LearnBusinessInputError("Supply 1–50 facts");
  const backend = getBackend();
  const source = await approveSource({ businessId, type: "owner_facts", ref: "owner", approvedBy: input.approvedBy, now: input.now });
  const prior = new Map((await backend.listLearnedFacts(businessId)).map((f) => [f.key, f]));
  const out: LearnedFactRecord[] = [];
  for (const f of input.facts) {
    const key = f.key.trim();
    const value = f.value.trim();
    if (!OWNER_KEY.test(key) || key.length > 64) throw new LearnBusinessInputError(`Invalid key: ${key}`);
    if (!value || value.length > 1000) throw new LearnBusinessInputError(`A value is required for ${key}`);
    const p = prior.get(key);
    out.push(await backend.upsertLearnedFact({ businessId, key, value, classification: key.startsWith("policy.") || key.startsWith("authority.") ? "policy" : "fact", source: { kind: "owner" }, confidence: "high", status: "verified", ownerVerified: true, correctedFrom: p && p.value !== value ? p.value : undefined, reviewedBy: input.approvedBy, reviewedAt: at, discoveredAt: p?.discoveredAt ?? at, refreshedAt: at }));
  }
  await recordSourceRead({ businessId, id: source.id, ok: true, facts: out.length, now: input.now });
  return { source: (await recordSourceRead({ businessId, id: source.id, ok: true, facts: out.length, now: input.now })) ?? source, facts: out };
}

/** A document the owner uploaded (policy file, price list) as text: parsed, learned, grounded by quotes. */
export async function intakeDocument(input: { graph: BusinessGraph; name: string; text: string; approvedBy: string; learner?: BusinessLearner; now?: Date }): Promise<{ source: LearnedSource; stored: LearnedFactRecord[]; rejected: { key: string; reason: string }[]; changes: LearningChange[] }> {
  const businessId = input.graph.business.id;
  const at = (input.now ?? new Date()).toISOString();
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new LearnBusinessInputError("A document name is required");
  if (!input.text.trim() || input.text.length > 400_000) throw new LearnBusinessInputError("Document text is required (up to 400k characters)");
  const source = await approveSource({ businessId, type: "document", ref: name, approvedBy: input.approvedBy, now: input.now });
  const doc = parseSourceDocument(`document:${encodeURIComponent(name)}`, input.text, "text/plain");
  const learner = input.learner ?? getBusinessLearner();
  const candidates = await learner.extract(doc);
  const { facts, rejected } = groundCandidateFacts(doc, candidates);
  const result = await storeCandidates(businessId, facts.map((f) => ({ key: f.key, value: f.value, classification: f.classification, confidence: f.confidence, source: { kind: "document", name, quote: f.quote, sourceId: source.id } })), source.id, at);
  const read = await recordSourceRead({ businessId, id: source.id, ok: true, facts: result.stored.length, rejected: rejected.length, now: input.now });
  return { source: read ?? source, stored: result.stored, rejected, changes: result.changes };
}

/** What the connected systems report about themselves (system key, name, capabilities, health). Never a guess. */
export async function intakeConnectedSystems(input: { graph: BusinessGraph; approvedBy: string; now?: Date }): Promise<{ sources: LearnedSource[]; stored: LearnedFactRecord[] }> {
  const businessId = input.graph.business.id;
  const at = (input.now ?? new Date()).toISOString();
  const systems = await listBusinessSystems(businessId);
  const sources: LearnedSource[] = [];
  const stored: LearnedFactRecord[] = [];
  for (const s of systems) {
    const source = await approveSource({ businessId, type: "connected_system", ref: s.system.key, approvedBy: input.approvedBy, provenance: { kind: "connected_system", detail: s.domain }, now: input.now });
    const active = s.capabilities.filter((c) => c.status === "active").map((c) => c.id);
    const candidates: Candidate[] = [
      { key: `systems.${s.domain}.provider`, value: `${s.system.name}${s.simulated ? " (simulated)" : ""}`, classification: "fact", confidence: "high", source: { kind: "system", system: s.system.key, reference: s.id, sourceId: source.id } },
      { key: `systems.${s.domain}.capabilities`, value: active.join(", ") || "none active", classification: "fact", confidence: "high", source: { kind: "system", system: s.system.key, reference: s.id, sourceId: source.id } },
    ];
    const r = await storeCandidates(businessId, candidates, source.id, at);
    stored.push(...r.stored);
    sources.push((await recordSourceRead({ businessId, id: source.id, ok: s.health.state !== "down", facts: r.stored.length, error: s.health.error, now: input.now })) ?? source);
  }
  return { sources, stored };
}

/** The catalog's own schema (categories, currency, option names) through the commerce connector. */
export async function intakeCatalog(input: { graph: BusinessGraph; approvedBy: string; now?: Date }): Promise<{ source: LearnedSource; stored: LearnedFactRecord[]; error?: string }> {
  const businessId = input.graph.business.id;
  const at = (input.now ?? new Date()).toISOString();
  const source = await approveSource({ businessId, type: "catalog", ref: "commerce", approvedBy: input.approvedBy, now: input.now });
  try {
    const schema = await getCatalogSchema(input.graph);
    const src = { kind: "catalog" as const, provider: "commerce", sourceId: source.id };
    const candidates: Candidate[] = [
      { key: "catalog.categories", value: schema.categories.join(", ") || "none", classification: "fact", confidence: "high", source: src },
      { key: "catalog.currency", value: schema.currency, classification: "fact", confidence: "high", source: src },
      { key: "catalog.variant_options", value: schema.variantOptions.map((o) => o.key).join(", ") || "none", classification: "fact", confidence: "high", source: src },
      ...(schema.priceRange ? [{ key: "catalog.price_range", value: `${schema.priceRange.min}–${schema.priceRange.max} ${schema.currency}`, classification: "fact" as const, confidence: "high" as const, source: src }] : []),
    ];
    const r = await storeCandidates(businessId, candidates, source.id, at);
    const read = await recordSourceRead({ businessId, id: source.id, ok: true, facts: r.stored.length, now: input.now });
    return { source: read ?? source, stored: r.stored };
  } catch (err) {
    const error = err instanceof Error ? err.message : "catalog unavailable";
    const read = await recordSourceRead({ businessId, id: source.id, ok: false, error, now: input.now });
    return { source: read ?? source, stored: [], error };
  }
}

export { sourceIdFor };
