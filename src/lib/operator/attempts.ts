import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";

/**
 * EXECUTION ATTEMPTS — the durable, idempotent history of what the proactive operator did for an
 * obligation: attempt number, when, outcome, evidence. One record per (obligation key, attempt n);
 * the executor never runs attempt n twice and never exceeds the policy's limit.
 */
export type AttemptStatus = "sent" | "dry_run" | "skipped" | "failed" | "cancelled";

export type ExecutionAttempt = {
  id: string;
  businessId: string;
  obligationKey: string;
  kind: string;
  n: number;
  at: string;
  status: AttemptStatus;
  /** What was done (or why not), in owner words. */
  what: string;
  evidence: string[];
  channel?: string;
  providerMessageId?: string;
  idempotencyKey: string;
};

export function attemptId(obligationKey: string, n: number): string {
  return `${obligationKey}#${n}`;
}

export async function listAttempts(businessId: string): Promise<ExecutionAttempt[]> {
  const records = await getBackend().listOperatorRecords(businessId, "execution_attempt");
  return records.map((r: OperatorRecord) => r.data as unknown as ExecutionAttempt).filter((a) => a && typeof a.obligationKey === "string").sort((a, b) => a.at.localeCompare(b.at));
}

/** Attempts that count against the policy (sent / dry-run / failed) per obligation key. */
export function attemptCounts(attempts: ExecutionAttempt[]): Record<string, { count: number; lastAt?: string }> {
  const out: Record<string, { count: number; lastAt?: string }> = {};
  for (const a of attempts) {
    if (a.status === "skipped" || a.status === "cancelled") continue;
    const cur = out[a.obligationKey] ?? { count: 0 };
    out[a.obligationKey] = { count: cur.count + 1, lastAt: cur.lastAt && cur.lastAt > a.at ? cur.lastAt : a.at };
  }
  return out;
}

export async function recordAttempt(attempt: ExecutionAttempt): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: attempt.businessId, kind: "execution_attempt", key: attempt.id, data: attempt });
}
