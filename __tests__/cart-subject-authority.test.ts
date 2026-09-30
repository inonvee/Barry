import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { readLedger } from "@/lib/runtime/ledger";
import { groundCartSubject } from "@/lib/runtime/compiler";
import { setReasonerForTests, type BarryIR, type PolicyContradiction, type ReasonerContext } from "@/lib/reasoner";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import type { Cart, CommerceAdapter } from "@/lib/commerce/types";
import { getBackend } from "@/lib/store";
import { acceptConversation } from "@/lib/simulator-session";
import { createInitialConversationState } from "@/lib/state";
import type { BusinessGraph } from "@/lib/business-graph";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * EXACT CART SUBJECT + AUTHORITATIVE CART STATE (live High on c661224): "remove the Midnight, keep the
 * Onyx" removed Onyx, and a later checkout saw a cart (Midnight + Onyx, ₪810) the turn before had not.
 * Scripted model: the IR is what a model would produce; grounding, execution, ledger, provider and
 * payment are the real runtime. Not live proof.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  dispose?.();
  dispose = undefined;
});

const who = { customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } };
const MIDNIGHT = "Midnight Wrap Dress";
const ONYX = "Onyx Slip Dress";

function setup() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model, id: conv("cart") };
}

async function cartWith(model: ScriptedModel, g: BusinessGraph, id: string, items: { title: string; size: string }[]) {
  model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
  const search = await handleCustomerMessage(g, id, "c", "black dresses");
  const titles = search.rich?.products?.map((p) => p.title) ?? [];
  let last;
  for (const item of items) {
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: titles.indexOf(item.title) }, variant: { size: item.size }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
    last = await handleCustomerMessage(g, id, "c", `${item.title} ${item.size} to the cart`);
  }
  return last!;
}

const removeNamed = (subject: string, extra: Partial<BarryIR> = {}, reference?: { type: "cart_line"; index: number }): Partial<BarryIR> => ({
  commerce: { intent: "remove", subject, keep: [ONYX], ...(reference ? { reference } : {}) },
  advancesTransaction: true,
  checkoutConsent: false,
  ...extra,
});

const cartOf = async (commerce: CommerceAdapter, id: string) => (await commerce.getCart(id))!;

