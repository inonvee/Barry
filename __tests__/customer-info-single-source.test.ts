import { describe, expect, it } from "vitest";
import { compile } from "@/lib/runtime/compiler";
import { verifyIR } from "@/lib/reasoner/verify";
import { parseIRResponse } from "@/lib/reasoner/openai-reasoner";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { handleCustomerMessage } from "@/lib/runtime";
import { createInitialConversationState } from "@/lib/state";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * (Updated for the model-first architecture: customerInfo is the model's
 * evidence-cited claim; verifyIR checks the evidence and never recovers
 * values from raw text itself.)
 *
 * CUSTOMER INFO SINGLE-SOURCE-OF-TRUTH FIX. Live bug: the LLM correctly
 * understood "My name is Inon and my phone number is 057484848" — it
 * showed up in `understood.entities` — but the OLD duplicate
 * `knownFieldsUpdate` field (the only one the compiler actually merged
 * into persistent state) stayed empty, so BARRY kept asking for name and
 * phone it had already been given. `entities`/`knownFieldsUpdate` were
 * two parallel representations of the same fact; the model could (and
 * did) fill one and omit the other.
 *
 * Fix: `BarryIR.customerInfo` is now THE single authoritative channel
 * (entities stays free-form/debug, never read by the compiler), backed
 * by a deterministic identity-verification layer (`verifyIR`) that
 * independently recovers an explicit self-announced name, phone, or
 * email from the raw text — so even if a Reasoner forgets to populate
 * customerInfo, the exact live failure can no longer reproduce.
 */
function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

describe("Regression 1: exact live message persists name/phone in the same turn", () => {
  it('"My name is Inon and my phone number is 057484848" — persisted knownFields set, missingFields cleared', async () => {
    const graph = buildSpaGraph();
    const conv = "cis-1";
    const customer = "cust-cis-1";

    await handleCustomerMessage(graph, conv, customer, "Couples massage please");
    const t = await handleCustomerMessage(
      graph,
      conv,
      customer,
      "My name is Inon and my phone number is 057484848"
    );

    expect(t.state.knownFields.name).toBe("Inon");
    expect(t.state.knownFields.phone).toBe("057484848");
    expect(t.state.missingFields).not.toContain("name");
    expect(t.state.missingFields).not.toContain("phone");
  });
});

describe("Regression 2: customerInfo is the model's evidence-cited claim — BARRY never recovers it from raw text", () => {
  it("an LLM response that cites evidence for name+phone persists them", () => {
    const graph = buildSpaGraph();
    const message = "My name is Inon and my phone number is 057484848";
    const rawLlmResponse = JSON.stringify({
      intent: "provide_contact_info",
      selectedOfferId: "offer-couples-massage",
      offerCandidateIds: [],
      offerChangeRequested: null,
      entities: [],
      constraints: { schedulingWindow: null, partySize: null, discountPct: null, slotAccepted: null, slotDeclined: null },
      customerInfo: [
        { key: "name", value: "Inon" },
        { key: "phone", value: "057484848" },
      ],
      requestedCapability: null,
      goal: null,
      commerce: null,
      customerClaimsPaymentCompleted: null,
    purchaseDecision: null,
      evidence: [
        { key: "customerInfo.name", value: "My name is Inon" },
        { key: "customerInfo.phone", value: "my phone number is 057484848" },
      ],
      knowledgeTopic: null,
    });

    const parsed = parseIRResponse(graph, rawLlmResponse);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { verified, verification } = verifyIR(graph, message, parsed.ir);
    expect(verification.rejected).toEqual([]);

    const state = createInitialConversationState("cis-2", graph.business.id, "cust-cis-2");
    state.selectedOfferId = "offer-couples-massage";
    const outcome = compile(graph, state, verified);
    expect(state.knownFields.name).toBe("Inon");
    expect(state.knownFields.phone).toBe("057484848");
    expect(outcome.kind).not.toBe("needs_info");
  });

  it("if the model leaves customerInfo empty, verifyIR does NOT recover it from raw text (no deterministic name parser)", () => {
    const graph = buildSpaGraph();
    const { verified } = verifyIR(graph, "My name is Inon and my phone number is 057484848", emptyIR());
    expect(verified.customerInfo).toEqual({});
  });
});

