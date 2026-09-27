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
      {lastTurn && (
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-semibold px-2 py-1 rounded-full ${
              lastTurn.reasoner === "llm"
                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            Reasoner: {lastTurn.reasoner === "llm" ? "LLM" : "Mock"}
          </span>
        </div>
      )}

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
            {lastTurn.understood.schedulingWindow && (
              <>
                <p className="text-xs text-neutral-500 mt-2 mb-1">Semantic scheduling IR (as understood, before resolution)</p>
                <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                  {JSON.stringify(lastTurn.understood.schedulingWindow, null, 2)}
                </pre>
              </>
            )}
            {lastTurn.understood.customerInfo && Object.keys(lastTurn.understood.customerInfo).length > 0 && (
              <>
                <p className="text-xs text-neutral-500 mt-2 mb-1">BARRY verified IR customerInfo</p>
                <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                  {JSON.stringify(lastTurn.understood.customerInfo, null, 2)}
                </pre>
              </>
            )}
          </Section>

          {lastTurn.verification &&
            (lastTurn.verification.offerOverridden ||
              lastTurn.verification.schedulingOverridden ||
              lastTurn.verification.customerInfoOverridden) && (
              <Section title="⚠ Verification overrode the Reasoner">
                {lastTurn.verification.offerOverridden && (
                  <>
                    <Kv
                      k="LLM proposed offer"
                      v={
                        lastTurn.verification.llmSelectedOfferId ??
                        (lastTurn.verification.llmOfferCandidateIds?.join(", ") || "—")
                      }
                    />
                    <Kv k="BARRY trusted instead" v={state.selectedOfferId ?? "—"} />
                  </>
                )}
                {lastTurn.verification.schedulingOverridden && (
                  <>
                    <p className="text-xs text-neutral-500 mt-2 mb-1">LLM-proposed scheduling IR</p>
                    <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                      {JSON.stringify(lastTurn.verification.llmSchedulingWindow ?? null, null, 2)}
                    </pre>
                    <p className="text-xs text-neutral-500 mt-2 mb-1">BARRY-verified scheduling IR (trusted)</p>
                    <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                      {JSON.stringify(lastTurn.understood.schedulingWindow ?? null, null, 2)}
                    </pre>
                  </>
                )}
                {lastTurn.verification.customerInfoOverridden && (
                  <>
                    <p className="text-xs text-neutral-500 mt-2 mb-1">Reasoner proposal customerInfo (raw, pre-verification)</p>
                    <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                      {JSON.stringify(lastTurn.verification.llmCustomerInfo ?? {}, null, 2)}
                    </pre>
                    <p className="text-xs text-neutral-500 mt-2 mb-1">BARRY verified IR customerInfo (post-verification)</p>
                    <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                      {JSON.stringify(lastTurn.understood.customerInfo ?? {}, null, 2)}
                    </pre>
                  </>
                )}
              </Section>
            )}

          {lastTurn.compiled && (
            <Section title="Compiler">
              {lastTurn.compiled.resolvedSchedulingWindow && (
                <>
                  <p className="text-xs text-neutral-500 mb-1">Resolved scheduling window (absolute UTC)</p>
                  <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                    {JSON.stringify(lastTurn.compiled.resolvedSchedulingWindow, null, 2)}
                  </pre>
                </>
              )}
              <p className="text-xs text-neutral-500 mt-2 mb-1">CustomerInfo actually applied to persistent state</p>
              <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">
                {JSON.stringify(lastTurn.compiled.appliedCustomerInfo, null, 2)}
              </pre>
              <p className="text-xs text-neutral-500 mt-2 mb-1">Missing fields (computed AFTER applying customerInfo above)</p>
              <p className="text-sm">{state.missingFields.length > 0 ? state.missingFields.join(", ") : "none"}</p>
            </Section>
          )}

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

          {lastTurn.responseFacts && (
            <Section title="Response facts (ground truth for the reply's phrasing)">
              <Kv k="Display timezone" v={lastTurn.responseFacts.timezone} />
              {lastTurn.responseFacts.offeredSlot && (
                <Kv
                  k="Offered slot (local)"
                  v={`${lastTurn.responseFacts.offeredSlot.localDate} ${lastTurn.responseFacts.offeredSlot.localTime}`}
                />
              )}
              {lastTurn.responseFacts.availableSlots && lastTurn.responseFacts.availableSlots.length > 0 && (
                <Kv
                  k="Available slots (local)"
                  v={lastTurn.responseFacts.availableSlots.map((s) => `${s.localDate} ${s.localTime}`).join("; ")}
                />
              )}
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
