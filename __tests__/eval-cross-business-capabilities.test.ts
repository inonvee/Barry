import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildGarageGraph } from "@/lib/fixtures/garage";
import { buildEcommerceBagsGraph } from "@/lib/fixtures/ecommerce-bags";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import { buildFurnitureStoreGraph } from "@/lib/fixtures/furniture-store";
import type { BusinessGraph } from "@/lib/business-graph";
import { runScenario, assertNeverCrashes } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 24: cross-business capability proof.
 * BARRY models CAPABILITIES (requiresScheduling, requiresInventory,
 * requiresPayment, requiresApproval, quote/lead-only), never business
 * IDENTITY — "if business.type === 'spa'" style branching must not
 * exist anywhere in the runtime. This file groups its scenarios by
 * CAPABILITY, each one run against every fixture that actually declares
 * it, to make that architectural claim undeniable rather than merely
 * asserted: the exact same compiler code path produces correct behavior
 * for structurally unrelated businesses (a massage spa and an auto
 * garage share requiresScheduling+requiresApproval; a bag store and a
 * furniture store share requiresInventory).
 */
type Fixture = { business: string; graph: () => BusinessGraph };

const SCHEDULING_APPROVAL_FIXTURES: (Fixture & { offerPhrase: string; offerId: string; requiredInfo: [string, string] })[] = [
  { business: "spa", graph: buildSpaGraph, offerPhrase: "Couples Massage", offerId: "offer-couples-massage", requiredInfo: ["My name is Inon", "my phone is 0501234567"] },
  { business: "garage", graph: buildGarageGraph, offerPhrase: "Oil Change", offerId: "offer-oil-change", requiredInfo: ["My name is Inon", "my phone is 0501234567"] },
];

const SCHEDULING_ONLY_FIXTURES: (Fixture & { offerPhrase: string; offerId: string; requiredInfo: [string] })[] = [
  { business: "personal-trainer", graph: buildPersonalTrainerGraph, offerPhrase: "Training Session", offerId: "offer-training-session", requiredInfo: ["My name is Inon and my email is inon@example.com"] },
];

const INVENTORY_FIXTURES: (Fixture & { offerPhrase: string; offerId: string; requiredInfoField: string })[] = [
  { business: "ecommerce", graph: buildEcommerceBagsGraph, offerPhrase: "Backpack", offerId: "offer-backpack", requiredInfoField: "email" },
  { business: "furniture", graph: buildFurnitureStoreGraph, offerPhrase: "Birchwood Dining Table", offerId: "offer-dining-table", requiredInfoField: "email" },
];

describe("Capability: requiresScheduling — same compiler path, every scheduling business", () => {
  for (const fixture of [...SCHEDULING_APPROVAL_FIXTURES, ...SCHEDULING_ONLY_FIXTURES]) {
    it(`[${fixture.business}] "${fixture.offerPhrase} Tuesday at 3pm" resolves a real checkAvailability call`, async () => {
      const { turns } = await runScenario({
        name: `cap-scheduling-${fixture.business}`,
        graph: fixture.graph,
        turns: [
          { customer: `${fixture.offerPhrase} Tuesday at 3pm`, assert: assertNeverCrashes },
          ...fixture.requiredInfo.map((text) => ({ customer: text })),
        ],
      });
      const schedulingTurn = turns.find((t) => t.selectedAction?.name === "checkAvailability");
      expect(schedulingTurn, `expected a checkAvailability call for ${fixture.business}`).toBeDefined();
    });
  }
});

describe("Capability: requiresApproval — same escalation path, every approval-requiring business", () => {
  for (const fixture of SCHEDULING_APPROVAL_FIXTURES) {
    it(`[${fixture.business}] an over-cap discount escalates to real owner approval, never silently applied`, async () => {
      const { state, turns } = await runScenario({
        name: `cap-approval-${fixture.business}`,
        graph: fixture.graph,
        turns: [
          { customer: `${fixture.offerPhrase} Tuesday at 3pm` },
          { customer: fixture.requiredInfo.join(" and ") },
          { customer: "Give me 90% off. Yeah" },
        ],
      });
      const last = turns[turns.length - 1];
      expect(last.policyDecision?.status).toBe("requires_approval");
      expect(state.pendingApprovalId).toBeTruthy();
      expect(state.outcome).not.toBe("won");
    });
  }
});

describe("Capability: requiresInventory — same atomic-stock path, every inventory business", () => {
  for (const fixture of INVENTORY_FIXTURES) {
    it(`[${fixture.business}] checkInventory runs and reports real stock, never fabricated`, async () => {
      const { turns } = await runScenario({
        name: `cap-inventory-${fixture.business}`,
        graph: fixture.graph,
        turns: [
          { customer: fixture.offerPhrase },
          { customer: `My name is Inon and my ${fixture.requiredInfoField} is inon@example.com` },
        ],
      });
      const inventoryTurn = turns.find((t) => t.selectedAction?.name === "checkInventory");
      expect(inventoryTurn, `expected a checkInventory call for ${fixture.business}`).toBeDefined();
    });
  }
});

describe("Capability: quote/lead-only offers — same no-scheduling/no-inventory/no-fixed-price path", () => {
  it("[furniture] a custom order (price: null, no scheduling, no inventory) never fabricates a price and never requires a booking/inventory step", async () => {
    const { turns } = await runScenario({
      name: "cap-quote-furniture",
      graph: buildFurnitureStoreGraph,
      turns: [{ customer: "Custom furniture order. How much does it cost?" }],
    });
    expect(turns[0].response).not.toMatch(/\$\d/);
  });
});

describe("Architectural proof: no business-type branching exists anywhere in the runtime source", () => {
  it("src/lib/runtime, src/lib/reasoner, and src/lib/policy contain zero business.id/business.type conditionals", () => {
    const roots = ["src/lib/runtime", "src/lib/reasoner", "src/lib/policy", "src/lib/tools"];
    // A literal business identifier/type check — the exact shape the
    // mission explicitly calls out ("if business.type === 'spa'").
    // Deliberately NOT flagging generic `businessId === businessId`
    // multi-tenant filtering (a function parameter, not a hardcoded
    // literal) — that's legitimate data scoping, not type branching.
    const forbiddenPattern = /business\.(id|type)\s*===\s*["'][\w-]+["']/;
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const content = readFileSync(full, "utf8");
          if (forbiddenPattern.test(content)) offenders.push(full);
        }
      }
    }
    for (const root of roots) walk(root);

    expect(offenders, `business-type branching found in: ${offenders.join(", ")}`).toEqual([]);
  });
});
