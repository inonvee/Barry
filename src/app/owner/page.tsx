"use client";

import { useCallback, useEffect, useState } from "react";
import { OwnerBar, useOwnerApi } from "@/components/owner/useOwnerApi";
import { Empty, OwnerNav, Pill, Section, Stat, btn, card, danger, formatMoney, primary, timeAgo, type Tone } from "@/components/owner/ui";
import type { OwnerWorkspace, OwnerConversationRow, OwnerApproval, AttentionReason } from "@/lib/owner/service";
import type { OutcomeEvent } from "@/lib/owner/revenue";

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

const LIFECYCLE: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "warn", label: "Waiting for you" },
  held: { tone: "bad", label: "Held — needs revalidation" },
  executed: { tone: "good", label: "Done" },
  executed_unconfirmed: { tone: "warn", label: "Submitted, not confirmed" },
  failed: { tone: "bad", label: "Approved, didn't go through" },
  declined: { tone: "neutral", label: "You declined" },
  withdrawn: { tone: "neutral", label: "Customer withdrew" },
  superseded: { tone: "neutral", label: "Replaced by a newer request" },
  approved: { tone: "info", label: "Approved" },
};

const CHANNEL: Record<OwnerConversationRow["channel"], string> = { whatsapp: "WhatsApp", web: "Web chat", instagram: "Instagram", simulator: "Simulator" };

export default function OwnerDashboard() {
  const api = useOwnerApi();
  const [tab, setTab] = useState<Tab>("today");
  const [range, setRange] = useState<"today" | "7d" | "30d">("today");
  const [ws, setWs] = useState<OwnerWorkspace | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const { businessId, call } = api;
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
    if (!businessId) return;
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
  }, [businessId, fetchWorkspace]);

  const needs = ws?.conversations.filter((c) => c.status === "needs_you") ?? [];
  const pendingApprovals = ws?.approvals.filter((a) => a.actionable || a.lifecycle === "held") ?? [];

  return (
    <main className="min-h-screen bg-[#f9fafb] text-[#101828]">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 md:py-10">
        <OwnerNav active="dashboard" />
        <OwnerBar api={api} title={ws ? ws.business.name : "Your business"} subtitle="What BARRY did for your business, what needs you, and how it's performing." />

        {error && <p className="rounded-lg border border-[#fecdca] bg-[#fef3f2] px-4 py-3 text-sm text-[#b42318]">{error}</p>}
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

        {!ws && !error && <p className="text-sm text-[#667085]">{loading ? "Loading your business…" : "Choose a business."}</p>}
        {ws && tab === "today" && <TodayView ws={ws} onOpen={() => setTab("inbox")} onApprovals={() => setTab("approvals")} />}
        {ws && tab === "inbox" && <InboxView ws={ws} api={api} />}
        {ws && tab === "approvals" && <ApprovalsView ws={ws} api={api} reload={load} />}
        {ws && tab === "outcomes" && <OutcomesView ws={ws} />}
        {ws && tab === "health" && <HealthView ws={ws} api={api} reload={load} />}
        {ws && tab === "ask" && <AskView api={api} />}
      </div>
    </main>
  );
}

type Api = ReturnType<typeof useOwnerApi>;

