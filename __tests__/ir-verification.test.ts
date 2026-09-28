import { describe, expect, it } from "vitest";
import { verifyIR } from "@/lib/reasoner/verify";
import { MockReasoner } from "@/lib/reasoner/mock-reasoner";
import { handleCustomerMessage } from "@/lib/runtime";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { createInitialConversationState } from "@/lib/state";

/**
 * MODEL-FIRST CONTRACT. Understanding is the model's job (MockReasoner is
 * its offline stand-in). verifyIR() GROUNDS the model's IR — it rejects
 * unknown ids, out-of-range values and claims without evidence — and it
 * NEVER replaces the model's semantic reading with a reading of its own.
 * The previous design let a regex layer overrule the model; that is what
 * turned "אני אקח את הראשונה" into name="אקח" in a live simulator run.
 */
function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

async function standIn(text: string) {
  const graph = buildSpaGraph();
  const state = createInitialConversationState(`irv-${Math.random()}`, graph.business.id, "c");
  return new MockReasoner().understand({ graph, state, customerMessage: text });
}

describe("Offline stand-in (MockReasoner) resolves explicit offer references", () => {
  it.each([
    ["Couples", "offer-couples-massage"],
    ["Couples Massage", "offer-couples-massage"],
    ["the couples one", "offer-couples-massage"],
    ["Solo", "offer-solo-massage"],
    ["Solo Swedish", "offer-solo-massage"],
    ["Swedish Massage", "offer-solo-massage"],
  ])('"%s" -> %s', async (text, offerId) => {
    const ir = await standIn(text);
    expect(ir.selectedOfferId).toBe(offerId);
  });

  it("a genuinely ambiguous phrase yields candidates, never a forced choice", async () => {
    const ir = await standIn("I want a massage");
    expect(ir.selectedOfferId).toBeUndefined();
    expect(ir.offerCandidateIds?.sort()).toEqual(["offer-couples-massage", "offer-solo-massage"]);
  });

});

describe("verifyIR: grounds the model's offer choice, never overrides it", () => {
  const graph = buildSpaGraph();

  it("keeps the model's valid selection even when the raw text names a different offer (the model owns semantics)", () => {
    const { verified, verification } = verifyIR(graph, "Solo please", emptyIR({ selectedOfferId: "offer-couples-massage" }));
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
    expect(verification.rejected).toEqual([]);
  });

  it("keeps model ambiguity as ambiguity — no raw-text tie-breaking", () => {
    const { verified } = verifyIR(graph, "Couples", emptyIR({ offerCandidateIds: ["offer-couples-massage", "offer-solo-massage"] }));
    expect(verified.selectedOfferId).toBeUndefined();
    expect(verified.offerCandidateIds).toEqual(["offer-couples-massage", "offer-solo-massage"]);
  });

  it("rejects an offer id that doesn't exist on this business", () => {
    const { verified, verification } = verifyIR(graph, "the deluxe", emptyIR({ selectedOfferId: "offer-invented" }));
    expect(verified.selectedOfferId).toBeUndefined();
    expect(verification.rejected.map((r) => r.claim)).toContain("selectedOfferId");
  });

  it("never adds an offer the model didn't propose", () => {
    const { verified } = verifyIR(graph, "Couples Massage", emptyIR());
    expect(verified.selectedOfferId).toBeUndefined();
  });
});

describe("verifyIR: scheduling is structurally validated, never re-read from text", () => {
  const graph = buildSpaGraph();

  it("keeps the model's scheduling reading as-is", () => {
    const ir = emptyIR({ constraints: { schedulingWindow: { date: { kind: "weekday", weekday: 2 }, time: { kind: "explicitTime", hour: 15, minute: 0 } } } });
    const { verified } = verifyIR(graph, "Thursday at 5", ir);
    expect(verified.constraints.schedulingWindow).toEqual(ir.constraints.schedulingWindow);
  });

  it("rejects out-of-range values instead of guessing", () => {
    const ir = emptyIR({ constraints: { schedulingWindow: { date: { kind: "weekday", weekday: 9 }, time: { kind: "explicitTime", hour: 26, minute: 0 } } } });
    const { verified, verification } = verifyIR(graph, "whenever", ir);
    expect(verified.constraints.schedulingWindow).toBeUndefined();
    expect(verification.rejected.map((r) => r.claim)).toEqual(["schedulingWindow.date", "schedulingWindow.time"]);
  });

  it("verified IR only ever carries SEMANTIC scheduling — never a resolved timestamp", () => {
    const ir = emptyIR({ constraints: { schedulingWindow: { date: { kind: "explicitDate", isoDate: "2026-09-27" } } } });
    const { verified } = verifyIR(graph, "Tuesday please", ir);
    expect(verified.constraints.schedulingWindow).not.toHaveProperty("earliest");
  });

  it("the stand-in model reads explicit weekday/qualifier/relative-day tokens", async () => {
    expect((await standIn("I wanna come with my wife on Tuesday at 3pm")).constraints.schedulingWindow).toEqual({
      date: { kind: "weekday", weekday: 2, qualifier: undefined },
      time: { kind: "explicitTime", hour: 15, minute: 0 },
    });
    expect((await standIn("let's do next Monday")).constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 1, qualifier: "next" });
    expect((await standIn("can I come tomorrow at 5")).constraints.schedulingWindow?.date).toEqual({ kind: "relativeDay", days: 1 });
  });
});

describe("End-to-end: offer continuity across the exact live scenario", () => {
  it("Hey / Couples / I wanna come with my wife Tuesday at 3pm — no re-clarification, correct weekday/partySize", async () => {
    const graph = buildSpaGraph();
    const conv = "ir-verify-e2e";
    const customer = "cust-ir-verify-e2e";

    const t1 = await handleCustomerMessage(graph, conv, customer, "Hey");
    expect(t1.state.selectedOfferId).toBeUndefined();

    const t2 = await handleCustomerMessage(graph, conv, customer, "Couples");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");

    const t3 = await handleCustomerMessage(graph, conv, customer, "I wanna come with my wife on Tuesday at 3pm");
    expect(t3.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t3.state.knownFields.__mentionedPartySize).toBe("2");
    const earliest = t3.state.knownFields.__mentionedEarliest;
    expect(earliest).toBeTruthy();
    expect(new Date(earliest).getUTCDay()).toBe(2); // Tuesday
    // Never re-asks which service — no clarify_offer / generic offer list.
    expect(t3.response.toLowerCase()).not.toMatch(/is that for .* or /);
  });

  it("previously selected offer survives later turns with no offer mention at all", async () => {
    const graph = buildSpaGraph();
    const conv = "ir-verify-continuity";
    const customer = "cust-ir-verify-continuity";

    await handleCustomerMessage(graph, conv, customer, "Couples");
    const t2 = await handleCustomerMessage(graph, conv, customer, "I wanna come Tuesday at 3pm");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");

    const t3 = await handleCustomerMessage(graph, conv, customer, "My name is Inon");
    expect(t3.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t3.state.knownFields.name).toBe("Inon");

    const t4 = await handleCustomerMessage(graph, conv, customer, "555-111-2222");
    expect(t4.state.selectedOfferId).toBe("offer-couples-massage");
  });
});
