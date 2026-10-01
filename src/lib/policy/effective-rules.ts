import type { BusinessGraph, Policy, PolicyProvenance } from "@/lib/business-graph";
import type { LearnedFactRecord } from "@/lib/store/types";

/**
 * THE EFFECTIVE RUNTIME AUTHORITY CONTRACT (pure).
 *
 * One function decides what authority the runtime enforces: the static Business Graph is the baseline,
 * and an owner-trained rule overlays it ONLY when it comes from an owner-verified fact (status verified
 * or corrected) whose value compiles into a validated structured rule. Free text never becomes authority:
 * a value that does not compile is NOT operational and asks the owner one clarifying question. Candidates,
 * inferences and recommendations never compile. A value above BARRY's hard system ceiling is blocked.
 *
 * The SAME result feeds the policy engine (the overlaid graph), the reasoner context (the graph's
 * policies carry provenance), Train BARRY (rule states + owner words) and the Inspector (provenance on
 * every decision). There is no second genome.
 */

/** Learned keys that state the automatic discount limit (any of them; the newest approved one wins). */
export const DISCOUNT_AUTHORITY_KEYS = ["authority.discounts", "authority.discount_limit", "policy.discounts", "policy.discount_limit"] as const;

/** BARRY's hard system ceiling: no owner-trained automatic discount above it is ever activated. */
export const HARD_MAX_AUTO_DISCOUNT_PCT = 30;

export type DiscountCompile =
  | { ok: true; pct: number; basis: "percentage" | "bare_number" | "none" }
  | { ok: false; reason: "no_percentage" | "ambiguous" | "out_of_range" | "above_hard_limit"; detail: string; found?: number[] };

const PCT = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|percent\b|per\s+cent\b|אחוז(?:ים)?)/giu;
const BARE = /^\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%?\s*\.?\s*$/u;
const NONE = /^\s*(none|no|no discounts?|0|zero|אין|ללא)\s*\.?\s*$/iu;

/**
 * Bounded, schema-like compilation of an owner's discount authority: the value must state exactly ONE
 * percentage (or a bare number, or "none"). Two different percentages ("5% … but up to 10% for VIPs")
 * are ambiguous and are never guessed. No phrase matching: only the numbers the owner wrote count.
 */
export function compileDiscountAuthority(value: string): DiscountCompile {
  const text = value.trim();
  if (NONE.test(text)) return { ok: true, pct: 0, basis: "none" };
  const bare = BARE.exec(text);
  const found = bare ? [Number(bare[1].replace(",", "."))] : [...new Set([...text.matchAll(PCT)].map((m) => Number(m[1].replace(",", "."))))];
  if (found.length === 0) return { ok: false, reason: "no_percentage", detail: "No percentage was stated." };
  if (found.length > 1) return { ok: false, reason: "ambiguous", detail: `More than one limit is stated (${found.map((n) => `${n}%`).join(", ")}).`, found };
  const pct = found[0];
  if (!(pct >= 0 && pct < 100)) return { ok: false, reason: "out_of_range", detail: `${pct}% is not a valid discount limit.`, found };
  if (pct > HARD_MAX_AUTO_DISCOUNT_PCT) return { ok: false, reason: "above_hard_limit", detail: `${pct}% is above BARRY's hard limit of ${HARD_MAX_AUTO_DISCOUNT_PCT}% for automatic discounts.`, found };
  return { ok: true, pct, basis: bare ? "bare_number" : "percentage" };
}

export type TrainedRuleState = "active" | "superseded" | "needs_review" | "needs_clarification" | "blocked";

export type TrainedRule = {
  factId: string;
  key: string;
  rule: "max_auto_discount_pct";
  /** What the owner wrote. */
  value: string;
  state: TrainedRuleState;
  compiled?: number;
  revision: string;
  reviewer?: string;
  reviewedAt?: string;
  /** Owner words: what this rule means for BARRY right now. */
  words: string;
  /** The one question that would make a non-operational rule operational. */
  question?: string;
  reason?: string;
};

