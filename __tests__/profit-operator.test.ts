import { describe, expect, it } from "vitest";
import "@/lib/fabric";
import { validateCostEvidence, recordCostEvidence, listCostEvidence } from "@/lib/finance/evidence";
import { profitOpportunities, financialImpact, isRealized, type CostEvidence } from "@/lib/finance/impact";
import { marginView } from "@/lib/finance/margin";
import { costActionAuthority, COST_ACTION_CAPABILITIES } from "@/lib/finance/actions";
import { prepareNegotiation } from "@/lib/finance/negotiation";
import { getCapability } from "@/lib/fabric/capability";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import type { CommerceOrderRecord, PaymentRequestRecord } from "@/lib/store/types";

/**
 * CHECKPOINT 6 — PROFIT / MARGIN OPERATOR V1: normalized cost evidence (validated, verified flag never
 * inferred), margin only where trusted revenue AND trusted cost exist, evidence-backed opportunity rules
 * (no evidence = zero), BARRY MADE / SAVED strictness, cost-action contracts that default to DENY, and a
 * negotiation brief that can never be sent without channel + authority + approved objective.
 */

const B = "profit-biz";
const ev = (over: Partial<CostEvidence> & Pick<CostEvidence, "id" | "kind" | "amount">): CostEvidence => ({ businessId: B, currency: "ILS", at: "2026-09-01T00:00:00.000Z", source: { system: "accounting", reference: over.id }, verified: true, ...over });

describe("normalized cost evidence", () => {
  it("validates shape, currency and source; rejects what cannot be trusted; stores per business", async () => {
    expect(validateCostEvidence({ id: "x" }).ok).toBe(false);
    const bad = validateCostEvidence({ id: "f1", businessId: B, kind: "payment_fee", amount: -3, currency: "ils", at: "yesterday", source: { system: "", reference: "" }, verified: true });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.problems.join(" ")).toMatch(/amount|currency|at|system/);
    const r = await recordCostEvidence(B, [ev({ id: "f1", kind: "payment_fee", amount: 12 }), { id: "f2", businessId: "other", kind: "payment_fee", amount: 1, currency: "ILS", at: "2026-09-01T00:00:00.000Z", source: { system: "s", reference: "r" }, verified: true }]);
    expect(r.stored.map((e) => e.id)).toEqual(["f1"]);
    expect(r.rejected[0].problems).toEqual(["businessId does not match the scope"]);
    expect((await listCostEvidence(B)).map((e) => e.id)).toEqual(["f1"]);
  });
});

