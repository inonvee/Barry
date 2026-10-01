import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { applyControlChange, isNoop, listControlAudit, loadControls, resetControlsCacheForTests, DEFAULT_CONTROLS } from "@/lib/hq/controls";
import { getBusinessStatus, getFleet, summarizeFleet, type BusinessStatus, type Fleet } from "@/lib/hq/fleet";
import { businessActivity, activityPulse } from "@/lib/hq/activity";
import { changesSince, snapshotOf, togglePin, pushRecent } from "@/lib/hq/visits";
import { searchFleet, searchBusinessRecords } from "@/lib/hq/search";
import { focusHeadline, focusItems } from "@/lib/hq/focus";
import { groupLaunch, launchChecklist } from "@/lib/hq/launch";
import { businessPresence, fleetPresence } from "@/lib/hq/presence";
import { runQaScenario } from "@/lib/qa/scenarios";
import { formatLocal, relativeWords, localDay } from "@/lib/format/time";
import { moneyParts, moneyWords, addMoney, hasMoney } from "@/lib/format/money";
import { formatMoney } from "@/components/owner/ui";
import { rankResults } from "@/components/ds/CommandBar";
import { StatusPill } from "@/components/ds/primitives";
import { BusinessRow, prioritizeIncidents } from "@/components/hq/views";
import { ownerPresence } from "@/lib/owner/presence-model";
import type { Incident } from "@/lib/hq/incidents";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * DESIGN LANGUAGE V1 + OPERABILITY — deterministic regressions: timezone formatting, no mixed-currency
 * summation, no-op founder audit, expected-block QA outcome, command/search scoping, since-last-visit,
 * the activity read model, pinned/recent state, mobile-safe fleet rows, launch grouping, presence.
 */

let dispose: (() => void) | undefined;
beforeEach(() => resetControlsCacheForTests());
afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

const NOW = new Date("2026-09-30T12:00:00.000Z");
const TZ = "Asia/Jerusalem";

function setup() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model, id: conv("dl") };
}

function status(over: Partial<BusinessStatus> = {}): BusinessStatus {
  return {
    id: "a", name: "A", timezone: TZ, health: "healthy", stage: "simulator_only", controls: { ...DEFAULT_CONTROLS }, build: { commit: null, runtime: "x", environment: "test" }, model: { mode: "simulated", model: null, status: "healthy", summary: "ok" }, storage: "memory", channel: { whatsapp: "missing" }, providers: { commerce: "simulated", payments: "simulated", scheduling: "not used" },
    readiness: { level: "READY_FOR_SUPERVISED_PILOT", label: "Ready for a supervised pilot", blockers: [] }, interventions: 0, approvalsActive: 0, approvalsHeld: 0, handoffsOpen: 0, incidents: { high: 0, medium: 0, low: 0, open: [] }, obligations: { open: 0, needsOwner: 0, barryCanAct: 0, waitingOnCustomer: 0, blocked: 0 },
    money: { stuckWithOwner: {}, waitingOnCustomer: {}, atRisk: {}, simulated: {}, verifiedPayments: 0 }, conversations: { total: 0, last24h: 0, latestActivityAt: null }, recentChanges: [], unavailable: [],
    ...over,
  };
}
const fleetOf = (businesses: BusinessStatus[]): Fleet => ({ at: NOW.toISOString(), build: { commit: null, runtime: "x", environment: "test" }, summary: summarizeFleet(businesses), businesses });
const incident = (over: Partial<Incident>): Incident => ({ key: "failed_write:x", businessId: "a", kind: "failed_write", severity: "medium", title: "A write failed", firstSeen: NOW.toISOString(), lastSeen: NOW.toISOString(), occurrences: 1, status: "current", evidence: ["ledger"], impact: "impact", nextAction: "next", links: {}, ...over });

// ── Time: business timezone, words, never raw ISO in product copy ──────────────────────────────────

