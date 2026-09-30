"use client";

import { useState } from "react";
import type { Intervention, InterventionAction, InterventionKind } from "@/lib/owner/interventions";
import type { Opportunity, OpportunitySummary } from "@/lib/owner/opportunities";
import type { ConversationStory } from "@/lib/owner/story";
import { Empty, Pill, Section, Stat, btn, danger, formatMoney, primary, timeAgo, type Tone } from "./ui";

/**
 * THE OWNER'S OPERATING SURFACES — the intervention queue, money in motion, and the conversation
 * story. Every card is rendered from the read model only; the actions call the existing owner
 * endpoints, which re-check everything before any effect.
 */

export const KIND: Record<InterventionKind, { tone: Tone; label: string }> = {
  approval: { tone: "warn", label: "NEEDS YOUR DECISION" },
  held_approval: { tone: "bad", label: "HELD — RE-CHECK FIRST" },
  handoff: { tone: "info", label: "NEEDS A PERSON" },
  failed_action: { tone: "bad", label: "DIDN'T GO THROUGH" },
  blocked_write: { tone: "neutral", label: "STOPPED BY THE CUSTOMER'S LIMIT" },
  not_understood: { tone: "bad", label: "NOT UNDERSTOOD" },
  delivery_failed: { tone: "bad", label: "REPLY NOT DELIVERED" },
};

export type Act = (item: Intervention, action: InterventionAction) => Promise<void> | void;

