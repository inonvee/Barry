import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "@/lib/fabric";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { readLedger } from "@/lib/runtime/ledger";
import { readHandoffs } from "@/lib/runtime/handoff";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { getBusinessGraph } from "@/lib/fixtures";
import { getBackend } from "@/lib/store";
import type { PaymentRequestRecord } from "@/lib/store/types";
import type { BusinessGraph } from "@/lib/business-graph";
import { revenueEvidence, revenueSummary } from "@/lib/owner/revenue";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { askOwnerBarry, briefingText } from "@/lib/owner/ask";
import { assessCapabilities, deriveCapabilities, type CapabilityInput } from "@/lib/owner/capabilities";
import { assessPilotReadiness } from "@/lib/owner/readiness";
import { SetupPlan } from "@/components/owner/train-plan";
import { ScriptedModel, approvalsOf, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * FOCUSED LIVE-BLOCKER REPAIR after the work acceptance on b5edc2e (2 High, 3 Medium). The IR is what
 * a model would produce; grounding, compilation, authority, execution, ledger, provider, owner read
 * models and rendering are the real runtime. Deterministic — not live proof.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  dispose?.();
  dispose = undefined;
});

const MIDNIGHT = "Midnight Wrap Dress";
const ONYX = "Onyx Slip Dress";
const who = { customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } };

function setup() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model, id: conv("blocker") };
}

/** Midnight M ×quantity in the cart, after a search that showed ONLY Midnight (Onyx never shown). */
async function midnightOnly(model: ScriptedModel, g: BusinessGraph, id: string, quantity = 3) {
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  const search = await handleCustomerMessage(g, id, "c", "the midnight dress");
  expect(search.rich?.products?.map((p) => p.title)).toEqual([MIDNIGHT]);
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" }, quantity }, purchaseDecision: false, checkoutConsent: undefined, advancesTransaction: true });
  return handleCustomerMessage(g, id, "c", `add ${quantity} Midnight dresses in M to the cart`);
}

const addNamed = (subject: string, extra: Partial<BarryIR> = {}, variant: Record<string, string> | null = { size: "M" }, quantity = 1): Partial<BarryIR> => ({
  commerce: { intent: "select", subject, ...(variant ? { variant } : {}), quantity },
  purchaseDecision: false,
  checkoutConsent: false,
  advancesTransaction: true,
  ...extra,
});

// ── HIGH 1: a NAMED item to add binds to that product, never to the cart's current item ──────────

