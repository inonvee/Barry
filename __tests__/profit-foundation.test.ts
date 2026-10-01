import { describe, expect, it } from "vitest";
import { financialImpact, isRealized, profitOpportunities, type CostEvidence } from "@/lib/finance/impact";
import { revenueSummary } from "@/lib/owner/revenue";
import { getBusinessGraph } from "@/lib/fixtures";
import { summarizeFleet, type BusinessStatus } from "@/lib/hq/fleet";
import { DEFAULT_CONTROLS } from "@/lib/hq/controls";

/** CHECKPOINT 5 (foundation) + the supervised-mode visibility rule of checkpoint 4. */

describe("profit / margin foundation: strict semantics, zero without evidence", () => {
  const g = getBusinessGraph("fashion-retailer");
  const ev = (over: Partial<CostEvidence> & { id: string; kind: CostEvidence["kind"]; amount: number }): CostEvidence => ({ businessId: g.business.id, currency: "ILS", at: "2026-09-01T00:00:00.000Z", source: { system: "test-ledger", reference: over.id }, verified: true, ...over });

  it("no cost evidence → no opportunities; impact shows verified revenue only, savings all zero", () => {
    const now = new Date();
    const revenue = revenueSummary({ graph: g, conversations: [], bookings: [], orders: [], approvals: [], now, payments: [{ id: "p1", businessId: g.business.id, conversationId: "c", customerId: "x", amount: 120, currency: "ILS", reason: "r", status: "paid", createdAt: now.toISOString(), verifiedAt: now.toISOString(), provider: "payplus" }] });
    const opportunities = profitOpportunities(g.business.id, []);
    expect(opportunities).toEqual([]);
    const impact = financialImpact(revenue, opportunities);
    expect(impact).toMatchObject({ generated: { ILS: 120 }, recovered: {}, saved: { realized: {}, potential: {}, proposed: {}, negotiated: {} }, evidenceCount: 0 });
  });

  it("verified evidence produces evidence-backed POTENTIAL opportunities with stated assumptions; unverified or another business's evidence is ignored; nothing is realised", () => {
    const fees = [1, 2, 3].map((i) => ev({ id: `fee${i}`, kind: "payment_fee", amount: 10 }));
    const foreign = ev({ id: "x", kind: "discount", amount: 500, businessId: "other" });
    const unverified = ev({ id: "u", kind: "discount", amount: 500, verified: false });
    const discount = ev({ id: "d1", kind: "discount", amount: 42 });
    const exposure = ev({ id: "e1", kind: "deposit_no_show", amount: 150, exposure: true });
    const out = profitOpportunities(g.business.id, [...fees, foreign, unverified, discount, exposure]);
    expect(out.map((o) => o.id)).toEqual([`payment_fees:${g.business.id}`, `discounts:${g.business.id}`, `exposure:${g.business.id}`]);
    for (const o of out) {
      expect(o.state).toBe("POTENTIAL");
      expect(o.assumptions.length).toBeGreaterThan(0);
      expect(o.evidence.every((e) => e.verified && e.businessId === g.business.id)).toBe(true);
      expect(isRealized(o)).toBe(false);
    }
    expect(out[1].estimatedImpact).toEqual({ amount: 42, currency: "ILS", per: "period" });
    const impact = financialImpact(revenueSummary({ graph: g, conversations: [], bookings: [], orders: [], approvals: [], payments: [] }), out);
    expect(impact.saved.realized).toEqual({});
    expect(impact.saved.potential.ILS).toBe(4.5 + 42 + 150);
    // Only a REALIZED opportunity with evidence counts as saved.
    const realized = { ...out[1], state: "REALIZED" as const, realized: { amount: 20, currency: "ILS", evidence: [discount] } };
    expect(isRealized(realized)).toBe(true);
    expect(financialImpact(revenueSummary({ graph: g, conversations: [], bookings: [], orders: [], approvals: [], payments: [] }), [realized]).saved.realized).toEqual({ ILS: 20 });
    expect(isRealized({ ...realized, realized: { ...realized.realized, evidence: [] } })).toBe(false);
  });
});

describe("supervised mode surfaces incidents aggressively", () => {
  const base: BusinessStatus = {
    id: "a", name: "A", timezone: "Asia/Jerusalem", health: "attention", stage: "simulator_only", controls: { ...DEFAULT_CONTROLS }, build: { commit: null, runtime: "x", environment: "test" }, model: { mode: "simulated", model: null, status: "healthy", summary: "" }, storage: "memory", channel: { whatsapp: "missing" }, providers: { commerce: "simulated", payments: "simulated", scheduling: "not used" },
    readiness: { level: "READY_FOR_SUPERVISED_PILOT", label: "Ready for a supervised pilot", blockers: [] }, interventions: 0, approvalsActive: 0, approvalsHeld: 0, handoffsOpen: 0,
    incidents: { high: 0, medium: 0, low: 1, open: [{ key: "k", businessId: "a", kind: "stale_unpaid_link", severity: "low", title: "Unpaid link", firstSeen: "2026-01-01", lastSeen: "2026-01-01", occurrences: 1, status: "current", evidence: [], impact: "", nextAction: "", links: {} }] },
    obligations: { open: 0, needsOwner: 0, barryCanAct: 0, waitingOnCustomer: 0, blocked: 0 }, money: { stuckWithOwner: {}, waitingOnCustomer: {}, atRisk: {}, simulated: {}, verifiedPayments: 0 }, conversations: { total: 0, last24h: 0, latestActivityAt: null }, recentChanges: [], unavailable: [],
  };
  it("a low incident is silent on a simulator-only business but needs the founder and is listed as broken on a supervised one", () => {
    const sim = summarizeFleet([base]);
    expect(sim.needFounder).toEqual([]);
    expect(sim.broke).toEqual([]);
    const sup = summarizeFleet([{ ...base, controls: { ...DEFAULT_CONTROLS, mode: "supervised" } }]);
    expect(sup.needFounder).toEqual([{ id: "a", name: "A", why: "1 open incident (supervised)" }]);
    expect(sup.broke).toHaveLength(1);
  });
});