describe("time in the business timezone", () => {
  it("formats an instant in the business timezone with Today / Yesterday / weekday words", () => {
    expect(formatLocal("2026-09-30T11:05:00.000Z", TZ, NOW)).toBe("Today 14:05");
    expect(formatLocal("2026-09-29T20:30:00.000Z", TZ, NOW)).toBe("Yesterday 23:30");
    expect(formatLocal("2026-09-27T06:00:00.000Z", TZ, NOW)).toBe("Sun 09:00");
    expect(formatLocal("2026-03-01T10:00:00.000Z", TZ, NOW)).toBe("Sun 1 Mar, 12:00");
    expect(formatLocal("2025-03-01T10:00:00.000Z", TZ, NOW)).toBe("1 Mar 2025, 12:00");
    expect(formatLocal("2026-09-30T11:05:00.000Z", "America/New_York", NOW)).toBe("Today 07:05");
  });
  it("never throws on bad input and keeps the calendar day in the business timezone", () => {
    expect(formatLocal(null, TZ, NOW)).toBe("—");
    expect(formatLocal("garbage", TZ, NOW)).toBe("—");
    expect(localDay("2026-09-30T22:30:00.000Z", TZ)).toBe("2026-10-01");
    expect(relativeWords("2026-09-30T11:48:00.000Z", NOW)).toBe("12 min ago");
    expect(relativeWords("2026-10-01T12:00:00.000Z", NOW)).toBe("in 1 day");
  });
});

// ── Money: never added across currencies ──────────────────────────────────────────────────────────

describe("money is never summed across currencies", () => {
  it("renders one figure per currency and never a '+' or a combined number", () => {
    const m = { ILS: 420, USD: 30 };
    expect(moneyParts(m).map((p) => p.currency)).toEqual(["ILS", "USD"]);
    expect(moneyWords(m)).not.toContain("+");
    expect(moneyWords(m)).not.toContain("450");
    expect(formatMoney(m)).not.toContain("+");
    expect(formatMoney(m)).not.toContain("450");
    expect(formatMoney(m).split(" · ")).toHaveLength(2);
    expect(moneyWords({})).toBe("none");
    expect(hasMoney({ ILS: 0 })).toBe(false);
  });
  it("addMoney only ever adds within a currency", () => {
    expect(addMoney({ ILS: 100 }, { ILS: 20.5, USD: 3 })).toEqual({ ILS: 120.5, USD: 3 });
  });
});

// ── Founder controls: no no-op audit ──────────────────────────────────────────────────────────────

describe("founder controls write nothing when nothing changes", () => {
  it("an identical change produces no audit record and no controls write", async () => {
    const { g } = setup();
    const first = await applyControlChange(g.business.id, { pauseConsequentialWrites: true }, { by: "founder", reason: "incident", now: NOW });
    expect(first.changed).toBe(true);
    expect(first.audit).not.toBeNull();
    const again = await applyControlChange(g.business.id, { pauseConsequentialWrites: true, pausedCapabilities: [] }, { by: "founder", reason: "same again", now: new Date(NOW.getTime() + 60_000) });
    expect(again.changed).toBe(false);
    expect(again.audit).toBeNull();
    expect((await listControlAudit(g.business.id)).length).toBe(1);
    expect((await loadControls(g.business.id)).reason).toBe("incident");
    expect(isNoop({ ...DEFAULT_CONTROLS, pausedCapabilities: ["support.*"] }, { pausedCapabilities: [" support.* "] })).toBe(true);
    expect(isNoop(DEFAULT_CONTROLS, { mode: "supervised" })).toBe(false);
    const resumed = await applyControlChange(g.business.id, { pauseConsequentialWrites: false }, { by: "founder", reason: "resume", now: new Date(NOW.getTime() + 120_000) });
    expect(resumed.changed).toBe(true);
    expect((await listControlAudit(g.business.id)).length).toBe(2);
  });
});

// ── QA: expected refusal is a PASS, not an error ──────────────────────────────────────────────────

