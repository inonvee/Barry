import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { MockReasoner, setReasonerForTests, type Reasoner } from "@/lib/reasoner";
import { OpenAIReasoner } from "@/lib/reasoner/openai-reasoner";
import { verifyIR } from "@/lib/reasoner/verify";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { resolveCommerceAdapterForBusiness } from "@/lib/commerce/registry";
import { createInitialConversationState } from "@/lib/state";
import type { TurnOutcome } from "@/lib/runtime/engine";
import {
  ALL_PARAPHRASES,
  SEMANTIC_GROUPS,
  SETUP_SCRIPT,
  SETUP_TURNS,
  ScriptedReasoner,
  type ParaphraseGroup,
} from "./support/semantic-corpus";

const CONSEQUENTIAL = new Set(["addToCart", "updateCartLine", "createCommerceCheckout", "createCommerceOrder", "createPaymentRequest", "createBooking"]);

let seq = 0;
async function runCase(group: ParaphraseGroup, text: string, turnReasoner: Reasoner) {
  setPaymentAdapterForTests(new MemoryPaymentAdapter());
  const graph = buildFashionRetailerGraph();
  const conv = `sem-${group.id}-${Date.now()}-${seq++}`;
  const cust = `cust-${conv}`;
  const setupReasoner = new ScriptedReasoner({ ...SETUP_SCRIPT, [text]: group.ir });
  setReasonerForTests(setupReasoner);
  let last: TurnOutcome | undefined;
  for (const turn of SETUP_TURNS[group.setup]) last = await handleCustomerMessage(graph, conv, cust, turn);
  const shown = (last?.state.knownFields.__commerceLastProductIds ?? "").split(",").filter(Boolean);
  const cartId = last?.state.knownFields.__commerceCartId;
  setReasonerForTests(turnReasoner);
  const out = await handleCustomerMessage(graph, conv, cust, text);
  setReasonerForTests(setupReasoner);
  const cart = cartId || out.state.knownFields.__commerceCartId
    ? await (await resolveCommerceAdapterForBusiness(graph.business.id)).getCart(out.state.knownFields.__commerceCartId ?? cartId!)
    : undefined;
  return { graph, conv, cust, shown, out, cart, followUp: (msg: string) => handleCustomerMessage(graph, conv, cust, msg) };
}

type Case = Awaited<ReturnType<typeof runCase>>;
type Input = { productId?: string; options?: Record<string, string>; replaceLine?: unknown };

