import type { LedgerEntry, RecoveredIntent } from "@/lib/runtime/ledger";

/**
 * The recovery story of each customer turn BARRY could not understand, read from the ledger alone:
 * FAILED CUSTOMER TURN → HELD REQUEST(S) → RE-CHECK → RECOVERED INTENT → OLD REQUEST SUPERSEDED/WITHDRAWN
 * → NEW REQUEST (awaiting the owner). Client-safe: type-only imports, no runtime dependencies.
 */
export type RecoveryChain = {
  failedSeq: number;
  turnId?: string;
  message?: string;
  reason?: string;
  heldRequestIds: string[];
  recheck?: { at: string; recovered?: RecoveredIntent };
  superseded: string[];
  withdrawn: string[];
};

export function recoveryChains(ledger: LedgerEntry[]): RecoveryChain[] {
  return ledger
    .filter((e) => e.effect === "understanding.failed")
    .map((f) => {
      const recheck = ledger.find((e) => e.effect === "understanding.revalidated" && e.revalidation?.of === f.seq);
      const held = f.failedTurn?.pendingRequestIds ?? [];
      const between = recheck ? ledger.filter((e) => e.seq > f.seq && e.seq < recheck.seq && e.requestId && held.includes(e.requestId)) : [];
      return {
        failedSeq: f.seq,
        ...(f.failedTurn ? { turnId: f.failedTurn.turnId, message: f.failedTurn.message, reason: f.failedTurn.reason } : {}),
        heldRequestIds: held,
        ...(recheck ? { recheck: { at: recheck.at, ...(recheck.revalidation?.recovered ? { recovered: recheck.revalidation.recovered } : {}) } } : {}),
        superseded: between.filter((e) => e.status === "superseded").map((e) => e.requestId!),
        withdrawn: between.filter((e) => e.status === "withdrawn").map((e) => e.requestId!),
      };
    });
}

export function readLedgerField(knownFields: Record<string, string>): LedgerEntry[] {
  try {
    const parsed = JSON.parse(knownFields.__effectLedger ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