describe("QA scenario under a founder pause reports EXPECTEDLY BLOCKED", () => {
  it("the checkout scenario yields outcome expectedly_blocked with the founder policy, and 'created' once resumed", async () => {
    await applyControlChange("fashion-retailer", { pauseConsequentialWrites: true }, { by: "founder", reason: "qa expected block", now: NOW });
    const blocked = await runQaScenario("rina_checkout_pending");
    expect(blocked.outcome).toBe("expectedly_blocked");
    expect(blocked.blocked?.policyId).toBe("founder_control:writes_paused");
    expect(blocked.blocked?.step).toBe("checkout");
    expect(blocked.records.paymentRequestId).toBeUndefined();
    await applyControlChange("fashion-retailer", { pauseConsequentialWrites: false }, { by: "founder", reason: "qa resume", now: new Date(NOW.getTime() + 1000) });
    const created = await runQaScenario("rina_checkout_pending");
    expect(created.outcome).toBe("created");
    expect(created.records.paymentRequestId).toBeTruthy();
  });
});

// ── Command bar / search scoping ──────────────────────────────────────────────────────────────────

describe("command-bar search returns only real records within scope", () => {
  it("fleet search finds businesses and open incidents; business records search stays within the given business", () => {
    const a = status({ id: "a", name: "Rina Studio", incidents: { high: 1, medium: 0, low: 0, open: [incident({ severity: "high", title: "Payment provider failing", businessId: "a" })] } });
    const b = status({ id: "b", name: "Coach Riley" });
    const fleet = fleetOf([a, b]);
    expect(searchFleet("rina", fleet).map((r) => r.kind)).toEqual(["business", "incident"]);
    expect(searchFleet("coach", fleet)).toHaveLength(1);
    expect(searchFleet("provider failing", fleet)[0].kind).toBe("incident");
    expect(searchFleet("zzz", fleet)).toEqual([]);
    const hrefs = { conversation: (id: string) => `/c/${id}`, approval: () => "/a", payment: () => "/p" };
    const results = searchBusinessRecords("dana", { businessId: "a", conversations: [], approvals: [{ id: "appr_1", businessId: "a", conversationId: "c1", customerId: "x", requestedAction: "applyDiscount", requestedInput: {}, reason: "Dana asked", policyId: "p", status: "pending", createdAt: NOW.toISOString() }], payments: [{ id: "pay_1", businessId: "a", conversationId: "c1", customerId: "x", amount: 420, currency: "ILS", reason: "r", status: "pending", createdAt: NOW.toISOString() }], hrefs });
    expect(results.map((r) => r.kind)).toEqual(["approval"]);
    expect(searchBusinessRecords("pay_1", { businessId: "a", conversations: [], approvals: [], payments: [{ id: "pay_1", businessId: "a", conversationId: "c1", customerId: "x", amount: 420, currency: "ILS", reason: "r", status: "pending", createdAt: NOW.toISOString() }], hrefs })[0].kind).toBe("payment");
  });
  it("ranks local results by kind and prefix match, and does not invent result types", () => {
    const items = [
      { id: "s1", kind: "surface" as const, title: "Fleet", href: "/hq/fleet" },
      { id: "b1", kind: "business" as const, title: "Rina Studio", href: "/hq/a", keywords: ["a"] },
      { id: "s2", kind: "surface" as const, title: "Incidents", href: "/hq/incidents" },
    ];
    expect(rankResults(items, "").map((r) => r.id)).toEqual(["b1", "s1", "s2"]);
    expect(rankResults(items, "inc").map((r) => r.id)).toEqual(["s2"]);
    expect(rankResults(items, "logs")).toEqual([]);
  });
});

// ── Since you were here ───────────────────────────────────────────────────────────────────────────

