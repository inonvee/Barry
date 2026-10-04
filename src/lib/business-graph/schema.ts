import { z } from "zod";

/**
 * The Business Graph is the single structured representation of "how a
 * business works" that BARRY reasons over. Nothing in the runtime, policy
 * engine, or tool layer is allowed to branch on business *type* — only on
 * the capabilities and data declared here.
 */

export const CapabilityFlagsSchema = z.object({
  requiresScheduling: z.boolean().default(false),
  requiresInventory: z.boolean().default(false),
  requiresPayment: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
});
export type CapabilityFlags = z.infer<typeof CapabilityFlagsSchema>;

export const ToneSchema = z.object({
  voice: z.enum(["friendly", "professional", "playful", "concise", "warm"]).default("friendly"),
  formality: z.enum(["casual", "neutral", "formal"]).default("neutral"),
  emojiOk: z.boolean().default(false),
  notes: z.string().optional(),
});
export type Tone = z.infer<typeof ToneSchema>;

export const BusinessSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Other names people use for the business (e.g. its name in another language) — reference data for grounding a mention, never logic. */
  aliases: z.array(z.string()).default([]),
  description: z.string(),
  locale: z.string().default("en-US"),
  timezone: z.string().default("UTC"),
  tone: ToneSchema,
  operatingHours: z
    .array(
      z.object({
        day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
        open: z.string(), // "09:00"
        close: z.string(), // "18:00"
      })
    )
    .default([]),
});
export type Business = z.infer<typeof BusinessSchema>;

/** Anything a customer can obtain: product, service, appointment, package, consultation, quote. */
export const OfferKindSchema = z.enum([
  "product",
  "service",
  "appointment",
  "package",
  "consultation",
  "quote",
]);
export type OfferKind = z.infer<typeof OfferKindSchema>;

export const OfferVariantSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceDelta: z.number().default(0),
  attributes: z.record(z.string(), z.string()).default({}),
});
export type OfferVariant = z.infer<typeof OfferVariantSchema>;

export const OfferSchema = z.object({
  id: z.string(),
  kind: OfferKindSchema,
  name: z.string(),
  description: z.string(),
  /**
   * Alternate normalized names/short forms a customer might use to refer
   * to this offer explicitly — e.g. other-language names, colloquial
   * short forms ("זוגי" for a couples package), or common misspellings.
   * Never business-type logic: this is generic reference data any
   * offer can declare, consumed by the SAME deterministic offer-reference
   * verifier that already matches on `name` (see
   * `findOffersByExplicitNameReference` in `src/lib/reasoner/entities.ts`).
   */
  aliases: z.array(z.string()).default([]),
  price: z.number().nonnegative().nullable(), // null = requires quote
  currency: z.string().default("USD"),
  variants: z.array(OfferVariantSchema).default([]),

  // Scheduling
  requiresScheduling: z.boolean().default(false),
  durationMinutes: z.number().positive().optional(),

  // Inventory
  requiresInventory: z.boolean().default(false),
  sku: z.string().optional(),

  // Resources needed to fulfill (ids into Resource list)
  requiredResourceTypes: z.array(z.string()).default([]),

  // Info BARRY must collect from the customer before this offer can be fulfilled
  requiredCustomerInfo: z.array(z.string()).default([]),

  // Payment
  requiresPayment: z.boolean().default(false),
  depositAmount: z.number().nonnegative().optional(),

  active: z.boolean().default(true),
});
export type Offer = z.infer<typeof OfferSchema>;

export const ResourceSchema = z.object({
  id: z.string(),
  type: z.string(), // "therapist" | "room" | "employee" | "vehicle_bay" | "equipment" | ...
  name: z.string(),
  capacity: z.number().positive().default(1),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const AvailabilitySlotSchema = z.object({
  resourceId: z.string(),
  start: z.string(), // ISO datetime
  end: z.string(), // ISO datetime
});
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;

export const InventoryItemSchema = z.object({
  sku: z.string(),
  quantityOnHand: z.number().int().nonnegative(),
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const KnowledgeItemSchema = z.object({
  id: z.string(),
  topic: z.string(),
  content: z.string(),
  kind: z.enum(["fact", "faq", "policy_text", "product_info", "service_info"]).default("fact"),
});
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

/** Rules defining what BARRY can promise or do without escalating to the owner. */
/**
 * Where an EFFECTIVE policy came from: the static business profile, or an owner-trained rule compiled from
 * an owner-approved learned fact (with its source fact, reviewer, revision and what it superseded).
 */
export const PolicyProvenanceSchema = z.object({
  source: z.enum(["static", "owner_trained"]),
  factId: z.string().optional(),
  factKey: z.string().optional(),
  sourceKind: z.string().optional(),
  reviewer: z.string().optional(),
  reviewedAt: z.string().optional(),
  revision: z.string(),
  supersedes: z.array(z.object({ source: z.enum(["static", "owner_trained"]), value: z.number(), revision: z.string(), factId: z.string().optional() })).default([]),
});
export type PolicyProvenance = z.infer<typeof PolicyProvenanceSchema>;

export const PolicySchema = z.object({
  id: z.string(),
  description: z.string(),
  /** Absent on profile-declared policies (treated as static). */
  provenance: PolicyProvenanceSchema.optional(),
  rule: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("max_auto_discount_pct"),
      value: z.number().min(0).max(100),
    }),
    z.object({
      type: z.literal("refund_requires_approval"),
      value: z.boolean(),
    }),
    z.object({
      type: z.literal("bookings_auto_allowed"),
      value: z.boolean(),
    }),
    z.object({
      type: z.literal("custom_pricing_requires_approval"),
      value: z.boolean(),
    }),
    z.object({
      type: z.literal("max_auto_payment_amount"),
      value: z.number().min(0),
    }),
    /** Shipping is free when the goods total (after discount) reaches this amount, in the business currency. */
    z.object({
      type: z.literal("free_shipping_over"),
      value: z.number().min(0),
    }),
    /** Shipping costs this flat fee (below any free-shipping threshold). Absent -> the fee is unknown, never invented. */
    z.object({
      type: z.literal("flat_shipping_fee"),
      value: z.number().min(0),
    }),
  ]),
});
export type Policy = z.infer<typeof PolicySchema>;

