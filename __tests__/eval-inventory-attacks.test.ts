import { describe, expect, it } from "vitest";
import { buildEcommerceBagsGraph } from "@/lib/fixtures/ecommerce-bags";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { getBackend } from "@/lib/store";

/**
 * MEGA RELIABILITY MISSION — Part 15: inventory/order attacks. Inventory
 * must be atomic (never oversold), fulfillment must never happen twice,
 * and never without genuine payment.
 *
 * Real bugs found and fixed while building this suite:
 *
 * 1. `fulfillOrder` decremented inventory unconditionally with NO
 *    re-check against current stock — the only stock check ran once, at
 *    `checkInventory` time, long before payment. Two customers who both
 *    checked inventory while exactly one unit remained (an entirely
 *    ordinary sequence — checkInventory and fulfillOrder happen turns
 *    apart, with a full payment flow in between, not simultaneous
 *    requests) could BOTH successfully pay and fulfill for the same
 *    last unit — genuine overselling. `getInventory`'s read-side
 *    `Math.max(0, ...)` clamp hid the deficit from display without
 *    preventing it. Fixed by making `decrementInventory` an atomic
 *    check-and-reserve against the CURRENT base quantity (memory-
 *    backend: a guarded Map read-then-write; supabase-backend:
 *    migration 0004's `reserve_inventory`, a single guarded UPDATE,
 *    replacing the unconditional `increment_inventory_consumed` from
 *    migration 0002) that returns whether the reservation actually
 *    succeeded — `fulfillOrder` now re-validates at the moment of
 *    actual fulfillment and refuses (never silently fulfills) when the
 *    unit sold out in the meantime.
 *
 * 2. (Also surfaced here, structurally identical to the inventory case
 *    but on the payment side): a payment FAILURE left the dead
 *    `paymentRequestId` on the conversation's knownFields forever —
 *    `!known[SCRATCH_KEYS.paymentRequestId]` (the ONE condition that
 *    creates a new payment request) could never fire again, so a
 *    customer who said "let's try again" got stuck in a permanent
 *    "just waiting on your payment" loop referencing a payment that had
 *    already failed, with no way to actually retry. Fixed in
 *    `handlePaymentOutcome`'s failure branch by clearing the dead
 *    payment request id.
 */

/**
 * The backend's inventory state is a module-level singleton shared by
 * every test in this file (not reset between tests) — deliberately
 * mirroring how a real server process behaves across requests, which is
 * exactly what Part 15's "last item"/"concurrent purchase" scenarios
 * need to exercise. This drives a SKU down to exactly `target` units
 * remaining regardless of what earlier tests in this file already
 * consumed, instead of assuming a fresh baseline.
 */
async function depleteTo(
  backend: ReturnType<typeof getBackend>,
  businessId: string,
  sku: string,
  baseQuantity: number,
  target: number
): Promise<void> {
  const current = await backend.getInventory(businessId, sku, baseQuantity);
  const toConsume = current - target;
  if (toConsume > 0) {
    const ok = await backend.decrementInventory(businessId, sku, toConsume, baseQuantity);
    if (!ok) throw new Error(`depleteTo: failed to consume ${toConsume} units of ${sku}`);
  }
}

describe("Inventory attacks: in stock vs out of stock", () => {
  it("an in-stock item proceeds normally to checkout", async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "inv-instock-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Backpack");
    // checkInventory fires as soon as required customer info is complete
    // (this same turn), not on a later, separately-worded "checkout" message.
    const r = await handleCustomerMessage(graph, conv, cust, "My name is Inon and my email is i@x.com");
    expect(r.turn.selectedAction?.name).toBe("checkInventory");
    expect(r.response).toMatch(/in stock/i);
  });

  it("an out-of-stock item (Tote, quantityOnHand: 0) never proceeds to payment", async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "inv-outofstock-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Everyday Tote");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my email is i@x.com");
    const r = await handleCustomerMessage(graph, conv, cust, "checkout");
    expect(r.response).toMatch(/out of stock/i);
    expect(r.turn.stateAfter.outcome).not.toBe("won");
  });
});

// These generic (non-depleting) scenarios run BEFORE the tests below that
// deliberately drain SKU-BACKPACK/SKU-WEEKENDER down to their last unit —
// they only ever consume 1 unit of well-stocked Backpack (12 on hand),
// so file order here matters for keeping their setup simple and honest
// about the shared, non-reset backend singleton.
describe("Inventory attacks: duplicate fulfillment webhook never fulfills twice", () => {
  it("firing the same 'paid' outcome twice fulfills ONCE", async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "inv-dupfulfill-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Backpack");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my email is i@x.com");
    const r = await handleCustomerMessage(graph, conv, cust, "go ahead");
    const paymentId = r.state.knownFields.__paymentRequestId;

    const first = await handlePaymentOutcome(graph, conv, paymentId, "paid");
    expect(first.turn.toolResult?.ok).toBe(true);

    const second = await handlePaymentOutcome(graph, conv, paymentId, "paid");
    expect(second.turn.selectedAction).toBeFalsy();
    expect(second.turn.toolResult).toBeUndefined();
    expect(second.response).toMatch(/already/i);
  });
});

