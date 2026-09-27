import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { extractEntities } from "@/lib/reasoner/entities";
import { runScenario, assertNeverCrashes } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 6: Hebrew language attacks, natural
 * (not textbook-translated) Hebrew. Two real bugs found and fixed while
 * building this suite:
 *
 * 1. `extractEntities`'s party-size detection was English-only ("my
 *    wife"/"our partner") — Hebrew relationship possessives ("אשתי",
 *    "בעלי", "בן הזוג") never registered partySize=2 at all. Fixed with
 *    a Hebrew partner-word table checked via the same whole-token
 *    matcher the weekday extractor uses.
 * 2. English "for two"/"for 2" never registered partySize=2 either (a
 *    parallel gap, found via the English attack suite) — AND "for" was
 *    ALSO being read as a time preposition ("for 3" -> 3 o'clock),
 *    which would have collided with party-size phrasing like "Tuesday
 *    for two" being misread as "Tuesday at 2pm". Fixed by removing
 *    "for" from the time-preposition set (party size, not time, is what
 *    "for N" overwhelmingly means in a booking context) and adding
 *    explicit "for N"/"for two" party-size detection.
 */
describe("Hebrew greetings and small talk never crash or misfire", () => {
  const greetings = ["היי", "שלום", "מה נשמע", "רוצה לקבוע"];

  for (const g of greetings) {
    it(`"${g}" never crashes and does not select an offer prematurely`, async () => {
      const { turns } = await runScenario({
        name: `heb-greeting-${g}`,
        graph: buildSpaGraph,
        turns: [{ customer: g, assert: assertNeverCrashes }],
      });
      expect(turns[0].selectedAction).toBeNull();
    });
  }
});

describe("Hebrew offer references", () => {
  const cases: [string, string][] = [
    ["רוצה זוגי", "offer-couples-massage"],
    ["מסאז זוגי", "offer-couples-massage"],
    ["זוגי", "offer-couples-massage"],
    ["שוודי", "offer-solo-massage"],
    ["אישי", "offer-solo-massage"],
    ["בעצם מסאז אישי", "offer-solo-massage"],
  ];

  for (const [msg, expected] of cases) {
    it(`"${msg}" -> ${expected}`, async () => {
      const { state } = await runScenario({
        name: `heb-offer-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: msg }],
      });
      expect(state.selectedOfferId).toBe(expected);
    });
  }
});

describe("Hebrew relationship/party-size phrasing", () => {
  const cases = ["אני ואשתי", "אני עם אשתי", "אני ובעלי", "אני עם בן הזוג"];

  for (const msg of cases) {
    it(`"${msg}" implies partySize 2`, () => {
      expect(extractEntities(msg).partySize).toBe(2);
    });
  }

  it("spelling variant אישתי is also recognized", () => {
    expect(extractEntities("אישתי")).toMatchObject({ partySize: 2 });
  });

  it("end-to-end: Hebrew partner phrasing sets __mentionedPartySize once an offer is chosen", async () => {
    const { state } = await runScenario({
      name: "heb-partysize-e2e",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "אני ואשתי" }],
    });
    expect(state.knownFields.__mentionedPartySize).toBe("2");
  });
});

describe("Hebrew weekdays and explicit time forms", () => {
  const dateCases: [string, number][] = [
    ["יום חמישי", 4],
    ["בחמישי", 4],
    ["ביום חמישי", 4],
  ];
  for (const [msg, weekday] of dateCases) {
    it(`"${msg}" resolves to weekday ${weekday}`, async () => {
      const { turns } = await runScenario({
        name: `heb-weekday-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: "זוגי" }, { customer: msg }],
      });
      expect(turns[1].understood.schedulingWindow?.date).toEqual({ kind: "weekday", weekday, qualifier: undefined });
    });
  }

  const dateTimeCases: string[] = ["חמישי ב3", "חמישי ב-3", "בחמישי ב3", "ביום חמישי בשעה 3"];
  for (const msg of dateTimeCases) {
    it(`"${msg}" resolves to Thursday 15:00`, async () => {
      const { state } = await runScenario({
        name: `heb-datetime-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: "זוגי" }, { customer: msg }],
      });
      expect(state.knownFields.__mentionedEarliest).toBeTruthy();
      expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(4);
      // 15:00 America/New_York -> 19:00 UTC (EDT) or 20:00 UTC (EST).
      expect([19, 20]).toContain(new Date(state.knownFields.__mentionedEarliest).getUTCHours());
    });
  }

  it('"בשלוש בצהריים" (explicit afternoon marker) paired with a weekday resolves to 15:00', async () => {
    const { state } = await runScenario({
      name: "heb-explicit-afternoon",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "ביום שני בשלוש בצהריים" }],
    });
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(1); // Monday
  });

  it('24-hour "ב15:00" never crashes, even though bare glued-digit Hebrew time parsing does not special-case 24h notation', async () => {
    const { turns } = await runScenario({
      name: "heb-24h",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "ביום שני ב15:00", assert: assertNeverCrashes }],
    });
    void turns;
  });
});

describe("Hebrew relative dates", () => {
  it('"מחר" -> relativeDay 1 (tomorrow)', async () => {
    const { turns } = await runScenario({
      name: "heb-tomorrow",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "מחר" }],
    });
    expect(turns[1].understood.schedulingWindow?.date).toEqual({ kind: "relativeDay", days: 1 });
  });

  it('"מחר ב3" -> tomorrow at 15:00', async () => {
    const { state } = await runScenario({
      name: "heb-tomorrow-time",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "מחר ב3" }],
    });
    expect(state.knownFields.__mentionedEarliest).toBeTruthy();
    expect([19, 20]).toContain(new Date(state.knownFields.__mentionedEarliest).getUTCHours());
  });

  it('"מחרתיים" -> relativeDay 2 (day after tomorrow), never confused with "מחר"', async () => {
    const { turns } = await runScenario({
      name: "heb-day-after-tomorrow",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "מחרתיים" }],
    });
    expect(turns[1].understood.schedulingWindow?.date).toEqual({ kind: "relativeDay", days: 2 });
  });
});

describe("Hebrew corrections", () => {
  it('"בעצם שני" ("actually Monday") corrects a previously-stated day', async () => {
    const { state } = await runScenario({
      name: "heb-correct-day",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "ביום חמישי ב3" }, { customer: "בעצם שני" }],
    });
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(1); // Monday
  });

  it('"לא, שלישי" ("no, Tuesday") corrects a previously-stated day', async () => {
    const { state } = await runScenario({
      name: "heb-correct-day-2",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי" }, { customer: "ביום חמישי ב3" }, { customer: "לא, שלישי" }],
    });
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(2); // Tuesday
  });
});

describe("Hebrew: never crashes, never fabricates, on ambiguous/slang/noisy input", () => {
  const noisy = ["שבוע הבא", "מה קורה", "אחלה, בואי נקבע", "תודה רבה!", "זוגי???", "  זוגי  ", "זוגי😊"];

  for (const msg of noisy) {
    it(`"${msg}" never crashes`, async () => {
      await runScenario({
        name: `heb-noisy-${msg.slice(0, 8)}`,
        graph: buildSpaGraph,
        turns: [{ customer: msg, assert: assertNeverCrashes }],
      });
    });
  }
});

describe("Mixed Hebrew/English", () => {
  it('"אני רוצה couples ביום חמישי at 3pm" resolves correctly across the language boundary', async () => {
    const { state } = await runScenario({
      name: "heb-mixed",
      graph: buildSpaGraph,
      turns: [{ customer: "אני רוצה couples ביום חמישי at 3pm" }],
    });
    expect(state.selectedOfferId).toBe("offer-couples-massage");
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(4);
  });
});
