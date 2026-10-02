import type { BusinessGraph } from "@/lib/business-graph";
import type { LearnedFactRecord } from "@/lib/store/types";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import { factSourceId, sourceFreshness, sourceWords, type LearnedSource } from "./sources";
import { policyWords } from "@/lib/policy/words";
import { DISCOUNT_AUTHORITY_KEYS, discountWords, resolveEffectiveAuthority, type TrainedRule } from "@/lib/policy/effective-rules";

/**
 * THE EFFECTIVE BUSINESS GENOME — every field BARRY operates on, with its provenance: why BARRY
 * believes it, where it came from, when it was last checked and whether the owner approved it.
 * Built from trusted facts (owner-approved first), the Genome fixture / owner-declared data, explicit
 * policy and authority, and the connected capability state. Candidates are listed but never effective.
 */

export type GenomeFieldOrigin = "owner_approved_fact" | "learned_candidate" | "genome_declaration" | "policy_rule" | "authority_rule" | "connected_system";

/**
 * What a field means for BARRY RIGHT NOW, in the owner's terms — never implying enforcement that the
 * runtime doesn't do:
 *  - active: the runtime uses it (the policy engine enforces it / the conversation runs on it);
 *  - needs_review: not confirmed, or confirmed but not understood as a rule (one question asked);
 *  - understood_only: saved and confirmed, but it doesn't change what BARRY does in conversations;
 *  - replaced: a newer rule of yours supersedes it;
 *  - blocked: it can't become operational (e.g. above BARRY's hard limit).
 */
export type FieldStatus = "active" | "needs_review" | "understood_only" | "replaced" | "blocked";
export const STATUS_WORDS: Record<FieldStatus, string> = { active: "ACTIVE", needs_review: "NEEDS REVIEW", understood_only: "UNDERSTOOD ONLY", replaced: "REPLACED", blocked: "BLOCKED — NOT OPERATIONAL" };