export const AvailableActionSchema = z.object({
  name: z.string(), // must match a registered tool name
  enabled: z.boolean().default(true),
});
export type AvailableAction = z.infer<typeof AvailableActionSchema>;

export const GoalSchema = z.enum([
  "completePurchase",
  "bookAppointment",
  "collectDeposit",
  "qualifyLead",
  "requestQuote",
]);
export type Goal = z.infer<typeof GoalSchema>;

/**
 * How THIS business wants BARRY to operate — the business-specific layer
 * on top of the universal BARRY Constitution. Written by the owner (or
 * learned and owner-approved), never inferred from an industry. An
 * explicit playbook setting always wins over BARRY's global default.
 */
export const FollowUpRuleSchema = z.object({
  enabled: z.boolean().default(true),
  /** Hours after the triggering record before the first follow-up. */
  afterHours: z.number().min(0).max(24 * 30).optional(),
  maxAttempts: z.number().int().min(0).max(5).optional(),
  intervalHours: z.number().min(1).max(24 * 30).optional(),
});
export type FollowUpRule = z.infer<typeof FollowUpRuleSchema>;

export const PlaybookSchema = z.object({
  /** The owner's own words on how to sell/serve (e.g. "relaxed, no pressure, short messages"). */
  salesStyle: z.string().max(1000).optional(),
  commerce: z
    .object({
      /**
       * on_purchase_decision: once a customer has decided ("I'll take it"),
       * BARRY moves straight on to checkout. on_request: BARRY adds to the
       * cart and waits until the customer asks to check out (e.g. stores
       * where customers usually build large baskets).
       */
      advanceToCheckout: z.enum(["on_purchase_decision", "on_request"]).default("on_purchase_decision"),
      /** Customer details this business needs before it can send a checkout (e.g. name, phone). */
      checkoutRequires: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Whether BARRY may suggest one genuinely relevant addition (never more). */
  suggestions: z.enum(["none", "one_relevant"]).default("one_relevant"),
  /** Who/how to hand off to when BARRY can't help. */
  handoff: z.string().max(500).optional(),
  /**
   * FOLLOW-UP RULES — whether, when and how often BARRY may follow up on its own (unpaid links,
   * abandoned checkouts, reminders, retries). Absent = BARRY's bounded defaults; `enabled: false`
   * turns a kind off. Never more than `maxAttempts`, never closer than `intervalHours` apart.
   */
  followUp: z
    .object({
      unpaidPayment: FollowUpRuleSchema.optional(),
      abandonedCheckout: FollowUpRuleSchema.optional(),
      unresolvedHandoff: FollowUpRuleSchema.optional(),
      appointmentReminder: FollowUpRuleSchema.optional(),
      failedAction: FollowUpRuleSchema.optional(),
    })
    .optional(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

/**
 * AUTHORITY: what BARRY may do on its own, per capability, for THIS business.
 * A bounded, auditable rule language — no expressions, no code:
 *   capability  an exact id ("shipping.create_shipment") or a domain wildcard ("shipping.*")
 *   effect      allow | require_approval | deny
 *   when        ALL conditions must hold; each compares ONE top-level input field
 *               of the capability call with a literal (lte/lt/gte/gt/eq/neq/in/exists)
 * Among matching rules the most restrictive wins (deny > require_approval > allow).
 * A capability no rule allows is DENIED — reads included; authority is never assumed from effect=read.
 */
export const AuthorityConditionSchema = z.object({
  field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  op: z.enum(["lte", "lt", "gte", "gt", "eq", "neq", "in", "exists"]),
  value: z.union([z.number(), z.string().max(200), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(200)]).optional(),
});
export type AuthorityCondition = z.infer<typeof AuthorityConditionSchema>;

export const AuthorityRuleSchema = z.object({
  id: z.string().min(1).max(100),
  capability: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?$/),
  effect: z.enum(["allow", "require_approval", "deny"]),
  when: z.array(AuthorityConditionSchema).max(10).default([]),
  /** Shown to owners and recorded in traces. */
  reason: z.string().max(300).optional(),
});
export type AuthorityRule = z.infer<typeof AuthorityRuleSchema>;

export const BusinessGraphSchema = z.object({
  business: BusinessSchema,
  capabilities: CapabilityFlagsSchema,
  offers: z.array(OfferSchema),
  resources: z.array(ResourceSchema),
  availability: z.array(AvailabilitySlotSchema).default([]),
  inventory: z.array(InventoryItemSchema).default([]),
  knowledge: z.array(KnowledgeItemSchema).default([]),
  policies: z.array(PolicySchema),
  availableActions: z.array(AvailableActionSchema),
  goals: z.array(GoalSchema),
  playbook: PlaybookSchema.prefault({}),
  /** Per-capability authority rules (see AuthorityRuleSchema). */
  authority: z.array(AuthorityRuleSchema).default([]),
});
export type BusinessGraph = z.infer<typeof BusinessGraphSchema>;
