import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { effectiveGraph } from "@/lib/policy/effective";
import { discountPolicyOf } from "@/lib/policy/effective-rules";
import { saveInitiative } from "@/lib/initiative/store";
import { toView, type Initiative } from "@/lib/initiative/model";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { getOwnerOs } from "@/lib/owner/os-service";
import { activityTimeline, noticedCard, noticedState, operationWorkState, setupView, systemView } from "@/lib/owner/os";
import { executeOwnerCommand } from "@/lib/owner/command-service";
import type { PilotReadiness, ReadinessCheck } from "@/lib/owner/readiness";
import { OWNER_MORE, OWNER_NAV } from "@/components/owner/OwnerShell";
import { tabOf } from "@/components/owner/views/shared";
import { WorkView } from "@/components/owner/views/Work";
import { GET as osRoute } from "@/app/api/owner/os/route";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * THE OWNER BUSINESS OS — a productization layer over systems that already exist. These tests pin that it
 * stays a truthful projection: Needs you / Work read the real pending records and persisted initiatives;
 * Rules show exactly what the runtime enforces (with provenance); a simulator is never "real"; readiness
 * blockers say who acts and link to where it's resolved; WhatsApp and the web read the same records; and
 * reading the OS never sends, writes or loosens anything.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
  delete process.env.BARRY_OWNER_TOKENS;
  vi.unstubAllGlobals();
});

const noop = () => undefined;
const who = { customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } };

function tenant() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  return r;
}

/** A checkout under a supervised start (every consequential action needs the owner) → a real pending request. */
async function pendingRequest() {
  const r = tenant();
  await applyControlChange(r.g.business.id, { approvalRequiredForAll: true }, { by: "founder", reason: "supervised start" });
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  const id = conv("os");
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  await handleCustomerMessage(r.g, id, "c", "the midnight dress");
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
  await handleCustomerMessage(r.g, id, "c", "add it in M");
  model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
  await handleCustomerMessage(r.g, id, "c", "checkout, Adi 0505550114");
  return r;
}

function initiative(businessId: string, o: Partial<Initiative> = {}): Initiative {
  const now = new Date().toISOString();
  return {
    id: `ini-${Math.random().toString(36).slice(2, 8)}`, businessId, category: "customer_experience", detector: "unanswered_questions", subject: "missing_business_information",
    title: "Customers asked what BARRY couldn't answer", observation: "3 customers asked about delivery times.", basis: "Counted from 3 conversations in the last 7 days",
    evidence: [{ kind: "conversation", id: "c1" }, { kind: "conversation", id: "c2" }, { kind: "conversation", id: "c3" }], metric: { count: 3 },
    provenance: { scanId: "s1", detectedAt: now, window: { from: now, to: now, label: "7 days" }, localDate: now.slice(0, 10), timezone: "UTC" },
    confidence: "high", importance: "medium", impact: { type: "revenue_at_risk", amount: { ILS: 900 } }, recommendation: { text: "Teach BARRY your delivery times." },
    entitlement: "not_needed", authority: "owner_decides", canAct: false, ownerActionNeeded: true, fingerprint: `fp-${Math.random()}`, state: "surfaced", rank: 1, firstSeenAt: now, lastSeenAt: now, surfacedAt: now, scans: 1, ...o,
  };
}

describe("information architecture", () => {
  it("four daily surfaces + MORE for the OS; earlier tab links still land", () => {
    expect(OWNER_NAV.map((n) => n.id)).toEqual(["today", "ask", "work", "money"]);
    expect(OWNER_MORE.map((n) => n.id)).toEqual(["customers", "rules", "knowledge", "systems", "activity", "setup", "plan", "settings"]);
    // Owner-facing words only — no internal system names in the navigation.
    expect(JSON.stringify([...OWNER_NAV, ...OWNER_MORE].map((n) => n.label))).not.toMatch(/initiative|fabric|genome|authority|operator|capabilit|founder|commercial/i);
    expect(tabOf("inbox")).toBe("customers"); // links in WhatsApp replies already sent
    expect(tabOf("actions")).toBe("work");
    expect(tabOf("nonsense")).toBe("today");
    expect(tabOf(null)).toBe("today");
  });
});

