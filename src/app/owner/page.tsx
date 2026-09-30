"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { OwnerBar, useOwnerApi } from "@/components/owner/useOwnerApi";
import { TestShell } from "@/components/shell/TestShell";
import { Empty, Pill, Section, Stat, btn, card, formatMoney, primary, timeAgo, type Tone } from "@/components/owner/ui";
import type { OwnerWorkspace, OwnerConversationRow, OwnerApproval, AttentionReason } from "@/lib/owner/service";
import type { OutcomeEvent } from "@/lib/owner/revenue";
import type { Intervention, InterventionAction } from "@/lib/owner/interventions";
import type { ConversationStory } from "@/lib/owner/story";
import { InterventionQueue, MoneyInMotion, StoryView, type Act } from "@/components/owner/operating";

type Tab = "today" | "inbox" | "approvals" | "outcomes" | "health" | "ask";
const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "inbox", label: "Inbox" },
  { id: "approvals", label: "Approvals" },
  { id: "outcomes", label: "Outcomes" },
  { id: "health", label: "Health" },
  { id: "ask", label: "Ask BARRY" },
];

const STATUS: Record<OwnerConversationRow["status"], { tone: Tone; label: string }> = {
  needs_you: { tone: "bad", label: "Needs you" },
  in_progress: { tone: "info", label: "In progress" },
  waiting_on_customer: { tone: "neutral", label: "Waiting on customer" },
  completed: { tone: "good", label: "Completed" },
  lost: { tone: "neutral", label: "Lost" },
};

const ATTENTION: Record<AttentionReason, string> = {
  approval_waiting: "Waiting for your approval",
  approval_held: "Request held — customer said something after it",
  handoff_open: "Customer needs a person",
  ai_unavailable: "BARRY couldn't understand the last message",
  action_failed: "Something didn't go through",
  blocked: "Blocked by the customer's own limits",
};

const OUTCOME: Record<OutcomeEvent["kind"], { tone: Tone; label: string }> = {
  paid: { tone: "good", label: "Paid" },
  booked: { tone: "good", label: "Booked" },
  order_created: { tone: "good", label: "Order" },
  case_created: { tone: "info", label: "Case opened" },
  checkout_abandoned: { tone: "warn", label: "Checkout not completed" },
  blocked: { tone: "warn", label: "Blocked" },
  failed: { tone: "bad", label: "Failed" },
  handoff: { tone: "info", label: "Handoff" },
  declined_by_owner: { tone: "neutral", label: "You declined" },
};

const LIFECYCLE: Record<string, { tone: Tone; label: string; explain: string }> = {
  active: { tone: "warn", label: "ACTIVE", explain: "Waiting for your decision." },
  held: { tone: "bad", label: "HELD", explain: "Can't be approved until the conversation is re-checked." },
  executed: { tone: "good", label: "EXECUTED", explain: "Approved and carried out; the business system confirmed it." },
  executed_unconfirmed: { tone: "warn", label: "EXECUTED · UNCONFIRMED", explain: "Submitted, but the system hasn't confirmed it happened." },
  failed: { tone: "bad", label: "FAILED", explain: "Approved, but carrying it out didn't go through (or was blocked by the customer's limits)." },
  declined: { tone: "neutral", label: "DECLINED", explain: "You declined it." },
  withdrawn: { tone: "neutral", label: "WITHDRAWN", explain: "The customer withdrew it." },
  superseded: { tone: "neutral", label: "SUPERSEDED", explain: "Replaced by a newer request (the customer changed its details)." },
  approved: { tone: "info", label: "APPROVED", explain: "Approved." },
};

function Terms({ a }: { a: OwnerApproval }) {
  const entries = Object.entries(a.terms).filter(([k]) => k !== "currency");
  return (
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-lg bg-white/70 px-3 py-2 text-sm">
      <dt className="text-[#667085]">Customer</dt>
      <dd className="break-words">{a.customer}</dd>
      <dt className="text-[#667085]">Action</dt>
      <dd className="break-words font-mono text-xs leading-5">{a.action}</dd>
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[#667085]">{k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}</dt>
          <dd className="break-words">{String(v)}</dd>
        </div>
      ))}
      {a.amount && (
        <>
          <dt className="text-[#667085]">Amount</dt>
          <dd className="font-semibold tabular-nums">{a.amount}</dd>
        </>
      )}
      {a.resultReference && (
        <>
          <dt className="text-[#667085]">Result</dt>
          <dd className="font-medium">{a.resultReference}</dd>
        </>
      )}
    </dl>
  );
}

