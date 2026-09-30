import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import { assessPilotReadiness, type ReadinessCheck } from "@/lib/owner/readiness";
import { assessCapabilities } from "@/lib/owner/capabilities";
import type { BusinessControls } from "./controls";
import { currentRelease, type ReleaseState } from "@/lib/release/manifest";

/**
 * DESIGN-PARTNER LAUNCH CHECKLIST + GO-LIVE GATE — founder supervision of one business before broad
 * production. Every item is evidence-based (readiness checks, the capability model, the founder's
 * controls, the release lane); what has no evidence is UNKNOWN / NEEDS PROOF, never assumed. The gate
 * answers one technical/operational question — "may this business run as a supervised design partner?"
 * — and never decides strategy. Train BARRY stays the owner's view; this is the founder's.
 */

export type LaunchItemStatus = "ready" | "blocked" | "unknown";
export type LaunchResponsibility = "owner" | "founder" | "barry_team";

export type LaunchItem = {
  id: string;
  title: string;
  status: LaunchItemStatus;
  evidence: string;
  blocker?: string;
  nextAction?: string;
  responsibility: LaunchResponsibility;
  /** Required for the supervised design-partner gate (others are for LIVE). */
  requiredForSupervised: boolean;
};

export type LaunchGate = {
  level: "READY_FOR_SUPERVISED_DESIGN_PARTNER" | "NOT_READY" | "UNKNOWN_NEEDS_PROOF";
  reason: string;
  items: LaunchItem[];
  requiredRemaining: string[];
  unknown: string[];
};

