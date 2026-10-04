import { getBackend } from "@/lib/store";
import { applyControlChange, loadControls } from "@/lib/hq/controls";
import { listOwnerIdentities, revokeOwnerIdentity } from "@/lib/owner-channel/identity";
import { listBusinessSummaries } from "@/lib/fixtures";
import { listFounderIdentities, revokeFounderIdentity } from "@/lib/founder-channel/identity";
import type { BusinessMode } from "@/lib/hq/controls";

/**
 * A DURABLE RESTORE POINT FOR THE PREVIEW QA RUNNERS (temporary QA surface).
 *
 * A QA run changes the test business's controls (SUPERVISED, owner / founder pauses) and links a synthetic owner
 * number. Restoring only in a `finally` is not enough: Vercel can kill the function at its time limit, and the
 * browser can go away. So BEFORE the first change a run records the business's original controls here (once —
 * a later stage or a re-run never overwrites the true original), and:
 *
 *   - every stage restores from it when it finishes (normally or not);
 *   - every new run first recovers from a restore point left by a run that died;
 *   - POST { "restore": true } restores it on demand (the QA page calls it after any failure or timeout);
 *
 * Restoring = original mode + pause state, every synthetic (999…) owner link revoked, then the point is cleared.
 */

const KIND = "founder_state" as const;
const KEY = "qa_restore_point";
export const SYNTHETIC_PREFIX = "999";

export type RestorePoint = {
  businessId: string;
  mode: BusinessMode;
  pausedBusiness: boolean;
  /** Every other founder lever a QA run may move (absent on points recorded before they were captured). */
  levers?: { approvalRequiredForAll: boolean; pauseConsequentialWrites: boolean; pausedCapabilities: string[]; disabledChannels: string[]; safeMode: boolean };
  createdAt: string;
  by: string;
};
export type RestoreResult = { restored: boolean; hadRestorePoint: boolean; mode: BusinessMode; pausedBusiness: boolean; /** Synthetic (999…) owner AND founder links revoked. */ revokedSyntheticOwners: number };

export async function readRestorePoint(businessId: string): Promise<RestorePoint | undefined> {
  const r = (await getBackend().listOperatorRecords(businessId, KIND)).find((x) => x.key === KEY);
  const p = r?.data as unknown as RestorePoint | undefined;
  return p && p.mode ? p : undefined;
}

/** Record the business's current controls as the original — unless a restore point already exists (keep the true original). */
export async function ensureRestorePoint(businessId: string, by: string, now = new Date()): Promise<RestorePoint> {
  const existing = await readRestorePoint(businessId);
  if (existing) return existing;
  const c = await loadControls(businessId);
  const point: RestorePoint = { businessId, mode: c.mode, pausedBusiness: c.pausedBusiness, levers: { approvalRequiredForAll: c.approvalRequiredForAll, pauseConsequentialWrites: c.pauseConsequentialWrites, pausedCapabilities: [...c.pausedCapabilities], disabledChannels: [...c.disabledChannels], safeMode: c.safeMode }, createdAt: now.toISOString(), by };
  await getBackend().upsertOperatorRecord({ businessId, kind: KIND, key: KEY, data: point as unknown as Record<string, unknown> });
  return point;
}

export type SyntheticIdentityCount = { syntheticOwnersActive: number; syntheticFoundersActive: number };

/** Active synthetic (999…) owner links across the fleet, and synthetic founder links. A real number never starts with 999. */
export async function countSyntheticIdentities(): Promise<SyntheticIdentityCount> {
  let owners = 0;
  for (const b of listBusinessSummaries()) owners += (await listOwnerIdentities(b.id).catch(() => [])).filter((l) => l.status === "active" && l.channelUserId.startsWith(SYNTHETIC_PREFIX)).length;
  const founders = (await listFounderIdentities()).filter((l) => l.status === "active" && l.channelUserId.startsWith(SYNTHETIC_PREFIX)).length;
  return { syntheticOwnersActive: owners, syntheticFoundersActive: founders };
}

/**
 * Revoke EVERY active synthetic (999…) owner link (every fleet business) and founder link — including stale ones left
 * by an interrupted earlier run. Real owners and the real founder are never touched (their numbers never start 999).
 */
export async function revokeSyntheticIdentities(by: string, reason: string): Promise<{ owners: number; founders: number }> {
  let owners = 0;
  let founders = 0;
  for (const b of listBusinessSummaries()) {
    for (const l of await listOwnerIdentities(b.id).catch(() => [])) {
      if (l.status === "active" && l.channelUserId.startsWith(SYNTHETIC_PREFIX) && (await revokeOwnerIdentity(b.id, l.id, `${by}: ${reason}`))) owners++;
    }
  }
  for (const l of await listFounderIdentities()) {
    if (l.status === "active" && l.channelUserId.startsWith(SYNTHETIC_PREFIX) && (await revokeFounderIdentity(l.id, `${by}: ${reason}`))) founders++;
  }
  return { owners, founders };
}

/** Put the business back exactly as the restore point says, revoke synthetic owner links, clear the point. Idempotent. */
export async function restoreFromPoint(businessId: string, by: string, reason: string): Promise<RestoreResult> {
  const point = await readRestorePoint(businessId);
  // Synthetic owner links (every fleet business) and synthetic founder links — a real link is never touched.
  const swept = await revokeSyntheticIdentities(by, reason);
  const revoked = swept.owners + swept.founders;
  if (point) await applyControlChange(businessId, { mode: point.mode, pausedBusiness: point.pausedBusiness, ...(point.levers ?? {}) }, { by, reason });
  const after = await loadControls(businessId);
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  const restored = !point || (after.mode === point.mode && after.pausedBusiness === point.pausedBusiness && (!point.levers || (after.approvalRequiredForAll === point.levers.approvalRequiredForAll && after.pauseConsequentialWrites === point.levers.pauseConsequentialWrites && after.safeMode === point.levers.safeMode && same(after.pausedCapabilities, point.levers.pausedCapabilities) && same(after.disabledChannels, point.levers.disabledChannels))));
  if (point && restored) await getBackend().deleteOperatorRecords(businessId, KIND, [KEY]);
  return { restored, hadRestorePoint: Boolean(point), mode: after.mode, pausedBusiness: after.pausedBusiness, revokedSyntheticOwners: revoked };
}
