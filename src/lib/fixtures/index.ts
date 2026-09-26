import type { BusinessGraph } from "@/lib/business-graph";
import { buildSpaGraph } from "./spa";
import { buildEcommerceBagsGraph } from "./ecommerce-bags";
import { buildGarageGraph } from "./garage";
import { buildPersonalTrainerGraph } from "./personal-trainer";
import { buildFurnitureStoreGraph } from "./furniture-store";

export { buildSpaGraph, buildEcommerceBagsGraph, buildGarageGraph, buildPersonalTrainerGraph, buildFurnitureStoreGraph };

const BUILDERS: Record<string, () => BusinessGraph> = {
  spa: buildSpaGraph,
  "ecommerce-bags": buildEcommerceBagsGraph,
  garage: buildGarageGraph,
  "personal-trainer": buildPersonalTrainerGraph,
  "furniture-store": buildFurnitureStoreGraph,
};

export const TEST_BUSINESS_IDS = Object.keys(BUILDERS);

/**
 * Fixtures rebuild a fresh graph on every call so availability windows stay
 * relative to "now". The graph itself is cached per businessId within a
 * process so repeated calls in one request share the same object identity.
 */
const cache = new Map<string, BusinessGraph>();

export function getBusinessGraph(businessId: string): BusinessGraph {
  const cached = cache.get(businessId);
  if (cached) return cached;
  const builder = BUILDERS[businessId];
  if (!builder) throw new Error(`Unknown business id: ${businessId}`);
  const graph = builder();
  cache.set(businessId, graph);
  return graph;
}

export function listBusinessSummaries(): { id: string; name: string; description: string }[] {
  return TEST_BUSINESS_IDS.map((id) => {
    const graph = getBusinessGraph(id);
    return { id, name: graph.business.name, description: graph.business.description };
  });
}