function TodayView({ ws, onOpen, onApprovals }: { ws: OwnerWorkspace; onOpen: () => void; onApprovals: () => void }) {
  const r = ws.revenue;
  const t = ws.today;
  const interventionRate = r.activeConversations ? Math.round((r.ownerInterventions / r.activeConversations) * 100) : null;
  return (
    <div className="flex flex-col gap-5">
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

      <Section title="Needs you" right={<button className={btn} onClick={onOpen}>Open inbox</button>}>
        {ws.conversations.filter((c) => c.status === "needs_you").length === 0 ? (
          <Empty>Nothing needs you right now.</Empty>
        ) : (
          <ul className="divide-y divide-[#eaecf0]">
            {ws.conversations
              .filter((c) => c.status === "needs_you")
              .slice(0, 6)
              .map((c) => (
                <li key={c.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">{c.customer}</p>
                    <p className="text-sm text-[#475467]">{c.attention.map((a) => ATTENTION[a]).join(" · ")}</p>
                  </div>
                  {c.attention.some((a) => a === "approval_waiting" || a === "approval_held") && (
                    <button className={btn} onClick={onApprovals}>
                      Review request
                    </button>
                  )}
                </li>
              ))}
          </ul>
        )}
      </Section>

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
  turns?: { at: string; customerMessage: string; understood: string; actions: string[]; stoppedBecause: string | null; replyFallback: string | null }[];
};

function InboxView({ ws, api }: { ws: OwnerWorkspace; api: Api }) {
  const [filter, setFilter] = useState<"all" | "needs_you">("all");
  const [open, setOpen] = useState<string | null>(null);
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
      {data.handoffs.filter((h) => h.status === "open").map((h) => (
        <div key={h.id} className="mb-3 rounded-lg border border-[#b2ddff] bg-[#eff8ff] p-3 text-sm text-[#175cd3]">
          <p className="font-semibold">Needs a person{h.urgency === "urgent" ? " — urgent" : ""}</p>
          <p className="mt-0.5">{h.summary}</p>
          {h.unresolved.length > 0 && <p className="mt-1">Still open: {h.unresolved.join("; ")}</p>}
          {!h.responseCommitted && <p className="mt-1 text-xs">BARRY told the customer the team can see this but didn&apos;t promise a reply time.</p>}
        </div>
      ))}
      {data.transaction.length > 0 && (
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

function ApprovalsView({ ws, api, reload }: { ws: OwnerWorkspace; api: Api; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const act = async (a: OwnerApproval, action: "approve" | "decline" | "recheck") => {
    setBusy(a.id);
    setNotice("");
    try {
      const res = await api.call<{ message?: string; held?: { reason: string } | null; recheck?: { revalidated: number; stillUnresolved: number; changedRequests: number } }>("/api/owner/approvals", { body: { businessId: api.businessId, approvalId: a.id, action } });
      if (res.recheck) setNotice(res.recheck.revalidated === 0 ? "BARRY still can't read the customer's later message — the request stays held." : res.recheck.changedRequests > 0 ? "The customer's later message changed this request — it was cancelled and won't run." : "Re-checked: the customer's later message didn't change this request. You can decide it now.");
      else if (res.held) setNotice(`Not carried out: ${res.held.reason}. The customer was asked to confirm.`);
      else setNotice(action === "approve" ? "Approved — BARRY carried it out and told the customer." : "Declined — BARRY told the customer.");
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };
  const pending = ws.approvals.filter((a) => a.actionable || a.lifecycle === "held");
  const history = ws.approvals.filter((a) => !(a.actionable || a.lifecycle === "held"));
  return (
    <div className="flex flex-col gap-4">
      {notice && <p className="rounded-lg border border-[#e4e7ec] bg-white px-4 py-3 text-sm" role="status">{notice}</p>}
      <Section title="Waiting for you" subtitle="BARRY re-checks everything the customer said since the request before anything runs.">
        {pending.length === 0 ? (
          <Empty>No requests are waiting for you.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((a) => (
              <li key={a.id} className={`rounded-xl border p-4 ${a.lifecycle === "held" ? "border-[#fecdca] bg-[#fffbfa]" : "border-[#fedf89] bg-[#fffcf5]"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={LIFECYCLE[a.lifecycle].tone}>{LIFECYCLE[a.lifecycle].label}</Pill>
                    <span className="font-medium">{a.customer}</span>
                    {a.revision > 1 && <span className="text-xs text-[#667085]">revision {a.revision}</span>}
                  </div>
                  <span className="text-xs text-[#667085]">{timeAgo(a.createdAt)}</span>
                </div>
                <p className="mt-2 text-[15px] text-[#101828]">{a.what}</p>
                {a.amount && <p className="mt-1 text-lg font-semibold tabular-nums">{a.amount}</p>}
                <p className="mt-1 text-sm text-[#475467]">Why you&apos;re asked: {a.whyApproval}</p>
                {a.newerContext && <p className="mt-2 rounded-lg bg-[#fef3f2] px-3 py-2 text-sm text-[#b42318]">{a.newerContext}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {a.actionable && (
                    <button className={primary} disabled={busy === a.id} onClick={() => void act(a, "approve")}>
                      Approve
                    </button>
                  )}
                  {a.lifecycle === "held" && (
                    <button className={btn} disabled={busy === a.id} onClick={() => void act(a, "recheck")}>
                      Re-check conversation
                    </button>
                  )}
                  <button className={danger} disabled={busy === a.id} onClick={() => void act(a, "decline")}>
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
                </div>
                <span className="text-xs text-[#667085]">{timeAgo(a.createdAt)}</span>
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
  const resolve = async (conversationId: string, handoffId: string) => {
    setBusy(handoffId);
    try {
      await api.call("/api/owner/handoffs", { body: { businessId: api.businessId, conversationId, handoffId } });
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
                      <Pill tone={h.status === "open" ? (h.urgency === "urgent" ? "bad" : "info") : "neutral"}>{h.status === "open" ? (h.urgency === "urgent" ? "Urgent" : "Open") : "Resolved"}</Pill>
                      <span className="font-medium">{h.customer}</span>
                    </div>
                    <span className="text-xs text-[#667085]">{timeAgo(h.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-[#344054]">{h.summary}</p>
                  {h.unresolved.length > 0 && <p className="mt-1 text-sm text-[#475467]">Still open: {h.unresolved.join("; ")}</p>}
                  {h.transaction.length > 0 && <p className="mt-1 text-xs text-[#667085]">{h.transaction.join(" · ")}</p>}
                  {h.status === "open" && (
                    <button className={`${btn} mt-2`} disabled={busy === h.id} onClick={() => void resolve(h.conversationId, h.id)}>
                      Mark resolved
                    </button>
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

const SUGGESTIONS = ["What happened today?", "Who needs me?", "How much did you collect this week?", "Which opportunities did we lose?", "Why did a request fail?"];

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
