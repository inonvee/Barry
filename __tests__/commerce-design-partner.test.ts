import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { createCommerceOrder, getCatalogSchema } from "@/lib/commerce/capability";
import { groundDiscovery, shortlist, compareRows, alternativesFor } from "@/lib/commerce/discovery";
import { deriveCustomerMemory, refreshCustomerMemory, loadCustomerMemory, memoryWords } from "@/lib/commerce/memory";
import { orderAftercare } from "@/lib/commerce/aftercare";
import { intakeStructuredFacts } from "@/lib/learn-business/intake";
import { fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * CHECKPOINT 2 — COMMERCE / DESIGN-PARTNER V1: grounded discovery (unsupported facets rejected or
 * remapped), guided selling shortlist + compare on real attributes, real alternatives for an
 * unavailable variant (also through the add-to-cart tool), provider-grounded order aftercare, and
 * customer commerce memory that keeps observed history apart from inference.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  dispose?.();
  dispose = undefined;
});
const NOW = new Date("2026-09-30T12:00:00.000Z");

function setup() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model, id: conv("cm") };
}

describe("product discovery: facets the catalog has, nothing else", () => {
  it("grounds occasion / size / budget against the schema; unsupported facets are rejected, an unknown occasion falls back to text", async () => {
    const { g } = setup();
    const schema = await getCatalogSchema(g);
    const ok = groundDiscovery(schema, { occasion: "wedding", options: { size: "M" }, budget: { amount: 400 }, attributes: { fabric: "silk" } });
    expect(ok.search.attributes).toEqual({ occasion: "wedding" });
    expect(ok.search.options).toEqual({ size: "M" });
    expect(ok.search.budget).toEqual({ amount: 400, currency: "ILS" });
    expect(ok.rejected.map((r) => r.field)).toEqual(["attributes.fabric"]);
    const unknown = groundDiscovery(schema, { text: "black dress", occasion: "moon landing" });
    expect(unknown.search.attributes).toBeUndefined();
    expect(unknown.search.text).toBe("black dress moon landing");
    expect(unknown.rejected).toEqual([]);
  });

  it("shortlist is small, in stock, within budget and ranked by option match; compare uses only shared real attributes", () => {
    const products = fashionCatalog();
    const rows = shortlist(products, { budget: { amount: 400, currency: "ILS" }, options: { size: "M" }, max: 3 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const r of rows) expect(r.price.amount).toBeLessThanOrEqual(400);
    expect(rows.every((r) => r.inStockOptions.length > 0)).toBe(true);
    const cmp = compareRows(rows);
    for (const k of cmp.keys) expect(k).not.toBe("keywords");
    expect(cmp.rows).toHaveLength(rows.length);
    expect(shortlist(products, { budget: { amount: 1, currency: "ILS" } })).toEqual([]);
  });

  it("alternatives are real: the same item in another in-stock option first, then same-category items in stock", () => {
    const products = fashionCatalog();
    const midnight = products.find((p) => p.id === "prod-midnight-wrap-dress")!;
    const alts = alternativesFor(products, { productId: midnight.id, options: { size: "S" } });
    expect(alts.length).toBeGreaterThan(0);
    expect(alts[0]).toMatchObject({ productId: midnight.id });
    expect(alts[0].reason).toMatch(/in stock in size (M|L)/);
    for (const a of alts) {
      const p = products.find((x) => x.id === a.productId)!;
      if (a.variant) expect(p.variants.some((v) => JSON.stringify(v.options) === JSON.stringify(a.variant) && v.inventory.available >= 1)).toBe(true);
    }
    expect(alternativesFor(products, { productId: "nope" })).toEqual([]);
  });

  it("the add-to-cart tool returns grounded alternatives when the requested variant is out of stock", async () => {
    const { g, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "the midnight dress");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "S" } }, purchaseDecision: false, advancesTransaction: true });
    const out = await handleCustomerMessage(g, id, "c", "add it in S");
    const step = out.turn.trace?.steps.find((s) => s.action === "addToCart");
    expect(step?.result?.ok).toBe(true);
    const state = (await getConversationStore().get(id))!;
    expect(state.knownFields.__commerceCartId).toBeUndefined();
    const notAdded = (out.turn.toolResult?.output as { notAdded?: { alternatives?: { title: string; reason: string }[] } } | undefined)?.notAdded;
    expect(notAdded?.alternatives?.length ?? 0).toBeGreaterThan(0);
    expect(notAdded?.alternatives?.[0].reason).toMatch(/in stock/);
  });
});

