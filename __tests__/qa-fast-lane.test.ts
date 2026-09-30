import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBusinessGraph } from "@/lib/fixtures";
import { resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { readHandoffs } from "@/lib/runtime/handoff";
import { readDeliveries } from "@/lib/channels/gateway";
import { QA_FORCE_UNDERSTANDING_FAILURE } from "@/lib/qa/mode";
import { QA_SCENARIOS, QA_PREFIX, runQaScenario, listQaScenarioRuns } from "@/lib/qa/scenarios";
import { resetQaData } from "@/lib/qa/reset";
import { testOwnerAvailability, testOwnerSignIn } from "@/lib/qa/test-owner";
import { getBusinessStatus } from "@/lib/hq/fleet";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { ScriptedModel, conv } from "./support/scripted-model";

/**
 * CHECKPOINT 2 — QA / release fast lane: the scenario factory builds acceptance states through the real
 * runtime with qa:-tagged records only; reset removes only those; the test-owner sign-in issues the
 * ordinary session without revealing a token and is unavailable outside QA mode.
 */

const ENV = ["VERCEL_ENV", "BARRY_QA_MODE", "BARRY_OWNER_TOKENS", "BARRY_OWNER_TOKEN", "BARRY_QA_TEST_OWNER_SIGNIN"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
  resetControlsCacheForTests();
});

const RINA = "fashion-retailer";
const approvalsFor = async (businessId: string, conversationId: string) => (await getBackend().listApprovals(businessId)).filter((a) => a.conversationId === conversationId);

