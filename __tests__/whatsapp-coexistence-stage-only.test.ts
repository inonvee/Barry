import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { setOwnerModelForTests } from "@/lib/owner/command-llm";
import { countSyntheticIdentities, readRestorePoint } from "@/lib/qa/restore-point";
import { allBusinessNumbers } from "@/lib/channels/business-numbers";
import { listTakeoverSignals } from "@/lib/channels/human-takeover";
import { setGatewayHookForConversation } from "@/lib/channels/gateway";
import { getConversationStore } from "@/lib/state";
import { COEX_ISOLATION_ONLY, COEX_RACE_ONLY, COEX_RETURN_ONLY, COEX_ROUTING_ONLY, COEX_STAGES, COEX_TAKEOVER_ONLY, type CoexReport } from "@/app/api/qa/whatsapp-coexistence/runner";
import { evidenceChecks, stageRequestBodies } from "@/app/hq/qa/owner-whatsapp/SequentialRunner";
import { ScriptedModel } from "./support/scripted-model";

/**
 * The QA page's "Run takeover only" / "Run race only" / "Run return only" / "Run isolation only" controls. Only the
 * deployment guards are replaced (this process is not a Vercel Preview and has no HQ session); the ROUTE HANDLER and
 * the RUNNER are the real ones the deployed page calls.
 */
vi.mock("@/lib/qa/preview-acceptance-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/qa/preview-acceptance-guard")>()),
  previewAcceptanceRefusal: () => null,
  acceptanceCredentials: () => ({ ok: true, appSecret: "test-app-secret", ownerToken: "test-owner-token-0123456789", founderToken: "f", cronSecret: "c" }),
  routedPhoneNumberId: () => "PNID-T",
}));
vi.mock("@/lib/hq/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/hq/auth")>()), hqAuthError: () => undefined }));

