import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MockReasoner } from "@/lib/reasoner";
import { parseIRResponse } from "@/lib/reasoner/openai-reasoner";
import { verifyIR } from "@/lib/reasoner/verify";
import { compile } from "@/lib/runtime/compiler";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { createInitialConversationState } from "@/lib/state";
import { REFERENCE_CASES, runReferenceCase, summarise, type CaseResult } from "./support/reference-corpus";
import { ScriptedReasoner } from "./support/semantic-corpus";

/**
 * Reference & decision semantics. Live failure this pins down
 * (gpt-4o-mini, commit 9a1a934, conversation conv_b8fn747o):
 *   BARRY showed exactly one dress; "אני אקח אותה במדיום" was understood
 *   as commerce CHECKOUT (with size M and a purchase decision) while the
 *   cart was still empty, and checkout-without-cart answered "which item
 *   do you mean?". Persisted state proved it: __commerceCheckoutRequested
 *   was set (only the checkout intent sets it) and no selection intent was.
 */

describe("pipeline: competent model semantics -> correct grounded outcome (proves BARRY, not any model)", () => {
  it.each(REFERENCE_CASES.map((c) => [c.group, c.text, c]))("[%s] %s", async (_g, _t, c) => {
    const result = await runReferenceCase(c, new ScriptedReasoner({ [c.text]: c.competentIr }));
    expect(result.failures).toEqual([]);
  });
});

const standIn: CaseResult[] = [];

describe("offline stand-in: never a false action, never paid — understanding coverage is informational", () => {
  it.each(REFERENCE_CASES.filter((c) => c.group !== "live_regression").map((c) => [c.group, c.text, c]))("[%s] %s", async (_g, _t, c) => {
    const result = await runReferenceCase(c, new MockReasoner());
    standIn.push(result);
    expect(result.falseAction).toBe(false);
    expect(result.failures).not.toContain("marked paid from the conversation");
    if (c.expect.noCheckout) expect(result.failures).not.toContain("created a checkout/payment link");
  });
  afterAll(() => console.info("[reference-semantics] offline stand-in", JSON.stringify(summarise(standIn))));
});

describe("grounding: references never escape what BARRY showed", () => {
  const graph = buildFashionRetailerGraph();
  function stateWithShown(ids: string[], cartLine = false) {
    const state = createInitialConversationState(`g-${Math.random()}`, graph.business.id, "c");
    state.knownFields.__commerceLastProductIds = ids.join(",");
    if (cartLine) {
      state.knownFields.__commerceCartId = "cart-1";
      state.knownFields.__commerceCartLineId = "line-1";
    }
    return state;
  }
  const selectAt = (index: number) => ({
    intent: "select",
    entities: {},
    constraints: {},
    customerInfo: {},
    commerce: { intent: "select" as const, reference: { type: "previous_result" as const, index }, variant: { size: "M" } },
  });

  it.each([
    ["past the end with ONE result (no silent fallback to the only item)", ["p-a"], 1],
    ["past the end with three results", ["p-a", "p-b", "p-c"], 5],
    ["negative (position 0)", ["p-a", "p-b"], -1],
  ])("%s -> rejected, marked, and BARRY asks", (_label, ids, index) => {
    const state = stateWithShown(ids as string[]);
    const { verified, verification } = verifyIR(graph, "x", selectAt(index as number), state);
    expect(verification.rejected.map((r) => r.claim)).toContain("commerce.reference");
    expect(verified.commerce?.referenceInvalid).toBe(true);
    expect(compile(graph, state, verified).kind).toBe("clarify_reference");
  });

  it("a valid explicit position selects exactly that result", () => {
    const state = stateWithShown(["p-a", "p-b", "p-c"]);
    const { verified } = verifyIR(graph, "x", selectAt(2), state);
    const out = compile(graph, state, verified);
    expect(out.kind).toBe("action");
    if (out.kind === "action") expect(out.action.input).toMatchObject({ productId: "p-c", options: { size: "M" } });
  });

  it("no position + exactly one shown -> that one; no position + several -> ask", () => {
    const noRef = { intent: "select", entities: {}, constraints: {}, customerInfo: {}, commerce: { intent: "select" as const, variant: { size: "M" } } };
    const one = stateWithShown(["p-only"]);
    const outOne = compile(graph, one, verifyIR(graph, "x", noRef, one).verified);
    expect(outOne.kind === "action" && outOne.action.input).toMatchObject({ productId: "p-only" });
    const many = stateWithShown(["p-a", "p-b"]);
    expect(compile(graph, many, verifyIR(graph, "x", noRef, many).verified).kind).toBe("clarify_reference");
  });

  it("a cart-less checkout is a decided selection grounded the same way — never 'which item?' when only one was shown", () => {
    const live = { intent: "completePurchase", entities: {}, constraints: {}, customerInfo: {}, purchaseDecision: true, commerce: { intent: "checkout" as const, variant: { size: "M" } } };
    const one = stateWithShown(["prod-onyx-slip-dress"]);
    const out = compile(graph, one, verifyIR(graph, "אני אקח אותה במדיום", live, one).verified);
    expect(out.kind === "action" && out.action).toMatchObject({ name: "addToCart", input: { productId: "prod-onyx-slip-dress", options: { size: "M" } } });
    expect(one.knownFields.__commerceCheckoutOnSuccess).toBe("1"); // eligibility only after the add verifiably succeeds
    expect(one.knownFields.__commerceCheckoutRequested).toBeUndefined();
    const many = stateWithShown(["p-a", "p-b"]);
    expect(compile(graph, many, verifyIR(graph, "x", live, many).verified).kind).toBe("clarify_reference");
  });

  it("a cart-line reference outside the cart is rejected", () => {
    const state = stateWithShown(["p-a"], true);
    const ir = { intent: "x", entities: {}, constraints: {}, customerInfo: {}, commerce: { intent: "change_variant" as const, reference: { type: "cart_line" as const, index: 3 }, variant: { size: "L" } } };
    const { verified, verification } = verifyIR(graph, "x", ir, state);
    expect(verification.rejected.map((r) => r.claim)).toContain("commerce.reference");
    expect(verified.commerce?.referenceInvalid).toBe(true);
  });
});