describe("Work: Needs you, BARRY is working, BARRY noticed — from real records", () => {
  it("Needs you renders the real pending request; BARRY noticed renders a persisted initiative with every owner question answered", async () => {
    const r = await pendingRequest();
    await saveInitiative(initiative(r.g.business.id));
    await saveInitiative(initiative(r.g.business.id, { state: "dismissed", title: "An old dismissed item", decidedAt: new Date().toISOString() }));
    const ws = await getOwnerWorkspace(r.g);
    expect(ws.interventions.length).toBeGreaterThan(0);
    expect(ws.initiatives.map((i) => i.title)).toEqual(["Customers asked what BARRY couldn't answer"]);
    expect(ws.initiativeHistory.map((i) => i.title)).toEqual(["An old dismissed item"]);
    const html = renderToString(createElement(WorkView, { ws, act: async () => undefined, busyId: null, onOpen: noop, onInitiative: async () => undefined, onAsk: noop }));
    expect(html).toContain(ws.interventions[0].title.replace(/&/g, "&amp;").slice(0, 20));
    expect(html).toMatch(/BARRY noticed/);
    expect(html).toContain("Customers asked what BARRY couldn&#x27;t answer");
    expect(html).not.toContain("An old dismissed item"); // history is behind its own filter
  });

  it("one state vocabulary maps the engine's lifecycles without inventing progress", () => {
    expect(noticedState({ state: "surfaced", ownerActionNeeded: true })).toBe("new");
    expect(noticedState({ state: "reviewed", ownerActionNeeded: true })).toBe("watching");
    expect(noticedState({ state: "acting", ownerActionNeeded: false })).toBe("working");
    expect(noticedState({ state: "measured", ownerActionNeeded: false })).toBe("done");
    expect(noticedState({ state: "snoozed", ownerActionNeeded: true })).toBe("snoozed");
    expect(noticedState({ state: "invalidated", ownerActionNeeded: true })).toBe("dismissed");
    expect(operationWorkState("proposed")).toBe("waiting_on_you");
    expect(operationWorkState("waiting_on_customers")).toBe("waiting_on_customer");
    expect(operationWorkState("stopped")).toBe("done");
  });

  it("money an initiative points at is never revenue; only a measured result is verified", () => {
    const c = noticedCard(toView(initiative("b")));
    expect(c.money).toMatch(/at risk \(not revenue\)/);
    expect(c.money).not.toMatch(/made|earned|collected/i);
    expect(c.result).toBeNull();
    expect(c.approval).toMatch(/You decide/);
    const measured = noticedCard(toView(initiative("b", { state: "measured", result: { verifiedValue: { ILS: 250 } } })));
    expect(measured.result).toMatch(/verified by your provider/);
    // Not on the plan → never offered as something BARRY can do.
    expect(noticedCard(toView(initiative("b", { canAct: true, entitlement: "not_included" }))).canAct).toBe(false);
  });
});

