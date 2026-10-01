import type { BusinessGraph } from "@/lib/business-graph";
import { getOwnerWorkspace, type OwnerWorkspace } from "@/lib/owner/service";
import { financialImpact, isRealized, profitOpportunities, type CostEvidence } from "@/lib/finance/impact";
import { listCostEvidence } from "@/lib/finance/evidence";
import type { Money } from "@/lib/owner/revenue";
import { currentEntitlement, hasFeature, type Entitlement } from "./entitlements";
import { FEATURE_WORDS, PLAN_CATALOG, planUnlocking, type Feature } from "./plans";
import type { Period } from "./cost";

/**
 * VALUE ACCOUNTING — what BARRY delivered, under strict evidence contracts (the SAME classification the
 * owner dashboard uses; no second rule, no vanity attribution):
 *
 *   BARRY HANDLED   conversations BARRY carried with no human (no owner request, no handoff, no failed
 *                   understanding) + verified business outcomes it completed (payments, bookings, orders,
 *                   cases) — simulated / test outcomes never count.
 *   BARRY MADE      GENERATED = provider-verified payments BARRY collected; RECOVERED = verified money
 *                   that came back after an earlier loss. Pending / simulated / unverified never count.
 *   BARRY SAVED     only REALIZED, evidence-backed savings. Potential / proposed / negotiated are listed
 *                   apart and never added.
 *   BARRY NEEDS YOU how many conversations needed the owner (an approval or a handoff).
 */

export type ValueAccount = {
  period: Period;
  handled: { conversations: number; outcomes: number; byKind: Record<string, number>; detail: string };
  made: { generated: Money; recovered: Money; excludedSimulated: Money; openOpportunity: Money };
  saved: { realized: Money; notCounted: { potential: Money; proposed: Money; negotiated: Money }; marginsAvailable: boolean; marginsNote: string | null };
  needsYou: { conversations: number; waitingNow: number };
  activeConversations: number;
  workingOn: string[];
  blocked: string[];
  unlockNext: string[];
  unavailable: string[];
};

const COMPLETED = new Set(["paid", "booked", "order_created", "case_created"]);

export function valueAccount(input: { ws: OwnerWorkspace; period: Period; costEvidence: CostEvidence[]; entitlement: Entitlement; businessId: string }): ValueAccount {
  const { ws, period, entitlement } = input;
  const inWindow = (at: string) => at >= period.start && at < period.end;
  const handledConversations = ws.conversations.filter((c) => c.handledAutonomously && inWindow(c.lastActivityAt)).length;
  const done = ws.outcomes.filter((o) => COMPLETED.has(o.kind) && !o.simulated && inWindow(o.at));
  const outcomes = done.length;
  const byKind: Record<string, number> = {};
  for (const o of done) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  const marginsAvailable = hasFeature(entitlement, "margins");
  const opportunities = marginsAvailable ? profitOpportunities(input.businessId, input.costEvidence) : [];
  const impact = financialImpact(ws.revenue, opportunities);
  // Realized only: the shared guard every surface uses.
  const realized: Money = {};
  for (const o of opportunities) if (isRealized(o)) realized[o.realized!.currency] = Math.round(((realized[o.realized!.currency] ?? 0) + o.realized!.amount) * 100) / 100;
  const marginsNote = !marginsAvailable ? null : input.costEvidence.length === 0 ? "BARRY Margins needs connected cost evidence — no savings are shown without it." : null;

  const workingOn = ws.obligations.filter((o) => ["watching", "scheduled", "actionable", "waiting_on_customer"].includes(o.status)).slice(0, 5).map((o) => `${o.subject} — ${o.customer}`);
  const blocked = [
    ...ws.obligations.filter((o) => o.status === "blocked").slice(0, 3).map((o) => `${o.subject} — ${o.customer}`),
    ...ws.health.systems.filter((s) => s.state === "disconnected" || s.state === "degraded").map((s) => `${s.domain}: ${s.blockers[0] ?? s.state}`),
  ].slice(0, 5);
  const planLocked: string[] = [];
  if (entitlement.plan && entitlement.features) {
    for (const f of Object.keys(FEATURE_WORDS) as Feature[]) {
      if (entitlement.features.includes(f)) continue;
      const by = planUnlocking(f);
      if (by) planLocked.push(`${FEATURE_WORDS[f]} — with ${PLAN_CATALOG[by].name}`);
    }
  }
  const unlockNext = [...ws.capabilities.steps.slice(0, 3).map((s) => `${s.title}${s.unlocks.length ? ` → ${s.unlocks.slice(0, 2).join(", ")}` : ""}`), ...planLocked.slice(0, 2)];
  return {
    period,
    handled: { conversations: handledConversations, outcomes, byKind, detail: "Conversations BARRY carried with no owner request, no handoff and no failed understanding; plus verified payments, bookings, orders and cases it completed (test outcomes excluded)." },
    made: { generated: { ...impact.generated }, recovered: { ...impact.recovered }, excludedSimulated: { ...ws.revenue.simulatedPaid }, openOpportunity: { ...ws.revenue.potential } },
    saved: { realized, notCounted: { potential: impact.saved.potential, proposed: impact.saved.proposed, negotiated: impact.saved.negotiated }, marginsAvailable, marginsNote },
    needsYou: { conversations: ws.revenue.ownerInterventions, waitingNow: ws.today.interventions },
    activeConversations: ws.revenue.activeConversations,
    workingOn,
    blocked,
    unlockNext,
    unavailable: ws.unavailable,
  };
}

export async function loadValueAccount(graph: BusinessGraph, period: Period, now = new Date()): Promise<ValueAccount> {
  const ws = await getOwnerWorkspace(graph, { since: period.start, label: period.label, now });
  const costEvidence = await listCostEvidence(graph.business.id).catch(() => []);
  return valueAccount({ ws, period, costEvidence, entitlement: currentEntitlement(graph.business.id), businessId: graph.business.id });
}
