import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { resolveEffectiveAuthority, type EffectiveAuthority } from "./effective-rules";

/**
 * Server half of the effective-runtime contract: load the business's learned facts and overlay them on
 * the static graph. Idempotent (an overlaid graph is resolved from its static base again, never from
 * itself). If the facts can't be read, BARRY can't know whether the owner TIGHTENED the profile's limit,
 * so it fails closed: no automatic discount this turn (every discount goes to the owner) — logged.
 */
const baseOf = new WeakMap<BusinessGraph, BusinessGraph>();

export async function loadEffectiveAuthority(graph: BusinessGraph): Promise<EffectiveAuthority> {
  const base = baseOf.get(graph) ?? graph;
  let facts: Awaited<ReturnType<ReturnType<typeof getBackend>["listLearnedFacts"]>> = [];
  let unavailable = false;
  try {
    facts = await getBackend().listLearnedFacts(base.business.id);
  } catch (err) {
    unavailable = true;
    console.error("[barry:authority] learned facts unavailable — automatic discounts fail closed this turn", err instanceof Error ? err.message : err);
  }
  const effective = resolveEffectiveAuthority(base, facts);
  if (unavailable) {
    const closed = { source: "static" as const, revision: "fail-closed:learned-facts-unavailable", supersedes: [] };
    effective.graph = { ...effective.graph, policies: effective.graph.policies.map((p) => (p.rule.type === "max_auto_discount_pct" ? { ...p, provenance: closed, rule: { ...p.rule, value: 0 } } : p)) };
    effective.rules = effective.rules.map((r) => ({ ...r, value: 0, provenance: closed }));
  }
  baseOf.set(effective.graph, base);
  return effective;
}

/** The graph the runtime must use: static baseline + owner-trained authority overlay. */
export async function effectiveGraph(graph: BusinessGraph): Promise<BusinessGraph> {
  return (await loadEffectiveAuthority(graph)).graph;
}
