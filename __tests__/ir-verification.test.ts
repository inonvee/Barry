import { describe, expect, it } from "vitest";
import { verifyIR } from "@/lib/reasoner/verify";
import { handleCustomerMessage } from "@/lib/runtime";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * SEMANTIC IR VERIFICATION MISSION: two new live bugs, both upstream of
 * the compiler/resolver — the LLM produced semantically incorrect BARRY
 * IR. verifyIR() is the deterministic layer between ANY Reasoner's IR
 * and the compiler that cross-checks high-confidence, directly-
 * verifiable business semantics (offer references, explicit
 * weekday/relative-day tokens) against the raw customer text, and
 * overrides the Reasoner when its IR contradicts something the customer
 * plainly said. It never computes a final UTC instant — that stays
 * resolveSchedulingWindow()'s job.
 */
function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

describe("verifyIR: offer reference verification", () => {
  const graph = buildSpaGraph();

  it('"Couples" resolves confidently to the couples offer, even if the LLM was ambiguous', () => {
    const { verified, verification } = verifyIR(
      graph,
      "Couples",
      emptyIR({ offerCandidateIds: ["offer-couples-massage", "offer-solo-massage"] })
    );
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
    expect(verified.offerCandidateIds).toBeUndefined();
    expect(verification.offerOverridden).toBe(true);
  });

  it('"Couples Massage" resolves confidently to the couples offer only', () => {
    const { verified } = verifyIR(graph, "Couples Massage", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
  });

  it('"the couples one" resolves confidently to the couples offer only', () => {
    const { verified } = verifyIR(graph, "the couples one", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
  });

  it('"Solo" resolves confidently to the solo offer only', () => {
    const { verified } = verifyIR(graph, "Solo", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-solo-massage");
  });

  it('"Solo Swedish" resolves confidently to the solo offer', () => {
    const { verified } = verifyIR(graph, "Solo Swedish", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-solo-massage");
  });

  it('"Swedish Massage" resolves confidently to the solo offer (not couples, despite "massage" overlap)', () => {
    const { verified } = verifyIR(graph, "Swedish Massage", emptyIR());
    expect(verified.selectedOfferId).toBe("offer-solo-massage");
  });

  it("a genuinely ambiguous phrase (matches both offer names equally) keeps clarification behavior untouched", () => {
    // Neither offer NAME is confidently singled out by "massage" alone —
    // both names contain it — so the deterministic verifier must not
    // force a choice; the Reasoner's own ambiguity handling stands.
    const { verified, verification } = verifyIR(
      graph,
      "I want a massage",
      emptyIR({ offerCandidateIds: ["offer-couples-massage", "offer-solo-massage"] })
    );
    expect(verified.selectedOfferId).toBeUndefined();
    expect(verified.offerCandidateIds).toEqual(["offer-couples-massage", "offer-solo-massage"]);
    expect(verification.offerOverridden).toBe(false);
  });

  it("overrides even a confidently-wrong LLM selection when the raw text unambiguously names a different offer", () => {
    const { verified, verification } = verifyIR(graph, "Solo please", emptyIR({ selectedOfferId: "offer-couples-massage" }));
    expect(verified.selectedOfferId).toBe("offer-solo-massage");
    expect(verification.offerOverridden).toBe(true);
  });

  it("never overrides when the raw text names no offer at all (trusts the Reasoner's own contextual judgment)", () => {
    const { verified, verification } = verifyIR(graph, "Yes that works", emptyIR({ selectedOfferId: "offer-couples-massage" }));
    expect(verified.selectedOfferId).toBe("offer-couples-massage");
    expect(verification.offerOverridden).toBe(false);
  });

  it("does not false-positive on an incidental description-word match (a real bug class this design avoids)", () => {
    // Couples Massage's DESCRIPTION says "for two" — "two" must never, by
    // itself, make an unrelated sentence resolve to that offer. Only
    // name-token matches drive this verifier.
    const { verified, verification } = verifyIR(graph, "I'll bring two friends along", emptyIR());
    expect(verified.selectedOfferId).toBeUndefined();
    expect(verification.offerOverridden).toBe(false);
  });
});

describe("verifyIR: scheduling semantic verification", () => {
  const graph = buildSpaGraph();

  it('"Tuesday at 3pm" corrects an LLM explicitDate that names the wrong weekday', () => {
    const ir = emptyIR({
      constraints: {
        schedulingWindow: { date: { kind: "explicitDate", isoDate: "2026-09-27" }, time: { kind: "explicitTime", hour: 15, minute: 0 } },
      },
    });
    const { verified, verification } = verifyIR(graph, "I wanna come with my wife on Tuesday at 3pm", ir);

    expect(verification.schedulingOverridden).toBe(true);
    expect(verified.constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 2, qualifier: undefined });
    // Time the LLM already got right must survive the override.
    expect(verified.constraints.schedulingWindow?.time).toEqual({ kind: "explicitTime", hour: 15, minute: 0 });
  });

  it('"next Monday" preserves the "next" qualifier when verifying against an LLM that got it right', () => {
    const ir = emptyIR({
      constraints: { schedulingWindow: { date: { kind: "weekday", weekday: 1, qualifier: "next" } } },
    });
    const { verified, verification } = verifyIR(graph, "let's do next Monday", ir);

    expect(verification.schedulingOverridden).toBe(false);
    expect(verified.constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 1, qualifier: "next" });
  });

  it('"next Monday" corrects an LLM that dropped the "next" qualifier', () => {
    const ir = emptyIR({
      constraints: { schedulingWindow: { date: { kind: "weekday", weekday: 1 } } }, // missing qualifier: "next"
    });
    const { verified, verification } = verifyIR(graph, "let's do next Monday", ir);

    expect(verification.schedulingOverridden).toBe(true);
    expect(verified.constraints.schedulingWindow?.date).toEqual({ kind: "weekday", weekday: 1, qualifier: "next" });
  });

  it('"tomorrow" corrects an LLM explicitDate mismatch to relativeDay', () => {
    const ir = emptyIR({
      constraints: { schedulingWindow: { date: { kind: "explicitDate", isoDate: "2099-01-01" } } },
    });
    const { verified, verification } = verifyIR(graph, "can I come tomorrow at 5", ir);

    expect(verification.schedulingOverridden).toBe(true);
    expect(verified.constraints.schedulingWindow?.date).toEqual({ kind: "relativeDay", days: 1 });
  });

  it("does not touch scheduling when the LLM already agrees with the explicit raw-text token", () => {
    const ir = emptyIR({
      constraints: { schedulingWindow: { date: { kind: "weekday", weekday: 2 }, time: { kind: "explicitTime", hour: 15, minute: 0 } } },
    });
    const { verified, verification } = verifyIR(graph, "Tuesday at 3pm works great", ir);

    expect(verification.schedulingOverridden).toBe(false);
    expect(verified.constraints.schedulingWindow).toEqual(ir.constraints.schedulingWindow);
  });

  it("does not invent a scheduling override when the raw text has no explicit date token at all", () => {
    const ir = emptyIR({
      constraints: { schedulingWindow: { date: { kind: "explicitDate", isoDate: "2026-11-03" } } },
    });
    const { verified, verification } = verifyIR(graph, "sometime soon works for me", ir);
    expect(verification.schedulingOverridden).toBe(false);
    expect(verified.constraints.schedulingWindow).toEqual(ir.constraints.schedulingWindow);
  });
});

describe("verifyIR: never computes a final UTC instant itself", () => {
  it("verified IR still carries only a SEMANTIC scheduling constraint, never a resolved timestamp", () => {
    const graph = buildSpaGraph();
    const ir = emptyIR({
      constraints: { schedulingWindow: { date: { kind: "explicitDate", isoDate: "2026-09-27" } } },
    });
    const { verified } = verifyIR(graph, "Tuesday please", ir);

    const date = verified.constraints.schedulingWindow?.date;
    expect(date?.kind).toBe("weekday");
    // No "earliest"/"latest" absolute timestamp field exists anywhere on
    // the verified IR — resolution is still the compiler+resolver's job.
    expect(verified.constraints.schedulingWindow).not.toHaveProperty("earliest");
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
