"use client";

import type { ApprovalRecord } from "@/lib/store/types";

export function ApprovalsPanel({
  approvals,
  onDecide,
  busyId,
}: {
  approvals: ApprovalRecord[];
  onDecide: (approvalId: string, decision: "approved" | "declined") => void;
  busyId: string | null;
}) {
  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full">
      {pending.length === 0 && resolved.length === 0 && (
        <p className="text-sm text-neutral-500">No approvals yet for this business.</p>
      )}

      {pending.map((a) => (
        <div key={a.id} className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
          <p className="text-sm font-medium">{a.requestedAction}</p>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{a.reason}</p>
          <pre className="mt-2 text-xs bg-white/60 dark:bg-black/20 rounded-lg p-2 overflow-x-auto">
            {JSON.stringify(a.requestedInput, null, 2)}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              disabled={busyId === a.id}
              onClick={() => onDecide(a.id, "approved")}
              className="flex-1 rounded-lg bg-green-600 text-white text-xs font-medium py-2 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              disabled={busyId === a.id}
              onClick={() => onDecide(a.id, "declined")}
              className="flex-1 rounded-lg bg-red-600 text-white text-xs font-medium py-2 disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      ))}

      {resolved.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Resolved</h3>
          <div className="space-y-2">
            {resolved.map((a) => (
              <div key={a.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
                <p className="text-sm font-medium">{a.requestedAction}</p>
                <p className="text-xs text-neutral-500">{a.status}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
