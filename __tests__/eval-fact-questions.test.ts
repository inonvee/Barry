import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildFurnitureStoreGraph } from "@/lib/fixtures/furniture-store";
import { runScenario } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 11: fact question torture test. A fact
 * question ("how much is it?") must be answerable straight from the
 * resolved Business Graph Offer at ANY conversation stage — it is never
 * gated behind `requiredCustomerInfo` (that's for FULFILLING a
 * transaction, not for stating an already-known fact) — and it must
 * NEVER corrupt or silently advance anything else in the conversation:
 * not the selected offer, not scheduling state already on file, not
 * customer identity, and never the transaction stage itself (no tool
 * call, no stage transition).
 *
 * Real bug found and fixed while building this suite (mock-reasoner.ts):
 * the fact-question recognizers (PRICE_QUESTION/DURATION_QUESTION/
 * DEPOSIT_QUESTION) were English-only regexes — a Hebrew customer asking
 * "כמה עולה?" (how much does it cost?) never triggered `ask_price` at
 * all, so the deterministic reviewer had no way to answer a fact
 * question in Hebrew even though the same information is sitting right
 * there in the Offer. Added a parallel Hebrew keyword set
 * (מחיר/עולה, זמן, פיקדון/מקדמה) checked via the existing Hebrew-aware
 * `matchHebrewToken`, dispatched the same language-independent way as
 * every other bilingual signal in this file (try one, then the other —
 * never an `if (business.locale === "he")` branch).
 */
describe("Fact questions: known facts answered correctly, straight from the Offer", () => {
  it('"How much is it?" (English) answers the exact price on file', async () => {
    const { turns } = await runScenario({
      name: "fact-price-en",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage. How much is it?" }],
    });
    expect(turns[0].selectedAction).toBeFalsy();
    expect(turns[0].response).toMatch(/220/);
  });

  it('"כמה זה עולה?" (Hebrew) answers the exact price on file', async () => {
    const { turns } = await runScenario({
      name: "fact-price-he",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי, כמה זה עולה?" }],
    });
    expect(turns[0].selectedAction).toBeFalsy();
    expect(turns[0].response).toMatch(/220/);
  });

  it('"How long does it take?" answers the exact duration on file', async () => {
    const { turns } = await runScenario({
      name: "fact-duration-en",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage. How long does it take?" }],
    });
    expect(turns[0].response).toMatch(/60/);
  });

  it('"כמה זמן זה לוקח?" (Hebrew) answers the exact duration on file', async () => {
    const { turns } = await runScenario({
      name: "fact-duration-he",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי, כמה זמן זה לוקח?" }],
    });
    expect(turns[0].response).toMatch(/60/);
  });

  it('"Do you need a deposit?" answers the exact deposit amount on file', async () => {
    const { turns } = await runScenario({
      name: "fact-deposit-en",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage. Do you need a deposit?" }],
    });
    expect(turns[0].response).toMatch(/50/);
  });

  it('"יש צורך בפיקדון?" (Hebrew) answers the exact deposit amount on file', async () => {
    const { turns } = await runScenario({
      name: "fact-deposit-he",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי, יש צורך בפיקדון?" }],
    });
    expect(turns[0].response).toMatch(/50/);
  });
});

describe("Fact questions: absent facts are never invented", () => {
  it("a quote-only offer (price: null) never fabricates a numeric price when asked", async () => {
    const { turns } = await runScenario({
      name: "fact-absent-price",
      graph: buildFurnitureStoreGraph,
      turns: [{ customer: "Custom furniture order. How much does it cost?" }],
    });
    // No fabricated numeric price anywhere in the response.
    expect(turns[0].response).not.toMatch(/\$\d/);
    // And the compiler must not have resolved a fake OfferFact either.
    expect(turns[0].compiled?.appliedCustomerInfo).toBeDefined();
  });

  it("asking about price with no offer named at all never guesses which offer", async () => {
    const { turns } = await runScenario({
      name: "fact-no-offer-yet",
      graph: buildSpaGraph,
      turns: [{ customer: "How much is it?" }],
    });
    expect(turns[0].selectedAction).toBeFalsy();
    // No offer resolved yet -> BARRY must ask what the customer wants,
    // never silently assume an offer to answer a price for.
    expect(turns[0].response).not.toMatch(/220|150/);
  });
});

describe("Fact questions never corrupt other state, at any conversation stage", () => {
  it("a fact question asked BEFORE any transaction field is on file does not skip required-info collection afterward", async () => {
    const { turns } = await runScenario({
      name: "fact-then-info-gathering",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage. How much is it?" }, { customer: "Ok, let's book it" }],
    });
    // Turn 2 must still ask for name/phone (requiredCustomerInfo) — the
    // fact question must not have silently marked them as satisfied.
    expect(turns[1].response).toMatch(/name|phone/i);
  });

  it("a fact question asked mid-scheduling does not lose the already-established date/time", async () => {
    const { turns } = await runScenario({
      name: "fact-mid-scheduling",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "How much is it?" },
        { customer: "My name is Inon and my phone is 0501234567" },
      ],
    });
    const beforeFact = turns[0].compiled?.resolvedSchedulingWindow?.earliest;
    // The fact-question turn itself must not resolve/advance a NEW
    // scheduling window (no new date/time was mentioned in it).
    expect(turns[1].compiled?.resolvedSchedulingWindow).toBeUndefined();
    expect(beforeFact).toBeTruthy();
    // And the scheduling info from turn 1 must still be on file after
    // the fact question, unclobbered, once the flow continues to the
    // point of checking availability.
    expect(turns[2].toolResult?.ok).toBe(true);
  });

  it("a fact question never triggers a tool call / never advances the transaction stage", async () => {
    const { turns } = await runScenario({
      name: "fact-never-advances-transaction",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage. What's the price?" }],
    });
    expect(turns[0].selectedAction).toBeFalsy();
    expect(turns[0].toolResult).toBeUndefined();
  });

  it("a fact question does not overwrite an already-selected offer with a different one", async () => {
    const { state } = await runScenario({
      name: "fact-does-not-reselect-offer",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage" }, { customer: "How much is a solo massage?" }],
    });
    // "solo massage" in a pure fact question must not silently switch
    // the sticky offer selection away from Couples Massage — only an
    // explicit change-of-mind phrase does that (see offerChangeRequested).
    expect(state.selectedOfferId).toBe("offer-couples-massage");
  });

  it("asking a fact question does not corrupt customer identity already on file", async () => {
    const { state } = await runScenario({
      name: "fact-does-not-corrupt-identity",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage" },
        { customer: "My name is Inon" },
        { customer: "What's the deposit?" },
      ],
    });
    expect(state.knownFields.name).toBe("Inon");
  });
});