describe("scenario factory: acceptance states from the real runtime, tagged as QA data", () => {
  it("every scenario belongs to a test business, runs, tags its conversation with qa:, records the run and returns links", async () => {
    for (const s of QA_SCENARIOS) {
      const run = await runQaScenario(s.id);
      expect(run.conversationId.startsWith(`${QA_PREFIX}${s.id}:`)).toBe(true);
      expect(run.businessId).toBe(s.businessId);
      expect(run.links.map((l) => l.label)).toEqual(expect.arrayContaining(["Owner · Today", "Owner · this conversation", "Owner · Money", "Train BARRY", "HQ · conversation (Inspector)", "QA tools"]));
      const state = await getConversationStore().get(run.conversationId);
      expect(state?.businessId).toBe(s.businessId);
      expect(state?.customerId).toBe("qa-customer");
      expect((await listQaScenarioRuns(s.businessId)).some((r) => r.runId === run.runId)).toBe(true);
    }
  });

  it("Rina: cart with Midnight + Onyx (₪810), checkout pending (simulated link), unverified 'I paid', discount approval (no handoff), completed order (one order)", async () => {
    const cart = await runQaScenario("rina_cart_midnight_onyx");
    const carts = (await getBackend().listCommerceCarts(RINA)).filter((c) => c.conversationId === cart.conversationId);
    expect(carts).toHaveLength(1);
    expect((carts[0].data as { total: { amount: number }; lines: { title: string }[] }).total.amount).toBe(810);
    expect((await getConversationStore().get(cart.conversationId))!.knownFields.__commerceCheckoutRequested).toBeUndefined();

    const pending = await runQaScenario("rina_checkout_pending");
    const payment = (await getBackend().getPaymentRequest(pending.records.paymentRequestId!))!;
    expect(payment).toMatchObject({ status: "pending", amount: 420, conversationId: pending.conversationId });
    expect(payment.provider ?? "memory").toMatch(/memory|mock|simulat/);
    const status = await getBusinessStatus(getBusinessGraph(RINA), { detail: true });
    expect(status.obligationList.some((o) => o.kind === "unpaid_payment_followup" && o.conversationId === pending.conversationId && o.simulated)).toBe(true);
    expect(status.money.simulated.ILS).toBeGreaterThanOrEqual(420);

    const claim = await runQaScenario("rina_payment_unverified_claim");
    const claimed = (await getConversationStore().get(claim.conversationId))!;
    expect(claimed.turns.at(-1)?.trace?.steps.map((s) => s.action)).toEqual(["verifyPayment"]);
    expect(claimed.knownFields.__paid).toBeUndefined();
    expect(claimed.knownFields.__commerceOrderId).toBeUndefined();

    const discount = await runQaScenario("rina_discount_approval");
    const approvals = await approvalsFor(RINA, discount.conversationId);
    expect(approvals.map((a) => [a.requestedAction, a.status, (a.requestedInput as { discountPct: number }).discountPct])).toEqual([["grantDiscount", "pending", 10]]);
    expect(discount.records.approvalId).toBe(approvals[0].id);
    expect(readHandoffs((await getConversationStore().get(discount.conversationId))!)).toEqual([]);

    const done = await runQaScenario("rina_completed_order");
    expect(done.records.orderId).toBeTruthy();
    expect((await getBackend().listCommerceOrders(RINA)).filter((o) => o.conversationId === done.conversationId)).toHaveLength(1);
    expect((await getBackend().getPaymentRequest(done.records.paymentRequestId!))!.status).toBe("paid");
  });

  it("Logistics: C302 active approval; F31 held after a forced not-understood correction; open handoff; failed delivery; armed AI failure", async () => {
    const logi = "barry-logistics-demo";
    const c302 = await runQaScenario("logistics_c302_approval");
    const a = await approvalsFor(logi, c302.conversationId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: "pending", requestedAction: "invokeCapability", requestedInput: { capability: "support.ticket.create", input: { reference: "Q4-C302" } } });

    const held = await runQaScenario("logistics_f31_held");
    const state = (await getConversationStore().get(held.conversationId))!;
    const lifecycle = withLifecycle(await approvalsFor(logi, held.conversationId), new Map([[held.conversationId, state]]));
    expect(lifecycle.map((x) => x.lifecycle)).toEqual(["held"]);
    expect(state.turns.at(-1)?.trace?.understanding?.valid).toBe(false);
    expect(state.knownFields[QA_FORCE_UNDERSTANDING_FAILURE]).toBeUndefined(); // consumed
    expect(held.note).toMatch(/Re-check/);

    const handoff = await runQaScenario("handoff_open");
    expect(handoff.records.handoffId).toBeTruthy();
    expect(readHandoffs((await getConversationStore().get(handoff.conversationId))!)[0].status).toBe("open");

    const delivery = await runQaScenario("delivery_failed");
    const d = readDeliveries((await getConversationStore().get(delivery.conversationId))!.knownFields);
    expect(d.at(-1)).toMatchObject({ status: "failed", channel: "whatsapp", error: expect.stringMatching(/QA: simulated/) });
    const spa = await getBusinessStatus(getBusinessGraph("spa"), { detail: true });
    expect(spa.incidents.open.some((i) => i.kind === "undelivered_reply" && i.links.conversationId === delivery.conversationId)).toBe(true);
    expect(spa.obligationList.some((o) => o.kind === "undelivered_reply" && o.conversationId === delivery.conversationId)).toBe(true);

    const armed = await runQaScenario("ai_failure_armed");
    expect((await getConversationStore().get(armed.conversationId))!.knownFields[QA_FORCE_UNDERSTANDING_FAILURE]).toBe("1");
  });

  it("scenarios refuse outside QA mode; a scenario for another business is refused by the route", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(runQaScenario("handoff_open")).rejects.toThrow(/QA mode/);
    delete process.env.VERCEL_ENV;
    const { POST } = await import("@/app/api/qa/scenarios/route");
    const res = await POST(new NextRequest("http://local/api/qa/scenarios", { method: "POST", body: JSON.stringify({ businessId: "spa", scenario: "rina_discount_approval" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(400);
  });
});

describe("QA reset removes only qa:-tagged records", () => {
  it("a real (non-QA) conversation, its payment and approval survive; every qa: record of the business goes", async () => {
    setReasonerForTests(new ScriptedModel(() => ({ constraints: { discountPct: 10 }, advancesTransaction: true })));
    const real = conv("real");
    const g = getBusinessGraph(RINA);
    // A non-QA conversation with a payment request and an approval.
    await handleCustomerMessage(g, real, "c", "hello");
    const realPayment = await getBackend().createPaymentRequest({ businessId: RINA, conversationId: real, customerId: "c", amount: 100, currency: "ILS", reason: "real", provider: "payplus" });
    const realApproval = await getBackend().createApproval({ businessId: RINA, conversationId: real, customerId: "c", requestedAction: "createPaymentRequest", requestedInput: { amount: 100 }, reason: "r", policyId: "p" });
    setReasonerForTests(undefined);
    const run = await runQaScenario("rina_discount_approval");
    const pendingRun = await runQaScenario("rina_checkout_pending");
    expect(await getConversationStore().get(run.conversationId)).toBeTruthy();
    const before = await getBusinessStatus(g, { detail: true });
    expect(before.obligationList.some((o) => o.conversationId === pendingRun.conversationId)).toBe(true);

    const result = await resetQaData(RINA);
    expect(result.prefix).toBe("qa:");
    expect(result.conversations).toBeGreaterThanOrEqual(2);
    expect(result.records.approvals).toBeGreaterThanOrEqual(1);
    expect(result.records.payment_requests).toBeGreaterThanOrEqual(1);
    expect(result.obligations).toBeGreaterThanOrEqual(1);
    expect(await getConversationStore().get(run.conversationId)).toBeUndefined();
    expect(await getConversationStore().get(pendingRun.conversationId)).toBeUndefined();
    expect((await getBackend().listApprovals(RINA)).some((a) => a.conversationId.startsWith("qa:"))).toBe(false);
    expect((await getBackend().listPaymentRequests(RINA)).some((p) => p.conversationId.startsWith("qa:"))).toBe(false);
    expect(await listQaScenarioRuns(RINA)).toEqual([]);
    // The real records are untouched.
    expect(await getConversationStore().get(real)).toBeTruthy();
    expect((await getBackend().getPaymentRequest(realPayment.id))?.status).toBe("pending");
    expect((await getBackend().getApproval(realApproval.id))?.status).toBe("pending");
    // Other businesses' qa: records are untouched by a Rina reset.
    const other = await runQaScenario("handoff_open");
    await resetQaData(RINA);
    expect(await getConversationStore().get(other.conversationId)).toBeTruthy();
  });
});

describe("test-owner sign-in: the session without the secret, only in QA mode, only for test businesses", () => {
  it("issues the ordinary owner session for a test business with its own token; refuses a business without one, a non-test business, and Production", async () => {
    process.env.BARRY_OWNER_TOKENS = "fashion-retailer:rina-qa-token-0000000000000001";
    delete process.env.BARRY_OWNER_TOKEN;
    delete process.env.VERCEL_ENV;
    expect(testOwnerAvailability()).toEqual({ available: true, businesses: ["fashion-retailer"] });
    const ok = await testOwnerSignIn("fashion-retailer");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.scope).toBe("business");
      expect(ok.cookie).not.toContain("rina-qa-token");
    }
    expect(await testOwnerSignIn("spa")).toEqual({ ok: false, reason: "no_own_token" });
    expect(await testOwnerSignIn("some-real-business")).toEqual({ ok: false, reason: "not_test_business" });
    // Audited.
    const audit = await getBackend().listOperatorRecords("fashion-retailer", "audit");
    expect(audit.some((a) => String((a.data as { by?: string }).by) === "qa:test-owner-signin")).toBe(true);

    const { POST, GET } = await import("@/app/api/qa/owner-session/route");
    const res = await POST(new NextRequest("http://local/api/qa/owner-session", { method: "POST", body: JSON.stringify({ businessId: "fashion-retailer" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^barry_owner=.*HttpOnly/);
    expect(res.headers.get("set-cookie")).not.toContain("rina-qa-token");
    expect(await res.json()).toMatchObject({ signedIn: true, testOnly: true });

    process.env.BARRY_QA_TEST_OWNER_SIGNIN = "0";
    expect(testOwnerAvailability().available).toBe(false);
    delete process.env.BARRY_QA_TEST_OWNER_SIGNIN;
    process.env.VERCEL_ENV = "production";
    expect(testOwnerAvailability()).toMatchObject({ available: false, reason: "not available on Production" });
    expect((await GET()).status).toBe(404);
    expect((await POST(new NextRequest("http://local/api/qa/owner-session", { method: "POST", body: JSON.stringify({ businessId: "fashion-retailer" }), headers: { "content-type": "application/json" } }))).status).toBe(404);
  });
});
