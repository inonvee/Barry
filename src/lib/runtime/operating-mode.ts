import type { BusinessControls } from "@/lib/hq/controls";

/**
 * THE OPERATING MODE — one place that says what BARRY may do on its own for a business right now. Every
 * runtime path asks here (scheduled work, the customer channel runtime, owner commands); nothing re-derives
 * it from the raw controls.
 *
 *   PAUSED      no autonomous outbound action of any kind (no replies, nothing proactive, no writes).
 *   SIMULATOR   test / practice: BARRY answers, but anything proactive is a dry run — never a real send.
 *   SUPERVISED  BARRY answers, analyzes, drafts, prepares and recommends; proactive outreach and every
 *               consequential action wait for the owner's approval.
 *   LIVE        only what the business's authority rules permit (founder controls still only tighten).
 *
 * Unknown or unreadable controls read as the safest mode the stored record allows (see loadControls); a
 * transition never loosens anything until the new controls are durably saved.
 */

export type OperatingMode = "paused" | "simulator" | "supervised" | "live";

export function operatingMode(c: Pick<BusinessControls, "mode" | "pausedBusiness">): OperatingMode {
  if (c.pausedBusiness) return "paused";
  return c.mode === "live" || c.mode === "supervised" ? c.mode : "simulator";
}

export type ProactiveGate =
  /** live=false: compose and record only (dry run) — nothing reaches a customer. */
  | { allowed: true; live: boolean; mode: OperatingMode }
  | { allowed: false; mode: OperatingMode; reason: string; /** the owner can approve it (run it themselves) */ needsApproval: boolean };

/**
 * Proactive outbound (follow-ups, abandoned-checkout recovery, reminders). `ownerInitiated`: the owner
 * asked for exactly this (an owner operation) — that IS the approval SUPERVISED requires.
 */
export function proactiveGate(c: BusinessControls, opts: { ownerInitiated?: boolean } = {}): ProactiveGate {
  const mode = operatingMode(c);
  if (mode === "paused") return { allowed: false, mode, reason: "the business is paused — nothing proactive runs", needsApproval: false };
  if (c.pauseConsequentialWrites) return { allowed: false, mode, reason: "consequential actions are paused by the founder", needsApproval: false };
  if (c.safeMode) return { allowed: false, mode, reason: "safe mode: proactive messages are off", needsApproval: false };
  if (mode === "simulator") return { allowed: true, live: false, mode };
  if (mode === "supervised" && !opts.ownerInitiated) return { allowed: false, mode, reason: "supervised: BARRY prepares this and waits for your go-ahead — nothing is sent on its own", needsApproval: true };
  return { allowed: true, live: true, mode };
}

/** May BARRY answer a customer on this channel at all right now? (Authority still decides every action.) */
export function replyGate(c: BusinessControls, channel: string): { allowed: true } | { allowed: false; reason: string } {
  if (operatingMode(c) === "paused") return { allowed: false, reason: "the business is paused" };
  if (c.disabledChannels.includes(channel.toLowerCase())) return { allowed: false, reason: `channel ${channel} is disabled` };
  return { allowed: true };
}
