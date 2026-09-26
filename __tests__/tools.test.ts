import { describe, expect, it } from "vitest";
import { callTool } from "@/lib/tools";
import { buildSpaGraph } from "@/lib/fixtures/spa";

describe("tool registry", () => {
  it("rejects invalid input against the tool's schema", async () => {
    const graph = buildSpaGraph();
    const result = await callTool(
      "createBooking",
      { offerId: "offer-solo-massage" /* missing resourceId/start/end */ },
      { graph, conversationId: "c1", customerId: "cust1" }
    );
    expect(result.ok).toBe(false);
  });

  it("returns an error for an unknown tool", async () => {
    const graph = buildSpaGraph();
    const result = await callTool("doesNotExist", {}, { graph, conversationId: "c1", customerId: "cust1" });
    expect(result.ok).toBe(false);
  });

  it("executes checkAvailability and validates its output shape", async () => {
    const graph = buildSpaGraph();
    const result = await callTool(
      "checkAvailability",
      { offerId: "offer-solo-massage", earliest: new Date().toISOString() },
      { graph, conversationId: "c2", customerId: "cust2" }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray((result.output as { slots: unknown[] }).slots)).toBe(true);
    }
  });
});