describe("Rules BARRY follows = what the runtime enforces", () => {
  it("an owner-taught limit shows as taught by you — the same value the policy engine uses; an unconfirmed one is not used", async () => {
    const { g } = tenant();
    const now = new Date().toISOString();
    await getBackend().upsertLearnedFact({ businessId: g.business.id, key: "authority.discounts", value: "7%", classification: "policy", source: { kind: "owner" }, confidence: "high", status: "verified", ownerVerified: true, reviewedBy: "owner", reviewedAt: now, discoveredAt: now, refreshedAt: now });
    await getBackend().upsertLearnedFact({ businessId: g.business.id, key: "policy.discounts", value: "Up to 20% for everyone", classification: "policy", source: { kind: "web", url: "https://example.com", quote: "20%" }, confidence: "medium", status: "candidate", ownerVerified: false, discoveredAt: now, refreshedAt: now });
    const os = await getOwnerOs(g);
    const discount = os.rules.rules.find((r) => r.area === "Discounts")!;
    expect(discount).toMatchObject({ source: "owner", change: "teach", state: "active" });
    expect(discount.words).toMatch(/up to 7%/);
    expect(discountPolicyOf(await effectiveGraph(g))!.value).toBe(7); // the enforced value — same resolution
    expect(os.rules.rules.some((r) => /20%/.test(r.words))).toBe(false);
    expect(os.rules.pending.some((r) => /20%/.test(r.words) && r.state === "needs_answer")).toBe(true);
    // Built-in safety is always listed and can't be switched off; nothing is presented as a general policy brain.
    expect(os.rules.rules.filter((r) => r.source === "built_in" && r.change === "fixed").length).toBeGreaterThanOrEqual(3);
    expect(os.rules.notSupported.length).toBeGreaterThan(0);
  });

  it("a founder restriction appears as one, and only ever tightens", async () => {
    const { g } = tenant();
    await applyControlChange(g.business.id, { approvalRequiredForAll: true }, { by: "founder", reason: "supervised start" });
    const os = await getOwnerOs(g);
    const f = os.rules.rules.filter((r) => r.source === "founder");
    expect(f.map((r) => r.id)).toEqual(["founder.approve_all"]);
    expect(f[0]).toMatchObject({ change: "team", sourceWords: "Restriction from the BARRY team" });
  });
});

describe("Connected systems never call a simulator real", () => {
  it("SIMULATED wins over everything else; read-only and supervised are labelled as such", () => {
    const base = { domain: "commerce", provider: "memory", status: "connected" as const, missing: [], lastVerifiedAt: null, reads: ["Search the catalog"], writes: ["Create a checkout"], used: true };
    for (const mode of ["simulator", "supervised", "live"] as const) expect(systemView({ ...base, simulated: true }, mode).label).toBe("SIMULATED");
    expect(systemView({ ...base, simulated: false }, "live").label).toBe("REAL");
    expect(systemView({ ...base, simulated: false }, "supervised").label).toBe("SUPERVISED");
    expect(systemView({ ...base, simulated: false, writes: [] }, "live").label).toBe("READ-ONLY");
    expect(systemView({ ...base, simulated: false, missing: ["API key"] }, "live").label).toBe("UNAVAILABLE");
    expect(systemView({ ...base, simulated: false, status: "not_configured" }, "live").label).toBe("NOT CONNECTED");
  });

  it("on a business running on the memory simulators, no system reads REAL", async () => {
    const { g } = tenant();
    const os = await getOwnerOs(g);
    const commerce = os.systems.find((s) => s.id === "commerce")!;
    expect(commerce.label).toBe("SIMULATED");
    expect(commerce.reads.length).toBeGreaterThan(0); // what BARRY can read comes from the capabilities the system provides
    expect(os.systems.filter((s) => s.label === "REAL").map((s) => s.provider)).not.toContain("memory");
    // The test runtime has no live AI model: BARRY's understanding is labelled SIMULATED, not REAL.
    expect(os.systems.find((s) => s.id === "understanding")!.label).toBe("SIMULATED");
  });
});

