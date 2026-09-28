import { handleCustomerMessage } from "@/lib/runtime";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { setReasonerForTests, type BarryIR, type Reasoner } from "@/lib/reasoner";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import type { Product } from "@/lib/commerce/types";
import type { BusinessGraph } from "@/lib/business-graph";
import type { TurnOutcome } from "@/lib/runtime/engine";
import { ScriptedReasoner } from "./semantic-corpus";

/**
 * REFERENCE / DECISION semantics corpus — real BARRY behavior, not single
 * sentences. Each case sets up real state (what BARRY showed, what's in
 * the cart, an open payment) with scripted turns, then evaluates ONE
 * customer message under the reasoner being tested, through the whole
 * pipeline (grounding -> compiler -> policy -> provider).
 *
 * `competentIr` is what a good model emits; running the corpus with it
 * proves BARRY's pipeline turns correct understanding into the correct
 * outcome. It proves NOTHING about any real model — only the live runner
 * (BARRY_LIVE_EVAL=1) measures that.
 */

const variant = (id: string, size: string, price: number, available = 3) => ({
  id,
  sku: id.toUpperCase(),
  title: size,
  options: { size },
  price: { amount: price, currency: "ILS" },
  inventory: { available },
});

/** Three clearly different items, every size in stock, deterministic order. */
export function evalCatalog(): Product[] {
  const make = (id: string, title: string, price: number): Product => ({
    id,
    title,
    description: `${title}.`,
    category: "dress",
    attributes: { color: "black" },
    media: [],
    variants: [variant(`${id}-s`, "S", price), variant(`${id}-m`, "M", price), variant(`${id}-l`, "L", price)],
  });
  return [make("p-aria", "Aria Dress", 300), make("p-bea", "Bea Dress", 350), make("p-cleo", "Cleo Dress", 390)];
}

export type Setup = "one_shown" | "three_shown" | "cart_first_M" | "cart_second_M" | "checkout_pending";

const SEARCH_ONE = "__setup: one under 320";
const SEARCH_THREE = "__setup: black dresses";
const ADD_FIRST_M = "__setup: add first in M";
const ADD_SECOND_M = "__setup: add second in M";
const TAKE_ONE_M = "__setup: take it in M";

export const SETUP_IR: Record<string, Partial<BarryIR>> = {
  [SEARCH_ONE]: { intent: "search", commerce: { intent: "search", query: { text: "dress", category: "dress", budget: { amount: 320 } } } },
  [SEARCH_THREE]: { intent: "search", commerce: { intent: "search", query: { text: "black dresses", category: "dress", attributes: { color: "black" } } } },
  [ADD_FIRST_M]: { intent: "select", purchaseDecision: false, commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } } },
  [ADD_SECOND_M]: { intent: "select", purchaseDecision: false, commerce: { intent: "select", reference: { type: "previous_result", index: 1 }, variant: { size: "M" } } },
  [TAKE_ONE_M]: { intent: "select", purchaseDecision: true, commerce: { intent: "select", variant: { size: "M" } } },
};

const SETUPS: Record<Setup, string[]> = {
  one_shown: [SEARCH_ONE],
  three_shown: [SEARCH_THREE],
  cart_first_M: [SEARCH_THREE, ADD_FIRST_M],
  cart_second_M: [SEARCH_THREE, ADD_SECOND_M],
  checkout_pending: [SEARCH_ONE, TAKE_ONE_M],
};

export type Expectation = {
  /** The action the customer's message must trigger (first step); null = no action. */
  action: string | null;
  /** The product that action must target: 1-based position among what BARRY showed. */
  productPosition?: number;
  variant?: Record<string, string>;
  /** BARRY must ask which item (and do nothing). */
  clarify?: boolean;
  purchaseDecision?: true | false | "not_true";
  /** No checkout / payment link may be created this turn. */
  noCheckout?: boolean;
  /** The turn must end on this outcome kind. */
  outcome?: string;
};

