"use client";

import type { ConversationState, TurnLog } from "@/lib/state";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">{title}</h3>
      {children}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm py-0.5">
      <span className="text-neutral-500">{k}</span>
      <span className="text-right font-medium break-all">{v}</span>
    </div>
  );
}

function statusColor(status?: string) {
  switch (status) {
    case "allowed":
    case "allowed_within_limits":
      return "text-green-600 dark:text-green-400";
    case "requires_approval":
      return "text-amber-600 dark:text-amber-400";
    case "denied":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-neutral-500";
  }
}

export function InspectorPanel({ state }: { state: ConversationState | null }) {
  if (!state) {
    return <p className="text-sm text-neutral-500 p-3">Send a message to see BARRY&apos;s reasoning here.</p>;
  }

  const lastTurn: TurnLog | undefined = state.turns[state.turns.length - 1];

  return (
    <div className="space-y-3 p-3 overflow-y-auto h-full">
      <Section title="Conversation state">
        <Kv k="Stage" v={state.stage} />
        <Kv k="Intent" v={state.detectedIntent ?? "—"} />
        <Kv k="Selected offer" v={state.selectedOfferId ?? "—"} />
        <Kv k="Outcome" v={state.outcome ?? "pending"} />
        {state.missingFields.length > 0 && <Kv k="Missing info" v={state.missingFields.join(", ")} />}
      </Section>

      {lastTurn && (
        <>
          <Section title="Understood">
            <Kv k="Intent" v={lastTurn.understood.intent} />
            <pre className="mt-1 text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
              {JSON.stringify(lastTurn.understood.entities, null, 2)}
            </pre>
          </Section>

          <Section title="Retrieved from Business Graph">
            <Kv k="Offers" v={lastTurn.retrieved.offerIds.join(", ") || "—"} />
            <Kv k="Knowledge" v={lastTurn.retrieved.knowledgeIds.join(", ") || "—"} />
          </Section>

          {lastTurn.goal && (
            <Section title="Goal">
              <p className="text-sm">{lastTurn.goal}</p>
            </Section>
          )}

          {lastTurn.selectedAction && (
            <Section title="Planned action">
              <Kv k="Tool" v={lastTurn.selectedAction.name} />
              <pre className="mt-1 text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                {JSON.stringify(lastTurn.selectedAction.input, null, 2)}
              </pre>
            </Section>
          )}

          {lastTurn.policyDecision && (
            <Section title="Policy decision">
              <Kv
                k="Status"
                v={<span className={statusColor(lastTurn.policyDecision.status)}>{lastTurn.policyDecision.status}</span>}
              />
              <p className="text-sm mt-1 text-neutral-600 dark:text-neutral-400">{lastTurn.policyDecision.reason}</p>
            </Section>
          )}

          {lastTurn.toolResult && (
            <Section title="Tool result">
              <Kv k="Success" v={String(lastTurn.toolResult.ok)} />
              <pre className="mt-1 text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                {JSON.stringify(lastTurn.toolResult.output ?? lastTurn.toolResult.error, null, 2)}
              </pre>
            </Section>
          )}

          <Section title="Final response">
            <p className="text-sm">{lastTurn.response}</p>
          </Section>
        </>
      )}
    </div>
  );
}
