import type { ExternalEvidence } from "./model";

/**
 * THE EXTERNAL-RESEARCH BOUNDARY (V1: no connector — deliberately).
 *
 * Later initiatives may cite outside evidence (supplier alternatives, shipping rates, SaaS
 * replacements, market benchmarks). Any such evidence must arrive as an ExternalEvidence record
 * (source URL / identifier, retrieval time, source type, the quoted or normalised claim, confidence, and
 * whether it is a public claim or a benchmark). It is CONTEXT, never a business fact:
 *   - it can never be the evidence behind a number in an observation,
 *   - it can never make a saving "realised" (only a later verified cost record of the business can),
 *   - it is never mixed across tenants (one business's figures are never another's benchmark).
 * No fake research: until a trustworthy connector exists, there is none.
 */

export const EXTERNAL_RESEARCH_CONNECTOR: null = null;

export function acceptExternalEvidence(raw: Partial<ExternalEvidence>): { ok: true; evidence: ExternalEvidence; businessFact: false } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!raw.sourceUrl || !/^https?:\/\//.test(raw.sourceUrl)) problems.push("a source URL is required");
  if (!raw.retrievedAt || Number.isNaN(Date.parse(raw.retrievedAt))) problems.push("the retrieval time is required");
  if (!raw.claim?.trim()) problems.push("the claim is required");
  if (!raw.sourceType) problems.push("the source type is required");
  if (!raw.claimType || (raw.claimType !== "public_claim" && raw.claimType !== "benchmark")) problems.push("external evidence is a public claim or a benchmark — never a verified business fact");
  if (problems.length) return { ok: false, problems };
  return { ok: true, evidence: { sourceUrl: raw.sourceUrl!, sourceType: raw.sourceType!, retrievedAt: raw.retrievedAt!, claim: raw.claim!.trim(), confidence: raw.confidence ?? "low", claimType: raw.claimType! }, businessFact: false };
}

/** A saving is realised only by the business's own later, verified cost record — never by an external claim. */
export function savingRealisedBy(evidence: { kind: "external" | "cost_record"; verified?: boolean }[]): boolean {
  return evidence.some((e) => e.kind === "cost_record" && e.verified === true);
}