describe("HIGH 1 — a named add-to-cart subject is bound to exactly that catalog product", () => {
  it("Midnight ×3 in the cart, 'add Onyx in M' (Onyx never shown) → Onyx M added, Midnight unchanged; ledger, provider and reply all say Onyx", async () => {
    const { g, commerce, model, id } = setup();
    const before = await midnightOnly(model, g, id);
    const cartId = before.state.knownFields.__commerceCartId;
    const ledgerBefore = readLedger(before.state).length;
    expect((await commerce.getCart(cartId))!.lines.map((l) => [l.title, l.quantity])).toEqual([[MIDNIGHT, 3]]);

    model.plan = () => addNamed("Onyx");
    const out = await handleCustomerMessage(g, id, "c", "And add an Onyx in M as well, please. I'm not ready to check out yet.");

    // Grounding: the name was looked up in the catalog and bound to Onyx — not to the pending/only/last product.
    expect(out.turn.compiled?.cartSubject).toMatchObject({ named: "Onyx", basis: "catalog", product: { title: ONYX } });
    const cart = (await commerce.getCart(cartId))!;
    expect(cart.lines.map((l) => [l.title, l.options.size, l.quantity])).toEqual([
      [MIDNIGHT, "M", 3],
      [ONYX, "M", 1],
    ]);
    const receipts = readLedger(out.state).slice(ledgerBefore).filter((e) => e.operation === "addToCart" || e.operation === "updateCartLine");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ effect: "cart.line_added", status: "effected", terms: { item: expect.stringContaining(ONYX) } });
    expect(String(receipts[0].terms.item)).not.toContain(MIDNIGHT);
    expect(readLedger(out.state).slice(ledgerBefore).some((e) => String(e.terms.item ?? "").includes(MIDNIGHT))).toBe(false);
    // Provider subject == ledger subject == reply subject; nothing about Midnight was added or changed.
    expect(out.response).toMatch(/Onyx Slip Dress/);
    expect(out.response).not.toMatch(/(added|put|שמתי).*Midnight/i);
    expect(out.response).not.toMatch(/Midnight Wrap Dress \(M/);
    // Cart intent + "not ready": no checkout anywhere.
    expect(out.state.knownFields.__commerceCheckoutRequested).toBeUndefined();
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(out.turn.trace?.stop.outcome).not.toBe("checkout_needs_info");
  });

  it("with Onyx among the shown results it binds by name to the shown product (never by position or pending choice)", async () => {
    const { g, commerce, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
    const search = await handleCustomerMessage(g, id, "c", "black dresses");
    expect(search.rich?.products?.map((p) => p.title)).toEqual([MIDNIGHT, ONYX]);
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, advancesTransaction: true });
    const first = await handleCustomerMessage(g, id, "c", "the Midnight in M");
    model.plan = () => addNamed("Onyx");
    const out = await handleCustomerMessage(g, id, "c", "add the Onyx in M too");
    expect(out.turn.compiled?.cartSubject).toMatchObject({ named: "Onyx", basis: "shown", product: { title: ONYX } });
    expect((await commerce.getCart(first.state.knownFields.__commerceCartId))!.lines.map((l) => l.title)).toEqual([MIDNIGHT, ONYX]);
  });

  it("named subject whose variant is ambiguous (Midnight: M and L in stock, none named) → nothing is written to any line", async () => {
    const { g, commerce, model, id } = setup();
    const before = await midnightOnly(model, g, id);
    const cartId = before.state.knownFields.__commerceCartId;
    model.plan = () => addNamed("Midnight", {}, null);
    const out = await handleCustomerMessage(g, id, "c", "add another Midnight too");
    expect(out.turn.compiled?.cartSubject).toMatchObject({ basis: "shown", product: { title: MIDNIGHT } });
    expect(out.turn.toolResult?.output).toMatchObject({ added: false, notAdded: { productTitle: MIDNIGHT, reason: "needs_variant" } });
    expect((await commerce.getCart(cartId))!.lines.map((l) => [l.title, l.quantity])).toEqual([[MIDNIGHT, 3]]);
    expect(readLedger(out.state).at(-1)).toMatchObject({ effect: "cart.not_changed" });
    expect(out.response).toMatch(/Midnight/);
    expect(out.response).toMatch(/M|L/);
  });

  it("a named item with exactly one in-stock variant resolves to it — Onyx with no size named is Onyx M, the only real option", async () => {
    const { g, commerce, model, id } = setup();
    const before = await midnightOnly(model, g, id);
    model.plan = () => addNamed("Onyx", {}, null);
    const out = await handleCustomerMessage(g, id, "c", "add an Onyx too");
    expect(out.turn.compiled?.cartSubject).toMatchObject({ basis: "catalog", product: { title: ONYX } });
    expect((await commerce.getCart(before.state.knownFields.__commerceCartId))!.lines.map((l) => [l.title, l.options.size])).toEqual([[MIDNIGHT, "M"], [ONYX, "M"]]);
  });

  it("named subject beyond stock (two Onyx M, one in stock) → no write at all; Midnight untouched; the reply is honest", async () => {
    const { g, commerce, model, id } = setup();
    const before = await midnightOnly(model, g, id);
    const cartId = before.state.knownFields.__commerceCartId;
    model.plan = () => addNamed("Onyx", {}, { size: "M" }, 2);
    const out = await handleCustomerMessage(g, id, "c", "add two Onyx in M");
    expect((await commerce.getCart(cartId))!.lines.map((l) => [l.title, l.quantity])).toEqual([[MIDNIGHT, 3]]);
    expect(out.turn.toolResult?.output).toMatchObject({ added: false });
    expect(out.response).not.toMatch(/added|שמתי/i);
  });

  it("named subject absent from the catalog → no write, no fallback to the cart's item, the customer hears it wasn't found", async () => {
    const { g, commerce, model, id } = setup();
    const before = await midnightOnly(model, g, id);
    const cartId = before.state.knownFields.__commerceCartId;
    const ledgerBefore = readLedger(before.state).length;
    model.plan = () => addNamed("Velvet Coat");
    const out = await handleCustomerMessage(g, id, "c", "add a Velvet Coat in M");
    expect(out.turn.trace?.stop).toEqual({ reason: "no_action", outcome: "cart_subject_unresolved" });
    expect(out.turn.compiled?.cartSubject).toMatchObject({ named: "Velvet Coat", basis: "not_in_catalog" });
    expect(readLedger(out.state).slice(ledgerBefore).filter((e) => e.operation === "addToCart" || e.operation === "updateCartLine")).toEqual([]);
    expect((await commerce.getCart(cartId))!.lines.map((l) => [l.title, l.quantity])).toEqual([[MIDNIGHT, 3]]);
    expect(out.response).toMatch(/couldn't find|didn't add|לא מצאתי/i);
    expect(out.response).toMatch(/Velvet Coat/);
  });

  it("a name that matches several products → nothing is added; the customer is asked which", async () => {
    const { g, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
    const search = await handleCustomerMessage(g, id, "c", "black dresses");
    expect(search.rich?.products?.map((p) => p.title)).toEqual([MIDNIGHT, ONYX]);
    model.plan = () => addNamed("Dress");
    const out = await handleCustomerMessage(g, id, "c", "add the dress in M");
    expect(out.turn.compiled?.cartSubject).toMatchObject({ basis: "ambiguous", candidates: [MIDNIGHT, ONYX] });
    expect(out.turn.trace?.stop.outcome).toBe("cart_subject_unresolved");
    expect(out.state.knownFields.__commerceCartId).toBeUndefined();
    expect(out.response).toMatch(/which one/i);
  });

  it("the named add is durable: the next request on a cold instance sees Midnight + Onyx, and a named removal touches only Onyx", async () => {
    const { g, model, id } = setup();
    const before = await midnightOnly(model, g, id);
    const cartId = before.state.knownFields.__commerceCartId;
    model.plan = () => addNamed("Onyx");
    await handleCustomerMessage(g, id, "c", "add an Onyx in M");
    const cold = new MemoryCommerceAdapter(fashionCatalog());
    registerCommerceAdapterFactoryForTests(g.business.id, () => cold);
    model.plan = () => ({ commerce: { intent: "remove", subject: "Onyx" }, checkoutConsent: false, advancesTransaction: true });
    const out = await handleCustomerMessage(g, id, "c", "remove the Onyx");
    expect(out.turn.trace?.context?.cart?.lines.map((l) => l.title)).toEqual([MIDNIGHT, ONYX]);
    expect((await cold.getCart(cartId))!.lines.map((l) => [l.title, l.quantity])).toEqual([[MIDNIGHT, 3]]);
    expect(readLedger(out.state).at(-1)).toMatchObject({ effect: "cart.line_removed", terms: { item: expect.stringContaining(ONYX) } });
  });
});

