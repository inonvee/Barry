import { getCapability } from "@/lib/fabric/capability";
import { featureForAction, PLAN_CATALOG, planUnlocking, type Feature, type PlanId } from "./plans";

/**
 * PLAN ENTITLEMENT — "did the customer buy access to this?" — enforced next to AUTHORITY ("may BARRY do
 * this now?"). Both must pass:
 *
 *   plan denies  + authority allows  → UNAVAILABLE (not included in the plan; never an owner request)
 *   plan allows  + authority denies  → DENIED      (authority wins; the plan never loosens it)
 *   both allow                        → EXECUTABLE  (authority still decides allowed vs. requires approval)
 *
 * The gate runs AFTER the business rules and founder controls and can only turn a decision into a
 * denial. A business with no commercial account (internal / demo) has no plan restriction — the founder
 * sees it as "no plan selected" and the free month can't start without one.
 *
 * Synchronous for the policy engine: the account is loaded before each turn (see account.ts).
 */

export type Entitlement = {
  plan: PlanId | null;
  /** The features the customer bought (the snapshot recorded with the plan). null = no restriction. */
  features: Feature[] | null;
  /** QA emulation of a plan (never in production). */
  emulated: boolean;
};

const cache = new Map<string, Entitlement>();
const NONE: Entitlement = { plan: null, features: null, emulated: false };

export function setEntitlement(businessId: string, e: Entitlement): void {
  cache.set(businessId, e);
}

export function currentEntitlement(businessId: string): Entitlement {
  return cache.get(businessId) ?? NONE;
}

export function resetEntitlementCacheForTests(): void {
  cache.clear();
}

export type EntitlementVerdict = { included: true; feature: Feature } | { included: false; feature: Feature; plan: PlanId; unlockedBy: PlanId | null; reason: string };

export function entitlementFor(e: Entitlement, action: string, params: Record<string, unknown> = {}): EntitlementVerdict {
  const effect = action === "invokeCapability" ? getCapability(String((params as { capability?: unknown }).capability ?? ""))?.effect : undefined;
  const feature = featureForAction(action, effect === "read" ? "read" : "consequential");
  if (!e.plan || !e.features || e.features.includes(feature)) return { included: true, feature };
  const unlockedBy = planUnlocking(feature);
  return { included: false, feature, plan: e.plan, unlockedBy, reason: `Not included in the ${PLAN_CATALOG[e.plan].name} plan${unlockedBy ? ` (included in ${PLAN_CATALOG[unlockedBy].name})` : ""}.` };
}

export function hasFeature(e: Entitlement, feature: Feature): boolean {
  return !e.plan || !e.features || e.features.includes(feature);
}

export type Executability = "executable" | "unavailable" | "denied";

/** The three-way answer for a decision that passed through decide(). */
export function executability(decision: { status: "allowed" | "requires_approval" | "denied"; policyId?: string }): Executability {
  if (decision.status !== "denied") return "executable";
  return decision.policyId === PLAN_POLICY_ID ? "unavailable" : "denied";
}

export const PLAN_POLICY_ID = "plan:not_included";
