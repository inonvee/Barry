import { z } from "zod";

/**
 * Structured output the LLM must produce for a planning turn. This is
 * intentionally a separate (looser) schema from the internal `PlanResult`:
 * it's what we ask the model for and validate before ever trusting it.
 * `openai-reasoner.ts` maps a validated instance of this onto `PlanResult`,
 * re-checking anything safety-critical (offer id, action name) against the
 * real Business Graph rather than trusting the model's claim.
 */
export const LlmPlanSchema = z.object({
  intent: z.string(),
  selectedOfferId: z.string().nullable(),
  entities: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  knownFieldsUpdate: z.record(z.string(), z.string()).default({}),
  missingFields: z.array(z.string()).default([]),
  stage: z.enum([
    "discovery",
    "offer_selection",
    "info_gathering",
    "scheduling",
    "payment",
    "confirmation",
    "escalated",
    "closed",
  ]),
  goal: z
    .enum(["completePurchase", "bookAppointment", "collectDeposit", "qualifyLead", "requestQuote"])
    .nullable()
    .optional(),
  /** Null when BARRY should just reply in natural language instead of acting. */
  action: z
    .object({
      name: z.string(),
      input: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  /** Used only when action is null — what BARRY should say next. */
  reply: z.string().nullable(),
  /** Internal-only rationale, never shown to the customer. Debug/Inspector use only. */
  rationale: z.string().optional(),
});
export type LlmPlan = z.infer<typeof LlmPlanSchema>;
