"use client";

import { useEffect, useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OutcomeEvent } from "@/lib/owner/revenue";
import type { ConversationStory } from "@/lib/owner/story";
import type { Intervention } from "@/lib/owner/interventions";
import { formatLocal } from "@/lib/format/time";
import type { useOwnerApi } from "../useOwnerApi";
import { Empty, Pill, Skeleton, StateNotice, quiet, timeAgo } from "../ui";
import { InterventionCard, NextExpectedAction, OpportunityRow, StoryView, type Act } from "../operating";
import { BarryOrb, Hero, Icon, LiveDot, Panel, PanelHeader, Segmented } from "../kit";
import { CHANNEL, CONVERSATION_STATE, LIFECYCLE, OUTCOME, conversationState, plural, type ConversationState } from "./shared";

type Api = ReturnType<typeof useOwnerApi>;

type ConversationDetail = {
  id: string;
  customer: string;
  channel: string;
  messages: { from: string; text: string; at: string }[];
  outcomes: OutcomeEvent[];
  transaction: string[];
  requests: { id: string; what: string; lifecycle: string; createdAt: string }[];
  handoffs: { id: string; reason: string; status: string; urgency: string; summary: string; unresolved: string[]; responseCommitted: boolean }[];
  deliveries: { at: string; status: string; error?: string }[];
  story?: ConversationStory;
  turns?: { at: string; customerMessage: string; understood: string; actions: string[]; stoppedBecause: string | null; replyFallback: string | null }[];
};

type Filter = "all" | ConversationState;

const KINDWORD: Record<Intervention["kind"], string> = { approval: "your decision", held_approval: "a re-check", handoff: "a person", failed_action: "a failed step", blocked_write: "a limit", not_understood: "a message BARRY couldn't read", delivery_failed: "an undelivered reply" };

/**
 * INBOX — scan in seconds: who is BARRY handling, who is BARRY waiting on, what waits on you, what
 * needs review, what is resolved. Opening one tells its story before the messages.
 */