describe("explicit subject wins — the executor only mutates the grounded line for the named target", () => {
  it("CASE A: Midnight + Onyx, 'remove Midnight, leave Onyx' → Midnight removed, Onyx stays, ₪390, receipt subject = Midnight", async () => {
    const { g, commerce, model, id } = setup();
    const two = await cartWith(model, g, id, [{ title: MIDNIGHT, size: "M" }, { title: ONYX, size: "M" }]);
    const cartId = two.state.knownFields.__commerceCartId;
    expect((await cartOf(commerce, cartId)).total.amount).toBe(810);
    model.plan = () => removeNamed(MIDNIGHT);
    const out = await handleCustomerMessage(g, id, "c", "Remove Midnight and leave Onyx.");
    const cart = await cartOf(commerce, cartId);
    expect(cart.lines.map((l) => l.title)).toEqual([ONYX]);
    expect(cart.total.amount).toBe(390);
    const receipts = readLedger(out.state).filter((e) => e.operation === "updateCartLine");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ effect: "cart.line_removed", terms: { item: expect.stringContaining(MIDNIGHT), quantityBefore: 1, quantityAfter: 0 }, outcome: { cartAfter: `1 × ${ONYX} (M / black)`, cartTotalAfter: "₪390" } });
    expect(receipts[0].terms.item).not.toContain(ONYX);
    // Inspector facts: subject, grounded line, revision N → N+1.
    expect(out.turn.compiled?.cartSubject).toMatchObject({ named: MIDNIGHT, keep: [ONYX], basis: "subject", line: { title: MIDNIGHT } });
    const { revisionBefore, revisionAfter } = receipts[0].outcome as { revisionBefore: number; revisionAfter: number };
    expect(revisionAfter).toBe(revisionBefore + 1);
    expect(out.turn.trace?.context?.cart?.revision).toBe(revisionBefore);
  });

  it("CASE A (live inversion): the name says Midnight but the position points at Onyx → nothing is changed (conflict), never Onyx", async () => {
    const { g, commerce, model, id } = setup();
    const two = await cartWith(model, g, id, [{ title: MIDNIGHT, size: "M" }, { title: ONYX, size: "M" }]);
    model.plan = () => removeNamed(MIDNIGHT, {}, { type: "cart_line", index: 1 });
    const out = await handleCustomerMessage(g, id, "c", "Remove Midnight and leave Onyx.");
    expect((await cartOf(commerce, two.state.knownFields.__commerceCartId)).lines.map((l) => l.title).sort()).toEqual([MIDNIGHT, ONYX]);
    expect(out.turn.trace?.steps ?? []).toEqual([]);
    expect(out.turn.compiled?.cartSubject?.basis).toBe("conflict");
  });

  it("CASE B: Onyx only, 'remove Midnight, leave Onyx' → no mutation of Onyx, no claim Midnight was removed, reply grounded in the real cart", async () => {
    const { g, commerce, model, id } = setup();
    const one = await cartWith(model, g, id, [{ title: ONYX, size: "M" }]);
    const cartId = one.state.knownFields.__commerceCartId;
    model.plan = () => removeNamed(MIDNIGHT);
    // A model that would narrate the removal anyway: the guard / deterministic reply must not let it through.
    model.write = (input) => (input.outcome.kind === "cart_subject_unresolved" ? `“${MIDNIGHT}” isn't in your cart right now — your cart has: ${ONYX}. I didn't change anything.` : "I removed the Midnight.");
    const out = await handleCustomerMessage(g, id, "c", "Remove Midnight and leave Onyx.");
    const cart = await cartOf(commerce, cartId);
    expect(cart.lines.map((l) => l.title)).toEqual([ONYX]);
    expect(cart.total.amount).toBe(390);
    expect(out.turn.trace?.steps ?? []).toEqual([]);
    expect(readLedger(out.state).filter((e) => e.operation === "updateCartLine")).toHaveLength(0);
    expect(out.turn.compiled?.cartSubject).toMatchObject({ basis: "not_in_cart", named: MIDNIGHT });
    expect(out.response).not.toMatch(/removed/i);
    expect(out.response).toContain(ONYX);
  });

  it("the only line is never the fallback target when the customer said to keep it", () => {
    const g = groundCartSubject({ intent: "remove", keep: [ONYX] }, {}, { cartLines: [{ position: 1, id: "l1", title: ONYX, options: { size: "M" }, quantity: 1 }] });
    expect(g.basis).toBe("keep");
  });

  it("an unreadable cart + a named target changes nothing (no 'last line BARRY touched')", () => {
    const g = groundCartSubject({ intent: "remove", subject: MIDNIGHT }, { __commerceCartLineId: "line_onyx" }, {});
    expect(g).toMatchObject({ basis: "unreadable" });
    expect(g.line).toBeUndefined();
  });

  it("CASE F: two lines of one product (M and L) — the bare name is ambiguous (no write); the size narrows it to exactly one line", async () => {
    const { g, commerce, model, id } = setup();
    const two = await cartWith(model, g, id, [{ title: MIDNIGHT, size: "M" }, { title: MIDNIGHT, size: "L" }]);
    const cartId = two.state.knownFields.__commerceCartId;
    expect((await cartOf(commerce, cartId)).lines).toHaveLength(2);
    model.plan = () => ({ commerce: { intent: "remove", subject: MIDNIGHT }, advancesTransaction: true, checkoutConsent: false });
    const ambiguous = await handleCustomerMessage(g, id, "c", "remove the Midnight");
    expect(ambiguous.turn.compiled?.cartSubject?.basis).toBe("ambiguous");
    expect((await cartOf(commerce, cartId)).lines).toHaveLength(2);
    model.plan = () => ({ commerce: { intent: "remove", subject: MIDNIGHT, variant: { size: "L" } }, advancesTransaction: true, checkoutConsent: false });
    await handleCustomerMessage(g, id, "c", "remove the Midnight in L");
    const left = (await cartOf(commerce, cartId)).lines;
    expect(left.map((l) => `${l.title} ${l.options.size}`)).toEqual([`${MIDNIGHT} M`]);
  });

  it("name matching is structural, not a language rule: a name that isn't in any line never grounds (e.g. a transliteration)", () => {
    const lines = [{ position: 1, id: "a", title: MIDNIGHT, options: { size: "M" }, quantity: 1 }, { position: 2, id: "b", title: ONYX, options: { size: "M" }, quantity: 1 }];
    expect(groundCartSubject({ intent: "remove", subject: "מידנייט" }, {}, { cartLines: lines }).basis).toBe("not_in_cart");
    expect(groundCartSubject({ intent: "remove", subject: "midnight" }, {}, { cartLines: lines }).line?.id).toBe("a");
    expect(groundCartSubject({ intent: "remove", subject: "Wrap Dress" }, {}, { cartLines: lines }).line?.id).toBe("a");
    expect(groundCartSubject({ intent: "remove", subject: "Dress" }, {}, { cartLines: lines }).basis).toBe("ambiguous");
  });
});

