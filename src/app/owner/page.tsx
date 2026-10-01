"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell, type OwnerSection } from "@/components/owner/OwnerShell";
import { Skeleton, StateNotice, btn, quiet, type Tone } from "@/components/owner/ui";
import { ownerPresence } from "@/lib/owner/presence-model";
import type { Act } from "@/components/owner/operating";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { Intervention, InterventionAction } from "@/lib/owner/interventions";
import { TABS, type Tab } from "@/components/owner/views/shared";
import { TodayView } from "@/components/owner/views/Today";
import { InboxView } from "@/components/owner/views/Inbox";
import { MoneyView } from "@/components/owner/views/Money";
import { AskView } from "@/components/owner/views/Ask";
import { ActionsView } from "@/components/owner/views/Actions";

/**
 * THE OWNER CONTROL ROOM — BARRY runs the business; this is where the owner sees and controls it.
 * Today (what needs me · what BARRY is doing · what it did · where money moves), Inbox, Money,
 * Ask BARRY, Actions & approvals. Everything renders from the owner read model; every action goes
 * through the owner endpoints, which re-check authority before any effect.
 */

export default function OwnerPage() {
  return (
    <Suspense fallback={<div className="barry-owner min-h-screen" />}>
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

  const setTab = (t: Tab, conversation?: string | null, question?: string) => {
    const q = new URLSearchParams();
    q.set("tab", t);
    if (conversation) q.set("conversation", conversation);
    if (question) q.set("q", question);
    router.replace(`/owner?${q.toString()}`, { scroll: false });
  };
  const goToConversation = (conversationId: string) => {
    setOpenConversation(conversationId);
    setTab("inbox", conversationId);
  };
  const goToIntervention = (id?: string) => {
    setTab("actions");
    if (id && typeof document !== "undefined") setTimeout(() => document.querySelector(`[data-intervention="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
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
  const badge = { today: queue.length || undefined, actions: queue.length || undefined, inbox: ws?.conversations.filter((c) => c.status === "needs_you").length || undefined };
  const presence = ws ? ownerPresence(ws) : undefined;
  return (
    <OwnerShell api={api} active={tab} badge={badge} onNavigate={onNavigate} presence={presence} channels={ws?.channels}>
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
        <div className="space-y-4" aria-busy>
          <div className="o-shimmer h-10 w-2/3 rounded-2xl" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="o-panel rounded-2xl p-5">
                <Skeleton lines={3} />
              </div>
            ))}
          </div>
          <div className="o-panel rounded-2xl p-5">
            <Skeleton lines={5} />
          </div>
        </div>
      )}
      {!authorized && api.session && <p className="mt-2 text-sm text-o-muted">Once you&apos;re signed in, this is where you see what BARRY is doing, what needs you and where money moves.</p>}
      {ws && tab === "today" && <TodayView ws={ws} act={act} busyId={busyId} loading={loading} onOpen={goToConversation} onIntervention={goToIntervention} onTab={setTab} onAsk={(q) => setTab("ask", null, q)} />}
      {ws && tab === "inbox" && <InboxView ws={ws} api={api} act={act} busyId={busyId} open={openConversation} setOpen={goToConversation} onIntervention={goToIntervention} loadedAt={loadedAt} />}
      {ws && tab === "money" && <MoneyView ws={ws} range={range} setRange={setRange} onOpen={goToConversation} onIntervention={goToIntervention} loadedAt={loadedAt} />}
      {ws && tab === "ask" && <AskView key={params.get("q") ?? ""} api={api} ws={ws} onIntervention={goToIntervention} onOpen={goToConversation} initialQuestion={params.get("q") ?? ""} />}
      {ws && tab === "actions" && <ActionsView ws={ws} act={act} busyId={busyId} onOpen={goToConversation} />}
    </OwnerShell>
  );
}

