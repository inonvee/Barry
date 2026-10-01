"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell, type OwnerSection } from "@/components/owner/OwnerShell";
import { Empty, MoneyFigures, Pill, Section, Skeleton, StateNotice, btn, formatMoney, primary, quiet, timeAgo, type Tone } from "@/components/owner/ui";
import { ownerPresence } from "@/lib/owner/presence-model";
import { financialImpact } from "@/lib/finance/impact";
import { formatLocal } from "@/lib/format/time";
import type { CommandResult } from "@/components/ds/CommandBar";
import { InterventionCard, InterventionQueue, MoneyInMotion, OpportunityRow, StoryView, type Act, NextExpectedAction, WatchingList } from "@/components/owner/operating";
import { isOpen } from "@/lib/operator/obligation-model";
import type { OwnerWorkspace, OwnerConversationRow, OwnerApproval } from "@/lib/owner/service";
import type { OutcomeEvent } from "@/lib/owner/revenue";
import type { Intervention, InterventionAction } from "@/lib/owner/interventions";
import type { ConversationStory } from "@/lib/owner/story";
import type { OwnerAnswerLinks } from "@/lib/owner/ask";

/**
 * THE OWNER PRODUCT — Today (what needs you, money in motion, what BARRY handled), Inbox (understand a
 * conversation without reading every message), Money (where money stands and what to do), Ask BARRY.
 * Everything renders from the owner read model; every action goes through the owner endpoints.
 */

type Tab = "today" | "inbox" | "money" | "ask";
const TABS: Tab[] = ["today", "inbox", "money", "ask"];

const STATUS: Record<OwnerConversationRow["status"], { tone: Tone; label: string }> = {
  needs_you: { tone: "bad", label: "Needs you" },
  in_progress: { tone: "info", label: "In progress" },
  waiting_on_customer: { tone: "neutral", label: "Waiting on customer" },
  completed: { tone: "good", label: "Completed" },
  lost: { tone: "neutral", label: "Lost" },
};

const OUTCOME: Record<OutcomeEvent["kind"], { tone: Tone; label: string }> = {
  paid: { tone: "good", label: "Paid" },
  booked: { tone: "good", label: "Booked" },
  order_created: { tone: "good", label: "Order" },
  case_created: { tone: "info", label: "Case opened" },
  checkout_abandoned: { tone: "warn", label: "Checkout not completed" },
  blocked: { tone: "warn", label: "Stopped" },
  failed: { tone: "bad", label: "Didn't go through" },
  handoff: { tone: "info", label: "Handed to you" },
  declined_by_owner: { tone: "neutral", label: "You declined" },
};

const LIFECYCLE: Record<string, { tone: Tone; label: string; explain: string }> = {
  active: { tone: "warn", label: "Waiting for you", explain: "Waiting for your decision." },
  held: { tone: "bad", label: "Held", explain: "Can't be approved until the conversation is re-checked." },
  executed: { tone: "good", label: "Done", explain: "Approved and carried out; your system confirmed it." },
  executed_unconfirmed: { tone: "warn", label: "Done · unconfirmed", explain: "Submitted, but your system hasn't confirmed it happened." },
  failed: { tone: "bad", label: "Didn't go through", explain: "Approved, but carrying it out didn't work (or the customer's limits stopped it)." },
  declined: { tone: "neutral", label: "Declined", explain: "You declined it." },
  withdrawn: { tone: "neutral", label: "Withdrawn", explain: "The customer withdrew it." },
  superseded: { tone: "neutral", label: "Replaced", explain: "Replaced by a newer request after the customer changed the details." },
  approved: { tone: "info", label: "Approved", explain: "Approved." },
};

const CHANNEL: Record<OwnerConversationRow["channel"], string> = { whatsapp: "WhatsApp", web: "Web chat", instagram: "Instagram", simulator: "Simulator" };

export default function OwnerPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f4f5f7]" />}>
      <OwnerDashboard />
    </Suspense>
  );
}