export type EffectiveRule = {
  rule: "max_auto_discount_pct";
  value: number;
  provenance: PolicyProvenance;
  /** Owner words, e.g. "BARRY may offer up to 5% without asking you. More than 5% requires your approval." */
  words: string;
  sourceWords: string;
};

export type EffectiveAuthority = {
  /** The graph the runtime enforces: static baseline + owner-trained overlay, every policy with provenance. */
  graph: BusinessGraph;
  rules: EffectiveRule[];
  trained: TrainedRule[];
};

const approved = (f: LearnedFactRecord) => f.ownerVerified && (f.status === "verified" || f.status === "corrected");
const at = (f: LearnedFactRecord) => f.reviewedAt ?? f.refreshedAt;
export const revisionOf = (f: Pick<LearnedFactRecord, "id" | "reviewedAt" | "refreshedAt">) => `${f.id}@${f.reviewedAt ?? f.refreshedAt}`;

export function discountWords(pct: number): string {
  return pct === 0 ? "BARRY gives no discount on its own. Every discount requires your approval." : `BARRY may offer up to ${pct}% without asking you. More than ${pct}% requires your approval.`;
}

function sourceWordsOf(p: PolicyProvenance): string {
  if (p.source === "static") return "Your business profile (set up with the BARRY team).";
  return p.sourceKind === "owner" || !p.sourceKind ? "You taught BARRY." : "You confirmed it in Train BARRY.";
}

function clarifyQuestion(c: Extract<DiscountCompile, { ok: false }>, raw: string): string {
  if (c.reason === "above_hard_limit") return `${c.detail} What is the most BARRY may give without asking you (up to ${HARD_MAX_AUTO_DISCOUNT_PCT}%)?`;
  if (c.reason === "ambiguous") return `You wrote “${raw}”. ${c.detail} What is the ONE most BARRY may give without asking you (for example 5%)?`;
  return `BARRY couldn't turn “${raw}” into a discount limit. What is the most BARRY may give without asking you (for example 5%, or “none”)?`;
}

/** Deterministic order: newest review first, then key order, then id. */
function newestFirst(a: LearnedFactRecord, b: LearnedFactRecord): number {
  return at(b).localeCompare(at(a)) || DISCOUNT_AUTHORITY_KEYS.indexOf(a.key as (typeof DISCOUNT_AUTHORITY_KEYS)[number]) - DISCOUNT_AUTHORITY_KEYS.indexOf(b.key as (typeof DISCOUNT_AUTHORITY_KEYS)[number]) || a.id.localeCompare(b.id);
}

/**
 * Resolve the effective authority from the static graph and the business's learned facts. Pure and
 * deterministic: the same inputs always give the same current rule.
 */