// ── HIGH 2: cart intent never starts checkout ───────────────────────────────────────────────────

describe("HIGH 2 — cart intent is not checkout intent", () => {
  it("'add three Midnight dresses to the cart' (no consent) → cart changed, checkout NOT requested, no details asked", async () => {
    const { g, model, id } = setup();
    const out = await midnightOnly(model, g, id);
    expect(out.turn.trace?.steps.map((s) => s.action)).toEqual(["addToCart"]);
    expect(out.state.knownFields.__commerceCheckoutRequested).toBeUndefined();
    expect(out.state.missingFields).toEqual([]);
    expect(out.turn.trace?.stop.outcome).not.toBe("checkout_needs_info");
    expect(out.response).not.toMatch(/name|phone|שם|טלפון/i);
  });

  it("a purchase decision the model reports on an add is only an OFFER of checkout — never progression", async () => {
    const { g, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "dresses");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" }, quantity: 3 }, purchaseDecision: true, checkoutConsent: undefined, advancesTransaction: true });
    const out = await handleCustomerMessage(g, id, "c", "add three Midnight dresses to the cart");
    expect(out.turn.trace?.stop).toEqual({ reason: "needs_customer", outcome: "offer_checkout" });
    expect(out.state.knownFields.__commerceCheckoutRequested).toBeUndefined();
    expect(out.state.missingFields).toEqual([]);
    expect(out.response).not.toMatch(/name|phone|שם|טלפון/i);
    expect(out.response).toMatch(/check out\??|לתשלום/i);
  });

  it("add + 'I'm not ready to check out yet' → no checkout, no offer; a later 'checkout now' begins it (details only then)", async () => {
    const { g, model, id } = setup();
    await midnightOnly(model, g, id);
    model.plan = () => addNamed("Onyx", { purchaseDecision: true, checkoutConsent: false });
    const notReady = await handleCustomerMessage(g, id, "c", "add an Onyx in M as well. I'm not ready to check out yet.");
    expect(notReady.state.knownFields.__commerceCheckoutRequested).toBeUndefined();
    expect(notReady.state.knownFields.__commerceCheckoutOffered).toBeUndefined();
    expect(notReady.turn.trace?.stop.outcome).not.toMatch(/checkout/);
    expect(notReady.response).not.toMatch(/name|phone|שם|טלפון/i);

    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true });
    const go = await handleCustomerMessage(g, id, "c", "ok, checkout now");
    expect(go.turn.trace?.stop).toEqual({ reason: "no_action", outcome: "checkout_needs_info" });
    expect(go.state.missingFields).toEqual(["name", "phone"]);

    model.plan = () => ({ advancesTransaction: true, ...who });
    const paid = await handleCustomerMessage(g, id, "c", "Adi, 0505550114");
    expect(paid.turn.trace?.steps.map((s) => s.action)).toEqual(["createCommerceCheckout"]);
    const payment = await getBackend().getPaymentRequest(paid.state.knownFields.__paymentRequestId);
    expect(payment?.amount).toBe(3 * 420 + 390);
  });

  it("a cart change with an informational ask answers the policy and never checks out", async () => {
    const { g, model, id } = setup();
    await midnightOnly(model, g, id);
    model.plan = () => ({ commerce: { intent: "change_quantity", subject: "Midnight", quantity: 2 }, knowledgeTopic: "returns", checkoutConsent: undefined, advancesTransaction: true, asks: [{ ask: "make it two Midnight", kind: "change", coveredByThisIR: true }, { ask: "can I return sale items?", kind: "question", topic: "returns", coveredByThisIR: false }] });
    const out = await handleCustomerMessage(g, id, "c", "make it two Midnight, and can I return sale items?");
    expect(out.turn.trace?.steps.map((s) => s.action)).toEqual(["updateCartLine"]);
    expect(out.state.knownFields.__commerceCheckoutRequested).toBeUndefined();
    expect(out.response).toMatch(/exchanged only|14 days/i);
    expect(out.response).not.toMatch(/name|phone|שם|טלפון/i);
  });

  it("explicit consent with the change still works: 'add it and check out' → checkout requested, details asked", async () => {
    const { g, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "dresses");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: true, checkoutConsent: true, advancesTransaction: true });
    const out = await handleCustomerMessage(g, id, "c", "add the Midnight in M and let's check out");
    expect(out.turn.trace?.steps.map((s) => s.action)).toEqual(["addToCart"]);
    expect(out.state.knownFields.__commerceCheckoutRequested).toBe("1");
    expect(out.turn.trace?.stop).toEqual({ reason: "needs_customer", outcome: "checkout_needs_info" });
  });
});

