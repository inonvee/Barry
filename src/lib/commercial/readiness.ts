import type { LaunchGate } from "@/lib/hq/launch";
import type { BusinessControls } from "@/lib/hq/controls";
import type { CommercialAccount } from "./account";
import { PLAN_CATALOG } from "./plans";

/**
 * DESIGN-PARTNER COMMERCIAL READINESS — extends the existing technical / operational launch gate
 * (hq/launch.ts) with the commercial items, and answers ONE question: may the founder start this
 * business's free month now? Every item is evidence; no evidence is NOT READY (never assumed).
 * The output is READY TO START FREE MONTH, NOT READY with the exact first blocker, or FREE MONTH
 * ALREADY STARTED (the month is never consumed twice).
 */

export type CommercialReadinessItem = { id: string; title: string; ready: boolean; evidence: string; blocker?: string; nextAction?: string };

export type CommercialReadiness = {
  level: "READY_TO_START_FREE_MONTH" | "NOT_READY" | "FREE_MONTH_ALREADY_STARTED";
  /** The exact first blocker (the order below is the order the founder works in). */
  blocker: string | null;
  items: CommercialReadinessItem[];
};

export function commercialReadiness(input: { account: CommercialAccount | null; launch: LaunchGate; controls: BusinessControls }): CommercialReadiness {
  const { account: a, launch, controls } = input;
  const launchItem = (id: string) => launch.items.find((i) => i.id === id);
  const required = launch.items.filter((i) => i.requiredForSupervised);
  const ownerItems = required.filter((i) => i.responsibility === "owner");
  const ownerNotReady = ownerItems.filter((i) => i.status !== "ready");
  const technical = required.filter((i) => i.responsibility === "barry_team");
  const technicalNotReady = technical.filter((i) => i.status !== "ready");
  const proof = launchItem("qa.live_proof");
  const items: CommercialReadinessItem[] = [
    { id: "plan.selected", title: "Plan selected", ready: !!a, evidence: a ? `${PLAN_CATALOG[a.plan].name} (${a.planVersion}) at ${a.monthlyPrice} ${a.currency}/month` : "no commercial account", ...(a ? {} : { blocker: "No plan selected.", nextAction: "Choose CORE / OPERATOR / INTELLIGENCE in HQ → Commercial." }) },
    { id: "setup.terms", title: "Setup terms recorded", ready: !!a && a.setupPrice !== null, evidence: a?.setupPrice !== null && a?.setupPrice !== undefined ? `setup ${a.setupPrice} ${a.currency} (${a.setupStatus.replace(/_/g, " ")})` : "no setup price recorded", ...(a && a.setupPrice !== null ? {} : { blocker: "Setup price not recorded.", nextAction: "Record the setup quote." }) },
    { id: "setup.settled", title: "Setup paid or waived", ready: !!a && (a.setupStatus === "paid" || a.setupStatus === "waived"), evidence: a ? `setup ${a.setupStatus.replace(/_/g, " ")}` : "—", ...(a && (a.setupStatus === "paid" || a.setupStatus === "waived") ? {} : { blocker: "Setup is not paid or waived.", nextAction: "Record the setup payment (or waive it with a reason)." }) },
    { id: "commercial.state", title: "Commercial state known", ready: !!a && (a.subscriptionState === "pre_activation" || a.subscriptionState === "free_period" || a.subscriptionState === "active"), evidence: a ? `subscription ${a.subscriptionState.replace(/_/g, " ")}` : "—", ...(a && (a.subscriptionState === "paused" || a.subscriptionState === "cancelled") ? { blocker: `Subscription is ${a.subscriptionState}.`, nextAction: "Resume or record a new agreement." } : !a ? { blocker: "No commercial state." } : {}) },
    { id: "technical", title: "Technical readiness (systems, channel, storage, AI)", ready: technicalNotReady.length === 0, evidence: technicalNotReady.length ? technicalNotReady.map((i) => `${i.title}: ${i.status}`).join("; ") : `${technical.length} technical items ready`, ...(technicalNotReady.length ? { blocker: `${technicalNotReady[0].title} — ${technicalNotReady[0].blocker ?? technicalNotReady[0].status}`, nextAction: technicalNotReady[0].nextAction } : {}) },
    { id: "owner", title: "Owner readiness (knowledge, policies, authority, handoff)", ready: ownerNotReady.length === 0, evidence: ownerNotReady.length ? ownerNotReady.map((i) => `${i.title}: ${i.status}`).join("; ") : `${ownerItems.length} owner items ready`, ...(ownerNotReady.length ? { blocker: `${ownerNotReady[0].title} — ${ownerNotReady[0].blocker ?? ownerNotReady[0].status}`, nextAction: ownerNotReady[0].nextAction } : {}) },
    { id: "live_proof", title: "Critical live proof for this build", ready: proof?.status === "ready", evidence: proof?.evidence ?? "no live-proof item", ...(proof?.status === "ready" ? {} : { blocker: "No passed Work verdict for this build.", nextAction: proof?.nextAction }) },
    { id: "supervision", title: "Founder supervision set", ready: controls.mode === "supervised" || controls.mode === "live", evidence: `mode ${controls.mode}`, ...(controls.mode === "simulator" ? { blocker: "Still in SIMULATOR mode.", nextAction: "Set SUPERVISED in Founder controls." } : {}) },
    { id: "launch.gate", title: "Design-partner launch gate", ready: launch.level === "READY_FOR_SUPERVISED_DESIGN_PARTNER", evidence: `${launch.level.replace(/_/g, " ")} — ${launch.reason}`, ...(launch.level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" ? {} : { blocker: launch.reason }) },
    { id: "free_month.unused", title: "Free month not consumed yet", ready: !a || a.subscriptionState === "pre_activation", evidence: a?.freePeriodStartsAt ? `free period started ${a.freePeriodStartsAt.slice(0, 10)}` : "not started", ...(a && a.subscriptionState !== "pre_activation" ? { blocker: "The free month has already started (or ended)." } : {}) },
  ];
  if (a && a.subscriptionState !== "pre_activation" && a.freePeriodStartsAt) return { level: "FREE_MONTH_ALREADY_STARTED", blocker: null, items };
  const first = items.find((i) => !i.ready);
  return { level: first ? "NOT_READY" : "READY_TO_START_FREE_MONTH", blocker: first ? `${first.title}: ${first.blocker ?? first.evidence}` : null, items };
}
