import { describe, expect, it } from "vitest";
import "@/lib/fabric";
import { assessPilotReadiness } from "@/lib/owner/readiness";
import { getBusinessGraph } from "@/lib/fixtures";

/**
 * Design-partner blocker found on the real Rina checklist: "What the business offers" failed for a store
 * whose products live in its connected catalog (Genome offers: none), which pinned readiness at NOT READY
 * regardless of anything else. A connected catalog search now counts; whether that catalog is real or a
 * simulator is still judged — and still blocks — in the systems checks.
 */
describe("knowledge.offers", () => {
  it("passes for a catalog store with a connected catalog search, and says where the products come from", async () => {
    const r = await assessPilotReadiness(getBusinessGraph("fashion-retailer"), { conversations: [] });
    const c = r.checks.find((x) => x.id === "knowledge.offers")!;
    expect(c.status).toBe("pass");
    expect(c.detail).toMatch(/connected store catalog \(simulated\)/);
    // The simulator is still not a real system: the supervised gate still fails on it.
    expect(r.checks.find((x) => x.id.startsWith("systems.commerce"))?.status).toBe("fail");
    expect(r.level).toBe("READY_FOR_TESTING");
  });

  it("a policy the owner already wrote in the Genome (returns) answers the learn-business question; real gaps stay", async () => {
    const r = await assessPilotReadiness(getBusinessGraph("fashion-retailer"), { conversations: [] });
    const ids = r.checks.map((c) => c.id);
    expect(ids).not.toContain("knowledge.policy.returns");
    expect(ids).toContain("knowledge.policy.refunds"); // no refund rule written anywhere: still the owner's answer
    expect(ids).toContain("knowledge.contact.phone");
    const g = getBusinessGraph("fashion-retailer");
    const without = { ...g, knowledge: g.knowledge.filter((k) => k.topic !== "returns") };
    expect((await assessPilotReadiness(without, { conversations: [] })).checks.map((c) => c.id)).toContain("knowledge.policy.returns");
  });

  it("still fails for a business with no offers and no catalog", async () => {
    const g = getBusinessGraph("personal-trainer");
    const bare = { ...g, offers: [], capabilities: { ...g.capabilities, requiresInventory: false } };
    const c = (await assessPilotReadiness(bare, { conversations: [] })).checks.find((x) => x.id === "knowledge.offers")!;
    expect(c.status).toBe("fail");
    expect(c.detail).toBe("No products or services are defined.");
  });
});