function Terms({ terms }: { terms: Record<string, string | number> }) {
  const entries = Object.entries(terms).filter(([k]) => k !== "currency");
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-lg bg-white/70 px-3 py-2 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[#667085]">{k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}</dt>
          <dd className="break-words">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InterventionCard({ item, busy, onAct, compact }: { item: Intervention; busy?: boolean; onAct: Act; compact?: boolean }) {
  const [showTried, setShowTried] = useState(false);
  const tone = KIND[item.kind];
  const border = item.priority === 1 ? "border-[#fedf89] bg-[#fffcf5]" : item.priority === 2 ? "border-[#fecdca] bg-[#fffbfa]" : "border-[#e4e7ec] bg-white";
  return (
    <li className={`rounded-xl border p-4 ${border}`} data-intervention={item.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={tone.tone}>{tone.label}</Pill>
          <span className="font-medium">{item.customer}</span>
          {item.amount && <span className="font-semibold tabular-nums">{item.amount}</span>}
        </div>
        <span className="text-xs text-[#667085]" title={item.since}>
          waiting {timeAgo(item.since)}
        </span>
      </div>
      <p className="mt-2 text-[15px] font-medium text-[#101828]">{item.title}</p>
      <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        <dt className="text-[#667085]">Why BARRY asks</dt>
        <dd className="text-[#344054]">{item.why}</dd>
        <dt className="text-[#667085]">You decide</dt>
        <dd className="text-[#344054]">{item.decision}</dd>
        {!compact && (
          <>
            <dt className="text-[#667085]">Then</dt>
            <dd className="text-[#344054]">{item.then}</dd>
            <dt className="text-[#667085]">Still current?</dt>
            <dd className="text-[#344054]">{item.freshness}</dd>
          </>
        )}
      </dl>
      {item.terms && Object.keys(item.terms).length > 0 && (
        <div className="mt-2">
          <Terms terms={item.terms} />
        </div>
      )}
      {item.tried.length > 0 && (
        <div className="mt-2">
          <button type="button" className="text-xs font-medium text-[#475467] underline-offset-2 hover:underline" onClick={() => setShowTried((v) => !v)} aria-expanded={showTried}>
            {showTried ? "Hide" : "Show"} what BARRY already did ({item.tried.length})
          </button>
          {showTried && (
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-[#475467]">
              {item.tried.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {item.options.map((o) => (
            <button key={o.action} type="button" className={o.destructive ? danger : o.primary ? primary : btn} disabled={busy} onClick={() => void onAct(item, o.action)} title={o.consequence}>
              {o.label}
            </button>
          ))}
          {!item.options.some((o) => o.action === "open_conversation") && (
            <button type="button" className={btn} disabled={busy} onClick={() => void onAct(item, "open_conversation")}>
              Open conversation
            </button>
          )}
        </div>
        {!compact && (
          <ul className="space-y-0.5 text-xs text-[#667085]">
            {item.options.map((o) => (
              <li key={o.action}>
                <span className="font-medium text-[#475467]">{o.label}:</span> {o.consequence}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-2 text-[11px] text-[#98a2b3]">Evidence: {item.evidence.join(" · ")}</p>
    </li>
  );
}

export function InterventionQueue({ items, busyId, onAct, limit, compact }: { items: Intervention[]; busyId: string | null; onAct: Act; limit?: number; compact?: boolean }) {
  if (items.length === 0) return <Empty>Nothing needs you right now. BARRY is handling every open conversation within your rules.</Empty>;
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <ul className="flex flex-col gap-3">
      {shown.map((i) => (
        <InterventionCard key={i.id} item={i} busy={busyId === i.id} onAct={onAct} compact={compact} />
      ))}
    </ul>
  );
}

const OPP: Record<Opportunity["kind"], { tone: Tone; label: string }> = {
  unpaid_link: { tone: "warn", label: "UNPAID LINK" },
  approval_blocking_sale: { tone: "warn", label: "SALE WAITING ON YOU" },
  held_blocking_sale: { tone: "bad", label: "SALE HELD" },
  stalled_purchase: { tone: "warn", label: "PURCHASE WENT QUIET" },
  payment_failed: { tone: "bad", label: "PAYMENT FAILED" },
  unpaid_deposit: { tone: "warn", label: "DEPOSIT UNPAID" },
  enquiry_open: { tone: "info", label: "ENQUIRY OPEN" },
  blocked_by_limit: { tone: "neutral", label: "STOPPED BY A LIMIT" },
};

const WHO: Record<Opportunity["next"]["who"], string> = { you: "Your move", customer: "Customer's move", barry: "BARRY's move" };

export function MoneyInMotion({ items, summary, onOpen, onIntervention }: { items: Opportunity[]; summary: OpportunitySummary; onOpen: (conversationId: string) => void; onIntervention: (id: string) => void }) {
  return (
    <Section title="Money in motion" subtitle="Where money is stuck, at risk or waiting — from payment, request, cart and booking records. Never counted as revenue.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Waits on you" value={formatMoney(summary.stuckWithYou)} hint="requests to decide, follow-ups to make" emphasis={Object.keys(summary.stuckWithYou).length > 0} />
        <Stat label="Waits on customers" value={formatMoney(summary.waitingOnCustomer)} hint="links sent, questions asked" />
        <Stat label="At risk" value={formatMoney(summary.atRisk)} hint="old links, failed payments, quiet purchases" />
      </div>
      {items.length === 0 ? (
        <div className="mt-3">
          <Empty>No money is stuck right now.</Empty>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-[#eaecf0]">
          {items.map((o) => (
            <li key={o.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={OPP[o.kind].tone}>{OPP[o.kind].label}</Pill>
                  {o.simulated && <Pill tone="neutral" icon={false}>test — not counted</Pill>}
                  <span className="font-medium">{o.customer}</span>
                  <span className="text-xs text-[#667085]">{timeAgo(o.since)}</span>
                </div>
                <p className="mt-1 text-sm text-[#344054]">{o.reasoning}</p>
                <p className="mt-0.5 text-sm">
                  <span className="font-medium text-[#101828]">{WHO[o.next.who]}:</span> <span className="text-[#475467]">{o.next.action}</span>
                </p>
                <p className="text-[11px] text-[#98a2b3]">Evidence: {o.evidence.join(" · ")}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
                {o.amount !== undefined && o.currency && <p className="font-semibold tabular-nums">{formatMoney({ [o.currency]: o.amount })}</p>}
                {o.next.interventionId ? (
                  <button type="button" className={primary} onClick={() => onIntervention(o.next.interventionId!)}>
                    Decide
                  </button>
                ) : (
                  <button type="button" className={btn} onClick={() => onOpen(o.conversationId)}>
                    Open conversation
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const OUTCOME_WORDS: Record<ConversationStory["steps"][number]["outcome"], { tone: Tone; label: string }> = {
  done: { tone: "good", label: "Done" },
  answered: { tone: "neutral", label: "Answered" },
  awaiting_owner: { tone: "warn", label: "Waiting for you" },
  needs_customer: { tone: "info", label: "Waiting for the customer" },
  blocked: { tone: "warn", label: "Blocked" },
  failed: { tone: "bad", label: "Failed" },
  not_understood: { tone: "bad", label: "Not understood" },
  handoff: { tone: "info", label: "Handed to your team" },
  owner_decision: { tone: "neutral", label: "Your decision" },
};

export function StoryView({ story }: { story: ConversationStory }) {
  if (story.steps.length === 0) return null;
  return (
    <div className="mb-3 rounded-lg bg-[#f9fafb] p-3 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-[#667085]">What happened</p>
      <ol className="mt-1 space-y-2">
        {story.steps.map((s) => (
          <li key={s.turnId} className="rounded-md bg-white px-3 py-2 ring-1 ring-[#eaecf0]">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={OUTCOME_WORDS[s.outcome].tone} icon={false}>
                {OUTCOME_WORDS[s.outcome].label}
              </Pill>
              <span className="text-xs text-[#98a2b3]">{timeAgo(s.at)}</span>
            </div>
            <p className="mt-1 text-[#101828]">
              <span className="text-[#667085]">Asked:</span> {s.customer}
            </p>
            {s.barry.length > 0 && (
              <ul className="mt-0.5 list-disc pl-5 text-[#344054]">
                {s.barry.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
            {s.stopped && <p className="mt-0.5 text-xs text-[#b54708]">Stopped: {s.stopped}</p>}
          </li>
        ))}
      </ol>
      {story.standing.length > 0 && <p className="mt-2 text-xs text-[#475467]">Where things stand: {story.standing.join(" · ")}</p>}
    </div>
  );
}
