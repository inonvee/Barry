"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell, type OwnerSection } from "@/components/owner/OwnerShell";
import { useOwnerLang } from "@/components/owner/lang";
import { Button, ErrorState, LoadingRows, Notice, type Tone } from "@/components/owner/os-ui";
import { ownerPresence } from "@/lib/owner/presence-model";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OwnerOs } from "@/lib/owner/os-service";
import type { OwnerReply } from "@/lib/owner/command-service";
import type { Intervention } from "@/lib/owner/interventions";
import { TABS, tabOf, type Act, type Tab } from "@/components/owner/views/shared";
import { TodayView, type RunCommand } from "@/components/owner/views/Today";
import { MoneyView } from "@/components/owner/views/Money";
import { AskView } from "@/components/owner/views/Ask";
import { WorkView } from "@/components/owner/views/Work";
import { ActivityView } from "@/components/owner/views/Activity";
import { ConversationSheet, CustomersView } from "@/components/owner/views/Customers";
import { MoreView } from "@/components/owner/views/More";
import { DecisionSheet } from "@/components/owner/views/decision";

/**
 * THE OWNER BUSINESS OS — BARRY runs the business; this is where the owner sees and directs it.
 * Today · Ask · Work · Money, and More (the index: Customers, Activity and the deep pages). Everything
 * renders from the owner read model — the same records the Owner WhatsApp channel reads — and every
 * action goes through the owner endpoints, which re-check authority before any effect. Decisions and
 * conversations open as sheets over whatever page you're on. Links already sent on WhatsApp still land:
 * ?tab=inbox / ?tab=actions, ?conversation=, ?intervention=, ?operation=.
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
  const { lang, t, adopt } = useOwnerLang();
  const tab: Tab = tabOf(params.get("tab"));
  const [range, setRange] = useState<"today" | "7d" | "30d">("today");
  const [loaded, setWs] = useState<OwnerWorkspace | null>(null);
  const [os, setOs] = useState<OwnerOs | null>(null);
  const [error, setError] = useState("");
  const [conversation, setConversation] = useState<string | null>(params.get("conversation"));
  const [decisionId, setDecisionId] = useState<string | null>(params.get("intervention"));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const wantBusiness = params.get("business");

  const { businessId, call, authorized } = api;
  const ws = authorized && loaded?.business.id === businessId ? loaded : null;
  const fetchWorkspace = useCallback(() => call<OwnerWorkspace>(`/api/owner/workspace?businessId=${encodeURIComponent(businessId)}&window=${range}&lang=${lang}`), [businessId, call, range, lang]);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      setWs(await fetchWorkspace());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
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
        adopt(data.business.locale);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setWs(null);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, authorized, fetchWorkspace, adopt]);

  // The setup line on Today reads the same server readiness the Setup page shows (never a fake percentage).
  useEffect(() => {
    if (!businessId || !authorized) return;
    let cancelled = false;
    call<OwnerOs>(`/api/owner/os?businessId=${encodeURIComponent(businessId)}&lang=${lang}`)
      .then((d) => !cancelled && setOs(d))
      .catch(() => !cancelled && setOs(null));
    return () => {
      cancelled = true;
    };
  }, [businessId, authorized, call, lang]);

  // The command bar switches business through the URL (?business=); honour it once, then clean the URL.
  useEffect(() => {
    if (wantBusiness && wantBusiness !== businessId && api.businesses.some((b) => b.id === wantBusiness)) {
      api.setBusinessId(wantBusiness);
      router.replace("/owner?tab=today", { scroll: false });
    }
  }, [wantBusiness, businessId, api, router]);

  const setTab = (next: Tab, question?: string) => {
    const q = new URLSearchParams();
    q.set("tab", next);
    if (question) q.set("q", question);
    router.replace(`/owner?${q.toString()}`, { scroll: false });
    window.scrollTo({ top: 0 });
  };
  const onNavigate = (section: OwnerSection) => {
    if ((TABS as string[]).includes(section)) {
      setTab(section as Tab);
      return true;
    }
    return false;
  };
  const openConversation = (id: string) => {
    setDecisionId(null);
    setConversation(id);
  };
  const openDecision = (item: Intervention) => {
    setConversation(null);
    setDecisionId(item.id);
  };

  // One action handler for every decision: the owner endpoints re-check everything before an effect.
  const act: Act = async (item, action) => {
    if (action === "open_conversation") return openConversation(item.conversationId);
    setBusy(true);
    setNotice(null);
    try {
      if (action === "approve" || action === "decline" || action === "recheck") {
        const res = await call<{ message?: string; held?: { reason: string } | null; recheck?: { revalidated: number; changedRequests: number; recovered?: { outcome: string }[] } }>("/api/owner/approvals", { body: { businessId, approvalId: item.refs.approvalId, action } });
        if (res.recheck) {
          const recovered = res.recheck.recovered?.find((r) => r.outcome !== "unrelated");
          setNotice(
            res.recheck.revalidated === 0
              ? { tone: "warn", text: t("BARRY still can't read the customer's later message — the request stays held.", "BARRY עדיין לא מצליח לקרוא את ההודעה המאוחרת של הלקוח — הבקשה נשארת מוחזקת.") }
              : recovered?.outcome === "proposed" || recovered?.outcome === "reused"
                ? { tone: "ok", text: t("The customer's later message changed this request: the old one was replaced and the corrected request is waiting for you.", "ההודעה המאוחרת של הלקוח שינתה את הבקשה: הישנה הוחלפה, והבקשה המתוקנת מחכה לך.") }
                : res.recheck.changedRequests > 0
                  ? { tone: "neutral", text: t("The customer's later message changed this request — it was cancelled and won't run.", "ההודעה המאוחרת של הלקוח שינתה את הבקשה — היא בוטלה ולא תתבצע.") }
                  : { tone: "ok", text: t("Re-checked: the customer's later message didn't change this request. You can decide it now.", "נבדק שוב: ההודעה המאוחרת לא שינתה את הבקשה. אפשר להחליט עכשיו.") },
          );
        } else if (res.held) setNotice({ tone: "warn", text: t(`Not carried out: ${res.held.reason}. The customer was asked to confirm.`, "לא בוצע — הלקוח התבקש לאשר קודם.") });
        else
          setNotice(
            action === "approve"
              ? { tone: "ok", text: res.message ? t(`Approved. BARRY told the customer: “${res.message.slice(0, 180)}”`, `אושר. BARRY כתב ללקוח: “${res.message.slice(0, 180)}”`) : t("Approved — BARRY carried it out and told the customer.", "אושר — BARRY ביצע ועדכן את הלקוח.") }
              : { tone: "neutral", text: t("Declined — BARRY told the customer; nothing was sent or changed.", "נדחה — BARRY עדכן את הלקוח; שום דבר לא נשלח או השתנה.") },
          );
      } else {
        await call("/api/owner/handoffs", { body: { businessId, conversationId: item.conversationId, handoffId: item.refs.handoffId, action } });
        setNotice(action === "acknowledge" ? { tone: "neutral", text: t("Marked as seen by your team. The customer was not messaged.", "סומן שהצוות ראה. לא נשלחה הודעה ללקוח.") } : { tone: "ok", text: t("Resolved. BARRY continues the conversation as usual.", "טופל. BARRY ממשיך את השיחה כרגיל.") });
      }
      await load();
    } catch (e) {
      setNotice({ tone: "bad", text: t(`That didn't go through — nothing was changed. (${e instanceof Error ? e.message : "error"})`, `זה לא עבר — שום דבר לא השתנה. (${e instanceof Error ? e.message : "error"})`) });
    } finally {
      setBusy(false);
    }
  };

  // Ask → the same owner command service the WhatsApp owner channel uses; then refresh.
  const runCommand: RunCommand = async (body) => {
    const res = await call<{ reply: OwnerReply }>("/api/owner/command", { body: { businessId, requestId: crypto.randomUUID(), lang, ...body } });
    await load();
    return res.reply;
  };

  // What BARRY noticed: review / snooze / dismiss, or "Do this" through the owner command service.
  const runInitiative = async (id: string, action: "review" | "dismiss" | "snooze" | "act") => {
    const res = await call<{ reply?: OwnerReply }>("/api/owner/initiatives", { body: { businessId, id, action, lang, ...(action === "snooze" ? { days: 7 } : {}), ...(action === "act" ? { requestId: crypto.randomUUID() } : {}) } });
    if (action !== "review") await load();
    return res.reply;
  };

  const queue = ws?.interventions ?? [];
  const decision = decisionId ? (queue.find((i) => i.id === decisionId) ?? null) : null;
  const badge = { work: queue.length || undefined };
  const presence = ws ? ownerPresence(ws, new Date(), lang) : undefined;
  const ask = (q?: string) => setTab("ask", q);
  const active: OwnerSection = tab;

  return (
    <OwnerShell api={api} active={active} badge={badge} onNavigate={onNavigate} presence={presence}>
      <div className="flex flex-col gap-4">
        {authorized && error && <ErrorState title={t("BARRY couldn't load your business right now", "BARRY לא הצליח לטעון את העסק כרגע")} detail={error} onRetry={() => void load()} />}
        {ws?.unavailable.length ? <Notice tone="warn">{t(`Some records couldn't be read (${ws.unavailable.join(", ")}) — the figures leave them out rather than guess.`, `חלק מהרשומות לא נקראו (${ws.unavailable.join(", ")}) — המספרים לא כוללים אותן במקום לנחש.`)}</Notice> : null}
        {notice && (
          <Notice tone={notice.tone} action={<button type="button" className="text-[13px] font-medium text-o-muted" onClick={() => setNotice(null)}>{t("Dismiss", "סגירה")}</button>}>
            <span data-testid="action-notice"><bdi>{notice.text}</bdi></span>
          </Notice>
        )}
        {decisionId && ws && !decision && (
          <Notice tone="neutral" action={<Button kind="quiet" onClick={() => setDecisionId(null)}>{t("OK", "הבנתי")}</Button>}>{t("That decision isn't waiting anymore — it was already decided or replaced.", "ההחלטה הזאת כבר לא מחכה — היא כבר הוחלטה או הוחלפה.")}</Notice>
        )}
        {authorized && !ws && !error && (
          <div className="flex flex-col gap-4" aria-busy>
            <div className="o-shimmer h-9 w-2/3 rounded-xl" />
            <LoadingRows rows={4} />
            <LoadingRows rows={3} />
          </div>
        )}
        {ws && tab === "today" && <TodayView ws={ws} os={os} onDecision={openDecision} onOpen={openConversation} onTab={(x) => setTab(x)} onAsk={ask} />}
        {ws && tab === "ask" && <AskView key={params.get("q") ?? ""} ws={ws} onCommand={runCommand} initialQuestion={params.get("q") ?? ""} />}
        {ws && tab === "work" && <WorkView ws={ws} onDecision={openDecision} onOpen={openConversation} onInitiative={runInitiative} onAsk={(q) => ask(q)} />}
        {ws && tab === "money" && <MoneyView ws={ws} range={range} setRange={setRange} onOpen={openConversation} />}
        {ws && tab === "more" && <MoreView ws={ws} api={api} />}
        {ws && tab === "customers" && <CustomersView ws={ws} onOpen={openConversation} onDecision={openDecision} />}
        {ws && tab === "activity" && <ActivityView ws={ws} onOpen={openConversation} />}
      </div>
      {ws && decision && <DecisionSheet key={decision.id} item={decision} act={act} busy={busy} onClose={() => setDecisionId(null)} onConversation={openConversation} />}
      {ws && conversation && <ConversationSheet key={conversation} id={conversation} ws={ws} api={api} onClose={() => setConversation(null)} onDecision={openDecision} />}
    </OwnerShell>
  );
}
