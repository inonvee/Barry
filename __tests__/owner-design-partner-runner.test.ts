import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { setOwnerModelForTests } from "@/lib/owner/command-llm";
import { countSyntheticIdentities, readRestorePoint } from "@/lib/qa/restore-point";
import { getConversationStore } from "@/lib/state";
import { ODP_STAGES, loadOwnerDesignPartnerReport, runOwnerDesignPartnerAcceptance } from "@/app/api/qa/owner-design-partner/runner";
import { GET, POST } from "@/app/api/qa/owner-design-partner/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * The deployed Owner Design Partner acceptance: it must not exist outside an isolated Preview, and its mechanics are
 * sound — every stage runs here through the real signed webhook, identity role routing, the owner / founder gateways
 * and the shared command services, with a scripted customer model and no owner model. Founder sending is LIVE in this
 * process (as on Preview): any call to the WhatsApp API would be a real send — the acceptance must make none.
 */

describe("guards", () => {
  it("the route does not exist outside the Preview — 404 for GET and POST", async () => {
    expect((await POST(new Request("https://x/api/qa/owner-design-partner", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await GET(new Request("https://x/api/qa/owner-design-partner?runId=odp-1"))).status).toBe(404);
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

let graphCalls = 0;

describe("mechanics (real webhook + role routing + gateways, scripted model)", () => {
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
      BARRY_WHATSAPP_ROLE_ROUTING: "identity",
      BARRY_WHATSAPP_FOUNDER_SEND: "live",
    });
    setReasonerForTests(new FlowModel());
    setOwnerModelForTests({ interpret: null, draft: null });
    graphCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (/graph\.facebook\.com/.test(String(url))) graphCalls++;
      throw new Error(`no network in this test: ${url}`);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(graphCalls).toBe(0);
    setReasonerForTests(undefined);
    setOwnerModelForTests(undefined);
    setLockStoreForTests(undefined);
    setInboxStoreForTests(undefined);
    resetControlsCacheForTests();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const failures = (r: { checks: { ok: boolean; stage: string; name: string; detail?: unknown }[] }) => r.checks.filter((c) => !c.ok).map((c) => `${c.stage}: ${c.name} ${JSON.stringify(c.detail ?? "").slice(0, 500)}`);

  it("each stage run ALONE passes except the deployment-bound check; restored; identities revoked; conversations deleted; zero real sends; no secret stored", async () => {
    const before = await loadControls("fashion-retailer");
    for (const stage of ODP_STAGES) {
      const report = await runOwnerDesignPartnerAcceptance({ appSecret: "test-app-secret", ownerToken: "test-owner-token-0123456789" }, { phoneNumberId: "PNID-T", stages: [stage], runId: `odp-${Date.now()}` });
      expect(failures(report), stage).toEqual([expect.stringMatching(/^preflight: durable Supabase storage on the Preview project/)]);
      expect(report.checks.filter((c) => c.stage === stage).length, stage).toBeGreaterThan(1);
      expect(await loadControls("fashion-retailer")).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness, approvalRequiredForAll: before.approvalRequiredForAll });
      expect(await readRestorePoint("fashion-retailer")).toBeUndefined();
      expect(await countSyntheticIdentities()).toEqual({ syntheticOwnersActive: 0, syntheticFoundersActive: 0 });
      for (const id of report.conversations) expect(await getConversationStore().get(id), `${stage} ${id}`).toBeUndefined();
      expect(report.checks.find((c) => /^realGraphSendAttempts === 0/.test(c.name))).toMatchObject({ ok: true, detail: { realGraphSendAttempts: 0 } });
      const text = JSON.stringify(await loadOwnerDesignPartnerReport(report.runId));
      for (const secret of ["test-app-secret", "test-owner-token-0123456789", "test-founder-token-0123456789abcdefXYZ"]) expect(text).not.toContain(secret);
    }
  }, 300_000);

  it("a stage out of its time budget stops between steps, fails clearly, and still restores and cleans up", async () => {
    const report = await runOwnerDesignPartnerAcceptance({ appSecret: "test-app-secret", ownerToken: "test-owner-token-0123456789" }, { phoneNumberId: "PNID-T", stages: ["handoff"], runId: `odp-${Date.now()}`, budgetMs: 0 });
    expect(report.verdict).toBe("FAIL");
    expect(report.checks.some((c) => !c.ok && /exceeded its 0s time budget/.test(c.name))).toBe(true);
    expect(report.checks.find((c) => /test business restored/.test(c.name))?.ok).toBe(true);
    expect(await countSyntheticIdentities()).toEqual({ syntheticOwnersActive: 0, syntheticFoundersActive: 0 });
  }, 60_000);
});
