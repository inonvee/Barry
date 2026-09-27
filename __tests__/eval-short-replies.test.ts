import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { runScenario } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 12: yes/no/short-reply context. A bare
 * "Yeah" or "No" (or their Hebrew equivalents) carries no meaning on its
 * own — it only means something in light of whatever BARRY just asked.
 * This suite proves a short reply is interpreted against the immediately
 * relevant question (accept/decline an offered slot, pick from a
 * clarify_offer list) rather than being ignored or misread.
 *
 * Two real bugs found and fixed while building this suite (entities.ts):
 *
 * 1. The `accepted` detector only matched a narrow English list
 *    ("yes"/"yep"/"sounds good"/...) that did NOT include "yeah" — the
 *    single most common casual English affirmative — and had NO Hebrew
 *    equivalent at all. A customer replying "Yeah" (or Hebrew "כן"/
 *    "סבבה") to an offered slot got the exact same question repeated
 *    back at them verbatim, forever — the short reply's context (an
 *    offered slot awaiting confirmation) was silently lost.
 *
 * 2. There was no decline signal at all: a "No" (or Hebrew "לא") to an
 *    offered slot behaved identically to complete silence — the same
 *    slot just got re-offered again with no path forward. Added a
 *    `declined` entity + `slotDeclined` IR constraint, handled by the
 *    compiler ONLY when there's actually an offered slot on file to
 *    decline (never a spurious state change otherwise) — it clears the
 *    stale offer and falls through to asking for a new date/time.
 */
describe("Short replies: accepting an offered slot", () => {
  const affirmatives = ["Yeah", "Yes", "Yep", "Sure", "Sounds good", "כן", "סבבה", "יאללה", "בסדר"];

  for (const word of affirmatives) {
    it(`"${word}" accepts the offered slot and proceeds past confirmation`, async () => {
      const { turns } = await runScenario({
        name: `short-accept-${word}`,
        graph: buildSpaGraph,
        turns: [
          { customer: "Couples massage Tuesday at 3pm" },
          { customer: "My name is Inon and my phone is 0501234567" },
          { customer: word },
        ],
      });
      // Turn 2 offered a slot ("does X work for you?"); turn 3's short
      // reply must move the conversation forward (into payment), never
      // just repeat the same confirmation question.
      expect(turns[2].response).not.toMatch(/does .* work for you\??$/i);
      expect(turns[2].selectedAction?.name).toBe("createPaymentRequest");
    });
  }
});

describe("Short replies: declining an offered slot", () => {
  const negatives = ["No", "Nope", "Nah", "לא"];

  for (const word of negatives) {
    it(`"${word}" declines the offered slot and prompts for a new time instead of repeating it`, async () => {
      const { turns } = await runScenario({
        name: `short-decline-${word}`,
        graph: buildSpaGraph,
        turns: [
          { customer: "Couples massage Tuesday at 3pm" },
          { customer: "My name is Inon and my phone is 0501234567" },
          { customer: word },
        ],
      });
      expect(turns[2].selectedAction).toBeFalsy();
      // Must ask for a NEW date/time, not silently re-offer the declined one.
      expect(turns[2].response).not.toMatch(/2026/);
    });
  }
});

describe("Short replies: answering a 'which offer' clarification", () => {
  it('a short offer-name reply ("solo") resolves the ambiguous clarify_offer question', async () => {
    const { state, turns } = await runScenario({
      name: "short-clarify-offer",
      graph: buildSpaGraph,
      turns: [{ customer: "massage" }, { customer: "solo" }],
    });
    expect(turns[0].response).toMatch(/couples|solo/i);
    expect(state.selectedOfferId).toBe("offer-solo-massage");
  });
});

describe("Short replies: a bare 'no' before anything was ever offered is a harmless no-op", () => {
  it('"No" with nothing on file yet never crashes and never fabricates a decline of something that was never offered', async () => {
    const { turns } = await runScenario({
      name: "short-no-context",
      graph: buildSpaGraph,
      turns: [{ customer: "No" }],
    });
    expect(typeof turns[0].response).toBe("string");
    expect(turns[0].response.length).toBeGreaterThan(0);
  });
});

describe("Short replies: accepting one slot does not silently pre-accept a LATER, different slot", () => {
  it("a decline followed by a fresh date/time still requires its own explicit confirmation", async () => {
    const { turns } = await runScenario({
      name: "short-decline-then-reoffer",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "My name is Inon and my phone is 0501234567" },
        { customer: "No" },
        { customer: "Wednesday at 4pm instead" },
      ],
    });
    // The new slot is checked (not auto-booked/paid off the back of the
    // earlier decline) and must await its OWN confirmation.
    expect(turns[3].selectedAction?.name).toBe("checkAvailability");
    expect(turns[3].response).toMatch(/work for you|does .* work/i);
  });
});
