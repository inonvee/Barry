import type { BusinessGraph } from "@/lib/business-graph";
import { capabilityDomain, type CapabilityId } from "@/lib/fabric/capability";
import "@/lib/fabric/builtin";

/**
 * UNIVERSAL CAPABILITY MODEL + PROVIDER-SPECIFIC OPTIMIZATION.
 *
 * BARRY reasons in capabilities ("I need live inventory", "I need a
 * payment link"), never in providers. Each provider adapter declares which
 * operations of a capability it really supports; the runtime resolves a
 * per-business profile from whatever the business actually connected.
 * That profile decides what BARRY may promise, what it can automate, what
 * needs a fallback, and what readiness reports as blocked.
 */

/**
 * The capability DOMAINS BARRY's conversation planner operates today, with
 * the legacy operation names their adapters declare. This is a readiness
 * SUMMARY for these domains only — capability resolution itself is open
 * (src/lib/fabric): any namespaced capability id can be registered and
 * resolved without touching this list.
 */
export const CAPABILITY_OPERATIONS = {
  commerce: ["catalogSearch", "catalogSchema", "variants", "liveInventory", "cart", "checkout", "orders", "orderStatus"],
  payments: ["paymentLinks", "statusLookup", "webhookVerification", "refunds"],
  scheduling: ["availability", "booking", "bookingLookup"],
  messaging: ["send"],
} as const;

export type Capability = keyof typeof CAPABILITY_OPERATIONS;
export type CommerceOperation = (typeof CAPABILITY_OPERATIONS)["commerce"][number];
export type PaymentOperation = (typeof CAPABILITY_OPERATIONS)["payments"][number];
export type SchedulingOperation = (typeof CAPABILITY_OPERATIONS)["scheduling"][number];
export type CapabilityOperation<C extends Capability = Capability> = (typeof CAPABILITY_OPERATIONS)[C][number];

/**
 * The capability ids (see src/lib/fabric/builtin.ts) each Business Genome
 * action needs. The runtime gate asks the fabric whether the business's
 * connected systems provide them — never which vendor is connected.
 */
export const ACTION_REQUIREMENTS: Record<string, CapabilityId[]> = {
  searchProducts: ["commerce.catalog.search"],
  addToCart: ["commerce.cart.create", "commerce.cart.update", "commerce.inventory.read"],
  updateCartLine: ["commerce.cart.update"],
  createCommerceCheckout: ["commerce.checkout.create", "payments.create_request"],
  createCommerceOrder: ["commerce.order.create"],
  createPaymentRequest: ["payments.create_request"],
  verifyPayment: ["payments.verify"],
  checkAvailability: ["scheduling.availability.read"],
  createBooking: ["scheduling.booking.create"],
};

/** Which Business Genome actions each domain serves — derived from ACTION_REQUIREMENTS, never maintained by hand. */
export const CAPABILITY_ACTIONS: Record<Capability, string[]> = (() => {
  const out: Record<Capability, string[]> = { commerce: [], payments: [], scheduling: [], messaging: [] };
  for (const [action, ids] of Object.entries(ACTION_REQUIREMENTS)) {
    for (const domain of new Set(ids.map(capabilityDomain))) {
      if (domain in out && !out[domain as Capability].includes(action)) out[domain as Capability].push(action);
    }
  }
  return out;
})();

export type CapabilityProfile = {
  capability: Capability;
  /** Whether this business's Genome uses the capability at all. */
  used: boolean;
  provider: string | null;
  status: "connected" | "not_configured" | "error";
  /** A simulated/fixture provider: fine for development, never a real integration. */
  simulated: boolean;
  /** Legacy operation names (for readiness wording). */
  operations: string[];
  missingOperations: string[];
  /** Capability ids of this domain the connected system provides — what the runtime gate checks. */
  capabilities: CapabilityId[];
  error?: string;
};

export type CapabilityProfiles = Record<Capability, CapabilityProfile>;

/** Can the business's connected systems perform this action? Unknown actions need no provider. */
export function actionSupported(profiles: CapabilityProfiles | undefined, action: string): { ok: boolean; missing: string[] } {
  if (!profiles) return { ok: true, missing: [] };
  const missing: string[] = [];
  for (const id of ACTION_REQUIREMENTS[action] ?? []) {
    const profile = (profiles as Record<string, CapabilityProfile | undefined>)[capabilityDomain(id)];
    if (!profile || profile.status !== "connected" || !profile.capabilities.includes(id)) missing.push(id);
  }
  return { ok: missing.length === 0, missing };
}

/** Compact, secret-free form for the model and for traces. */
export function profilesForModel(profiles: CapabilityProfiles) {
  return (Object.values(profiles) as CapabilityProfile[])
    .filter((p) => p.used || p.status === "connected")
    .map((p) => ({ capability: p.capability, connected: p.status === "connected", operations: p.operations }));
}

export function usedCapabilities(graph: BusinessGraph): Capability[] {
  const enabled = new Set(graph.availableActions.filter((a) => a.enabled).map((a) => a.name));
  return (Object.keys(CAPABILITY_ACTIONS) as Capability[]).filter((cap) => CAPABILITY_ACTIONS[cap].some((a) => enabled.has(a)));
}