describe("Regression 2b: customer facts require evidence; impossible values never persist", () => {
  it("a proposed name with no cited evidence is rejected — and never replaced by a guess", () => {
    const graph = buildSpaGraph();
    const { verified, verification } = verifyIR(graph, "השם שלי זה ינון", emptyIR({ customerInfo: { name: "זה" } }));
    expect(verified.customerInfo.name).toBeUndefined();
    expect(verification.rejected[0]).toMatchObject({ claim: "customerInfo.name", reason: "no evidence cited" });
  });

  it("evidence must really occur in the message and contain the value", () => {
    const graph = buildSpaGraph();
    const notInMessage = verifyIR(graph, "hello", emptyIR({ customerInfo: { name: "Dana" }, evidence: { "customerInfo.name": "my name is Dana" } }));
    const doesNotContain = verifyIR(graph, "my name is Dana", emptyIR({ customerInfo: { name: "Rina" }, evidence: { "customerInfo.name": "my name is Dana" } }));
    expect(notInMessage.verified.customerInfo.name).toBeUndefined();
    expect(doesNotContain.verified.customerInfo.name).toBeUndefined();
  });

  const invalidHebrewNames = ["אשתי", "אישתי", "בעלי", "בן הזוג", "בת הזוג"];

  for (const invalidName of invalidHebrewNames) {
    it(`relationship value "${invalidName}" never persists as a customer name, even with cited evidence`, () => {
      const graph = buildSpaGraph();
      const message = "אני רוצה לבוא עם אשתי ועם בעלי ועם בן הזוג ועם בת הזוג ועם אישתי";
      const noEvidence = verifyIR(graph, message, emptyIR({ customerInfo: { name: invalidName } }));
      expect(noEvidence.verified.customerInfo.name).toBeUndefined();

      const withEvidence = verifyIR(graph, message, emptyIR({ customerInfo: { name: invalidName }, evidence: { "customerInfo.name": invalidName } }));
      const state = createInitialConversationState(`cis-rel-${invalidName}`, graph.business.id, "c");
      compile(graph, state, withEvidence.verified);
      expect(state.knownFields.name).toBeUndefined();
    });
  }

  it("rejects an LLM-proposed English relationship value without customer-identity evidence", () => {
    const graph = buildSpaGraph();
    const { verified } = verifyIR(
      graph,
      "My wife is coming with me",
      emptyIR({ customerInfo: { name: "wife" } })
    );

    expect(verified.customerInfo.name).toBeUndefined();
  });

  it("\"My wife's name is Sarah\" does not persist Sarah as the customer's own name merely because the LLM proposed it", () => {
    const graph = buildSpaGraph();
    const { verified } = verifyIR(
      graph,
      "My wife's name is Sarah",
      emptyIR({ customerInfo: { name: "Sarah" } })
    );

    expect(verified.customerInfo.name).toBeUndefined();
  });

  it("preserves a contextual bare-name reply when BARRY just asked for the customer's name", async () => {
    const graph = buildSpaGraph();
    const conv = "cis-contextual-he-name";
    const customer = "cust-cis-contextual-he-name";

    await handleCustomerMessage(graph, conv, customer, "זוגי בחמישי בשעה אחת");
    const t = await handleCustomerMessage(graph, conv, customer, "ינון");

    expect(t.state.knownFields.name).toBe("ינון");
  });
});

describe("Regression 5: a later corrected phone (deterministically, regardless of what any reasoner reports)", () => {
  it('"Actually my number is 0501234567" replaces the previously stored phone', async () => {
    const graph = buildSpaGraph();
    const conv = "cis-5";
    const customer = "cust-cis-5";

    await handleCustomerMessage(graph, conv, customer, "Couples massage please");
    await handleCustomerMessage(graph, conv, customer, "My name is Inon and my phone number is 057484848");
    const t = await handleCustomerMessage(graph, conv, customer, "Actually my number is 0501234567");

    expect(t.state.knownFields.phone).toBe("0501234567");
    expect(t.state.knownFields.name).toBe("Inon"); // untouched
  });
});

