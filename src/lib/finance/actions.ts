import { z } from "zod";
import type { BusinessGraph } from "@/lib/business-graph";
import { registerCapability, getCapability, type AnyCapabilityContract } from "@/lib/fabric/capability";
import { decideCapability } from "@/lib/policy/authority";

/**
 * COST ACTION AUTHORITY — contracts for the consequential cost actions BARRY may one day take
 * (cancel a subscription, change a supplier, open a negotiation, change reorder cadence, set a deposit
 * or discount policy). Every one is consequential, provider-confirmed, idempotent and policy-gated;
 * with no explicit authority rule the decision is DENIED. Nothing here executes anything.
 */

const base = { version: "1.0.0", effect: "consequential" as const, verification: "provider_confirmed" as const, idempotency: "key_required" as const, authority: "policy_gated" as const, provenance: { source: "barry_core" as const } };
const key = z.string().min(8);

export const COST_ACTION_CAPABILITIES: AnyCapabilityContract[] = [
  { id: "procurement.subscription.cancel", purpose: "Cancel a software subscription the business pays for.", input: z.object({ subscriptionReference: z.string().min(1).max(120), reason: z.string().max(300), idempotencyKey: key }), output: z.object({ cancelled: z.literal(true), effectiveAt: z.string().optional() }), examples: { valid: { subscriptionReference: "sub_1", reason: "duplicate", idempotencyKey: "cancel-key-01" }, invalid: { subscriptionReference: "", idempotencyKey: "x" } }, ...base },
  { id: "procurement.supplier.change", purpose: "Switch an item's supplier to another approved supplier.", input: z.object({ item: z.string().min(1).max(120), toSupplier: z.string().min(1).max(120), idempotencyKey: key }), output: z.object({ changed: z.literal(true) }), examples: { valid: { item: "fabric-01", toSupplier: "supplier-b", idempotencyKey: "change-key-01" }, invalid: { item: "", idempotencyKey: "x" } }, ...base },
  { id: "procurement.negotiation.open", purpose: "Send a negotiation request to a supplier on an approved objective.", input: z.object({ counterparty: z.string().min(1).max(120), objective: z.string().min(1).max(500), targetUnitPrice: z.number().positive().optional(), idempotencyKey: key }), output: z.object({ sent: z.literal(true), reference: z.string() }), examples: { valid: { counterparty: "supplier-a", objective: "return to last year's unit price", idempotencyKey: "nego-key-01" }, invalid: { counterparty: "", idempotencyKey: "x" } }, ...base },
  { id: "procurement.reorder.schedule", purpose: "Change the reorder cadence or quantity of an item.", input: z.object({ item: z.string().min(1).max(120), cadenceDays: z.number().int().min(1).max(365), quantity: z.number().int().min(0), idempotencyKey: key }), output: z.object({ scheduled: z.literal(true) }), examples: { valid: { item: "fabric-01", cadenceDays: 30, quantity: 20, idempotencyKey: "reorder-key-01" }, invalid: { item: "", cadenceDays: 0, quantity: -1, idempotencyKey: "x" } }, ...base },
  { id: "policy.deposit.set", purpose: "Set the deposit the business requires for bookings.", input: z.object({ amount: z.number().min(0), currency: z.string().length(3), idempotencyKey: key }), output: z.object({ set: z.literal(true) }), examples: { valid: { amount: 50, currency: "ILS", idempotencyKey: "deposit-key-01" }, invalid: { amount: -1, currency: "x", idempotencyKey: "x" } }, ...base },
  { id: "policy.discount.set", purpose: "Set the maximum discount BARRY may grant on its own.", input: z.object({ maxAutoPct: z.number().min(0).max(100), idempotencyKey: key }), output: z.object({ set: z.literal(true) }), examples: { valid: { maxAutoPct: 5, idempotencyKey: "discount-key-01" }, invalid: { maxAutoPct: 500, idempotencyKey: "x" } }, ...base },
];

for (const c of COST_ACTION_CAPABILITIES) if (!getCapability(c.id)) registerCapability(c);

export type CostActionDecision = { capability: string; status: "allowed" | "requires_approval" | "denied"; reason: string; ruleId?: string };

/** Default deny: without an explicit authority rule in the Genome the action is not permitted. */
export function costActionAuthority(graph: BusinessGraph, capability: string, input: Record<string, unknown> = {}): CostActionDecision {
  if (!COST_ACTION_CAPABILITIES.some((c) => c.id === capability)) return { capability, status: "denied", reason: "Not a cost action BARRY knows." };
  const d = decideCapability(graph, capability, input);
  return { capability, status: d.status, reason: d.reason, ...(d.ruleId ? { ruleId: d.ruleId } : {}) };
}