// ── MEDIUM 1: an above-limit discount is an owner approval with exact terms — never a handoff ─────

describe("MEDIUM 1 — discount above the automatic limit → owner approval with exact terms", () => {
  const askDiscount = (pct: number, handoff = true): Partial<BarryIR> => ({
    constraints: { discountPct: pct },
    advancesTransaction: true,
    ...(handoff ? { handoff: { reason: "the customer asked the owner to approve a discount", urgency: "normal" as const } } : {}),
    asks: [{ ask: `${pct}% off this dress`, kind: "change", coveredByThisIR: true }],
  });

  it("≤5%: granted by policy, no owner request, priced exactly, no handoff", async () => {
    const { g, model, id } = setup();
    await midnightOnly(model, g, id, 1);
    model.plan = () => askDiscount(5, false);
    const out = await handleCustomerMessage(g, id, "c", "any chance of 5% off?");
    expect(out.turn.trace?.steps.map((s) => [s.action, s.policy.status, s.result?.ok])).toEqual([["grantDiscount", "allowed", true]]);
    expect(readLedger(out.state).at(-1)).toMatchObject({ effect: "discount.granted", status: "effected", terms: { discountPct: 5, item: MIDNIGHT } });
    expect(JSON.parse(out.state.knownFields.__discountGranted)).toMatchObject({ pct: 5, item: MIDNIGHT });
    expect(await approvalsOf(g, id)).toEqual([]);
    expect(out.response).toMatch(/5%/);
    expect(out.response).toMatch(/399/);
  });

  it("10% ('ask the owner'): exactly one owner request with the terms, NO handoff, truthful 'waiting' reply, no discount yet", async () => {
    const { g, model, id } = setup();
    await midnightOnly(model, g, id, 1);
    model.plan = () => askDiscount(10);
    const out = await handleCustomerMessage(g, id, "c", "Could you ask the owner to approve 10% off this dress?");
    expect(out.turn.trace?.steps.map((s) => [s.action, s.policy.status, s.policy.policyId])).toEqual([["grantDiscount", "requires_approval", "max_auto_discount_pct"]]);
    const approvals = await approvalsOf(g, id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "pending", requestedAction: "grantDiscount", requestedInput: { discountPct: 10, item: MIDNIGHT, listAmount: 420, currency: "ILS" } });
    expect(readHandoffs(out.state)).toEqual([]);
    expect(readLedger(out.state).some((e) => e.effect.startsWith("handoff."))).toBe(false);
    expect(readLedger(out.state).at(-1)).toMatchObject({ effect: "request.awaiting_owner", terms: { discountPct: 10 } });
    expect(out.state.knownFields.__discountGranted).toBeUndefined();
    expect(out.response).toMatch(/owner|בעל העסק/i);
    expect(out.response).not.toMatch(/team can see|passed .* to the team/i);

    // The owner's card and Ask BARRY show exactly these terms.
    const ws = await getOwnerWorkspace(g);
    const card = ws.interventions.find((i) => i.refs?.approvalId === approvals[0].id)!;
    expect(card.title).toMatch(/Approve a 10% discount on Midnight Wrap Dress \(₪420 → ₪378\)/);
    expect(card.options.find((o) => o.action === "approve")?.label).toBe("Approve 10% off Midnight Wrap Dress (₪420 → ₪378)");
    expect(card.why).toMatch(/5% discount BARRY may give on its own/);
    const ask = await askOwnerBarry(g, "Who needs me?");
    expect(ask.answer).toMatch(/10% discount on Midnight Wrap Dress/);
    expect(ask.answer).not.toMatch(/Nothing is waiting for you/);

    // A status question later: still waiting, never "nothing is waiting".
    model.plan = () => ({ advancesTransaction: false, asks: [{ ask: "any news from the owner?", kind: "status", coveredByThisIR: true }] });
    const status = await handleCustomerMessage(g, id, "c", "any news from the owner?");
    expect(status.response).toMatch(/still with the owner|waiting|ממתין|אצל בעל העסק/i);
  });

  it("approve → the exact discount grant runs once (a second approval is a no-op); the checkout is then priced with it", async () => {
    const { g, model, id } = setup();
    await midnightOnly(model, g, id, 1);
    model.plan = () => askDiscount(10);
    await handleCustomerMessage(g, id, "c", "ask the owner for 10% off");
    const [a] = await approvalsOf(g, id);
    const resumed = await resumeAfterApproval(g, a.id, "approved", "owner:test");
    expect(resumed.turn.toolResult?.ok).toBe(true);
    expect(resumed.response).toMatch(/approved/i);
    expect(resumed.response).toMatch(/378/);
    expect(JSON.parse(resumed.state.knownFields.__discountGranted)).toMatchObject({ pct: 10, item: MIDNIGHT });
    const again = await resumeAfterApproval(g, a.id, "approved", "owner:test");
    expect(again.turn.understood.intent).toBe("approval_already_resolved");
    expect(readLedger(again.state).filter((e) => e.effect === "discount.granted")).toHaveLength(1);

    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const pay = await handleCustomerMessage(g, id, "c", "checkout please, Adi 0505550114");
    expect(pay.turn.trace?.steps.map((s) => s.action)).toEqual(["createCommerceCheckout"]);
    const payment = await getBackend().getPaymentRequest(pay.state.knownFields.__paymentRequestId);
    expect(payment?.amount).toBe(378);
    expect(pay.response).toMatch(/378/);
  });

  it("decline → no discount exists anywhere; the checkout is at list price", async () => {
    const { g, model, id } = setup();
    await midnightOnly(model, g, id, 1);
    model.plan = () => askDiscount(10);
    await handleCustomerMessage(g, id, "c", "ask the owner for 10% off");
    const [a] = await approvalsOf(g, id);
    const declined = await resumeAfterApproval(g, a.id, "declined", "owner:test");
    expect(declined.state.knownFields.__discountGranted).toBeUndefined();
    expect(readLedger(declined.state).some((e) => e.effect === "discount.granted")).toBe(false);
    expect(declined.response).toMatch(/can't do that|לא נוכל/i);
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const pay = await handleCustomerMessage(g, id, "c", "checkout, Adi 0505550114");
    expect((await getBackend().getPaymentRequest(pay.state.knownFields.__paymentRequestId))?.amount).toBe(420);
  });

  it("corrected terms supersede: 10% then 15% → exactly one active request, at 15%", async () => {
    const { g, model, id } = setup();
    await midnightOnly(model, g, id, 1);
    model.plan = () => askDiscount(10);
    await handleCustomerMessage(g, id, "c", "ask the owner for 10% off");
    model.plan = () => askDiscount(15);
    await handleCustomerMessage(g, id, "c", "actually make that 15%");
    const approvals = await approvalsOf(g, id);
    expect(approvals.filter((x) => x.status === "pending").map((x) => (x.requestedInput as { discountPct: number }).discountPct)).toEqual([15]);
    expect(approvals).toHaveLength(2);
  });
});

