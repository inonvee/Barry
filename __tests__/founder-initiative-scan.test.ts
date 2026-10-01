import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { fleetTenant } from "@/lib/hq/fleet";
import { listInitiatives, listScans } from "@/lib/initiative/store";
import * as engine from "@/lib/initiative/engine";
import { interpretFounder } from "@/lib/founder/command";
import { executeFounderCommand, getFounderCommand, type FounderActor } from "@/lib/founder/command-service";
import { ScriptedModel, conv } from "./support/scripted-model";

/**
 * FOUNDER → INITIATIVE SCAN BRIDGE — "Run an initiative scan for Rina Studio" is its own intent (never an
 * initiative read) and runs ONE bounded scan of ONE exactly-resolved business through the existing
 * Initiative Engine. Limits, dedupe, verification and persistence are the engine's; the bridge adds only
 * explicit founder-force wording.
 */
const founder: FounderActor = { kind: "founder", via: "test" };
let n = 0;
// Daily scan limits count per business-local day: each test uses its own day so the 3-per-day budget is its own.
const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600_000);
const ask = (text: string, offset = 0) => executeFounderCommand({ actor: founder, key: `fis-${Date.now()}-${n++}`, text, now: day(offset) });
const D = "fashion-retailer";
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
});

const SHIPPING = { knowledgeTopic: "shipping", asks: [{ ask: "how much is shipping", kind: "question", coveredByThisIR: true, topic: "shipping" }], advancesTransaction: false };
async function seedRepeatedQuestions(count: number) {
  const model = new ScriptedModel(() => SHIPPING as never);
  setReasonerForTests(model);
  const g = fleetTenant(D)!;
  for (let i = 0; i < count; i++) await handleCustomerMessage(g, conv("fis"), "c", "how much is shipping?");
}

describe("interpretation", () => {
  it("scan phrasings are initiative_scan, never initiative_read; reads stay reads", () => {
    for (const t of ["Run an initiative scan for Rina Studio.", "Scan Rina Studio for initiatives.", "See if BARRY notices anything new at Rina Studio.", "Run a fresh initiative scan for Rina."]) {
      expect(interpretFounder(t, { hasBusiness: true }), t).toEqual({ family: "initiative_scan", force: false });
    }
    expect(interpretFounder("What did BARRY notice at Rina Studio?", { hasBusiness: true })).toEqual({ family: "initiative_read" });
    expect(interpretFounder("What did BARRY notice across the fleet?")).toEqual({ family: "initiative_read" });
  });

  it("force only with explicit founder QA wording", () => {
    expect(interpretFounder("Force an initiative scan for Rina Studio for QA.", { hasBusiness: true })).toEqual({ family: "initiative_scan", force: true });
    expect(interpretFounder("Run an initiative scan for Rina Studio.", { hasBusiness: true })).toEqual({ family: "initiative_scan", force: false });
  });
});

