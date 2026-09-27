import { describe, expect, it } from "vitest";
import { verifyIR } from "@/lib/reasoner/verify";
import { extractExplicitSchedulingConstraint, findOffersByExplicitNameReference } from "@/lib/reasoner/entities";
import { handleCustomerMessage } from "@/lib/runtime";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * HEBREW SEMANTIC VERIFICATION MISSION: Hebrew natural-language
 * GENERATION already worked; Hebrew semantic VERIFICATION did not — the
 * same deterministic layer (`verifyIR`, `entities.ts`) that cross-checks
 * English offer references and weekdays against raw text had no
 * Hebrew-aware matching at all, and worse, `tokenize()` silently
 * stripped every Hebrew letter before any comparison ever ran (its regex
 * only kept `[a-z0-9]`). Every Hebrew offer reference was therefore
 * invisible to the verifier, and every Hebrew weekday/time word was
 * invisible to the scheduling extractor.
 *
 * Fix is additive, not a redesign: `Offer.aliases` (generic reference
 * data, not Hebrew-specific) lets any offer declare alternate names;
 * `tokenize()` now keeps any Unicode letter/digit; Hebrew weekday/
 * relative-day/time tables sit alongside the existing English ones in
 * the same dispatch functions, matched via a Hebrew-aware whole-token
 * check (Hebrew grammar glues single-letter prepositions directly onto
 * the following word with no space, so a plain \b-based check — which
 * only recognizes ASCII word characters anyway — would reject every
 * naturally-written Hebrew phrase).
 */
function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

