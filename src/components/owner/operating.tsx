"use client";

import { useState } from "react";
import type { Intervention, InterventionAction, InterventionKind } from "@/lib/owner/interventions";
import type { Opportunity, OpportunitySummary } from "@/lib/owner/opportunities";
import type { ConversationStory } from "@/lib/owner/story";
import { Empty, Pill, btn, danger, formatMoney, primary, quiet, timeAgo, type Tone } from "./ui";

/**
 * THE OWNER'S OPERATING SURFACES — intervention cards, money in motion, the conversation story.
 * Every card answers, from the read model only: what happened, why you, what BARRY already did, what
 * you decide, what happens next. Actions call the existing owner endpoints, which re-check everything.
 */

export const KIND: Record<InterventionKind, { tone: Tone; label: string; accent: string }> = {
  approval: { tone: "warn", label: "Your decision", accent: "border-l-[#f79009]" },
  held_approval: { tone: "bad", label: "Re-check first", accent: "border-l-[#b42318]" },
  handoff: { tone: "info", label: "Needs a person", accent: "border-l-[#2e90fa]" },
  failed_action: { tone: "bad", label: "Didn't go through", accent: "border-l-[#b42318]" },
  blocked_write: { tone: "neutral", label: "Stopped by the customer's limit", accent: "border-l-[#98a2b3]" },
  not_understood: { tone: "bad", label: "Not understood", accent: "border-l-[#b42318]" },
  delivery_failed: { tone: "bad", label: "Reply not delivered", accent: "border-l-[#b42318]" },
};

export type Act = (item: Intervention, action: InterventionAction) => Promise<void> | void;

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">{k}</dt>
      <dd className="text-[14px] leading-6 text-[#344054]">{children}</dd>
    </div>
  );
}

function Terms({ terms, amount }: { terms: Record<string, string | number>; amount?: string }) {
  const entries = Object.entries(terms).filter(([k]) => k !== "currency" && k !== "amount");
  if (entries.length === 0 && !amount) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[#344054]">
      {amount && (
        <li>
          <span className="text-[#98a2b3]">amount</span> <span className="font-semibold tabular-nums">{amount}</span>
        </li>
      )}
      {entries.map(([k, v]) => (
        <li key={k}>
          <span className="text-[#98a2b3]">{k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}</span> {String(v)}
        </li>
      ))}
    </ul>
  );
}

