import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { listAttempts, recordAttempt } from "@/lib/operator/attempts";
import { localMoment } from "@/lib/initiative/scheduler";
import { DAILY_PROACTIVE_LIMIT, MAX_ATTEMPTS, listJobRuns, runBackgroundTick, runBusinessJobs, setBackgroundSendersForTests } from "@/lib/background/runner";
import { LOGISTICS_DEMO_ID } from "@/lib/fixtures/logistics-demo";
import type { OutboundSender } from "@/lib/channels/gateway";
import type { ConversationState } from "@/lib/state";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * PAID-PILOT P0 PHASE 5 — BACKGROUND OPERATION. Recurring follow-ups / abandoned checkout / owner brief /
 * initiative scans: business-local time, one run per slot, no duplicate sends, dry runs never counted as
 * sends, the mode respected, test businesses never live, every run logged with failures and retries visible.
 */

const H = 3600_000;
let dispose: (() => void) | undefined;
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
});
afterEach(() => {
  setReasonerForTests(undefined);
  setBackgroundSendersForTests(undefined);
  setLockStoreForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

type Capture = OutboundSender & { sent: string[] };
function liveCapture(): Capture {
  const sent: string[] = [];
  return { channel: "web", mode: "live", sent, send: async (to) => (sent.push(to), { providerMessageId: `out.${sent.length}` }) };
}

/** A business with one customer whose payment link has been open past the follow-up delay. */
async function business() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  const id = conv("bg");
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  await handleCustomerMessage(r.g, id, "c", "the midnight dress");
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
  await handleCustomerMessage(r.g, id, "c", "add it in M");
  model.plan = () => ({ commerce: { intent: "checkout" }, customerInfo: { name: "Dana", phone: "0501234567" }, evidence: { "customerInfo.name": "Dana", "customerInfo.phone": "0501234567" }, advancesTransaction: true });
  await handleCustomerMessage(r.g, id, "c", "checkout please, Dana 0501234567");
  const payment = (await getBackend().listPaymentRequests(r.g.business.id)).find((p) => p.conversationId === id)!;
  return { g: r.g, id, payment };
}

/** The first top-of-the-hour moment after `from` whose business-local hour is `hour`. */
function atLocalHour(tz: string, from: number, hour: number): Date {
  let t = Math.floor(from / H) * H + H; // top of an hour (every timezone used here is whole-hour offset)
  for (let i = 0; i < 48 && localMoment(tz, new Date(t)).hour !== hour; i++) t += H;
  return new Date(t);
}

const followups = (outs: Awaited<ReturnType<typeof runBusinessJobs>>) => outs.find((o) => o.job === "followups")!;

describe("business-local schedule", () => {
  it("follow-ups run only inside the business's own hours; the brief only in its morning window", async () => {
    const { g, payment } = await business();
    const tz = g.business.timezone;
    const base = Date.parse(payment.createdAt) + 25 * H;
    const night = atLocalHour(tz, base, 3);
    expect(followups(await runBusinessJobs(g, { now: night, jobs: ["followups"] }))).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/outside the window/) });
    const noon = atLocalHour(tz, base, 12);
    const o = followups(await runBusinessJobs(g, { now: noon, jobs: ["followups"] }));
    expect(o.decision).toBe("ran");
    expect(o.slot).toBe(`${localMoment(tz, noon).date}T12`);
    const brief = (await runBusinessJobs(g, { now: noon, jobs: ["owner_brief"] }))[0];
    expect(brief).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/outside the window/) });
  });
});

describe("idempotent runs, no duplicate sends", () => {
  it("the same slot runs once; a concurrent tick does nothing; one send per attempt", async () => {
    const { g, payment } = await business();
    await applyControlChange(g.business.id, { mode: "live" }, { by: "founder", reason: "go live" });
    const out = liveCapture();
    setBackgroundSendersForTests(() => out);
    const noon = atLocalHour(g.business.timezone, Date.parse(payment.createdAt) + 25 * H, 12);
    const [a, b] = await Promise.all([runBusinessJobs(g, { now: noon, jobs: ["followups"] }), runBusinessJobs(g, { now: noon, jobs: ["followups"] })]);
    const decisions = [followups(a).decision, followups(b).decision].sort();
    expect(decisions).toEqual(["ran", "skipped"]);
    expect(out.sent).toHaveLength(1);
    // The next tick in the same slot: already ran.
    expect(followups(await runBusinessJobs(g, { now: new Date(noon.getTime() + 20 * 60_000), jobs: ["followups"] }))).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/already ran/) });
    // The next slot: the attempt interval holds it — still exactly one send.
    expect(followups(await runBusinessJobs(g, { now: new Date(noon.getTime() + H), jobs: ["followups"] })).decision).toBe("ran");
    expect(out.sent).toHaveLength(1);
    expect((await listAttempts(g.business.id)).filter((x) => x.status === "sent")).toHaveLength(1);
  });
});