// ── MEDIUM 2: one money classification for Money and Ask BARRY ───────────────────────────────────

describe("MEDIUM 2 — Money and Ask BARRY classify the same records identically; a pending simulated link is visible and labelled", () => {
  const g = getBusinessGraph("fashion-retailer");

  it("a ₪390 pending link on a simulated provider: Collected 0, listed as pending test money in the summary, the detail, money in motion and the briefing", async () => {
    const backend = getBackend();
    const convId = conv("money");
    const p = await backend.createPaymentRequest({ businessId: g.business.id, conversationId: convId, customerId: "c", amount: 390, currency: "ILS", reason: "Order for cart x", provider: "memory", providerPaymentId: `pp_${convId}` });
    try {
      const ws = await getOwnerWorkspace(g);
      expect(ws.revenue.direct).toEqual({});
      expect(ws.revenue.potential.ILS ?? 0).toBe(0);
      expect(ws.revenue.potentialSimulated).toEqual({ ILS: 390 });
      expect(ws.revenue.potentialSimulatedItems).toBe(1);
      const row = ws.revenueEvidence.find((e) => e.conversationId === convId)!;
      expect(row).toMatchObject({ category: "open_opportunity", simulated: true, amount: 390 });
      expect(row.record).toMatch(/simulated payment link, unpaid: test money, pending, not revenue/);
      expect(ws.revenueEvidence.filter((e) => e.conversationId === convId)).toHaveLength(1);
      expect(ws.opportunities.summary.simulated).toEqual({ ILS: 390 });
      expect(ws.opportunities.summary.waitingOnCustomer.ILS ?? 0).toBe(0);
      expect(ws.opportunities.items.find((o) => o.conversationId === convId)).toMatchObject({ kind: "unpaid_link", simulated: true, amount: 390 });

      const ask = await askOwnerBarry(g, "Any unpaid payments?");
      expect(ask.briefing.revenueToday.pendingSimulatedTestMoney).toBe("₪390");
      expect(ask.briefing.revenueToday.openOpportunities).toBe("none");
      expect(ask.briefing.revenueToday.collectedByBarry).toBe("none");
      expect(ask.answer).toMatch(/Pending on a simulated provider \(test money, unpaid, not revenue\): ₪390/);
      expect(ask.briefing.moneyInMotion.simulatedTestMoney).toBe("₪390");
    } finally {
      await backend.updatePaymentRequestStatus(p.id, "cancelled");
    }
  });

  it("the summary is a sum over the evidence: same records → identical figures; real and simulated never mix; nothing is counted twice", () => {
    const now = new Date();
    const pay = (over: Partial<PaymentRequestRecord>): PaymentRequestRecord => ({ id: `pay_${Math.random().toString(36).slice(2)}`, businessId: g.business.id, conversationId: "c1", customerId: "x", amount: 390, currency: "ILS", reason: "r", status: "pending", createdAt: now.toISOString(), provider: "payplus", ...over });
    const input = {
      graph: g,
      conversations: [],
      bookings: [],
      orders: [],
      approvals: [],
      now,
      payments: [
        pay({ status: "pending", provider: "memory", amount: 390 }), // simulated pending → pending test money
        pay({ status: "pending", amount: 250 }), // real pending → open opportunity
        pay({ status: "paid", verifiedAt: now.toISOString(), amount: 120 }), // collected
        pay({ status: "paid", verifiedAt: now.toISOString(), provider: "memory", amount: 80 }), // simulated paid
        pay({ status: "paid", amount: 999 }), // unverified: not counted
      ],
    };
    const ev = revenueEvidence(input);
    const r = revenueSummary(input);
    const sum = (rows: typeof ev) => rows.reduce((s, e) => s + e.amount, 0);
    expect(r.direct).toEqual({ ILS: sum(ev.filter((e) => e.category === "collected")) });
    expect(r.potential).toEqual({ ILS: sum(ev.filter((e) => e.category === "open_opportunity" && !e.simulated)) });
    expect(r.potentialSimulated).toEqual({ ILS: sum(ev.filter((e) => e.category === "open_opportunity" && e.simulated)) });
    expect(r.simulatedPaid).toEqual({ ILS: sum(ev.filter((e) => e.category === "simulated")) });
    expect(r.direct).toEqual({ ILS: 120 });
    expect(r.potential).toEqual({ ILS: 250 });
    expect(r.potentialSimulated).toEqual({ ILS: 390 });
    expect(r.potentialItems + r.potentialSimulatedItems).toBe(ev.filter((e) => e.category === "open_opportunity").length);
    expect(ev.filter((e) => e.category === "excluded_unverified").map((e) => e.amount)).toEqual([999]);
    expect(ev).toHaveLength(5);
  });
});

