import { getBackend } from "@/lib/store";
import { applyControlChange, loadControls } from "@/lib/hq/controls";
import { listOwnerIdentities, revokeOwnerIdentity } from "@/lib/owner-channel/identity";
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

export type RestorePoint = { businessId: string; mode: BusinessMode; pausedBusiness: boolean; createdAt: string; by: string };
export type RestoreResult = { restored: boolean; hadRestorePoint: boolean; mode: BusinessMode; pausedBusiness: boolean; revokedSyntheticOwners: number };

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
  const point: RestorePoint = { businessId, mode: c.mode, pausedBusiness: c.pausedBusiness, createdAt: now.toISOString(), by };
  await getBackend().upsertOperatorRecord({ businessId, kind: KIND, key: KEY, data: point as unknown as Record<string, unknown> });
  return point;
}

/** Put the business back exactly as the restore point says, revoke synthetic owner links, clear the point. Idempotent. */
export async function restoreFromPoint(businessId: string, by: string, reason: string): Promise<RestoreResult> {
  const point = await readRestorePoint(businessId);
  let revoked = 0;
  for (const l of await listOwnerIdentities(businessId)) {
    if (l.status === "active" && l.channelUserId.startsWith(SYNTHETIC_PREFIX)) {
      if (await revokeOwnerIdentity(businessId, l.id, `${by}: ${reason}`)) revoked++;
    }
  }
  if (point) await applyControlChange(businessId, { mode: point.mode, pausedBusiness: point.pausedBusiness }, { by, reason });
  const after = await loadControls(businessId);
  const restored = !point || (after.mode === point.mode && after.pausedBusiness === point.pausedBusiness);
  if (point && restored) await getBackend().deleteOperatorRecords(businessId, KIND, [KEY]);
  return { restored, hadRestorePoint: Boolean(point), mode: after.mode, pausedBusiness: after.pausedBusiness, revokedSyntheticOwners: revoked };
}
