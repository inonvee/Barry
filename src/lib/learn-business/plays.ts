import type { BusinessGraph } from "@/lib/business-graph";
import type { LearnedFactRecord } from "@/lib/store/types";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import { handoffPath } from "@/lib/runtime/handoff";
import { usedCapabilities } from "@/lib/capabilities/model";

/**
 * BUSINESS OPERATING STRATEGY — the plays BARRY can run for this business, each grounded in actual
 * facts and connected capabilities and classified: CAN DO NOW / CAN DO AFTER SETUP / SIMULATOR ONLY /
 * NOT SUPPORTED. No play is invented from an industry; each is derived from capabilities and facts.
 */

export type PlayAvailability = "can_do_now" | "after_setup" | "simulator_only" | "not_supported";
export type PlayId = "after_hours" | "guided_selling" | "abandoned_checkout_recovery" | "support_triage" | "appointment_filling" | "cross_sell" | "payment_follow_up" | "owner_escalation";

export type OperatingPlay = {
  id: PlayId;
  title: string;
  availability: PlayAvailability;
  /** What it rests on (facts / connections) and what is missing, in owner words. */
  groundedOn: string[];
  missing: string[];
  how: string;
};

const approved = (f: LearnedFactRecord) => f.ownerVerified && (f.status === "verified" || f.status === "corrected");

export function operatingPlays(input: { graph: BusinessGraph; facts: LearnedFactRecord[]; profiles?: CapabilityProfiles }): OperatingPlay[] {
  const { graph, facts, profiles } = input;
  const used = new Set(usedCapabilities(graph));
  const fact = (key: string) => facts.find((f) => f.key === key && approved(f));
  const hours = fact("hours.opening")?.value ?? (graph.business.operatingHours ? "declared in the profile" : undefined);
  const state = (domain: keyof CapabilityProfiles): "real" | "simulated" | "missing" => {
    const p = profiles?.[domain];
    if (!p || p.status !== "connected") return "missing";
    return p.simulated ? "simulated" : "real";
  };
  const avail = (needed: ("real" | "simulated" | "missing")[], factsOk: boolean, supported = true): PlayAvailability => {
    if (!supported) return "not_supported";
    if (needed.includes("missing") || !factsOk) return "after_setup";
    if (needed.includes("simulated")) return "simulator_only";
    return "can_do_now";
  };
  const commerce = used.has("commerce") ? state("commerce") : "missing";
  const payments = used.has("payments") ? state("payments") : "missing";
  const scheduling = used.has("scheduling") ? state("scheduling") : "missing";
  const channel = state("messaging");
  const handoff = handoffPath(graph) || fact("authority.escalation")?.value;
  const out: OperatingPlay[] = [];

  out.push({ id: "after_hours", title: "Answer after hours", availability: avail([channel], Boolean(hours)), groundedOn: [hours ? `Opening hours: ${hours}` : "", channel !== "missing" ? "A customer channel is connected" : ""].filter(Boolean), missing: [hours ? "" : "Opening hours", channel === "missing" ? "A connected customer channel" : ""].filter(Boolean), how: "BARRY answers from verified facts at any hour and says when a person is back." });
  out.push({ id: "guided_selling", title: "Guided selling", availability: avail([commerce], true, used.has("commerce")), groundedOn: commerce !== "missing" ? ["The catalog is searchable by its own categories, attributes and options"] : [], missing: commerce === "missing" ? ["A connected catalog"] : [], how: "Need → clarify only if necessary → a small grounded set → compare → the exact variant → cart. No invented fit or material claims." });
  out.push({ id: "abandoned_checkout_recovery", title: "Recover abandoned checkouts", availability: avail([commerce, payments, channel], true, used.has("commerce") && used.has("payments")), groundedOn: [commerce !== "missing" ? "Carts and checkouts are recorded" : "", payments !== "missing" ? "Payments are provider-verified" : ""].filter(Boolean), missing: [commerce === "missing" ? "A connected catalog" : "", payments === "missing" ? "A payment provider" : "", channel === "missing" ? "A channel to follow up on" : ""].filter(Boolean), how: "A cart that reached checkout without a verified payment gets one bounded follow-up under your follow-up rules." });
  out.push({ id: "support_triage", title: "Support triage", availability: avail([channel], Boolean(handoff)), groundedOn: [handoff ? `Handoff: ${handoff}` : ""].filter(Boolean), missing: handoff ? [] : ["Who BARRY hands difficult cases to"], how: "BARRY answers what the verified facts cover and hands the rest to a person with a summary." });
  out.push({ id: "appointment_filling", title: "Fill appointments", availability: avail([scheduling, channel], Boolean(hours), used.has("scheduling")), groundedOn: [scheduling !== "missing" ? "Open times come from the calendar provider" : "", hours ? `Opening hours: ${hours}` : ""].filter(Boolean), missing: [scheduling === "missing" ? "A calendar provider" : "", hours ? "" : "Opening hours"].filter(Boolean), how: "Only real open slots are offered; the exact slot is confirmed before booking." });
  out.push({ id: "cross_sell", title: "One relevant suggestion", availability: graph.playbook.suggestions === "none" ? "not_supported" : avail([commerce], true, used.has("commerce")), groundedOn: graph.playbook.suggestions === "none" ? ["Your playbook says: no suggestions"] : commerce !== "missing" ? ["Suggestions come only from the live catalog"] : [], missing: graph.playbook.suggestions !== "none" && commerce === "missing" ? ["A connected catalog"] : [], how: "At most one genuinely relevant addition, from items really in stock." });
  out.push({ id: "payment_follow_up", title: "Follow up unpaid links", availability: avail([payments, channel], true, used.has("payments")), groundedOn: payments !== "missing" ? ["Unpaid links are watched until the provider reports payment"] : [], missing: [payments === "missing" ? "A payment provider" : "", channel === "missing" ? "A channel to follow up on" : ""].filter(Boolean), how: "A reminder after the configured delay, bounded attempts, never while a payment is pending verification." });
  out.push({ id: "owner_escalation", title: "Escalate to you", availability: avail([], Boolean(handoff)), groundedOn: handoff ? [`Escalation path: ${handoff}`] : [], missing: handoff ? [] : ["How BARRY reaches you"], how: "Approvals, held requests and handoffs reach you in Today; nothing consequential runs without your rules." });
  return out;
}
