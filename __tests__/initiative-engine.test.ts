import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "@/lib/fabric";
import { noticedCard } from "@/lib/owner/os";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import type { BusinessGraph } from "@/lib/business-graph";
import { selectPlan } from "@/lib/commercial/account";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { executeOwnerCommand } from "@/lib/owner/command-service";
import { interpretCommand } from "@/lib/owner/command";
import { actOnInitiative, applyInitiativeAction, buildSnapshot, initiativeMetrics, runInitiativeScan, score, verifyCandidate } from "@/lib/initiative/engine";
import { listInitiatives, saveInitiative } from "@/lib/initiative/store";
import { costSignals, moneyAtRisk, type Snapshot } from "@/lib/initiative/detectors";
import { initiativeMessage, materiallyNew } from "@/lib/initiative/model";
import { acceptExternalEvidence, savingRealisedBy, EXTERNAL_RESEARCH_CONNECTOR } from "@/lib/initiative/research";
import { TodayView } from "@/components/owner/views/Today";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * INITIATIVE ENGINE V1 — invariants: no initiative without evidence; an empty scan is a success; one
 * idea is one record (updated, never duplicated); dismissal sticks unless the evidence is materially
 * new; tenants never mix; test / unverified money never becomes money; plans change what BARRY can
 * DO, not what it can notice; acting goes through the normal command pipeline.
 */

const disposers: (() => void)[] = [];
const graphs = new Map<string, BusinessGraph>();
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  while (disposers.length) disposers.pop()!();
  graphs.clear();
  setBusinessGraphResolverForTests(undefined);
});

const SCRIPT: Record<string, object> = {
  "how much is shipping?": { knowledgeTopic: "shipping", asks: [{ ask: "how much is shipping", kind: "question", coveredByThisIR: true, topic: "shipping" }], advancesTransaction: false },
  "do you sell gift cards?": { asks: [{ ask: "do you sell gift cards", kind: "question", coveredByThisIR: true }], advancesTransaction: false },
  "the midnight dress": { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true },
  "add it in M": { commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true },
  "could you ask the owner to approve 10% off this dress?": { constraints: { discountPct: 10 }, advancesTransaction: true, asks: [{ ask: "10% off this dress", kind: "change", coveredByThisIR: true }] },
};

function tenant() {
  const r = isolatedRetailer();
  disposers.push(r.dispose);
  graphs.set(r.g.business.id, r.g);
  setBusinessGraphResolverForTests((id) => graphs.get(id) ?? getBusinessGraph(id));
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  const say = async (id: string, text: string) => {
    model.plan = () => SCRIPT[text] as never;
    return handleCustomerMessage(r.g, id, "c", text);
  };
  return { ...r, say };
}
async function asks(t: ReturnType<typeof tenant>, n: number, opts: { cart?: number } = {}) {
  const ids: string[] = [];
  for (let k = 0; k < n; k++) {
    const id = conv("ship");
    await t.say(id, "how much is shipping?");
    if (k < (opts.cart ?? 0)) {
      await t.say(id, "the midnight dress");
      await t.say(id, "add it in M");
    }
    ids.push(id);
  }
  return ids;
}

