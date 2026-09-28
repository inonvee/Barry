import type { BusinessGraph } from "@/lib/business-graph";

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

/** Which Business Genome actions each capability serves — the single mapping used everywhere. */
export const CAPABILITY_ACTIONS: Record<Capability, string[]> = {
  // (checkInventory/fulfillOrder act on inventory held in the Business Genome itself, not a provider.)
  commerce: ["searchProducts", "addToCart", "updateCartLine", "createCommerceCheckout", "createCommerceOrder"],
  payments: ["createPaymentRequest", "createCommerceCheckout", "verifyPayment"],
  scheduling: ["checkAvailability", "createBooking"],
  messaging: [],
};

/** The operation(s) an action needs from its capability's provider. */
export const ACTION_REQUIREMENTS: Record<string, { capability: Capability; operations: CapabilityOperation[] }[]> = {
  searchProducts: [{ capability: "commerce", operations: ["catalogSearch"] }],
  addToCart: [{ capability: "commerce", operations: ["cart", "liveInventory"] }],
  updateCartLine: [{ capability: "commerce", operations: ["cart"] }],
  createCommerceCheckout: [
    { capability: "commerce", operations: ["checkout"] },
    { capability: "payments", operations: ["paymentLinks"] },
  ],
  createCommerceOrder: [{ capability: "commerce", operations: ["orders"] }],
  createPaymentRequest: [{ capability: "payments", operations: ["paymentLinks"] }],
  verifyPayment: [{ capability: "payments", operations: ["statusLookup"] }],
  checkAvailability: [{ capability: "scheduling", operations: ["availability"] }],
  createBooking: [{ capability: "scheduling", operations: ["booking"] }],
};

export type CapabilityProfile = {
  capability: Capability;
  /** Whether this business's Genome uses the capability at all. */
  used: boolean;
  provider: string | null;
  status: "connected" | "not_configured" | "error";
  /** A simulated/fixture provider: fine for development, never a real integration. */
  simulated: boolean;
  operations: string[];
  missingOperations: string[];
  error?: string;
};

export type CapabilityProfiles = Record<Capability, CapabilityProfile>;

/** Can the connected providers perform this action? Unknown actions need no provider. */
export function actionSupported(profiles: CapabilityProfiles | undefined, action: string): { ok: boolean; missing: string[] } {
  if (!profiles) return { ok: true, missing: [] };
  const missing: string[] = [];
  for (const req of ACTION_REQUIREMENTS[action] ?? []) {
    const profile = profiles[req.capability];
    for (const op of req.operations) {
      if (profile.status !== "connected" || !profile.operations.includes(op)) missing.push(`${req.capability}.${op}`);
    }
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

