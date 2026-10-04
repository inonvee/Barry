import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { applyControlChange, loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { listFounderIdentities } from "@/lib/founder-channel/identity";
import { ensureRestorePoint, readRestorePoint } from "@/lib/qa/restore-point";
import { FWA_STAGES, loadFounderWhatsappReport, runFounderWhatsappAcceptance } from "@/app/api/qa/founder-whatsapp/runner";
import { GET, POST } from "@/app/api/qa/founder-whatsapp/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * The in-deployment Founder WhatsApp acceptance: it must not exist outside an isolated, dry-run Preview, and its
 * mechanics are sound — run here through the real founder gateway, owner gateway and WhatsApp route with a scripted
 * customer model and no founder model. The verdict that counts is the deployed run with the live model.
 */

describe("guards", () => {
  it("the route does not exist outside the Preview — 404 for GET and POST", async () => {
    expect((await POST(new Request("https://x/api/qa/founder-whatsapp", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await GET(new Request("https://x/api/qa/founder-whatsapp?runId=fwa-1"))).status).toBe(404);
  });
});

describe("mechanics", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    resetControlsCacheForTests();
    setLockStoreForTests(new MemoryLockStore());
    setInboxStoreForTests(new MemoryInboxStore());
    Object.assign(process.env, { WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: "test-app-secret", WHATSAPP_ACCESS_TOKEN: "t", BARRY_WHATSAPP_ROUTES: "PNID-T=fashion-retailer", BARRY_WHATSAPP_SEND: "dry_run", BARRY_OWNER_TOKEN: "test-owner-token-0123456789", BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ" });
    setReasonerForTests(new ScriptedModel(() => undefined));
  });
  afterEach(() => {
    setReasonerForTests(undefined);
    setLockStoreForTests(undefined);
    setInboxStoreForTests(undefined);
    resetControlsCacheForTests();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const failures = (r: { checks: { ok: boolean; stage: string; name: string; detail?: unknown }[] }) => r.checks.filter((c) => !c.ok).map((c) => `${c.stage}: ${c.name} ${JSON.stringify(c.detail ?? "").slice(0, 400)}`);

  it("each stage run ALONE passes except the deployment-bound check; every lever restored; synthetic founders revoked; no secret stored", async () => {
    const before = await loadControls("fashion-retailer");
    for (const stage of FWA_STAGES) {
      const report = await runFounderWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: [stage], runId: `fwa-${Date.now()}` });
      expect(failures(report), stage).toEqual([expect.stringMatching(/^preflight: durable Supabase storage on the Preview project/)]);
      const after = await loadControls("fashion-retailer");
      expect(after).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness, approvalRequiredForAll: before.approvalRequiredForAll, pausedCapabilities: before.pausedCapabilities, safeMode: before.safeMode });
      expect(await readRestorePoint("fashion-retailer")).toBeUndefined();
      expect((await listFounderIdentities()).filter((l) => l.status === "active" && l.channelUserId.startsWith("999"))).toHaveLength(0);
      const text = JSON.stringify(await loadFounderWhatsappReport(report.runId));
      for (const secret of ["test-app-secret", "test-owner-token-0123456789", "test-founder-token-0123456789abcdefXYZ"]) expect(text).not.toContain(secret);
    }
  }, 240_000);

  it("a killed earlier run (paused + approval-for-all + a paused capability) is recovered to the TRUE original by the next stage", async () => {
    const original = await loadControls("fashion-retailer");
    await ensureRestorePoint("fashion-retailer", "founder (qa test)");
    await applyControlChange("fashion-retailer", { pausedBusiness: true, approvalRequiredForAll: true, pausedCapabilities: ["payments.*"] }, { by: "founder (qa test)", reason: "simulated killed run" });
    const report = await runFounderWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: ["identity"], runId: `fwa-${Date.now()}` });
    expect(report.checks.find((c) => /recovered the test business/.test(c.name))?.ok).toBe(true);
    expect(await loadControls("fashion-retailer")).toMatchObject({ pausedBusiness: original.pausedBusiness, approvalRequiredForAll: original.approvalRequiredForAll, pausedCapabilities: original.pausedCapabilities });
  }, 60_000);

  it("a stage out of its time budget stops between steps, fails clearly, and still restores", async () => {
    const report = await runFounderWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: ["mutations"], runId: `fwa-${Date.now()}`, budgetMs: 0 });
    expect(report.checks.some((c) => !c.ok && /exceeded its 0s time budget/.test(c.name))).toBe(true);
    expect(report.checks.find((c) => /test business restored/.test(c.name))?.ok).toBe(true);
  }, 60_000);
});
