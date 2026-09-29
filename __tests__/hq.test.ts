import { afterEach, describe, expect, it, vi } from "vitest";
import { HQ_COOKIE, founderTokenMatches, hqAuthError, hqConfig, hqSessionValid, issueHqSession } from "@/lib/hq/auth";
import { POST as signIn } from "@/app/api/hq/session/route";
import { findTenant, getHqBusiness, getHqConversation, getHqOverview } from "@/lib/hq/service";
import { hqConversationView } from "@/lib/hq/conversation-view";
import { buildDesignPartnerReadiness } from "@/lib/hq/design-partner";
import { getLearningWorkspace } from "@/lib/learn-business/service";
import { resolveCapabilityProfiles, type CapabilityProfiles } from "@/lib/capabilities";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBusinessGraph } from "@/lib/fixtures";
import { getConversationStore } from "@/lib/state";
import { getBackend, type PaymentRequestRecord } from "@/lib/store";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { ScriptedReasoner } from "./support/semantic-corpus";

const FOUNDER = "f".repeat(20) + "-founder-token-for-tests";

afterEach(() => {
  delete process.env.BARRY_FOUNDER_TOKEN;
  delete process.env.BARRY_OWNER_TOKEN;
  vi.restoreAllMocks();
  setReasonerForTests(undefined);
  setPaymentAdapterForTests(undefined);
});