// ── MEDIUM 3: owner copy never carries a raw setting key ─────────────────────────────────────────

const RAW_SETTING = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const ENV = ["BARRY_OWNER_TOKEN", "BARRY_OWNER_TOKENS", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "BARRY_WHATSAPP_ROUTES", "BARRY_WHATSAPP_SEND", "OPENAI_API_KEY", "BARRY_REASONER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

describe("MEDIUM 3 — Train BARRY owner copy vs the BARRY team's technical step", () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function ownerStrings(a: Awaited<ReturnType<typeof assessCapabilities>>): string[] {
    return [...a.needs.flatMap((n) => [n.title, n.detail, n.authorityWords, ...n.blockedBy]), ...a.steps.flatMap((s) => [s.title, s.why, s.how, ...s.unlocks]), ...a.now, ...a.nowSimulated, ...a.afterSetup];
  }

  it("read model: with nothing configured, every owner-facing need/step string is free of setting keys; the team's technical field carries them", async () => {
    for (const k of ENV) delete process.env[k];
    const g = getBusinessGraph("fashion-retailer");
    const a = await assessCapabilities(g);
    for (const s of ownerStrings(a)) expect(s).not.toMatch(RAW_SETTING);
    const team = a.steps.filter((s) => s.who === "barry_team");
    expect(team.map((s) => s.id)).toEqual(expect.arrayContaining(["channel.whatsapp", "platform.ai", "platform.memory", "platform.owner"]));
    for (const id of ["platform.ai", "platform.memory", "platform.owner", "channel.whatsapp"]) {
      const step = a.steps.find((s) => s.id === id)!;
      expect(step.technical).toMatch(RAW_SETTING);
      expect(step.how).not.toMatch(RAW_SETTING);
    }
    // Readiness checks the owner sees on Train BARRY: label, detail and fix are owner words too.
    const r = await assessPilotReadiness(g);
    for (const c of r.checks) for (const s of [c.label, c.detail, c.fix ?? "", c.why ?? ""]) expect(s).not.toMatch(RAW_SETTING);
    expect(r.checks.filter((c) => c.technical).length).toBeGreaterThan(0);
    // Health and the Ask BARRY briefing derive from the same model.
    const ws = await getOwnerWorkspace(g);
    for (const s of ws.health.systems) for (const b of s.blockers) expect(b).not.toMatch(RAW_SETTING);
    const ask = await askOwnerBarry(g, "What can you do for me?");
    expect(briefingText(ask.briefing)).not.toMatch(RAW_SETTING);
    expect(JSON.stringify(ask.briefing)).not.toMatch(RAW_SETTING);
  });

  it("a connection with missing settings names their COUNT to the owner and the KEYS only to the team", () => {
    const input: CapabilityInput = {
      graph: getBusinessGraph("fashion-retailer"),
      profiles: undefined,
      connections: [],
      surface: [],
      systems: [],
      ai: { live: false },
      durable: false,
      ownerAccess: { scoped: false, global: false },
      whatsapp: { configured: false, routed: false, missing: ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN"], sendMode: "dry_run" },
    };
    const a = deriveCapabilities(input);
    const wa = a.steps.find((s) => s.id === "channel.whatsapp")!;
    expect(wa.how).toMatch(/3 settings still missing/);
    expect(wa.how).not.toMatch(RAW_SETTING);
    expect(wa.technical).toBe("Missing WhatsApp settings: WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_ACCESS_TOKEN.");
    expect(a.needs.find((n) => n.id === "channel.whatsapp")!.detail).toMatch(/3 settings for the BARRY team to add/);
  });

  it("render: the owner's setup plan shows no raw setting key outside the folded 'For the BARRY team' technical block", async () => {
    for (const k of ENV) delete process.env[k];
    const a = await assessCapabilities(getBusinessGraph("fashion-retailer"));
    const html = renderToString(createElement(SetupPlan, { steps: a.steps }));
    expect(html).toMatch(/For the BARRY team \(technical step/);
    const ownerHtml = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(ownerHtml).not.toMatch(RAW_SETTING);
    expect(ownerHtml).toMatch(/With the BARRY team/);
    const teamBlocks = html.match(/<details[\s\S]*?<\/details>/g) ?? [];
    expect(teamBlocks.some((b) => RAW_SETTING.test(b))).toBe(true);
  });
});