const CHANNEL: Record<OwnerConversationRow["channel"], string> = { whatsapp: "WhatsApp", web: "Web chat", instagram: "Instagram", simulator: "Simulator" };

export default function OwnerDashboard() {
  const api = useOwnerApi();
  const [tab, setTab] = useState<Tab>("today");
  const [range, setRange] = useState<"today" | "7d" | "30d">("today");
  const [loaded, setWs] = useState<OwnerWorkspace | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [openConversation, setOpenConversation] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const { businessId, call, authorized } = api;
  // Nothing of a business is shown without that business's owner session.
  const ws = authorized && loaded?.business.id === businessId ? loaded : null;
  const fetchWorkspace = useCallback(() => call<OwnerWorkspace>(`/api/owner/workspace?businessId=${encodeURIComponent(businessId)}&window=${range}`), [businessId, call, range]);

  const load = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      setWs(await fetchWorkspace());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
      setWs(null);
    } finally {
      setLoading(false);
    }
  }, [businessId, fetchWorkspace]);

  useEffect(() => {
    if (!businessId || !authorized) return;
    let cancelled = false;
    fetchWorkspace()
      .then((data) => {
        if (cancelled) return;
        setWs(data);
        setError("");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setWs(null);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, authorized, fetchWorkspace]);

  const needs = ws?.conversations.filter((c) => c.status === "needs_you") ?? [];
  const pendingApprovals = ws?.approvals.filter((a) => a.actionable || a.lifecycle === "held") ?? [];
  const queue = ws?.interventions ?? [];

  const goToConversation = (conversationId: string) => {
    setOpenConversation(conversationId);
    setTab("inbox");
  };
  const goToIntervention = (id: string) => {
    setTab("today");
    if (typeof document !== "undefined") setTimeout(() => document.querySelector(`[data-intervention="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  // One action handler for every queue item: the existing owner endpoints re-check everything before an effect.
  const act: Act = async (item: Intervention, action: InterventionAction) => {
    if (action === "open_conversation") return goToConversation(item.conversationId);
    setBusyId(item.id);
    setNotice("");
    try {
      if (action === "approve" || action === "decline" || action === "recheck") {
        const res = await call<{ message?: string; held?: { reason: string } | null; recheck?: { revalidated: number; stillUnresolved: number; changedRequests: number; recovered?: { outcome: string }[] } }>("/api/owner/approvals", { body: { businessId, approvalId: item.refs.approvalId, action } });
        if (res.recheck) {
          const recovered = res.recheck.recovered?.find((r) => r.outcome !== "unrelated");
          setNotice(res.recheck.revalidated === 0 ? "BARRY still can't read the customer's later message — the request stays held." : recovered?.outcome === "proposed" || recovered?.outcome === "reused" ? "The customer's later message changed this request: the old one was replaced and the corrected request is waiting for you." : res.recheck.changedRequests > 0 ? "The customer's later message changed this request — it was cancelled and won't run." : "Re-checked: the customer's later message didn't change this request. You can decide it now.");
        } else if (res.held) setNotice(`Not carried out: ${res.held.reason}. The customer was asked to confirm.`);
        else setNotice(action === "approve" ? `Approved — ${res.message ? `BARRY told the customer: “${res.message.slice(0, 160)}”` : "BARRY carried it out and told the customer."}` : "Declined — BARRY told the customer; nothing was sent or changed.");
      } else {
        await call("/api/owner/handoffs", { body: { businessId, conversationId: item.conversationId, handoffId: item.refs.handoffId, action } });
        setNotice(action === "acknowledge" ? "Acknowledged — your team has seen it. The customer was not messaged." : "Resolved — closed in your inbox. BARRY continues the conversation as usual.");
      }
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#f9fafb] text-[#101828]">
      <TestShell active="owner" />
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 md:py-10">
        <OwnerBar api={api} title={ws ? ws.business.name : "Your business"} subtitle="What BARRY did for your business, what needs you, and how it's performing." />

        {authorized && error && <p className="rounded-lg border border-[#fecdca] bg-[#fef3f2] px-4 py-3 text-sm text-[#b42318]">{error}</p>}
        {ws && (ws.health.ai.status === "unavailable" || ws.health.ai.status === "degraded") && (
          <div className={`rounded-xl border px-4 py-3 text-sm ${ws.health.ai.status === "unavailable" ? "border-[#fecdca] bg-[#fef3f2] text-[#b42318]" : "border-[#fedf89] bg-[#fffaeb] text-[#b54708]"}`} role="status">
            <p className="font-semibold">{ws.health.ai.status === "unavailable" ? "AI understanding temporarily unavailable" : "AI understanding degraded"}</p>
            <p className="mt-0.5">{ws.health.ai.summary}</p>
          </div>
        )}
        {ws?.unavailable.length ? <p className="text-sm text-[#b54708]">Couldn&apos;t load: {ws.unavailable.join(", ")} — figures below exclude them.</p> : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="-mx-1 flex min-w-0 max-w-full gap-1 overflow-x-auto" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${tab === t.id ? "bg-white text-[#101828] shadow-sm ring-1 ring-[#e4e7ec]" : "text-[#475467] hover:text-[#101828]"}`}>
                {t.label}
                {t.id === "today" && queue.length > 0 && <span className="ml-1.5 rounded-full bg-[#b42318] px-1.5 text-xs text-white">{queue.length}</span>}
                {t.id === "approvals" && pendingApprovals.length > 0 && <span className="ml-1.5 rounded-full bg-[#b42318] px-1.5 text-xs text-white">{pendingApprovals.length}</span>}
                {t.id === "inbox" && needs.length > 0 && <span className="ml-1.5 rounded-full bg-[#1d2939] px-1.5 text-xs text-white">{needs.length}</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value as typeof range)} className="rounded-lg border border-[#d0d5dd] bg-white px-2.5 py-1.5 text-sm">
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <button className={btn} onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {!authorized && api.session && <p className="rounded-xl border border-dashed border-[#d0d5dd] bg-white px-4 py-6 text-center text-sm text-[#475467]">Sign in as this business&apos;s owner (above) to see its conversations, approvals, outcomes and money.</p>}
        {authorized && !ws && !error && <p className="text-sm text-[#667085]">{loading ? "Loading your business…" : "Loading…"}</p>}
        {ws && notice && (
          <p className="rounded-lg border border-[#e4e7ec] bg-white px-4 py-3 text-sm" role="status">
            {notice}
          </p>
        )}
        {ws && tab === "today" && <TodayView ws={ws} act={act} busyId={busyId} onOpen={goToConversation} onIntervention={goToIntervention} onQueue={() => setTab("approvals")} />}
        {ws && tab === "inbox" && <InboxView ws={ws} api={api} open={openConversation} setOpen={setOpenConversation} />}
        {ws && tab === "approvals" && <ApprovalsView ws={ws} act={act} busyId={busyId} />}
        {ws && tab === "outcomes" && <OutcomesView ws={ws} />}
        {ws && tab === "health" && <HealthView ws={ws} api={api} reload={load} />}
        {ws && tab === "ask" && <AskView api={api} />}
      </div>
    </main>
  );
}

type Api = ReturnType<typeof useOwnerApi>;

const REVENUE_CATEGORIES: { id: OwnerWorkspace["revenueEvidence"][number]["category"]; label: string; explain: string }[] = [
  { id: "collected", label: "COLLECTED", explain: "Provider-verified paid money only — the only real revenue." },
  { id: "recovered", label: "RECOVERED", explain: "Collected money that followed an earlier failed or cancelled attempt (already inside Collected)." },
  { id: "booked_not_collected", label: "BOOKED, NOT COLLECTED", explain: "Value of bookings BARRY made; not cash." },
  { id: "open_opportunity", label: "OPEN OPPORTUNITIES", explain: "Unpaid payment links and requests waiting for you — not revenue." },
  { id: "simulated", label: "SIMULATED", explain: "Test money on simulated providers — never counted." },
  { id: "excluded_unverified", label: "NOT COUNTED", explain: "Marked paid without verification, or unpaid simulated links — never counted." },
];

function RevenueReconciliation({ ws }: { ws: OwnerWorkspace }) {
  const items = ws.revenueEvidence;
  return (
    <Section title="Why these numbers" subtitle="Every amount, the category it's in, and the record that puts it there.">
      {items.length === 0 ? (
        <Empty>No money records in this period.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {REVENUE_CATEGORIES.filter((c) => items.some((i) => i.category === c.id)).map((c) => {
            const rows = items.filter((i) => i.category === c.id);
            const totals: Record<string, number> = {};
            for (const r of rows) totals[r.currency] = Math.round(((totals[r.currency] ?? 0) + r.amount) * 100) / 100;
            return (
              <details key={c.id} className="rounded-lg border border-[#eaecf0] p-3">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Pill tone={c.id === "collected" || c.id === "recovered" ? "good" : c.id === "booked_not_collected" ? "info" : "neutral"}>{c.label}</Pill>
                    <span className="text-xs text-[#667085]">{c.explain}</span>
                  </span>
                  <span className="font-semibold tabular-nums">{formatMoney(totals)}</span>
                </summary>
                <ul className="mt-2 divide-y divide-[#f2f4f7] text-sm">
                  {rows.map((r, i) => (
                    <li key={i} className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:justify-between">
                      <span className="min-w-0 break-words text-[#344054]">
                        {r.customer} — <span className="text-[#667085]">{r.record}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney({ [r.currency]: r.amount })}</span>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function TodayView({ ws, act, busyId, onOpen, onIntervention, onQueue }: { ws: OwnerWorkspace; act: Act; busyId: string | null; onOpen: (conversationId: string) => void; onIntervention: (id: string) => void; onQueue: () => void }) {
  const r = ws.revenue;
  const t = ws.today;
  const interventionRate = r.activeConversations ? Math.round((r.ownerInterventions / r.activeConversations) * 100) : null;
  const queue = ws.interventions;
  return (
    <div className="flex flex-col gap-5">
      <Section
        title={queue.length ? `Needs you — ${queue.length} item${queue.length === 1 ? "" : "s"}` : "Needs you"}
        subtitle="Everything waiting on a decision or a person, in priority order. Each item says why BARRY escalated, what it already did, what you decide and what follows."
        right={queue.length > 6 ? <button className={btn} onClick={onQueue}>See all requests</button> : undefined}
      >
        <InterventionQueue items={queue} busyId={busyId} onAct={act} limit={6} />
      </Section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Conversations" value={t.conversations} hint={ws.window.label} />
        <Stat label="Handled without you" value={t.handledAutonomously} hint={t.conversations ? `${Math.round((t.handledAutonomously / t.conversations) * 100)}% of conversations` : undefined} />
        <Stat label="Need you now" value={t.needYou} hint={t.approvalsWaiting ? `${t.approvalsWaiting} approval${t.approvalsWaiting === 1 ? "" : "s"} · ${t.handoffsOpen} handoff${t.handoffsOpen === 1 ? "" : "s"}` : `${t.handoffsOpen} handoff${t.handoffsOpen === 1 ? "" : "s"}`} emphasis={t.needYou > 0} />
        <Stat label="Completed outcomes" value={t.completedOutcomes} hint={t.blockedOrFailed ? `${t.blockedOrFailed} blocked or failed` : "paid, booked, orders, cases"} />
      </div>

      <Section title="Money" subtitle="Only provider-verified payments count as collected. Other figures are shown separately and never added together.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Collected by BARRY" value={formatMoney(r.direct)} hint={`${r.directPayments} verified payment${r.directPayments === 1 ? "" : "s"}${Object.keys(r.recovered).length ? ` · recovered ${formatMoney(r.recovered)}` : ""}`} emphasis />
          <Stat label="Booked, not yet collected" value={formatMoney(r.influenced)} hint={`${r.influencedBookings} booking${r.influencedBookings === 1 ? "" : "s"} BARRY made`} />
          <Stat label="Open opportunities" value={formatMoney(r.potential)} hint={`${r.potentialItems} unpaid link${r.potentialItems === 1 ? "" : "s"} or request${r.potentialItems === 1 ? "" : "s"} — not revenue`} />
          <Stat label="Conversion" value={r.purchaseIntentConversations ? `${r.convertedConversations} / ${r.purchaseIntentConversations}` : "—"} hint={`reached buying intent → paid/booked · ${r.lostOpportunities} lost`} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#667085]">
          <span>Discounts: {r.discounts.granted} granted, {r.discounts.refused} refused</span>
          <span>·</span>
          <span>You stepped in on {interventionRate === null ? "—" : `${interventionRate}%`} of conversations</span>
          {(Object.keys(r.simulatedPaid).length > 0 || Object.keys(r.simulatedInfluenced).length > 0) && (
            <>
              <span>·</span>
              <span>Test/simulated money (not counted): {formatMoney(r.simulatedPaid)}{Object.keys(r.simulatedInfluenced).length ? `, ${formatMoney(r.simulatedInfluenced)} booked` : ""}</span>
            </>
          )}
        </div>
      </Section>

      <MoneyInMotion items={ws.opportunities.items} summary={ws.opportunities.summary} onOpen={onOpen} onIntervention={onIntervention} />

      <RevenueReconciliation ws={ws} />

      <Section title="Recent outcomes">
        <OutcomeList events={ws.outcomes.slice(0, 6)} ws={ws} />
      </Section>
    </div>
  );
}

function OutcomeList({ events, ws }: { events: OutcomeEvent[]; ws: OwnerWorkspace }) {
  if (events.length === 0) return <Empty>No outcomes in this period yet.</Empty>;
  const customer = (id: string) => ws.conversations.find((c) => c.id === id)?.customer ?? "Customer";
  return (
    <ul className="divide-y divide-[#eaecf0]">
      {events.map((e, i) => (
        <li key={`${e.conversationId}-${e.at}-${i}`} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={OUTCOME[e.kind].tone}>{OUTCOME[e.kind].label}</Pill>
              {e.simulated && <Pill tone="neutral" icon={false}>test</Pill>}
              <span className="font-medium">{customer(e.conversationId)}</span>
            </div>
            <p className="mt-1 text-sm text-[#475467]">
              {e.label}
              {e.reference ? ` · ${e.reference}` : ""}
            </p>
            <p className="text-xs text-[#98a2b3]">Evidence: {e.evidence}</p>
          </div>
          <div className="text-right text-sm">
            {e.amount !== undefined && e.currency && <p className="font-semibold tabular-nums">{formatMoney({ [e.currency]: e.amount })}</p>}
            <p className="text-xs text-[#667085]">{timeAgo(e.at)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

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

function InboxView({ ws, api, open, setOpen }: { ws: OwnerWorkspace; api: Api; open: string | null; setOpen: (id: string | null) => void }) {
  const [filter, setFilter] = useState<"all" | "needs_you">("all");
  const rows = ws.conversations.filter((c) => filter === "all" || c.status === "needs_you");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Section
        title="Conversations"
        right={
          <select aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="rounded-lg border border-[#d0d5dd] bg-white px-2 py-1 text-sm">
            <option value="all">All</option>
            <option value="needs_you">Needs you</option>
          </select>
        }
      >
        {rows.length === 0 ? (
          <Empty>No conversations yet.</Empty>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {rows.map((c) => (
              <li key={c.id}>
                <button onClick={() => setOpen(c.id)} className={`w-full rounded-lg px-2 py-3 text-left hover:bg-[#f9fafb] ${open === c.id ? "bg-[#f2f4f7]" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{c.customer}</span>
                    <span className="shrink-0 text-xs text-[#667085]">{timeAgo(c.lastActivityAt)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Pill tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill>
                    <span className="text-xs text-[#667085]">{CHANNEL[c.channel]}</span>
                    {c.outcomes.map((o) => (
                      <Pill key={o} tone={OUTCOME[o].tone} icon={false}>
                        {OUTCOME[o].label}
                      </Pill>
                    ))}
                  </div>
                  {c.lastMessage && <p className="mt-1 truncate text-sm text-[#475467]">{c.lastMessage.from === "barry" ? "BARRY: " : ""}{c.lastMessage.text}</p>}
                  {c.attention.length > 0 && <p className="mt-1 text-xs font-medium text-[#b42318]">{c.attention.map((a) => ATTENTION[a]).join(" · ")}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {open ? <ConversationPanel id={open} api={api} /> : <div className={`${card} hidden lg:block`}><Empty>Select a conversation to see what happened.</Empty></div>}
    </div>
  );
}

function ConversationPanel({ id, api }: { id: string; api: Api }) {
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [advanced, setAdvanced] = useState(false);
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
  if (error) return <Section title="Conversation"><p className="text-sm text-[#b42318]">{error}</p></Section>;
  if (!data) return <Section title="Conversation"><p className="text-sm text-[#667085]">Loading…</p></Section>;
  return (
    <Section title={data.customer} subtitle={data.channel === "simulator" ? "Simulator conversation" : data.channel} right={<label className="flex items-center gap-1.5 text-xs text-[#475467]"><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Technical detail</label>}>
      {data.handoffs.filter((h) => h.status !== "resolved").map((h) => (
        <div key={h.id} className="mb-3 rounded-lg border border-[#b2ddff] bg-[#eff8ff] p-3 text-sm text-[#175cd3]">
          <p className="font-semibold">Needs a person{h.urgency === "urgent" ? " — urgent" : ""}</p>
          <p className="mt-0.5">{h.summary}</p>
          {h.unresolved.length > 0 && <p className="mt-1">Still open: {h.unresolved.join("; ")}</p>}
          {!h.responseCommitted && <p className="mt-1 text-xs">BARRY told the customer the team can see this but didn&apos;t promise a reply time.</p>}
        </div>
      ))}
      {data.story ? (
        <StoryView story={data.story} />
      ) : data.transaction.length > 0 && (
        <div className="mb-3 rounded-lg bg-[#f9fafb] p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-[#667085]">Where things stand</p>
          <ul className="mt-1 list-disc pl-5 text-[#344054]">
            {data.transaction.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1">
        {data.messages.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.from === "customer" ? "self-start bg-[#f2f4f7]" : m.from === "barry" ? "self-end bg-[#1d2939] text-white" : "self-center bg-[#fffaeb] text-xs text-[#b54708]"}`}>
            <p className="whitespace-pre-wrap break-words">{m.text}</p>
            <p className={`mt-1 text-[10px] ${m.from === "barry" ? "text-[#d0d5dd]" : "text-[#98a2b3]"}`}>{new Date(m.at).toLocaleString()}</p>
          </div>
        ))}
      </div>
      {data.requests.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-[#667085]">Requests to you</p>
          <ul className="mt-1 space-y-1 text-sm">
            {data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Pill tone={(LIFECYCLE[r.lifecycle] ?? LIFECYCLE.approved).tone}>{(LIFECYCLE[r.lifecycle] ?? { label: r.lifecycle }).label}</Pill>
                <span className="text-[#344054]">{r.what}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.deliveries.some((d) => d.status === "failed") && <p className="mt-3 text-sm text-[#b42318]">Some replies could not be delivered: {data.deliveries.filter((d) => d.status === "failed").map((d) => d.error).join("; ")}</p>}
      {advanced && data.turns && (
        <div className="mt-4 border-t border-[#eaecf0] pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-[#667085]">Technical detail</p>
          <ol className="mt-2 space-y-2 text-xs text-[#475467]">
            {data.turns.map((t, i) => (
              <li key={i} className="rounded-md bg-[#f9fafb] p-2">
                <p className="font-medium text-[#344054]">“{t.customerMessage}”</p>
                <p>Understanding: {t.understood}{t.stoppedBecause ? ` · stopped: ${t.stoppedBecause}` : ""}</p>
                {t.actions.length > 0 && <p>Actions: {t.actions.join("; ")}</p>}
                {t.replyFallback && <p>Reply safety: {t.replyFallback}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Section>
  );
}

function ApprovalsView({ ws, act, busyId }: { ws: OwnerWorkspace; act: Act; busyId: string | null }) {
  const pending = ws.interventions.filter((i) => i.kind === "approval" || i.kind === "held_approval");
  const history = ws.approvals.filter((a) => !(a.actionable || a.lifecycle === "held"));
  return (
    <div className="flex flex-col gap-4">
      <Section title="Waiting for you" subtitle="Exact terms, your rule behind each request, and what BARRY does once you decide. Everything the customer said since is re-checked before anything runs.">
        <InterventionQueue items={pending} busyId={busyId} onAct={act} />
      </Section>
      <Section title="History">
        {history.length === 0 ? (
          <Empty>No past requests.</Empty>
        ) : (
          <ul className="divide-y divide-[#eaecf0]">
            {history.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={(LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved).tone}>{(LIFECYCLE[a.lifecycle] ?? { label: a.lifecycle }).label}</Pill>
                    <span className="font-medium">{a.customer}</span>
                  </div>
                  <p className="mt-1 text-sm text-[#475467]">{a.what}</p>
                  <p className="text-xs text-[#667085]">{(LIFECYCLE[a.lifecycle] ?? { explain: "" }).explain}{a.resultReference ? ` Result: ${a.resultReference}.` : ""}</p>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-[#475467]">Exact terms</summary>
                    <Terms a={a} />
                  </details>
                </div>
                <span className="shrink-0 text-xs text-[#667085]">{timeAgo(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function OutcomesView({ ws }: { ws: OwnerWorkspace }) {
  const [kind, setKind] = useState<"all" | OutcomeEvent["kind"]>("all");
  const events = ws.outcomes.filter((e) => kind === "all" || e.kind === kind);
  return (
    <Section
      title="Outcomes"
      subtitle={`Everything BARRY achieved or couldn't — ${ws.window.label}. Each line shows the record that proves it.`}
      right={
        <select aria-label="Outcome type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="rounded-lg border border-[#d0d5dd] bg-white px-2 py-1 text-sm">
          <option value="all">All outcomes</option>
          {Object.entries(OUTCOME).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      }
    >
      <OutcomeList events={events} ws={ws} />
    </Section>
  );
}

const SYSTEM_STATE: Record<string, { tone: Tone; label: string }> = {
  healthy: { tone: "good", label: "Connected" },
  simulated: { tone: "warn", label: "Simulated" },
  degraded: { tone: "warn", label: "Needs attention" },
  disconnected: { tone: "bad", label: "Disconnected" },
  not_configured: { tone: "neutral", label: "Not set up" },
};
const AI_STATE: Record<string, { tone: Tone; label: string }> = {
  healthy: { tone: "good", label: "Working" },
  degraded: { tone: "warn", label: "Degraded" },
  unavailable: { tone: "bad", label: "Unavailable" },
  not_configured: { tone: "neutral", label: "Simulator" },
  no_traffic: { tone: "neutral", label: "No recent traffic" },
};

function HealthView({ ws, api, reload }: { ws: OwnerWorkspace; api: Api; reload: () => Promise<void> }) {
  const ai = ws.health.ai;
  const [busy, setBusy] = useState<string | null>(null);
  const resolve = async (conversationId: string, handoffId: string, action: "acknowledge" | "resolve") => {
    setBusy(handoffId);
    try {
      await api.call("/api/owner/handoffs", { body: { businessId: api.businessId, conversationId, handoffId, action } });
      await reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="AI" right={<Pill tone={AI_STATE[ai.status].tone}>{AI_STATE[ai.status].label}</Pill>}>
        <p className="text-sm text-[#344054]">{ai.summary}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-[#667085]">Messages (24h)</dt>
          <dd className="tabular-nums">{ai.turnsSampled}</dd>
          <dt className="text-[#667085]">Not understood</dt>
          <dd className="tabular-nums">{ai.understandingFailures}</dd>
          <dt className="text-[#667085]">Reply fallbacks</dt>
          <dd className="tabular-nums">{ai.composerFailures}</dd>
          {ai.model && (
            <>
              <dt className="text-[#667085]">Model</dt>
              <dd>{ai.model}</dd>
            </>
          )}
        </dl>
        {ai.lastFailure && (
          <p className="mt-3 rounded-lg bg-[#f9fafb] px-3 py-2 text-xs text-[#475467]">
            Last failure {timeAgo(ai.lastFailure.at)}: {ai.lastFailure.kind.replace(/_/g, " ")}
            {ai.lastFailure.status ? ` · HTTP ${ai.lastFailure.status}` : ""}
            {ai.lastFailure.code ? ` · ${ai.lastFailure.code}` : ""}
          </p>
        )}
      </Section>
      <Section title="What BARRY can do for you" subtitle="Derived from your goals, connected systems and rules — the full view is in Train BARRY." right={<Link href="/owner/train" className={btn}>Train BARRY</Link>}>
        {ws.capabilities.now.length + ws.capabilities.nowSimulated.length + ws.capabilities.afterSetup.length === 0 ? (
          <Empty>Couldn&apos;t assess capabilities.</Empty>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {ws.capabilities.now.length > 0 && (
              <p>
                <Pill tone="good">Ready</Pill> <span className="text-[#344054]">{ws.capabilities.now.join(" · ")}</span>
              </p>
            )}
            {ws.capabilities.nowSimulated.length > 0 && (
              <p>
                <Pill tone="warn">Simulator only</Pill> <span className="text-[#344054]">{ws.capabilities.nowSimulated.join(" · ")}</span>
              </p>
            )}
            {ws.capabilities.steps.length > 0 && (
              <ul className="mt-1 space-y-1">
                {ws.capabilities.steps.map((s) => (
                  <li key={s.id} className="text-[#475467]">
                    <span className="font-medium text-[#101828]">{s.title}</span> ({s.who === "you" ? "you" : "BARRY team"}) → {s.unlocks.join(", ")}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>
      <Section title="Connected systems">
        {ws.health.systems.length === 0 ? (
          <Empty>No systems.</Empty>
        ) : (
          <ul className="divide-y divide-[#eaecf0]">
            {ws.health.systems.map((s) => (
              <li key={s.domain} className="py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{s.domain}</span>
                  <Pill tone={SYSTEM_STATE[s.state].tone}>{SYSTEM_STATE[s.state].label}</Pill>
                </div>
                <p className="text-xs text-[#667085]">
                  {s.provider ?? "No provider"}
                  {s.lastVerifiedAt ? ` · verified ${timeAgo(s.lastVerifiedAt)}` : ""}
                </p>
                {s.blockers.length > 0 && <p className="text-xs text-[#b54708]">{s.blockers.join("; ")}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div className="lg:col-span-2">
        <Section title="Handoffs to your team" subtitle="Customers BARRY passed to a person, with the context they need.">
          {ws.handoffs.length === 0 ? (
            <Empty>No handoffs.</Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {ws.handoffs.map((h) => (
                <li key={h.id} className="rounded-xl border border-[#e4e7ec] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={h.status === "resolved" ? "neutral" : h.urgency === "urgent" ? "bad" : "info"}>{h.status === "resolved" ? "RESOLVED" : h.status === "acknowledged" ? "ACKNOWLEDGED" : h.urgency === "urgent" ? "OPEN · URGENT" : "OPEN"}</Pill>
                      <span className="font-medium">{h.customer}</span>
                    </div>
                    <span className="text-xs text-[#667085]">{timeAgo(h.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-[#344054]">{h.summary}</p>
                  {h.unresolved.length > 0 && <p className="mt-1 text-sm text-[#475467]">Still open: {h.unresolved.join("; ")}</p>}
                  {h.transaction.length > 0 && <p className="mt-1 text-xs text-[#667085]">{h.transaction.join(" · ")}</p>}
                  <p className="mt-1 text-xs text-[#667085]">{h.responseCommitted ? "BARRY told the customer your team follows up as your playbook says." : "BARRY told the customer your team can see this, without promising a reply time."} BARRY can&apos;t send your reply for you yet — answer the customer in your own channel.</p>
                  {h.status !== "resolved" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {h.status === "open" && (
                        <button className={btn} disabled={busy === h.id} onClick={() => void resolve(h.conversationId, h.id, "acknowledge")}>
                          Acknowledge
                        </button>
                      )}
                      <button className={btn} disabled={busy === h.id} onClick={() => void resolve(h.conversationId, h.id, "resolve")}>
                        Mark resolved
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

const SUGGESTIONS = ["What happened today?", "How much did we actually collect?", "Who needs me?", "What failed?", "Which opportunities did we lose?", "Give everyone 20% off."];

function AskView({ api }: { api: Api }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ q: string; a: string; note?: string; source: string }[]>([]);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    try {
      const res = await api.call<{ answer: string; source: string; note?: string }>("/api/owner/ask", { body: { businessId: api.businessId, question } });
      setHistory((h) => [{ q: question, a: res.answer, note: res.note, source: res.source }, ...h]);
      setQ("");
    } catch (e) {
      setHistory((h) => [{ q: question, a: e instanceof Error ? e.message : "Something went wrong", source: "error" }, ...h]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Ask BARRY about your business" subtitle="Answers come only from your business's records. BARRY can't change anything from here.">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. How did you make me money this week?" className="flex-1 rounded-lg border border-[#d0d5dd] px-3 py-2 text-sm" maxLength={1000} />
        <button className={primary} disabled={busy || !q.trim()}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="rounded-full border border-[#e4e7ec] px-2.5 py-1 text-xs text-[#475467] hover:bg-[#f9fafb]" onClick={() => void ask(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <ul className="mt-4 flex flex-col gap-3">
        {history.map((h, i) => (
          <li key={i} className="rounded-xl bg-[#f9fafb] p-3">
            <p className="text-sm font-medium">{h.q}</p>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-[#344054]">{h.a}</p>
            {h.note && <p className="mt-1.5 text-xs text-[#667085]">{h.note}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
