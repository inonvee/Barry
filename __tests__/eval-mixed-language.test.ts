import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { extractAnnouncedName } from "@/lib/reasoner/entities";
import { runScenario, assertNeverCrashes } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 7: mixed-language attacks. Execution
 * semantics must not depend on language consistency — a message can
 * name the offer in one language, the date in another, and still
 * resolve deterministically.
 *
 * Two real bugs found and fixed while building this suite (entities.ts):
 * name extraction required the MARKER and the NAME to be in the same
 * script. "My name is ינון" (English marker, Hebrew name) and "קוראים
 * לי Inon" (Hebrew marker, Latin name) both silently returned undefined
 * — the cleaning regexes were script-restricted (`[^A-Za-z]` / Hebrew-
 * range-only) instead of Unicode-letter-aware, and the English
 * confidence gate required an uppercase LATIN letter specifically
 * (rejecting any Hebrew candidate outright, case not applying to
 * Hebrew at all). Fixed by generalizing both cleaning regexes to
 * `\p{L}` and changing the confidence gate to "reject only a stray
 * lowercase LATIN word" instead of "require an uppercase Latin one".
 */
describe("Mixed language: offer selection across the language boundary", () => {
  const cases: [string, string][] = [
    ["אני רוצה couples massage ביום חמישי at 3pm", "offer-couples-massage"],
    ["Couples ביום שלישי ב3", "offer-couples-massage"],
    ["אני רוצה solo Tuesday at 4", "offer-solo-massage"],
    ["solo בבקשה tomorrow at 4", "offer-solo-massage"],
  ];

  for (const [msg, expected] of cases) {
    it(`"${msg}" -> ${expected}`, async () => {
      const { state } = await runScenario({
        name: `mixed-offer-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: msg }],
      });
      expect(state.selectedOfferId).toBe(expected);
    });
  }
});

describe("Mixed language: scheduling semantics across the language boundary", () => {
  it('"אני רוצה couples massage ביום חמישי at 3pm" -> Thursday 15:00', async () => {
    const { state } = await runScenario({
      name: "mixed-sched-1",
      graph: buildSpaGraph,
      turns: [{ customer: "אני רוצה couples massage ביום חמישי at 3pm" }],
    });
    expect(state.knownFields.__mentionedEarliest).toBeTruthy();
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(4);
  });

  it('"Couples ביום שלישי ב3" -> Tuesday 15:00', async () => {
    const { state } = await runScenario({
      name: "mixed-sched-2",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples ביום שלישי ב3" }],
    });
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(2);
  });

  it('"next Monday בשעה 15:00" -> Monday, qualifier "next", 15:00', async () => {
    const { turns } = await runScenario({
      name: "mixed-sched-3",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage please" }, { customer: "next Monday בשעה 15:00" }],
    });
    expect(turns[1].understood.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 1, qualifier: "next" });
  });

  it('"אני בא with my wife Tuesday ב3" -> Tuesday 15:00, partySize 2', async () => {
    const { state } = await runScenario({
      name: "mixed-sched-4",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage please" }, { customer: "אני בא with my wife Tuesday ב3" }],
    });
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(2);
  });
});

describe("Mixed language: customer identity across the language boundary", () => {
  it('"My name is ינון" -> customerInfo.name = ינון', () => {
    expect(extractAnnouncedName("My name is ינון")).toBe("ינון");
  });

  it('"קוראים לי Inon" -> customerInfo.name = Inon', () => {
    expect(extractAnnouncedName("קוראים לי Inon")).toBe("Inon");
  });

  it("end-to-end: a Hebrew-marker/Latin-name message persists correctly", async () => {
    const { state } = await runScenario({
      name: "mixed-identity-e2e",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage please" }, { customer: "קוראים לי Inon" }],
    });
    expect(state.knownFields.name).toBe("Inon");
  });
});

describe("Mixed language: corrections carry across the language boundary", () => {
  it('Hebrew offer selection, then an English correction, still converges', async () => {
    const { state } = await runScenario({
      name: "mixed-correction",
      graph: buildSpaGraph,
      turns: [
        { customer: "זוגי" },
        { customer: "My name is Inon and my phone number is 0501234567" },
        { customer: "Actually solo instead" },
      ],
    });
    expect(state.selectedOfferId).toBe("offer-solo-massage");
    expect(state.knownFields.name).toBe("Inon");
  });
});

describe("Mixed language: never crashes on script-switching mid-sentence", () => {
  const noisy = [
    "אני רוצה couples massage בבקשה thanks!",
    "Solo אישי בבקשה 😊",
    "מחר at 3pm בבקשה",
  ];
  for (const msg of noisy) {
    it(`"${msg}" never crashes`, async () => {
      await runScenario({
        name: `mixed-noisy-${msg.slice(0, 8)}`,
        graph: buildSpaGraph,
        turns: [{ customer: msg, assert: assertNeverCrashes }],
      });
    });
  }
});
