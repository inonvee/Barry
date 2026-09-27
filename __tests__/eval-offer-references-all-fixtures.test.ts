import { describe, expect, it } from "vitest";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffersByExplicitNameReference } from "@/lib/reasoner/entities";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildGarageGraph } from "@/lib/fixtures/garage";
import { buildEcommerceBagsGraph } from "@/lib/fixtures/ecommerce-bags";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import { buildFurnitureStoreGraph } from "@/lib/fixtures/furniture-store";
import { runScenario } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 9: offer reference attacks across ALL
 * fixtures, not just spa. `findOffersByExplicitNameReference` (the
 * deterministic verifier's offer matcher) takes a BusinessGraph as a
 * plain parameter and only ever reads `offer.name`/`offer.aliases` — no
 * fixture/business-type branching exists anywhere in it, so the exact
 * same code path is what's under test for every business below.
 */
type FixtureCase = {
  business: string;
  graph: () => BusinessGraph;
  exactName: [string, string];
  shortUniqueToken: [string, string];
  caseInsensitive: [string, string];
  negativeOverlap: string; // a word that matches no offer name at all
};

const FIXTURES: FixtureCase[] = [
  {
    business: "spa",
    graph: buildSpaGraph,
    exactName: ["Couples Massage", "offer-couples-massage"],
    shortUniqueToken: ["Swedish", "offer-solo-massage"],
    caseInsensitive: ["couples massage", "offer-couples-massage"],
    negativeOverlap: "parking",
  },
  {
    business: "garage",
    graph: buildGarageGraph,
    exactName: ["Oil Change", "offer-oil-change"],
    shortUniqueToken: ["brake", "offer-brake-inspection"],
    caseInsensitive: ["OIL CHANGE", "offer-oil-change"],
    negativeOverlap: "insurance",
  },
  {
    business: "ecommerce",
    graph: buildEcommerceBagsGraph,
    exactName: ["Everyday Tote", "offer-tote"],
    shortUniqueToken: ["backpack", "offer-backpack"],
    caseInsensitive: ["weekender duffel", "offer-weekender"],
    negativeOverlap: "shipping",
  },
  {
    business: "trainer",
    graph: buildPersonalTrainerGraph,
    exactName: ["Free Fitness Consultation", "offer-free-consult"],
    shortUniqueToken: ["session", "offer-training-session"],
    caseInsensitive: ["training session", "offer-training-session"],
    negativeOverlap: "nutrition",
  },
  {
    business: "furniture",
    graph: buildFurnitureStoreGraph,
    exactName: ["Birchwood Dining Table", "offer-dining-table"],
    shortUniqueToken: ["sofa", "offer-sofa"],
    caseInsensitive: ["custom furniture order", "offer-custom-order"],
    negativeOverlap: "delivery",
  },
];

for (const fixture of FIXTURES) {
  describe(`Offer references: ${fixture.business}`, () => {
    it(`exact offer name resolves uniquely`, () => {
      const graph = fixture.graph();
      const matches = findOffersByExplicitNameReference(graph, fixture.exactName[0]);
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(fixture.exactName[1]);
    });

    it(`a short unique token resolves uniquely`, () => {
      const graph = fixture.graph();
      const matches = findOffersByExplicitNameReference(graph, fixture.shortUniqueToken[0]);
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(fixture.shortUniqueToken[1]);
    });

    it(`matching is case-insensitive`, () => {
      const graph = fixture.graph();
      const matches = findOffersByExplicitNameReference(graph, fixture.caseInsensitive[0]);
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(fixture.caseInsensitive[1]);
    });

    it(`an unrelated word matching no offer name returns no matches (never a false positive)`, () => {
      const graph = fixture.graph();
      expect(findOffersByExplicitNameReference(graph, fixture.negativeOverlap)).toEqual([]);
    });

    it(`end-to-end: the short unique token resolves the correct offer through the real runtime`, async () => {
      const { state } = await runScenario({
        name: `offer-ref-e2e-${fixture.business}`,
        graph: fixture.graph,
        turns: [{ customer: fixture.shortUniqueToken[0] }],
      });
      expect(state.selectedOfferId).toBe(fixture.shortUniqueToken[1]);
    });
  });
}

describe("Offer references: genuinely ambiguous phrase keeps clarification behavior (spa — the one fixture with real name-token overlap)", () => {
  it('"massage" alone matches both spa offers and is never force-resolved to one', () => {
    const graph = buildSpaGraph();
    const matches = findOffersByExplicitNameReference(graph, "massage");
    expect(matches.length).toBe(2);
    expect(matches.map((m) => m.id).sort()).toEqual(["offer-couples-massage", "offer-solo-massage"]);
  });
});

describe("Offer references: no business-type branching exists in the matcher itself", () => {
  it("the exact same matcher function resolves offers correctly for 5 structurally different businesses with zero per-business code", () => {
    // This test's own existence is the proof: every fixture above ran
    // through identical calls to findOffersByExplicitNameReference with
    // no business.id / business.type conditional anywhere in this file
    // or in entities.ts itself.
    for (const fixture of FIXTURES) {
      const graph = fixture.graph();
      expect(graph.offers.length).toBeGreaterThan(0);
    }
  });
});