describe("order aftercare and customer memory", () => {
  it("aftercare is provider-grounded; returns policy only from an owner-approved fact; next action only when supported", async () => {
    const { g, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "the midnight dress");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "add it in M");
    model.plan = () => ({ commerce: { intent: "checkout" }, customerInfo: { name: "Dana", phone: "0501234567" }, evidence: { "customerInfo.name": "Dana", "customerInfo.phone": "0501234567" }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "checkout please, Dana 0501234567");
    const state = (await getConversationStore().get(id))!;
    const payment = (await getBackend().listPaymentRequests(g.business.id)).find((p) => p.conversationId === id)!;
    await getBackend().simulatePaymentOutcome(payment.id, "paid");
    const order = await createCommerceOrder({ graph: g, customerId: "c", conversationId: id, cartId: state.knownFields.__commerceCartId, paymentRequestId: payment.id });
    const unknown = await orderAftercare(g, order.id, { facts: [], lang: "en" });
    expect(unknown.order?.id).toBe(order.id);
    expect(unknown.providerStatus?.status).toBe("paid");
    expect(unknown.returns.source).toBe("not_known");
    expect(unknown.nextActions).toEqual(["ask_team"]);
    expect(unknown.words).toMatch(/hand you to the team/);
    const { facts } = await intakeStructuredFacts({ graph: g, facts: [{ key: "policy.returns", value: "14 days with a receipt" }], approvedBy: "owner-1", now: NOW });
    const known = await orderAftercare(g, order.id, { facts, lang: "en" });
    expect(known.returns).toEqual({ policy: "14 days with a receipt", source: "owner_approved_fact" });
    expect(known.nextActions).toEqual(["start_return"]);
    expect(known.words).toContain("Returns: 14 days with a receipt");
    expect((await orderAftercare(g, "no-such-order", { facts, lang: "en" })).order).toBeNull();

    // Customer memory: the verified order is OBSERVED; a preference is INFERRED only after repeated purchases.
    const memory = await refreshCustomerMemory(g.business.id, "c", [state], NOW);
    expect(memory.observed.purchases).toHaveLength(1);
    expect(memory.observed.purchases[0]).toMatchObject({ verified: true, total: { amount: 420, currency: "ILS" } });
    expect(memory.observed.optionsUsed.size).toEqual({ M: 1 });
    expect(memory.inferred).toEqual([]);
    expect(await loadCustomerMemory(g.business.id, "c")).toMatchObject({ customerId: "c" });
    const twice = deriveCustomerMemory({ businessId: g.business.id, customerId: "c", orders: [...(await getBackend().listCommerceOrders(g.business.id)), { ...(await getBackend().listCommerceOrders(g.business.id))[0], id: "o2", orderId: "ORD-2" }], carts: [], payments: [], conversations: [state], now: NOW });
    expect(twice.inferred.find((i) => i.option === "size")).toEqual({ option: "size", value: "M", observations: 2, basis: "repeated_purchases" });
    expect(memoryWords(twice).some((w) => /inferred/.test(w) && /ask, don't assume/.test(w))).toBe(true);
    state.knownFields["customer.pref.size"] = "L";
    const explicit = deriveCustomerMemory({ businessId: g.business.id, customerId: "c", orders: twice.observed.purchases.map((p, i) => ({ id: `o${i}`, businessId: g.business.id, conversationId: id, customerId: "c", orderId: p.orderId, cartId: "x", totalAmount: p.total.amount, currency: p.total.currency, status: "paid" as const, idempotencyKey: `k${i}`, verifiedAt: p.at, data: { lines: p.lines.map((l) => ({ ...l, id: "l", productId: "p", variantId: "v", unitPrice: { amount: 1, currency: "ILS" } })) }, createdAt: p.at })), carts: [], payments: [], conversations: [state], now: NOW });
    expect(explicit.explicit).toEqual({ size: "L" });
    expect(explicit.inferred.some((i) => i.option === "size")).toBe(false);
  });
});
