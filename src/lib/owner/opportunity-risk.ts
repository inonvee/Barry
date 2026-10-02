import type { Opportunity, OpportunityKind } from "./opportunities";

/** (pure, client-safe) The one rule for money likely lost unless someone acts — the At risk figure and its list both use it. */
const AT_RISK: OpportunityKind[] = ["payment_failed", "stalled_purchase"];
export function isAtRisk(i: Pick<Opportunity, "kind" | "recoverable">): boolean {
  return AT_RISK.includes(i.kind) || (i.kind === "unpaid_link" && i.recoverable);
}