describe("margin observability never guesses a cost", () => {
  it("margin exists only with a verified payment and verified cost on the order; unknown cost stays apart; test money apart", () => {
    const orders: CommerceOrderRecord[] = [
      { id: "o1", businessId: B, conversationId: "c1", customerId: "x", orderId: "ORD-1", cartId: "k", totalAmount: 420, currency: "ILS", status: "paid", idempotencyKey: "i1", verifiedAt: "2026-09-02T00:00:00.000Z", data: {}, createdAt: "2026-09-02T00:00:00.000Z" },
      { id: "o2", businessId: B, conversationId: "c2", customerId: "y", orderId: "ORD-2", cartId: "k", totalAmount: 390, currency: "ILS", status: "paid", idempotencyKey: "i2", verifiedAt: "2026-09-03T00:00:00.000Z", data: {}, createdAt: "2026-09-03T00:00:00.000Z" },
      { id: "o3", businessId: B, conversationId: "c3", customerId: "z", orderId: "ORD-3", cartId: "k", totalAmount: 100, currency: "ILS", status: "paid", idempotencyKey: "i3", verifiedAt: "2026-09-03T00:00:00.000Z", data: {}, createdAt: "2026-09-03T00:00:00.000Z" },
    ];
    const payments: PaymentRequestRecord[] = [
      { id: "p1", businessId: B, conversationId: "c1", customerId: "x", amount: 420, currency: "ILS", reason: "r", status: "paid", createdAt: "2026-09-02T00:00:00.000Z", provider: "payplus", verifiedAt: "2026-09-02T00:01:00.000Z", providerTransactionId: "t1" },
      { id: "p2", businessId: B, conversationId: "c2", customerId: "y", amount: 390, currency: "ILS", reason: "r", status: "paid", createdAt: "2026-09-03T00:00:00.000Z", provider: "payplus", verifiedAt: "2026-09-03T00:01:00.000Z", providerTransactionId: "t2" },
      { id: "p3", businessId: B, conversationId: "c3", customerId: "z", amount: 100, currency: "ILS", reason: "r", status: "paid", createdAt: "2026-09-03T00:00:00.000Z", provider: "memory", verifiedAt: "2026-09-03T00:01:00.000Z" },
    ];
    const evidence = [ev({ id: "s1", kind: "supplier_cost", amount: 200, orderId: "ORD-1" }), ev({ id: "fee1", kind: "payment_fee", amount: 10, orderId: "ORD-1" }), ev({ id: "guess", kind: "supplier_cost", amount: 50, orderId: "ORD-2", verified: false })];
    const v = marginView({ orders, payments, evidence });
    const o1 = v.orders.find((o) => o.orderId === "ORD-1")!;
    expect(o1).toMatchObject({ revenue: 420, cost: 210, margin: 210, marginPct: 50 });
    expect(o1.explain).toMatch(/verified payment/);
    const o2 = v.orders.find((o) => o.orderId === "ORD-2")!;
    expect(o2.cost).toBeNull();
    expect(o2.explain).toMatch(/unknown/);
    expect(v.summary.byCurrency.ILS).toMatchObject({ ordersWithKnownCost: 1, revenue: 420, cost: 210, margin: 210, marginPct: 50 });
    expect(v.summary.revenueWithUnknownCost).toEqual({ ILS: 390 });
    expect(v.summary.ordersWithoutCost).toBe(1);
    expect(v.summary.simulatedOrders).toBe(1);
  });
});

describe("profit opportunities are evidence-backed and never realised by estimate", () => {
  it("no evidence → none; supplier increase, subscription duplication, slow inventory and shipping inefficiency each need their evidence", () => {
    expect(profitOpportunities(B, [])).toEqual([]);
    const evidence: CostEvidence[] = [
      ev({ id: "sc1", kind: "supplier_cost", amount: 1000, counterparty: "Fabrics Ltd", item: "crepe-black", unitPrice: 10, quantity: 100, at: "2026-03-01T00:00:00.000Z" }),
      ev({ id: "sc2", kind: "supplier_cost", amount: 1300, counterparty: "Fabrics Ltd", item: "crepe-black", unitPrice: 13, quantity: 100, at: "2026-09-01T00:00:00.000Z" }),
      ev({ id: "sub1", kind: "saas_subscription", amount: 50, category: "email marketing", item: "MailA" }),
      ev({ id: "sub2", kind: "saas_subscription", amount: 80, category: "Email Marketing", item: "MailB" }),
      ev({ id: "inv1", kind: "inventory_carrying", amount: 2000, exposure: true, at: "2026-01-01T00:00:00.000Z" }),
      ...[30, 32, 31, 90, 33].map((amount, i) => ev({ id: `sh${i}`, kind: "shipping_fulfillment", amount, orderId: `ORD-${i}` })),
    ];
    const out = profitOpportunities(B, evidence);
    const ids = out.map((o) => o.id.split(":")[0]);
    expect(ids).toEqual(expect.arrayContaining(["supplier_increase", "subscription_duplication", "slow_inventory", "shipping_inefficiency"]));
    const sup = out.find((o) => o.id.startsWith("supplier_increase"))!;
    expect(sup.problem).toMatch(/30% more per unit/);
    expect(sup.estimatedImpact).toEqual({ amount: 600, currency: "ILS", per: "period" });
    expect(sup.authority).toBe("owner_approval");
    const dup = out.find((o) => o.id.startsWith("subscription_duplication"))!;
    expect(dup.estimatedImpact.amount).toBe(80);
    for (const o of out) {
      expect(o.state).toBe("POTENTIAL");
      expect(isRealized(o)).toBe(false);
      expect(o.assumptions.length).toBeGreaterThan(0);
    }
    const impact = financialImpact({ direct: { ILS: 420 }, directPayments: 1, recovered: {}, influenced: {}, influencedBookings: 0, potential: {}, potentialItems: 0, potentialSimulated: {}, potentialSimulatedItems: 0, simulatedPaid: {}, simulatedInfluenced: {}, discounts: { granted: 0, refused: 0 }, purchaseIntentConversations: 1, convertedConversations: 1, lostOpportunities: 0, ownerInterventions: 0, activeConversations: 1 }, out);
    expect(impact.saved.realized).toEqual({});
    expect(impact.saved.potential.ILS).toBeGreaterThan(0);
    expect(impact.generated).toEqual({ ILS: 420 });
  });
});

