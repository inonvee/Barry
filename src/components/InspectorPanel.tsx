"use client";

import { useState } from "react";
import type { ConversationState, TurnLog } from "@/lib/state";
import { readLedgerField, recoveryChains, type RecoveryChain } from "@/lib/inspector/recovery-chain";

/**
 * The QA view of one BARRY turn: which models ran, what the model
 * understood, what grounding accepted or rejected, what BARRY saw, what it
 * did (step by step, with provider and policy), why it stopped, and where
 * the transaction stands. Structured, not raw JSON — the few JSON blocks
 * that remain are collapsed.
 */

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
      <span className="text-neutral-500 shrink-0">{k}</span>
      <span className="text-right font-medium break-all">{v}</span>
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="mt-1">
      <summary className="text-xs text-neutral-500 cursor-pointer">{label}</summary>
      <pre className="mt-1 text-xs bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2 overflow-x-auto">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "accent" }) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    good: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    accent: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200",
  };
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${tones[tone]}`}>{children}</span>;
}

function policyTone(status?: string) {
  return status === "allowed" ? "good" : status === "requires_approval" ? "warn" : status === "denied" ? "bad" : "neutral";
}

const dash = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : String(v));

type Commerce = {
  intent?: string;
  reference?: { type?: string; index?: number };
  referenceInvalid?: boolean;
  variant?: Record<string, string>;
  query?: { text?: string; category?: string; budget?: { amount?: number; currency?: string } };
};

function CommerceSummary({ commerce }: { commerce: unknown }) {
  if (!commerce || typeof commerce !== "object") return <Kv k="Commerce" v="—" />;
  const c = commerce as Commerce;
  const ref = c.reference ? `${c.reference.type ?? "?"}${c.reference.index !== undefined ? ` #${c.reference.index + 1}` : ""}` : c.referenceInvalid ? "invalid (asks)" : "—";
  const variant = c.variant && Object.keys(c.variant).length ? Object.entries(c.variant).map(([k, v]) => `${k}=${v}`).join(", ") : "—";
  return (
    <>
      <Kv k="Commerce intent" v={dash(c.intent)} />
      <Kv k="Reference" v={ref} />
      <Kv k="Variant" v={variant} />
      {c.query && <Kv k="Query" v={[c.query.text, c.query.category, c.query.budget?.amount !== undefined ? `≤ ${c.query.budget.amount} ${c.query.budget.currency ?? ""}` : undefined].filter(Boolean).join(" · ")} />}
    </>
  );
}

type UnderstandingTrace = NonNullable<NonNullable<TurnLog["trace"]>["understanding"]>;

function failureLabel(f: NonNullable<UnderstandingTrace["failure"]>): string {
  return [f.kind.replace(/_/g, " "), f.status !== undefined ? `HTTP ${f.status}` : "", f.code ?? "", f.message ?? ""].filter(Boolean).join(" · ");
}

/** Whether the model's understanding was usable — and exactly why not, when it wasn't. */
function UnderstandingStatus({ u }: { u: UnderstandingTrace }) {
  return (
    <div className="mb-2">
      <div className="flex flex-wrap gap-1.5 mb-1">
        <Chip tone={!u.valid ? "bad" : u.salvagedFields?.length ? "warn" : "good"}>{!u.valid ? "understanding failed" : u.salvagedFields?.length ? "understood (salvaged)" : "understood"}</Chip>
        {u.failClosed && <Chip tone="warn">fail-closed: no write this turn</Chip>}
        <Chip tone="neutral">{`${u.attempts} attempt${u.attempts === 1 ? "" : "s"} · ${u.latencyMs} ms`}</Chip>
      </div>
      {u.failure && <p className={`text-xs ${u.valid ? "text-amber-700 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}>{u.valid ? "Recovered from: " : "Reason: "}{failureLabel(u.failure)}</p>}
      {u.salvagedFields?.length ? <Kv k="Dropped malformed fields" v={u.salvagedFields.join(", ")} /> : null}
    </div>
  );
}

const STEP_WORDS: Record<string, string> = { allowed: "allowed", requires_approval: "needs owner approval", denied: "not allowed" };

/**
 * The first screen of a turn: what BARRY thought the customer wanted, what actually happened (from the
 * ledger, never from the reply), and why the reply says what it says.
 */
