import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { applyControlChange, resetControlsCacheForTests, loadControls } from "@/lib/hq/controls";
import { ensureRestorePoint, readRestorePoint, restoreFromPoint } from "@/lib/qa/restore-point";
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

/** Whether the scripted model hands a "speak with someone" request to a person (as the live model did on Preview). */
let modelHandsOff = false;

class FlowModel extends ScriptedModel {
  constructor() {
    super((ctx: ReasonerContext) => {
      const m = ctx.customerMessage ?? "";
      if (modelHandsOff && /speak with someone/i.test(m)) return { handoff: { reason: "The customer asked to speak with a person.", urgency: "normal" }, advancesTransaction: false } as never;
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
    modelHandsOff = false;
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

  const onlySupabase = (report: { checks: { ok: boolean; stage: string; name: string; detail?: unknown }[] }) => report.checks.filter((c) => !c.ok).map((c) => `${c.stage}: ${c.name} ${JSON.stringify(c.detail ?? "").slice(0, 300)}`);

  it("each stage run ALONE (as the QA page does, one request per stage) passes on its own and leaves the business restored", async () => {
    const before = await loadControls("fashion-retailer");
    for (const stage of OWA_STAGES) {
      const report = await runOwnerWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: [stage], runId: `owa-${Date.now()}` });
      expect(onlySupabase(report), stage).toEqual([expect.stringMatching(/^preflight: durable Supabase storage on the Preview project/)]);
      expect(await loadControls("fashion-retailer")).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness });
      expect(await readRestorePoint("fashion-retailer")).toBeUndefined();
    }
  }, 180_000);

  it("a run that died mid-way (SUPERVISED + paused, synthetic owner still linked) is recovered by the next run, to the TRUE original", async () => {
    const original = await loadControls("fashion-retailer");
    // A previous run recorded the original, changed the business, and was killed before its restore.
    await ensureRestorePoint("fashion-retailer", "founder (qa test)");
    await applyControlChange("fashion-retailer", { mode: "supervised", pausedBusiness: true }, { by: "founder (qa test)", reason: "simulated killed run" });
    const report = await runOwnerWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: ["identity"], runId: `owa-${Date.now()}` });
    expect(report.checks.find((c) => /recovered the test business/.test(c.name))?.ok).toBe(true);
    expect(await loadControls("fashion-retailer")).toMatchObject({ mode: original.mode, pausedBusiness: original.pausedBusiness });
    expect(await readRestorePoint("fashion-retailer")).toBeUndefined();
  }, 60_000);

  it("a stage that runs out of its time budget stops between steps, FAILS clearly, and still restores", async () => {
    const original = await loadControls("fashion-retailer");
    const report = await runOwnerWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: ["decisions"], runId: `owa-${Date.now()}`, budgetMs: 0 });
    expect(report.verdict).toBe("FAIL");
    expect(report.checks.some((c) => !c.ok && /exceeded its 0s time budget/.test(c.name))).toBe(true);
    expect(report.checks.find((c) => /restored to its original mode/.test(c.name))?.ok).toBe(true);
    expect(await loadControls("fashion-retailer")).toMatchObject({ mode: original.mode, pausedBusiness: original.pausedBusiness });
    expect((await listOwnerIdentities("fashion-retailer")).filter((l) => l.status === "active" && l.channelUserId.startsWith("999"))).toHaveLength(0);
  }, 60_000);

  it("restore on demand: original controls back, synthetic owner links revoked, point cleared; idempotent", async () => {
    const original = await loadControls("fashion-retailer");
    await ensureRestorePoint("fashion-retailer", "founder (qa test)");
    // A second ensure (e.g. the next stage) never overwrites the true original.
    await applyControlChange("fashion-retailer", { mode: "supervised", pausedBusiness: true }, { by: "founder (qa test)", reason: "changed" });
    expect((await ensureRestorePoint("fashion-retailer", "founder (qa test)")).mode).toBe(original.mode);
    const r = await restoreFromPoint("fashion-retailer", "founder (qa test)", "restore");
    expect(r).toMatchObject({ restored: true, hadRestorePoint: true, mode: original.mode, pausedBusiness: original.pausedBusiness });
    expect(await readRestorePoint("fashion-retailer")).toBeUndefined();
    expect(await restoreFromPoint("fashion-retailer", "founder (qa test)", "again")).toMatchObject({ restored: true, hadRestorePoint: false });
  });

  type Detail = { handoff?: string; handoffBy: string; notifiedBy: string; notices: { key: string; status: string; items?: string[] }[] };
  const notifCheck = (report: { checks: { name: string; ok: boolean; detail?: unknown }[] }) => report.checks.find((c) => /exactly one durable owner attention notice/.test(c.name))!;

  it("REGRESSION (deployed owa-1791136227220): the customer webhook hands off AND notifies before the runner's own call — exactly one durable notice, the stage passes", async () => {
    modelHandsOff = true;
    const report = await runOwnerWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: ["notifications"], runId: `owa-${Date.now()}` });
    const c = notifCheck(report);
    const d = c.detail as Detail;
    // The deployed path: the live model's handoff, notified by the webhook — the runner's later call returns [].
    expect(d.handoffBy).toMatch(/live model/);
    expect(d.notifiedBy).toBe("the customer webhook");
    expect(c.ok).toBe(true);
    expect(d.notices).toHaveLength(1);
    expect(["dry_run", "blocked"]).toContain(d.notices[0].status);
    expect(d.notices[0].items).toContain(`handoff:${d.handoff}`); // coalesced with anything else new for this owner
    expect(report.checks.find((x) => /never sent twice/.test(x.name))).toMatchObject({ ok: true, detail: { againReturned: 0, durableForHandoff: 1 } });
    expect(onlySupabase(report)).toEqual([expect.stringMatching(/^preflight: durable Supabase storage/)]);
  }, 60_000);

  it("the other path: the model does not hand off — the runner creates the handoff and its fallback call produces the one notice", async () => {
    const report = await runOwnerWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: ["notifications"], runId: `owa-${Date.now()}` });
    const c = notifCheck(report);
    const d = c.detail as Detail;
    expect(d.handoffBy).toMatch(/runner/);
    expect(d.notifiedBy).toMatch(/runner/);
    expect(c.ok).toBe(true);
    expect(d.notices).toHaveLength(1);
    expect(report.checks.find((x) => /never sent twice/.test(x.name))?.ok).toBe(true);
  }, 60_000);
});