export function InterventionCard({ item, busy, onAct, compact }: { item: Intervention; busy?: boolean; onAct: Act; compact?: boolean }) {
  const [showTried, setShowTried] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const kind = KIND[item.kind];
  const held = item.kind === "held_approval";
  return (
    <li className={`rounded-2xl border-l-4 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_0_0_1px_rgba(16,24,40,0.04)] md:p-5 ${kind.accent}`} data-intervention={item.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={kind.tone}>{kind.label}</Pill>
        {item.amount && <span className="text-[13px] font-semibold tabular-nums text-[#101828]">{item.amount}</span>}
        <span className="ml-auto text-[12px] text-[#98a2b3]" title={item.since}>
          {timeAgo(item.since)}
        </span>
      </div>
      <h3 className="mt-2 text-[16px] font-semibold leading-6 text-[#101828]">{item.title}</h3>
      <dl className="mt-3 space-y-2">
        <Row k="Why you">{item.why}</Row>
        {item.terms && Object.keys(item.terms).length > 0 && (
          <Row k="Exact terms">
            <Terms terms={item.terms} amount={item.amount} />
          </Row>
        )}
        <Row k="You decide">{item.decision}</Row>
        {!compact && <Row k="Then">{item.then}</Row>}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className={held ? "font-medium text-[#b42318]" : "text-[#667085]"}>{item.freshness}</span>
        {item.tried.length > 0 && (
          <button type="button" className="font-medium text-[#475467] underline-offset-2 hover:underline" onClick={() => setShowTried((v) => !v)} aria-expanded={showTried}>
            {showTried ? "Hide" : "What BARRY already did"} ({item.tried.length})
          </button>
        )}
        <button type="button" className="text-[#98a2b3] underline-offset-2 hover:underline" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
          {showDetails ? "Hide evidence" : "Evidence"}
        </button>
      </div>
      {showTried && (
        <ol className="mt-2 list-decimal space-y-0.5 rounded-xl bg-[#f9fafb] px-4 py-2 pl-8 text-[13px] text-[#475467]">
          {item.tried.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      )}
      {showDetails && <p className="mt-2 rounded-xl bg-[#f9fafb] px-3 py-2 text-[12px] text-[#667085]">{item.evidence.join(" · ")}</p>}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {item.options.map((o) => (
          <button key={o.action} type="button" className={`${o.destructive ? danger : o.primary ? primary : btn} w-full sm:w-auto`} disabled={busy} onClick={() => void onAct(item, o.action)} title={o.consequence}>
            {o.label}
          </button>
        ))}
        {!item.options.some((o) => o.action === "open_conversation") && (
          <button type="button" className={`${quiet} w-full sm:w-auto`} disabled={busy} onClick={() => void onAct(item, "open_conversation")}>
            Open conversation
          </button>
        )}
      </div>
      {!compact && item.options.length > 1 && (
        <ul className="mt-2 space-y-0.5 text-[12px] text-[#667085]">
          {item.options
            .filter((o) => o.action !== "open_conversation")
            .map((o) => (
              <li key={o.action}>
                <span className="font-medium text-[#475467]">{o.label}:</span> {o.consequence}
              </li>
            ))}
        </ul>
      )}
    </li>
  );
}

export function InterventionQueue({ items, busyId, onAct, limit, compact }: { items: Intervention[]; busyId: string | null; onAct: Act; limit?: number; compact?: boolean }) {
  if (items.length === 0) return <Empty title="Nothing needs you right now">BARRY is handling every open conversation within your rules. Requests for approval, customers who need a person, and anything that didn&apos;t go through will appear here.</Empty>;
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <ul className="flex flex-col gap-3">
      {shown.map((i) => (
        <InterventionCard key={i.id} item={i} busy={busyId === i.id} onAct={onAct} compact={compact} />
      ))}
    </ul>
  );
}

export const OPP: Record<Opportunity["kind"], { tone: Tone; label: string }> = {
  unpaid_link: { tone: "warn", label: "Unpaid link" },
  approval_blocking_sale: { tone: "warn", label: "Sale waiting on you" },
  held_blocking_sale: { tone: "bad", label: "Sale held" },
  stalled_purchase: { tone: "warn", label: "Purchase went quiet" },
  payment_failed: { tone: "bad", label: "Payment failed" },
  unpaid_deposit: { tone: "warn", label: "Deposit unpaid" },
  enquiry_open: { tone: "info", label: "Enquiry open" },
  blocked_by_limit: { tone: "neutral", label: "Stopped by a limit" },
};

const WHO: Record<Opportunity["next"]["who"], string> = { you: "Your move", customer: "Customer's move", barry: "BARRY's move" };

export function OpportunityRow({ o, onOpen, onIntervention, inConversation }: { o: Opportunity; onOpen: (conversationId: string) => void; onIntervention: (id: string) => void; inConversation?: boolean }) {
  const [showEvidence, setShowEvidence] = useState(false);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={OPP[o.kind].tone}>{OPP[o.kind].label}</Pill>
            {o.simulated && (
              <Pill tone="neutral" icon={false}>
                test · not counted
              </Pill>
            )}
            <span className="text-[14px] font-medium text-[#101828]">{o.customer}</span>
            <span className="text-[12px] text-[#98a2b3]">{timeAgo(o.since)}</span>
          </div>
          <p className="mt-1 text-[13px] text-[#475467]">{o.reasoning}</p>
          <p className="mt-1 text-[13px]">
            <span className="font-semibold text-[#101828]">{WHO[o.next.who]}:</span> <span className="text-[#344054]">{o.next.action}</span>
          </p>
        </div>
        {o.amount !== undefined && o.currency && <p className="shrink-0 text-[15px] font-semibold tabular-nums text-[#101828]">{formatMoney({ [o.currency]: o.amount })}</p>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {o.next.interventionId ? (
          <button type="button" className={primary} onClick={() => onIntervention(o.next.interventionId!)}>
            Decide now
          </button>
        ) : null}
        {!inConversation && (
          <button type="button" className={btn} onClick={() => onOpen(o.conversationId)}>
            Open conversation
          </button>
        )}
        <button type="button" className="text-[12px] text-[#98a2b3] underline-offset-2 hover:underline" onClick={() => setShowEvidence((v) => !v)}>
          {showEvidence ? "Hide evidence" : "Evidence"}
        </button>
      </div>
      {showEvidence && <p className="mt-1 text-[12px] text-[#667085]">{o.evidence.join(" · ")}</p>}
    </li>
  );
}

export function MoneyInMotion({ items, summary, onOpen, onIntervention, limit }: { items: Opportunity[]; summary: OpportunitySummary; onOpen: (conversationId: string) => void; onIntervention: (id: string) => void; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-xl bg-[#f9fafb] px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase leading-tight tracking-[0.08em] text-[#667085]">Waits on you</p>
          <p className="mt-1 text-lg font-semibold tabular-nums sm:text-xl">{formatMoney(summary.stuckWithYou)}</p>
        </div>
        <div className="rounded-xl bg-[#f9fafb] px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase leading-tight tracking-[0.08em] text-[#667085]">On customers</p>
          <p className="mt-1 text-lg font-semibold tabular-nums sm:text-xl">{formatMoney(summary.waitingOnCustomer)}</p>
        </div>
        <div className="rounded-xl bg-[#f9fafb] px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase leading-tight tracking-[0.08em] text-[#667085]">At risk</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-[#b42318] sm:text-xl">{formatMoney(summary.atRisk)}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="mt-3">
          <Empty title="No money is stuck">When a payment link goes unpaid, a sale waits on your approval, a purchase goes quiet or a deposit is missing, it shows here with what to do about it.</Empty>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-[#f2f4f7]">
          {shown.map((o) => (
            <OpportunityRow key={o.id} o={o} onOpen={onOpen} onIntervention={onIntervention} />
          ))}
        </ul>
      )}
    </>
  );
}

const OUTCOME_WORDS: Record<ConversationStory["steps"][number]["outcome"], { tone: Tone; label: string }> = {
  done: { tone: "good", label: "Done" },
  answered: { tone: "neutral", label: "Answered" },
  awaiting_owner: { tone: "warn", label: "Waiting for you" },
  needs_customer: { tone: "info", label: "Waiting for the customer" },
  blocked: { tone: "warn", label: "Stopped" },
  failed: { tone: "bad", label: "Didn't go through" },
  not_understood: { tone: "bad", label: "Not understood" },
  handoff: { tone: "info", label: "Handed to your team" },
  owner_decision: { tone: "neutral", label: "Your decision" },
};

export function StoryView({ story, compact }: { story: ConversationStory; compact?: boolean }) {
  if (story.steps.length === 0) return null;
  const steps = compact ? story.steps.slice(-4) : story.steps;
  return (
    <ol className="relative space-y-3 border-l border-[#e4e7ec] pl-4">
      {steps.map((s) => (
        <li key={s.turnId} className="relative">
          <span className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${OUTCOME_WORDS[s.outcome].tone === "good" ? "bg-[#12b76a]" : OUTCOME_WORDS[s.outcome].tone === "bad" ? "bg-[#f04438]" : OUTCOME_WORDS[s.outcome].tone === "warn" ? "bg-[#f79009]" : OUTCOME_WORDS[s.outcome].tone === "info" ? "bg-[#2e90fa]" : "bg-[#98a2b3]"}`} />
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={OUTCOME_WORDS[s.outcome].tone} icon={false}>
              {OUTCOME_WORDS[s.outcome].label}
            </Pill>
            <span className="text-[12px] text-[#98a2b3]">{timeAgo(s.at)}</span>
          </div>
          <p className="mt-1 text-[14px] text-[#101828]">
            <span className="text-[#98a2b3]">Customer:</span> {s.customer}
          </p>
          {s.barry.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-[13px] text-[#344054]">
              {s.barry.map((b, i) => (
                <li key={i}>
                  <span className="text-[#98a2b3]">BARRY:</span> {b}
                </li>
              ))}
            </ul>
          )}
          {s.stopped && <p className="mt-0.5 text-[12px] font-medium text-[#b54708]">Stopped: {s.stopped}</p>}
        </li>
      ))}
    </ol>
  );
}
