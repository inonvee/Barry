import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { extractAnnouncedName } from "@/lib/reasoner/entities";
import { runScenario, assertNeverCrashes } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 8: customer identity torture test.
 * HIGH PRIORITY: we already had a live bug where "אישתי" ("my wife") was
 * persisted as the customer's NAME. This suite exists specifically to
 * prevent that class of bug from ever recurring, in either language.
 *
 * Structural invariant: a relationship/role word may never become a
 * customer name without explicit self-identification evidence (an
 * unambiguous marker — "my name is", "call me", "I'm", "קוראים לי",
 * "השם שלי" — or, for the bare Hebrew "אני X" form, passing an explicit
 * blocklist of common non-name words/relationship terms).
 *
 * Two real bugs found and fixed while building this suite (both in
 * entities.ts):
 * 1. "I'm Inon" never matched at all — no "I'm"/"I am" marker existed.
 *    Added, protected the same way "call me" is (captured word must
 *    start with a capital letter).
 * 2. Hebrew had NO deterministic name extraction whatsoever —
 *    "קוראים לי ינון"/"השם שלי ינון"/"אני ינון" all fell through to
 *    undefined. Added Hebrew markers, with the bare "אני X" form
 *    guarded by an explicit blocklist (this is the exact mechanism that
 *    keeps "אני עם אשתי" from ever producing a name).
 * 3. "Sorry, call me Jordan instead" captured "Jordan instead" as the
 *    name — "instead" wasn't in the stop-word list. Fixed.
 */
describe("Identity: positive explicit self-identification (English)", () => {
  const cases = ["My name is Inon", "I'm Inon", "Call me Inon"];
  for (const msg of cases) {
    it(`"${msg}" -> customerInfo.name = Inon`, async () => {
      const { turns } = await runScenario({
        name: `id-en-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: "Couples massage please" }, { customer: msg }],
      });
      expect(turns[1].compiled?.appliedCustomerInfo.name).toBe("Inon");
    });
  }
});

describe("Identity: positive explicit self-identification (Hebrew)", () => {
  const cases: [string, string][] = [
    ["קוראים לי ינון", "ינון"],
    ["השם שלי ינון", "ינון"],
    ["השם שלי זה ינון", "ינון"],
    ["השם שלי הוא ינון", "ינון"],
    ["השם שלי היא דנה", "דנה"],
    ["השם שלי זה Inon", "Inon"],
    ["קוראים לי Inon", "Inon"],
    ["אני ינון", "ינון"],
  ];
  for (const [msg, expected] of cases) {
    it(`"${msg}" -> customerInfo.name = ${expected}`, async () => {
      const { turns } = await runScenario({
        name: `id-he-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: "זוגי" }, { customer: msg }],
      });
      expect(turns[1].compiled?.appliedCustomerInfo.name).toBe(expected);
    });
  }
});

describe("Identity: contact info", () => {
  it('"My phone is 0501234567" -> customerInfo.phone', async () => {
    const { turns } = await runScenario({
      name: "id-phone-en",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage please" }, { customer: "My phone is 0501234567" }],
    });
    expect(turns[1].compiled?.appliedCustomerInfo.phone).toBe("0501234567");
  });

  it('"הטלפון שלי 0501234567" -> customerInfo.phone', async () => {
    const { turns } = await runScenario({
      name: "id-phone-he",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "הטלפון שלי 0501234567" }],
    });
    expect(turns[1].compiled?.appliedCustomerInfo.phone).toBe("0501234567");
  });

  it('"My email is x@y.com" -> customerInfo.email', async () => {
    const { turns } = await runScenario({
      name: "id-email",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage please" }, { customer: "My email is x@y.com" }],
    });
    expect(turns[1].compiled?.appliedCustomerInfo.email).toBe("x@y.com");
  });
});