/** The grounded outcome every paraphrase of a group must reach. */
const EXPECT: Record<string, (c: Case) => Promise<void> | void> = {
  select_first_in_M: ({ out, shown, cart }) => {
    expect(out.turn.selectedAction?.name).toBe("addToCart");
    expect(out.turn.selectedAction?.input).toMatchObject({ productId: shown[0], options: { size: "M" } });
    expect(out.turn.toolResult?.output).toMatchObject({ added: true });
    expect(cart?.lines.map((l) => [l.productId, l.options.size])).toEqual([[shown[0], "M"]]);
    expect(out.state.knownFields.name).toBeUndefined();
  },
  select_second: ({ out, shown }) => {
    expect(out.turn.selectedAction?.name).toBe("addToCart");
    expect((out.turn.selectedAction?.input as Input).productId).toBe(shown[1]);
    expect(out.turn.toolResult?.ok).toBe(true);
  },
  change_cart_item_to_M: ({ out, shown, cart }) => {
    expect(out.turn.selectedAction?.name).toBe("updateCartLine");
    expect(out.turn.toolResult?.output).toMatchObject({ added: true });
    expect(cart?.lines.map((l) => [l.productId, l.options.size])).toEqual([[shown[0], "M"]]);
  },
  replace_with_first: async ({ out, shown, cart, followUp }) => {
    expect(out.turn.selectedAction?.name).toBe("addToCart");
    expect(out.turn.selectedAction?.input).toMatchObject({ productId: shown[0], replaceLine: expect.any(Object) });
    // The first result comes in two sizes: BARRY asks, and the cart is untouched meanwhile.
    expect(out.turn.toolResult?.output).toMatchObject({ added: false, notAdded: { reason: "needs_variant" } });
    expect(cart?.lines.map((l) => l.productId)).toEqual([shown[1]]);
    const done = await followUp("__followup: M");
    expect(done.turn.toolResult?.output).toMatchObject({ added: true, replacedLineId: expect.any(String) });
    const after = await (await resolveCommerceAdapterForBusiness("fashion-retailer")).getCart(done.state.knownFields.__commerceCartId);
    expect(after?.lines.map((l) => [l.productId, l.options.size])).toEqual([[shown[0], "M"]]);
  },
  negotiate_350: ({ out, cart }) => {
    expect(out.turn.selectedAction ?? undefined).toBeUndefined();
    expect(cart?.total.amount).toBe(420);
    expect(out.response).toMatch(/can't change prices/i);
  },
  claims_paid: ({ out }) => {
    expect(out.turn.selectedAction?.name).toBe("verifyPayment");
    expect(out.state.knownFields.__paid).toBeUndefined();
    expect(out.state.outcome).not.toBe("won");
  },
  search_black_dress: ({ out }) => {
    expect(out.turn.selectedAction?.name).toBe("searchProducts");
    expect(out.rich?.products?.length).toBeGreaterThan(0);
  },
};

afterEach(() => {
  setReasonerForTests(undefined);
  setPaymentAdapterForTests(undefined);
});

describe("semantic corpus", () => {
  it("has at least 50 paraphrases across Hebrew and English, including the ones from the field", () => {
    expect(ALL_PARAPHRASES.length).toBeGreaterThanOrEqual(50);
    const texts = ALL_PARAPHRASES.map((p) => p.text);
    for (const t of ["יאללה אני אקח את הראשונה ב-M", "שים לי אותה במדיום", "יאללה את השנייה", "עזוב, תחליף לראשונה", "יש מצב 350?", "אחי שילמתי כבר"]) {
      expect(texts).toContain(t);
    }
    expect(new Set(texts).size).toBe(texts.length);
    expect(Object.keys(EXPECT).sort()).toEqual(SEMANTIC_GROUPS.map((g) => g.id).sort());
  });
});

describe("model semantics -> identical grounded action (scripted model, real pipeline)", () => {
  it.each(ALL_PARAPHRASES.map((p) => [p.group.id, p.text, p]))("[%s] %s", async (_id, text, p) => {
    const c = await runCase(p.group, text, new ScriptedReasoner({ ...SETUP_SCRIPT, [text]: p.group.ir }));
    await EXPECT[p.group.id](c);
  });
});

const standInCoverage: Record<string, { understood: number; total: number }> = {};

describe("offline stand-in: never the wrong action (safety), whether or not it understands", () => {
  it.each(ALL_PARAPHRASES.map((p) => [p.group.id, p.text, p]))("[%s] %s", async (_id, text, p) => {
    const c = await runCase(p.group, text, new MockReasoner());
    const action = c.out.turn.selectedAction;
    const bucket = (standInCoverage[p.group.id] ??= { understood: 0, total: 0 });
    bucket.total += 1;

    // Never: invent a name, claim payment, or take a consequential action the meaning didn't ask for.
    expect(c.out.turn.compiled?.appliedCustomerInfo.name).toBeUndefined(); // this turn never invents a name
    expect(c.out.state.knownFields.__paid).toBeUndefined();
    let understood = false;
    try {
      await EXPECT[p.group.id](c);
      understood = true;
    } catch {
      understood = false;
    }
    if (understood) bucket.understood += 1;
    else if (action && CONSEQUENTIAL.has(action.name)) {
      throw new Error(`stand-in took a different consequential action for "${text}": ${action.name} ${JSON.stringify(action.input)}`);
    }
  });

  afterAll(() => {
    // Informational: how much the heuristic stand-in understands. The model is what production uses.
    console.info("[semantic-evals] offline stand-in coverage", JSON.stringify(standInCoverage));
  });
});

describe("grounding rejects what the model can't support", () => {
  const graph = buildFashionRetailerGraph();
  const state = createInitialConversationState("adv", graph.business.id, "c");

  it("a name with no evidence is rejected — 'אקח' can never become a customer name that way", () => {
    const { verified, verification } = verifyIR(graph, "יאללה אני אקח את הראשונה ב-M", {
      intent: "commerce_select",
      entities: {},
      constraints: {},
      customerInfo: { name: "אקח" },
      commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } },
    }, state);
    expect(verified.customerInfo.name).toBeUndefined();
    expect(verification.rejected.map((r) => r.claim)).toContain("customerInfo.name");
    expect(verified.commerce).toMatchObject({ intent: "select", reference: { index: 0 }, variant: { size: "M" } });
  });

  it("evidence must actually occur in the message and contain the value", () => {
    const { verified } = verifyIR(graph, "call me later", {
      intent: "x",
      entities: {},
      constraints: {},
      customerInfo: { name: "Dana", phone: "0501234567" },
      evidence: { "customerInfo.name": "my name is Dana", "customerInfo.phone": "0501234567" },
    }, state);
    expect(verified.customerInfo).toEqual({});
  });

  it("out-of-range and malformed commerce claims are rejected, never repaired", () => {
    const { verified, verification } = verifyIR(graph, "x", {
      intent: "x",
      entities: {},
      constraints: {},
      customerInfo: {},
      commerce: { intent: "select", reference: { type: "previous_result", index: -2 }, quantity: 0, requestedPrice: { amount: -5 } },
    }, state);
    expect(verified.commerce?.reference).toBeUndefined();
    expect(verified.commerce?.quantity).toBeUndefined();
    expect(verified.commerce?.requestedPrice).toBeUndefined();
    expect(verification.rejected.length).toBe(3);
  });

  it("a reference past what was shown asks instead of guessing", async () => {
    const group = SEMANTIC_GROUPS.find((g) => g.id === "select_first_in_M")!;
    const ir = { intent: "commerce_select", commerce: { intent: "select" as const, reference: { type: "previous_result" as const, index: 7 } } };
    const c = await runCase(group, "the eighth one", new ScriptedReasoner({ ...SETUP_SCRIPT, "the eighth one": ir }));
    expect(c.out.turn.selectedAction ?? undefined).toBeUndefined();
    expect(c.cart).toBeUndefined();
  });

  it("a payment claim with nothing to verify does nothing", async () => {
    const group = SEMANTIC_GROUPS.find((g) => g.id === "select_first_in_M")!;
    const c = await runCase(group, "I paid", new ScriptedReasoner({ ...SETUP_SCRIPT, "I paid": { intent: "payment_claim", customerClaims: { paymentCompleted: true } } }));
    expect(c.out.turn.selectedAction ?? undefined).toBeUndefined();
    expect(c.out.response).toMatch(/nothing for me to verify/i);
  });

  it("an unknown offer id from the model is dropped", () => {
    const { verified, verification } = verifyIR(graph, "x", { intent: "x", entities: {}, constraints: {}, customerInfo: {}, selectedOfferId: "offer-invented" }, state);
    expect(verified.selectedOfferId).toBeUndefined();
    expect(verification.rejected.map((r) => r.claim)).toContain("selectedOfferId");
  });
});