describe("Inventory attacks: fulfillment never happens without genuine payment", () => {
  it("a payment failure never fulfills the order", async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "inv-payfail-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Backpack");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my email is i@x.com");
    const r = await handleCustomerMessage(graph, conv, cust, "go ahead");
    const paymentId = r.state.knownFields.__paymentRequestId;

    const failed = await handlePaymentOutcome(graph, conv, paymentId, "failed");
    expect(failed.state.outcome).not.toBe("won");
    expect(failed.state.knownFields.__paid).toBeFalsy();
  });

  it('an "I paid" claim never fulfills the order without a real payment outcome', async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "inv-claim-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Backpack");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my email is i@x.com");
    await handleCustomerMessage(graph, conv, cust, "go ahead");
    const r = await handleCustomerMessage(graph, conv, cust, "I already paid, please ship it");
    expect(r.turn.selectedAction?.name).not.toBe("fulfillOrder");
    expect(r.state.outcome).not.toBe("won");
  });

  it("a retry after failure (a fresh payment request) can still succeed", async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "inv-retry-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Backpack");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my email is i@x.com");
    let r = await handleCustomerMessage(graph, conv, cust, "go ahead");
    const firstPaymentId = r.state.knownFields.__paymentRequestId;
    await handlePaymentOutcome(graph, conv, firstPaymentId, "failed");

    r = await handleCustomerMessage(graph, conv, cust, "Let's try again");
    const secondPaymentId = r.state.knownFields.__paymentRequestId;
    expect(secondPaymentId).toBeTruthy();
    expect(secondPaymentId).not.toBe(firstPaymentId);

    const result = await handlePaymentOutcome(graph, conv, secondPaymentId, "paid");
    expect(result.state.outcome).toBe("won");
  });
});

describe("Inventory attacks: the last item can be bought exactly once", () => {
  it("depleting stock to zero and trying again correctly reports out of stock", async () => {
    const graph = buildEcommerceBagsGraph();
    const backend = getBackend();
    await depleteTo(backend, graph.business.id, "SKU-WEEKENDER", 4, 1); // exactly 1 left

    const conv1 = "inv-last-a-" + Date.now();
    const cust1 = "cust-a-" + Date.now();
    await handleCustomerMessage(graph, conv1, cust1, "Weekender Duffel");
    // checkInventory fires on this same turn (required info now complete).
    let r = await handleCustomerMessage(graph, conv1, cust1, "My name is A and my email is a@x.com");
    expect(r.response).toMatch(/in stock/i);
    r = await handleCustomerMessage(graph, conv1, cust1, "go ahead");
    const paymentId1 = r.state.knownFields.__paymentRequestId;
    const result1 = await handlePaymentOutcome(graph, conv1, paymentId1, "paid");
    expect(result1.turn.toolResult?.ok).toBe(true);

    // A second buyer, checking AFTER the first unit is gone, correctly sees no stock.
    const conv2 = "inv-last-b-" + Date.now();
    const cust2 = "cust-b-" + Date.now();
    await handleCustomerMessage(graph, conv2, cust2, "Weekender Duffel");
    const r2 = await handleCustomerMessage(graph, conv2, cust2, "My name is B and my email is b@x.com");
    expect(r2.response).toMatch(/out of stock/i);
  });
});

describe("Inventory attacks: concurrent purchase of the last unit never oversells", () => {
  it("two customers who BOTH pass checkInventory while exactly one unit remains — only one fulfillment succeeds", async () => {
    const graph = buildEcommerceBagsGraph();
    const backend = getBackend();
    // A different SKU than the "last item" test above, which already
    // depletes SKU-WEEKENDER to 0 — Backpack has enough headroom left
    // (12 on hand, minus a handful of single-unit purchases from earlier
    // tests in this file) to still reach exactly 1 remaining.
    await depleteTo(backend, graph.business.id, "SKU-BACKPACK", 12, 1); // exactly 1 left

    async function upToPayment(name: string) {
      const conv = `inv-race-${name}-${Date.now()}-${Math.random()}`;
      const cust = `inv-race-cust-${name}-${Date.now()}-${Math.random()}`;
      await handleCustomerMessage(graph, conv, cust, "Backpack");
      // Both customers reach checkInventory BEFORE either one pays —
      // the actual race window (stock is only decremented at fulfillment).
      const r = await handleCustomerMessage(graph, conv, cust, `My name is ${name} and my email is ${name}@x.com`);
      expect(r.response).toMatch(/in stock/i);
      return { conv, cust };
    }

    const a = await upToPayment("RaceA");
    const b = await upToPayment("RaceB");

    async function payAndFulfill(convCust: { conv: string; cust: string }) {
      const r = await handleCustomerMessage(graph, convCust.conv, convCust.cust, "go ahead");
      const paymentId = r.state.knownFields.__paymentRequestId;
      return handlePaymentOutcome(graph, convCust.conv, paymentId, "paid");
    }

    const [resultA, resultB] = await Promise.all([payAndFulfill(a), payAndFulfill(b)]);
    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((r) => r.turn.toolResult?.ok);
    const failed = outcomes.filter((r) => r.turn.toolResult && !r.turn.toolResult.ok);

    // EXACTLY one succeeds — never both (oversold), never neither.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].response).toMatch(/sold out|issue/i);

    // Actual consumed inventory never exceeds the real base quantity (12).
    const remaining = await backend.getInventory(graph.business.id, "SKU-BACKPACK", 12);
    expect(remaining).toBe(0);
  });
});
