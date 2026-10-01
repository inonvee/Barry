import type { BusinessGraph } from "@/lib/business-graph";
import type { LearnedFactRecord } from "@/lib/store/types";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import { factSourceId, sourceFreshness, sourceWords, type LearnedSource } from "./sources";

/**
 * THE EFFECTIVE BUSINESS GENOME — every field BARRY operates on, with its provenance: why BARRY
 * believes it, where it came from, when it was last checked and whether the owner approved it.
 * Built from trusted facts (owner-approved first), the Genome fixture / owner-declared data, explicit
 * policy and authority, and the connected capability state. Candidates are listed but never effective.
 */

export type GenomeFieldOrigin = "owner_approved_fact" | "learned_candidate" | "genome_declaration" | "policy_rule" | "authority_rule" | "connected_system";

export type EffectiveField = {
  key: string;
  value: string;
  effective: boolean;
  origin: GenomeFieldOrigin;
  why: string;
  from: string;
  lastChecked: string | null;
  ownerApproved: boolean;
  freshness: "fresh" | "aging" | "stale" | "unknown" | "n/a";
  classification: LearnedFactRecord["classification"] | "declaration";
};

const approved = (f: LearnedFactRecord) => f.ownerVerified && (f.status === "verified" || f.status === "corrected");

export function effectiveGenome(input: { graph: BusinessGraph; facts: LearnedFactRecord[]; sources: LearnedSource[]; profiles?: CapabilityProfiles; now: Date }): EffectiveField[] {
  const { graph, facts, sources, now } = input;
  const out: EffectiveField[] = [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const byKey = new Map<string, LearnedFactRecord>();
  for (const f of facts) if (f.status !== "rejected") byKey.set(f.key, f);

  for (const f of byKey.values()) {
    const sid = factSourceId(f);
    const src = sid ? sourceById.get(sid) : undefined;
    const ok = approved(f);
    out.push({
      key: f.key,
      value: f.value,
      effective: ok,
      origin: ok ? "owner_approved_fact" : "learned_candidate",
      why: ok ? (f.source.kind === "owner" ? "You told BARRY." : `Learned from ${sourceWords(f)} and ${f.status === "corrected" ? "corrected" : "confirmed"} by you.`) : `Learned from ${sourceWords(f)}; not confirmed yet, so BARRY does not act on it.`,
      from: sourceWords(f),
      lastChecked: f.reviewedAt ?? f.refreshedAt,
      ownerApproved: ok,
      freshness: f.source.kind === "owner" ? "n/a" : src ? sourceFreshness(src, now) : "unknown",
      classification: f.classification,
    });
  }

  // Genome declarations (the fixture / owner-declared data) that no learned fact overrides.
  const declare = (key: string, value: string, why: string) => {
    if (byKey.has(key) && approved(byKey.get(key)!)) return;
    out.push({ key, value, effective: true, origin: "genome_declaration", why, from: "the business profile", lastChecked: null, ownerApproved: true, freshness: "n/a", classification: "declaration" });
  };
  declare("business.name", graph.business.name, "Declared in the business profile.");
  declare("business.description", graph.business.description, "Declared in the business profile.");
  if (graph.business.timezone) declare("business.timezone", graph.business.timezone, "Declared in the business profile; every time BARRY quotes is in it.");
  for (const p of graph.policies) {
    out.push({ key: `policy.rule.${p.rule.type}`, value: p.description, effective: true, origin: "policy_rule", why: "An explicit rule in the Business Genome; the policy engine enforces it.", from: "the business rules", lastChecked: null, ownerApproved: true, freshness: "n/a", classification: "policy" });
  }
  for (const a of graph.authority) {
    out.push({ key: `authority.${a.capability}`, value: `${a.effect.replace("_", " ")}${a.when.length ? ` when ${a.when.map((w) => `${w.field} ${w.op} ${JSON.stringify(w.value)}`).join(" and ")}` : ""}`, effective: true, origin: "authority_rule", why: a.reason ?? "An explicit authority rule; BARRY never exceeds it.", from: "the authority rules", lastChecked: null, ownerApproved: true, freshness: "n/a", classification: "policy" });
  }
  if (input.profiles) {
    for (const p of Object.values(input.profiles)) {
      if (!p.used && p.status !== "connected") continue;
      out.push({ key: `systems.${p.capability}`, value: p.status === "connected" ? `${p.provider ?? "provider"}${p.simulated ? " (simulated)" : ""}` : "not connected", effective: p.status === "connected", origin: "connected_system", why: p.status === "connected" ? "The connector itself reports what it supports." : "No working connection; BARRY cannot operate this.", from: p.provider ?? "connections", lastChecked: null, ownerApproved: false, freshness: "n/a", classification: "declaration" });
    }
  }
  return out.sort((a, b) => Number(b.effective) - Number(a.effective) || a.key.localeCompare(b.key));
}