describe("model contract: positions are the ones the customer saw", () => {
  it("referencePosition 1 means the first shown item (0 internally); the model can never name a product id", () => {
    const raw = {
      intent: "select",
      selectedOfferId: null,
      offerCandidateIds: [],
      offerChangeRequested: null,
      entities: [],
      constraints: { schedulingWindow: null, partySize: null, discountPct: null, slotAccepted: null, slotDeclined: null },
      customerFacts: [],
      requestedCapability: null,
      goal: null,
      commerce: {
        intent: "select",
        queryText: null,
        category: null,
        attributes: [],
        budgetAmount: null,
        budgetCurrency: null,
        referenceType: "previous_result",
        referencePosition: 1,
        variant: [{ key: "size", value: "M" }],
        quantity: null,
        requestedPriceAmount: null,
        requestedPriceCurrency: null,
        productId: "prod-injected",
      },
      customerClaimsPaymentCompleted: null,
      purchaseDecision: true,
      knowledgeTopic: null,
    capabilityRequest: null,
    };
    const parsed = parseIRResponse(buildFashionRetailerGraph(), JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.ir.commerce).toMatchObject({ intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } });
      expect(JSON.stringify(parsed.ir)).not.toContain("prod-injected");
      expect(parsed.ir.purchaseDecision).toBe(true);
    }
  });
});

describe("no phrase-specific language logic in BARRY's core", () => {
  const SRC = path.join(__dirname, "..", "src", "lib");
  const CORE = ["runtime/compiler.ts", "runtime/engine.ts", "reasoner/verify.ts", "tools/definitions.ts", "commerce/capability.ts", "commerce/catalog.ts", "capabilities/model.ts", "policy/engine.ts"];
  it.each(CORE)("%s contains no Hebrew literals and no pronoun/phrase matching", (rel) => {
    const code = fs
      .readFileSync(path.join(SRC, rel), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)) // comments may cite a live failure
      .join("\n");
    expect(code).not.toMatch(/[א-ת]/);
    expect(code).not.toMatch(/\\b(it|that one|this one|the first|the second)\\b|אותה|אותו/i);
  });
});

describe("the model's view of what was shown", () => {
  it("lists items by the position the customer saw, with real stock — and never exposes a product id", async () => {
    const { buildUnderstandingContext } = await import("@/lib/reasoner/openai-reasoner");
    const graph = buildFashionRetailerGraph();
    const state = createInitialConversationState("ctx-view", graph.business.id, "c");
    state.knownFields.__commerceLastProductIds = "prod-midnight-wrap-dress,prod-onyx-slip-dress";
    state.knownFields.__commercePendingProductId = "prod-onyx-slip-dress";
    const shownProducts = [
      { id: "prod-midnight-wrap-dress", position: 1, title: "Midnight Wrap Dress", variants: [{ options: { size: "M" }, price: "420 ILS", inStock: true }] },
      { id: "prod-onyx-slip-dress", position: 2, title: "Onyx Slip Dress", variants: [{ options: { size: "M" }, price: "390 ILS", inStock: true }] },
    ];
    const shownResults = shownProducts.map(({ id: _id, ...rest }) => (void _id, rest));
    const context = buildUnderstandingContext({ graph, state, customerMessage: "x", grounded: { shownResults, shownProducts } });
    expect(context.shownResults.map((r) => [r.position, r.title])).toEqual([[1, "Midnight Wrap Dress"], [2, "Onyx Slip Dress"]]);
    expect(context.awaitingVariantChoiceFor).toEqual({ position: 2, title: "Onyx Slip Dress" });
    expect(JSON.stringify(context)).not.toMatch(/prod-/);
  });
});