export type ReferenceCase = {
  id: string;
  group: "single_reference" | "multiple_references" | "ambiguous" | "purchase_decision" | "change_of_mind" | "payment_claim" | "negotiation" | "live_regression";
  setup: Setup;
  text: string;
  expect: Expectation;
  competentIr: Partial<BarryIR>;
};

const sel = (c: Partial<NonNullable<BarryIR["commerce"]>>, decision?: boolean): Partial<BarryIR> => ({
  intent: "select",
  ...(decision !== undefined ? { purchaseDecision: decision } : {}),
  commerce: { intent: "select", ...c },
});
const at = (position: number) => ({ reference: { type: "previous_result" as const, index: position - 1 } });

export const REFERENCE_CASES: ReferenceCase[] = [
  // ── one shown result: a pronoun is unambiguous ────────────────────────
  ...[
    "אני אקח אותה במדיום",
    "יאללה קח אותה M",
    "אני רוצה אותה במידה M",
    "I'll take it in medium",
    "give me that one in M",
  ].map((text, i): ReferenceCase => ({
    id: `single-${i}`,
    group: "single_reference",
    setup: "one_shown",
    text,
    expect: { action: "addToCart", productPosition: 1, variant: { size: "M" }, purchaseDecision: true },
    competentIr: sel({ variant: { size: "M" } }, true),
  })),
  {
    id: "single-add-no-decision",
    group: "single_reference",
    setup: "one_shown",
    text: "תוסיף לי את זה ב-M",
    expect: { action: "addToCart", productPosition: 1, variant: { size: "M" } },
    competentIr: sel({ variant: { size: "M" } }),
  },
  // The exact live failure shape: the model filed "I'll take it" as checkout on an empty cart.
  {
    id: "live-regression-cartless-checkout",
    group: "live_regression",
    setup: "one_shown",
    text: "אני אקח אותה במדיום (checkout-shaped IR)",
    expect: { action: "addToCart", productPosition: 1, variant: { size: "M" } },
    competentIr: { intent: "completePurchase", purchaseDecision: true, commerce: { intent: "checkout", variant: { size: "M" } } },
  },
  // ── several shown results: ordinals / positions ───────────────────────
  { id: "multi-second", group: "multiple_references", setup: "three_shown", text: "אני אקח את השנייה במידה M", expect: { action: "addToCart", productPosition: 2, variant: { size: "M" } }, competentIr: sel({ ...at(2), variant: { size: "M" } }, true) },
  { id: "multi-first", group: "multiple_references", setup: "three_shown", text: "the first one, size M", expect: { action: "addToCart", productPosition: 1, variant: { size: "M" } }, competentIr: sel({ ...at(1), variant: { size: "M" } }) },
  { id: "multi-last", group: "multiple_references", setup: "three_shown", text: "עזוב תביא את האחרונה ב-M", expect: { action: "addToCart", productPosition: 3, variant: { size: "M" } }, competentIr: sel({ ...at(3), variant: { size: "M" } }, true) },
  // ── genuinely ambiguous: ask, never guess ─────────────────────────────
  { id: "ambiguous-pronoun", group: "ambiguous", setup: "three_shown", text: "אני אקח אותה", expect: { action: null, clarify: true, noCheckout: true }, competentIr: sel({}, true) },
  { id: "ambiguous-en", group: "ambiguous", setup: "three_shown", text: "I'll take that one", expect: { action: null, clarify: true, noCheckout: true }, competentIr: sel({}, true) },
  // ── purchase decision distinctions ────────────────────────────────────
  { id: "decision-admire", group: "purchase_decision", setup: "one_shown", text: "היא יפה", expect: { action: null, purchaseDecision: "not_true", noCheckout: true }, competentIr: { intent: "compliment" } },
  { id: "decision-availability-q", group: "purchase_decision", setup: "one_shown", text: "יש אותה ב-M?", expect: { action: null, purchaseDecision: "not_true", noCheckout: true, outcome: "product_info" }, competentIr: { intent: "inquire", purchaseDecision: false, commerce: { intent: "inquire", variant: { size: "M" } } } },
  { id: "decision-still-browsing", group: "purchase_decision", setup: "one_shown", text: "תוסיף אותה לעגלה במידה M אבל אני עוד מסתכלת", expect: { action: "addToCart", productPosition: 1, purchaseDecision: false, noCheckout: true }, competentIr: sel({ variant: { size: "M" } }, false) },
  { id: "decision-decided", group: "purchase_decision", setup: "one_shown", text: "יאללה אני לוקחת אותה ב-M", expect: { action: "addToCart", productPosition: 1, purchaseDecision: true }, competentIr: sel({ variant: { size: "M" } }, true) },
  // ── change of mind against real cart/result state ─────────────────────
  { id: "change-to-second", group: "change_of_mind", setup: "cart_first_M", text: "בעצם תחליף לשנייה במידה M", expect: { action: "addToCart", productPosition: 2, variant: { size: "M" } }, competentIr: { intent: "replace", commerce: { intent: "replace", ...at(2), variant: { size: "M" } } } },
  { id: "change-back-to-first", group: "change_of_mind", setup: "cart_second_M", text: "לא רגע את הראשונה, M", expect: { action: "addToCart", productPosition: 1, variant: { size: "M" } }, competentIr: { intent: "replace", commerce: { intent: "replace", ...at(1), variant: { size: "M" } } } },
  { id: "change-size", group: "change_of_mind", setup: "cart_first_M", text: "make it L instead", expect: { action: "updateCartLine", variant: { size: "L" } }, competentIr: { intent: "change_variant", commerce: { intent: "change_variant", reference: { type: "cart_line", index: 0 }, variant: { size: "L" } } } },
  // ── payment claims are verified, never believed ───────────────────────
  { id: "paid-he", group: "payment_claim", setup: "checkout_pending", text: "שילמתי", expect: { action: "verifyPayment" }, competentIr: { intent: "payment_claim", customerClaims: { paymentCompleted: true } } },
  { id: "paid-en", group: "payment_claim", setup: "checkout_pending", text: "I paid already", expect: { action: "verifyPayment" }, competentIr: { intent: "payment_claim", customerClaims: { paymentCompleted: true } } },
  // ── negotiation goes to policy, never a random discount ───────────────
  { id: "negotiate-350", group: "negotiation", setup: "cart_first_M", text: "יש מצב 350?", expect: { action: null, outcome: "price_request", noCheckout: true }, competentIr: { intent: "negotiate", commerce: { intent: "negotiate_price", requestedPrice: { amount: 350 } } } },
];

