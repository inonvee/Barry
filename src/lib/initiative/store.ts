import { getBackend } from "@/lib/store";
import { toView, type Initiative, type InitiativeView } from "./model";

/** Initiative persistence (tenant-scoped operator records). Read-only helpers never run a scan. */

export type ScanRecord = { id: string; businessId: string; at: string; localDate: string; trigger: "scheduled" | "manual" | "test"; candidates: number; verified: number; rejected: { detector: string; reason: string }[]; created: number; updated: number; surfaced: number; suppressed: number; resolved: number; skipped?: string };

export async function listInitiatives(businessId: string): Promise<Initiative[]> {
  return (await getBackend().listOperatorRecords(businessId, "initiative")).map((r) => r.data as unknown as Initiative).filter((i) => i && i.fingerprint && i.businessId === businessId).sort((a, b) => b.rank - a.rank);
}
export async function saveInitiative(i: Initiative): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: i.businessId, kind: "initiative", key: i.id, data: i as unknown as Record<string, unknown> });
}
export async function listScans(businessId: string): Promise<ScanRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "initiative_scan")).map((r) => r.data as unknown as ScanRecord).sort((a, b) => b.at.localeCompare(a.at));
}
export async function saveScan(scan: ScanRecord): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: scan.businessId, kind: "initiative_scan", key: scan.id, data: scan as unknown as Record<string, unknown> });
}

/** What the owner sees now: surfaced / reviewed / accepted / acting, best first. Never computed on read. */
export async function visibleInitiatives(businessId: string): Promise<InitiativeView[]> {
  return (await listInitiatives(businessId)).filter((i) => ["surfaced", "reviewed", "accepted", "acting"].includes(i.state)).map(toView);
}
