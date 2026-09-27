import { describe, expect, it } from "vitest";
import { parseIRResponse, sanitizeIR } from "@/lib/reasoner/openai-reasoner";
import { LlmIRSchema } from "@/lib/reasoner/schemas";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * Regression coverage for the live "understanding_failed" bug: OpenAI's
 * Structured Outputs strict mode (which actually constrains generation)
 * requires every object to have additionalProperties:false and every
 * property listed in `required` — free-form dictionaries can't be
 * expressed at all. The old schema had none of this and used
 * `strict: false`, so nothing ever verified the model's output actually
 * matched, and it silently failed validation on every single turn.
 *
 * These tests exercise `parseIRResponse()` — the pure parse/validate/
 * sanitize pipeline — directly with hand-crafted raw strings, so the
 * exact failure modes are testable without a network call.
 */

const NULL_SCHEDULING_WINDOW = {
  dateKind: null,
  isoDate: null,
  relativeDays: null,
  weekday: null,
  weekdayQualifier: null,
  timeKind: null,
  hour: null,
  minute: null,
  partOfDay: null,
};

function validRawIR(overrides: Record<string, unknown> = {}) {
  return {
    intent: "discovery",
    selectedOfferId: null,
    offerCandidateIds: [],
    offerChangeRequested: null,
    entities: [],
    constraints: { schedulingWindow: NULL_SCHEDULING_WINDOW, partySize: null, discountPct: null, slotAccepted: null },
    customerInfo: [],
    requestedCapability: null,
    goal: null,
    ...overrides,
  };
}

describe("LLM IR contract: parseIRResponse", () => {
  it("accepts a fully strict-mode-compliant response (the shape a real model call should produce)", () => {
    const graph = buildSpaGraph();
    const raw = JSON.stringify(
      validRawIR({
        intent: "offer_interest",
        selectedOfferId: "offer-couples-massage",
        entities: [{ key: "service", value: "couples massage" }],
        constraints: {
          schedulingWindow: {
            ...NULL_SCHEDULING_WINDOW,
            dateKind: "weekday",
            weekday: 0,
            timeKind: "explicitTime",
            hour: 14,
            minute: 0,
          },
          partySize: 2,
          discountPct: null,
          slotAccepted: null,
        },
        customerInfo: [{ key: "name", value: "Jordan Lee" }],
      })
    );

    const result = parseIRResponse(graph, raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ir.selectedOfferId).toBe("offer-couples-massage");
      expect(result.ir.constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 0, qualifier: undefined });
      expect(result.ir.constraints.schedulingWindow?.time).toEqual({ kind: "explicitTime", hour: 14, minute: 0 });
      expect(result.ir.constraints.partySize).toBe(2);
      expect(result.ir.customerInfo.name).toBe("Jordan Lee");
      expect(result.ir.entities.service).toBe("couples massage");
    }
  });

  it("rejects invalid JSON with json_parse_error", () => {
    const graph = buildSpaGraph();
    const result = parseIRResponse(graph, "{not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("json_parse_error");
  });

  it("rejects a response missing a required field (no silent defaulting)", () => {
    const graph = buildSpaGraph();
    const raw = validRawIR();
    delete (raw as Record<string, unknown>).intent;
    const result = parseIRResponse(graph, JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema_validation_error");
  });

  it("rejects a response where entities/customerInfo are omitted entirely, not just empty", () => {
    const graph = buildSpaGraph();
    const raw = validRawIR();
    delete (raw as Record<string, unknown>).customerInfo;
    const result = parseIRResponse(graph, JSON.stringify(raw));
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong constraint type (partySize as a string instead of a number)", () => {
    const graph = buildSpaGraph();
    const raw = validRawIR({
      constraints: { schedulingWindow: NULL_SCHEDULING_WINDOW, partySize: "two", discountPct: null, slotAccepted: null },
    });
    const result = parseIRResponse(graph, JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema_validation_error");
  });

  it("drops an invalid/unknown offer id instead of trusting it", () => {
    const graph = buildSpaGraph();
    const raw = validRawIR({ selectedOfferId: "offer-does-not-exist" });
    const result = parseIRResponse(graph, JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ir.selectedOfferId).toBeUndefined();
  });

  it("drops an invalid/unknown offerChangeRequested id instead of trusting it", () => {
    const graph = buildSpaGraph();
    const raw = validRawIR({ offerChangeRequested: "offer-does-not-exist" });
    const result = parseIRResponse(graph, JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ir.offerChangeRequested).toBeUndefined();
  });

  it("filters unknown candidate offer ids out of offerCandidateIds", () => {
    const graph = buildSpaGraph();
    const raw = validRawIR({ offerCandidateIds: ["offer-couples-massage", "offer-does-not-exist"] });
    const result = parseIRResponse(graph, JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ir.offerCandidateIds).toEqual(["offer-couples-massage"]);
  });

  it("treats extra/unexpected top-level properties as harmless (stripped, not an error)", () => {
    const graph = buildSpaGraph();
    const raw = { ...validRawIR(), somethingTheModelInvented: "ignore me" };
    const result = parseIRResponse(graph, JSON.stringify(raw));
    expect(result.ok).toBe(true);
  });

  it("treats a scheduling window with both dateKind and timeKind null as no window at all", () => {
    const graph = buildSpaGraph();
    const parsed = LlmIRSchema.parse(validRawIR());
    const ir = sanitizeIR(graph, parsed);
    expect(ir.constraints.schedulingWindow).toBeUndefined();
  });

  it("ignores a dateKind without the data it needs (e.g. explicitDate with isoDate null)", () => {
    const graph = buildSpaGraph();
    const parsed = LlmIRSchema.parse(
      validRawIR({
        constraints: {
          schedulingWindow: { ...NULL_SCHEDULING_WINDOW, dateKind: "explicitDate", isoDate: null },
          partySize: null,
          discountPct: null,
          slotAccepted: null,
        },
      })
    );
    const ir = sanitizeIR(graph, parsed);
    expect(ir.constraints.schedulingWindow).toBeUndefined();
  });

  it("null and omitted-then-defaulted values never silently diverge — the schema has no defaults", () => {
    // A response that answers every field with null/empty (the "nothing to report" case,
    // e.g. for "Hey") must still parse successfully — null is a valid, intentional value,
    // distinct from a missing key.
    const graph = buildSpaGraph();
    const result = parseIRResponse(graph, JSON.stringify(validRawIR()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ir.selectedOfferId).toBeUndefined();
      expect(result.ir.constraints).toEqual({});
      expect(result.ir.entities).toEqual({});
      expect(result.ir.customerInfo).toEqual({});
    }
  });
});
