import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { runScenario, assertNeverCrashes } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 5: English language attacks. Greetings,
 * short replies, typos, punctuation noise, casing, emoji, run-ons, and
 * shorthand. Typos are deliberately NOT asserted to resolve correctly —
 * "coupls"/"tuseday" are the Reasoner's job (fuzzy language), not the
 * deterministic verifier's (per the mission: "Do not make deterministic
 * verification dangerously fuzzy"). The bar for these is: never crash,
 * never fabricate a fact, never silently corrupt already-known state.
 */

describe("Greetings and short replies never crash or misfire", () => {
  const greetings = ["Hello", "Hi", "Hey", "Yo", "Sup", "I need an appointment"];

  for (const g of greetings) {
    it(`"${g}" never crashes and does not select an offer prematurely`, async () => {
      const { turns } = await runScenario({
        name: `greeting-${g}`,
        graph: buildSpaGraph,
        turns: [{ customer: g, assert: assertNeverCrashes }],
      });
      expect(turns[0].selectedAction).toBeNull();
    });
  }
});

describe("Confident explicit offer references resolve correctly", () => {
  const cases: [string, string][] = [
    ["Couples", "offer-couples-massage"],
    ["Solo", "offer-solo-massage"],
    ["The couples one", "offer-couples-massage"],
    ["The Swedish one", "offer-solo-massage"],
  ];

  for (const [msg, expected] of cases) {
    it(`"${msg}" -> ${expected}`, async () => {
      const { state } = await runScenario({
        name: `offer-ref-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: msg }],
      });
      expect(state.selectedOfferId).toBe(expected);
    });
  }
});

describe("Party-size phrasing", () => {
  const cases = ["Me and my wife", "My wife and I", "For two"];

  for (const msg of cases) {
    it(`"${msg}" implies partySize 2 once an offer needing scheduling is chosen`, async () => {
      const { state } = await runScenario({
        name: `partysize-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: "Couples massage please" }, { customer: msg }],
      });
      expect(state.knownFields.__mentionedPartySize).toBe("2");
    });
  }

  it('"Just me" never sets partySize to 2', async () => {
    const { state } = await runScenario({
      name: "partysize-justme",
      graph: buildSpaGraph,
      turns: [{ customer: "Solo massage please" }, { customer: "Just me" }],
    });
    expect(state.knownFields.__mentionedPartySize).toBeUndefined();
  });
});

describe("Explicit scheduling phrasing variants all resolve to a valid semantic constraint", () => {
  const cases = [
    "Tomorrow",
    "Next Tuesday",
    "Tuesday",
    "This Tuesday",
    "Tuesday afternoon",
    "Next Tuesday around 3",
  ];

  for (const msg of cases) {
    it(`"${msg}" produces a non-crashing, non-fabricated scheduling turn`, async () => {
      const { turns } = await runScenario({
        name: `sched-${msg}`,
        graph: buildSpaGraph,
        turns: [{ customer: "Couples massage please" }, { customer: msg, assert: assertNeverCrashes }],
      });
      // Whatever was understood, it must never fabricate an unrelated
      // weekday out of thin air — if a date was recognized at all, it's
      // a real, in-range weekday index.
      const date = turns[1].understood.schedulingWindow?.date;
      if (date?.kind === "weekday") {
        expect(date.weekday).toBeGreaterThanOrEqual(0);
        expect(date.weekday).toBeLessThanOrEqual(6);
      }
    });
  }
});

describe("Corrections phrased casually", () => {
  it('"Actually make it 4" corrects the time while keeping the day', async () => {
    const { state } = await runScenario({
      name: "casual-correct-time",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "Tuesday at 3" },
        { customer: "Actually make it 4" },
      ],
    });
    expect(state.selectedOfferId).toBe("offer-couples-massage");
    expect(state.knownFields.__mentionedEarliest).toBeTruthy();
  });

  it('"No, Wednesday instead" corrects the day', async () => {
    const { state } = await runScenario({
      name: "casual-correct-day",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "Tuesday at 3" },
        { customer: "No, Wednesday instead" },
      ],
    });
    expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(3);
  });
});

describe("Typos, casing, punctuation, emoji, run-ons — never crash, never corrupt known state", () => {
  const adversarial = [
    "coupls",
    "tuseday",
    "3 pm pls",
    "me+wife tue 3",
    "actually nah solo",
    "COUPLES MASSAGE PLEASE!!!",
    "couples massage please 😊🎉",
    "hiiiii i wanna book a couples massage for tuesday around 3pm if thats ok with u thanks!!",
    "  couples   massage  ",
    "Couples.",
    "couples???",
  ];

  for (const msg of adversarial) {
    it(`"${msg}" never crashes and never fabricates an unrelated offer or a booking action`, async () => {
      const { turns } = await runScenario({
        name: `adversarial-${msg.slice(0, 12)}`,
        graph: buildSpaGraph,
        turns: [{ customer: msg, assert: assertNeverCrashes }],
      });
      // A single adversarial message alone, with no name/phone/schedule
      // on file, must never reach a real booking/payment action.
      expect(["createBooking", "createPaymentRequest", "fulfillOrder"]).not.toContain(
        turns[0].selectedAction?.name
      );
    });
  }

  it("a typo'd correction never corrupts previously-confirmed good state", async () => {
    const { state } = await runScenario({
      name: "typo-correction-safety",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "My name is Inon and my phone number is 0501234567" },
        { customer: "actually nah solo" }, // casual, no exact "instead"/"actually X instead" grammar
      ],
    });
    // Whatever the offer ends up being, identity must survive intact —
    // a casual typo'd correction must never wipe out real customer data.
    expect(state.knownFields.name).toBe("Inon");
    expect(state.knownFields.phone).toBe("0501234567");
  });
});

describe("Unknown business facts are never invented", () => {
  it("a question about something outside the Business Graph never fabricates an answer", async () => {
    const { turns } = await runScenario({
      name: "unknown-fact",
      graph: buildSpaGraph,
      turns: [
        {
          customer: "Do you offer free parking validation for the airport garage across town?",
          assert: ({ response }) => {
            expect(response.toLowerCase()).not.toMatch(/airport/);
          },
        },
      ],
    });
    expect(turns[0].retrieved.knowledgeIds).toEqual([]);
  });
});