describe("operating mode", () => {
  it("SIMULATOR (default, test business): a dry run, logged as a dry run — the real channel is never touched", async () => {
    const { g, payment } = await business();
    const out = liveCapture();
    setBackgroundSendersForTests(() => out);
    const noon = atLocalHour(g.business.timezone, Date.parse(payment.createdAt) + 25 * H, 12);
    const o = followups(await runBusinessJobs(g, { now: noon, jobs: ["followups"] }));
    expect(o.summary).toMatchObject({ sent: 0, dryRun: 1 });
    expect(out.sent).toHaveLength(0);
    const [run] = await listJobRuns(g.business.id);
    expect(run).toMatchObject({ job: "followups", status: "ran", mode: "simulator", summary: { sent: 0, dryRun: 1 } });
    // A dry run is not a message to the customer: nothing in the transcript.
    const state = (await getConversationStore().get(payment.conversationId)) as ConversationState;
    expect(state.messages.filter((m) => m.role === "barry").every((m) => !/payment link/.test(m.content) || !/reminder/i.test(m.content))).toBe(true);
  });

  it("SUPERVISED: prepares, sends nothing on its own (the owner runs it); PAUSED: nothing runs", async () => {
    const { g, payment } = await business();
    const out = liveCapture();
    setBackgroundSendersForTests(() => out);
    const noon = atLocalHour(g.business.timezone, Date.parse(payment.createdAt) + 25 * H, 12);
    await applyControlChange(g.business.id, { mode: "supervised" }, { by: "founder", reason: "pilot" });
    const s = followups(await runBusinessJobs(g, { now: noon, jobs: ["followups"] }));
    expect(s).toMatchObject({ decision: "ran", reason: expect.stringMatching(/supervised/) });
    expect(s.summary).toMatchObject({ sent: 0, dryRun: 0 });
    await applyControlChange(g.business.id, { pausedBusiness: true }, { by: "owner", reason: "pause" });
    expect(followups(await runBusinessJobs(g, { now: new Date(noon.getTime() + H), jobs: ["followups"] }))).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/paused/) });
    expect(out.sent).toHaveLength(0);
    expect(await listAttempts(g.business.id)).toHaveLength(0);
  });

  it("one business paused never affects another", async () => {
    const a = await business();
    const disposeA = dispose;
    dispose = undefined;
    const b = await business();
    try {
      await applyControlChange(a.g.business.id, { pausedBusiness: true }, { by: "owner", reason: "pause" });
      const noon = atLocalHour(b.g.business.timezone, Math.max(Date.parse(a.payment.createdAt), Date.parse(b.payment.createdAt)) + 25 * H, 12);
      expect(followups(await runBusinessJobs(a.g, { now: noon, jobs: ["followups"] })).decision).toBe("skipped");
      expect(followups(await runBusinessJobs(b.g, { now: noon, jobs: ["followups"] })).summary).toMatchObject({ dryRun: 1 });
    } finally {
      disposeA?.();
    }
  });

  it("the demo business never runs", async () => {
    const tick = await runBackgroundTick({ businessId: LOGISTICS_DEMO_ID });
    expect(tick.outcomes.every((o) => o.decision === "skipped")).toBe(true);
  });
});

describe("limits, failures and retries", () => {
  it("per-business daily limit: at the limit nothing more is sent today (dry runs never use it up)", async () => {
    const { g, payment } = await business();
    await applyControlChange(g.business.id, { mode: "live" }, { by: "founder", reason: "go live" });
    const out = liveCapture();
    setBackgroundSendersForTests(() => out);
    const noon = atLocalHour(g.business.timezone, Date.parse(payment.createdAt) + 25 * H, 12);
    for (let i = 0; i < DAILY_PROACTIVE_LIMIT; i++) await recordAttempt({ id: `other:${i}#1`, businessId: g.business.id, obligationKey: `other:${i}`, kind: "unpaid_payment_followup", n: 1, at: new Date(noon.getTime() - 60_000).toISOString(), status: "sent", what: "", evidence: [], idempotencyKey: `other:${i}#1` });
    const o = followups(await runBusinessJobs(g, { now: noon, jobs: ["followups"] }));
    expect(o.reason).toMatch(/daily limit/);
    expect(out.sent).toHaveLength(0);
  });

  it("a failing run is recorded failed, retried on the next tick in the slot, then left failed — visible, never silent", async () => {
    const { g, payment } = await business();
    await applyControlChange(g.business.id, { mode: "live" }, { by: "founder", reason: "go live" });
    setBackgroundSendersForTests(() => {
      throw new Error("channel unavailable");
    });
    const noon = atLocalHour(g.business.timezone, Date.parse(payment.createdAt) + 25 * H, 12);
    const first = followups(await runBusinessJobs(g, { now: noon, jobs: ["followups"] }));
    expect(first).toMatchObject({ decision: "failed", reason: expect.stringMatching(/retried on the next tick/) });
    const second = followups(await runBusinessJobs(g, { now: new Date(noon.getTime() + 15 * 60_000), jobs: ["followups"] }));
    expect(second).toMatchObject({ decision: "failed", reason: expect.stringMatching(/not retried/) });
    const third = followups(await runBusinessJobs(g, { now: new Date(noon.getTime() + 30 * 60_000), jobs: ["followups"] }));
    expect(third).toMatchObject({ decision: "skipped", reason: expect.stringMatching(new RegExp(`failed ${MAX_ATTEMPTS} times`)) });
    const [run] = await listJobRuns(g.business.id);
    expect(run).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, retry: false, error: "channel unavailable" });
  });

  it("every tick is logged with each outcome and why", async () => {
    const tick = await runBackgroundTick({ businessId: "spa", now: new Date("2026-10-05T01:00:00Z"), jobs: ["followups", "owner_brief"] });
    expect(tick.evaluated).toBe(1);
    expect(tick.outcomes.length).toBe(2);
    expect(tick.outcomes.every((o) => o.reason.length > 0)).toBe(true);
  });
});
