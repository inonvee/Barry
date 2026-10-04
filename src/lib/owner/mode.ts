import type { BusinessGraph } from "@/lib/business-graph";
import { applyControlChange, loadControls, type BusinessControls } from "@/lib/hq/controls";
import { operatingMode, type OperatingMode } from "@/lib/runtime/operating-mode";

/**
 * THE OWNER'S PAUSE — one channel-independent service (web, owner WhatsApp): the owner can pause BARRY for
 * their own business (nothing outbound, no writes; other businesses untouched) and lift their own pause.
 * A pause the founder set is lifted only by the founder. Every change goes through the same durable,
 * audited, serialized control change as the founder's (who, when, why, before → after).
 */

export class OwnerModeError extends Error {
  constructor(readonly code: "founder_paused", message: string) {
    super(message);
    this.name = "OwnerModeError";
  }
}

export type OwnerModeView = { mode: OperatingMode; pausedBy: "owner" | "founder" | null; since: string | null; reason: string };

const isOwner = (by: string | null) => Boolean(by && /^(?:the )?owner\b/i.test(by));

export function modeView(c: BusinessControls): OwnerModeView {
  return { mode: operatingMode(c), pausedBy: c.pausedBusiness ? (isOwner(c.pausedBy) ? "owner" : "founder") : null, since: c.updatedAt, reason: c.reason };
}

export async function ownerMode(graph: BusinessGraph): Promise<OwnerModeView> {
  return modeView(await loadControls(graph.business.id));
}

/** Pause BARRY for this business. Idempotent (already paused → unchanged, by whoever paused it). */
export async function ownerPause(graph: BusinessGraph, by: string, reason = "paused by the owner"): Promise<OwnerModeView> {
  const { controls } = await applyControlChange(graph.business.id, { pausedBusiness: true }, { by, reason });
  return modeView(controls);
}

/** Lift the owner's own pause. A founder's pause stays (refused, nothing changes). */
export async function ownerResume(graph: BusinessGraph, by: string, reason = "resumed by the owner"): Promise<OwnerModeView> {
  const before = await loadControls(graph.business.id);
  if (!before.pausedBusiness) return modeView(before);
  if (!isOwner(before.pausedBy)) throw new OwnerModeError("founder_paused", "The BARRY team paused this business — they resume it with you. Nothing was changed.");
  const { controls } = await applyControlChange(graph.business.id, { pausedBusiness: false }, { by, reason });
  return modeView(controls);
}