export function InboxView({ ws, api, act, busyId, open, setOpen, onIntervention, loadedAt }: { ws: OwnerWorkspace; api: Api; act: Act; busyId: string | null; open: string | null; setOpen: (id: string) => void; onIntervention: (id: string) => void; loadedAt: Date | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const withState = ws.conversations.map((c) => ({ c, state: conversationState(c) }));
  const count = (s: ConversationState) => withState.filter((x) => x.state === s).length;
  const rows = withState.filter((x) => filter === "all" || x.state === filter);
  const showList = !open;
  return (
    <div className="flex flex-col gap-5">
      <div className={showList ? "" : "hidden lg:block"}>
        <Hero eyebrow={`Inbox · ${ws.business.name}`} title={count("you") + count("review") ? <><span className="o-hero-type">{plural(count("you") + count("review"), "conversation")}</span> need{count("you") + count("review") === 1 ? "s" : ""} you.</> : <>BARRY is on <span className="o-hero-type">every conversation.</span></>} lead={`${plural(ws.conversations.length, "conversation")} · ${count("barry")} BARRY is handling · ${count("customer")} waiting on customers · ${count("resolved")} resolved`} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)]">
        <div className={showList ? "" : "hidden lg:block"}>
          <Segmented<Filter>
            ariaLabel="Filter conversations"
            value={filter}
            onChange={setFilter}
            options={[
              { id: "all", label: "All", count: ws.conversations.length },
              { id: "you", label: "Waiting on you", count: count("you") },
              { id: "review", label: "Needs review", count: count("review") },
              { id: "barry", label: "BARRY handling", count: count("barry") },
              { id: "customer", label: "Waiting on customer", count: count("customer") },
              { id: "resolved", label: "Resolved", count: count("resolved") },
            ]}
          />
          <div className="mt-3">
            {rows.length === 0 ? (
              <Empty title={ws.conversations.length === 0 ? "No conversations yet" : "Nothing here"}>{ws.conversations.length === 0 ? "Once customers write to BARRY, every conversation appears here with its state and what BARRY did." : "No conversation is in this state."}</Empty>
            ) : (
              <ul className="o-stage divide-y divide-o-line/70 overflow-hidden">
                {rows.map(({ c, state }) => {
                  const st = CONVERSATION_STATE[state];
                  const ring = { good: "ring-o-ok/50", warn: "ring-o-warn/60", bad: "ring-o-bad/60", info: "ring-o-accent/50", neutral: "ring-o-line-strong" }[st.tone];
                  const word = { good: "text-o-ok", warn: "text-o-warn", bad: "text-o-bad", info: "text-o-accent", neutral: "text-o-muted" }[st.tone];
                  return (
                    <li key={c.id}>
                      <button onClick={() => setOpen(c.id)} aria-current={open === c.id ? "true" : undefined} className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-o-sunken/50 ${open === c.id ? "bg-o-accent/10" : ""}`}>
                        <span className={`relative mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-o-raised to-o-sunken text-[14px] font-semibold text-o-ink-2 ring-2 ${ring}`}>
                          {c.customer.replace(/[^\p{L}]/gu, "").slice(0, 1).toUpperCase() || "?"}
                          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-o-canvas p-[3px]"><LiveDot state={st.live} /></span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-[14.5px] font-semibold text-o-ink">{c.customer}</span>
                            <span className="shrink-0 text-[12px] text-o-faint">{timeAgo(c.lastActivityAt)}</span>
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px]">
                            <span className={`font-medium ${word}`}>{st.label}</span>
                            <span className="text-o-faint">· {CHANNEL[c.channel]}</span>
                            {c.barryActions > 0 && <span className="text-o-faint">· BARRY did {plural(c.barryActions, "thing")}</span>}
                            {c.outcomes.slice(0, 2).map((o) => (
                              <span key={o} className={OUTCOME[o].tone === "good" ? "text-o-ok" : "text-o-muted"}>· {OUTCOME[o].label}</span>
                            ))}
                          </span>
                          {c.lastMessage && (
                            <span className="mt-1 block truncate text-[13px] text-o-muted">
                              {c.lastMessage.from === "barry" ? <span className="text-o-accent">BARRY · </span> : ""}
                              {c.lastMessage.text}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <div className={showList ? "hidden lg:block" : ""}>
          {open ? (
            <ConversationPanel key={open} id={open} api={api} ws={ws} act={act} busyId={busyId} onBack={() => setOpen("")} onIntervention={onIntervention} loadedAt={loadedAt} />
          ) : (
            <div className="o-stage hidden flex-col items-center px-8 py-12 text-center lg:flex">
              <BarryOrb size={56} state="idle" />
              <p className="mt-4 text-[15px] font-semibold text-o-ink">Pick a conversation</p>
              <p className="mt-1.5 max-w-sm text-[13.5px] leading-6 text-o-muted">You&apos;ll see what the customer wanted, what BARRY did, where it stands and what happens next — before the messages.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationPanel({ id, api, ws, act, busyId, onBack, onIntervention, loadedAt }: { id: string; api: Api; ws: OwnerWorkspace; act: Act; busyId: string | null; onBack: () => void; onIntervention: (id: string) => void; loadedAt: Date | null }) {
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [fullStory, setFullStory] = useState(false);
  const [error, setError] = useState("");
  const { businessId, call } = api;
  useEffect(() => {
    let cancelled = false;
    call<ConversationDetail>(`/api/owner/conversation?businessId=${encodeURIComponent(businessId)}&conversationId=${encodeURIComponent(id)}${advanced ? "&advanced=1" : ""}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError("");
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, call, id, advanced]);
  const row = ws.conversations.find((c) => c.id === id);
  const state = row ? conversationState(row) : undefined;
  const items = ws.interventions.filter((i) => i.conversationId === id);
  const money = ws.opportunities.items.filter((o) => o.conversationId === id);
  const back = (
    <button className={`${quiet} -ml-2 mb-1 lg:hidden`} onClick={onBack}>
      <Icon name="back" size={16} /> Inbox
    </button>
  );
  if (error)
    return (
      <Panel className="p-4 md:p-5">
        {back}
        <StateNotice tone="bad" title="Couldn't load this conversation">{error}</StateNotice>
      </Panel>
    );
  if (!data)
    return (
      <Panel className="p-4 md:p-5">
        {back}
        <p className="mb-3 text-lg font-semibold text-o-ink">{row?.customer ?? "Conversation"}</p>
        <Skeleton lines={5} />
      </Panel>
    );
  const steps = data.story?.steps ?? [];
  const lastAsk = [...steps].reverse().find((s) => !s.customer.startsWith("("))?.customer;
  const lastDid = [...steps].reverse().find((s) => s.barry.length > 0)?.barry;
  const decided = data.requests.filter((r) => r.lifecycle !== "active" && r.lifecycle !== "held");
  const nowWords = items.length ? `Waiting on you — ${items.map((i) => KINDWORD[i.kind]).join(", ")}` : row?.status === "waiting_on_customer" ? "Waiting on the customer — BARRY asked and is waiting for a reply." : row?.status === "completed" ? "Resolved — nothing left to do." : "BARRY is handling it.";
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-4 md:p-5" glow={state === "you" || state === "review"}>
        {back}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-o-ink">{data.customer}</h2>
          {state && <Pill tone={CONVERSATION_STATE[state].tone}>{CONVERSATION_STATE[state].label}</Pill>}
        </div>
        <p className="mt-1 text-[12px] text-o-faint">
          {CHANNEL[data.channel as keyof typeof CHANNEL] ?? data.channel}
          {row ? ` · last activity ${loadedAt ? formatLocal(row.lastActivityAt, ws.business.timezone, loadedAt) : timeAgo(row.lastActivityAt)}` : ""}
        </p>
        {/* The story: wanted → BARRY did → now → next */}
        <ol className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <StoryCell n={1} label="What they wanted" text={lastAsk ?? "—"} />
          <StoryCell n={2} label="What BARRY did" text={lastDid?.join(" · ") ?? "Answered and kept the conversation going."} />
          <StoryCell n={3} label="Where it stands" text={nowWords} tone={items.length ? "warn" : undefined} />
          <StoryCell n={4} label="Where things are" text={data.transaction.length ? data.transaction.join(" · ") : "No transaction in progress."} />
        </ol>
        <div className="mt-3">
          <NextExpectedAction items={ws.obligations} conversationId={id} />
        </div>
      </Panel>

      {items.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-[14px] font-semibold text-o-ink">Needs you here</h3>
          <ul className="flex flex-col gap-3">
            {items.map((i) => (
              <InterventionCard key={i.id} item={i} busy={busyId === i.id} onAct={act} />
            ))}
          </ul>
        </section>
      )}

      {money.length > 0 && (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="money" tone="ok" title="Money in this conversation" />
          <ul className="mt-3 divide-y divide-o-line">
            {money.map((o) => (
              <OpportunityRow key={o.id} o={o} onOpen={() => undefined} onIntervention={onIntervention} inConversation />
            ))}
          </ul>
        </Panel>
      )}

      {steps.length > 0 && (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="pulse" title="What happened" sub="From BARRY's records." right={steps.length > 4 ? <button className={quiet} onClick={() => setFullStory((v) => !v)}>{fullStory ? "Latest only" : `All ${steps.length} steps`}</button> : undefined} />
          <div className="mt-4">
            <StoryView story={data.story!} compact={!fullStory} />
          </div>
        </Panel>
      )}

      {decided.length > 0 && (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="shield" title="Requests to you" />
          <ul className="mt-3 space-y-2 text-[13px]">
            {decided.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Pill tone={(LIFECYCLE[r.lifecycle] ?? LIFECYCLE.approved).tone}>{(LIFECYCLE[r.lifecycle] ?? { label: r.lifecycle }).label}</Pill>
                <span className="text-o-ink-2">{r.what}</span>
                <span className="text-o-faint">{timeAgo(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {data.deliveries.some((d) => d.status === "failed") && <StateNotice tone="bad" title="Some replies couldn't be delivered">{data.deliveries.filter((d) => d.status === "failed").map((d) => d.error).join("; ")}</StateNotice>}

      <Panel className="p-4 md:p-5">
        <PanelHeader icon="chat" title={`Messages · ${data.messages.length}`} right={<button className={quiet} onClick={() => setShowMessages((v) => !v)}>{showMessages ? "Hide" : "Show"}</button>} />
        {showMessages ? (
          <div className="mt-3 flex max-h-[32rem] flex-col gap-2 overflow-y-auto pr-1">
            {data.messages.map((m, i) => (
              <div key={i} className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[14px] ${m.from === "customer" ? "self-start bg-o-sunken text-o-ink ring-1 ring-inset ring-o-line" : m.from === "barry" ? "self-end bg-o-accent/20 text-o-ink ring-1 ring-inset ring-o-accent/30" : "self-center bg-o-warn-bg text-xs text-o-warn"}`}>
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                <p className="mt-1 text-[10px] text-o-faint">{new Date(m.at).toLocaleString()}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-o-muted">{data.messages.at(-1) ? `Last: ${data.messages.at(-1)!.from === "barry" ? "BARRY — " : ""}“${data.messages.at(-1)!.text.slice(0, 140)}”` : "No messages."}</p>
        )}
        <label className="mt-3 flex items-center gap-1.5 text-[12px] text-o-faint">
          <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} className="accent-[var(--o-accent)]" /> Technical detail (for the BARRY team)
        </label>
        {advanced && data.turns && (
          <ol className="mt-2 space-y-2 text-xs text-o-ink-2">
            {data.turns.map((t, i) => (
              <li key={i} className="rounded-xl bg-o-sunken p-2.5 ring-1 ring-inset ring-o-line">
                <p className="font-medium text-o-ink">“{t.customerMessage}”</p>
                <p>Understanding: {t.understood}{t.stoppedBecause ? ` · stopped: ${t.stoppedBecause}` : ""}</p>
                {t.actions.length > 0 && <p>Actions: {t.actions.join("; ")}</p>}
                {t.replyFallback && <p>Reply safety: {t.replyFallback}</p>}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

function StoryCell({ n, label, text, tone }: { n: number; label: string; text: string; tone?: "warn" }) {
  return (
    <li className={`rounded-xl px-3.5 py-3 ring-1 ring-inset ${tone === "warn" ? "bg-o-warn-bg/70 ring-o-warn-line" : "bg-o-sunken/60 ring-o-line"}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-o-faint">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-o-raised text-[10px] text-o-ink-2">{n}</span>
        {label}
      </p>
      <p className={`mt-1 text-[13.5px] leading-5 ${tone === "warn" ? "text-o-warn" : "text-o-ink"}`}>{text}</p>
    </li>
  );
}
