/**
 * THE PLAN CATALOG — the one canonical list of what each BARRY plan includes, used by sales /
 * onboarding (HQ), Owner settings, readiness, the unit-economics engine and runtime capability
 * availability. Pure data + pure functions; no business-specific branch.
 *
 * Prices are INTERNAL LAUNCH TARGETS (see docs/BUSINESS_MODEL_V1.md), not contract text. Fixed monthly
 * pricing; no revenue share, no % of revenue, no % of savings, no overage billing.
 *
 * A plan answers ONE question: "did the customer buy access to this?" It can only REMOVE availability;
 * whether BARRY may act right now is still decided by authority (policy engine + founder controls).
 */

export type PlanId = "CORE" | "OPERATOR" | "INTELLIGENCE" | "CUSTOM";

/** Product features a plan includes. Stable names; the runtime maps actions onto them below. */
export type Feature =
  | "knowledge" // business knowledge, customer questions, reads from connected systems
  | "inbox_handoff" // Inbox, handoffs to the team
  | "selling_basic" // search / recommend / stock + availability reads, leads, media
  | "approvals_basic" // the owner approves what BARRY may not do alone
  | "train" // Train BARRY
  | "owner_visibility" // Owner Today, conversations, value summary
  | "commerce_transactions" // carts, discounts, orders
  | "bookings"
  | "payments"
  | "proactive_followups"
  | "recovery"
  | "connected_systems_execution" // consequential calls into the business's connected systems
  | "margins"; // BARRY Margins: cost intelligence, margin leakage, savings opportunities

export type PlanDefinition = {
  id: PlanId;
  name: string;
  promise: string;
  /** Monthly subscription (USD launch target). null for CUSTOM: priced per deal. */
  monthlyPrice: number | null;
  /** "Setup from" (USD launch target). */
  setupFrom: number | null;
  currency: "USD";
  features: Feature[];
  /** Initial direct-cost guardrail per month until measured data replaces the assumption. */
  costGuardrail: number | null;
  /** Owner words, one line per capability group. */
  includes: string[];
};

export const CATALOG_VERSION = "2026-10-v1";
export const FREE_PERIOD_DAYS = 30;
export const GROSS_MARGIN_TARGET_PCT = 70;

const CORE_FEATURES: Feature[] = ["knowledge", "inbox_handoff", "selling_basic", "approvals_basic", "train", "owner_visibility"];
const OPERATOR_FEATURES: Feature[] = [...CORE_FEATURES, "commerce_transactions", "bookings", "payments", "proactive_followups", "recovery", "connected_systems_execution"];
const INTELLIGENCE_FEATURES: Feature[] = [...OPERATOR_FEATURES, "margins"];

export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  CORE: {
    id: "CORE",
    name: "BARRY Core",
    promise: "BARRY talks.",
    monthlyPrice: 399,
    setupFrom: 750,
    currency: "USD",
    features: CORE_FEATURES,
    costGuardrail: 120,
    includes: ["Answers customer questions from your business knowledge", "Inbox and handoffs to your team", "Recommends and finds products / services", "Asks you before anything it may not do alone", "Train BARRY and full owner visibility"],
  },
  OPERATOR: {
    id: "OPERATOR",
    name: "BARRY Operator",
    promise: "BARRY works.",
    monthlyPrice: 899,
    setupFrom: 1500,
    currency: "USD",
    features: OPERATOR_FEATURES,
    costGuardrail: 270,
    includes: ["Everything in Core", "Carts, orders, bookings and payment links", "Consequential actions with your approvals", "Proactive follow-ups and revenue recovery", "Works across several connected systems"],
  },
  INTELLIGENCE: {
    id: "INTELLIGENCE",
    name: "BARRY Intelligence",
    promise: "BARRY improves.",
    monthlyPrice: 1799,
    setupFrom: 3000,
    currency: "USD",
    features: INTELLIGENCE_FEATURES,
    costGuardrail: 540,
    includes: ["Everything in Operator", "BARRY Margins: cost intelligence and margin leakage", "Supplier, fee, shipping, SaaS and inventory opportunities — where cost evidence exists", "BARRY MADE and BARRY SAVED, evidence-backed"],
  },
  CUSTOM: {
    id: "CUSTOM",
    name: "BARRY Custom",
    promise: "Scoped with you.",
    monthlyPrice: null,
    setupFrom: null,
    currency: "USD",
    features: INTELLIGENCE_FEATURES,
    costGuardrail: null,
    includes: ["Custom scope and pricing, agreed with the BARRY team"],
  },
};

export const STANDARD_PLANS: PlanId[] = ["CORE", "OPERATOR", "INTELLIGENCE"];

export const FEATURE_WORDS: Record<Feature, string> = {
  knowledge: "Answer customer questions from your business knowledge",
  inbox_handoff: "Inbox and handoffs to your team",
  selling_basic: "Find and recommend products / services",
  approvals_basic: "Ask you before anything it may not do alone",
  train: "Train BARRY",
  owner_visibility: "Owner visibility and monthly value summary",
  commerce_transactions: "Carts, discounts and orders",
  bookings: "Book appointments",
  payments: "Send payment links",
  proactive_followups: "Proactive follow-ups",
  recovery: "Revenue recovery",
  connected_systems_execution: "Act in your connected systems",
  margins: "BARRY Margins (cost intelligence)",
};

/** The cheapest standard plan that includes a feature — what an upgrade would unlock. */
export function planUnlocking(feature: Feature): PlanId | null {
  return STANDARD_PLANS.find((p) => PLAN_CATALOG[p].features.includes(feature)) ?? null;
}

// ── Runtime action → feature ──────────────────────────────────────────────────────────────────────

/** Typed actions → the feature a plan must include. Reads stay available on every plan. */
const ACTION_FEATURE: Record<string, Feature> = {
  searchProducts: "selling_basic",
  checkInventory: "selling_basic",
  checkAvailability: "selling_basic",
  verifyPayment: "knowledge",
  createLead: "selling_basic",
  sendMedia: "selling_basic",
  requestApproval: "approvals_basic",
  addToCart: "commerce_transactions",
  updateCartLine: "commerce_transactions",
  grantDiscount: "commerce_transactions",
  createCommerceOrder: "commerce_transactions",
  fulfillOrder: "commerce_transactions",
  createCommerceCheckout: "payments",
  createPaymentRequest: "payments",
  createBooking: "bookings",
  createFollowUp: "proactive_followups",
};

/**
 * The feature an action needs. A generic capability call needs "knowledge" for a read and
 * "connected_systems_execution" for anything consequential. An action the catalog doesn't know needs
 * the broadest execution feature — fail closed, never "free".
 */
export function featureForAction(action: string, effect?: "read" | "consequential"): Feature {
  if (action === "invokeCapability") return effect === "read" ? "knowledge" : "connected_systems_execution";
  return ACTION_FEATURE[action] ?? "connected_systems_execution";
}
