import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { setOwnerModelForTests } from "@/lib/owner/command-llm";
import { countSyntheticIdentities, readRestorePoint } from "@/lib/qa/restore-point";
import { allBusinessNumbers } from "@/lib/channels/business-numbers";
import { getConversationStore } from "@/lib/state";
import { COEX_ROUTING_ONLY, COEX_STAGES, type CoexReport } from "@/app/api/qa/whatsapp-coexistence/runner";
import { stageRequestBodies } from "@/app/hq/qa/owner-whatsapp/SequentialRunner";
import { ScriptedModel } from "./support/scripted-model";

/**
 * The QA page's "Run routing only" control. Only the deployment guards are replaced here (this process is not a Vercel
 * Preview and has no HQ session); the ROUTE HANDLER and the RUNNER are the real ones the deployed page calls.
 */
vi.mock("@/lib/qa/preview-acceptance-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/qa/preview-acceptance-guard")>()),
  previewAcceptanceRefusal: () => null,
  acceptanceCredentials: () => ({ ok: true, appSecret: "test-app-secret", ownerToken: "test-owner-token-0123456789", founderToken: "f", cronSecret: "c" }),
  routedPhoneNumberId: () => "PNID-T",
}));
vi.mock("@/lib/hq/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/hq/auth")>()), hqAuthError: () => undefined }));

let graphCalls = 0;
const saved = { ...process.env };
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
  Object.assign(process.env, { WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: "test-app-secret", WHATSAPP_ACCESS_TOKEN: "t", BARRY_WHATSAPP_ROUTES: "PNID-T=fashion-retailer", BARRY_WHATSAPP_SEND: "dry_run", BARRY_OWNER_TOKEN: "test-owner-token-0123456789", BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ", BARRY_WHATSAPP_ROLE_ROUTING: "identity" });
  setReasonerForTests(new ScriptedModel(() => undefined));
  setOwnerModelForTests({ interpret: null, draft: null });
  graphCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (/graph\.facebook\.com/.test(String(url))) graphCalls++;
    throw new Error(`no network in this test: ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setReasonerForTests(undefined);
  setOwnerModelForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("“Run routing only” runs ONLY the routing stage", () => {
  it("the control's request is exactly one POST with stages = [\"routing\"] (the full-suite control is unchanged)", () => {
    expect(COEX_ROUTING_ONLY).toEqual(["routing"]);
    expect(stageRequestBodies(COEX_ROUTING_ONLY)).toEqual([{ stages: ["routing"] }]);
    expect(stageRequestBodies(COEX_STAGES)).toEqual(COEX_STAGES.map((s) => ({ stages: [s] })));
  });

  it("that request through the real route + runner: only routing checks run; restore, cleanup and realGraphSendAttempts = 0 still asserted", async () => {
    const before = await loadControls("fashion-retailer");
    const { POST } = await import("@/app/api/qa/whatsapp-coexistence/route");
    const [body] = stageRequestBodies(COEX_ROUTING_ONLY);
    const res = await POST(new Request("https://x/api/qa/whatsapp-coexistence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const report = (await res.json()) as CoexReport;
    expect(report.stages).toEqual(["routing"]);
    expect(report.runId).toMatch(/^coex-\d+$/);
    const stagesRun = [...new Set(report.checks.map((c) => c.stage))].sort();
    expect(stagesRun).toEqual(["preflight", "restore", "routing"]);
    for (const other of ["takeover", "race", "return", "isolation"]) expect(report.checks.some((c) => c.stage === other)).toBe(false);
    // Check B carries the full evidence.
    const b = report.checks.find((c) => /^B: /.test(c.name))!;
    expect(b.detail).toEqual(expect.objectContaining({ initialHolder: "barry", initialControlLog: expect.any(Array), finalHolder: expect.any(String), controlLog: expect.any(Array), openHandoffAfterTurn: expect.any(Boolean) }));
    // Restore / cleanup ran and realGraphSendAttempts = 0 is asserted.
    expect(report.checks.find((c) => /^realGraphSendAttempts === 0/.test(c.name))).toMatchObject({ ok: true });
    expect(report.checks.find((c) => /business controls restored/.test(c.name))?.ok).toBe(true);
    expect(await loadControls("fashion-retailer")).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness });
    expect(await readRestorePoint("fashion-retailer")).toBeUndefined();
    expect(await countSyntheticIdentities()).toEqual({ syntheticOwnersActive: 0, syntheticFoundersActive: 0 });
    expect((await allBusinessNumbers()).filter((n) => n.phoneNumberId.startsWith("999"))).toHaveLength(0);
    for (const id of report.conversations) expect(await getConversationStore().get(id)).toBeUndefined();
    expect(graphCalls).toBe(0);
  }, 120_000);

  it("cleanup and restore still run when routing FAILS (a conversation already held by a person)", async () => {
    const { POST } = await import("@/app/api/qa/whatsapp-coexistence/route");
    const { giveToHuman } = await import("@/lib/runtime/control");
    // The runner derives its synthetic numbers from runId = coex-<Date.now()>: pin the clock so the seeded conversation matches.
    const fixed = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(fixed);
    const d6 = String(parseInt(String(fixed).slice(-7), 10)).padStart(7, "0").slice(1);
    const id = `wa:fashion-retailer:99956${d6}1`;
    const st = await getConversationStore().getOrCreate(id, "fashion-retailer", "wa:x");
    giveToHuman(st, "the owner (web)", "test: already held");
    await getConversationStore().save(st);
    const res = await POST(new Request("https://x/api/qa/whatsapp-coexistence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(stageRequestBodies(COEX_ROUTING_ONLY)[0]) }));
    vi.restoreAllMocks();
    const report = (await res.json()) as CoexReport;
    expect(res.status).toBe(422);
    expect(report.verdict).toBe("FAIL");
    expect(report.checks.find((c) => /^B: /.test(c.name))).toMatchObject({ ok: false, detail: expect.objectContaining({ initialHolder: "human" }) });
    expect(report.checks.find((c) => /^realGraphSendAttempts === 0/.test(c.name))?.ok).toBe(true);
    expect(report.checks.find((c) => /business controls restored/.test(c.name))?.ok).toBe(true);
    expect(await getConversationStore().get(id)).toBeUndefined();
    expect((await allBusinessNumbers()).filter((n) => n.phoneNumberId.startsWith("999"))).toHaveLength(0);
  }, 120_000);
});