const BIZ = "fashion-retailer";
let graphCalls = 0;
const saved = { ...process.env };
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
  Object.assign(process.env, { WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: "test-app-secret", WHATSAPP_ACCESS_TOKEN: "t", BARRY_WHATSAPP_ROUTES: `PNID-T=${BIZ}`, BARRY_WHATSAPP_SEND: "dry_run", BARRY_OWNER_TOKEN: "test-owner-token-0123456789", BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ", BARRY_WHATSAPP_ROLE_ROUTING: "identity" });
  setReasonerForTests(new ScriptedModel(() => undefined));
  setOwnerModelForTests({ interpret: null, draft: null });
  graphCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (/graph\.facebook\.com/.test(String(url))) graphCalls++;
    throw new Error(`no network in this test: ${url}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setReasonerForTests(undefined);
  setOwnerModelForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const CONTROLS = [
  { stage: "takeover", list: COEX_TAKEOVER_ONLY },
  { stage: "race", list: COEX_RACE_ONLY },
  { stage: "return", list: COEX_RETURN_ONLY },
  { stage: "isolation", list: COEX_ISOLATION_ONLY },
] as const;

/** A fault that only the chosen stage hits (its synthetic customers are 99956<d6><i>); returns its remover. */
async function injectStageFault(stage: (typeof CONTROLS)[number]["stage"], d6: string): Promise<() => void> {
  const id = (i: number) => `wa:${BIZ}:99956${d6}${i}`;
  const boom = async () => {
    throw new Error("injected stage failure (test)");
  };
  if (stage === "takeover") return setGatewayHookForConversation(id(3), "beforeReasoning", boom); // BARRY never replies → I fails
  if (stage === "race") return setGatewayHookForConversation(id(5), "beforeSend", boom); // no reply to suppress → N fails
  if (stage === "return") return setGatewayHookForConversation(id(8), "beforeReasoning", boom);
  // isolation: this business's conversation with the customer is already held by a person → M fails.
  const { giveToHuman } = await import("@/lib/runtime/control");
  const st = await getConversationStore().getOrCreate(id(1), BIZ, "wa:x");
  giveToHuman(st, "the owner (web)", "test: already held");
  await getConversationStore().save(st);
  return () => undefined;
}

async function postBody(body: unknown) {
  const { POST } = await import("@/app/api/qa/whatsapp-coexistence/route");
  const res = await POST(new Request("https://x/api/qa/whatsapp-coexistence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, report: (await res.json()) as CoexReport };
}

/** Preflight + restore + cleanup ran, and realGraphSendAttempts = 0 was asserted (and true). */
async function expectPreflightRestoreCleanup(report: CoexReport, before: { mode: string; pausedBusiness: boolean }) {
  expect(report.checks.some((c) => c.stage === "preflight" && /VERIFIED only by evidence/.test(c.name))).toBe(true);
  expect(report.checks.find((c) => /^realGraphSendAttempts === 0/.test(c.name))).toMatchObject({ stage: "restore", ok: true, detail: { realGraphSendAttempts: 0 } });
  expect(report.checks.find((c) => /business controls restored/.test(c.name))?.ok).toBe(true);
  expect(report.checks.find((c) => /synthetic business numbers removed/.test(c.name))?.ok).toBe(true);
  expect(report.checks.find((c) => /synthetic conversations and takeover records removed/.test(c.name))?.ok).toBe(true);
  expect(report.checks.find((c) => /synthetic identities removed/.test(c.name))?.ok).toBe(true);
  expect(await loadControls(BIZ)).toMatchObject({ mode: before.mode, pausedBusiness: before.pausedBusiness });
  expect(await readRestorePoint(BIZ)).toBeUndefined();
  expect(await countSyntheticIdentities()).toEqual({ syntheticOwnersActive: 0, syntheticFoundersActive: 0 });
  expect((await allBusinessNumbers()).filter((n) => n.phoneNumberId.startsWith("999"))).toHaveLength(0);
  for (const id of report.conversations) {
    expect(await getConversationStore().get(id)).toBeUndefined();
    expect(await listTakeoverSignals(id.split(":")[1], id)).toHaveLength(0);
  }
  expect(graphCalls).toBe(0);
}

const detailOf = (report: CoexReport, re: RegExp) => report.checks.find((c) => re.test(c.name))?.detail as Record<string, unknown>;

describe("each stage-only control sends exactly ONE stage; the full suite and routing-only controls are unchanged", () => {
  it("takeover / race / return / isolation controls → exactly one POST each, carrying only that stage", () => {
    expect(stageRequestBodies(COEX_TAKEOVER_ONLY)).toEqual([{ stages: ["takeover"] }]);
    expect(stageRequestBodies(COEX_RACE_ONLY)).toEqual([{ stages: ["race"] }]);
    expect(stageRequestBodies(COEX_RETURN_ONLY)).toEqual([{ stages: ["return"] }]);
    expect(stageRequestBodies(COEX_ISOLATION_ONLY)).toEqual([{ stages: ["isolation"] }]);
  });

  it("7. the full-suite control is unchanged (all five stages, in order, one POST each) and routing-only still sends [\"routing\"]", () => {
    expect([...COEX_STAGES]).toEqual(["routing", "takeover", "race", "return", "isolation"]);
    expect(stageRequestBodies(COEX_STAGES)).toEqual([{ stages: ["routing"] }, { stages: ["takeover"] }, { stages: ["race"] }, { stages: ["return"] }, { stages: ["isolation"] }]);
    expect(stageRequestBodies(COEX_ROUTING_ONLY)).toEqual([{ stages: ["routing"] }]);
  });

  it("the evidence panel shows every check of the chosen stage (and the routing panel still selects check B by name)", () => {
    const checks = [
      { stage: "preflight", name: "x" },
      { stage: "takeover", name: "D: a" },
      { stage: "takeover", name: "E: b" },
      { stage: "routing", name: "B: c" },
      { stage: "restore", name: "y" },
    ];
    expect(evidenceChecks(checks, { evidenceStage: "takeover" }).map((c) => c.name)).toEqual(["D: a", "E: b"]);
    expect(evidenceChecks(checks, { evidenceCheck: "B: " }).map((c) => c.name)).toEqual(["B: c"]);
    expect(evidenceChecks(checks, {})).toEqual([]);
  });
});

describe("1–5. through the real route + runner: ONLY the chosen stage runs, with preflight + restore", () => {
  it.each(CONTROLS)("$stage only → checks of preflight, $stage and restore only; every $stage check passes; restore + cleanup + 0 Graph sends", async ({ stage, list }) => {
    const before = await loadControls(BIZ);
    const [body, ...more] = stageRequestBodies(list);
    expect(more).toHaveLength(0);
    const { report } = await postBody(body);
    expect(report.stages).toEqual([stage]);
    expect([...new Set(report.checks.map((c) => c.stage))].sort()).toEqual(["preflight", "restore", stage].sort());
    for (const other of COEX_STAGES.filter((s) => s !== stage)) expect(report.checks.some((c) => c.stage === other)).toBe(false);
    const stageChecks = report.checks.filter((c) => c.stage === stage);
    expect(stageChecks.length).toBeGreaterThan(0);
    expect(stageChecks.filter((c) => !c.ok)).toEqual([]);
    // Every stage check carries evidence.
    for (const c of stageChecks) expect(c.detail, c.name).toBeDefined();
    await expectPreflightRestoreCleanup(report, before);
  }, 180_000);
});

describe("the stage reports expose the runner's evidence", () => {
  it("takeover: holder before/after, echo result, control log, HUMAN transcript, sends before/after, duplicate + own-message echo", async () => {
    const { report } = await postBody(stageRequestBodies(COEX_TAKEOVER_ONLY)[0]);
    expect(detailOf(report, /^D: /)).toMatchObject({ holderBefore: "barry", holderAfter: "human", echo: [expect.objectContaining({ status: "recorded" })], controlLog: expect.arrayContaining([expect.objectContaining({ to: "human" })]) });
    expect(detailOf(report, /^G: /)).toMatchObject({ holder: "human", transcript: expect.arrayContaining([expect.objectContaining({ role: "owner", author: expect.stringContaining("team member") })]) });
    expect(detailOf(report, /^E: /)).toMatchObject({ sendsBefore: expect.any(Number), sendsAfter: expect.any(Number) });
    expect(detailOf(report, /^E: /).sendsAfter).toBe(detailOf(report, /^E: /).sendsBefore);
    expect(detailOf(report, /^H: /)).toMatchObject({ echo: [expect.objectContaining({ status: "duplicate" })], personMessages: 1, takeoversInControlLog: 1 });
    expect(detailOf(report, /^I: /)).toMatchObject({ echo: [expect.objectContaining({ status: "own_message" })], holderBefore: "barry", holderAfter: "barry", barryProviderMessageId: expect.stringMatching(/^wamid\.qa\.barry\./) });
  }, 180_000);

  it("race: holder at each race point, sends before/after, delivery (suppression) status", async () => {
    const { report } = await postBody(stageRequestBodies(COEX_RACE_ONLY)[0]);
    const n = report.checks.filter((c) => c.stage === "race").map((c) => c.detail as Record<string, unknown>);
    expect(n).toHaveLength(4);
    for (const d of n) expect(d).toMatchObject({ holder: "human", sendsBefore: expect.any(Number), sendsAfter: expect.any(Number), lastDelivery: expect.anything() });
    expect(n[0]).toMatchObject({ holderBeforeEcho: "barry", holderAfterEcho: "human" });
    expect(n[1]).toMatchObject({ holderAtRacePoint: "barry", lastDelivery: "suppressed" });
    expect(n[2]).toMatchObject({ holderAtRacePoint: "barry", lastDelivery: "suppressed" });
    expect(n[3]).toMatchObject({ holderBefore: "barry", sendsAfterEcho: 0 });
  }, 180_000);

  it("return: holder before/after the return, the old delayed echo result, the same-second ambiguity result", async () => {
    const { report } = await postBody(stageRequestBodies(COEX_RETURN_ONLY)[0]);
    expect(detailOf(report, /^K: Owner BARRY WhatsApp/)).toMatchObject({ holderBefore: "human", holderAfter: "barry" });
    expect(detailOf(report, /^K: the web handoff/)).toMatchObject({ holderBefore: "human", holderAfter: "barry" });
    expect(detailOf(report, /^J: an old delayed echo/)).toMatchObject({ holderBefore: "barry", holderAfter: "barry", echo: [expect.objectContaining({ status: "recorded" })], inTranscriptAsPerson: true });
    expect(detailOf(report, /^same-second ambiguity/)).toMatchObject({ holderBefore: "barry", holderAfter: "human", echo: [expect.objectContaining({ status: "recorded" })] });
    const same = detailOf(report, /^same-second ambiguity/);
    expect(same.echoTimestampSeconds).toBe(String(Math.floor(Date.parse(String(same.returnedAt)) / 1000)));
  }, 180_000);

  it("isolation: source business, target business, the attempted cross-tenant action, holder/state in each tenant", async () => {
    const { report } = await postBody(stageRequestBodies(COEX_ISOLATION_ONLY)[0]);
    const [echoCheck, returnCheck] = report.checks.filter((c) => c.stage === "isolation").map((c) => c.detail as Record<string, Record<string, Record<string, unknown>>>);
    const other = String(echoCheck.sourceBusiness);
    expect(other).not.toBe(BIZ);
    expect(echoCheck).toMatchObject({ targetBusiness: BIZ, attemptedAction: expect.any(String) });
    expect(echoCheck.after[BIZ]).toMatchObject({ holder: "barry", personMessages: 0 });
    expect(echoCheck.after[other]).toMatchObject({ holder: "human", personMessages: 1 });
    expect(returnCheck).toMatchObject({ sourceBusiness: BIZ, targetBusiness: other, attemptedAction: expect.any(String), error: expect.any(String) });
    expect(returnCheck.before[other]).toMatchObject({ holder: "human" });
    expect(returnCheck.after[other]).toMatchObject({ holder: "human" });
    expect(returnCheck.after[BIZ]).toMatchObject({ holder: "barry" });
  }, 180_000);
});

describe("6. a failure inside the stage still performs restore and cleanup", () => {
  it.each(CONTROLS)("$stage only, failing mid-stage → FAIL, yet restore, cleanup and realGraphSendAttempts = 0 all ran", async ({ stage, list }) => {
    const before = await loadControls(BIZ);
    // The runner derives its synthetic numbers from runId = coex-<Date.now()>: pin the clock to know the stage's first
    // conversations, and break one of them — a fault only the stage itself reaches (never preflight).
    const fixed = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(fixed);
    const d6 = String(parseInt(String(fixed).slice(-7), 10)).padStart(7, "0").slice(1);
    const remove = await injectStageFault(stage, d6);
    let res: Awaited<ReturnType<typeof postBody>>;
    try {
      res = await postBody(stageRequestBodies(list)[0]);
    } finally {
      remove();
    }
    const { status, report } = res;
    expect(report.runId).toBe(`coex-${fixed}`);
    expect(status).toBe(422);
    expect(report.verdict).toBe("FAIL");
    expect(report.stages).toEqual([stage]);
    for (const other of COEX_STAGES.filter((s) => s !== stage)) expect(report.checks.some((c) => c.stage === other)).toBe(false);
    // The stage itself failed (a failed stage check, or the runner error recorded before the restore).
    expect(report.checks.some((c) => !c.ok && (c.stage === stage || c.name === "runner error"))).toBe(true);
    expect(report.checks.filter((c) => c.stage === "preflight" && /VERIFIED only by evidence/.test(c.name)).every((c) => c.ok)).toBe(true);
    await expectPreflightRestoreCleanup(report, before);
  }, 180_000);
});
