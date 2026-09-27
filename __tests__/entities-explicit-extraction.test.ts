import { describe, expect, it } from "vitest";
import { extractExplicitSchedulingConstraint, findOffersByExplicitNameReference } from "@/lib/reasoner/entities";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * Unit-level pinning for the deterministic extractors verifyIR() builds
 * on (SEMANTIC IR VERIFICATION MISSION). These only ever describe
 * SEMANTIC scheduling info or a name-token match — never a resolved
 * timestamp and never a description-word match — so a regression here
 * shows up at the lowest possible level, before it reaches verifyIR()
 * or the compiler.
 */
describe("extractExplicitSchedulingConstraint", () => {
  it('"Tuesday at 3pm" extracts weekday=2 (Tuesday), hour=15', () => {
    const result = extractExplicitSchedulingConstraint("I wanna come with my wife on Tuesday at 3pm");
    expect(result?.date).toEqual({ kind: "weekday", weekday: 2, qualifier: undefined });
    expect(result?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
  });

  it('"next Monday" extracts weekday=1 (Monday) with qualifier "next"', () => {
    const result = extractExplicitSchedulingConstraint("let's do next Monday");
    expect(result?.date).toEqual({ kind: "weekday", weekday: 1, qualifier: "next" });
  });

  it('bare "Monday" (no "next") extracts qualifier undefined', () => {
    const result = extractExplicitSchedulingConstraint("how about Monday");
    expect(result?.date).toEqual({ kind: "weekday", weekday: 1, qualifier: undefined });
  });

  it('"tomorrow" extracts relativeDay days=1', () => {
    const result = extractExplicitSchedulingConstraint("can I come tomorrow");
    expect(result?.date).toEqual({ kind: "relativeDay", days: 1 });
  });

  it('"today" extracts relativeDay days=0', () => {
    const result = extractExplicitSchedulingConstraint("is there anything today");
    expect(result?.date).toEqual({ kind: "relativeDay", days: 0 });
  });

  it("returns undefined when no explicit weekday/relative-day token is present", () => {
    expect(extractExplicitSchedulingConstraint("sometime soon works for me")).toBeUndefined();
    expect(extractExplicitSchedulingConstraint("How much is it?")).toBeUndefined();
  });

  /**
   * Whole-word weekday matching: a short weekday form ("fri", "mon",
   * "wed", "sun", "sat") must never match as a substring inside an
   * unrelated word. The old `text.indexOf("fri")`-style check matched
   * "friend" as Friday, "money" as Monday, "wedding" as Wednesday,
   * "sunflower" as Sunday, and "satisfied" as Saturday.
   */
  describe("whole-word weekday matching (no substring false positives)", () => {
    it.each([
      "How much money is it?",
      "I'm coming with my friend",
      "My wedding is soon",
      "I like sunflowers",
      "I'm satisfied",
    ])('"%s" extracts no scheduling date', (message) => {
      expect(extractExplicitSchedulingConstraint(message)).toBeUndefined();
    });

    it.each([
      ["Tuesday", 2, undefined],
      ["Tue", 2, undefined],
      ["next Tuesday", 2, "next"],
      ["Friday at 3pm", 5, undefined],
      ["Sun at 1pm", 0, undefined],
    ] as const)('"%s" extracts weekday=%i, qualifier=%s', (message, weekday, qualifier) => {
      const result = extractExplicitSchedulingConstraint(message);
      expect(result?.date).toEqual({ kind: "weekday", weekday, qualifier });
    });

    it('"Friday at 3pm" also extracts the explicit time (hour 15)', () => {
      const result = extractExplicitSchedulingConstraint("Friday at 3pm");
      expect(result?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
    });

    it("recognizes every canonical long and short weekday form", () => {
      const cases: [string, number][] = [
        ["Sunday", 0], ["Sun", 0],
        ["Monday", 1], ["Mon", 1],
        ["Tuesday", 2], ["Tue", 2], ["Tues", 2],
        ["Wednesday", 3], ["Wed", 3],
        ["Thursday", 4], ["Thu", 4], ["Thurs", 4],
        ["Friday", 5], ["Fri", 5],
        ["Saturday", 6], ["Sat", 6],
      ];
      for (const [word, weekday] of cases) {
        expect(extractExplicitSchedulingConstraint(`See you ${word}`)?.date).toEqual({
          kind: "weekday",
          weekday,
          qualifier: undefined,
        });
      }
    });

    it("matching is case-insensitive", () => {
      expect(extractExplicitSchedulingConstraint("TUESDAY works")?.date).toEqual({
        kind: "weekday",
        weekday: 2,
        qualifier: undefined,
      });
    });
  });
});

describe("findOffersByExplicitNameReference", () => {
  const graph = buildSpaGraph();

  it.each([
    ["Couples", "offer-couples-massage"],
    ["Couples Massage", "offer-couples-massage"],
    ["the couples one", "offer-couples-massage"],
    ["Solo", "offer-solo-massage"],
    ["Solo Swedish", "offer-solo-massage"],
    ["Swedish Massage", "offer-solo-massage"],
  ] as const)('"%s" resolves confidently to exactly %s', (message, expectedId) => {
    const matches = findOffersByExplicitNameReference(graph, message);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(expectedId);
  });

  it("a phrase matching neither offer's name returns no matches", () => {
    expect(findOffersByExplicitNameReference(graph, "I want something relaxing")).toEqual([]);
  });

  it("never matches on a DESCRIPTION-only word (avoids false-positive overrides)", () => {
    // "for two" is in Couples Massage's description, not its name.
    expect(findOffersByExplicitNameReference(graph, "bring two friends")).toEqual([]);
  });
});