describe("universality: BARRY's core has no industry-specific behavior", () => {
  const SRC = path.join(__dirname, "..", "src", "lib");
  const OFFLINE_STAND_IN = new Set(["reasoner/mock-reasoner.ts", "reasoner/mock-commerce.ts", "reasoner/entities.ts"]);
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  }
  const core = walk(SRC)
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .filter((rel) => !rel.startsWith("fixtures/") && !OFFLINE_STAND_IN.has(rel));

  it.each(core)("%s names no industry", (rel) => {
    const text = fs.readFileSync(path.join(SRC, rel), "utf8");
    expect(text).not.toMatch(/\b(dress(es)?|wedding|spa|massage|fitness|furniture|garage|haircut|salon|fashion)\b|שמלה|חתונה|עיסוי/i);
  });

  it("the runtime, verifier and compiler never import the offline stand-in heuristics", () => {
    for (const rel of ["runtime/engine.ts", "runtime/compiler.ts", "reasoner/verify.ts", "reasoner/openai-reasoner.ts", "tools/definitions.ts"]) {
      const text = fs.readFileSync(path.join(SRC, rel), "utf8");
      expect(text, rel).not.toMatch(/from ["'](\.\/|@\/lib\/reasoner\/)(entities|mock-commerce|mock-reasoner)["']/);
    }
  });
});

const LIVE = Boolean(process.env.OPENAI_API_KEY && process.env.BARRY_LIVE_EVAL === "1");

describe.skipIf(!LIVE)("LIVE model: paraphrases reach the same grounded action (BARRY_LIVE_EVAL=1)", () => {
  it.each(ALL_PARAPHRASES.map((p) => [p.group.id, p.text, p]))(
    "[%s] %s",
    async (_id, text, p) => {
      const c = await runCase(p.group, text, new OpenAIReasoner());
      if (p.group.id === "replace_with_first") {
        // Only the understanding step is live; the size follow-up is covered by the scripted run.
        expect(c.out.turn.selectedAction?.name).toBe("addToCart");
        expect(c.out.turn.selectedAction?.input).toMatchObject({ productId: c.shown[0], replaceLine: expect.any(Object) });
        return;
      }
      await EXPECT[p.group.id](c);
    },
    60_000
  );
});