describe("BARRY setup: honest readiness, every blocker actionable", () => {
  const check = (c: Partial<ReadinessCheck> & Pick<ReadinessCheck, "id" | "area" | "status" | "gate">): ReadinessCheck => ({ label: c.id, detail: `${c.id} detail`, ...c });
  const readiness = (level: PilotReadiness["level"], checks: ReadinessCheck[]): PilotReadiness => ({ level, label: level, checks });

  it("groups blockers by who acts, links each to where it's resolved, keeps release items apart, and never says ready without the level", () => {
    const r = readiness("READY_FOR_TESTING", [
      check({ id: "knowledge.policy.refunds", area: "knowledge", status: "fail", gate: "READY_FOR_SUPERVISED_PILOT" }),
      check({ id: "handoff.path", area: "handoff", status: "fail", gate: "READY_FOR_SUPERVISED_PILOT" }),
      check({ id: "systems.commerce.0", area: "systems", status: "fail", gate: "READY_FOR_SUPERVISED_PILOT" }),
      check({ id: "ai.model", area: "ai", status: "fail", gate: "READY_FOR_SUPERVISED_PILOT" }),
      check({ id: "authority.consequential", area: "authority", status: "warn", gate: "READY_FOR_SUPERVISED_PILOT" }),
      check({ id: "channel.live", area: "channel", status: "fail", gate: "READY_FOR_CUSTOMER_TRAFFIC" }),
    ]);
    const s = setupView({ readiness: r, mode: "simulator", rulesActive: 4, signedIn: true });
    expect(s.headline).toBe("4 things left before a supervised start");
    expect(s.supervisedReady).toBe(false);
    const group = (id: string) => s.groups.find((g) => g.id === id)!;
    expect(group("owner").items.map((i) => i.href)).toEqual(["/owner/knowledge#teach", "/owner/knowledge#teach"]);
    expect(group("connection").items[0].href).toBe("/owner/systems");
    expect(group("team").items.map((i) => i.id)).toEqual(["ai.model"]);
    expect(group("optional").items[0].href).toBe("/owner/rules");
    for (const g of s.groups.filter((g) => g.id === "owner" || g.id === "connection")) for (const i of g.items) expect(i.href).toBeTruthy();
    expect(s.later.map((l) => l.id)).toEqual(["channel.live"]); // the BARRY team's release requirement, apart
    expect(s.groups.flatMap((g) => g.items).some((i) => i.id === "channel.live")).toBe(false);
    expect(s.journey.find((j) => j.id === "autonomy")!.state).toBe("later"); // never automatic
    expect(setupView({ readiness: readiness("READY_FOR_SUPERVISED_PILOT", []), mode: "simulator", rulesActive: 1, signedIn: true }).headline).toBe("Ready to start supervised");
  });
});

describe("one durable truth across WhatsApp and the web", () => {
  it("a command from WhatsApp shows up in the web read model and its Activity — no channel-local state", async () => {
    const { g } = tenant();
    await executeOwnerCommand({ graph: g, source: "whatsapp", actor: { kind: "whatsapp", identityId: "whatsapp:1", masked: "···0001" }, key: "wa:os-1", text: "How much did we make today?" });
    const ws = await getOwnerWorkspace(g);
    expect(ws.ownerCommands.map((c) => [c.source, c.text])).toContainEqual(["whatsapp", "How much did we make today?"]);
    expect(activityTimeline(ws).some((a) => a.text === "You asked BARRY on WhatsApp: “How much did we make today?”")).toBe(true);
  });
});

describe("reading the OS sends nothing, writes nothing, loosens nothing", () => {
  it("getOwnerOs makes no outbound call and changes no record", async () => {
    const { g } = tenant();
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no outbound calls")));
    vi.stubGlobal("fetch", fetchSpy);
    const KINDS = ["controls", "initiative", "initiative_scan", "owner_command", "commercial_account"] as const;
    const snapshot = async () => JSON.stringify([...(await Promise.all(KINDS.map((k) => getBackend().listOperatorRecords(g.business.id, k)))), await getBackend().listLearnedFacts(g.business.id), await getBackend().listApprovals(g.business.id)]);
    const before = await snapshot();
    const os = await getOwnerOs(g);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
    // Customer WhatsApp is not presented as live in the test runtime.
    expect(os.systems.find((s) => s.id === "whatsapp_customers")!.label).not.toBe("REAL");
  });

  it("the OS endpoint is tenant-isolated: another business's owner token is refused", async () => {
    process.env.BARRY_OWNER_TOKENS = "fashion-retailer:owner-token-rina-000001,ecommerce-bags:owner-token-bags-000002";
    const req = (businessId: string, token?: string) => new NextRequest(`http://localhost/api/owner/os?businessId=${businessId}`, { headers: token ? { "x-barry-owner-token": token } : {} });
    expect((await osRoute(req("fashion-retailer"))).status).toBe(401);
    expect((await osRoute(req("fashion-retailer", "owner-token-bags-000002"))).status).toBe(401);
    const ok = await osRoute(req("fashion-retailer", "owner-token-rina-000001"));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { business: { id: string } };
    expect(body.business.id).toBe("fashion-retailer");
  });
});