describe("CASE C: mixed intent — exact cart behaviour AND the policy answer", () => {
  class PolicyModel extends ScriptedModel {
    async checkPolicyConsistency(_c: ReasonerContext, reply: string, policies: { topic: string; text: string }[]): Promise<PolicyContradiction[]> {
      return /cannot be exchanged/.test(reply) ? [{ sentence: reply, policy: policies[0].text, why: "prohibition" }] : [];
    }
    async checkAskCoverage(_c: ReasonerContext, reply: string, asks: { kind: string }[]): Promise<number[]> {
      return asks.flatMap((a, i) => (a.kind === "question" && !/exchang/i.test(reply) ? [i] : []));
    }
  }
  const asks = [
    { ask: "remove the Midnight, keep the Onyx", kind: "change" as const, coveredByThisIR: true },
    { ask: "can sale items be exchanged?", kind: "question" as const, coveredByThisIR: false, topic: "returns" },
  ];

  it("both items present: Midnight removed, Onyx kept, ₪390, and the exchange-only policy is answered", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new PolicyModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("mixed");
    const two = await cartWith(model, r.g, id, [{ title: MIDNIGHT, size: "M" }, { title: ONYX, size: "M" }]);
    model.plan = () => removeNamed(MIDNIGHT, { asks });
    model.write = () => "I removed the Midnight. Sale items cannot be exchanged.";
    const out = await handleCustomerMessage(r.g, id, "c", "תוציאי את ה-Midnight מהסל ותשאירי את ה-Onyx, וגם אפשר להחליף פריטי סייל?");
    const cart = (await r.commerce.getCart(two.state.knownFields.__commerceCartId))!;
    expect(cart.lines.map((l) => l.title)).toEqual([ONYX]);
    expect(out.response).toContain("Sale items can be exchanged only.");
    expect(out.response).toMatch(/390/);
    expect(out.response).not.toMatch(/cannot be exchanged/);
    expect(out.turn.trace?.asks?.map((a) => a.status)).toEqual(["completed", "answered"]);
  });

  it("Midnight absent: nothing removed, the reply says so, and the policy is still answered", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new PolicyModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("mixed-absent");
    const one = await cartWith(model, r.g, id, [{ title: ONYX, size: "M" }]);
    model.plan = () => removeNamed(MIDNIGHT, { asks });
    model.write = () => "I removed the Midnight.";
    const out = await handleCustomerMessage(r.g, id, "c", "Remove Midnight, keep Onyx — and can sale items be exchanged?");
    expect((await r.commerce.getCart(one.state.knownFields.__commerceCartId))!.lines.map((l) => l.title)).toEqual([ONYX]);
    expect(out.response).not.toMatch(/removed the Midnight/i);
    expect(out.response).toContain("Sale items can be exchanged only.");
    expect(out.turn.trace?.asks?.map((a) => a.status)).toEqual(["needs_info", "answered"]);
  });
});