describe("Regression 6: an existing good name survives a later turn that mentions no name at all", () => {
  it("compiler-level: customerInfo omitting 'name' entirely never clears the existing value", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("cis-6", graph.business.id, "cust-cis-6");
    state.selectedOfferId = "offer-couples-massage";
    state.knownFields.name = "Jordan Lee";

    compile(graph, state, emptyIR({ customerInfo: { phone: "555-111-2222" } }));

    expect(state.knownFields.name).toBe("Jordan Lee");
    expect(state.knownFields.phone).toBe("555-111-2222");
  });

  it("end-to-end: name set on one turn survives an unrelated later turn", async () => {
    const graph = buildSpaGraph();
    const conv = "cis-6b";
    const customer = "cust-cis-6b";

    await handleCustomerMessage(graph, conv, customer, "Couples massage please");
    await handleCustomerMessage(graph, conv, customer, "My name is Inon");
    const t = await handleCustomerMessage(graph, conv, customer, "057484848");

    expect(t.state.knownFields.name).toBe("Inon");
    expect(t.state.knownFields.phone).toBe("057484848");
  });
});

describe("Regression 7: composer grounding — exactly the missing fields, never invented/pluralized", () => {
  it('partySize=2 + missingFields=["name","phone"] asks for ONE name and ONE phone number, never "names and phone numbers"', () => {
    const response = composeDeterministic({
      outcome: { kind: "needs_info", offerName: "Couples Massage", missingFields: ["name", "phone"], stage: "info_gathering" },
    });

    const lower = response.toLowerCase();
    expect(lower).toContain("name");
    expect(lower).toContain("phone number");
    expect(lower).not.toMatch(/\bnames\b/);
    expect(lower).not.toMatch(/phone numbers/);
  });

  it("a single missing field is asked for singularly", () => {
    const response = composeDeterministic({
      outcome: { kind: "needs_info", offerName: "Couples Massage", missingFields: ["phone"], stage: "info_gathering" },
    });
    expect(response.toLowerCase()).toContain("phone number");
    expect(response.toLowerCase()).not.toContain("and");
  });
});

describe("Regression 8: full exact live scenario end-to-end", () => {
  it("Hello / Couples / Tuesday at 3pm / My name is Inon and my phone number is 057484848 — no re-request for name/phone", async () => {
    const graph = buildSpaGraph();
    const conv = "cis-8";
    const customer = "cust-cis-8";

    const t1 = await handleCustomerMessage(graph, conv, customer, "Hello");
    expect(t1.state.selectedOfferId).toBeUndefined();

    const t2 = await handleCustomerMessage(graph, conv, customer, "Couples");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");

    const t3 = await handleCustomerMessage(graph, conv, customer, "I wanna come with my wife Tuesday at 3pm");
    expect(t3.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t3.state.knownFields.__mentionedPartySize).toBe("2");
    const earliest = t3.state.knownFields.__mentionedEarliest;
    expect(earliest).toBeTruthy();
    expect(new Date(earliest).getUTCDay()).toBe(2); // Tuesday
    expect([19, 20]).toContain(new Date(earliest).getUTCHours()); // 3pm EDT/EST -> 19:00 or 20:00 UTC

    const t4 = await handleCustomerMessage(
      graph,
      conv,
      customer,
      "My name is Inon and my phone number is 057484848"
    );

    expect(t4.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t4.state.knownFields.name).toBe("Inon");
    expect(t4.state.knownFields.phone).toBe("057484848");
    expect(t4.state.missingFields).toEqual([]);
    // BARRY must proceed to the availability/slot flow, not re-ask for info.
    expect(t4.turn.selectedAction?.name).toBe("checkAvailability");
    expect(t4.response.toLowerCase()).not.toMatch(/name|phone number/);
  });
});
