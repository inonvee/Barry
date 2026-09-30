import { afterEach, describe, expect, it } from "vitest";
import { parseIRResponse } from "@/lib/reasoner/openai-reasoner";
import { verifyIR } from "@/lib/reasoner/verify";
import { resolveReplyLanguage, scriptLanguage } from "@/lib/reasoner/language";
import { checkInfoRequest } from "@/lib/reasoner/reply-contract";
import { compile } from "@/lib/runtime/compiler";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { createInitialConversationState } from "@/lib/state";
import { setReasonerForTests, type BarryIR, type ComposeResponseInput, type Reasoner, type ReasonerContext } from "@/lib/reasoner";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import type { BusinessGraph } from "@/lib/business-graph";
import { ScriptedReasoner } from "./support/semantic-corpus";

/**
 * Live failures (GPT-5.6 Sol preview, Rina Studio checkout needs name + phone):
 *  1. The customer sent "0558832177". The model proposed { "customerInfo.phone": ... }
 *     and grounding looked for evidence under "customerInfo.customerInfo.phone" —
 *     "no evidence cited", checkout stayed blocked. Root cause: facts and their
 *     evidence travelled in two parallel key/value arrays with a namespace the
 *     model had to reproduce exactly.
 *  2. After the digits-only message the reply switched from Hebrew to English.
 *  3. BARRY asked for "full name" although the business requires only "name".
 */

const graph = buildFashionRetailerGraph();

function rawIR(customerFacts: { field: string; value: string; evidence: string }[]) {
  return JSON.stringify({
    intent: "provide_details",
    selectedOfferId: null,
    offerCandidateIds: [],
    offerChangeRequested: null,
    entities: [],
    constraints: { schedulingWindow: null, partySize: null, discountPct: null, slotAccepted: null, slotDeclined: null },
    customerFacts,
    requestedCapability: null,
    goal: null,
    commerce: null,
    customerClaimsPaymentCompleted: null,
    purchaseDecision: null,
    knowledgeTopic: null,
    capabilityRequest: null,
  });
}

function ground(message: string, facts: { field: string; value: string; evidence: string }[]) {
  const parsed = parseIRResponse(graph, rawIR(facts));
  if (!parsed.ok) throw new Error(parsed.kind);
  const state = createInitialConversationState(`c-${Math.random()}`, graph.business.id, "cust");
  const { verified, verification } = verifyIR(graph, message, parsed.ir, state);
  compile(graph, state, verified);
  return { verified, verification, state };
}

describe("customer facts: field + value + evidence bound together", () => {
  it("the live phone turn: a digits-only message with the fact bound to its own quote is accepted and applied", () => {
    const { verification, state } = ground("0558832177", [{ field: "phone", value: "0558832177", evidence: "0558832177" }]);
    expect(verification.customerFacts).toEqual([{ field: "phone", value: "0558832177", evidence: "0558832177", status: "accepted" }]);
    expect(state.knownFields.phone).toBe("0558832177");
  });

  it("a name with evidence is accepted", () => {
    const { state } = ground("שירה לוי", [{ field: "name", value: "שירה לוי", evidence: "שירה לוי" }]);
    expect(state.knownFields.name).toBe("שירה לוי");
  });

  it("numbers are compared by digits: a formatted number in the message supports the plain value", () => {
    const { state } = ground("הטלפון שלי 055-883 2177", [{ field: "phone", value: "0558832177", evidence: "055-883 2177" }]);
    expect(state.knownFields.phone).toBe("0558832177");
  });

  it("any field the business defines works — the contract is not a fixed name/phone/email list", () => {
    const { verification, state } = ground("מידה 38 בנעליים", [{ field: "shoe_size", value: "38", evidence: "מידה 38" }]);
    expect(verification.customerFacts?.[0].status).toBe("accepted");
    expect(state.knownFields.shoe_size).toBe("38");
  });

  it.each([
    ["evidence not in this message", "0558832177", { field: "phone", value: "0558832177", evidence: "my number is 0558832177" }, "evidence not found in this message"],
    ["evidence does not contain the value", "שירה לוי", { field: "name", value: "דנה", evidence: "שירה לוי" }, "evidence does not contain the value"],
    ["a namespaced key", "0558832177", { field: "customerInfo.phone", value: "0558832177", evidence: "0558832177" }, "not a plain field name"],
    ["an internal state key", "paid", { field: "__paid", value: "1", evidence: "paid" }, "internal state key — never a customer field"],
    ["another internal key", "x", { field: "__commerceCartId", value: "cart_1", evidence: "x" }, "internal state key — never a customer field"],
  ])("rejects %s — never persisted, never rewritten", (_label, message, fact, reason) => {
    const { verification, state } = ground(message, [fact]);
    expect(verification.customerFacts).toEqual([expect.objectContaining({ field: fact.field, status: "rejected", reason })]);
    expect(state.knownFields[fact.field]).toBeUndefined();
    expect(state.knownFields.phone).toBeUndefined();
    expect(state.knownFields.__paid).toBeUndefined();
    // Readable claims — the operator never sees "customerInfo.customerInfo.phone".
    expect(verification.rejected.map((r) => r.claim).join(" ")).not.toContain("customerInfo.customerInfo");
  });

  it("the model-facing schema has no separate evidence array and no key namespace to reproduce", async () => {
    const { irJsonSchema } = await import("@/lib/reasoner/schemas");
    const props = irJsonSchema().schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("customerFacts");
    expect(props).not.toHaveProperty("evidence");
    expect(props).not.toHaveProperty("customerInfo");
  });
});

