"use client";

import { useState } from "react";
import type { Intervention, InterventionAction, InterventionKind } from "@/lib/owner/interventions";
import type { Opportunity, OpportunitySummary } from "@/lib/owner/opportunities";
import type { ConversationStory } from "@/lib/owner/story";
import { NEXT_MOVE_WORDS, isOpen, type Obligation } from "@/lib/operator/obligation-model";
import { Empty, Pill, btn, danger, formatMoney, primary, quiet, timeAgo, type Tone } from "./ui";

/**
 * THE OWNER'S OPERATING SURFACES — intervention cards, money in motion, the conversation story.
 * Every card answers, from the read model only: what happened, why you, what BARRY already did, what
 * you decide, what happens next. Actions call the existing owner endpoints, which re-check everything.
 */

export const KIND: Record<InterventionKind, { tone: Tone; label: string; accent: string }> = {
  approval: { tone: "warn", label: "Your decision", accent: "border-l-o-warn" },
  held_approval: { tone: "bad", label: "Re-check first", accent: "border-l-o-bad" },
  handoff: { tone: "info", label: "Needs a person", accent: "border-l-o-info" },
  failed_action: { tone: "bad", label: "Didn't go through", accent: "border-l-o-bad" },
  blocked_write: { tone: "neutral", label: "Stopped by the customer's limit", accent: "border-l-o-faint" },
  not_understood: { tone: "bad", label: "Not understood", accent: "border-l-o-bad" },
  delivery_failed: { tone: "bad", label: "Reply not delivered", accent: "border-l-o-bad" },
};

export type Act = (item: Intervention, action: InterventionAction) => Promise<void> | void;

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-o-faint sm:pt-0.5">{k}</dt>
      <dd className="text-[14px] leading-6 text-o-ink-2">{children}</dd>
    </div>
  );
}

/** Owner words for the known term keys; anything else is de-camel-cased, never shown as a raw key. */
const TERM_LABEL: Record<string, string> = { discountPct: "Discount", listAmount: "List price", item: "Item", items: "Items", quantity: "Quantity", reference: "Reference", reason: "Reason", discountItem: "Discount on" };

function termValue(k: string, v: string | number, currency?: string): string {
  if (k === "discountPct") return `${v}%`;
  if ((k === "listAmount" || /Amount$/.test(k)) && typeof v === "number" && currency) return formatMoney({ [currency]: v });
  return String(v);
}