describe("scans: evidence or nothing", () => {
  it("a business with nothing worth saying produces zero initiatives — and the Living Interface stays quiet", async () => {
    const t = tenant();
    await asks(t, 2);
    const { scan } = await runInitiativeScan(t.g, { trigger: "test" });
    expect(scan).toMatchObject({ created: 0, surfaced: 0 });
    expect(await listInitiatives(t.g.business.id)).toEqual([]);
    const ws = await getOwnerWorkspace(t.g);
    const html = renderToString(createElement(TodayView, { ws, onDecision: () => undefined, onOpen: () => undefined, onTab: () => undefined, onAsk: () => undefined }));
    expect(html).not.toContain("BARRY noticed");
  });

  it("a repeated question becomes ONE initiative from grounded topics; re-scanning updates it, never duplicates", async () => {
    const t = tenant();
    const ids = await asks(t, 5);
    const first = await runInitiativeScan(t.g, { trigger: "test" });
    expect(first.scan.created).toBe(1);
    const [i] = await listInitiatives(t.g.business.id);
    expect(i).toMatchObject({ detector: "repeated_question", subject: "shipping", state: "surfaced", metric: { count: 5 } });
    expect(i.evidence.filter((e) => e.kind === "conversation").map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(JSON.stringify(i)).not.toContain("how much is shipping"); // aggregate references, not message text
    await asks(t, 1);
    const second = await runInitiativeScan(t.g, { trigger: "test" });
    expect(second.scan).toMatchObject({ created: 0, updated: 1 });
    const all = await listInitiatives(t.g.business.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ metric: { count: 6 }, scans: 2 });
    // The Living Interface shows exactly the persisted initiative — nothing invented around it.
    const ws = await getOwnerWorkspace(t.g);
    expect(ws.initiatives.map((x) => x.id)).toEqual([all[0].id]);
    const html = renderToString(createElement(TodayView, { ws, onDecision: () => undefined, onOpen: () => undefined, onTab: () => undefined, onAsk: () => undefined }));
    expect(html).toContain("BARRY noticed");
    expect(html).toContain(noticedCard(ws.initiatives[0]).what);
    expect(noticedCard(ws.initiatives[0]).observation).toContain("6 customers asked about shipping");
  });

  it("asking then dropping after the cart turns a question into conversion friction (counted, not guessed)", async () => {
    const t = tenant();
    await asks(t, 5, { cart: 3 });
    await runInitiativeScan(t.g, { trigger: "test" });
    const i = (await listInitiatives(t.g.business.id)).find((x) => x.detector === "repeated_question")!;
    expect(i).toMatchObject({ category: "sales_friction", metric: { count: 5, total: 3 } });
    expect(i.impact.amount).toBeUndefined(); // a conversion signal is never a revenue figure
  });

  it("questions BARRY couldn't answer are noticed from the runtime's own record of them", async () => {
    const t = tenant();
    for (let k = 0; k < 3; k++) await t.say(conv("gift"), "do you sell gift cards?");
    await runInitiativeScan(t.g, { trigger: "test" });
    expect((await listInitiatives(t.g.business.id)).map((i) => i.detector)).toContain("unanswered_questions");
  });
});

describe("fatigue: dismissed stays dismissed, snoozed sleeps, the daily surface cap holds", () => {
  it("a dismissed idea stays quiet on the next scans; only materially new evidence after a quiet period reopens it", async () => {
    const t = tenant();
    await asks(t, 5);
    await runInitiativeScan(t.g, { trigger: "test" });
    const [i] = await listInitiatives(t.g.business.id);
    await applyInitiativeAction(t.g.business.id, i.id, { kind: "dismiss" });
    await asks(t, 1);
    const again = await runInitiativeScan(t.g, { trigger: "test" });
    expect(again.scan.suppressed).toBe(1);
    expect((await listInitiatives(t.g.business.id))[0].state).toBe("dismissed");
    // Even much more evidence is held back inside the quiet period…
    await asks(t, 6);
    const held = await runInitiativeScan(t.g, { trigger: "test", force: true });
    expect(held.scan.suppressed).toBe(1);
    // …and only after it, with materially new evidence, does it return.
    const d = (await listInitiatives(t.g.business.id))[0];
    await saveInitiative({ ...d, dismissal: { at: new Date(Date.now() - 15 * 24 * 3600_000).toISOString(), metric: d.dismissal!.metric } });
    await runInitiativeScan(t.g, { trigger: "test", force: true });
    expect((await listInitiatives(t.g.business.id))[0].state).toBe("surfaced");
    expect(materiallyNew({ count: 6 }, { count: 7 })).toBe(false);
    expect(materiallyNew({ count: 6 }, { count: 12 })).toBe(true);
  });

  it("snoozed sleeps until its date; at most 3 scans per business-local day (by the business's calendar, not UTC)", async () => {
    const t = tenant();
    await asks(t, 5);
    const at = (iso: string) => new Date(iso);
    // 23:30 in Jerusalem on Oct 1 is 20:30 UTC; 00:30 Oct 2 local is 21:30 UTC the same UTC day.
    for (let k = 0; k < 3; k++) expect((await runInitiativeScan(t.g, { trigger: "test", now: at("2026-10-01T20:30:00.000Z") })).scan.skipped).toBeUndefined();
    expect((await runInitiativeScan(t.g, { trigger: "test", now: at("2026-10-01T20:40:00.000Z") })).scan.skipped).toMatch(/limit/);
    const nextDay = await runInitiativeScan(t.g, { trigger: "test", now: at("2026-10-01T21:30:00.000Z") });
    expect(nextDay.scan.skipped).toBeUndefined();
    expect(nextDay.scan.localDate).toBe("2026-10-02");
    const [i] = await listInitiatives(t.g.business.id);
    await applyInitiativeAction(t.g.business.id, i.id, { kind: "snooze", days: 7 }, at("2026-10-02T08:00:00.000Z"));
    await runInitiativeScan(t.g, { trigger: "test", now: at("2026-10-03T08:00:00.000Z"), force: true });
    expect((await listInitiatives(t.g.business.id))[0].state).toBe("snoozed");
    const m = await initiativeMetrics(t.g.business.id);
    expect(m).toMatchObject({ scans: 5, scansSkipped: 1, snoozed: 1 });
  });
});

