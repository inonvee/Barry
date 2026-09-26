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
export const PolicySchema = z.object({
  id: z.string(),
  description: z.string(),
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
});
export type BusinessGraph = z.infer<typeof BusinessGraphSchema>;
