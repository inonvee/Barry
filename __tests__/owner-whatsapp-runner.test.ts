import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { resetControlsCacheForTests, loadControls } from "@/lib/hq/controls";
import { listOwnerIdentities } from "@/lib/owner-channel/identity";
import { setOwnerModelForTests } from "@/lib/owner/command-llm";
import { OWA_STAGES, loadOwnerWhatsappReport, runOwnerWhatsappAcceptance } from "@/app/api/qa/owner-whatsapp/runner";
import { GET, POST } from "@/app/api/qa/owner-whatsapp/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * The in-deployment Owner WhatsApp acceptance: it must not exist outside an isolated, dry-run Preview, and its
 * mechanics are sound (run here through the real route handlers and owner gateway with a scripted customer
 * model and no owner model). The verdict that counts is the deployed run on Preview with the live model.
 */

describe("guards", () => {
  it("the route does not exist outside the Preview (this test process is not one) — 404 for GET and POST", async () => {
    expect((await POST(new Request("https://x/api/qa/owner-whatsapp", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await GET(new Request("https://x/api/qa/owner-whatsapp?runId=owa-1"))).status).toBe(404);
  });
});

class FlowModel extends ScriptedModel {
  constructor() {
    super((ctx: ReasonerContext) => {
      const m = ctx.customerMessage ?? "";
      if (/buy the Midnight Wrap Dress/i.test(m)) return { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true } as never;
      if (/add one to my cart/i.test(m)) return { commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true } as never;
      const name = m.match(/My name is (\p{L}+ \p{L}+)/u)?.[1];
      if (/check out|checkout/i.test(m)) return { commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...(name ? { customerInfo: { name, phone: "0501234567" }, evidence: { "customerInfo.name": name, "customerInfo.phone": "0501234567" } } : {}) } as never;
      return undefined;
    });
  }
}

describe("mechanics (real route handlers + owner gateway, scripted model)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    resetControlsCacheForTests();
    setLockStoreForTests(new MemoryLockStore());
    setInboxStoreForTests(new MemoryInboxStore());
    Object.assign(process.env, {
      WHATSAPP_VERIFY_TOKEN: "v",
      WHATSAPP_APP_SECRET: "test-app-secret",
      WHATSAPP_ACCESS_TOKEN: "t",
      BARRY_WHATSAPP_ROUTES: "PNID-T=fashion-retailer",
      BARRY_WHATSAPP_SEND: "dry_run",
      BARRY_OWNER_TOKEN: "test-owner-token-0123456789",
    });
    setReasonerForTests(new FlowModel());
    setOwnerModelForTests({ interpret: null, draft: null });
  });
  afterEach(() => {
    setReasonerForTests(undefined);
    setOwnerModelForTests(undefined);
    setLockStoreForTests(undefined);
    setInboxStoreForTests(undefined);
    resetControlsCacheForTests();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("every stage passes except the deployment-bound check; controls restored; synthetic owner revoked; no secret in the evidence", async () => {
    const before = await loadControls("fashion-retailer");
    const report = await runOwnerWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: [...OWA_STAGES], runId: `owa-${Date.now()}` });
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.stage}: ${c.name} ${JSON.stringify(c.detail ?? "").slice(0, 300)}`);
    // Only Supabase-on-the-Preview-project fails here (memory stores in this process).
    expect(failed).toEqual([expect.stringMatching(/^preflight: durable Supabase storage on the Preview project/)]);
    expect(report.checks.length).toBeGreaterThan(30);
    expect(await loadControls("fashion-retailer")).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness });
    expect((await listOwnerIdentities("fashion-retailer")).filter((l) => l.status === "active" && l.channelUserId.startsWith("9999"))).toHaveLength(0);
    const text = JSON.stringify(await loadOwnerWhatsappReport(report.runId));
    for (const secret of ["test-app-secret", "test-owner-token-0123456789"]) expect(text).not.toContain(secret);
  }, 120_000);
});