describe("authoritative cart state: one current revision for every reader, in every process", () => {
  it("CASE D: Midnight + Onyx (₪810) → remove Midnight → checkout → the payment is ₪390, never ₪810", async () => {
    const { g, model, id } = setup();
    await cartWith(model, g, id, [{ title: MIDNIGHT, size: "M" }, { title: ONYX, size: "M" }]);
    model.plan = () => removeNamed(MIDNIGHT);
    await handleCustomerMessage(g, id, "c", "Remove Midnight and leave Onyx.");
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const out = await handleCustomerMessage(g, id, "c", "Checkout please. Adi 0505550114");
    const payment = await getBackend().getPaymentRequest(out.state.knownFields.__paymentRequestId);
    expect(payment?.amount).toBe(390);
  });

  it("CASE D across serverless instances: a process still holding the OLD cart (₪810, revision N) is reinstated to revision N+1 before checkout → ₪390", async () => {
    const { g, commerce, model, id } = setup();
    const two = await cartWith(model, g, id, [{ title: MIDNIGHT, size: "M" }, { title: ONYX, size: "M" }]);
    const cartId = two.state.knownFields.__commerceCartId;
    // Instance B: same simulator catalog, but it last saw the cart BEFORE the removal.
    const instanceB = new MemoryCommerceAdapter(fashionCatalog());
    await instanceB.restoreCart((await commerce.getCart(cartId))!);
    model.plan = () => removeNamed(MIDNIGHT);
    await handleCustomerMessage(g, id, "c", "Remove Midnight and leave Onyx."); // runs on instance A
    // The next requests land on instance B (the live pathology).
    registerCommerceAdapterFactoryForTests(g.business.id, () => instanceB);
    expect((await instanceB.getCart(cartId))!.total.amount).toBe(810);
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const out = await handleCustomerMessage(g, id, "c", "Checkout please. Adi 0505550114");
    expect(out.turn.trace?.context?.cart?.lines.map((l) => l.title)).toEqual([ONYX]);
    const payment = await getBackend().getPaymentRequest(out.state.knownFields.__paymentRequestId);
    expect(payment?.amount).toBe(390);
  });

  it("a cold instance that has never seen the cart reads the durable post-effect cart — it never starts a new, different cart", async () => {
    const { g, model, id } = setup();
    const two = await cartWith(model, g, id, [{ title: MIDNIGHT, size: "M" }, { title: ONYX, size: "M" }]);
    const cartId = two.state.knownFields.__commerceCartId;
    const cold = new MemoryCommerceAdapter(fashionCatalog());
    registerCommerceAdapterFactoryForTests(g.business.id, () => cold);
    model.plan = () => removeNamed(MIDNIGHT);
    const out = await handleCustomerMessage(g, id, "c", "Remove Midnight and leave Onyx.");
    expect(out.state.knownFields.__commerceCartId).toBe(cartId);
    expect((await cold.getCart(cartId))!.lines.map((l) => l.title)).toEqual([ONYX]);
  });

  it("CASE E (provider): a read OLDER than the recorded revision is refused — no payment is built on a stale cart", async () => {
    const { g, commerce, model, id } = setup();
    const two = await cartWith(model, g, id, [{ title: MIDNIGHT, size: "M" }, { title: ONYX, size: "M" }]);
    const cartId = two.state.knownFields.__commerceCartId;
    const stale: Cart = (await commerce.getCart(cartId))!;
    model.plan = () => removeNamed(MIDNIGHT);
    await handleCustomerMessage(g, id, "c", "Remove Midnight and leave Onyx.");
    // A provider (not a restorable simulator) that serves a lagging copy of the cart.
    const lagging: CommerceAdapter = Object.assign(Object.create(Object.getPrototypeOf(commerce)), commerce, { restoreCart: undefined, getCart: async (cid: string) => (cid === cartId ? structuredClone(stale) : commerce.getCart(cid)) });
    registerCommerceAdapterFactoryForTests(g.business.id, () => lagging);
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const out = await handleCustomerMessage(g, id, "c", "Checkout please. Adi 0505550114");
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
    const payments = (await getBackend().listPaymentRequests(g.business.id)).filter((p) => p.conversationId === id);
    expect(payments).toEqual([]);
  });

  it("CASE E (UI): a delayed response can't overwrite a newer conversation state, nor land in another business", () => {
    const at = { businessId: "fashion-retailer", conversationId: "c1" };
    const newer = { ...createInitialConversationState("c1", "fashion-retailer", "x"), turns: [{}, {}] as never[], updatedAt: "2026-01-01T00:00:02Z" };
    const older = { ...newer, turns: [{}] as never[], updatedAt: "2026-01-01T00:00:01Z" };
    const held = { ...at, state: newer };
    expect(acceptConversation(held, at, older)).toBe(false);
    expect(acceptConversation(held, at, { ...newer, turns: [{}, {}, {}] as never[] })).toBe(true);
    expect(acceptConversation(held, at, { ...newer, businessId: "barry-logistics-demo" })).toBe(false);
    expect(acceptConversation(held, { businessId: "barry-logistics-demo", conversationId: "c1" }, older)).toBe(false);
  });
});