export async function launchChecklist(graph: BusinessGraph, input: { controls: BusinessControls; conversations?: ConversationState[]; release?: ReleaseState }): Promise<LaunchGate> {
  const readiness = await assessPilotReadiness(graph, { conversations: input.conversations });
  const capabilities = await assessCapabilities(graph);
  const release = input.release ?? (await currentRelease());
  const check = (id: string): ReadinessCheck | undefined => readiness.checks.find((c) => c.id === id);
  const fromCheck = (id: string, title: string, responsibility: LaunchResponsibility, requiredForSupervised: boolean, warnIsReady = false): LaunchItem => {
    const c = check(id);
    if (!c) return { id, title, status: "unknown", evidence: "no readiness check ran for this item", responsibility, requiredForSupervised };
    const ready = c.status === "pass" || (warnIsReady && c.status === "warn");
    return { id, title, status: ready ? "ready" : "blocked", evidence: c.detail, ...(ready ? {} : { blocker: c.detail, nextAction: c.fix }), responsibility, requiredForSupervised };
  };
  const items: LaunchItem[] = [];
  items.push(fromCheck("knowledge.offers", "Business understanding: offers / catalog", "owner", true));
  items.push(fromCheck("knowledge.policies", "Business understanding: policies & FAQs", "owner", true));
  items.push(fromCheck("platform.owner_access", "Owner access (own token, limited to this business)", "barry_team", true));
  items.push(fromCheck("channel.configured", "Customer channel (WhatsApp) routed", "barry_team", true));
  // Commerce / provider: real provider connected for what the business uses.
  const sell = capabilities.needs.filter((n) => n.area === "sell" || n.area === "book");
  const realSell = sell.length === 0 ? "unknown" : sell.every((n) => n.status === "ready") ? "ready" : sell.some((n) => n.status === "ready_simulated") ? "blocked" : "blocked";
  items.push({ id: "commerce.provider", title: "Commerce / booking provider is the business's real system", status: realSell, evidence: sell.length ? sell.map((n) => `${n.title}: ${n.status.replace(/_/g, " ")}${n.provider ? ` (${n.provider})` : ""}`).join("; ") : "this business uses no commerce or booking flow", ...(realSell === "blocked" ? { blocker: "Runs on a simulator only.", nextAction: "Connect the real system on the Connections page with the BARRY team." } : {}), responsibility: "barry_team", requiredForSupervised: true });
  const money = capabilities.needs.filter((n) => n.area === "money");
  const realMoney = money.length === 0 ? "unknown" : money.every((n) => n.status === "ready") ? "ready" : "blocked";
  items.push({ id: "payments.provider", title: "Payments: real provider connected", status: realMoney, evidence: money.length ? money.map((n) => `${n.title}: ${n.status.replace(/_/g, " ")}${n.provider ? ` (${n.provider})` : ""}`).join("; ") : "no payment flow", ...(realMoney === "blocked" ? { blocker: "Payments run on a simulator.", nextAction: "Connect the real payment provider with the BARRY team." } : {}), responsibility: "barry_team", requiredForSupervised: true });
  items.push(fromCheck("payments.proven", "Payments proven by a real verified transaction", "founder", false));
  items.push(fromCheck("authority.consequential", "Authority: limits and approvals set for consequential actions", "owner", true, true));
  items.push(fromCheck("handoff.path", "Handoff: the team's promise to customers is declared", "owner", true));
  items.push({ id: "readiness.level", title: `Readiness assessment: ${readiness.label}`, status: readiness.level === "NOT_READY" || readiness.level === "READY_FOR_TESTING" ? "blocked" : "ready", evidence: `${readiness.checks.filter((c) => c.status === "pass").length} of ${readiness.checks.length} checks pass`, ...(readiness.next ? { blocker: readiness.next.blockers.map((b) => b.label).join("; "), nextAction: `Next level: ${readiness.next.label}` } : {}), responsibility: "founder", requiredForSupervised: true });
  items.push(fromCheck("platform.persistence", "Storage is durable", "barry_team", true));
  items.push(fromCheck("ai.model", "Live AI model configured", "barry_team", true));
  const critical = capabilities.needs.filter((n) => n.status === "needs_setup" && (n.area === "sell" || n.area === "money" || n.area === "book" || n.area === "support"));
  items.push({ id: "capabilities.critical", title: "Critical capabilities have a system behind them", status: critical.length ? "blocked" : "ready", evidence: critical.length ? critical.map((n) => n.title).join("; ") : "every selling / money / booking / support need has a system (real or simulated)", ...(critical.length ? { blocker: `${critical.length} need${critical.length === 1 ? "" : "s"} setup`, nextAction: "See Train BARRY steps." } : {}), responsibility: "barry_team", requiredForSupervised: true });
  const verdictForThis = release.verdict && release.sha && release.verdict.sha === release.sha ? release.verdict : null;
  items.push({ id: "qa.live_proof", title: "QA / live proof for this build", status: verdictForThis ? (verdictForThis.verdict === "passed" ? "ready" : "blocked") : "unknown", evidence: verdictForThis ? `Work verdict ${verdictForThis.verdict} on ${verdictForThis.sha.slice(0, 7)} at ${verdictForThis.at}` : release.sha ? `no Work verdict recorded for ${release.sha.slice(0, 7)} (${release.nextProofRequired.length} live checks required)` : "no build sha in this environment", ...(verdictForThis?.verdict === "passed" ? {} : { nextAction: "Work runs the manifest's live checks; the founder records the verdict in HQ." }), responsibility: "founder", requiredForSupervised: true });
  items.push({ id: "founder.supervision", title: "Founder supervision mode set", status: input.controls.mode === "supervised" || input.controls.mode === "live" ? "ready" : "blocked", evidence: `mode ${input.controls.mode}${input.controls.updatedAt ? ` · set ${input.controls.updatedAt} by ${input.controls.updatedBy ?? "founder"} — ${input.controls.reason}` : " (default)"}`, ...(input.controls.mode === "simulator" ? { blocker: "Still in SIMULATOR mode.", nextAction: "Set the mode to SUPERVISED in Founder controls (with a reason)." } : {}), responsibility: "founder", requiredForSupervised: true });

  const required = items.filter((i) => i.requiredForSupervised);
  const unknown = required.filter((i) => i.status === "unknown").map((i) => i.title);
  const blocked = required.filter((i) => i.status === "blocked").map((i) => i.title);
  const level: LaunchGate["level"] = blocked.length ? "NOT_READY" : unknown.length ? "UNKNOWN_NEEDS_PROOF" : "READY_FOR_SUPERVISED_DESIGN_PARTNER";
  return {
    level,
    reason: level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" ? "Every required item has evidence." : level === "NOT_READY" ? `${blocked.length} required item${blocked.length === 1 ? "" : "s"} blocked: ${blocked.slice(0, 3).join("; ")}${blocked.length > 3 ? "…" : ""}` : `Needs proof: ${unknown.join("; ")}`,
    items,
    requiredRemaining: blocked,
    unknown,
  };
}
