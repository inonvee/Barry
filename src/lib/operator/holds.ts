import { getBackend } from "@/lib/store";

/**
 * OWNER HOLDS — customers the owner told BARRY to stop contacting. A stopped owner operation holds its
 * cohort: the proactive executor skips those obligations until a LATER owner command includes them
 * again. Already-sent messages are untouched (nothing is "unsent"); only new outreach stops.
 */
type HoldSource = { id: string; state: string; createdAt: string; stoppedAt?: string; targets: { key: string; eligibility: string }[] };

export async function ownerHeldKeys(businessId: string): Promise<Map<string, string>> {
  const ops = (await getBackend().listOperatorRecords(businessId, "owner_operation")).map((r) => r.data as unknown as HoldSource).filter((o) => o && Array.isArray(o.targets));
  const held = new Map<string, string>();
  const byTime = [...ops].sort((a, b) => (a.stoppedAt ?? a.createdAt).localeCompare(b.stoppedAt ?? b.createdAt));
  for (const op of byTime) {
    for (const t of op.targets) {
      if (op.state === "stopped") held.set(t.key, op.id);
      else if (t.eligibility === "eligible" && op.state !== "proposed" && op.state !== "blocked") held.delete(t.key);
    }
  }
  return held;
}