export type CaseResult = {
  id: string;
  group: ReferenceCase["group"];
  text: string;
  pass: boolean;
  failures: string[];
  referenceChecked: boolean;
  referenceCorrect: boolean;
  decisionChecked: boolean;
  decisionCorrect: boolean;
  falseAction: boolean;
  unsupportedReference: boolean;
  structuredValid: boolean;
  latencyMs?: number;
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens: number };
};

const CONSEQUENTIAL = new Set(["addToCart", "updateCartLine", "createCommerceCheckout", "createCommerceOrder", "createPaymentRequest", "createBooking"]);

/** Wraps a reasoner so the setup turns are scripted and only the evaluated turn uses the reasoner under test. */
class EvalReasoner implements Reasoner {
  readonly name: "mock" | "llm";
  lastTelemetry?: { valid: boolean; latencyMs: number; usage: CaseResult["usage"] };
  private readonly setup = new ScriptedReasoner(SETUP_IR);
  constructor(private readonly underTest: Reasoner & { understandDetailed?: (ctx: Parameters<Reasoner["understand"]>[0]) => Promise<{ ir: BarryIR; valid: boolean; latencyMs: number; usage: NonNullable<CaseResult["usage"]> }> }, private readonly evaluated: string) {
    this.name = underTest.name;
  }
  get model() {
    return this.underTest.model;
  }
  async understand(ctx: Parameters<Reasoner["understand"]>[0]): Promise<BarryIR> {
    if (ctx.customerMessage !== this.evaluated) return this.setup.understand(ctx);
    if (this.underTest.understandDetailed) {
      const r = await this.underTest.understandDetailed(ctx);
      this.lastTelemetry = { valid: r.valid, latencyMs: r.latencyMs, usage: r.usage };
      return r.ir;
    }
    return this.underTest.understand(ctx);
  }
  composeResponse(ctx: Parameters<Reasoner["composeResponse"]>[0], input: Parameters<Reasoner["composeResponse"]>[1]) {
    return this.setup.composeResponse(ctx, input); // deterministic wording: evals judge understanding + outcome
  }
}

