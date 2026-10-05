import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import { assessPilotReadiness, type ReadinessCheck } from "@/lib/owner/readiness";
import { assessCapabilities } from "@/lib/owner/capabilities";
import type { BusinessControls } from "./controls";
import { currentRelease, type ReleaseState } from "@/lib/release/manifest";
import { listSources } from "@/lib/learn-business/sources";
import { listLearningChanges } from "@/lib/learn-business/relearn";
import { whatsappOwnerReach } from "@/lib/channels/whatsapp";
import { linkActive, listOwnerIdentities, maskedIdentity } from "@/lib/owner-channel/identity";
import { loadBusinessProblems } from "@/lib/owner/problems";

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
  /** The Design Partner verdict — no percentages, no partial credit: unknown is BLOCKED until it is proven. */
  verdict: "READY_FOR_SUPERVISED" | "BLOCKED";
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
  // Approved sources learned + facts/policies reviewed (Learn Business V1).
  const sources = await listSources(graph.business.id).catch(() => []);
  const changes = await listLearningChanges(graph.business.id).catch(() => []);
  const fetched = sources.filter((s) => s.status === "fetched");
  items.push({ id: "knowledge.sources", title: "Approved business sources learned", status: sources.length === 0 ? "unknown" : fetched.length ? "ready" : "blocked", evidence: sources.length ? `${fetched.length} of ${sources.length} approved source${sources.length === 1 ? "" : "s"} read (${sources.map((s) => s.type).join(", ")})` : "no source approved yet", ...(sources.length === 0 ? { nextAction: "The owner approves a website, catalog, document or facts in Train BARRY." } : fetched.length ? {} : { blocker: "No approved source could be read.", nextAction: "Fix or replace the source in Train BARRY." }), responsibility: "owner", requiredForSupervised: true });
  const pendingConsequential = changes.filter((c) => c.decision === "pending" && c.impact === "consequential");
  items.push({ id: "knowledge.reviewed", title: "Facts and policies reviewed (no consequential change waiting)", status: pendingConsequential.length ? "blocked" : "ready", evidence: pendingConsequential.length ? `${pendingConsequential.length} consequential change${pendingConsequential.length === 1 ? "" : "s"} wait for the owner` : "no consequential learned change is pending", ...(pendingConsequential.length ? { blocker: "Learned consequential changes are unreviewed.", nextAction: "The owner confirms or keeps the previous value in Train BARRY." } : {}), responsibility: "owner", requiredForSupervised: true });
  items.push(fromCheck("knowledge.offers", "Business understanding: offers / catalog", "owner", true));
  items.push(fromCheck("knowledge.policies", "Business understanding: policies & FAQs", "owner", true));
  items.push(fromCheck("platform.owner_access", "Owner access (own token, limited to this business)", "barry_team", true));
  items.push(fromCheck("channel.configured", "Customer channel (WhatsApp) routed", "barry_team", true));
  // Owner WhatsApp: a line reaches the owner (dedicated, or the shared number with identity role routing) and the
  // owner has linked their own number (a verified, active link — never a synthetic QA number).
  const reach = whatsappOwnerReach(graph.business.id);
  items.push({ id: "channel.owner_whatsapp_reach", title: "Owner BARRY reachable on WhatsApp", status: reach.configured ? "ready" : "blocked", evidence: reach.configured ? (reach.via === "shared_line" ? "the business's WhatsApp number routes verified owners to Owner BARRY (identity role routing)" : "a dedicated owner WhatsApp line is configured") : "no WhatsApp line reaches Owner BARRY for this business", ...(reach.configured ? {} : { blocker: "Owner BARRY can't be reached on WhatsApp.", nextAction: "The BARRY team routes the business's WhatsApp number and turns on identity role routing." }), responsibility: "barry_team", requiredForSupervised: true });
  const ownerLinks = (await listOwnerIdentities(graph.business.id).catch(() => [])).filter((l) => linkActive(l).ok && !l.channelUserId.startsWith("999"));
  items.push({ id: "channel.owner_whatsapp_linked", title: "Owner linked their WhatsApp", status: ownerLinks.length ? "ready" : "blocked", evidence: ownerLinks.length ? `${ownerLinks.length} verified owner number${ownerLinks.length === 1 ? "" : "s"} linked (${ownerLinks.map(maskedIdentity).join(", ")})` : "no owner number is linked", ...(ownerLinks.length ? {} : { blocker: "The owner hasn't linked their WhatsApp yet.", nextAction: "The owner opens Settings → Link my WhatsApp and sends the code from their phone." }), responsibility: "owner", requiredForSupervised: true });
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

  // No unresolved critical problem (a real system down, WhatsApp refusing messages, an unverifiable payment event).
  const problems = await loadBusinessProblems(graph.business.id, { ...(input.conversations ? { conversations: input.conversations } : {}) }).catch(() => null);
  const criticalProblems = (problems ?? []).filter((p) => p.severity === "high");
  items.push({ id: "incidents.critical", title: "No unresolved critical problem", status: problems === null ? "unknown" : criticalProblems.length ? "blocked" : "ready", evidence: problems === null ? "the business's problems could not be read" : criticalProblems.length ? criticalProblems.map((p) => p.what.en).join(" ") : "no critical problem in the records", ...(criticalProblems.length ? { blocker: criticalProblems[0].what.en, nextAction: criticalProblems[0].nextStep.en } : {}), responsibility: "barry_team", requiredForSupervised: true });

  // Blockers must be explicitly zero (or accepted): any OPEN blocker from the readiness assessment counts.
  const openBlockers = readiness.next?.blockers.length ?? 0;
  items.push({ id: "blockers.zero", title: "Readiness blockers explicitly zero or accepted", status: openBlockers === 0 ? "ready" : "blocked", evidence: openBlockers === 0 ? "no open readiness blocker" : `${openBlockers} open blocker${openBlockers === 1 ? "" : "s"}: ${readiness.next?.blockers.slice(0, 3).map((b) => b.label).join("; ")}`, ...(openBlockers ? { blocker: "Open readiness blockers.", nextAction: "Clear them, or the founder accepts them explicitly in the launch review." } : {}), responsibility: "founder", requiredForSupervised: false });

  const required = items.filter((i) => i.requiredForSupervised);
  const unknown = required.filter((i) => i.status === "unknown").map((i) => i.title);
  const blocked = required.filter((i) => i.status === "blocked").map((i) => i.title);
  const level: LaunchGate["level"] = blocked.length ? "NOT_READY" : unknown.length ? "UNKNOWN_NEEDS_PROOF" : "READY_FOR_SUPERVISED_DESIGN_PARTNER";
  return {
    level,
    verdict: level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" ? "READY_FOR_SUPERVISED" : "BLOCKED",
    reason: level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" ? "Every required item has evidence." : level === "NOT_READY" ? `${blocked.length} required item${blocked.length === 1 ? "" : "s"} blocked: ${blocked.slice(0, 3).join("; ")}${blocked.length > 3 ? "…" : ""}` : `Needs proof: ${unknown.join("; ")}`,
    items,
    requiredRemaining: blocked,
    unknown,
  };
}

