import { z } from "zod";

/**
 * Structured output the LLM must produce for an understanding turn — BARRY
 * IR, and NOTHING else. There is deliberately no "action" or "tool input"
 * field here: the LLM cannot construct a tool call even in principle.
 *
 * This Zod schema and `irJsonSchema()` in `openai-reasoner.ts` describe the
 * SAME contract on purpose, because OpenAI's Structured Outputs "strict"
 * mode (which actually constrains generation, unlike advisory/non-strict
 * mode) only supports a specific JSON Schema subset:
 *   - every object needs `additionalProperties: false`
 *   - every property of every object must appear in that object's
 *     `required` array — "optional" only exists via nullable types
 *     (`type: [X, "null"]`), never via omission
 *   - free-form dictionaries (`{ type: "object" }` with unknown keys) are
 *     NOT expressible at all
 *
 * That last point is why `entities` and `knownFieldsUpdate` are arrays of
 * `{ key, value }` pairs here instead of `Record<string, string>` — a real
 * key-value bag has no fixed shape, so strict mode can't represent it
 * directly. Every field below is therefore always present in the raw
 * response (no `.optional()`/`.default()` — those are Zod-only conveniences
 * that don't exist on the wire); "not present" is represented as `null` or
 * an empty array, never by leaving a key out.
 */
export const KeyValuePairSchema = z.object({ key: z.string(), value: z.string() });
export type KeyValuePair = z.infer<typeof KeyValuePairSchema>;

/**
 * Flattened, strict-mode-compatible representation of a semantic
 * scheduling constraint. The model describes WHAT the customer said
 * ("Sunday", "at 2pm") — never a resolved timestamp; a tagged union
 * (DateSpec | TimeSpec, see src/lib/scheduling/resolver.ts) isn't directly
 * expressible in strict mode, so every possible field is flattened here
 * and reconstructed into the real union in `sanitizeIR`. `dateKind`/
 * `timeKind` say which of the other fields are meaningful; the rest are
 * null when not applicable.
 */
export const LlmSchedulingWindowSchema = z.object({
  dateKind: z.enum(["explicitDate", "relativeDay", "weekday"]).nullable(),
  isoDate: z.string().nullable(), // for explicitDate: "YYYY-MM-DD"
  relativeDays: z.number().nullable(), // for relativeDay: 0=today, 1=tomorrow, ...
  weekday: z.number().nullable(), // for weekday: 0=Sun..6=Sat
  weekdayQualifier: z.enum(["this", "next"]).nullable(),
  timeKind: z.enum(["explicitTime", "partOfDay"]).nullable(),
  hour: z.number().nullable(), // for explicitTime: 24h, local to the business
  minute: z.number().nullable(),
  partOfDay: z.enum(["morning", "afternoon", "evening"]).nullable(),
});
export type LlmSchedulingWindow = z.infer<typeof LlmSchedulingWindowSchema>;

export const LlmIRSchema = z.object({
  intent: z.string(),
  selectedOfferId: z.string().nullable(),
  offerCandidateIds: z.array(z.string()),
  entities: z.array(KeyValuePairSchema),
  constraints: z.object({
    schedulingWindow: LlmSchedulingWindowSchema.nullable(),
    partySize: z.number().nullable(),
    discountPct: z.number().nullable(),
    slotAccepted: z.boolean().nullable(),
  }),
  knownFieldsUpdate: z.array(KeyValuePairSchema),
  requestedCapability: z.string().nullable(),
  goal: z
    .enum(["completePurchase", "bookAppointment", "collectDeposit", "qualifyLead", "requestQuote"])
    .nullable(),
});
export type LlmIR = z.infer<typeof LlmIRSchema>;

function kvSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: { key: { type: "string" }, value: { type: "string" } },
    required: ["key", "value"],
  };
}

/**
 * The JSON Schema sent to OpenAI as `response_format.json_schema.schema`
 * with `strict: true`. Must describe exactly what `LlmIRSchema` above
 * validates — see the module docstring for why every property is always
 * `required` and nullable types replace optionality.
 */
export function irJsonSchema() {
  return {
    name: "barry_ir",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: { type: "string" },
        selectedOfferId: { type: ["string", "null"] },
        offerCandidateIds: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: kvSchema() },
        constraints: {
          type: "object",
          additionalProperties: false,
          properties: {
            schedulingWindow: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                dateKind: { type: ["string", "null"], enum: ["explicitDate", "relativeDay", "weekday", null] },
                isoDate: { type: ["string", "null"] },
                relativeDays: { type: ["number", "null"] },
                weekday: { type: ["number", "null"] },
                weekdayQualifier: { type: ["string", "null"], enum: ["this", "next", null] },
                timeKind: { type: ["string", "null"], enum: ["explicitTime", "partOfDay", null] },
                hour: { type: ["number", "null"] },
                minute: { type: ["number", "null"] },
                partOfDay: { type: ["string", "null"], enum: ["morning", "afternoon", "evening", null] },
              },
              required: [
                "dateKind",
                "isoDate",
                "relativeDays",
                "weekday",
                "weekdayQualifier",
                "timeKind",
                "hour",
                "minute",
                "partOfDay",
              ],
            },
            partySize: { type: ["number", "null"] },
            discountPct: { type: ["number", "null"] },
            slotAccepted: { type: ["boolean", "null"] },
          },
          required: ["schedulingWindow", "partySize", "discountPct", "slotAccepted"],
        },
        knownFieldsUpdate: { type: "array", items: kvSchema() },
        requestedCapability: { type: ["string", "null"] },
        goal: {
          type: ["string", "null"],
          enum: ["completePurchase", "bookAppointment", "collectDeposit", "qualifyLead", "requestQuote", null],
        },
      },
      required: [
        "intent",
        "selectedOfferId",
        "offerCandidateIds",
        "entities",
        "constraints",
        "knownFieldsUpdate",
        "requestedCapability",
        "goal",
      ],
    },
  };
}
