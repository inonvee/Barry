import type { AuthorityCondition, AuthorityRule, BusinessGraph } from "@/lib/business-graph";
import { getCapability, type CapabilityId } from "@/lib/fabric/capability";
import "@/lib/fabric/builtin";

/**
 * DYNAMIC AUTHORITY — per capability, per business, context-aware,
 * deterministic.
 *
 * The model may PROPOSE a capability call; it never decides whether BARRY
 * may make it. That decision is this function, over the business's own
 * authority rules (Business Genome `authority`) and the exact, validated
 * input of the call:
 *
 *   1. rules for the capability (exact id, or a "domain.*" wildcard);
 *   2. among rules whose conditions hold, the most restrictive wins:
 *      deny > require_approval > allow;
 *   3. nothing matched: a READ capability is allowed (it changes nothing);
 *      a CONSEQUENTIAL capability is DENIED — authority is never assumed.
 *
 * Conditions compare one top-level input field with a literal. A condition
 * that can't be evaluated (missing field, wrong type) never GRANTS
 * authority, and always COUNTS toward a restriction.
 */

export type AuthorityDecision = {
  status: "allowed" | "requires_approval" | "denied";
  reason: string;
  /** The rule that decided, when one did. */
  ruleId?: string;
};

function ruleApplies(rule: AuthorityRule, capability: CapabilityId): boolean {
  if (rule.capability === capability) return true;
  if (rule.capability.endsWith(".*")) return capability.startsWith(rule.capability.slice(0, -1));
  return false;
}

/** true / false, or undefined when the condition can't be evaluated against this input. */
function evaluate(c: AuthorityCondition, input: Record<string, unknown>): boolean | undefined {
  const v = input[c.field];
  if (c.op === "exists") return v !== undefined && v !== null && v !== "";
  if (v === undefined || v === null) return undefined;
  switch (c.op) {
    case "eq":
      return typeof v === typeof c.value ? v === c.value : undefined;
    case "neq":
      return typeof v === typeof c.value ? v !== c.value : undefined;
    case "in":
      return Array.isArray(c.value) && (typeof v === "string" || typeof v === "number") ? (c.value as (string | number)[]).includes(v) : undefined;
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (typeof v !== "number" || typeof c.value !== "number") return undefined;
      return c.op === "lt" ? v < c.value : c.op === "lte" ? v <= c.value : c.op === "gt" ? v > c.value : v >= c.value;
    }
  }
}

function holds(rule: AuthorityRule, input: Record<string, unknown>): boolean {
  const restrictive = rule.effect !== "allow";
  return rule.when.every((c) => {
    const r = evaluate(c, input);
    return r === undefined ? restrictive : r;
  });
}

function because(rule: AuthorityRule, what: string): string {
  return `${what} (rule ${rule.id}${rule.reason ? `: ${rule.reason}` : ""})`;
}

export function decideCapability(graph: BusinessGraph, capability: CapabilityId, input: Record<string, unknown>): AuthorityDecision {
  const contract = getCapability(capability);
  if (!contract) return { status: "denied", reason: `Unknown capability ${capability}` };
  const matching = (graph.authority ?? []).filter((r) => ruleApplies(r, capability) && holds(r, input));

  const deny = matching.find((r) => r.effect === "deny");
  if (deny) return { status: "denied", reason: because(deny, `${capability} is not permitted`), ruleId: deny.id };
  const approval = matching.find((r) => r.effect === "require_approval");
  if (approval) return { status: "requires_approval", reason: because(approval, `${capability} needs the owner's approval`), ruleId: approval.id };
  const allow = matching.find((r) => r.effect === "allow");
  if (allow) return { status: "allowed", reason: because(allow, `${capability} is permitted`), ruleId: allow.id };

  if (contract.effect === "read") return { status: "allowed", reason: `${capability} only reads; no rule restricts it` };
  return { status: "denied", reason: `No authority rule allows ${capability} in this situation — BARRY does not assume authority` };
}

/** How a capability is governed for this business, without a concrete input (for the model's context and HQ). */
export function authoritySummary(graph: BusinessGraph, capability: CapabilityId): "automatic" | "conditional" | "owner_approval" | "not_permitted" | "read_only" {
  const contract = getCapability(capability);
  const rules = (graph.authority ?? []).filter((r) => ruleApplies(r, capability));
  if (rules.some((r) => r.effect === "deny" && r.when.length === 0)) return "not_permitted";
  if (rules.some((r) => r.effect === "require_approval" && r.when.length === 0)) return "owner_approval";
  if (rules.some((r) => r.effect === "allow" && r.when.length === 0) && !rules.some((r) => r.effect !== "allow")) return "automatic";
  if (rules.length > 0) return "conditional";
  return contract?.effect === "read" ? "read_only" : "not_permitted";
}
