import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as readConversation } from "@/app/api/simulator/conversation/route";
import { POST as sendMessage } from "@/app/api/simulator/message/route";
import { POST as settlePayment } from "@/app/api/simulator/payment/route";
import { GET as readGraph } from "@/app/api/simulator/graph/route";
import { GET as listApprovals, POST as decideApproval } from "@/app/api/simulator/approvals/route";
import { getConversationStore } from "@/lib/state";
import { getBackend } from "@/lib/store";
import { getBusinessGraph } from "@/lib/fixtures";
import { isSimulatedPaymentProvider, SimulatedPaymentRefusedError } from "@/lib/payments/simulated";
import { isSimulatedPayment, isVerifiedPaid, revenueSummary } from "@/lib/owner/revenue";
import { simulatorEnabled } from "@/lib/simulator-access";

/**
 * PAID-PILOT P0 — the customer simulator is never a public surface, and test money can never become real.
 * The routes read transcripts, speak as a customer and settle payments: in Production they don't exist;
 * elsewhere only the business's owner can use them; and settling is limited to simulated providers by the
 * store itself, so a mis-set gate still can't mint verified revenue on a real provider.
 */

const BIZ = "fashion-retailer";
const OTHER = "spa";
const TOKEN = "rina-owner-token-0123456789";
const OTHER_TOKEN = "spa-owner-token-0123456789";
const WA_ID = `wa:${BIZ}:972500000001`;

const get = (url: string, token?: string) => new NextRequest(url, token ? { headers: { "x-barry-owner-token": token } } : undefined);
const post = (url: string, body: unknown, token?: string) =>
  new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token ? { "x-barry-owner-token": token } : {}) } });

/** A real customer's conversation with a REAL-provider payment link outstanding. */
async function realCustomerWithPayPlusLink() {
  const store = getConversationStore();
  const state = await store.getOrCreate(WA_ID, BIZ, "wa:972500000001");
  state.messages.push({ role: "customer", content: "private order details", at: new Date().toISOString() });
  const pr = await getBackend().createPaymentRequest({ businessId: BIZ, conversationId: WA_ID, customerId: "wa:972500000001", amount: 390, currency: "ILS", reason: "order", provider: "payplus", providerPaymentId: `pp_${Date.now()}` });
  state.knownFields.__paymentRequestId = pr.id;
  await store.save(state);
  return pr;
}

/** Every simulator route, unauthenticated unless a token is given. */
function everyRoute(token?: string) {
  return [
    ["GET conversation", () => readConversation(get(`http://x/api/simulator/conversation?businessId=${BIZ}&conversationId=${encodeURIComponent(WA_ID)}`, token))],
    ["POST message", () => sendMessage(post("http://x/api/simulator/message", { businessId: BIZ, conversationId: WA_ID, customerId: "wa:972500000001", message: "cancel my order" }, token))],
    ["POST payment", () => settlePayment(post("http://x/api/simulator/payment", { businessId: BIZ, conversationId: WA_ID, paymentRequestId: "pr_x", outcome: "paid" }, token))],
    ["GET graph", () => readGraph(get(`http://x/api/simulator/graph?businessId=${BIZ}`, token))],
    ["GET approvals", () => listApprovals(get(`http://x/api/simulator/approvals?businessId=${BIZ}`, token))],
    ["POST approvals", () => decideApproval(post("http://x/api/simulator/approvals", { businessId: BIZ, approvalId: "a_x", decision: "approved" }, token))],
  ] as const;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Production: the simulator does not exist", () => {
  it("Vercel Production answers 404 on every simulator route — even with the business's own owner token", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BARRY_OWNER_TOKENS", `${BIZ}:${TOKEN}`);
    expect(simulatorEnabled()).toBe(false);
    for (const token of [undefined, TOKEN]) {
      for (const [name, call] of everyRoute(token)) expect((await call()).status, name).toBe(404);
    }
  });

  it("any other production-mode runtime that isn't a Vercel Preview fails closed (404)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("BARRY_OWNER_TOKENS", `${BIZ}:${TOKEN}`);
    expect(simulatorEnabled()).toBe(false);
    for (const [name, call] of everyRoute(TOKEN)) expect((await call()).status, name).toBe(404);
  });

  it("a 404'd request changes nothing: no message injected, no payment settled, no transcript read", async () => {
    const pr = await realCustomerWithPayPlusLink();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    const read = await readConversation(get(`http://x/api/simulator/conversation?businessId=${BIZ}&conversationId=${encodeURIComponent(WA_ID)}`));
    expect(await read.json()).toEqual({ error: "Not found" });
    expect((await sendMessage(post("http://x", { businessId: BIZ, conversationId: WA_ID, customerId: "wa:972500000001", message: "cancel" }))).status).toBe(404);
    expect((await settlePayment(post("http://x", { businessId: BIZ, conversationId: WA_ID, paymentRequestId: pr.id, outcome: "paid" }))).status).toBe(404);
    vi.unstubAllEnvs();
    const after = (await getConversationStore().get(WA_ID))!;
    expect(after.messages.filter((m) => m.role === "customer").map((m) => m.content)).toEqual(["private order details"]);
    const record = (await getBackend().getPaymentRequest(pr.id))!;
    expect(record.status).toBe("pending");
    expect(record.verifiedAt).toBeUndefined();
  });
});