function Terms({ terms, amount }: { terms: Record<string, string | number>; amount?: string }) {
  const currency = typeof terms.currency === "string" ? terms.currency : undefined;
  const entries = Object.entries(terms).filter(([k]) => k !== "currency" && k !== "amount");
  if (entries.length === 0 && !amount) return null;
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13.5px] text-o-ink">
      {amount && (
        <li>
          <span className="text-o-muted">Amount</span> <span className="font-semibold tabular-nums">{amount}</span>
        </li>
      )}
      {entries.map(([k, v]) => (
        <li key={k}>
          <span className="text-o-muted">{TERM_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</span> <span className="font-semibold tabular-nums">{termValue(k, v, currency)}</span>
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
  const hasTerms = item.terms && Object.keys(item.terms).length > 0;
  return (
    <li className={`o-panel o-rise relative overflow-hidden rounded-2xl border-l-[3px] p-4 md:p-5 ${kind.accent}`} data-intervention={item.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={kind.tone}>{kind.label}</Pill>
        <span className="text-[12.5px] text-o-muted">{item.customer}</span>
        <span className="ml-auto text-[12px] text-o-faint" title={item.since}>
          {timeAgo(item.since)}
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 flex-1 text-[17px] font-semibold leading-6 tracking-tight text-o-ink">{item.title}</h3>
        {item.amount && <span className="text-[20px] font-semibold tabular-nums tracking-tight text-o-ink">{item.amount}</span>}
      </div>
      {hasTerms && (
        <div className="mt-3 rounded-xl bg-o-sunken/70 px-3.5 py-2.5 ring-1 ring-inset ring-o-line">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-o-faint">Exact terms</p>
          <div className="mt-1">
            <Terms terms={item.terms ?? {}} amount={item.amount} />
          </div>
        </div>
      )}
      <dl className="mt-3 space-y-2">
        <Row k="Why you">{item.why}</Row>
        <Row k="You decide">{item.decision}</Row>
        {!compact && <Row k="Then">{item.then}</Row>}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className={held ? "font-medium text-o-bad" : "text-o-muted"}>{item.freshness}</span>
        {item.tried.length > 0 && (
          <button type="button" className="font-medium text-o-ink-2 underline-offset-2 hover:underline" onClick={() => setShowTried((v) => !v)} aria-expanded={showTried}>
            {showTried ? "Hide" : "What BARRY already did"} ({item.tried.length})
          </button>
        )}
        <button type="button" className="text-o-faint underline-offset-2 hover:underline" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
          {showDetails ? "Hide evidence" : "Evidence"}
        </button>
      </div>
      {showTried && (
        <ol className="mt-2 list-decimal space-y-0.5 rounded-xl bg-o-sunken/70 px-4 py-2 pl-8 text-[13px] text-o-ink-2">
          {item.tried.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      )}
      {showDetails && <p className="mt-2 rounded-xl bg-o-sunken/70 px-3 py-2 text-[12px] text-o-muted">{item.evidence.join(" · ")}</p>}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {item.options.map((o) => (
          <button key={o.action} type="button" className={`${o.destructive ? danger : o.primary ? primary : btn} w-full sm:w-auto`} disabled={busy} onClick={() => void onAct(item, o.action)} title={o.consequence}>
            {o.label}
          </button>
        ))}
        {!item.options.some((o) => o.action === "open_conversation") && (
          <button type="button" className={`${quiet} w-full justify-center sm:w-auto`} disabled={busy} onClick={() => void onAct(item, "open_conversation")}>
            Open conversation
          </button>
        )}
      </div>
      {!compact && item.options.length > 1 && (
        <ul className="mt-3 space-y-0.5 border-t border-o-line pt-3 text-[12px] text-o-muted">
          {item.options
            .filter((o) => o.action !== "open_conversation")
            .map((o) => (
              <li key={o.action}>
                <span className="font-medium text-o-ink-2">{o.label}:</span> {o.consequence}
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
            <span className="text-[14px] font-medium text-o-ink">{o.customer}</span>
            <span className="text-[12px] text-o-faint">{timeAgo(o.since)}</span>
          </div>
          <p className="mt-1 text-[13px] text-o-ink-2">{o.reasoning}</p>
          <p className="mt-1 text-[13px]">
            <span className="font-semibold text-o-ink">{WHO[o.next.who]}:</span> <span className="text-o-ink-2">{o.next.action}</span>
          </p>
        </div>
        {o.amount !== undefined && o.currency && <p className="shrink-0 text-[15px] font-semibold tabular-nums text-o-ink">{formatMoney({ [o.currency]: o.amount })}</p>}
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
        <button type="button" className="text-[12px] text-o-faint underline-offset-2 hover:underline" onClick={() => setShowEvidence((v) => !v)}>
          {showEvidence ? "Hide evidence" : "Evidence"}
        </button>
      </div>
      {showEvidence && <p className="mt-1 text-[12px] text-o-muted">{o.evidence.join(" · ")}</p>}
    </li>
  );
}

export function MoneyInMotion({ items, summary, onOpen, onIntervention, limit }: { items: Opportunity[]; summary: OpportunitySummary; onOpen: (conversationId: string) => void; onIntervention: (id: string) => void; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-o-ink-2">
        <span>Waits on you <span className="font-semibold tabular-nums text-o-ink">{formatMoney(summary.stuckWithYou)}</span></span>
        <span>On customers <span className="font-semibold tabular-nums text-o-ink">{formatMoney(summary.waitingOnCustomer)}</span></span>
        <span>At risk <span className={`font-semibold tabular-nums ${Object.keys(summary.atRisk).length ? "text-o-bad" : "text-o-ink"}`}>{formatMoney(summary.atRisk)}</span></span>
      </p>
      {Object.keys(summary.simulated).length > 0 && (
        <p className="mt-2 text-[12px] text-o-muted">
          Plus {formatMoney(summary.simulated)} pending on a simulated provider — test money, shown apart and never counted above.
        </p>
      )}
      {items.length === 0 ? (
        <div className="mt-3">
          <Empty title="No money is stuck">When a payment link goes unpaid, a sale waits on your approval, a purchase goes quiet or a deposit is missing, it shows here with what to do about it.</Empty>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-o-line">
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
    <ol className="relative space-y-3 border-l border-o-line pl-4">
      {steps.map((s) => (
        <li key={s.turnId} className="relative">
          <span className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-o-surface ${OUTCOME_WORDS[s.outcome].tone === "good" ? "bg-o-ok" : OUTCOME_WORDS[s.outcome].tone === "bad" ? "bg-o-bad" : OUTCOME_WORDS[s.outcome].tone === "warn" ? "bg-o-warn" : OUTCOME_WORDS[s.outcome].tone === "info" ? "bg-o-info" : "bg-o-faint"}`} />
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={OUTCOME_WORDS[s.outcome].tone} icon={false}>
              {OUTCOME_WORDS[s.outcome].label}
            </Pill>
            <span className="text-[12px] text-o-faint">{timeAgo(s.at)}</span>
          </div>
          <p className="mt-1 text-[14px] text-o-ink">
            <span className="text-o-faint">Customer:</span> {s.customer}
          </p>
          {s.barry.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-[13px] text-o-ink-2">
              {s.barry.map((b, i) => (
                <li key={i}>
                  <span className="text-o-faint">BARRY:</span> {b}
                </li>
              ))}
            </ul>
          )}
          {s.stopped && <p className="mt-0.5 text-[12px] font-medium text-o-warn">Stopped: {s.stopped}</p>}
        </li>
      ))}
    </ol>
  );
}


// ── What BARRY is watching (obligations) ──────────────────────────────────

/** "in 3h" / "2 days ago" / "now" — relative to the viewer's clock. */
function dueWords(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3600_000 ? `${Math.max(1, Math.round(abs / 60_000))}m` : abs < 48 * 3600_000 ? `${Math.round(abs / 3600_000)}h` : `${Math.round(abs / (24 * 3600_000))} days`;
  if (abs < 60_000) return "now";
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

const MOVE_TONE: Record<Obligation["nextMove"], Tone> = { needs_owner: "warn", barry_can_act: "good", waiting_on_customer: "neutral", blocked_by_capability: "bad", scheduled_for_later: "neutral" };

/** One line per obligation: whose move, what, why, when. Owner words only; the record behind it on demand. */
export function WatchingList({ items, onOpen, limit, empty }: { items: Obligation[]; onOpen?: (conversationId: string) => void; limit?: number; empty?: string }) {
  const open = items.filter(isOpen);
  const shown = limit ? open.slice(0, limit) : open;
  if (shown.length === 0) return <Empty title="Nothing to watch">{empty ?? "When a payment link goes unpaid, a reply fails to arrive, a deposit is missing or an action needs a retry, BARRY keeps it here until the records show it's done."}</Empty>;
  return (
    <ul className="divide-y divide-o-line">
      {shown.map((o) => (
        <li key={o.key} className="flex flex-col gap-0.5 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={MOVE_TONE[o.nextMove]}>{NEXT_MOVE_WORDS[o.nextMove]}</Pill>
            {onOpen ? (
              <button className="text-left font-medium text-o-ink hover:underline" onClick={() => onOpen(o.conversationId)}>
                {`${o.customer}: ${o.subject}`}
              </button>
            ) : (
              <span className="font-medium text-o-ink">{`${o.customer}: ${o.subject}`}</span>
            )}
            {o.simulated && <Pill tone="neutral" icon={false}>test</Pill>}
            {o.dueAt && <span className="text-[12px] text-o-faint">{`due ${dueWords(o.dueAt)}`}</span>}
          </div>
          <p className="text-[13px] text-o-ink-2">{`${o.reason} `}<span className="text-o-ink">{`Next: ${o.nextAction}`}</span></p>
        </li>
      ))}
    </ul>
  );
}

/** The next expected action in ONE conversation, from its first open obligation. */
export function NextExpectedAction({ items, conversationId }: { items: Obligation[]; conversationId: string }) {
  const mine = items.filter((o) => o.conversationId === conversationId && isOpen(o));
  if (mine.length === 0) return null;
  const o = mine[0];
  return (
    <div className="rounded-xl bg-o-raised px-3 py-2.5 text-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-o-muted">Next expected action</p>
      <p className="mt-0.5">
        <Pill tone={MOVE_TONE[o.nextMove]}>{NEXT_MOVE_WORDS[o.nextMove]}</Pill> <span className="font-medium">{o.nextAction}</span>
      </p>
      <p className="text-[12px] text-o-muted">{`${o.subject} · ${o.reason}${o.dueAt ? ` · due ${dueWords(o.dueAt)}` : ""}${mine.length > 1 ? ` · +${mine.length - 1} more` : ""}`}</p>
    </div>
  );
}