describe("since-last-visit changes are derived from a durable snapshot only", () => {
  it("no snapshot → no claims; otherwise only real differences, each linking to the right view", () => {
    const before = fleetOf([status({ id: "a", name: "A" })]);
    expect(changesSince(null, before)).toEqual([]);
    const snap = snapshotOf(before);
    expect(changesSince(snap, before)).toEqual([]);
    const after = fleetOf([
      status({
        id: "a",
        name: "A",
        incidents: { high: 1, medium: 0, low: 0, open: [incident({ severity: "high", title: "AI unavailable", key: "ai_unavailable:model" })] },
        money: { stuckWithOwner: { ILS: 420 }, waitingOnCustomer: {}, atRisk: {}, simulated: {}, verifiedPayments: 2 },
        approvalsActive: 1,
        readiness: { level: "NOT_READY", label: "Not ready", blockers: ["x"] },
        model: { mode: "simulated", model: null, status: "unavailable", summary: "down" },
        recentChanges: [{ id: "ctl_1", at: new Date(NOW.getTime() + 1000).toISOString(), by: "founder", reason: "r", change: { pauseConsequentialWrites: true }, before: { ...DEFAULT_CONTROLS, pausedCapabilities: [], disabledChannels: [] }, after: { ...DEFAULT_CONTROLS, pauseConsequentialWrites: true } }],
      }),
    ]);
    const changes = changesSince(snap, after);
    expect(changes.map((c) => c.kind).sort()).toEqual(["approval_required", "capability_degraded", "founder_action", "incident_new", "money_blocked", "payment_verified", "readiness_changed"]);
    expect(changes.find((c) => c.kind === "money_blocked")?.href).toBe("/hq/a?view=money");
    expect(changes.find((c) => c.kind === "incident_new")?.href).toBe("/hq/a?view=attention");
    const resolved = changesSince(snapshotOf(after), before);
    expect(resolved.map((c) => c.kind).sort()).toEqual(["capability_recovered", "incident_resolved", "readiness_changed"]);
  });
  it("pins toggle and recents dedupe, most recent first, at most 8", () => {
    expect(togglePin({ businessIds: [] }, "a")).toEqual({ businessIds: ["a"] });
    expect(togglePin({ businessIds: ["a"] }, "a")).toEqual({ businessIds: [] });
    let recent = pushRecent([], { href: "/hq/a", label: "A", at: "1" });
    for (let i = 0; i < 10; i++) recent = pushRecent(recent, { href: `/hq/${i}`, label: String(i), at: String(i) });
    recent = pushRecent(recent, { href: "/hq/a", label: "A", at: "z" });
    expect(recent[0].href).toBe("/hq/a");
    expect(recent.filter((r) => r.href === "/hq/a")).toHaveLength(1);
    expect(recent.length).toBe(8);
  });
});

// ── Activity read model ───────────────────────────────────────────────────────────────────────────

describe("live activity read model", () => {
  it("derives what / for whom / by whom / verified / still needed from records, newest first, no raw logs", async () => {
    const { g, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "the midnight dress");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "add it in M");
    const conversations = await getConversationStore().listByBusiness(g.business.id);
    const approvals = withLifecycle(await getBackend().listApprovals(g.business.id), new Map(conversations.map((c) => [c.id, c])));
    const payments = await getBackend().listPaymentRequests(g.business.id);
    const events = businessActivity({ graph: g, conversations, approvals, payments, audit: [{ id: "ctl_1", at: NOW.toISOString(), by: "founder", reason: "why", change: { pauseConsequentialWrites: true }, before: { ...DEFAULT_CONTROLS }, after: { ...DEFAULT_CONTROLS, pauseConsequentialWrites: true } }] });
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < events.length; i++) expect(events[i - 1].at >= events[i].at).toBe(true);
    const effect = events.find((e) => e.kind === "effect");
    expect(effect?.by).toBe("barry");
    expect(effect?.forWhom).toBeTruthy();
    expect(effect?.evidence).toMatch(/^ledger #\d+/);
    const approval = events.find((e) => e.kind === "approval");
    if (approval) {
      expect(approval.stillNeeded).toBe("the owner's decision");
      expect(approval.consequential).toBe(true);
    }
    const control = events.find((e) => e.kind === "founder_control");
    expect(control?.by).toBe("founder");
    expect(control?.what).toContain("consequential writes paused");
    const pulse = activityPulse(events, new Date());
    expect(pulse.total).toBe(events.length);
    for (const e of events) expect(JSON.stringify(e)).not.toMatch(/"turns"|"messages"/);
  });
  it("the fleet detail carries the same activity and getFleet strips it", async () => {
    const { g } = setup();
    const detail = await getBusinessStatus(g, { now: NOW, detail: true });
    expect(Array.isArray(detail.activity)).toBe(true);
    const fleet = await getFleet({ now: NOW });
    expect("activity" in fleet.businesses[0]).toBe(false);
  });
});