describe("cost actions: contracts exist, execution is denied by default", () => {
  it("every cost action is consequential, provider-confirmed, idempotent and policy-gated; without a rule the Genome denies it", () => {
    for (const c of COST_ACTION_CAPABILITIES) {
      const registered = getCapability(c.id)!;
      expect(registered).toMatchObject({ effect: "consequential", verification: "provider_confirmed", idempotency: "key_required", authority: "policy_gated" });
    }
    const g = buildFashionRetailerGraph();
    const d = costActionAuthority(g, "procurement.subscription.cancel", { subscriptionReference: "sub_1", reason: "dup", idempotencyKey: "cancel-key-01" });
    expect(d.status).toBe("denied");
    expect(costActionAuthority(g, "commerce.cart.create").status).toBe("denied");
    const allowed = costActionAuthority({ ...g, authority: [...g.authority, { id: "cost-1", capability: "procurement.subscription.cancel", effect: "require_approval", when: [] }] }, "procurement.subscription.cancel", { subscriptionReference: "sub_1", reason: "dup", idempotencyKey: "cancel-key-01" });
    expect(allowed.status).toBe("requires_approval");
  });
});

describe("negotiation preparation", () => {
  it("builds history, concentration, trend, alternatives and a flagged target range; cannot be sent without channel, authority and an approved objective", () => {
    const g = buildFashionRetailerGraph();
    const evidence: CostEvidence[] = [
      ev({ id: "a1", kind: "supplier_cost", amount: 1000, counterparty: "Fabrics Ltd", item: "crepe-black", unitPrice: 10, quantity: 100, at: "2026-03-01T00:00:00.000Z" }),
      ev({ id: "a2", kind: "supplier_cost", amount: 1300, counterparty: "Fabrics Ltd", item: "crepe-black", unitPrice: 13, quantity: 100, at: "2026-09-01T00:00:00.000Z" }),
      ev({ id: "b1", kind: "supplier_cost", amount: 550, counterparty: "Textile Co", item: "crepe-black", unitPrice: 11, quantity: 50, at: "2026-08-01T00:00:00.000Z" }),
      ev({ id: "u1", kind: "supplier_cost", amount: 999, counterparty: "Fabrics Ltd", item: "crepe-black", unitPrice: 5, quantity: 200, verified: false }),
    ];
    const brief = prepareNegotiation({ graph: g, evidence, counterparty: "Fabrics Ltd", objective: "return to ₪10 per unit" });
    expect(brief.history).toMatchObject({ purchases: 2, total: 2300, currency: "ILS" });
    expect(brief.history.items[0]).toMatchObject({ item: "crepe-black", quantity: 200, firstUnitPrice: 10, lastUnitPrice: 13, trendPct: 30 });
    expect(brief.concentration.sharePct).toBe(80.7);
    expect(brief.alternatives).toEqual([{ item: "crepe-black", supplier: "Textile Co", lastUnitPrice: 11 }]);
    expect(brief.targetRange[0]).toMatchObject({ item: "crepe-black", low: 10, high: 12.35 });
    expect(brief.canSend.ok).toBe(false);
    expect(brief.canSend.reasons.join(" ")).toMatch(/channel/);
    expect(brief.canSend.reasons.join(" ")).toMatch(/authority: denied/);
    expect(brief.canSend.reasons.join(" ")).toMatch(/not approved/);
  });
});