let seq = 0;

export async function runReferenceCase(c: ReferenceCase, reasonerUnderTest: Reasoner): Promise<CaseResult> {
  const id = `ref-eval-${seq++}-${Date.now()}`;
  const adapter = new MemoryCommerceAdapter(evalCatalog());
  registerCommerceAdapterFactoryForTests(id, () => adapter);
  setPaymentAdapterForTests(new MemoryPaymentAdapter());
  const base = buildFashionRetailerGraph();
  const graph: BusinessGraph = {
    ...base,
    business: { ...base.business, id },
    playbook: { ...base.playbook, commerce: { ...base.playbook.commerce, checkoutRequires: [] } },
  };
  const reasoner = new EvalReasoner(reasonerUnderTest, c.text);
  setReasonerForTests(reasoner);
  const conv = `conv-${id}`;
  try {
    let last: TurnOutcome | undefined;
    for (const turn of SETUPS[c.setup]) last = await handleCustomerMessage(graph, conv, `c-${id}`, turn);
    const shown = (last?.state.knownFields.__commerceLastProductIds ?? "").split(",").filter(Boolean);
    const paymentBefore = last?.state.knownFields.__paymentRequestId;
    const out = await handleCustomerMessage(graph, conv, `c-${id}`, c.text);
    // What the customer-triggered action actually targeted: its own input when
    // it was the only step, else the provider cart line it produced.
    let target: { productId?: string; options?: Record<string, string> } | undefined;
    const steps = out.turn.trace?.steps ?? [];
    if (steps.length === 1) target = out.turn.selectedAction?.input as typeof target;
    else if (steps.length > 1) {
      const cart = await adapter.getCart(out.state.knownFields.__commerceCartId ?? "");
      const line = cart?.lines.find((l) => l.id === out.state.knownFields.__commerceCartLineId);
      target = line ? { productId: line.productId, options: line.options } : undefined;
    }
    return grade(c, out, shown, paymentBefore, reasoner.lastTelemetry, target);
  } finally {
    setReasonerForTests(undefined);
    setPaymentAdapterForTests(undefined);
    registerCommerceAdapterFactoryForTests(id, undefined);
  }
}