function TurnSummary({ turn }: { turn: TurnLog }) {
  const t = turn.trace;
  const u = t?.understanding;
  const asks = turn.understood.asks ?? [];
  const notDone = new Set(t?.notDone ?? []);
  // ASK COMPLETENESS: what the runtime says became of each ask (the reply had to address all of them).
  const statusOf = asks.map((a, i) => (t?.asks?.[i]?.ask === a.ask ? t.asks[i].status : undefined));
  return (
    <section className="m-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">What BARRY thought the customer wanted</p>
      {u && !u.valid ? (
        <p className="mt-1 font-medium text-red-700 dark:text-red-400">Nothing — understanding failed ({u.failure?.kind.replace(/_/g, " ") ?? "unknown"}). No action was taken.</p>
      ) : asks.length ? (
        <ul className="mt-1 space-y-0.5">
          {asks.map((a, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5">
              <Chip tone={a.kind === "change" ? (notDone.has(a.ask) ? "bad" : "good") : "neutral"}>{a.kind === "change" ? (notDone.has(a.ask) ? "not done" : a.coveredByThisIR ? "acted on" : "continued") : a.kind}</Chip>
              {statusOf[i] && <Chip tone={["blocked", "not_done"].includes(statusOf[i]!) ? "bad" : statusOf[i] === "answered" || statusOf[i] === "completed" ? "good" : "neutral"}>{statusOf[i]!.replace(/_/g, " ").toUpperCase()}</Chip>}
              <span>{a.ask}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1">{turn.understood.intent}</p>
      )}
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">What actually happened</p>
      {t?.steps.length ? (
        <ul className="mt-1 space-y-0.5">
          {t.steps.map((st, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs">{st.generic?.capability ?? st.action}</span>
              <Chip tone={policyTone(st.policy.status)}>{STEP_WORDS[st.policy.status] ?? st.policy.status}</Chip>
              {st.ownerRequest && <Chip tone="warn">{st.ownerRequest === "requested" ? "sent to owner" : st.ownerRequest.replace(/_/g, " ")}</Chip>}
              {st.result && <Chip tone={st.result.ok ? "good" : "bad"}>{st.result.ok ? "executed" : "failed"}</Chip>}
              {st.generic?.executed && <Chip tone={st.generic.verified ? "good" : "neutral"}>{st.generic.verified ? "provider-verified" : "not verified"}</Chip>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">No action this turn{t ? ` (${t.stop.reason.replace(/_/g, " ")})` : ""}.</p>
      )}
      {t?.effects?.length ? (
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          Effects: {t.effects.map((e) => `${e.effect} · ${e.status}${e.reference ? ` (${e.reference})` : ""}`).join(" · ")}
        </p>
      ) : null}
      {t?.hold && <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">Approval held, not executed — {t.hold.reason}</p>}
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Why BARRY said that</p>
      <p className="mt-1 text-xs">
        {t?.reply?.fallback
          ? `The reply was replaced for safety: ${t.reply.fallback}`
          : t
            ? "The model's reply passed every check (effects, owner state, amounts, policy, language, internal terms)."
            : "Not traced."}
      </p>
    </section>
  );
}

export function TurnView({ state, turn, isLatest }: { state: ConversationState; turn: TurnLog; isLatest: boolean }) {
  const trace = turn.trace;
  const rt = trace?.runtime;
  const facts = turn.verification?.customerFacts ?? [];
  const applied = turn.compiled?.appliedCustomerInfo ?? {};
  const known = state.knownFields;
  // Customer-fact verdicts are listed above; this is everything else grounding refused.
  const rejected = (turn.verification?.rejected ?? trace?.rejectedClaims ?? []).filter((r) => !(facts.length && r.claim.startsWith("customerInfo")));
  const missing = trace?.missingFields ?? (isLatest ? state.missingFields : undefined);

  return (
    <>
      <TurnSummary turn={turn} />


      <Section title="1 · Understanding">
        {trace?.understanding && <UnderstandingStatus u={trace.understanding} />}
        <Kv k="Raw intent" v={turn.understood.intent} />
        <Kv k="Purchase decision" v={turn.understood.purchaseDecision === undefined ? "—" : String(turn.understood.purchaseDecision)} />
        {turn.understood.signals && (
          <Kv
            k="Turn signals (model, literal)"
            v={Object.entries(turn.understood.signals)
              .map(([name, value]) => `${name}=${value === null ? "null" : String(value)}`)
              .join(" · ")}
          />
        )}
        <CommerceSummary commerce={turn.understood.commerce} />
        {turn.understood.knowledgeTopic && <Kv k="Knowledge topic" v={turn.understood.knowledgeTopic} />}
        {turn.understood.customerClaims !== undefined && <Kv k="Customer claims" v={JSON.stringify(turn.understood.customerClaims)} />}
        {Object.keys(turn.understood.entities).length > 0 && <Json label="Entities" value={turn.understood.entities} />}
        {turn.understood.schedulingWindow && <Json label="Scheduling (as understood)" value={turn.understood.schedulingWindow} />}
        {turn.verification?.capabilityRequest && (
          <div className="mt-2 border-t border-neutral-100 dark:border-neutral-800 pt-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-neutral-500">Capability request</span>
              <span className="font-mono text-xs">{turn.verification.capabilityRequest.proposed.capability}</span>
              <Chip tone={turn.verification.capabilityRequest.status === "accepted" ? "good" : "bad"}>{turn.verification.capabilityRequest.status === "accepted" ? "grounded" : "rejected"}</Chip>
            </div>
            <Kv k="Input" v={Object.entries(turn.verification.capabilityRequest.proposed.input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") || "—"} />
            <Kv k="Purpose" v={turn.verification.capabilityRequest.proposed.purpose || "—"} />
            {turn.verification.capabilityRequest.reason && <p className="text-xs text-red-600 dark:text-red-400">{turn.verification.capabilityRequest.reason}</p>}
          </div>
        )}
      </Section>

      <Section title="1 · Understanding · Customer facts">
        {facts.length === 0 && <p className="text-xs text-neutral-500">None proposed this turn.</p>}
        <div className="space-y-2">
          {facts.map((f, i) => (
            <div key={i} className="text-sm border-t first:border-t-0 border-neutral-100 dark:border-neutral-800 pt-1.5 first:pt-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium break-all">{f.field}</span>
                <Chip tone={f.status === "accepted" ? (f.field in applied ? "good" : "warn") : "bad"}>
                  {f.status === "accepted" ? (f.field in applied ? "applied" : "accepted, not applied") : "rejected"}
                </Chip>
              </div>
              <Kv k="Proposed" v={f.value} />
              <Kv k="Evidence" v={f.evidence === null ? "—" : `“${f.evidence}”`} />
              {f.reason && <p className="text-xs text-red-600 dark:text-red-400">{f.reason}</p>}
            </div>
          ))}
        </div>
      </Section>

      {rejected.length > 0 && (
        <Section title="2 · Grounding · rejected">
          {rejected.map((r, i) => (
            <Kv key={i} k={r.claim} v={r.reason} />
          ))}
        </Section>
      )}

      {trace?.context && (
        <Section title="2 · Grounding · what BARRY saw">
          {trace.context.shown.length > 0 && (
            <ol className="text-sm list-none space-y-0.5">
              {trace.context.shown.map((p) => (
                <li key={p.position}>
                  <span className="text-neutral-500">#{p.position}</span> {p.title}
                </li>
              ))}
            </ol>
          )}
          {trace.context.cart && (
            <div className="mt-2">
              <p className="text-xs text-neutral-500">Cart (before this turn)</p>
              {trace.context.cart.lines.map((l) => (
                <Kv key={l.position} k={`${l.position}. ${l.title}`} v={`${Object.values(l.options).join("/") || "—"} × ${l.quantity}`} />
              ))}
              <Kv k="Total" v={dash(trace.context.cart.total)} />
            </div>
          )}
        </Section>
      )}

      {trace && (
        <Section title="3–4 · Authority & execution">
          {trace.steps.length === 0 && <p className="text-xs text-neutral-500">No action this turn.</p>}
          <div className="space-y-2">
            {trace.steps.map((step, i) => (
              <div key={i} className="text-sm border-t first:border-t-0 border-neutral-100 dark:border-neutral-800 pt-1.5 first:pt-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">
                    {i + 1}. {step.action}
                  </span>
                  <Chip>{step.trigger}</Chip>
                  <Chip tone={policyTone(step.policy.status)}>{step.policy.status}</Chip>
                  {step.result && <Chip tone={step.result.ok ? "good" : "bad"}>{step.result.ok ? "ok" : "failed"}</Chip>}
                </div>
                {step.capabilities.length > 0 && <Kv k="Capability / provider" v={step.capabilities.map((c) => `${c.capability}: ${c.provider ?? "none"}`).join(", ")} />}
                {step.generic && (
                  <>
                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                      <Chip tone={step.generic.executed ? "good" : "neutral"}>{step.generic.executed ? "executed" : "not executed"}</Chip>
                      {step.generic.executed && <Chip tone={step.generic.verified ? "good" : "neutral"}>{step.generic.verified ? "provider-verified" : "read (no write to verify)"}</Chip>}
                      {step.generic.simulated && <Chip tone="warn">simulated system</Chip>}
                      {step.generic.code && <Chip tone="bad">{step.generic.code}</Chip>}
                    </div>
                    <Kv k="Purpose" v={step.generic.purpose || "—"} />
                    <Kv k="Input fields" v={step.generic.inputFields.join(", ") || "—"} />
                    <Kv k="Authority" v={`${step.generic.authority.status}${step.generic.authority.ruleId ? ` · rule ${step.generic.authority.ruleId}` : " · no rule"}`} />
                    <Kv k="System" v={step.generic.system ? `${step.generic.system} via ${step.generic.connector}${step.generic.contractVersion ? ` · contract ${step.generic.contractVersion}` : ""}` : "not resolved / not reached"} />
                  </>
                )}
                {step.policy.status !== "allowed" && <p className="text-xs text-neutral-500">{step.policy.reason}</p>}
                {step.result?.error && <p className="text-xs text-red-600 dark:text-red-400 break-all">{step.result.error}</p>}
                <Kv k="Stage" v={`${step.stageBefore} → ${step.stageAfter}`} />
                {step.stateKeysChanged.length > 0 && <Kv k="State keys changed" v={step.stateKeysChanged.join(", ")} />}
              </div>
            ))}
          </div>
          <Kv k="Stopped because" v={`${trace.stop.reason} (${trace.stop.outcome})`} />
        </Section>
      )}

      {trace?.effects && trace.effects.length > 0 && (
        <Section title="5–6 · Verification & effect (ledger)">
          {trace.effects.map((e) => (
            <p key={e.seq} className="text-xs font-mono">
              #{e.seq} {e.operation} → <span className={e.status === "effected" ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>{e.effect} · {e.status}</span>
              {e.reference ? ` · ref ${e.reference}` : ""}
              {Object.keys(e.terms).length ? ` · ${JSON.stringify(e.terms)}` : ""}
            </p>
          ))}
        </Section>
      )}

      <Section title="7 · Reply · safety & contract">
        <Kv k="Missing fields" v={missing === undefined ? "not recorded" : missing.length ? missing.join(", ") : "none"} />
        {trace?.reply && <Kv k="Reply language" v={`${trace.reply.language} (${trace.reply.basis.replace(/_/g, " ")})`} />}
        {trace?.reply?.fallback && <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">Deterministic reply used — {trace.reply.fallback}</p>}
        {trace?.reply?.composerFailures?.map((f, i) => (
          <p key={i} className="text-xs text-red-600 dark:text-red-400 mt-1">Composer call failed — {failureLabel(f)}; the deterministic reply was used.</p>
        ))}
        {trace?.hold && <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">Owner approval held, not executed — {trace.hold.reason}</p>}
      </Section>

      {isLatest && (
        <Section title="Transaction state (now)">
          <Kv k="Stage" v={state.stage} />
          <Kv k="Cart" v={known.__commerceCartId ? `open${known.__commerceCartTotal ? ` · ${known.__commerceCartTotal}` : ""}` : "—"} />
          <Kv k="Checkout requested" v={known.__commerceCheckoutRequested ? "yes" : "no"} />
          <Kv k="Payment link" v={known.__paymentRequestId ? "sent" : "—"} />
          <Kv k="Payment" v={known.__paid ? "verified paid" : known.__paymentRequestId ? "not verified" : "—"} />
          <Kv k="Order" v={known.__commerceOrderId ? "created" : "—"} />
          <Kv k="Outcome" v={state.outcome ?? "pending"} />
        </Section>
      )}

      <Section title="7 · Reply">
        <p className="text-sm whitespace-pre-wrap">{turn.response}</p>
        {turn.compiled?.resolvedSchedulingWindow && <Json label="Resolved scheduling window (UTC)" value={turn.compiled.resolvedSchedulingWindow} />}
        {turn.responseFacts && <Json label="Response facts" value={turn.responseFacts} />}
        {turn.toolResult && <Json label="Last tool output" value={turn.toolResult.output ?? turn.toolResult.error} />}
      </Section>
      <details className="px-3 pb-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-neutral-500">Technical detail · models & runtime</summary>
        <Section title="Models & runtime">
        <div className="flex flex-wrap gap-1.5 mb-2">
          <Chip tone={turn.reasoner === "llm" ? "accent" : "neutral"}>{turn.reasoner === "llm" ? "LLM" : "Mock"}</Chip>
          {rt?.configError && <Chip tone="bad">config error</Chip>}
        </div>
        <Kv k="Reasoner model" v={`${dash(rt?.model)}${rt?.reasoningEffort ? ` · effort ${rt.reasoningEffort}` : ""}`} />
        <Kv k="Composer model" v={`${dash(rt?.composerModel)}${rt?.composerReasoningEffort ? ` · effort ${rt.composerReasoningEffort}` : ""}`} />
        <Kv k="Runtime" v={`${dash(rt?.barryVersion)}${rt?.commit ? ` @ ${rt.commit.slice(0, 7)}` : ""}`} />
        <Kv k="Constitution" v={dash(rt?.constitutionVersion)} />
        {rt?.configError && <p className="text-xs text-red-600 dark:text-red-400 mt-1">{rt.configError}</p>}
        </Section>
      </details>
    </>
  );
}

const RECOVERED: Record<string, string> = {
  proposed: "CORRECTED REQUEST SENT — awaiting owner approval",
  reused: "CORRECTED REQUEST already waiting for the owner",
  withdrawn: "customer withdrew the request",
  not_executed: "corrected action NOT done — the customer must confirm it",
  blocked: "corrected request can't be done here",
  needs_info: "corrected request needs more details from the customer",
  no_replacement: "no corrected request in the message",
  unrelated: "message didn't concern the held request — hold released",
};

/** FAILED CUSTOMER TURN → HELD APPROVAL → RE-CHECK → RECOVERED INTENT → OLD SUPERSEDED → NEW ACTIVE. */
function RecoveryCard({ chain }: { chain: RecoveryChain }) {
  const r = chain.recheck?.recovered;
  const step = (label: string, value: React.ReactNode) => (
    <li className="text-sm">
      <span className="font-semibold uppercase text-[11px] tracking-wide text-neutral-500">{label}</span> <span className="break-words">{value}</span>
    </li>
  );
  return (
    <Section title="Recovery · failed customer turn">
      <ol className="space-y-1">
        {step("Failed customer turn", <>“{chain.message ?? "?"}” <span className="text-neutral-500">({chain.reason ?? "unknown"})</span></>)}
        {step("Held approval", chain.heldRequestIds.length ? chain.heldRequestIds.join(", ") : "none pending")}
        {step("Re-check", chain.recheck ? new Date(chain.recheck.at).toLocaleString() : "not yet — still HELD")}
        {chain.recheck && step("Recovered intent", r ? RECOVERED[r.outcome] ?? r.outcome : "understood")}
        {chain.superseded.length > 0 && step("Old request superseded", chain.superseded.join(", "))}
        {chain.withdrawn.length > 0 && step("Old request withdrawn", chain.withdrawn.join(", "))}
        {r?.requestId && step("New request", <>{r.requestId} · {Object.entries(r.terms ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")} · sent to the owner (see Approvals for its current state)</>)}
      </ol>
    </Section>
  );
}

export function InspectorPanel({ state }: { state: ConversationState | null }) {
  const [picked, setPicked] = useState<number | null>(null);
  if (!state) {
    return <p className="text-sm text-neutral-500 p-3">Send a message to see BARRY&apos;s reasoning here.</p>;
  }
  const count = state.turns.length;
  const index = picked !== null && picked < count ? picked : count - 1;
  const turn: TurnLog | undefined = state.turns[index];

  return (
    <div className="space-y-3 p-3 overflow-y-auto h-full">
      {count > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-neutral-500 shrink-0">Turn</span>
          <select
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1 text-sm"
            value={index}
            onChange={(e) => setPicked(Number(e.target.value) === count - 1 ? null : Number(e.target.value))}
          >
            {state.turns.map((t, i) => (
              <option key={t.id} value={i}>
                {i + 1}. {t.customerMessage.slice(0, 40)}
              </option>
            ))}
          </select>
        </label>
      )}
      {recoveryChains(readLedgerField(state.knownFields)).map((c) => (
        <RecoveryCard key={c.failedSeq} chain={c} />
      ))}
      {turn ? <TurnView state={state} turn={turn} isLatest={index === count - 1} /> : <p className="text-sm text-neutral-500">No turns yet.</p>}
    </div>
  );
}