export function resolveEffectiveAuthority(input: BusinessGraph, facts: LearnedFactRecord[]): EffectiveAuthority {
  // Always resolve from the STATIC baseline: an overlay already on the input is recomputed, never trusted.
  const kept = input.policies.filter((p) => p.provenance?.source !== "owner_trained");
  // An overlaid graph carries the profile rule it replaced in its provenance: restore it as the baseline.
  const replaced = input.policies.find((p) => p.provenance?.source === "owner_trained")?.provenance?.supersedes.find((x) => x.source === "static");
  if (replaced && !kept.some((p) => p.rule.type === "max_auto_discount_pct")) {
    kept.push({ id: replaced.revision.replace(/^static:/, ""), description: "Max automatic discount", provenance: { source: "static", revision: replaced.revision, supersedes: [] }, rule: { type: "max_auto_discount_pct", value: replaced.value } });
  }
  const base: BusinessGraph = { ...input, policies: kept };
  const staticPolicy = base.policies.find((p) => p.rule.type === "max_auto_discount_pct" && p.provenance?.source !== "owner_trained");
  const staticValue = staticPolicy?.rule.type === "max_auto_discount_pct" ? staticPolicy.rule.value : undefined;
  const staticRevision = staticPolicy ? `static:${staticPolicy.id}` : "static:none";

  const relevant = facts.filter((f) => (DISCOUNT_AUTHORITY_KEYS as readonly string[]).includes(f.key) && f.status !== "rejected");
  const trained: TrainedRule[] = [];
  const contenders: { fact: LearnedFactRecord; pct: number }[] = [];
  for (const f of relevant) {
    const head = { factId: f.id, key: f.key, rule: "max_auto_discount_pct" as const, value: f.value, revision: revisionOf(f), ...(f.reviewedBy ? { reviewer: f.reviewedBy } : {}), ...(f.reviewedAt ? { reviewedAt: f.reviewedAt } : {}) };
    if (!approved(f)) {
      trained.push({ ...head, state: "needs_review", words: `Learned “${f.value}” — not confirmed by you, so BARRY does not use it.`, question: `Is “${f.value}” your discount rule?` });
      continue;
    }
    const c = compileDiscountAuthority(f.value);
    if (!c.ok) {
      trained.push({ ...head, state: c.reason === "above_hard_limit" ? "blocked" : "needs_clarification", reason: c.detail, words: `BARRY understood “${f.value}” but does not act on it: ${c.detail}`, question: clarifyQuestion(c, f.value) });
      continue;
    }
    contenders.push({ fact: f, pct: c.pct });
    trained.push({ ...head, state: "active", compiled: c.pct, words: discountWords(c.pct) });
  }
  contenders.sort((a, b) => newestFirst(a.fact, b.fact));
  const current = contenders[0];
  for (const t of trained) if (t.state === "active" && current && t.factId !== current.fact.id) {
    t.state = "superseded";
    t.words = `Replaced by your newer rule (${current.pct}%).`;
  }

  const rules: EffectiveRule[] = [];
  let policies: Policy[] = base.policies.map((p) => (p.provenance ? p : { ...p, provenance: { source: "static" as const, revision: `static:${p.id}`, supersedes: [] } }));
  if (current) {
    const supersedes: PolicyProvenance["supersedes"] = [];
    if (staticValue !== undefined) supersedes.push({ source: "static", value: staticValue, revision: staticRevision });
    for (const c of contenders.slice(1)) supersedes.push({ source: "owner_trained", value: c.pct, revision: revisionOf(c.fact), factId: c.fact.id });
    if (current.fact.correctedFrom) {
      const prev = compileDiscountAuthority(current.fact.correctedFrom);
      if (prev.ok) supersedes.push({ source: "owner_trained", value: prev.pct, revision: `${current.fact.id}@before-correction`, factId: current.fact.id });
    }
    const provenance: PolicyProvenance = { source: "owner_trained", factId: current.fact.id, factKey: current.fact.key, sourceKind: current.fact.source.kind, ...(current.fact.reviewedBy ? { reviewer: current.fact.reviewedBy } : {}), ...(current.fact.reviewedAt ? { reviewedAt: current.fact.reviewedAt } : {}), revision: revisionOf(current.fact), supersedes };
    const overlay: Policy = { id: `owner:${current.fact.key}`, description: discountWords(current.pct), provenance, rule: { type: "max_auto_discount_pct", value: current.pct } };
    policies = [...policies.filter((p) => p.rule.type !== "max_auto_discount_pct"), overlay];
    rules.push({ rule: "max_auto_discount_pct", value: current.pct, provenance, words: discountWords(current.pct), sourceWords: sourceWordsOf(provenance) });
  } else if (staticValue !== undefined) {
    const provenance: PolicyProvenance = { source: "static", revision: staticRevision, supersedes: [] };
    rules.push({ rule: "max_auto_discount_pct", value: staticValue, provenance, words: discountWords(staticValue), sourceWords: sourceWordsOf(provenance) });
  }
  return { graph: { ...base, policies }, rules, trained: trained.sort((a, b) => (a.reviewedAt ?? "").localeCompare(b.reviewedAt ?? "") * -1) };
}

/** The effective discount policy of a graph with its provenance (for decisions and the Inspector). */
export function discountPolicyOf(graph: BusinessGraph): { value: number; provenance: PolicyProvenance; policyId: string } | undefined {
  const p = graph.policies.find((x) => x.rule.type === "max_auto_discount_pct");
  if (!p || p.rule.type !== "max_auto_discount_pct") return undefined;
  return { value: p.rule.value, provenance: p.provenance ?? { source: "static", revision: `static:${p.id}`, supersedes: [] }, policyId: p.id };
}
