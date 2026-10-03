import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";

/**
 * EXECUTION ATTEMPTS — the durable, idempotent history of what the proactive operator did for an
 * obligation: attempt number, when, outcome, evidence. One record per (obligation key, attempt n);
 * the executor never runs attempt n twice and never exceeds the policy's limit.
 */
/** attempted = recorded right before the send; it stays so only if the result was never recorded (unknown — never re-sent). */
export type AttemptStatus = "attempted" | "sent" | "dry_run" | "skipped" | "failed" | "cancelled";

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

export type AttemptCount = {
  /** Attempts that count against the policy's limit (sent / dry-run / failed) — the budget and idempotency. */
  count: number;
  lastAt?: string;
  /** Attempts that really reached the customer (status sent). Only these may be called "contacted" or "reached". */
  sent: number;
  /** Test-mode attempts: composed and recorded, nothing sent. */
  dryRun: number;
};

/** Attempts per obligation key — the policy budget, and separately what really reached the customer. */
export function attemptCounts(attempts: ExecutionAttempt[]): Record<string, AttemptCount> {
  const out: Record<string, AttemptCount> = {};
  for (const a of attempts) {
    if (a.status === "skipped" || a.status === "cancelled") continue;
    const cur = out[a.obligationKey] ?? { count: 0, sent: 0, dryRun: 0 };
    out[a.obligationKey] = { count: cur.count + 1, lastAt: cur.lastAt && cur.lastAt > a.at ? cur.lastAt : a.at, sent: cur.sent + (a.status === "sent" ? 1 : 0), dryRun: cur.dryRun + (a.status === "dry_run" ? 1 : 0) };
  }
  return out;
}

export async function recordAttempt(attempt: ExecutionAttempt): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: attempt.businessId, kind: "execution_attempt", key: attempt.id, data: attempt });
}