describe("Preview: the simulator is the owner's tool, for their business only", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
  });

  it("without a session every route is refused (401)", async () => {
    vi.stubEnv("BARRY_OWNER_TOKENS", `${BIZ}:${TOKEN},${OTHER}:${OTHER_TOKEN}`);
    for (const [name, call] of everyRoute()) expect((await call()).status, name).toBe(401);
  });

  it("another business's owner is refused (401) — no cross-tenant transcript or injection", async () => {
    vi.stubEnv("BARRY_OWNER_TOKENS", `${BIZ}:${TOKEN},${OTHER}:${OTHER_TOKEN}`);
    for (const [name, call] of everyRoute(OTHER_TOKEN)) expect((await call()).status, name).toBe(401);
  });

  it("a Preview with no owner access configured fails closed (503), never open", async () => {
    vi.stubEnv("BARRY_OWNER_TOKENS", "");
    vi.stubEnv("BARRY_OWNER_TOKEN", "");
    for (const [name, call] of everyRoute()) expect((await call()).status, name).toBe(503);
  });

  it("the business's own owner can read its conversation and graph", async () => {
    vi.stubEnv("BARRY_OWNER_TOKENS", `${BIZ}:${TOKEN}`);
    await realCustomerWithPayPlusLink();
    const read = await readConversation(get(`http://x/api/simulator/conversation?businessId=${BIZ}&conversationId=${encodeURIComponent(WA_ID)}`, TOKEN));
    expect(read.status).toBe(200);
    expect((await read.json()).state?.id).toBe(WA_ID);
    expect((await readGraph(get(`http://x/api/simulator/graph?businessId=${BIZ}`, TOKEN))).status).toBe(200);
  });
});

describe("Test money can never become real revenue", () => {
  it("the store refuses to simulate a payment on a real provider — whoever calls it", async () => {
    const pr = await realCustomerWithPayPlusLink();
    await expect(getBackend().simulatePaymentOutcome(pr.id, "paid")).rejects.toBeInstanceOf(SimulatedPaymentRefusedError);
    const record = (await getBackend().getPaymentRequest(pr.id))!;
    expect(record.status).toBe("pending");
    expect(record.verifiedAt).toBeUndefined();
  });

  it("even the authorized simulator route cannot settle a real-provider payment (403), and Money stays at zero", async () => {
    const pr = await realCustomerWithPayPlusLink();
    // Local/test runtime with no owner access configured: the route is reachable — the store still refuses.
    const res = await settlePayment(post("http://x/api/simulator/payment", { businessId: BIZ, conversationId: WA_ID, paymentRequestId: pr.id, outcome: "paid" }));
    expect(res.status).toBe(403);
    const record = (await getBackend().getPaymentRequest(pr.id))!;
    expect(isVerifiedPaid(record)).toBe(false);
    const state = (await getConversationStore().get(WA_ID))!;
    expect(state.knownFields.__paid).toBeUndefined();
    const summary = revenueSummary({ graph: getBusinessGraph(BIZ), conversations: [state], payments: [record], bookings: [], orders: [], approvals: [] });
    expect(summary.direct).toEqual({});
  });

  it("a simulated payment the simulator settles is test money: shown apart, never in direct revenue", async () => {
    const store = getConversationStore();
    const id = `conv_sim_${Date.now()}`;
    const state = await store.getOrCreate(id, BIZ, "c-sim");
    const pr = await getBackend().createPaymentRequest({ businessId: BIZ, conversationId: id, customerId: "c-sim", amount: 120, currency: "ILS", reason: "test", provider: "memory" });
    state.knownFields.__paymentRequestId = pr.id;
    await store.save(state);
    const settled = await getBackend().simulatePaymentOutcome(pr.id, "paid");
    expect(isVerifiedPaid(settled)).toBe(true);
    expect(isSimulatedPayment(settled)).toBe(true);
    const summary = revenueSummary({ graph: getBusinessGraph(BIZ), conversations: [(await store.get(id))!], payments: [settled], bookings: [], orders: [], approvals: [] });
    expect(summary.direct).toEqual({});
    expect(summary.simulatedPaid).toEqual({ ILS: 120 });
  });

  it("one rule decides what is simulated", () => {
    for (const p of [undefined, "", "memory", "mock-pay", "simulated"]) expect(isSimulatedPaymentProvider(p)).toBe(true);
    for (const p of ["payplus", "stripe"]) expect(isSimulatedPaymentProvider(p)).toBe(false);
  });
});