// ── Focus, presence, fleet rows, incidents order, launch grouping ─────────────────────────────────

describe("focus, presence and the fleet row", () => {
  it("the headline counts what needs the founder and the items rank need > money > not-ready", () => {
    const a = status({ id: "a", name: "A", approvalsHeld: 1 });
    const b = status({ id: "b", name: "B", money: { stuckWithOwner: { ILS: 100 }, waitingOnCustomer: {}, atRisk: {}, simulated: {}, verifiedPayments: 0 } });
    const c = status({ id: "c", name: "C", controls: { ...DEFAULT_CONTROLS, mode: "supervised" }, readiness: { level: "NOT_READY", label: "Not ready", blockers: ["no offers"] } });
    const fleet = fleetOf([a, b, c]);
    const items = focusItems(fleet);
    expect(items.map((i) => i.key)).toEqual(["need:a", "money:b", "ready:c"]);
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3]);
    expect(focusHeadline(fleet, items.length)).toBe("BARRY is running 3 businesses. 3 things need you.");
    expect(focusHeadline(fleetOf([a]), 0)).toBe("BARRY is running 1 business. Nothing needs you.");
  });
  it("presence states have one meaning each", () => {
    expect(businessPresence(status({ controls: { ...DEFAULT_CONTROLS, pauseConsequentialWrites: true } })).state).toBe("paused");
    expect(businessPresence(status({ model: { mode: "simulated", model: null, status: "unavailable", summary: "down" } })).state).toBe("degraded");
    expect(businessPresence(status({ approvalsActive: 2 })).state).toBe("needs_you");
    expect(businessPresence(status()).state).toBe("working");
    expect(fleetPresence(fleetOf([status({ approvalsHeld: 1 })])).state).toBe("needs_you");
    expect(ownerPresence({ interventions: [], health: { ai: { status: "unavailable" } as never, systems: [] }, today: { conversations: 0 } as never, obligations: [], capabilities: {} as never }).state).toBe("degraded");
  });
  it("the fleet row renders without a table, with a status word and the business-timezone time", () => {
    const html = renderToString(createElement(BusinessRow, { b: status({ name: "Rina Studio", conversations: { total: 3, last24h: 1, latestActivityAt: "2026-09-30T11:05:00.000Z" } }), now: NOW }));
    expect(html).not.toContain("<table");
    expect(html).toContain("Rina Studio");
    expect(html).toContain("Today 14:05");
    expect(html).toContain('data-status="ok"');
    expect(html).toContain("OK");
    expect(html).toContain("flex-col");
    expect(renderToString(createElement(StatusPill, { status: "degraded" }))).toContain("Degraded");
  });
  it("incidents are ordered new → high → recurring → recent", () => {
    const rows = prioritizeIncidents([
      { incident: incident({ key: "1", status: "acknowledged", severity: "high" }) },
      { incident: incident({ key: "2", status: "current", severity: "low", occurrences: 5 }) },
      { incident: incident({ key: "3", status: "current", severity: "high" }) },
      { incident: incident({ key: "4", status: "current", severity: "low", occurrences: 1 }) },
    ]);
    expect(rows.map((r) => r.incident.key)).toEqual(["3", "2", "4", "1"]);
  });
  it("the launch checklist groups by concern with counts and one primary blocker", async () => {
    const { g } = setup();
    const gate = await launchChecklist(g, { controls: { ...DEFAULT_CONTROLS }, conversations: [] });
    const grouped = groupLaunch(gate);
    expect(grouped.groups.map((x) => x.id)).toContain("supervision");
    expect(grouped.ready + grouped.blocked + grouped.unknown).toBe(gate.items.length);
    for (const group of grouped.groups) expect(group.ready + group.blocked + group.unknown).toBe(group.items.length);
    expect(grouped.primary).not.toBeNull();
    expect(grouped.primary!.item.requiredForSupervised).toBe(true);
    expect(grouped.primary!.item.status).not.toBe("ready");
  });
});