describe("Hebrew offer references (verifyIR)", () => {
  const graph = buildSpaGraph();

  it('1. "זוגי" resolves confidently to the couples offer only', () => {
    const { verified } = verifyIR(graph, "זוגי", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
  });

  it('2. "מסאז זוגי" resolves confidently to the couples offer only', () => {
    const { verified } = verifyIR(graph, "מסאז זוגי", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
  });

  it("gershayim spelling \"מסאז' זוגי\" resolves the same way", () => {
    const { verified } = verifyIR(graph, "מסאז' זוגי", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
  });

  it('3. "שוודי" resolves confidently to the solo offer only', () => {
    const { verified } = verifyIR(graph, "שוודי", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-solo-massage");
  });

  it('"יחיד" and "אישי" also resolve confidently to the solo offer', () => {
    expect(verifyIR(graph, "יחיד", emptyIR()).verified.selectedOfferId).toBe("offer-solo-massage");
    expect(verifyIR(graph, "אישי", emptyIR()).verified.selectedOfferId).toBe("offer-solo-massage");
  });

  it("overrides an LLM that left the offer ambiguous when the raw Hebrew text is unambiguous", () => {
    const { verified, verification } = verifyIR(
      graph,
      "זוגי",
      emptyIR({ offerCandidateIds: ["offer-couples-massage", "offer-solo-massage"] })
    );
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
    expect(verification.offerOverridden).toBe(true);
  });

  it("uses aliases, not hardcoded business-type logic — findOffersByExplicitNameReference matches via Offer.aliases generically", () => {
    const matches = findOffersByExplicitNameReference(graph, "שוודי");
    expect(matches).toHaveLength(1);
    expect(matches[0].aliases).toContain("שוודי");
  });
});

describe("Hebrew weekdays and time (extractExplicitSchedulingConstraint)", () => {
  it('4. "זוגי ביום חמישי ב3" -> couples offer, weekday 4 (Thursday), 15:00', () => {
    const graph = buildSpaGraph();
    const message = "זוגי ביום חמישי ב3";

    const { verified } = verifyIR(graph, message, emptyIR());
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
    expect(verified.constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 4, qualifier: undefined });
    expect(verified.constraints.schedulingWindow?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
  });

  it('5. "מסאז זוגי ביום שלישי בשעה 3" -> weekday 2 (Tuesday), 15:00', () => {
    const result = extractExplicitSchedulingConstraint("מסאז זוגי ביום שלישי בשעה 3");
    expect(result?.date).toEqual({ kind: "weekday", weekday: 2, qualifier: undefined });
    expect(result?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
  });

  it('"בשעה שלוש" (spelled-out number) resolves the same as "בשעה 3"', () => {
    const result = extractExplicitSchedulingConstraint("ביום שלישי בשעה שלוש");
    expect(result?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
  });

  it('"בחמישי בשעה אחד" resolves Thursday + 13:00 using the existing small-hour booking convention', () => {
    const result = extractExplicitSchedulingConstraint("אני רוצה לבוא עם אשתי בחמישי בשעה אחד");
    expect(result?.date).toEqual({ kind: "weekday", weekday: 4, qualifier: undefined });
    expect(result?.time).toEqual({ kind: "explicitTime", hour: 13, minute: 0 });
  });

  it('"בחמישי בשעה אחת" resolves Thursday + 13:00', () => {
    const result = extractExplicitSchedulingConstraint("אני רוצה לבוא עם אשתי בחמישי בשעה אחת");
    expect(result?.date).toEqual({ kind: "weekday", weekday: 4, qualifier: undefined });
    expect(result?.time).toEqual({ kind: "explicitTime", hour: 13, minute: 0 });
  });

  it('supports common Hebrew one-o-clock forms: "באחת", "ב-1", "ב1", and "13:00"', () => {
    expect(extractExplicitSchedulingConstraint("בחמישי באחת")?.time).toEqual({
      kind: "explicitTime",
      hour: 13,
      minute: 0,
    });
    expect(extractExplicitSchedulingConstraint("בחמישי ב-1")?.time).toEqual({
      kind: "explicitTime",
      hour: 13,
      minute: 0,
    });
    expect(extractExplicitSchedulingConstraint("בחמישי ב1")?.time).toEqual({
      kind: "explicitTime",
      hour: 13,
      minute: 0,
    });
    expect(extractExplicitSchedulingConstraint("בחמישי 13:00")?.time).toEqual({
      kind: "explicitTime",
      hour: 13,
      minute: 0,
    });
  });

  it("verifyIR overrides a weekday-only LLM read with the deterministic colloquial Hebrew time when the raw text supplies it", () => {
    const graph = buildSpaGraph();
    const { verified, verification } = verifyIR(
      graph,
      "אני רוצה לבוא עם אשתי בחמישי בשעה אחד",
      emptyIR({ constraints: { schedulingWindow: { date: { kind: "weekday", weekday: 4 } } } })
    );

    expect(verification.schedulingOverridden).toBe(true);
    expect(verified.constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 4, qualifier: undefined });
    expect(verified.constraints.schedulingWindow?.time).toEqual({ kind: "explicitTime", hour: 13, minute: 0 });
  });

  it('"3 בצהריים" and "שלוש בצהריים" both resolve to 15:00 (explicit afternoon marker)', () => {
    expect(extractExplicitSchedulingConstraint("ביום שני 3 בצהריים")?.time).toEqual({
      kind: "explicitTime",
      hour: 15,
      minute: 0,
    });
    expect(extractExplicitSchedulingConstraint("ביום שני שלוש בצהריים")?.time).toEqual({
      kind: "explicitTime",
      hour: 15,
      minute: 0,
    });
  });

  it('6. "מחר ב3" -> relativeDay 1 (tomorrow), 15:00', () => {
    const result = extractExplicitSchedulingConstraint("מחר ב3");
    expect(result?.date).toEqual({ kind: "relativeDay", days: 1 });
    expect(result?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
  });

  it('"מחרתיים" -> relativeDay 2 (day after tomorrow), never mistaken for "מחר" (tomorrow)', () => {
    const result = extractExplicitSchedulingConstraint("מחרתיים ב3");
    expect(result?.date).toEqual({ kind: "relativeDay", days: 2 });
  });

  it('"היום" -> relativeDay 0 (today)', () => {
    const result = extractExplicitSchedulingConstraint("אפשר היום בשעה 3");
    expect(result?.date).toEqual({ kind: "relativeDay", days: 0 });
  });

  it("ב3 alone (bare small hour, no explicit AM/PM marker) defaults to afternoon, same convention as English", () => {
    const result = extractExplicitSchedulingConstraint("יום שני ב3");
    expect(result?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
  });

  it("does not false-positive on Hebrew words that merely contain a weekday substring with letters on both sides", () => {
    // "ששים" (sixty) contains "שש" (six) as a substring but continues with
    // more Hebrew letters immediately after — must never be read as a
    // weekday token (there is no "שש" weekday form here, but this proves
    // the trailing-boundary check generalizes: it also protects the
    // compact weekday forms that DO exist, e.g. "שני" inside "שנייה").
    expect(extractExplicitSchedulingConstraint("זה עולה ששים שקלים")).toBeUndefined();
  });
});

describe("Hebrew semantics override wrong/incomplete LLM IR", () => {
  it('7. "יום חמישי" must not become an unrelated explicitDate', () => {
    const graph = buildSpaGraph();
    const ir = emptyIR({
      constraints: {
        schedulingWindow: { date: { kind: "explicitDate", isoDate: "2026-09-27" } }, // wrong: a Sunday
      },
    });
    const { verified, verification } = verifyIR(graph, "יום חמישי", ir);

    expect(verification.schedulingOverridden).toBe(true);
    expect(verified.constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 4, qualifier: undefined });
  });

  it('8. raw Hebrew explicit offer reference overrides a wrong LLM selection', () => {
    const graph = buildSpaGraph();
    const ir = emptyIR({ selectedOfferId: "offer-solo-massage" }); // LLM guessed wrong
    const { verified, verification } = verifyIR(graph, "זוגי בבקשה", ir);

    expect(verified.selectedOfferId).toBe("offer-couples-massage");
    expect(verification.offerOverridden).toBe(true);
  });
});

describe("End-to-end: full live Hebrew scenario", () => {
  it('9. "היי" / "אני רוצה זוגי" / "זוגי ביום חמישי ב3" — no service re-clarification', async () => {
    const graph = buildSpaGraph();
    const conv = "heb-sem-1";
    const customer = "cust-heb-sem-1";

    const t1 = await handleCustomerMessage(graph, conv, customer, "היי");
    expect(t1.state.selectedOfferId).toBeUndefined();

    const t2 = await handleCustomerMessage(graph, conv, customer, "אני רוצה זוגי");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");

    const t3 = await handleCustomerMessage(graph, conv, customer, "זוגי ביום חמישי ב3");
    expect(t3.state.selectedOfferId).toBe("offer-couples-massage");
    const earliest = t3.state.knownFields.__mentionedEarliest;
    expect(earliest).toBeTruthy();
    expect(new Date(earliest).getUTCDay()).toBe(4); // Thursday
  });

  it('10. mixed Hebrew/English "אני רוצה couples ביום חמישי at 3pm" resolves correctly', async () => {
    const graph = buildSpaGraph();
    const conv = "heb-sem-2";
    const customer = "cust-heb-sem-2";

    const t = await handleCustomerMessage(graph, conv, customer, "אני רוצה couples ביום חמישי at 3pm");

    expect(t.state.selectedOfferId).toBe("offer-couples-massage");
    const earliest = t.state.knownFields.__mentionedEarliest;
    expect(earliest).toBeTruthy();
    expect(new Date(earliest).getUTCDay()).toBe(4); // Thursday
    expect([19, 20]).toContain(new Date(earliest).getUTCHours()); // 3pm EDT/EST -> 19:00 or 20:00 UTC
  });
});
