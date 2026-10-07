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
import { COEX_STAGES, runCoexistenceAcceptance } from "@/app/api/qa/whatsapp-coexistence/runner";
import { GET, POST } from "@/app/api/qa/whatsapp-coexistence/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * The deployed WhatsApp coexistence + takeover acceptance: it doesn't exist outside an isolated Preview, and its
 * mechanics are sound — every stage runs here through the real signed webhook, routing, takeover and gateway with a
 * scripted customer model. Only the deployment-bound checks (Preview database / environment) fail in this process.
 */

describe("guards", () => {
  it("404 outside the Preview", async () => {
    expect((await POST(new Request("https://x/api/qa/whatsapp-coexistence", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await GET(new Request("https://x/api/qa/whatsapp-coexistence?runId=coex-1"))).status).toBe(404);
  });
});

let graphCalls = 0;
describe("mechanics", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    resetControlsCacheForTests();
    setLockStoreForTests(new MemoryLockStore());
    setInboxStoreForTests(new MemoryInboxStore());
    Object.assign(process.env, { WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: "test-app-secret", WHATSAPP_ACCESS_TOKEN: "t", BARRY_WHATSAPP_ROUTES: "PNID-T=fashion-retailer", BARRY_WHATSAPP_SEND: "dry_run", BARRY_OWNER_TOKEN: "test-owner-token-0123456789", BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ", BARRY_WHATSAPP_ROLE_ROUTING: "identity", BARRY_WHATSAPP_FOUNDER_SEND: "live" });
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
    expect(graphCalls).toBe(0);
    setReasonerForTests(undefined);
    setOwnerModelForTests(undefined);
    setLockStoreForTests(undefined);
    setInboxStoreForTests(undefined);
    resetControlsCacheForTests();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const failures = (r: { checks: { ok: boolean; stage: string; name: string; detail?: unknown }[] }) => r.checks.filter((c) => !c.ok).map((c) => `${c.stage}: ${c.name} ${JSON.stringify(c.detail ?? "").slice(0, 400)}`);

  it("each stage run ALONE passes except the deployment-bound checks; restored; numbers, signals, conversations, identities removed; zero real sends", async () => {
    const before = await loadControls("fashion-retailer");
    for (const stage of COEX_STAGES) {
      const report = await runCoexistenceAcceptance({ appSecret: "test-app-secret" }, { controlLine: "PNID-T", stages: [stage], runId: `coex-${Date.now()}` });
      expect(failures(report), stage).toEqual([expect.stringMatching(/^preflight: durable Supabase storage on the Preview project/), expect.stringMatching(/^restore: Production untouched/)]);
      expect(report.checks.filter((c) => c.stage === stage).length, stage).toBeGreaterThan(1);
      expect(await loadControls("fashion-retailer")).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness });
      expect(await readRestorePoint("fashion-retailer")).toBeUndefined();
      expect(await countSyntheticIdentities()).toEqual({ syntheticOwnersActive: 0, syntheticFoundersActive: 0 });
      expect((await allBusinessNumbers()).filter((n) => n.phoneNumberId.startsWith("999"))).toHaveLength(0);
      for (const id of report.conversations) expect(await getConversationStore().get(id), `${stage} ${id}`).toBeUndefined();
      expect(report.checks.find((c) => /^realGraphSendAttempts === 0/.test(c.name))).toMatchObject({ ok: true });
    }
  }, 300_000);

  it("REGRESSION (deployed coex-1791228135489): the first turn legitimately hands off → B still proves the INITIAL holder was BARRY, with full evidence", async () => {
    setReasonerForTests(new ScriptedModel((ctx) => (/open on Friday/i.test(ctx.customerMessage ?? "") ? ({ handoff: { reason: "The customer asked something only the team can answer.", urgency: "normal" }, advancesTransaction: false } as never) : undefined)));
    const report = await runCoexistenceAcceptance({ appSecret: "test-app-secret" }, { controlLine: "PNID-T", stages: ["routing"], runId: `coex-${Date.now()}` });
    const b = report.checks.find((c) => /^B: /.test(c.name))!;
    expect(b.ok).toBe(true);
    expect(b.detail).toMatchObject({ initialHolder: "barry", finalHolder: "human", openHandoffAfterTurn: true });
    expect((b.detail as { controlLog: { from: string; to: string }[] }).controlLog).toEqual([expect.objectContaining({ from: "barry", to: "human" })]);
  }, 120_000);

  it("B FAILS — with the observed holder — when the conversation did not start with BARRY (never evidence-less)", async () => {
    const { getConversationStore: store } = await import("@/lib/state");
    const { giveToHuman } = await import("@/lib/runtime/control");
    const runId = `coex-${Date.now()}`;
    const d6 = String(parseInt(runId.replace(/\D/g, "").slice(-7), 10)).padStart(7, "0").slice(1);
    const phone = `99956${d6}1`;
    const id = `wa:fashion-retailer:${phone}`;
    // The conversation already exists, held by a person, before the stage's first customer message.
    const st = await store().getOrCreate(id, "fashion-retailer", `wa:${phone}`);
    giveToHuman(st, "the owner (web)", "test: already held");
    await store().save(st);
    const report = await runCoexistenceAcceptance({ appSecret: "test-app-secret" }, { controlLine: "PNID-T", stages: ["routing"], runId });
    const b = report.checks.find((c) => /^B: /.test(c.name))!;
    expect(b.ok).toBe(false);
    expect(b.detail).toMatchObject({ initialHolder: "human", finalHolder: "human", openHandoffAfterTurn: false });
    expect((b.detail as { initialControlLog: unknown[] }).initialControlLog).toEqual([expect.objectContaining({ to: "human", by: "the owner (web)" })]);
    expect(await store().get(id)).toBeUndefined();
  }, 120_000);
});
