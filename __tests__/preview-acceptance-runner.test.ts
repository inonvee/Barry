import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { resetControlsCacheForTests, loadControls } from "@/lib/hq/controls";
import { acceptanceCredentials, previewAcceptanceRefusal, routedPhoneNumberId } from "@/lib/qa/preview-acceptance-guard";
import { runPreviewAcceptance, loadAcceptanceReport } from "@/app/api/qa/acceptance/runner";
import { GET, POST } from "@/app/api/qa/acceptance/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * The in-deployment Preview acceptance: its guards (it must not exist outside an isolated, dry-run Preview) and
 * its mechanics, run here against the real route handlers with a scripted model. The verdict that counts is
 * the deployed run on Preview with the live model; this proves the runner itself is sound.
 */

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  SUPABASE_URL: "https://glqrfoljvdbyrmbvupym.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-not-a-key",
  BARRY_WHATSAPP_SEND: "dry_run",
} as unknown as NodeJS.ProcessEnv;

describe("guards", () => {
  it("refuses everything but an isolated, dry-run Preview on the Preview database", () => {
    expect(previewAcceptanceRefusal(PREVIEW_ENV)).toBeNull();
    expect(previewAcceptanceRefusal({ ...PREVIEW_ENV, VERCEL_ENV: "production" })).toMatch(/not a Vercel Preview/);
    expect(previewAcceptanceRefusal({ ...PREVIEW_ENV, VERCEL_ENV: undefined })).toMatch(/not a Vercel Preview/);
    expect(previewAcceptanceRefusal({ ...PREVIEW_ENV, SUPABASE_URL: "https://ynnmlsnmybbaxeyolydj.supabase.co" })).toMatch(/Production database/);
    expect(previewAcceptanceRefusal({ ...PREVIEW_ENV, SUPABASE_URL: "https://someotherproject.supabase.co" })).toMatch(/not on the Preview database/);
    expect(previewAcceptanceRefusal({ ...PREVIEW_ENV, SUPABASE_SERVICE_ROLE_KEY: "" })).toMatch(/durable storage/);
    expect(previewAcceptanceRefusal({ ...PREVIEW_ENV, BARRY_WHATSAPP_SEND: "live" })).toMatch(/dry_run/);
    expect(previewAcceptanceRefusal({ ...PREVIEW_ENV, BARRY_WHATSAPP_SEND: undefined })).toMatch(/dry_run/);
  });

  it("names missing credentials without echoing any value; finds the routed test number", () => {
    const r = acceptanceCredentials("fashion-retailer", { WHATSAPP_APP_SECRET: "s3cret-value", CRON_SECRET: "" } as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("s3cret-value");
    expect(routedPhoneNumberId("fashion-retailer", { BARRY_WHATSAPP_ROUTES: "111=spa, 1315221915012159=fashion-retailer" } as unknown as NodeJS.ProcessEnv)).toBe("1315221915012159");
  });

  it("the route does not exist outside the Preview (this test process is not one) — 404 for GET and POST", async () => {
    expect((await POST(new Request("https://x/api/qa/acceptance", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await GET(new Request("https://x/api/qa/acceptance?runId=qa-1"))).status).toBe(404);
  });
});

/** A scripted model playing the customer flows the runner sends (the deployed run uses the live model). */
class FlowModel extends ScriptedModel {
  constructor() {
    super((ctx: ReasonerContext) => {
      const m = ctx.customerMessage ?? "";
      if (/buy the Midnight Wrap Dress/i.test(m)) return { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true } as never;
      if (/add one to my cart/i.test(m)) return { commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true } as never;
      if (/check out|checkout/i.test(m)) return { commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, customerInfo: { name: "Dana Levi", phone: "0501234567" }, evidence: { "customerInfo.name": "Dana Levi", "customerInfo.phone": "0501234567" } } as never;
      return undefined;
    });
  }
}

describe("mechanics (real route handlers, scripted model)", () => {
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
      BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ",
      CRON_SECRET: "test-cron-secret-0123456789",
    });
    setReasonerForTests(new FlowModel());
  });
  afterEach(() => {
    setReasonerForTests(undefined);
    setLockStoreForTests(undefined);
    setInboxStoreForTests(undefined);
    resetControlsCacheForTests();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("runs every stage through the real routes; everything not tied to the deployment (live model, Supabase) passes; controls restored; evidence stored without secrets", async () => {
    const creds = acceptanceCredentials("fashion-retailer");
    if (!creds.ok) throw new Error("test credentials missing");
    const before = await loadControls("fashion-retailer");
    const report = await runPreviewAcceptance(creds, { phoneNumberId: "PNID-T", stages: ["channel", "handoff", "supervised", "mode", "cron"], runId: `qa-${Date.now()}` });
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    // Only the deployment-bound check fails here: Supabase on the Preview project (this run uses memory stores;
    // the scripted test model reports itself as the live-model kind, so the reasoner checks are not meaningful here).
    expect(failed).toEqual(["durable Supabase storage on the Preview project"]);
    expect(report.checks.length).toBeGreaterThan(25);
    expect(await loadControls("fashion-retailer")).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness });
    const stored = await loadAcceptanceReport(report.runId);
    expect(stored?.verdict).toBe("FAIL");
    const text = JSON.stringify(stored);
    for (const secret of ["test-app-secret", "test-owner-token-0123456789", "test-founder-token-0123456789abcdefXYZ", "test-cron-secret-0123456789"]) expect(text).not.toContain(secret);
  }, 60_000);
});
