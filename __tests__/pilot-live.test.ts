import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { getBusinessGraph } from "@/lib/fixtures";
import { LOGISTICS_DEMO_ID, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { setReasonerForTests, type Reasoner, type ReasonerContext, type UnderstandingResult, type ComposeResponseInput } from "@/lib/reasoner";
import { OpenAIReasoner } from "@/lib/reasoner/openai-reasoner";
import { readLedger } from "@/lib/runtime/ledger";
import { getOwnerWorkspace } from "@/lib/owner/service";

/**
 * LIVE paid-pilot checks (BARRY_LIVE_EVAL=1 + OPENAI_API_KEY): the CONFIGURED reasoner/composer on the
 * real runtime. Assertions are on state — ledger, approvals, handoffs, the provider cart — never on
 * exact wording. A "forced" failure wraps the live reasoner and fails one named turn; it is labelled as
 * forced in the report. Report: $BARRY_PILOT_REPORT or <tmp>/barry-pilot-live.json.
 */

const LIVE = Boolean(process.env.OPENAI_API_KEY && process.env.BARRY_LIVE_EVAL === "1");
const results: { check: string; pass: boolean; detail: string }[] = [];

/** Delegates to the live reasoner, except understanding fails (forced) while `failWhen` matches. */
class ForcedFailure implements Reasoner {
  readonly name = "llm" as const;
  constructor(private readonly live: OpenAIReasoner, public failWhen: (ctx: ReasonerContext) => boolean) {}
  get model() {
    return this.live.model;
  }
  async understand(ctx: ReasonerContext) {
    return (await this.understandDetailed(ctx)).ir;
  }
  async understandDetailed(ctx: ReasonerContext): Promise<UnderstandingResult> {
    if (this.failWhen(ctx)) return { ir: { intent: "understanding_failed", entities: {}, constraints: {}, customerInfo: {} }, valid: false, attempts: 1, failure: { kind: "provider_quota_exhausted", status: 429, code: "forced_for_test", message: "forced failure (test)", transient: false }, latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }, model: this.live.model };
    return this.live.understandDetailed(ctx);
  }
  composeResponse(ctx: ReasonerContext, input: ComposeResponseInput) {
    return this.live.composeResponse(ctx, input);
  }
}

const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  expect(pass, `${check}: ${detail}`).toBe(true);
};
let n = 0;
const conv = (p: string) => `live-pilot-${p}-${Date.now()}-${n++}`;
const approvals = async (businessId: string, id: string) => (await getBackend().listApprovals(businessId)).filter((a) => a.conversationId === id);