describe("reply language persists through words-free messages", () => {
  it.each([
    [["היי אני מחפשת שמלה", "0558832177"], "he", "recent_turn"],
    [["Hi, I'm looking for a dress", "0558832177"], "en", "recent_turn"],
    [["שירה לוי", "shira@example.com"], "he", "recent_turn"],
    [["אני אקח אותה", "ORDER-29382"], "he", "recent_turn"],
    [["תודה", "👍"], "he", "recent_turn"],
    [["כן", "https://example.com/p/1"], "he", "business_locale"],
    [["שלום", "₪390"], "he", "recent_turn"],
    [["Onyx במידה M"], "he", "current_turn"],
    [["I'll take the Onyx"], "en", "current_turn"],
  ])("%j -> %s (%s)", (messages, code, basis) => {
    expect(resolveReplyLanguage({ customerMessages: messages as string[], businessLocale: "he-IL" })).toMatchObject({ code, basis });
  });

  it("falls back to the stored conversation language, then the business locale, then English", () => {
    expect(resolveReplyLanguage({ customerMessages: ["0558832177"], stored: "he", businessLocale: "en-US" })).toMatchObject({ code: "he", basis: "stored" });
    expect(resolveReplyLanguage({ customerMessages: ["0558832177"], businessLocale: "he-IL" })).toMatchObject({ code: "he", basis: "business_locale" });
    expect(resolveReplyLanguage({ customerMessages: ["👍"] })).toMatchObject({ code: "en", basis: "default" });
  });

  it("short fragments and codes carry no language", () => {
    for (const text of ["ok", "M", "👍", "ORDER-29382", "hello@example.com", "₪390", "0558832177"]) expect(scriptLanguage(text)).toBeUndefined();
  });
});

describe("the details BARRY asks for are exactly what the compiler says is missing", () => {
  it.each([
    [["phone"], "מה מספר הטלפון שלך?", "he", undefined],
    [["phone"], "אפשר שם מלא ומספר טלפון?", "he", /not missing|stricter/],
    [["phone"], "Could you share your phone and email?", "en", /email/],
    [["name"], "What's your full name?", "en", /stricter/],
    [["name"], "אפשר שם מלא?", "he", /stricter/],
    [["name"], "What name should I put the order under?", "en", undefined],
    [["name", "phone"], "כדי להמשיך, אפשר שם ומספר טלפון?", "he", undefined],
    [["name", "phone"], "Could you share your name?", "en", /phone/],
    [["email"], "מה כתובת האימייל שלך?", "he", undefined],
  ])("missing %j, reply %j", (missing, text, lang, expected) => {
    const violation = checkInfoRequest(text, missing as string[], lang);
    if (expected) expect(violation?.reason).toMatch(expected as RegExp);
    else expect(violation).toBeUndefined();
  });
});

/** A model-backed reasoner stand-in whose wording breaks the missing-field contract. */
class OverreachingComposer implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "test-reasoner";
  readonly composerModel = "test-composer";
  constructor(private readonly script: ScriptedReasoner, private readonly reply: string) {}
  understand(ctx: ReasonerContext): Promise<BarryIR> {
    return this.script.understand(ctx);
  }
  async composeResponse(_ctx: ReasonerContext, _input: ComposeResponseInput): Promise<string> {
    void _ctx;
    void _input;
    return this.reply;
  }
}

