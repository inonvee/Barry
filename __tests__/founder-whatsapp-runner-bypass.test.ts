import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { observeGraphSends, whatsappFounderSender } from "@/lib/channels/whatsapp";
import { runFounderWhatsappAcceptance } from "@/app/api/qa/founder-whatsapp/runner";
import { ScriptedModel } from "./support/scripted-model";

/**
 * realGraphSendAttempts is real evidence, not a constant: if a path BYPASSES the QA recording senders and reaches the
 * real WhatsApp transport, the acceptance FAILS — and the send to the synthetic recipient is still blocked before any
 * network call. Simulated here by making the runner's sender override a no-op while founder sending is live.
 */
vi.mock("@/lib/channels/role-routing", async (orig) => ({ ...(await orig<typeof import("@/lib/channels/role-routing")>()), setRoleSendersOverride: () => undefined }));

let graphCalls = 0;
const saved = { ...process.env };
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
  Object.assign(process.env, { WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: "test-app-secret", WHATSAPP_ACCESS_TOKEN: "t", BARRY_WHATSAPP_ROUTES: "PNID-T=fashion-retailer", BARRY_WHATSAPP_SEND: "dry_run", BARRY_OWNER_TOKEN: "test-owner-token-0123456789", BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ", BARRY_WHATSAPP_ROLE_ROUTING: "identity", BARRY_WHATSAPP_FOUNDER_SEND: "live" });
  setReasonerForTests(new ScriptedModel(() => undefined));
  graphCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (/graph\.facebook\.com/.test(String(url))) graphCalls++;
    throw new Error(`no network in this test: ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setReasonerForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("real Graph send instrumentation", () => {
  it("an observer sees every real-transport attempt and can block it before any network call", async () => {
    const seen: string[] = [];
    const stop = observeGraphSends((a) => (seen.push(`${a.role}:${a.to}`), a.to.startsWith("999") ? "block" : undefined));
    try {
      await expect(whatsappFounderSender(fetch, "PNID-T").send("999000000001", { text: "hi" })).rejects.toThrow(/blocked by an acceptance guard/);
    } finally {
      stop();
    }
    expect(seen).toEqual(["founder:999000000001"]);
    expect(graphCalls).toBe(0);
  });

  it("a path that bypasses the QA recording senders fails the acceptance (realGraphSendAttempts > 0) — and still sends nothing", async () => {
    const report = await runFounderWhatsappAcceptance({ appSecret: "test-app-secret" }, { phoneNumberId: "PNID-T", stages: ["shared_line"], runId: `fwa-${Date.now()}` });
    const c = report.checks.find((x) => /^realGraphSendAttempts === 0/.test(x.name));
    expect(c?.ok).toBe(false);
    expect((c?.detail as { realGraphSendAttempts: number; blockedSynthetic: number }).realGraphSendAttempts).toBeGreaterThan(0);
    expect((c?.detail as { realGraphSendAttempts: number; blockedSynthetic: number }).blockedSynthetic).toBe((c?.detail as { realGraphSendAttempts: number }).realGraphSendAttempts);
    expect(report.verdict).toBe("FAIL");
    expect(graphCalls).toBe(0);
  }, 120_000);
});
