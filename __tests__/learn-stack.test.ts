import { describe, expect, it } from "vitest";
import { detectStack } from "@/lib/learn-business/stack";
import { getLearningWorkspace, reviewLearnedFact, runLearning } from "@/lib/learn-business/service";
import { StructuredDataLearner, type SourceTransport } from "@/lib/learn-business";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { getBackend } from "@/lib/store";
import type { BusinessGraph } from "@/lib/business-graph";

const SHOPIFY_PAGE = `<!doctype html><html><head><title>Maya Knits</title>
<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/0001/theme.css">
<script src="https://js.stripe.com/v3/"></script>
</head><body>
<h1>Maya Knits</h1>
<a href="https://wa.me/972501234567">Chat with us on WhatsApp</a>
<a href="https://www.instagram.com/maya.knits">Instagram</a>
</body></html>`;

const transport: SourceTransport = async () => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: Buffer.from(SHOPIFY_PAGE),
  truncated: false,
});
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];

function freshGraph(): BusinessGraph {
  const g = buildFashionRetailerGraph();
  return { ...g, business: { ...g.business, id: `stack-biz-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } };
}

describe("Learn Stack: which systems the business already runs", () => {
  it("detects commerce, payments and channels from page fingerprints, with the exact evidence", () => {
    const signals = detectStack(SHOPIFY_PAGE);
    expect(signals.map((s) => [s.capability, s.slot, s.platform])).toEqual(
      expect.arrayContaining([
        ["commerce", "platform", "Shopify"],
        ["payments", "provider", "Stripe"],
        ["messaging", "whatsapp", "WhatsApp"],
        ["messaging", "instagram", "Instagram"],
      ])
    );
    const shopify = signals.find((s) => s.platform === "Shopify")!;
    expect(SHOPIFY_PAGE.replace(/\s+/g, " ")).toContain(shopify.evidence);
    expect(shopify.evidence).toMatch(/cdn\.shopify\.com/);
  });

  it("claims nothing on a page that shows no system", () => {
    expect(detectStack("<html><body><h1>We sell shoes</h1><p>Call us.</p></body></html>")).toEqual([]);
  });

  it("stores detections as inferences, explains what to connect, and the owner's confirmation makes them facts", async () => {
    const graph = freshGraph();
    await runLearning({ graph, urls: ["https://maya-knits.example/"], approvedBy: "owner", learner: new StructuredDataLearner(), fetch: { transport, resolve } });
    const facts = await getBackend().listLearnedFacts(graph.business.id);
    const commerce = facts.find((f) => f.key === "stack.commerce.platform")!;
    expect(commerce).toMatchObject({ value: "Shopify", classification: "inference", status: "candidate", source: { kind: "web", quote: expect.stringMatching(/cdn\.shopify\.com/) } });

    const workspace = await getLearningWorkspace(graph);
    const report = Object.fromEntries(workspace.capabilityReport.map((r) => [r.capability, r]));
    // This business id has no commerce connection: BARRY says so, and names what it found.
    expect(report.commerce).toMatchObject({ status: "detected_not_connected", detected: "Shopify", canDo: [] });
    expect(report.commerce.unlock).toMatch(/Connect Shopify so BARRY can/);
    expect(report.messaging).toMatchObject({ status: "detected_not_connected", detected: expect.stringMatching(/WhatsApp/) });
    const commerceBlocker = workspace.readiness.operational.blockers.find((b) => b.capability === "commerce" && /connection/.test(b.reason))!;
    expect(commerceBlocker.fix).toMatch(/appears to use Shopify/);

    const verified = await reviewLearnedFact({ businessId: graph.business.id, factId: commerce.id, action: "verify", reviewedBy: "owner" });
    expect(verified).toMatchObject({ classification: "fact", status: "verified", ownerVerified: true });
  });

  it("a simulated provider is reported as simulated, never as a real integration", async () => {
    const workspace = await getLearningWorkspace(buildFashionRetailerGraph());
    const commerce = workspace.capabilityReport.find((r) => r.capability === "commerce")!;
    expect(commerce).toMatchObject({ status: "simulated", provider: "memory" });
    expect(commerce.canDo).toEqual(expect.arrayContaining(["check real stock", "send checkout"]));
    expect(workspace.readiness.operational.blockers.some((b) => b.capability === "commerce" && /simulated/.test(b.reason))).toBe(true);
  });
});