describe("runtime: Rina checkout details in Hebrew, exactly the missing fields", () => {
  const SEARCH = "היי אני מחפשת שמלה במידה מדיום עד 400 ש״ח";
  const TAKE = "אני אקח אותה במדיום";
  const NAME = "שירה לוי";
  const PHONE = "0558832177";
  const SCRIPT: Record<string, Partial<BarryIR>> = {
    [SEARCH]: { intent: "search", commerce: { intent: "search", query: { text: SEARCH, category: "dress", budget: { amount: 400, currency: "ILS" } }, variant: { size: "M" } } },
    [TAKE]: { intent: "select", purchaseDecision: true, commerce: { intent: "select", variant: { size: "M" } } },
    [NAME]: { intent: "details", customerInfo: { name: NAME }, evidence: { "customerInfo.name": NAME } },
    [PHONE]: { intent: "details", customerInfo: { phone: PHONE }, evidence: { "customerInfo.phone": PHONE } },
  };
  let id = "";
  function freshGraph(): BusinessGraph {
    id = `lang-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const adapter = new MemoryCommerceAdapter(fashionCatalog());
    registerCommerceAdapterFactoryForTests(id, () => adapter);
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    return { ...graph, business: { ...graph.business, id } };
  }
  afterEach(() => {
    registerCommerceAdapterFactoryForTests(id, undefined);
    setReasonerForTests(undefined);
    setPaymentAdapterForTests(undefined);
  });

  it("the phone-only turn is answered in Hebrew and completes checkout", async () => {
    const g = freshGraph();
    setReasonerForTests(new ScriptedReasoner(SCRIPT));
    const conv = `conv-${id}`;
    for (const m of [SEARCH, TAKE]) await handleCustomerMessage(g, conv, "c", m);
    const name = await handleCustomerMessage(g, conv, "c", NAME);
    expect(name.state.missingFields).toEqual(["phone"]);
    expect(name.response).toMatch(/טלפון/);
    expect(name.response).not.toMatch(/(^|[^\p{L}])שם(?![\p{L}])/u);
    const phone = await handleCustomerMessage(g, conv, "c", PHONE);
    expect(phone.turn.trace?.reply).toMatchObject({ language: "he", basis: "recent_turn" });
    expect(phone.response).toMatch(/[א-ת]/);
    expect(phone.turn.trace?.steps.map((s) => s.action)).toEqual(["createCommerceCheckout"]);
  });

  it("a model reply that asks for 'full name' (business needs name) is replaced by the deterministic Hebrew request", async () => {
    const g = freshGraph();
    setReasonerForTests(new OverreachingComposer(new ScriptedReasoner(SCRIPT), "Great! Could I get your full name and phone number?"));
    const conv = `conv-${id}`;
    await handleCustomerMessage(g, conv, "c", SEARCH);
    const take = await handleCustomerMessage(g, conv, "c", TAKE);
    // Caught as the wrong language and/or the wrong fields — either way the deterministic Hebrew request is used.
    expect(take.turn.trace?.reply?.fallback).toMatch(/missing-field contract|language/);
    expect(take.response).not.toMatch(/full name|שם מלא/i);
    expect(take.response).toMatch(/שם/);
    expect(take.response).toMatch(/טלפון/);
    expect(take.turn.trace?.runtime).toMatchObject({ model: "test-reasoner", composerModel: "test-composer" });
  });

  it("a model reply that re-asks for the name when only phone is missing is replaced", async () => {
    const g = freshGraph();
    setReasonerForTests(new OverreachingComposer(new ScriptedReasoner(SCRIPT), "תודה! אפשר שם ומספר טלפון?"));
    const conv = `conv-${id}`;
    for (const m of [SEARCH, TAKE]) await handleCustomerMessage(g, conv, "c", m);
    const name = await handleCustomerMessage(g, conv, "c", NAME);
    expect(name.state.missingFields).toEqual(["phone"]);
    expect(name.turn.trace?.reply?.fallback).toMatch(/"name", which is not missing/);
    expect(name.response).toMatch(/מספר טלפון/);
  });
});
