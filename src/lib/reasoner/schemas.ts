import { z } from "zod";

/**
 * Structured output the LLM must produce for an understanding turn — BARRY
 * IR, and NOTHING else. There is deliberately no "action" or "tool input"
 * field here: the LLM cannot construct a tool call even in principle. The
 * deterministic Action Compiler (`src/lib/runtime/compiler.ts`) is what
 * turns this into a `ToolCall`, after validating it against the real
 * Business Graph and the tool's own Zod schema.
 */
export const LlmIRSchema = z.object({
  intent: z.string(),
  selectedOfferId: z.string().nullable(),
  offerCandidateIds: z.array(z.string()).nullable(),
  entities: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  constraints: z
    .object({
      schedulingWindow: z
        .object({ earliest: z.string(), latest: z.string().nullable().optional() })
        .nullable()
        .optional(),
      partySize: z.number().nullable().optional(),
      discountPct: z.number().nullable().optional(),
      slotAccepted: z.boolean().nullable().optional(),
    })
    .default({}),
  knownFieldsUpdate: z.record(z.string(), z.string()).default({}),
  requestedCapability: z.string().nullable(),
  goal: z
    .enum(["completePurchase", "bookAppointment", "collectDeposit", "qualifyLead", "requestQuote"])
    .nullable(),
});
export type LlmIR = z.infer<typeof LlmIRSchema>;