describe("Identity: corrections", () => {
  it('"Actually my number is..." replaces the previous phone', async () => {
    const { state } = await runScenario({
      name: "id-correct-phone-en",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "My name is Inon and my phone number is 0501111111" },
        { customer: "Actually my number is 0502222222" },
      ],
    });
    expect(state.knownFields.phone).toBe("0502222222");
    expect(state.knownFields.name).toBe("Inon");
  });

  it('"Sorry, call me Jordan instead" replaces the previous name without trailing garbage', async () => {
    const { state } = await runScenario({
      name: "id-correct-name-en",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "My name is Inon and my phone number is 0501234567" },
        { customer: "Sorry, call me Jordan instead" },
      ],
    });
    expect(state.knownFields.name).toBe("Jordan");
    expect(state.knownFields.phone).toBe("0501234567");
  });

  it('"בעצם המספר שלי..." replaces the previous phone', async () => {
    const { state } = await runScenario({
      name: "id-correct-phone-he",
      graph: buildSpaGraph,
      turns: [
        { customer: "זוגי" },
        { customer: "קוראים לי ינון, הטלפון שלי 0501111111" },
        { customer: "בעצם המספר שלי 0502222222" },
      ],
    });
    expect(state.knownFields.phone).toBe("0502222222");
    expect(state.knownFields.name).toBe("ינון");
  });

  it('"טעיתי, קוראים לי..." replaces the previous name', async () => {
    const { state } = await runScenario({
      name: "id-correct-name-he",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "קוראים לי דני" }, { customer: "טעיתי, קוראים לי יוסי" }],
    });
    expect(state.knownFields.name).toBe("יוסי");
  });
});

describe("Identity: NEGATIVE cases — a relationship/role word must never become the customer name", () => {
  const englishNegatives = [
    "My wife's name is Sarah",
    "I am coming with my wife",
    "Call me tomorrow",
    "Call me at 5",
    "This is about my booking",
    "How much is it?",
    "null",
    "N/A",
    "undefined",
  ];

  for (const msg of englishNegatives) {
    it(`"${msg}" never sets a customer name`, () => {
      expect(extractAnnouncedName(msg)).toBeUndefined();
    });
  }

  const hebrewNegatives = [
    "אני בא עם אשתי",
    "אני עם אישתי",
    "אני עם בעלי",
    "אני עם בן הזוג",
    "אני עם בת הזוג",
    "אני עם חברה שלי",
    "אני רוצה זוגי",
  ];

  for (const msg of hebrewNegatives) {
    it(`"${msg}" never sets a customer name (relationship word, not self-identification)`, () => {
      expect(extractAnnouncedName(msg)).toBeUndefined();
    });
  }

  it('"My wife\'s name is Sarah" never persists "Sarah" as the CUSTOMER\'s name, end-to-end', async () => {
    const { state } = await runScenario({
      name: "id-negative-wife-name-e2e",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "My wife's name is Sarah", assert: assertNeverCrashes },
      ],
    });
    expect(state.knownFields.name).not.toBe("Sarah");
  });

  it('"אני בא עם אשתי" never persists a relationship word as the customer name, end-to-end', async () => {
    const { state } = await runScenario({
      name: "id-negative-hebrew-wife-e2e",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "אני בא עם אשתי", assert: assertNeverCrashes }],
    });
    expect(state.knownFields.name).not.toMatch(/^(אשתי|אישתי|בעלי)$/);
    // This message DOES legitimately imply partySize 2 — that's a
    // separate, correct signal from the (absent) name.
    expect(state.knownFields.__mentionedPartySize).toBe("2");
  });

  it("sentinel strings can never become a customer name even via the compiler's own normalization boundary", async () => {
    const { state } = await runScenario({
      name: "id-negative-sentinels",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "null", assert: assertNeverCrashes },
        { customer: "N/A", assert: assertNeverCrashes },
        { customer: "undefined", assert: assertNeverCrashes },
      ],
    });
    expect(state.knownFields.name).not.toBe("null");
    expect(state.knownFields.name).not.toBe("N/A");
    expect(state.knownFields.name).not.toBe("undefined");
  });
});
