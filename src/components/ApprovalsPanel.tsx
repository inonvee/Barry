"use client";

import type { ApprovalRecord } from "@/lib/store/types";

/** An approval as the API returns it: the stored record plus its authoritative lifecycle. */
export type ApprovalView = ApprovalRecord & {
  lifecycle?: "active" | "held" | "superseded" | "withdrawn" | "declined" | "executed" | "executed_unconfirmed" | "failed" | "approved";
  revision?: number;
  summary?: string;
  result?: { result: string; reference?: string };
  /** Pending, but held: the customer's intent after the request is unverified (a later message wasn't understood, or conflicts). */
  hold?: { reason: string; detail?: string };
};

function holdText(h: NonNullable<ApprovalView["hold"]>): string {
  return h.reason === "conflicting_reference"
    ? `Held: the customer later wrote ${h.detail ?? "a different reference"}, which conflicts with this request. The customer must reconfirm before it can run.`
    : "Held: a later customer message could not be understood, so the customer's current intent is unverified. The customer must reconfirm before it can run.";
}

/** A generic capability call is titled by its capability, not by the generic action's name. */
function actionTitle(a: { requestedAction: string; requestedInput: unknown }): string {
  const capability = (a.requestedInput as { capability?: unknown } | null)?.capability;
  return a.requestedAction === "invokeCapability" && typeof capability === "string" ? `${capability} (capability call)` : a.requestedAction;
}

const LIFECYCLE_STYLE: Record<string, string> = {
  active: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  held: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  executed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  executed_unconfirmed: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  declined: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  withdrawn: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  superseded: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  approved: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
};

function lifecycleOf(a: ApprovalView): string {
  return a.lifecycle ?? (a.status === "pending" ? "active" : a.status);
}

function Meta({ a, currentConversationId }: { a: ApprovalView; currentConversationId?: string | null }) {
  const lifecycle = lifecycleOf(a);
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1">
      <span className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 ${LIFECYCLE_STYLE[lifecycle] ?? LIFECYCLE_STYLE.declined}`}>{lifecycle.replace(/_/g, " ")}</span>
      {a.revision !== undefined && <span className="text-[10px] text-neutral-500">revision {a.revision}</span>}
      {a.result?.reference && <span className="text-[10px] text-neutral-500">ref {a.result.reference}</span>}
      <span className="text-[10px] text-neutral-500">{a.conversationId === currentConversationId ? "this conversation" : "another conversation"}</span>
    </div>
  );
}

export function ApprovalsPanel({
  approvals,
  onDecide,
  busyId,
  currentConversationId,
}: {
  approvals: ApprovalView[];
  onDecide: (approvalId: string, decision: "approved" | "declined") => void;
  busyId: string | null;
  currentConversationId?: string | null;
}) {
  // Only a PENDING request can be decided. Superseded / withdrawn / resolved ones are history — no stale buttons.
  // A held one can be declined, not approved: the server would hold it again until the customer reconfirms.
  const isPending = (a: ApprovalView) => lifecycleOf(a) === "active" || lifecycleOf(a) === "held";
  const active = approvals.filter(isPending);
  const history = approvals.filter((a) => !isPending(a));

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full">
      {active.length === 0 && history.length === 0 && <p className="text-sm text-neutral-500">No approvals yet for this business.</p>}
      {active.length === 0 && history.length > 0 && <p className="text-sm text-neutral-500">Nothing is waiting for approval.</p>}

      {active.map((a) => (
        <div key={a.id} className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
          <p className="text-sm font-medium">{actionTitle(a)}</p>
          <Meta a={a} currentConversationId={currentConversationId} />
          {a.summary && <p className="text-sm mt-1">{a.summary}</p>}
          <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{a.reason}</p>
          {a.hold && <p className="text-xs text-orange-700 dark:text-orange-400 mt-1">{holdText(a.hold)}</p>}
          <pre className="mt-2 text-xs bg-white/60 dark:bg-black/20 rounded-lg p-2 overflow-x-auto">{JSON.stringify(a.requestedInput, null, 2)}</pre>
          <div className="mt-3 flex gap-2">
            <button
              disabled={busyId === a.id || Boolean(a.hold)}
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

      {history.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">History</h3>
          <div className="space-y-2">
            {history.map((a) => (
              <div key={a.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
                <p className="text-sm font-medium">{actionTitle(a)}</p>
                <Meta a={a} currentConversationId={currentConversationId} />
                {a.summary && <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{a.summary}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