function OwnerDashboard() {
  const api = useOwnerApi();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = (TABS as string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "today";
  const [range, setRange] = useState<"today" | "7d" | "30d">("today");
  const [loaded, setWs] = useState<OwnerWorkspace | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [openConversation, setOpenConversation] = useState<string | null>(params.get("conversation"));
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const wantBusiness = params.get("business");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);

  const { businessId, call, authorized } = api;
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
        setLoadedAt(new Date());
        setError("");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setWs(null);
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, authorized, fetchWorkspace]);

  // The command bar switches business through the URL (?business=); honour it once, then clean the URL.
  useEffect(() => {
    if (wantBusiness && wantBusiness !== businessId && api.businesses.some((b) => b.id === wantBusiness)) {
      api.setBusinessId(wantBusiness);
      router.replace("/owner?tab=today", { scroll: false });
    }
  }, [wantBusiness, businessId, api, router]);

  const setTab = (t: Tab, conversation?: string | null) => {
    const q = new URLSearchParams();
    q.set("tab", t);
    if (conversation) q.set("conversation", conversation);
    router.replace(`/owner?${q.toString()}`, { scroll: false });
  };
  const goToConversation = (conversationId: string) => {
    setOpenConversation(conversationId);
    setTab("inbox", conversationId);
  };
  const goToIntervention = (id: string) => {
    setTab("today");
    if (typeof document !== "undefined") setTimeout(() => document.querySelector(`[data-intervention="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  };
  const onNavigate = (section: OwnerSection) => {
    if ((TABS as string[]).includes(section)) {
      setTab(section as Tab);
      return true;
    }
    return false;
  };

  // One action handler for every queue item: the owner endpoints re-check everything before an effect.
  const act: Act = async (item: Intervention, action: InterventionAction) => {
    if (action === "open_conversation") return goToConversation(item.conversationId);
    setBusyId(item.id);
    setNotice(null);
    try {
      if (action === "approve" || action === "decline" || action === "recheck") {
        const res = await call<{ message?: string; held?: { reason: string } | null; recheck?: { revalidated: number; changedRequests: number; recovered?: { outcome: string }[] } }>("/api/owner/approvals", { body: { businessId, approvalId: item.refs.approvalId, action } });
        if (res.recheck) {
          const recovered = res.recheck.recovered?.find((r) => r.outcome !== "unrelated");
          setNotice(
            res.recheck.revalidated === 0
              ? { tone: "warn", text: "BARRY still can't read the customer's later message — the request stays held." }
              : recovered?.outcome === "proposed" || recovered?.outcome === "reused"
                ? { tone: "good", text: "The customer's later message changed this request: the old one was replaced and the corrected request is now waiting for you." }
                : res.recheck.changedRequests > 0
                  ? { tone: "neutral", text: "The customer's later message changed this request — it was cancelled and won't run." }
                  : { tone: "good", text: "Re-checked: the customer's later message didn't change this request. You can decide it now." }
          );
        } else if (res.held) setNotice({ tone: "warn", text: `Not carried out: ${res.held.reason}. The customer was asked to confirm.` });
        else setNotice(action === "approve" ? { tone: "good", text: res.message ? `Approved. BARRY told the customer: “${res.message.slice(0, 180)}”` : "Approved — BARRY carried it out and told the customer." } : { tone: "neutral", text: "Declined — BARRY told the customer; nothing was sent or changed." });
      } else {
        await call("/api/owner/handoffs", { body: { businessId, conversationId: item.conversationId, handoffId: item.refs.handoffId, action } });
        setNotice(action === "acknowledge" ? { tone: "neutral", text: "Acknowledged — marked as seen by your team. The customer was not messaged." } : { tone: "good", text: "Resolved — closed in your inbox. BARRY continues the conversation as usual." });
      }
      await load();
    } catch (e) {
      setNotice({ tone: "bad", text: e instanceof Error ? e.message : "Something went wrong" });
    } finally {
      setBusyId(null);
    }
  };

  const queue = ws?.interventions ?? [];
  const badge = { today: queue.length || undefined, inbox: ws?.conversations.filter((c) => c.status === "needs_you").length || undefined };
  const presence = ws ? ownerPresence(ws) : undefined;
  // Command bar: real records of THIS business only (the workspace the owner's session loaded).
  const commands: CommandResult[] = ws
    ? [
        ...ws.conversations.slice(0, 60).map((c) => ({ id: `conversation:${c.id}`, kind: "conversation" as const, title: c.customer, subtitle: STATUS[c.status].label, href: `/owner?tab=inbox&conversation=${encodeURIComponent(c.id)}`, keywords: [c.id] })),
        ...ws.interventions.map((i) => ({ id: `approval:${i.id}`, kind: "approval" as const, title: i.title, subtitle: `${i.customer} · ${i.decision}`, href: "/owner?tab=today", status: "attention" as const })),
        ...ws.opportunities.items.filter((o) => o.kind === "unpaid_link" || o.kind === "payment_failed").map((o) => ({ id: `payment:${o.id}`, kind: "payment" as const, title: `${o.amount !== undefined && o.currency ? formatMoney({ [o.currency]: o.amount }) : "Payment"} — ${o.customer}`, subtitle: o.next.action, href: `/owner?tab=inbox&conversation=${encodeURIComponent(o.conversationId)}` })),
      ]
    : [];

  return (
    <OwnerShell api={api} active={tab} badge={badge} onNavigate={onNavigate} presence={presence} commands={commands}>
      {authorized && error && (
        <div className="mb-4">
          <StateNotice tone="bad" title="BARRY couldn't load your business right now" action={<button className={btn} onClick={() => void load()}>Try again</button>}>
            Nothing is wrong with your business — the page couldn&apos;t read its records. Try again in a moment.
            <details className="mt-1 text-xs text-[#98a2b3]">
              <summary className="cursor-pointer">Technical detail</summary>
              {error}
            </details>
          </StateNotice>
        </div>
      )}
      {ws?.unavailable.length ? (
        <div className="mb-4">
          <StateNotice tone="warn" title="Some records couldn't be read">
            {ws.unavailable.join(", ")} — the figures below leave them out rather than guess.
          </StateNotice>
        </div>
      ) : null}
      {notice && (
        <div className="mb-4">
          <StateNotice tone={notice.tone} title={notice.text} action={<button className={quiet} onClick={() => setNotice(null)}>Dismiss</button>} />
        </div>
      )}
      {authorized && !ws && !error && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-white p-5">
            <Skeleton lines={4} />
          </div>
          <div className="rounded-2xl bg-white p-5">
            <Skeleton lines={3} />
          </div>
        </div>
      )}
      {!authorized && api.session && <p className="mt-2 text-sm text-[#667085]">Once you&apos;re signed in, this page shows what needs you, where money stands and what BARRY handled.</p>}
      {ws && tab === "today" && <TodayView ws={ws} act={act} busyId={busyId} loading={loading} onOpen={goToConversation} onIntervention={goToIntervention} onTab={setTab} />}
      {ws && tab === "inbox" && <InboxView ws={ws} api={api} act={act} busyId={busyId} open={openConversation} setOpen={goToConversation} onIntervention={goToIntervention} loadedAt={loadedAt} />}
      {ws && tab === "money" && <MoneyView ws={ws} range={range} setRange={setRange} onOpen={goToConversation} onIntervention={goToIntervention} loadedAt={loadedAt} />}
      {ws && tab === "ask" && <AskView api={api} onIntervention={goToIntervention} onOpen={goToConversation} initialQuestion={params.get("q") ?? ""} />}
    </OwnerShell>
  );
}

type Api = ReturnType<typeof useOwnerApi>;

// ── Today ────────────────────────────────────────────────────────────────

function TodayView({ ws, act, busyId, loading, onOpen, onIntervention, onTab }: { ws: OwnerWorkspace; act: Act; busyId: string | null; loading: boolean; onOpen: (id: string) => void; onIntervention: (id: string) => void; onTab: (t: Tab) => void }) {
  const [showAll, setShowAll] = useState(false);
  const queue = ws.interventions;
  const t = ws.today;
  const ai = ws.health.ai;
  const handled = ws.outcomes.filter((o) => o.kind === "paid" || o.kind === "booked" || o.kind === "order_created" || o.kind === "case_created");
  const setupSteps = ws.capabilities.steps.filter((s) => s.gate !== "customer_traffic").slice(0, 2);
  // Approvals, held requests and handoffs already have their cards above: here BARRY shows the rest it is watching.
  const watching = ws.obligations.filter((o) => isOpen(o) && !["approval_blocking_transaction", "held_request_recheck", "unresolved_handoff"].includes(o.kind));
  const due = watching.filter((o) => o.status === "actionable");
  // The proactive operator's four buckets, from the same obligations: handling / waiting on customer / needs you / blocked.
  const openObligations = ws.obligations.filter(isOpen);
  const groups = {
    handling: openObligations.filter((o) => o.nextMove === "barry_can_act" || o.nextMove === "scheduled_for_later").length,
    waiting: openObligations.filter((o) => o.nextMove === "waiting_on_customer").length,
    needsYou: queue.length,
    blocked: openObligations.filter((o) => o.nextMove === "blocked_by_capability").length,
  };
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#667085]">{greeting} · {ws.business.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">
          {queue.length === 0 ? "Nothing needs you right now" : `${queue.length} thing${queue.length === 1 ? "" : "s"} need${queue.length === 1 ? "s" : ""} you`}
        </h1>
        <p className="mt-1 text-sm text-[#667085]">
          {t.conversations} conversation{t.conversations === 1 ? "" : "s"} {ws.window.label}, {t.handledAutonomously} handled without you
          {loading ? " · refreshing…" : ""}
        </p>
      </div>

      {(ai.status === "unavailable" || ai.status === "degraded") && (
        <StateNotice tone={ai.status === "unavailable" ? "bad" : "warn"} title={ai.status === "unavailable" ? "BARRY can't understand customers right now" : "BARRY had trouble understanding some messages"}>
          {ai.summary}
        </StateNotice>
      )}

      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-[#475467]" data-queue-groups>
        <span>BARRY is handling <span className="font-semibold tabular-nums text-[#101828]">{groups.handling}</span></span>
        <span>Waiting on customers <span className="font-semibold tabular-nums text-[#101828]">{groups.waiting}</span></span>
        <span>Needs you <span className={`font-semibold tabular-nums ${groups.needsYou ? "text-[#b42318]" : "text-[#101828]"}`}>{groups.needsYou}</span></span>
        <span>Blocked <span className={`font-semibold tabular-nums ${groups.blocked ? "text-[#b42318]" : "text-[#101828]"}`}>{groups.blocked}</span></span>
      </p>

      <Section title="Needs you" subtitle={queue.length ? "In priority order. Each card says why BARRY stopped, what it already did, what you decide and what happens next." : undefined} plain>
        <InterventionQueue items={queue} busyId={busyId} onAct={act} limit={showAll ? undefined : 4} />
        {queue.length > 4 && !showAll && (
          <button className={`${btn} mt-3 w-full sm:w-auto`} onClick={() => setShowAll(true)}>
            Show all {queue.length}
          </button>
        )}
      </Section>

      <Section title="BARRY is watching" subtitle={watching.length ? `${watching.length} thing${watching.length === 1 ? "" : "s"} BARRY keeps track of until the records show it's done${due.length ? ` · ${due.length} due now` : ""}.` : undefined}>
        <WatchingList items={watching} onOpen={onOpen} limit={4} />
        {watching.length > 4 && <p className="mt-2 text-[12px] text-[#667085]">+{watching.length - 4} more — each conversation shows its next expected action.</p>}
      </Section>

      <Section title="Money in motion" subtitle="Where money is stuck, at risk or waiting — never counted as revenue." right={<button className={quiet} onClick={() => onTab("money")}>All money ›</button>}>
        <MoneyInMotion items={ws.opportunities.items} summary={ws.opportunities.summary} onOpen={onOpen} onIntervention={onIntervention} limit={3} />
        {ws.opportunities.items.length > 3 && (
          <button className={`${btn} mt-3 w-full sm:w-auto`} onClick={() => onTab("money")}>
            See all {ws.opportunities.items.length}
          </button>
        )}
      </Section>

      <Section
        title="What BARRY handled"
        subtitle={`${t.conversations} conversation${t.conversations === 1 ? "" : "s"} ${ws.window.label} · ${t.handledAutonomously} handled without you${t.conversations ? ` (${Math.round((t.handledAutonomously / t.conversations) * 100)}%)` : ""} · ${t.completedOutcomes} completed${t.blockedOrFailed ? ` · ${t.blockedOrFailed} stopped or failed` : ""}`}
        right={<button className={quiet} onClick={() => onTab("inbox")}>Inbox ›</button>}
      >
        <div>
          <OutcomeList events={handled.length ? handled.slice(0, 5) : ws.outcomes.slice(0, 5)} ws={ws} onOpen={onOpen} empty="Nothing completed yet in this period. Payments, bookings, orders and cases BARRY completes will show here with the record that proves each one." />
        </div>
      </Section>

      {setupSteps.length > 0 && (
        <Section title="Next to unlock" subtitle="What BARRY could do for you once it's set up." right={<Link href="/owner/train" className={quiet}>Train BARRY ›</Link>}>
          <ul className="space-y-2">
            {setupSteps.map((s) => (
              <li key={s.id} className="flex flex-col gap-0.5 rounded-xl bg-[#f9fafb] px-3 py-2.5 text-sm">
                <span className="font-medium text-[#101828]">
                  {s.title} <span className="font-normal text-[#98a2b3]">· {s.who === "you" ? "you" : "BARRY team"}</span>
                </span>
                <span className="text-[13px] text-[#475467]">Then BARRY can: {s.unlocks.join(", ")}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function OutcomeList({ events, ws, onOpen, empty }: { events: OutcomeEvent[]; ws: OwnerWorkspace; onOpen: (id: string) => void; empty: string }) {
  if (events.length === 0) return <Empty>{empty}</Empty>;
  const customer = (id: string) => ws.conversations.find((c) => c.id === id)?.customer ?? "Customer";
  return (
    <ul className="divide-y divide-[#f2f4f7]">
      {events.map((e, i) => (
        <li key={`${e.conversationId}-${e.at}-${i}`} className="flex items-center justify-between gap-3 py-2.5">
          <button className="min-w-0 text-left" onClick={() => onOpen(e.conversationId)}>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={OUTCOME[e.kind].tone}>{OUTCOME[e.kind].label}</Pill>
              {e.simulated && (
                <Pill tone="neutral" icon={false}>
                  test
                </Pill>
              )}
              <span className="text-[14px] font-medium">{customer(e.conversationId)}</span>
            </div>
            <p className="mt-0.5 text-[13px] text-[#475467]">
              {e.label}
              {e.reference ? ` · ${e.reference}` : ""} <span className="text-[#98a2b3]">· {e.evidence}</span>
            </p>
          </button>
          <div className="shrink-0 text-right">
            {e.amount !== undefined && e.currency && <p className="text-[14px] font-semibold tabular-nums">{formatMoney({ [e.currency]: e.amount })}</p>}
            <p className="text-[12px] text-[#98a2b3]">{timeAgo(e.at)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Inbox ────────────────────────────────────────────────────────────────

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

type Filter = "all" | "needs_you" | "waiting_on_customer" | "completed";

function InboxView({ ws, api, act, busyId, open, setOpen, onIntervention, loadedAt }: { ws: OwnerWorkspace; api: Api; act: Act; busyId: string | null; open: string | null; setOpen: (id: string) => void; onIntervention: (id: string) => void; loadedAt: Date | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = ws.conversations.filter((c) => filter === "all" || c.status === filter);
  const counts = { needs_you: ws.conversations.filter((c) => c.status === "needs_you").length, waiting_on_customer: ws.conversations.filter((c) => c.status === "waiting_on_customer").length, completed: ws.conversations.filter((c) => c.status === "completed").length };
  const showList = !open;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
      <div className={`${showList ? "" : "hidden lg:block"}`}>
        <Section title="Inbox" subtitle={`${ws.conversations.length} conversation${ws.conversations.length === 1 ? "" : "s"}`}>
          <div className="-mx-1 mb-2 flex gap-1 overflow-x-auto pb-1">
            {(
              [
                ["all", "All"],
                ["needs_you", `Needs you${counts.needs_you ? ` · ${counts.needs_you}` : ""}`],
                ["waiting_on_customer", `Waiting on customer${counts.waiting_on_customer ? ` · ${counts.waiting_on_customer}` : ""}`],
                ["completed", `Completed${counts.completed ? ` · ${counts.completed}` : ""}`],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium ${filter === id ? "bg-[#1d2939] text-white" : "bg-[#f2f4f7] text-[#475467]"}`}>
                {label}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <Empty title={ws.conversations.length === 0 ? "No conversations yet" : "Nothing here"}>{ws.conversations.length === 0 ? "Once customers write to BARRY, every conversation appears here with its status and what BARRY did." : "No conversation matches this filter."}</Empty>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {rows.map((c) => (
                <li key={c.id}>
                  <button onClick={() => setOpen(c.id)} className={`w-full rounded-xl px-2 py-3 text-left hover:bg-[#f9fafb] ${open === c.id ? "bg-[#f2f4f7]" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[14px] font-semibold">{c.customer}</span>
                      <span className="shrink-0 text-[12px] text-[#98a2b3]">{timeAgo(c.lastActivityAt)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Pill tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill>
                      <span className="text-[12px] text-[#98a2b3]">{CHANNEL[c.channel]}</span>
                      {c.outcomes.slice(0, 2).map((o) => (
                        <Pill key={o} tone={OUTCOME[o].tone} icon={false}>
                          {OUTCOME[o].label}
                        </Pill>
                      ))}
                    </div>
                    {c.lastMessage && (
                      <p className="mt-1 truncate text-[13px] text-[#475467]">
                        {c.lastMessage.from === "barry" ? "BARRY: " : ""}
                        {c.lastMessage.text}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <div className={showList ? "hidden lg:block" : ""}>
        {open ? (
          <ConversationPanel key={open} id={open} api={api} ws={ws} act={act} busyId={busyId} onBack={() => setOpen("")} onIntervention={onIntervention} loadedAt={loadedAt} />
        ) : (
          <div className="hidden rounded-2xl bg-white p-5 lg:block">
            <Empty title="Pick a conversation">You&apos;ll see what the customer wants, what BARRY did, what&apos;s waiting, and the money involved — before the messages.</Empty>
          </div>
        )}
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
  const items = ws.interventions.filter((i) => i.conversationId === id);
  const money = ws.opportunities.items.filter((o) => o.conversationId === id);
  const nextAction = <NextExpectedAction items={ws.obligations} conversationId={id} />;
  const back = (
    <button className={`${quiet} -ml-2 lg:hidden`} onClick={onBack}>
      ‹ Inbox
    </button>
  );
  if (error)
    return (
      <Section title="Conversation" right={back}>
        <StateNotice tone="bad" title="Couldn't load this conversation">{error}</StateNotice>
      </Section>
    );
  if (!data)
    return (
      <Section title={row?.customer ?? "Conversation"} right={back}>
        <Skeleton lines={5} />
      </Section>
    );
  const lastAsk = [...data.story?.steps ?? []].reverse().find((s) => !s.customer.startsWith("("))?.customer;
  const decided = data.requests.filter((r) => r.lifecycle !== "active" && r.lifecycle !== "held");
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl bg-white p-4 md:p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {back}
            <h2 className="text-xl font-semibold tracking-tight">{data.customer}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {row && <Pill tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Pill>}
              <span className="text-[12px] text-[#98a2b3]">{CHANNEL[data.channel as OwnerConversationRow["channel"]] ?? data.channel}</span>
              {row && <span className="text-[12px] text-[#98a2b3]">· last activity {loadedAt ? formatLocal(row.lastActivityAt, ws.business.timezone, loadedAt) : timeAgo(row.lastActivityAt)}</span>}
            </div>
          </div>
        </div>
        <dl className="mt-4 space-y-3">
          {lastAsk && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3]">What they want</dt>
              <dd className="mt-0.5 text-[14px] text-[#101828]">{lastAsk}</dd>
            </div>
          )}
          {data.transaction.length > 0 && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3]">Where things stand</dt>
              <dd className="mt-0.5 flex flex-wrap gap-1.5">
                {data.transaction.map((t) => (
                  <span key={t} className="rounded-full bg-[#f2f4f7] px-2.5 py-0.5 text-[12px] text-[#344054]">
                    {t}
                  </span>
                ))}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3]">Waiting on</dt>
            <dd className="mt-0.5 text-[14px] text-[#344054]">
              {items.length ? `You — ${items.map((i) => KINDWORD[i.kind]).join(", ")}` : row?.status === "waiting_on_customer" ? "The customer — BARRY asked and is waiting for a reply." : row?.status === "completed" ? "Nobody — this one is done." : "Nobody — BARRY is handling it."}
            </dd>
          </div>
        </dl>
      </section>

      {nextAction}

      {items.length > 0 && (
        <Section title="Needs you here" plain>
          <ul className="flex flex-col gap-3">
            {items.map((i) => (
              <InterventionCard key={i.id} item={i} busy={busyId === i.id} onAct={act} />
            ))}
          </ul>
        </Section>
      )}

      {money.length > 0 && (
        <Section title="Money in this conversation">
          <ul className="divide-y divide-[#f2f4f7]">
            {money.map((o) => (
              <OpportunityRow key={o.id} o={o} onOpen={() => undefined} onIntervention={onIntervention} inConversation />
            ))}
          </ul>
        </Section>
      )}

      {data.story && data.story.steps.length > 0 && (
        <Section title="What happened" subtitle="What the customer asked, what BARRY did, and what became of it — from BARRY's records." right={data.story.steps.length > 4 ? <button className={quiet} onClick={() => setFullStory((v) => !v)}>{fullStory ? "Latest only" : `All ${data.story.steps.length} steps`}</button> : undefined}>
          <StoryView story={data.story} compact={!fullStory} />
        </Section>
      )}

      {decided.length > 0 && (
        <Section title="Requests to you">
          <ul className="space-y-1.5 text-[13px]">
            {decided.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Pill tone={(LIFECYCLE[r.lifecycle] ?? LIFECYCLE.approved).tone}>{(LIFECYCLE[r.lifecycle] ?? { label: r.lifecycle }).label}</Pill>
                <span className="text-[#344054]">{r.what}</span>
                <span className="text-[#98a2b3]">{timeAgo(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.deliveries.some((d) => d.status === "failed") && <StateNotice tone="bad" title="Some replies couldn't be delivered">{data.deliveries.filter((d) => d.status === "failed").map((d) => d.error).join("; ")}</StateNotice>}

      <Section title={`Conversation · ${data.messages.length} message${data.messages.length === 1 ? "" : "s"}`} right={<button className={quiet} onClick={() => setShowMessages((v) => !v)}>{showMessages ? "Hide" : "Show"}</button>}>
        {showMessages ? (
          <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto pr-1">
            {data.messages.map((m, i) => (
              <div key={i} className={`max-w-[88%] rounded-2xl px-3 py-2 text-[14px] ${m.from === "customer" ? "self-start bg-[#f2f4f7]" : m.from === "barry" ? "self-end bg-[#1d2939] text-white" : "self-center bg-[#fffaeb] text-xs text-[#b54708]"}`}>
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                <p className={`mt-1 text-[10px] ${m.from === "barry" ? "text-[#d0d5dd]" : "text-[#98a2b3]"}`}>{new Date(m.at).toLocaleString()}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-[#667085]">{data.messages.at(-1) ? `Last: ${data.messages.at(-1)!.from === "barry" ? "BARRY — " : ""}“${data.messages.at(-1)!.text.slice(0, 140)}”` : "No messages."}</p>
        )}
        <label className="mt-3 flex items-center gap-1.5 text-[12px] text-[#98a2b3]">
          <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Technical detail (for the BARRY team)
        </label>
        {advanced && data.turns && (
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
        )}
      </Section>
    </div>
  );
}

const KINDWORD: Record<Intervention["kind"], string> = { approval: "your decision", held_approval: "a re-check", handoff: "a person", failed_action: "a failed step", blocked_write: "a limit", not_understood: "a message BARRY couldn't read", delivery_failed: "an undelivered reply" };

// ── Money ────────────────────────────────────────────────────────────────

const REVENUE_CATEGORIES: { id: OwnerWorkspace["revenueEvidence"][number]["category"]; label: string; explain: string; tone: Tone }[] = [
  { id: "collected", label: "Collected", explain: "Paid and verified by your payment provider — the only real revenue.", tone: "good" },
  { id: "recovered", label: "Recovered", explain: "Collected after an earlier failed or cancelled attempt (already inside Collected).", tone: "good" },
  { id: "booked_not_collected", label: "Booked, not collected", explain: "Value of bookings BARRY made; not cash.", tone: "info" },
  { id: "open_opportunity", label: "Pending", explain: "Unpaid links and requests waiting for you — not revenue. Simulated ones are marked as test money.", tone: "warn" },
  { id: "simulated", label: "Simulated", explain: "Test money on simulated providers — never counted.", tone: "neutral" },
  { id: "excluded_unverified", label: "Not counted", explain: "Marked paid without provider verification.", tone: "neutral" },
];

function MoneyView({ ws, range, setRange, onOpen, onIntervention, loadedAt }: { ws: OwnerWorkspace; range: "today" | "7d" | "30d"; setRange: (r: "today" | "7d" | "30d") => void; onOpen: (id: string) => void; onIntervention: (id: string) => void; loadedAt: Date | null }) {
  const r = ws.revenue;
  const items = ws.revenueEvidence;
  const impact = financialImpact(r, []);
  const collected = Object.keys(r.direct).length > 0;
  const headline = collected ? `Collected ${formatMoney(r.direct)} ${ws.window.label}.` : `Nothing collected ${ws.window.label} yet.`;
  const atRisk = ws.opportunities.summary.atRisk;
  const stuck = ws.opportunities.summary.stuckWithYou;
  const lead = [
    r.directPayments ? `${r.directPayments} verified payment${r.directPayments === 1 ? "" : "s"}` : "",
    Object.keys(r.potential).length ? `${formatMoney(r.potential)} pending in unpaid links` : "",
    Object.keys(stuck).length ? `${formatMoney(stuck)} waits on you` : "",
    Object.keys(atRisk).length ? `${formatMoney(atRisk)} at risk` : "",
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#667085]">Money · {ws.business.name}{loadedAt ? ` · ${formatLocal(loadedAt.toISOString(), ws.business.timezone, loadedAt)}` : ""}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">{headline}</h1>
          <p className="mt-1 text-sm text-[#667085]">{lead.length ? `${lead.join(" · ")}. ` : ""}Only provider-verified payments count as collected. Everything else is shown apart, each amount in its own currency, never added together.</p>
        </div>
        <select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value as typeof range)} className="min-h-10 rounded-lg border border-[#d0d5dd] bg-white px-3 text-sm">
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </div>

      <Section title="Where money stands" subtitle="Five different things, kept apart.">
        <dl className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-[12rem_1fr]">
          <dt className="text-[#667085]">Collected</dt>
          <dd><MoneyFigures money={r.direct} tone="good" empty="nothing yet" /> <span className="text-[12px] text-[#98a2b3]">{r.directPayments} verified payment{r.directPayments === 1 ? "" : "s"}{Object.keys(r.recovered).length ? ` · includes ${formatMoney(r.recovered)} recovered after a nudge` : ""}</span></dd>
          <dt className="text-[#667085]">Booked, not collected</dt>
          <dd><MoneyFigures money={r.influenced} empty="nothing" /> <span className="text-[12px] text-[#98a2b3]">{r.influencedBookings} booking{r.influencedBookings === 1 ? "" : "s"}</span></dd>
          <dt className="text-[#667085]">Pending</dt>
          <dd><MoneyFigures money={r.potential} empty="nothing" /> <span className="text-[12px] text-[#98a2b3]">{r.potentialItems} unpaid link{r.potentialItems === 1 ? "" : "s"} or request{r.potentialItems === 1 ? "" : "s"} — not revenue</span></dd>
          <dt className="text-[#667085]">At risk</dt>
          <dd><MoneyFigures money={atRisk} tone={Object.keys(atRisk).length ? "bad" : undefined} empty="nothing" /></dd>
          <dt className="text-[#667085]">Test money (apart)</dt>
          <dd><MoneyFigures money={{ ...r.simulatedPaid }} empty="none" /> <span className="text-[12px] text-[#98a2b3]">{Object.keys(r.simulatedInfluenced).length ? `and ${formatMoney(r.simulatedInfluenced)} booked · ` : ""}{r.potentialSimulatedItems ? `${formatMoney(r.potentialSimulated)} pending on a simulated provider · ` : ""}never counted as collected</span></dd>
          <dt className="text-[#667085]">Converted</dt>
          <dd className="tabular-nums">{r.purchaseIntentConversations ? `${r.convertedConversations} of ${r.purchaseIntentConversations}` : "—"} <span className="text-[12px] text-[#98a2b3]">conversations with buying intent · {r.lostOpportunities} lost</span></dd>
        </dl>
      </Section>

      <Section title="BARRY MADE · BARRY SAVED" subtitle="What BARRY generated and recovered is verified revenue. Savings appear by state once your costs are connected — never estimated as realised.">
        <dl className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-[12rem_1fr]">
          <dt className="text-[#667085]">BARRY MADE</dt>
          <dd><MoneyFigures money={impact.generated} tone="good" empty="nothing verified yet" /> <span className="text-[12px] text-[#98a2b3]">generated{Object.keys(impact.recovered).length ? ` · ${formatMoney(impact.recovered)} of it recovered` : ""}</span></dd>
          <dt className="text-[#667085]">BARRY SAVED</dt>
          <dd><MoneyFigures money={impact.saved.realized} empty="nothing yet" /> <span className="text-[12px] text-[#98a2b3]">realised · potential {formatMoney(impact.saved.potential)} · proposed {formatMoney(impact.saved.proposed)} · negotiated {formatMoney(impact.saved.negotiated)}</span></dd>
        </dl>
        {impact.evidenceCount === 0 && <p className="mt-2 text-[12px] text-[#667085]">No cost evidence is connected yet, so there is nothing to save from. BARRY will not invent a saving.</p>}
      </Section>
      <Section title="Money in motion" subtitle="What can you do about it? Each line says whose move it is.">
        <MoneyInMotion items={ws.opportunities.items} summary={ws.opportunities.summary} onOpen={onOpen} onIntervention={onIntervention} />
      </Section>
      <Section title="Unpaid follow-ups" subtitle="Every unpaid link BARRY is watching, with whose move it is now; closed ones show the record that closed them.">
        <WatchingList items={ws.obligations.filter((o) => o.kind === "unpaid_payment_followup" || o.kind === "booking_deposit_missing")} onOpen={onOpen} empty="No unpaid link or missing deposit is being watched." />
      </Section>
      <Section title="Every amount, explained" subtitle="The category each amount is in, and the record that puts it there.">
        {items.length === 0 ? (
          <Empty>No money records in this period yet.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {REVENUE_CATEGORIES.filter((c) => items.some((i) => i.category === c.id)).map((c) => {
              const rows = items.filter((i) => i.category === c.id);
              const totals: Record<string, number> = {};
              for (const x of rows) totals[x.currency] = Math.round(((totals[x.currency] ?? 0) + x.amount) * 100) / 100;
              return (
                <details key={c.id} className="rounded-xl bg-[#f9fafb] p-3">
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <Pill tone={c.tone}>{c.label}</Pill>
                      <span className="text-[12px] text-[#667085]">{c.explain}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{formatMoney(totals)}</span>
                  </summary>
                  <ul className="mt-2 divide-y divide-[#eaecf0] text-[13px]">
                    {rows.map((x, i) => (
                      <li key={i} className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:justify-between">
                        <button className="min-w-0 break-words text-left text-[#344054]" onClick={() => onOpen(x.conversationId)}>
                          {x.customer} — <span className="text-[#667085]">{x.record}</span>
                          {x.simulated && (
                            <>
                              {" "}
                              <Pill tone="neutral">Test money</Pill>
                            </>
                          )}
                        </button>
                        <span className="shrink-0 tabular-nums">{formatMoney({ [x.currency]: x.amount })}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        )}
      </Section>
      {ws.approvals.some((a) => !(a.actionable || a.lifecycle === "held")) && (
        <Section title="Decisions you made">
          <ul className="divide-y divide-[#f2f4f7]">
            {ws.approvals
              .filter((a) => !(a.actionable || a.lifecycle === "held"))
              .slice(0, 12)
              .map((a) => (
                <DecisionRow key={a.id} a={a} onOpen={onOpen} />
              ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function DecisionRow({ a, onOpen }: { a: OwnerApproval; onOpen: (id: string) => void }) {
  const l = LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <button className="min-w-0 text-left" onClick={() => onOpen(a.conversationId)}>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={l.tone}>{l.label}</Pill>
          <span className="text-[14px] font-medium">{a.customer}</span>
        </div>
        <p className="mt-0.5 text-[13px] text-[#475467]">
          {a.what}
          {a.resultReference ? ` · ${a.resultReference}` : ""}
        </p>
      </button>
      <span className="shrink-0 text-[12px] text-[#98a2b3]">{timeAgo(a.createdAt)}</span>
    </li>
  );
}

// ── Ask BARRY ────────────────────────────────────────────────────────────

const SUGGESTIONS = ["What needs me?", "Where is money stuck?", "What happened today?", "What failed?", "What can you do right now?", "Why is this waiting?"];

function AskView({ api, onIntervention, onOpen, initialQuestion }: { api: Api; onIntervention: (id: string) => void; onOpen: (id: string) => void; initialQuestion?: string }) {
  const [q, setQ] = useState(initialQuestion ?? "");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ q: string; a: string; note?: string; source: string; links?: OwnerAnswerLinks }[]>([]);
  const asked = useRef(false);
  useEffect(() => {
    if (!initialQuestion?.trim() || asked.current) return;
    asked.current = true;
    const t = setTimeout(() => void ask(initialQuestion), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    try {
      const res = await api.call<{ answer: string; source: string; note?: string; links?: OwnerAnswerLinks }>("/api/owner/ask", { body: { businessId: api.businessId, question } });
      setHistory((h) => [{ q: question, a: res.answer, note: res.note, source: res.source, links: res.links }, ...h]);
      setQ("");
    } catch (e) {
      setHistory((h) => [{ q: question, a: e instanceof Error ? e.message : "Something went wrong", source: "error" }, ...h]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ask BARRY</h1>
        <p className="mt-1 text-sm text-[#667085]">Ask about your business. Answers come only from its records; BARRY can&apos;t change anything from here.</p>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Why is Dana's request waiting?" className="min-h-11 flex-1 rounded-xl border border-[#d0d5dd] bg-white px-4 text-[15px]" maxLength={1000} />
        <button className={primary} disabled={busy || !q.trim()}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="rounded-full bg-white px-3 py-1.5 text-[13px] text-[#344054] ring-1 ring-[#e4e7ec] hover:bg-[#f9fafb]" onClick={() => void ask(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      {history.length === 0 && (
        <Empty title="Try a question">BARRY answers from the same records you see on Today, Inbox and Money — and links you to the item it talks about.</Empty>
      )}
      <ul className="flex flex-col gap-3">
        {history.map((h, i) => (
          <li key={i} className="rounded-2xl bg-white p-4">
            <p className="text-[13px] font-semibold text-[#667085]">{h.q}</p>
            <p className="mt-2 whitespace-pre-wrap text-[15px] leading-7 text-[#101828]">{h.a}</p>
            {h.note && <p className="mt-2 text-[12px] text-[#98a2b3]">{h.note}</p>}
            {h.links && (h.links.interventions.length > 0 || h.links.opportunities.length > 0 || h.links.steps.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {h.links.interventions.map((l) => (
                  <button key={l.id} className="rounded-full bg-[#fffaeb] px-2.5 py-1 text-[12px] text-[#b54708] ring-1 ring-[#fedf89]" onClick={() => onIntervention(l.id)}>
                    Decide: {l.customer}
                  </button>
                ))}
                {h.links.opportunities.map((l) => (
                  <button key={l.id} className="rounded-full bg-[#f2f4f7] px-2.5 py-1 text-[12px] text-[#344054] ring-1 ring-[#e4e7ec]" onClick={() => onOpen(l.conversationId)}>
                    {l.kind}: {l.customer}
                  </button>
                ))}
                {h.links.steps.map((l) => (
                  <Link key={l.id} href="/owner/train" className="rounded-full bg-[#eff8ff] px-2.5 py-1 text-[12px] text-[#175cd3] ring-1 ring-[#b2ddff]">
                    Unlock: {l.title}
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