describe.skipIf(!LIVE)("LIVE paid-pilot checks", () => {
  afterEach(() => {
    setReasonerForTests(undefined);
    resetDemoHelpdeskForTests();
  });
  afterAll(() => {
    const file = process.env.BARRY_PILOT_REPORT ?? path.join(os.tmpdir(), "barry-pilot-live.json");
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  });

  it("1. F31 normal correction: the stale reference can never be approved into a ticket", async () => {
    setReasonerForTests(new OpenAIReasoner());
    const g = getBusinessGraph(LOGISTICS_DEMO_ID);
    const id = conv("f31");
    await handleCustomerMessage(g, id, "c", "Different parcel Q4-C301 now, delayed. Create one owner approval for a delay case only.");
    await handleCustomerMessage(g, id, "c", "Wait, C302 not 301. Correct the reference and change the reason to damaged; replace the pending one.");
    for (const a of (await approvals(g.business.id, id)).filter((x) => x.status === "pending")) await resumeAfterApproval(g, a.id, "approved", "owner");
    const refs = demoHelpdeskTickets().map((t) => t.reference);
    record("f31_normal", !refs.some((r) => /C301/.test(r)), `tickets: ${JSON.stringify(refs)}`);
  }, 180_000);

  it("2. F31 correction + (forced) understanding failure: approve executes nothing; revalidation later applies the correction", async () => {
    const live = new OpenAIReasoner();
    const r = new ForcedFailure(live, (ctx) => /C302/.test(ctx.customerMessage));
    setReasonerForTests(r);
    const g = getBusinessGraph(LOGISTICS_DEMO_ID);
    const id = conv("f31-fail");
    await handleCustomerMessage(g, id, "c", "Different parcel Q4-C301 now, delayed. Create one owner approval for a delay case only.");
    const [pending] = await approvals(g.business.id, id);
    await handleCustomerMessage(g, id, "c", "Wait C302, not301. Correct reference and change reason to damaged; replace the pending one now.");
    const held = await resumeAfterApproval(g, pending.id, "approved", "owner");
    record("f31_forced_failure_held", demoHelpdeskTickets().length === 0 && held.turn.trace?.stop.reason === "approval_held_customer_intent_unverified", `tickets=${demoHelpdeskTickets().length} stop=${held.turn.trace?.stop.reason}`);
    r.failWhen = () => false;
    await handleCustomerMessage(g, id, "c", "hello?");
    const after = (await approvals(g.business.id, id)).find((a) => a.id === pending.id)!;
    record("f31_revalidated", after.status !== "pending", `C301 request status after revalidation: ${after.status} (${after.resolution?.decidedBy ?? ""})`);
  }, 240_000);

  it("3. provider failure (forced): no action, safe reply, classified in the trace and the owner's AI health", async () => {
    setReasonerForTests(new ForcedFailure(new OpenAIReasoner(), () => true));
    const g = getBusinessGraph("ecommerce-bags");
    const id = conv("outage");
    const outs = [];
    for (const m of ["How much is the weekender bag?", "is it under 130?", "hello??"]) outs.push(await handleCustomerMessage(g, id, "c", m));
    const noAction = outs.every((o) => (o.turn.trace?.steps.length ?? 0) === 0);
    const safe = outs.every((o) => !/openai|429|quota|provider/i.test(o.response));
    const ws = await getOwnerWorkspace(g);
    record("degraded_mode", noAction && safe && ws.health.ai.status === "unavailable", `noAction=${noAction} safe=${safe} ai=${ws.health.ai.status}`);
  }, 120_000);

  it("4-6. variant replacement, partial multi-intent and fact provenance on the retailer", async () => {
    setReasonerForTests(new OpenAIReasoner());
    const g = getBusinessGraph("fashion-retailer");
    const id = conv("rina");
    await handleCustomerMessage(g, id, "c", "היי, אני מחפשת שמלה שחורה");
    const two = await handleCustomerMessage(g, id, "c", "את Midnight במידה M אחת לסל, וגם Onyx במידה M אחת. בלי קופה");
    const ledger = readLedger(two.state).slice(-6);
    const added = ledger.filter((e) => e.effect === "cart.line_added").length;
    record("multi_intent", added === 2 || (added === 1 && /לא|עוד/.test(two.response)), `lines added this turn: ${added}; reply: ${two.response.slice(0, 160)}`);
    const change = await handleCustomerMessage(g, id, "c", "תשני את Midnight למידה L וכמות 2. בלי קופה");
    const upd = readLedger(change.state).filter((e) => e.operation === "updateCartLine").at(-1);
    record("variant_replacement", upd?.effect === "cart.line_updated" && upd.status === "effected" && upd.terms.quantityAfter === 2, JSON.stringify(upd?.terms ?? null));
    const hours = await handleCustomerMessage(g, id, "c", "אתם פתוחים בשישי? באיזה שעות?");
    record("fact_provenance", !/\b\d{1,2}[:.]\d{2}\b/.test(hours.response), hours.response.slice(0, 200));
  }, 300_000);

  it("7-8. owner approval stale revalidation + the dashboard reflects authoritative state", async () => {
    setReasonerForTests(new OpenAIReasoner());
    const g = getBusinessGraph(LOGISTICS_DEMO_ID);
    const id = conv("dash");
    await handleCustomerMessage(g, id, "c", "Parcel Q4-A777 never arrived. Please open ONE support case (needs owner approval).");
    const ws = await getOwnerWorkspace(g);
    const mine = ws.approvals.filter((a) => a.conversationId === id);
    record("dashboard_state", mine.length === (await approvals(g.business.id, id)).length && mine.every((a) => a.actionable === (a.lifecycle === "active")), JSON.stringify(mine.map((a) => [a.lifecycle, a.actionable])));
  }, 120_000);

  it("10. handoff claim only when a handoff exists and the business declared how its team replies", async () => {
    setReasonerForTests(new OpenAIReasoner());
    const g = getBusinessGraph(LOGISTICS_DEMO_ID);
    const id = conv("handoff");
    const out = await handleCustomerMessage(g, id, "c", "I want to speak to a real person right now, this is ridiculous, my parcel arrived crushed.");
    const state = (await getConversationStore().get(id))!;
    const handoffs = JSON.parse(state.knownFields.__handoffs ?? "[]") as unknown[];
    const promises = /(will|'ll) (contact|call|get back to|reach out to) you/i.test(out.response);
    record("handoff_truth", handoffs.length === 1 && !promises, `handoffs=${handoffs.length} reply=${out.response.slice(0, 200)}`);
  }, 120_000);
});

describe("pilot live harness (runs without a key)", () => {
  it("is skipped unless OPENAI_API_KEY and BARRY_LIVE_EVAL=1 are set", () => {
    expect(LIVE).toBe(Boolean(process.env.OPENAI_API_KEY && process.env.BARRY_LIVE_EVAL === "1"));
  });
});