export type EffectiveField = {
  key: string;
  /** Owner words for what this is (never an internal key). */
  label?: string;
  value: string;
  /** True only when the runtime actually operates on it. */
  effective: boolean;
  status: FieldStatus;
  /** The one question that would make it operational (needs_review / blocked). */
  question?: string;
  factId?: string;
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

  // The SAME resolution the runtime enforces (policy/effective-rules): what is active is what decides.
  const authority = resolveEffectiveAuthority(graph, facts);
  const trainedByFact = new Map<string, TrainedRule>(authority.trained.map((t) => [t.factId, t]));
  const isAuthorityKey = (key: string) => (DISCOUNT_AUTHORITY_KEYS as readonly string[]).includes(key);

  for (const f of facts) {
    if (f.status === "rejected") continue;
    // Several records for one discount rule are all shown (current one active, older ones replaced);
    // any other key shows its latest record only.
    if (!isAuthorityKey(f.key) && byKey.get(f.key) !== f) continue;
    const sid = factSourceId(f);
    const src = sid ? sourceById.get(sid) : undefined;
    const ok = approved(f);
    const told = f.source.kind === "owner" ? "You taught BARRY." : `Learned from ${sourceWords(f)} and ${f.status === "corrected" ? "corrected" : "confirmed"} by you.`;
    const trained = trainedByFact.get(f.id);
    let status: FieldStatus;
    let why: string;
    let question: string | undefined;
    let label: string | undefined;
    if (trained) {
      label = "Discount rule";
      status = trained.state === "active" ? "active" : trained.state === "superseded" ? "replaced" : trained.state === "blocked" ? "blocked" : "needs_review";
      why = trained.state === "active" ? `ACTIVE RULE — ${trained.words} Source: ${told}` : trained.words;
      question = trained.question;
    } else if (!ok) {
      status = "needs_review";
      why = `Learned from ${sourceWords(f)}; not confirmed yet, so BARRY does not act on it.`;
    } else {
      // Confirmed, but no runtime rule reads this key: it is on record, not enforced.
      status = "understood_only";
      why = `${told} BARRY has it on record — it doesn't change what BARRY does in conversations yet.`;
    }
    out.push({
      key: f.key,
      ...(label ? { label } : {}),
      value: f.value,
      effective: status === "active",
      status,
      ...(question ? { question } : {}),
      factId: f.id,
      origin: ok ? "owner_approved_fact" : "learned_candidate",
      why,
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
    out.push({ key, value, effective: true, status: "active", origin: "genome_declaration", why, from: "the business profile", lastChecked: null, ownerApproved: true, freshness: "n/a", classification: "declaration" });
  };
  declare("business.name", graph.business.name, "Declared in the business profile.");
  declare("business.description", graph.business.description, "Declared in the business profile.");
  if (graph.business.timezone) declare("business.timezone", graph.business.timezone, "Declared in the business profile; every time BARRY quotes is in it.");
  // A policy is described by its RULE VALUE (the free-text description beside it can be stale).
  const currencies = [...new Set(graph.offers.filter((o) => o.active).map((o) => o.currency))];
  const currency = currencies.length === 1 ? currencies[0] : null;
  // The policies the runtime ENFORCES — the effective graph (an owner-trained discount rule replaces the profile's).
  for (const p of authority.graph.policies) {
    if (p.provenance?.source === "owner_trained") continue; // shown above as the owner's own rule
    const discount = p.rule.type === "max_auto_discount_pct" ? p.rule.value : undefined;
    out.push({ key: `policy.rule.${p.rule.type}`, ...(discount !== undefined ? { label: "Discount rule" } : {}), value: discount !== undefined ? discountWords(discount) : policyWords(p.rule, currency).words, effective: true, status: "active", origin: "policy_rule", why: discount !== undefined ? `ACTIVE RULE — ${discountWords(discount)} Source: your business profile.` : "A rule in your business profile — BARRY follows it.", from: "the business rules", lastChecked: null, ownerApproved: true, freshness: "n/a", classification: "policy" });
  }
  // A profile rule an owner-trained rule replaced: shown as replaced, never as active.
  for (const p of graph.policies) {
    if (p.provenance?.source === "owner_trained" || authority.graph.policies.some((q) => q.id === p.id)) continue;
    const discount = p.rule.type === "max_auto_discount_pct" ? p.rule.value : undefined;
    out.push({ key: `policy.rule.${p.rule.type}`, ...(discount !== undefined ? { label: "Discount rule (business profile)" } : {}), value: discount !== undefined ? discountWords(discount) : policyWords(p.rule, currency).words, effective: false, status: "replaced", origin: "policy_rule", why: "Replaced by the rule you taught BARRY.", from: "the business rules", lastChecked: null, ownerApproved: true, freshness: "n/a", classification: "policy" });
  }
  for (const a of graph.authority) {
    out.push({ key: `authority.${a.capability}`, status: "active", value: `${a.effect.replace("_", " ")}${a.when.length ? ` when ${a.when.map((w) => `${w.field} ${w.op} ${JSON.stringify(w.value)}`).join(" and ")}` : ""}`, effective: true, origin: "authority_rule", why: a.reason ?? "An explicit authority rule; BARRY never exceeds it.", from: "the authority rules", lastChecked: null, ownerApproved: true, freshness: "n/a", classification: "policy" });
  }
  if (input.profiles) {
    for (const p of Object.values(input.profiles)) {
      if (!p.used && p.status !== "connected") continue;
      out.push({ key: `systems.${p.capability}`, status: p.status === "connected" ? "active" : "blocked", value: p.status === "connected" ? `${p.provider ?? "provider"}${p.simulated ? " (simulated)" : ""}` : "not connected", effective: p.status === "connected", origin: "connected_system", why: p.status === "connected" ? "The connector itself reports what it supports." : "No working connection; BARRY cannot operate this.", from: p.provider ?? "connections", lastChecked: null, ownerApproved: false, freshness: "n/a", classification: "declaration" });
    }
  }
  return out.sort((a, b) => Number(b.effective) - Number(a.effective) || a.key.localeCompare(b.key));
}
