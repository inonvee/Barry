import type { BusinessGraph } from "@/lib/business-graph";
import { getBusinessGraph as getFixtureBusinessGraph } from "@/lib/fixtures";

export type BusinessGraphResolver = (businessId: string) => BusinessGraph;

let resolver: BusinessGraphResolver = getFixtureBusinessGraph;

export function resolveBusinessGraph(businessId: string): BusinessGraph {
  return resolver(businessId);
}

export function setBusinessGraphResolverForTests(next: BusinessGraphResolver | undefined): void {
  resolver = next ?? getFixtureBusinessGraph;
}