function grade(
  c: ReferenceCase,
  out: TurnOutcome,
  shown: string[],
  paymentBefore: string | undefined,
  telemetry: EvalReasoner["lastTelemetry"],
  input: { productId?: string; options?: Record<string, string> } | undefined
): CaseResult {
  const failures: string[] = [];
  const steps = out.turn.trace?.steps ?? [];
  const actionName = steps[0]?.action ?? null;

  if (actionName !== c.expect.action) failures.push(`action ${actionName ?? "none"} (expected ${c.expect.action ?? "none"})`);

  let referenceChecked = false;
  let referenceCorrect = true;
  if (c.expect.productPosition !== undefined) {
    referenceChecked = true;
    const expectedId = shown[c.expect.productPosition - 1];
    const actualId = input?.productId;
    referenceCorrect = actualId === expectedId;
    if (!referenceCorrect) failures.push(`product ${actualId ?? "none"} (expected position ${c.expect.productPosition} = ${expectedId})`);
  }
  if (c.expect.clarify) {
    referenceChecked = true;
    referenceCorrect = out.turn.trace?.stop.outcome === "clarify_reference" && steps.length === 0;
    if (!referenceCorrect) failures.push(`expected to ask which item, got ${out.turn.trace?.stop.outcome}`);
  }
  if (c.expect.variant && input?.options) {
    for (const [k, v] of Object.entries(c.expect.variant)) {
      if (input.options[k]?.toLowerCase() !== v.toLowerCase()) failures.push(`variant ${k}=${input.options[k]} (expected ${v})`);
    }
  }
  let decisionChecked = false;
  let decisionCorrect = true;
  if (c.expect.purchaseDecision !== undefined) {
    decisionChecked = true;
    const got = out.turn.understood.purchaseDecision;
    decisionCorrect = c.expect.purchaseDecision === "not_true" ? got !== true : got === c.expect.purchaseDecision;
    if (!decisionCorrect) failures.push(`purchaseDecision ${String(got)} (expected ${String(c.expect.purchaseDecision)})`);
  }
  const newPayment = out.state.knownFields.__paymentRequestId && out.state.knownFields.__paymentRequestId !== paymentBefore;
  if (c.expect.noCheckout && (newPayment || steps.some((s) => s.action === "createCommerceCheckout"))) failures.push("created a checkout/payment link");
  if (c.expect.outcome && out.turn.trace?.stop.outcome !== c.expect.outcome) failures.push(`outcome ${out.turn.trace?.stop.outcome} (expected ${c.expect.outcome})`);
  if (out.state.knownFields.__paid) failures.push("marked paid from the conversation");

  const falseAction = steps.some((s) => CONSEQUENTIAL.has(s.action) && s.trigger === "customer" && s.action !== c.expect.action);
  const unsupportedReference =
    (out.turn.trace?.stop.outcome === "clarify_reference" && !c.expect.clarify) ||
    (out.turn.trace?.rejectedClaims ?? []).some((r) => r.claim === "commerce.reference");
  const structuredValid = telemetry ? telemetry.valid : true;
  if (!structuredValid) failures.push("structured output invalid");

  return {
    id: c.id,
    group: c.group,
    text: c.text,
    pass: failures.length === 0,
    failures,
    referenceChecked,
    referenceCorrect,
    decisionChecked,
    decisionCorrect,
    falseAction,
    unsupportedReference,
    structuredValid,
    latencyMs: telemetry?.latencyMs,
    usage: telemetry?.usage,
  };
}

export function summarise(results: CaseResult[]) {
  const n = results.length;
  const rate = (k: number, d: number) => (d === 0 ? "—" : `${Math.round((k / d) * 100)}%`);
  const refs = results.filter((r) => r.referenceChecked);
  const decisions = results.filter((r) => r.decisionChecked);
  const lat = results.map((r) => r.latencyMs).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  const tokens = results.reduce(
    (acc, r) => ({ prompt: acc.prompt + (r.usage?.promptTokens ?? 0), completion: acc.completion + (r.usage?.completionTokens ?? 0), reasoning: acc.reasoning + (r.usage?.reasoningTokens ?? 0) }),
    { prompt: 0, completion: 0, reasoning: 0 }
  );
  return {
    cases: n,
    semanticCorrectness: rate(results.filter((r) => r.pass).length, n),
    referenceResolution: rate(refs.filter((r) => r.referenceCorrect).length, refs.length),
    purchaseDecisionCorrect: rate(decisions.filter((r) => r.decisionCorrect).length, decisions.length),
    falseActionRate: rate(results.filter((r) => r.falseAction).length, n),
    unsupportedReferenceRate: rate(results.filter((r) => r.unsupportedReference).length, n),
    structuredOutputValidity: rate(results.filter((r) => r.structuredValid).length, n),
    latencyP50Ms: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    latencyP90Ms: lat.length ? lat[Math.floor(lat.length * 0.9)] : null,
    tokens,
  };
}