describe("HQ access: founder-only, off unless explicitly configured", () => {
  it("does not exist without a founder token — in every environment, including dev/test", () => {
    expect(hqConfig().enabled).toBe(false);
    expect(hqAuthError(new Request("https://x.test/api/hq"))?.status).toBe(404);
    expect(founderTokenMatches("anything")).toBe(false);
    expect(hqSessionValid("123.abc")).toBe(false);
  });

  it("rejects weak tokens and a founder token equal to the owner token", () => {
    process.env.BARRY_FOUNDER_TOKEN = "short";
    expect(hqConfig()).toMatchObject({ enabled: false, reason: expect.stringMatching(/at least 32/) });
    process.env.BARRY_FOUNDER_TOKEN = FOUNDER;
    process.env.BARRY_OWNER_TOKEN = FOUNDER;
    expect(hqConfig()).toMatchObject({ enabled: false, reason: expect.stringMatching(/differ/) });
  });

  it("sessions are signed, expire, and die when the token rotates", () => {
    process.env.BARRY_FOUNDER_TOKEN = FOUNDER;
    const { value } = issueHqSession();
    expect(hqSessionValid(value)).toBe(true);
    const [exp] = value.split(".");
    expect(hqSessionValid(`${exp}.${"0".repeat(64)}`)).toBe(false);
    expect(hqSessionValid(`${Number(exp) + 999}.${value.split(".")[1]}`)).toBe(false);
    expect(hqSessionValid(value, (Number(exp) + 1) * 1000)).toBe(false);
    expect(value).not.toContain(FOUNDER);
    process.env.BARRY_FOUNDER_TOKEN = FOUNDER + "-rotated";
    expect(hqSessionValid(value)).toBe(false);
  });

  it("API guard: 401 without a session, OK with the founder bearer or a valid session cookie", () => {
    process.env.BARRY_FOUNDER_TOKEN = FOUNDER;
    process.env.BARRY_OWNER_TOKEN = "owner-token";
    expect(hqAuthError(new Request("https://x.test/api/hq"))?.status).toBe(401);
    expect(hqAuthError(new Request("https://x.test/api/hq", { headers: { authorization: "Bearer owner-token" } }))?.status).toBe(401);
    expect(hqAuthError(new Request("https://x.test/api/hq", { headers: { authorization: `Bearer ${FOUNDER}` } }))).toBeUndefined();
    const { value } = issueHqSession();
    expect(hqAuthError(new Request("https://x.test/api/hq", { headers: { cookie: `${HQ_COOKIE}=${value}` } }))).toBeUndefined();
  });

  it("sign-in sets an httpOnly, SameSite=Strict session only for the right token", async () => {
    process.env.BARRY_FOUNDER_TOKEN = FOUNDER;
    const form = (token: string) => {
      const body = new FormData();
      body.set("token", token);
      return new Request("https://x.test/api/hq/session", { method: "POST", body });
    };
    const bad = await signIn(form("wrong"));
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toMatch(/\/hq\/login\?error=1$/);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const good = await signIn(form(FOUNDER));
    expect(good.headers.get("location")).toMatch(/\/hq$/);
    const cookie = good.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${HQ_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toContain(FOUNDER);

    delete process.env.BARRY_FOUNDER_TOKEN;
    expect((await signIn(form(FOUNDER))).status).toBe(404);
  });
});

describe("HQ read model: tenant-scoped, shared readiness, honest about gaps", () => {
  const SCRIPT: Record<string, Partial<BarryIR>> = {
    "hi, my name is Maya": { intent: "details", customerInfo: { name: "Maya" }, evidence: { "customerInfo.name": "Maya" } },
  };

  async function converse(businessId: string, conv: string) {
    setReasonerForTests(new ScriptedReasoner(SCRIPT));
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    await handleCustomerMessage(getBusinessGraph(businessId), conv, `cust-${conv}`, "hi, my name is Maya");
  }

  it("a conversation is only reachable under its own business; unknown businesses are not found", async () => {
    const fashionConv = `hq-fashion-${Date.now()}`;
    const spaConv = `hq-spa-${Date.now()}`;
    await converse("fashion-retailer", fashionConv);
    await converse("spa", spaConv);

    expect((await getHqConversation("fashion-retailer", fashionConv))?.conversation.id).toBe(fashionConv);
    expect(await getHqConversation("spa", fashionConv)).toBeUndefined();
    expect(await getHqConversation("fashion-retailer", spaConv)).toBeUndefined();
    expect(await getHqConversation("no-such-business", fashionConv)).toBeUndefined();
    expect(findTenant("../spa")).toBeUndefined();
    expect(await getHqBusiness("no-such-business")).toBeUndefined();

    const store = getConversationStore();
    const fashionActivity = await store.listRecentTurnActivity("fashion-retailer", 500);
    expect(fashionActivity.some((t) => t.conversationId === fashionConv)).toBe(true);
    expect(fashionActivity.some((t) => t.conversationId === spaConv)).toBe(false);
    const spaSummaries = await store.listSummariesByBusiness("spa", 500);
    expect(spaSummaries.conversations.map((c) => c.id)).toContain(spaConv);
    expect(spaSummaries.conversations.map((c) => c.id)).not.toContain(fashionConv);

    const detail = await getHqBusiness("spa");
    const everything = JSON.stringify(detail);
    expect(everything).not.toContain(fashionConv);
  });

  it("the trace page is built from the stored conversation and carries no stored customer fields beyond the messages", async () => {
    const conv = `hq-view-${Date.now()}`;
    await converse("fashion-retailer", conv);
    const found = await getHqConversation("fashion-retailer", conv);
    const state = found!.conversation;
    state.knownFields.phone = "0501234567";
    state.knownFields.__paymentRequestId = "pr_secret_id";
    const view = hqConversationView(state);
    expect(view.turns).toHaveLength(state.turns.length);
    expect(view.turns[0].trace?.runtime.constitutionVersion).toBeTruthy();
    expect(view.knownFields).toEqual({ __paymentRequestId: "present" });
    expect(JSON.stringify(view.knownFields)).not.toContain("0501234567");
    // The trace itself never held values.
    expect(JSON.stringify(view.turns.map((t) => t.trace))).not.toContain("Maya");
  });

  it("HQ readiness IS the Learn Business readiness (one computation, not a copy)", async () => {
    for (const id of ["fashion-retailer", "spa"]) {
      const graph = getBusinessGraph(id);
      const [hq, workspace] = await Promise.all([getHqBusiness(id), getLearningWorkspace(graph)]);
      expect(hq!.readiness).toEqual({ ok: true, value: workspace.readiness });
      expect(hq!.capabilities).toEqual({ ok: true, value: workspace.capabilityReport });
    }
  });

  it("a failing source is shown as unavailable — never as zero", async () => {
    vi.spyOn(getBackend(), "listApprovals").mockRejectedValue(new Error("db down"));
    const detail = await getHqBusiness("fashion-retailer");
    expect(detail!.approvals).toEqual({ ok: false, unavailable: "approvals unavailable" });
    expect(detail!.counts.approvalsPending).toBeNull();
    expect(detail!.counts.orders).not.toBeNull();
    const overview = await getHqOverview();
    expect(overview.businesses.find((b) => b.id === "fashion-retailer")!.counts.approvalsTotal).toBeNull();
  });

  it("the overview lists every tenant with a runtime that is either traced or explicitly not tracked", async () => {
    const overview = await getHqOverview();
    expect(overview.businesses.map((b) => b.id)).toEqual(expect.arrayContaining(["fashion-retailer", "spa"]));
    for (const b of overview.businesses) {
      expect(b.runtime.ok).toBe(true);
      expect(Object.keys(b)).not.toContain("_profiles");
    }
  });
});

describe("design-partner readiness is derived, never assumed", () => {
  it("fixture providers: catalog/cart/checkout are simulated, channels are not built, PayPlus is not connected yet", async () => {
    setPaymentAdapterForTests(undefined);
    const profiles = await resolveCapabilityProfiles(getBusinessGraph("fashion-retailer"));
    const rows = buildDesignPartnerReadiness({ profiles, payments: [] });
    const by = Object.fromEntries(rows.map((r) => [r.surface, r.status]));
    expect(by["WhatsApp"]).toBe("not_built");
    expect(by["Instagram"]).toBe("not_built");
    expect(by["Custom website chat"]).toBe("not_built");
    expect(by["Catalog search"]).toBe("simulated");
    expect(by["Checkout"]).toBe("simulated");
    expect(rows.some((r) => r.status === "live_proven")).toBe(false);
  });

  const realProfiles = (): CapabilityProfiles => ({
    commerce: { capability: "commerce", used: true, provider: "custom-commerce", status: "connected", simulated: false, operations: ["catalogSearch", "variants", "liveInventory", "cart", "checkout"], missingOperations: ["orders"], capabilities: ["commerce.catalog.search", "commerce.variants.read", "commerce.inventory.read", "commerce.cart.create", "commerce.cart.update", "commerce.checkout.create"] },
    payments: { capability: "payments", used: true, provider: "payplus", status: "connected", simulated: false, operations: ["paymentLinks", "statusLookup", "webhookVerification"], missingOperations: ["refunds"], capabilities: ["payments.create_request", "payments.verify", "payments.webhook.verify"] },
    scheduling: { capability: "scheduling", used: false, provider: null, status: "not_configured", simulated: false, operations: [], missingOperations: [], capabilities: [] },
    messaging: { capability: "messaging", used: false, provider: null, status: "not_configured", simulated: false, operations: [], missingOperations: ["send"], capabilities: [] },
  });

  it("a real provider is 'ready' until a provider-verified transaction proves it; a missing operation needs the client", () => {
    const rows = buildDesignPartnerReadiness({ profiles: realProfiles(), payments: [] });
    const by = Object.fromEntries(rows.map((r) => [r.surface, r.status]));
    expect(by["Checkout"]).toBe("ready");
    expect(by["Orders"]).toBe("needs_client_provider");
    expect(by["PayPlus payments"]).toBe("ready");

    const paid = { provider: "payplus", status: "paid", verifiedAt: "2026-09-28T00:00:00Z" } as PaymentRequestRecord;
    const proven = buildDesignPartnerReadiness({ profiles: realProfiles(), payments: [paid] });
    expect(proven.find((r) => r.surface === "PayPlus payments")?.status).toBe("live_proven");
    // An unverified "paid" is not proof.
    const claimed = buildDesignPartnerReadiness({ profiles: realProfiles(), payments: [{ ...paid, verifiedAt: undefined }] });
    expect(claimed.find((r) => r.surface === "PayPlus payments")?.status).toBe("ready");
  });
});
