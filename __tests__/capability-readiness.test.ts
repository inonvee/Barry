import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { getBusinessGraph } from "@/lib/fixtures";
import { buildLogisticsDemoGraph } from "@/lib/fixtures/logistics-demo";
import { assessCapabilities, deriveCapabilities, type CapabilityInput } from "@/lib/owner/capabilities";
import { assessPilotReadiness } from "@/lib/owner/readiness";
import { getTrainingProfile } from "@/lib/owner/training";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { askOwnerBarry } from "@/lib/owner/ask";
import type { CapabilityProfiles } from "@/lib/capabilities/model";

/**
 * ONE capability-readiness model: business need → required capabilities → provider / authority /
 * platform → what BARRY can do now, what only works on a simulator, and what each setup step unlocks.
 * Train BARRY, Health, Owner Barry and readiness all read it.
 */

const ENV = ["BARRY_OWNER_TOKEN", "BARRY_OWNER_TOKENS", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "BARRY_WHATSAPP_ROUTES", "BARRY_WHATSAPP_SEND"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const profile = (capability: CapabilityProfiles[keyof CapabilityProfiles]["capability"], over: Partial<CapabilityProfiles[keyof CapabilityProfiles]> = {}): CapabilityProfiles[keyof CapabilityProfiles] => ({ capability, used: true, provider: null, status: "not_configured", simulated: false, operations: [], missingOperations: [], capabilities: [], ...over });

function baseInput(over: Partial<CapabilityInput> = {}): CapabilityInput {
  return {
    graph: getBusinessGraph("fashion-retailer"),
    profiles: undefined,
    connections: [],
    surface: [],
    systems: [],
    ai: { live: false },
    durable: false,
    ownerAccess: { scoped: false, global: false },
    whatsapp: { configured: false, routed: false, missing: ["WHATSAPP_ACCESS_TOKEN"], sendMode: "dry_run" },
    ...over,
  };
}

describe("needs are derived from the Genome and resolved against real systems, authority and platform", () => {
  it("a store on simulators: selling works on the simulator only, money authority is in the owner's words, and the plan leads with the step that unlocks the most", async () => {
    const a = await assessCapabilities(getBusinessGraph("fashion-retailer"));
    const byId = Object.fromEntries(a.needs.map((n) => [n.id, n]));
    expect(byId["sell.cart"]).toMatchObject({ status: "ready_simulated", area: "sell", authority: "automatic" });
    expect(byId["sell.checkout"]).toMatchObject({ status: "ready_simulated", authority: "within_limits" });
    expect(byId["sell.checkout"].authorityWords).toBe("up to ₪2000 on its own; above that you approve; discounts up to 5% on its own");
    expect(byId["knowledge.policies"]).toMatchObject({ status: "ready" });
    expect(byId["knowledge.policies"].detail).toMatch(/returns, shipping/);
    expect(byId["handoff.team"]).toMatchObject({ status: "needs_setup", blockedBy: ["playbook.handoff"] });
    expect(byId["channel.whatsapp"]).toMatchObject({ status: "needs_setup", blockedBy: ["channel.whatsapp"] });
    expect(byId["platform.ai"]).toMatchObject({ status: "needs_setup" });
    // The step that unlocks the most comes first: the real store unlocks find / cart / checkout / order.
    expect(a.steps[0].id).toBe("real.commerce");
    expect(a.steps[0].unlocks).toEqual(expect.arrayContaining(["Build and change the customer's cart", "Send a checkout link for the cart"]));
    expect(a.steps.map((s) => s.id)).toEqual(expect.arrayContaining(["real.payments", "channel.whatsapp", "playbook.handoff", "platform.ai", "platform.memory", "platform.owner"]));
    for (const s of a.steps) expect(s.why && s.how && s.unlocks.length).toBeTruthy();
    expect(a.nowSimulated).toContain("Send a checkout link for the cart");
    expect(a.now).toContain("Quote your policies (returns, shipping, cancellations…)");
    // No provider key or capability id leaks into the owner's words.
    for (const n of a.needs) expect(`${n.title} ${n.detail} ${n.authorityWords}`).not.toMatch(/commerce\.|payments\.|scheduling\./);
  });

  it("a business's own systems appear as needs with their authority: reads on their own, consequential calls with approval (logistics demo)", async () => {
    const a = await assessCapabilities(buildLogisticsDemoGraph());
    const track = a.needs.find((n) => n.id === "capability:shipping.track")!;
    const ticket = a.needs.find((n) => n.id === "capability:support.ticket.create")!;
    expect(track).toMatchObject({ status: "ready_simulated", authority: "read" });
    expect(ticket).toMatchObject({ status: "ready_simulated", authority: "owner_approval", authorityWords: "only with your approval" });
    expect(ticket.title).toMatch(/support case|ticket/i);
    expect(a.steps.find((s) => s.id === "real.support")?.unlocks).toContain(ticket.title);
  });

  it("a connected real provider that lacks an operation gets an 'extend' step; dry-run WhatsApp gets a 'switch to live' step for customer traffic; no owner access gets its step", () => {
    const g = getBusinessGraph("spa");
    const a = deriveCapabilities(
      baseInput({
        graph: g,
        profiles: {
          commerce: profile("commerce", { used: false }),
          payments: profile("payments", { provider: "payplus", status: "connected", capabilities: ["payments.create_request"], operations: ["paymentLinks"], missingOperations: ["statusLookup"] }),
          scheduling: profile("scheduling", { provider: "google", status: "connected", capabilities: ["scheduling.availability.read", "scheduling.booking.create"] }),
          messaging: profile("messaging", { used: false }),
        },
        connections: [{ capability: "payments", provider: "payplus", status: "connected", origin: "business_connection", simulated: false, lastVerifiedAt: null, permissions: [], settings: {}, setup: [], missing: [], operations: [], system: { system: { key: "payplus", name: "PayPlus", kind: "provider" } } as never }],
        ai: { live: true, model: "gpt-x" },
        durable: true,
        whatsapp: { configured: true, routed: true, missing: [], sendMode: "dry_run" },
      })
    );
    const byId = Object.fromEntries(a.needs.map((n) => [n.id, n]));
    expect(byId["money.links"]).toMatchObject({ status: "ready", provider: "PayPlus" });
    expect(byId["money.verify"]).toMatchObject({ status: "needs_setup", blockedBy: ["support.payments"] });
    expect(a.steps.find((s) => s.id === "support.payments")).toMatchObject({ title: "Extend your payment provider connection", who: "barry_team" });
    expect(byId["book.create"]).toMatchObject({ status: "ready", provider: "google", authority: "automatic" });
    expect(byId["channel.whatsapp"]).toMatchObject({ status: "ready" });
    expect(byId["channel.whatsapp"].detail).toMatch(/dry run/);
    expect(a.steps.find((s) => s.id === "channel.live")).toMatchObject({ gate: "customer_traffic" });
    expect(byId["platform.ai"]).toMatchObject({ status: "ready", provider: "gpt-x" });
    expect(byId["platform.owner"]).toMatchObject({ status: "needs_setup", blockedBy: ["platform.owner"] });
    expect(a.now).toEqual(expect.arrayContaining(["Send payment links for exact amounts", "Book appointments", "Talk to customers on WhatsApp"]));
  });

  it("bookings that need approval and offers without hours produce the right authority and knowledge needs", () => {
    const g = getBusinessGraph("spa");
    const withApproval = { ...g, business: { ...g.business, operatingHours: [] }, policies: [...g.policies.filter((p) => p.rule.type !== "bookings_auto_allowed"), { id: "b", description: "approve bookings", rule: { type: "bookings_auto_allowed" as const, value: false } }] };
    const a = deriveCapabilities(baseInput({ graph: withApproval }));
    expect(a.needs.find((n) => n.id === "book.create")).toMatchObject({ authority: "owner_approval", authorityWords: "only with your approval" });
    expect(a.needs.find((n) => n.id === "knowledge.hours")).toMatchObject({ status: "needs_setup", blockedBy: ["genome.hours"] });
    expect(a.steps.find((s) => s.id === "genome.hours")).toMatchObject({ who: "you", gate: "testing" });
  });
});

describe("every owner surface reads the same model", () => {
  it("Train BARRY, the workspace and Owner Barry agree on what BARRY can do now and what setup unlocks", async () => {
    const g = getBusinessGraph("fashion-retailer");
    const [profile, ws, direct] = await Promise.all([getTrainingProfile(g), getOwnerWorkspace(g), assessCapabilities(g)]);
    expect(profile.assessment.now).toEqual(direct.now);
    expect(ws.capabilities.now).toEqual(direct.now);
    expect(ws.capabilities.steps.map((s) => s.id)).toEqual(direct.steps.slice(0, 6).map((s) => s.id));
    const answer = await askOwnerBarry(g, "What can you do for me?");
    expect(answer.briefing.capabilities.canDoNow).toEqual(direct.now);
    expect(answer.briefing.capabilities.afterSetup[0]).toMatchObject({ step: direct.steps[0].title, unlocks: direct.steps[0].unlocks });
    expect(answer.answer).toMatch(/BARRY can do now:/);
  });

  it("readiness blockers and capability steps agree on owner access, channel, handoff and AI", async () => {
    const g = getBusinessGraph("spa");
    const [r, a] = await Promise.all([assessPilotReadiness(g), assessCapabilities(g)]);
    const blockers = new Set(r.next!.blockers.map((b) => b.id));
    const steps = new Set(a.steps.map((s) => s.id));
    expect(blockers.has("platform.owner_access")).toBe(steps.has("platform.owner"));
    expect(blockers.has("channel.configured")).toBe(steps.has("channel.whatsapp"));
    expect(blockers.has("handoff.path")).toBe(steps.has("playbook.handoff"));
    expect(blockers.has("ai.model")).toBe(steps.has("platform.ai"));
    expect(blockers.has("platform.persistence")).toBe(steps.has("platform.memory"));
  });
});