describe("the bridge", () => {
  it("unknown, missing or ambiguous business → no scan", async () => {
    const spy = (await import("vitest")).vi.spyOn(engine, "runInitiativeScan");
    const before = (await listScans(D)).length;
    for (const t of ["Run an initiative scan for Globex Industries.", "Run an initiative scan.", "Scan Rina Studio and Oakhaven for initiatives."]) {
      const r = await ask(t);
      expect(r.status, t).toBe("clarify");
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await listScans(D)).length).toBe(before);
    spy.mockRestore();
  });

  it("an empty scan is a success, not a failure, and is persisted through the existing store", async () => {
    const r = await ask("Run an initiative scan for Rina Studio.");
    expect(r.intent).toBe("initiative_scan");
    expect(r.status).toBe("executed");
    expect(r.answer).toMatch(/^Nothing new at Rina Studio/);
    expect(r.answer).toMatch(/I haven't contacted anyone/);
    expect(r.answer).toMatch(/not a failure/);
    const scans = await listScans(D);
    expect(scans).toHaveLength(1);
    expect(scans[0].trigger).toBe("manual");
    expect(scans[0].skipped).toBeUndefined();
  });

  it("reuses the existing engine (one runInitiativeScan call, normal bounded, no force) and records the trace", async () => {
    const spy = (await import("vitest")).vi.spyOn(engine, "runInitiativeScan");
    const key = `fis-trace-${Date.now()}`;
    await executeFounderCommand({ actor: founder, key, text: "Run an initiative scan for Rina Studio." });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].business.id).toBe(D);
    expect(spy.mock.calls[0][1]).toMatchObject({ trigger: "manual", force: false });
    spy.mockRestore();
    const rec = await getFounderCommand(key);
    expect(rec?.intent).toEqual({ family: "initiative_scan", force: false });
    expect(rec?.scope).toEqual({ kind: "business", businessIds: [D] });
    expect(rec?.resolution.matched.map((b) => b.id)).toEqual([D]);
    expect(rec?.scan).toMatchObject({ businessId: D, forced: false, skipped: null });
    expect(typeof rec?.scan?.candidates).toBe("number");
    expect(rec?.trace.map((t) => t.step)).toEqual(expect.arrayContaining(["scope", "grounding", "authority", "execution", "verification"]));
  });

  it("real findings are persisted once; a repeat scan updates in place instead of duplicating", async () => {
    await seedRepeatedQuestions(6);
    const first = await ask("Run an initiative scan for Rina Studio.", 1);
    const after1 = await listInitiatives(D);
    expect(after1.length).toBeGreaterThan(0);
    expect(first.answer).toMatch(/^I found (?:one thing|\d+ things) worth attention at Rina Studio\. The biggest: /);
    expect(first.answer).toMatch(/I haven't contacted anyone/);
    const second = await ask("Scan Rina Studio for initiatives.", 1);
    const after2 = await listInitiatives(D);
    expect(after2).toHaveLength(after1.length);
    expect(new Set(after2.map((i) => i.fingerprint)).size).toBe(after2.length);
    expect(second.status).toBe("executed");
  });

  it("a normal scan respects the daily limit; only explicit force bypasses it (and only that)", async () => {
    let skipped: Awaited<ReturnType<typeof ask>> | undefined;
    for (let i = 0; i < 5 && !skipped; i++) {
      const r = await ask("Run an initiative scan for Rina Studio.", 2);
      if (r.status === "no_change") skipped = r;
    }
    expect(skipped).toBeDefined();
    expect(skipped!.answer).toMatch(/Scan skipped for Rina Studio: scan limit reached/);
    expect(skipped!.answer).toMatch(/Nothing was detected or changed/);
    const initiativesBefore = await listInitiatives(D);
    const scansBefore = (await listScans(D)).filter((s) => !s.skipped).length;
    // Normal again: still skipped.
    expect((await ask("Run a fresh initiative scan for Rina.", 2)).status).toBe("no_change");
    // Explicit force: runs, once, through the engine.
    const forced = await ask("Force an initiative scan for Rina Studio for QA.", 2);
    expect(forced.status).toBe("executed");
    expect(forced.answer).toMatch(/^Forced QA scan done\. /);
    expect((await listScans(D)).filter((s) => !s.skipped).length).toBe(scansBefore + 1);
    // Force bypassed only the limit: dedupe still holds.
    expect(await listInitiatives(D)).toHaveLength(initiativesBefore.length);
    // No customer message was created by any of this.
    expect(await getBackend().listApprovals(D).then((a) => a.length)).toBe(0);
  });

  it("a failing scan is reported as failed, distinct from an empty one", async () => {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(engine, "runInitiativeScan").mockRejectedValueOnce(new Error("store unavailable"));
    const r = await ask("Run an initiative scan for Rina Studio.");
    expect(r.status).toBe("failed");
    expect(r.answer).toMatch(/scan failed/);
    expect(r.answer).toMatch(/not the same as a scan that found nothing/);
    spy.mockRestore();
  });
});

void buildFashionRetailerGraph;
