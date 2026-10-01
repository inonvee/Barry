import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { consoleRows, applyConsoleFilter, fleetTransactions, globalApprovals, fleetConnectionHealth } from "@/lib/hq/console";
import { currentAssignment, trackAssignment, listAssignments, genomeRevision } from "@/lib/hq/runtime-assignment";
import { proposeChange, decideProposal, activateProposal, rollbackProposal, listProposals, riskOf } from "@/lib/hq/proposals";
import { applyControlChange, loadControls, listControlAudit, resetControlsCacheForTests } from "@/lib/hq/controls";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * CHECKPOINT 5 — HQ V2 / FLEET OPERATIONS: cross-business console filters, transaction views with
 * verified state, global approvals that never bypass the owner, connection health rows, auditable
 * runtime / version assignment, and Ask HQ V2 structured proposals (propose → approve → activate →
 * roll back; GLOBAL / CAPABILITY gated).
 */

let dispose: (() => void) | undefined;
beforeEach(() => resetControlsCacheForTests());
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});
const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("conversation console", () => {
  it("rows carry status / needs-owner / money / incident / channel and the filter narrows them; needs-owner sorts first", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("hqc");
    model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
    await handleCustomerMessage(r.g, id, "c", "the midnight dress");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
    await handleCustomerMessage(r.g, id, "c", "add it in M");
    model.plan = () => ({ commerce: { intent: "negotiate_price", requestedPrice: { amount: 350 } }, advancesTransaction: true });
    await handleCustomerMessage(r.g, id, "c", "can you do 350?");
    const conversations = await getConversationStore().listByBusiness(r.g.business.id);
    const approvals = withLifecycle(await getBackend().listApprovals(r.g.business.id), new Map(conversations.map((c) => [c.id, c])));
    const payments = await getBackend().listPaymentRequests(r.g.business.id);
    const rows = consoleRows({ businessId: r.g.business.id, businessName: "Rina", conversations, approvals, payments });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.channel).toBe("web");
    expect(["needs_owner", "waiting_on_customer", "in_progress"]).toContain(row.status);
    expect(row.needsOwner).toBe(approvals.some((a) => a.lifecycle === "active" || a.lifecycle === "held"));
    const other = { ...row, conversationId: "x2", needsOwner: false, status: "waiting_on_customer" as const, lastActivityAt: "2026-09-30T13:00:00.000Z" };
    const filtered = applyConsoleFilter([other, { ...row, needsOwner: true, status: "needs_owner" }], { needsOwner: true });
    expect(filtered.map((x) => x.conversationId)).toEqual([row.conversationId]);
    expect(applyConsoleFilter([other, row], { channel: "whatsapp" })).toEqual([]);
    expect(applyConsoleFilter([other, { ...row, needsOwner: true, status: "needs_owner" }], {}).map((x) => x.needsOwner)).toEqual([true, false]);
    expect(applyConsoleFilter([other], { sinceHours: 1 }, new Date("2026-09-30T18:00:00.000Z"))).toEqual([]);
  });

  it("transactions and approvals are read models across the fleet; the founder gets visibility, not a decision", async () => {
    const tx = await fleetTransactions({ businessId: "fashion-retailer", limit: 10 });
    for (const t of tx) expect(["cart", "payment", "order", "booking"]).toContain(t.kind);
    const approvals = await globalApprovals({ businessId: "fashion-retailer", openOnly: true, now: NOW });
    for (const a of approvals) {
      expect(a.owner).toBe("owner");
      expect(["active", "held"]).toContain(a.lifecycle);
      expect(a.ageHours).toBeGreaterThanOrEqual(0);
    }
    const health = await fleetConnectionHealth(NOW);
    expect(health.length).toBeGreaterThan(0);
    for (const h of health) {
      expect(JSON.stringify(h)).not.toMatch(/secret|token=/i);
      expect(typeof h.reverificationDue).toBe("boolean");
    }
  });
});

