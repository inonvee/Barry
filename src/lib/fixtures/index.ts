import type { BusinessGraph } from "@/lib/business-graph";
import { buildSpaGraph } from "./spa";
import { buildEcommerceBagsGraph } from "./ecommerce-bags";
import { buildGarageGraph } from "./garage";
import { buildPersonalTrainerGraph } from "./personal-trainer";
import { buildFurnitureStoreGraph } from "./furniture-store";
import { buildFashionRetailerGraph } from "./fashion-retailer";
import { buildLogisticsDemoGraph, LOGISTICS_DEMO_ID } from "./logistics-demo";
import { simulationAllowed } from "@/lib/fabric/registry";

export { buildSpaGraph, buildEcommerceBagsGraph, buildGarageGraph, buildPersonalTrainerGraph, buildFurnitureStoreGraph, buildFashionRetailerGraph, buildLogisticsDemoGraph };

const BUILDERS: Record<string, () => BusinessGraph> = {
  spa: buildSpaGraph,
  "ecommerce-bags": buildEcommerceBagsGraph,
  garage: buildGarageGraph,
  "personal-trainer": buildPersonalTrainerGraph,
  "furniture-store": buildFurnitureStoreGraph,
  "fashion-retailer": buildFashionRetailerGraph,
};

export const TEST_BUSINESS_IDS = Object.keys(BUILDERS);

/**
 * PREVIEW/DEMO fixtures: businesses whose external systems are in-process
 * MOCKS. They exist only where simulation is allowed (dev, tests, an
 * explicitly-allowed preview) — elsewhere they are neither listed nor
 * loadable, and their mock connectors are refused by the Fabric anyway.
 */
const DEMO_BUILDERS: Record<string, () => BusinessGraph> = {
  [LOGISTICS_DEMO_ID]: buildLogisticsDemoGraph,
};

export function isDemoBusiness(businessId: string): boolean {
  return businessId in DEMO_BUILDERS;
}

/**
 * Fixtures rebuild a fresh graph on every call so availability windows stay
 * relative to "now". The graph itself is cached per businessId within a
 * process so repeated calls in one request share the same object identity.
 */
const cache = new Map<string, BusinessGraph>();

export function getBusinessGraph(businessId: string): BusinessGraph {
  const cached = cache.get(businessId);
  if (cached && (!isDemoBusiness(businessId) || simulationAllowed())) return cached;
  const builder = BUILDERS[businessId] ?? (simulationAllowed() ? DEMO_BUILDERS[businessId] : undefined);
  if (!builder) throw new Error(`Unknown business id: ${businessId}`);
  const graph = builder();
  cache.set(businessId, graph);
  return graph;
}

export function listBusinessSummaries(): { id: string; name: string; description: string }[] {
  const ids = [...TEST_BUSINESS_IDS, ...(simulationAllowed() ? Object.keys(DEMO_BUILDERS) : [])];
  return ids.map((id) => {
    const graph = getBusinessGraph(id);
    return { id, name: graph.business.name, description: graph.business.description };
  });
}