// ── Grouped checklist (the founder reads sections, not a flat list) ────────────────────────────────

export type LaunchGroupId = "understanding" | "connections" | "authority" | "channel" | "commerce" | "payments" | "model" | "live_proof" | "supervision";
export type LaunchGroup = { id: LaunchGroupId; title: string; items: LaunchItem[]; ready: number; blocked: number; unknown: number };
export type GroupedLaunch = { groups: LaunchGroup[]; primary: { item: LaunchItem; group: string } | null; ready: number; blocked: number; unknown: number };

const GROUP_TITLES: Record<LaunchGroupId, string> = { understanding: "Business understanding", connections: "Connections", authority: "Authority", channel: "Customer channel", commerce: "Commerce / scheduling", payments: "Payments", model: "Model", live_proof: "Live proof", supervision: "Founder supervision" };

export function launchGroupOf(itemId: string): LaunchGroupId {
  if (itemId.startsWith("knowledge.")) return "understanding";
  if (itemId === "blockers.zero" || itemId === "incidents.critical") return "supervision";
  if (itemId === "platform.owner_access" || itemId === "platform.persistence" || itemId === "capabilities.critical") return "connections";
  if (itemId.startsWith("authority.") || itemId === "handoff.path") return "authority";
  if (itemId.startsWith("channel.")) return "channel";
  if (itemId === "commerce.provider") return "commerce";
  if (itemId.startsWith("payments.")) return "payments";
  if (itemId === "ai.model") return "model";
  if (itemId === "qa.live_proof" || itemId === "readiness.level") return "live_proof";
  return "supervision";
}

/** Sections with ready / blocked / unknown counts, and ONE primary blocker (first required blocked, else first required unknown). Pure. */
export function groupLaunch(gate: LaunchGate): GroupedLaunch {
  const order: LaunchGroupId[] = ["understanding", "connections", "authority", "channel", "commerce", "payments", "model", "live_proof", "supervision"];
  const groups = order
    .map((id) => {
      const items = gate.items.filter((i) => launchGroupOf(i.id) === id);
      return { id, title: GROUP_TITLES[id], items, ready: items.filter((i) => i.status === "ready").length, blocked: items.filter((i) => i.status === "blocked").length, unknown: items.filter((i) => i.status === "unknown").length };
    })
    .filter((g) => g.items.length > 0);
  const required = gate.items.filter((i) => i.requiredForSupervised);
  const first = required.find((i) => i.status === "blocked") ?? required.find((i) => i.status === "unknown") ?? null;
  return { groups, primary: first ? { item: first, group: GROUP_TITLES[launchGroupOf(first.id)] } : null, ready: gate.items.filter((i) => i.status === "ready").length, blocked: gate.items.filter((i) => i.status === "blocked").length, unknown: gate.items.filter((i) => i.status === "unknown").length };
}

/**
 * The Design Partner verdict for the OWNER: READY FOR SUPERVISED or BLOCKED, and each blocker in plain words with who
 * acts on it ("you" or "the BARRY team"). Unknown is a blocker until proven. Pure.
 */
export type OwnerDesignPartnerView = { verdict: "READY_FOR_SUPERVISED" | "BLOCKED"; label: string; blockers: { id: string; title: string; why: string; next: string; who: "you" | "the BARRY team" }[] };
export function ownerDesignPartnerView(gate: LaunchGate): OwnerDesignPartnerView {
  const blockers = gate.items
    .filter((i) => i.requiredForSupervised && i.status !== "ready")
    .map((i) => ({ id: i.id, title: i.title, why: i.status === "unknown" ? `Not proven yet — ${i.evidence}.` : (i.blocker ?? i.evidence), next: i.nextAction ?? (i.status === "unknown" ? "The BARRY team proves it." : "The BARRY team fixes it."), who: i.responsibility === "owner" ? ("you" as const) : ("the BARRY team" as const) }));
  return { verdict: gate.verdict, label: gate.verdict === "READY_FOR_SUPERVISED" ? "Ready for a supervised start" : "Blocked", blockers };
}