describe("runtime / version assignment is auditable", () => {
  it("records only when something changed; the genome revision reflects the Genome, the playbook its own revision", async () => {
    const g = { ...buildFashionRetailerGraph(), business: { ...buildFashionRetailerGraph().business, id: `assign-${Date.now()}` } };
    const first = await trackAssignment(g, NOW);
    expect(first.changed).toBe(true);
    expect(first.assignment).toMatchObject({ businessId: g.business.id, constitution: expect.any(String), runtime: { version: expect.any(String) } });
    expect(first.assignment.reasoner.model).toBeTruthy();
    const again = await trackAssignment(g, new Date(NOW.getTime() + 1000));
    expect(again.changed).toBe(false);
    expect(await listAssignments(g.business.id)).toHaveLength(1);
    const changed = await trackAssignment({ ...g, playbook: { ...g.playbook, salesStyle: "short and warm" } }, new Date(NOW.getTime() + 2000));
    expect(changed.changed).toBe(true);
    expect(changed.previous?.fingerprint).toBe(first.assignment.fingerprint);
    expect(changed.assignment.playbookRevision).not.toBe(first.assignment.playbookRevision);
    expect(changed.assignment.genomeRevision).toBe(genomeRevision(g));
    expect((await currentAssignment(g, NOW)).fingerprint).toBe(first.assignment.fingerprint);
  });
});

describe("Ask HQ V2 proposals: never a silent mutation", () => {
  it("propose → approve → activate (BUSINESS) applies the audited control change; rollback restores; GLOBAL stays gated; conflicts are named", async () => {
    const business = "fashion-retailer";
    const before = await loadControls(business);
    expect(before.safeMode).toBe(false);
    const p = await proposeChange({ instruction: "Put Rina in safe mode until the payment provider is back", scope: "BUSINESS", change: { safeMode: true }, businessIds: [business], by: "founder", now: NOW });
    expect(p).toMatchObject({ status: "proposed", scope: "BUSINESS", activation: "available", risk: "medium", affectedBusinesses: [business] });
    expect(p.diff[0]).toEqual({ businessId: business, before: { safeMode: false }, after: { safeMode: true } });
    expect((await loadControls(business)).safeMode).toBe(false); // nothing changed yet
    const auditBefore = (await listControlAudit(business)).length;
    const refusedActivation = await activateProposal({ id: p.id, by: "founder", now: NOW });
    expect(refusedActivation.refused).toMatch(/not approved/);
    await decideProposal({ id: p.id, decision: "approved", by: "founder", now: NOW });
    const activated = await activateProposal({ id: p.id, by: "founder", now: NOW });
    expect(activated.applied).toEqual([business]);
    expect(activated.proposal?.status).toBe("activated");
    expect(activated.proposal?.version).toBe(2);
    expect((await loadControls(business)).safeMode).toBe(true);
    expect((await listControlAudit(business)).length).toBe(auditBefore + 1);
    expect((await listControlAudit(business))[0].reason).toMatch(/proposal prop_/);
    const rolled = await rollbackProposal({ id: p.id, by: "founder", now: NOW });
    expect(rolled.restored).toEqual([business]);
    expect((await loadControls(business)).safeMode).toBe(false);
    expect((await listProposals()).find((x) => x.id === p.id)?.status).toBe("rolled_back");

    const global = await proposeChange({ instruction: "Pause every business", scope: "GLOBAL", change: { pausedBusiness: true }, by: "founder", now: NOW });
    expect(global).toMatchObject({ activation: "gated", risk: "high" });
    expect(global.affectedBusinesses.length).toBeGreaterThan(1);
    await decideProposal({ id: global.id, decision: "approved", by: "founder", now: NOW });
    const gated = await activateProposal({ id: global.id, by: "founder", now: NOW });
    expect(gated.applied).toEqual([]);
    expect(gated.refused).toMatch(/gated/);
    for (const id of global.affectedBusinesses) expect((await loadControls(id)).pausedBusiness).toBe(false);

    const noop = await proposeChange({ instruction: "safe mode off", scope: "BUSINESS", change: { safeMode: false }, businessIds: [business], by: "founder", now: NOW });
    expect(noop.conflicts).toContain(`${business}: already in that state`);
    await expect(proposeChange({ instruction: "x", scope: "BUSINESS", change: {}, businessIds: [business], by: "founder" })).rejects.toThrow(/at least one control/);
    await expect(proposeChange({ instruction: "x", scope: "BUSINESS", change: { safeMode: true }, businessIds: ["nope"], by: "founder" })).rejects.toThrow(/known business/);
    expect(riskOf({ mode: "live" }, "BUSINESS", 1)).toBe("high");
    expect(riskOf({ approvalRequiredForAll: true }, "BUSINESS", 1)).toBe("low");
    await applyControlChange(business, { safeMode: false }, { by: "founder", reason: "test cleanup" });
  });
});