describe("tenants, money truth and plans", () => {
  it("one tenant's evidence never affects another; foreign references fail verification", async () => {
    const a = tenant();
    await asks(a, 5);
    const b = tenant();
    await runInitiativeScan(b.g, { trigger: "test" });
    expect(await listInitiatives(b.g.business.id)).toEqual([]);
    await runInitiativeScan(a.g, { trigger: "test" });
    const [ia] = await listInitiatives(a.g.business.id);
    const sb = await buildSnapshot(b.g);
    const borrowed = { ...ia, window: ia.provenance.window, counts: "conversation" as const };
    expect(verifyCandidate(borrowed, sb)).toMatchObject({ ok: false });
  });

  it("test money never becomes money; abandoned demand is noticed on every plan — the plan changes what BARRY can do, not what it sees", async () => {
    const t = tenant();
    for (let k = 0; k < 2; k++) {
      const id = conv("cart");
      await t.say(id, "the midnight dress");
      await t.say(id, "add it in M");
    }
    await runInitiativeScan(t.g, { trigger: "test" });
    const demand = (await listInitiatives(t.g.business.id)).find((i) => i.detector === "abandoned_demand")!;
    expect(demand).toMatchObject({ canAct: true, entitlement: "included", testData: true, recommendation: { action: { kind: "command" } } });
    expect(demand.metric.amount).toBeUndefined(); // only simulated carts → no money claimed
    expect(demand.impact.amount).toBeUndefined();

    const core = tenant();
    for (let k = 0; k < 2; k++) {
      const id = conv("cart");
      await core.say(id, "the midnight dress");
      await core.say(id, "add it in M");
    }
    await selectPlan(core.g.business.id, { plan: "CORE" }, { by: "founder-test", reason: "core" });
    await runInitiativeScan(core.g, { trigger: "test" });
    const coreDemand = (await listInitiatives(core.g.business.id)).find((i) => i.detector === "abandoned_demand")!;
    expect(coreDemand).toMatchObject({ canAct: false, entitlement: "not_included", ownerActionNeeded: true });
    // Acting is refused, and even the command itself would be blocked by the plan in the normal pipeline.
    expect(await actOnInitiative(core.g, coreDemand.id, "req-1")).toMatchObject({ ok: false });
    const direct = await executeOwnerCommand({ graph: core.g, source: "web", actor: { kind: "web" }, key: "web:core-1", text: "Recover abandoned checkouts" });
    expect(direct.reply.text).toMatch(/aren't part of your current plan/);
  });

  it("'Do this' runs through the owner command service and links the operation for measurement", async () => {
    const t = tenant();
    for (let k = 0; k < 2; k++) {
      const id = conv("cart");
      await t.say(id, "the midnight dress");
      await t.say(id, "add it in M");
    }
    await runInitiativeScan(t.g, { trigger: "test" });
    const demand = (await listInitiatives(t.g.business.id)).find((i) => i.detector === "abandoned_demand")!;
    const r = await actOnInitiative(t.g, demand.id, "req-1");
    expect(r.ok && r.reply.text).toMatch(/Found 2 abandoned checkouts/);
    const after = (await listInitiatives(t.g.business.id)).find((i) => i.id === demand.id)!;
    expect(after.state).toBe("acting");
    expect(after.result?.operationId).toMatch(/^op_/);
    // The same request again is idempotent at the command layer: no second operation.
    await actOnInitiative(t.g, demand.id, "req-1");
    expect((await getBackend().listOperatorRecords(t.g.business.id, "owner_operation")).length).toBe(1);
    expect((await initiativeMetrics(t.g.business.id)).actionsStarted).toBe(1);
  });

  it("repeated approvals of the same kind suggest a standing rule — BARRY never changes authority itself", async () => {
    const t = tenant();
    for (let k = 0; k < 3; k++) {
      const id = conv("disc");
      await t.say(id, "the midnight dress");
      await t.say(id, "add it in M");
      await t.say(id, "could you ask the owner to approve 10% off this dress?");
      const [a] = (await getBackend().listApprovals(t.g.business.id)).filter((x) => x.conversationId === id);
      await resumeAfterApproval(t.g, a.id, "approved", "owner");
    }
    const before = JSON.stringify(t.g.authority ?? null);
    await runInitiativeScan(t.g, { trigger: "test" });
    const friction = (await listInitiatives(t.g.business.id)).find((i) => i.detector === "repeat_approvals")!;
    expect(friction).toMatchObject({ category: "owner_friction", canAct: false, authority: "owner_decides", metric: { count: 3, total: 3 } });
    expect(friction.recommendation.action).toMatchObject({ kind: "link" });
    expect(JSON.stringify(t.g.authority ?? null)).toBe(before);
    expect(await getBackend().listOperatorRecords(t.g.business.id, "learning_change")).toEqual([]);
  });
});

describe("money, cost and research truth (pure detectors)", () => {
  const base = (over: Partial<Snapshot> = {}): Snapshot => ({
    businessId: "b1", timezone: "UTC", now: new Date("2026-10-01T12:00:00.000Z"),
    window: { d7: "2026-09-25T00:00:00.000Z", d14: "2026-09-18T00:00:00.000Z", d30: "2026-09-02T00:00:00.000Z", d60: "2026-08-03T00:00:00.000Z", localDate: "2026-10-01" },
    knowledgeTopics: [], plan: { proactive: true, margins: false, name: null }, rules: [], obligations: [], approvals: [], conversations: [], orders: [], opportunities: [], activeWorkflows: [], costEvidence: [], simulatedSystems: [], ...over,
  });
  const opp = (id: string, simulated: boolean) => ({ id, kind: "payment_failed" as const, customer: "X", conversationId: "c", since: "2026-09-30T00:00:00.000Z", ageHours: 30, amount: 300, currency: "ILS", simulated, evidence: [], reasoning: "", next: { who: "customer" as const, action: "" }, recoverable: true });

  it("money at risk only from real records; test money never; verification refuses money from test records", () => {
    expect(moneyAtRisk(base({ opportunities: [opp("p1", true)] }))).toEqual([]);
    const s = base({ opportunities: [opp("p1", false), opp("p2", true)] });
    const [c] = moneyAtRisk(s);
    expect(c.metric).toEqual({ count: 1, amount: { ILS: 300 } });
    expect(verifyCandidate(c, s)).toEqual({ ok: true });
    const forged = { ...c, evidence: [{ kind: "payment" as const, id: "p2" }] };
    expect(verifyCandidate(forged, s)).toMatchObject({ ok: false });
    expect(verifyCandidate({ ...c, metric: { ...c.metric, count: 4 } }, s)).toMatchObject({ ok: false, reason: expect.stringMatching(/stated 4/) });
  });

  it("cost: nothing without verified records; a rise is reported as a rise — never as a saving", () => {
    const rec = (id: string, at: string, amount: number, verified = true) => ({ id, businessId: "b1", kind: "shipping_fulfillment" as const, amount, currency: "ILS", at, source: { system: "x", reference: id }, verified });
    expect(costSignals(base())).toEqual([]);
    expect(costSignals(base({ plan: { proactive: true, margins: true, name: null } }))).toEqual([]);
    const [needs] = costSignals(base({ plan: { proactive: true, margins: true, name: "Intelligence" } }));
    expect(needs).toMatchObject({ detector: "cost_evidence_missing", impact: { type: "evidence_needed" } });
    expect(needs.metric.amount).toBeUndefined();
    const s = base({ costEvidence: [rec("a", "2026-09-10T00:00:00.000Z", 100), rec("b", "2026-09-20T00:00:00.000Z", 100), rec("c", "2026-08-10T00:00:00.000Z", 70), rec("d", "2026-08-20T00:00:00.000Z", 70), rec("e", "2026-09-21T00:00:00.000Z", 900, false)] });
    const [rise] = costSignals(s);
    expect(rise).toMatchObject({ detector: "cost_increase", impact: { type: "cost_increase" }, metric: { count: 4, amount: { ILS: 60 } } });
    expect(rise.basis).toMatch(/don't have enough evidence to claim a saving/);
    expect(verifyCandidate(rise, s)).toEqual({ ok: true });
  });

  it("external research can't become a business fact, carry a figure, or realise a saving", () => {
    expect(EXTERNAL_RESEARCH_CONNECTOR).toBeNull();
    expect(acceptExternalEvidence({ claim: "cheaper shipping", sourceType: "supplier_site" })).toMatchObject({ ok: false });
    const ok = acceptExternalEvidence({ sourceUrl: "https://example.com/rates", retrievedAt: "2026-10-01T00:00:00.000Z", claim: "rates from ₪15", sourceType: "supplier_site", claimType: "public_claim" });
    expect(ok).toMatchObject({ ok: true, businessFact: false });
    expect(savingRealisedBy([{ kind: "external" }])).toBe(false);
    expect(savingRealisedBy([{ kind: "cost_record", verified: true }])).toBe(true);
    const s = base({ opportunities: [opp("p1", false)] });
    const [c] = moneyAtRisk(s);
    expect(verifyCandidate({ ...c, external: [ok.ok ? ok.evidence : (undefined as never)] }, s)).toMatchObject({ ok: false });
  });

  it("ranking is evidence-first: money and confidence lift, already-handled and recent dismissals sink", () => {
    const x = { importance: "medium" as const, confidence: "medium" as const, metric: { count: 5 }, canAct: false, alreadyHandled: false, impact: { type: "conversion" as const }, testData: false };
    expect(score({ ...x, metric: { count: 5, amount: { ILS: 2000 } } }, { recentDismissalsInCategory: 0 })).toBeGreaterThan(score(x, { recentDismissalsInCategory: 0 }));
    expect(score({ ...x, alreadyHandled: true }, { recentDismissalsInCategory: 0 })).toBeLessThan(score(x, { recentDismissalsInCategory: 0 }));
    expect(score(x, { recentDismissalsInCategory: 2 })).toBeLessThan(score(x, { recentDismissalsInCategory: 0 }));
  });
});

describe("Ask BARRY and briefs read the persisted initiatives", () => {
  it("answers only from what scans persisted — nothing invented on demand", async () => {
    const t = tenant();
    expect(interpretCommand("What did you notice today?").intent).toEqual({ kind: "query", topic: "initiatives" });
    expect(interpretCommand("Where am I losing money?").intent).toEqual({ kind: "query", topic: "initiatives", subject: "money" });
    expect(interpretCommand("What would you improve?").intent).toMatchObject({ topic: "initiatives" });
    await asks(t, 5);
    const before = await executeOwnerCommand({ graph: t.g, source: "web", actor: { kind: "web" }, key: "web:n-1", text: "What did you notice today?" });
    expect(before.reply.text).toMatch(/Nothing stood out/); // not scanned yet → nothing claimed
    await runInitiativeScan(t.g, { trigger: "test" });
    const after = await executeOwnerCommand({ graph: t.g, source: "web", actor: { kind: "web" }, key: "web:n-2", text: "What did you notice today?" });
    expect(after.reply.text).toMatch(/5 customers asked about shipping/);
    const money = await executeOwnerCommand({ graph: t.g, source: "web", actor: { kind: "web" }, key: "web:n-3", text: "Where am I losing money?" });
    expect(money.reply.text).not.toMatch(/shipping/);
    const [i] = await listInitiatives(t.g.business.id);
    expect(initiativeMessage(i).text).toMatch(/^I noticed something worth looking at/);
  });
});
