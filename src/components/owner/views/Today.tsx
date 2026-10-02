"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OwnerReply } from "@/lib/owner/command-service";
import type { OwnerOs } from "@/lib/owner/os-service";
import type { Intervention } from "@/lib/owner/interventions";
import type { Money } from "@/lib/owner/revenue";
import { activeWork, proactiveWords, workflows } from "@/lib/owner/control-room";
import { activityTimeline, noticedCard } from "@/lib/owner/os";
import { hasMoney } from "@/lib/format/money";
import { amount, money, type OwnerLang } from "@/lib/owner/lang";
import { Icon, type IconName } from "../kit";
import { useOwnerLang } from "../lang";
import { INTERVENTION_KIND, type Tab } from "./shared";

/**
 * TODAY — the live operational layer over the business. In order of what deserves attention:
 *   NEEDS YOUR ATTENTION   the first decision with full presence (situation · stakes · the one action), the rest compressed
 *   BARRY IS RUNNING       live processes from the canonical active-work definition, with their real progress and age
 *   BUSINESS PULSE         verified money, money in motion and at risk, today's flow — scannable in seconds
 *   WAITING ON OTHERS      conversations where the ball is with the customer
 *   RECENTLY               what changed, what BARRY completed
 * Colour is state only (hot = needs you · live = BARRY handling/handled · warn = at risk). The page re-reads the
 * records every minute while it's open; ages tick from real timestamps; only items that genuinely arrive animate.
 */

/** The command round trip: the SAME owner command service the WhatsApp channel uses. */
export type RunCommand = (body: { text?: string; actionId?: string }) => Promise<OwnerReply>;

/** The story counts, from the canonical definitions (Work shows the same numbers). */
export function todayStory(ws: OwnerWorkspace) {
  const things = activeWork(ws).length;
  const needs = ws.interventions.length;
  return { things, needs };
}

const GLYPH: Record<string, IconName> = { unpaid_payment_followup: "card", abandoned_checkout_recovery: "cart", unresolved_handoff: "users", appointment_reminder: "clock", unpaid_deposit_followup: "receipt" };

const sumMoney = (a: Money, b: Money): Money => {
  const out: Money = { ...a };
  for (const [c, v] of Object.entries(b)) out[c] = Math.round(((out[c] ?? 0) + v) * 100) / 100;
  return out;
};

function timeKit(lang: OwnerLang, tz: string, now: Date) {
  const loc = lang === "he" ? "he-IL" : "en-GB";
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: tz, ...o });
  const key = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const clock = (iso: string | Date) => fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const at = (iso: string) => {
    const d = new Date(iso);
    if (key(d) === key(now)) return clock(d);
    if (key(d) === key(new Date(now.getTime() - 864e5))) return lang === "he" ? "אתמול" : "Yesterday";
    return fmt({ day: "numeric", month: "short" }).format(d);
  };
  /** Compact age: 4m · 3h · 2d 4h. */
  const age = (iso: string) => {
    const m = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60000));
    if (m < 1) return lang === "he" ? "עכשיו" : "now";
    if (m < 60) return lang === "he" ? `${m} דק׳` : `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return lang === "he" ? `${h} שע׳` : `${h}h`;
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return lang === "he" ? `${d} ימ׳${rh ? ` ${rh} שע׳` : ""}` : `${d}d${rh ? ` ${rh}h` : ""}`;
  };
  const date = fmt({ weekday: "long", day: "numeric", month: "long" }).format(now);
  return { clock, at, age, date };
}

/** Items that ARRIVED with a refresh (never on first paint) — the only things that move. */
function useArrivals(keys: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const sig = keys.join("|");
  useEffect(() => {
    const cur = new Set(sig ? sig.split("|") : []);
    const prev = seen.current;
    seen.current = cur;
    if (!prev) return;
    const fresh = new Set([...cur].filter((k) => !prev.has(k)));
    if (!fresh.size) return;
    const t0 = setTimeout(() => setArrived(fresh), 0);
    const t1 = setTimeout(() => setArrived(new Set()), 900);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
    };
  }, [sig]);
  return arrived;
}

/** Ages tick from real timestamps (every 30 s) — the clock moves, the data doesn't pretend to. */
function useNow(asOf: Date | null | undefined): Date {
  const [now, setNow] = useState(() => asOf ?? new Date());
  useEffect(() => {
    const t0 = setTimeout(() => setNow(new Date()), 0);
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [asOf]);
  return now;
}

function Ring({ value, total, live }: { value: number; total: number; live: boolean }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const p = total ? Math.min(1, value / total) : 0;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90 rtl:scale-x-[-1]" aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--x-line-2)" strokeWidth="2.5" />
      {p > 0 && <circle cx="12" cy="12" r={r} fill="none" stroke={live ? "var(--x-live)" : "var(--x-t3)"} strokeWidth="2.5" strokeDasharray={`${c * p} ${c}`} strokeLinecap="butt" />}
    </svg>
  );
}

function SectionHead({ title, meta, href, linkLabel, dot }: { title: string; meta?: React.ReactNode; href?: string; linkLabel?: string; dot?: "hot" | "live" }) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-x-t1">{title}</h2>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot === "hot" ? "bg-x-hot" : "bg-x-live"}`} />}
      {meta && <span className="text-[12.5px] text-x-t3">{meta}</span>}
      {href && <Link href={href} className="ms-auto flex items-center gap-1 text-[12.5px] text-x-t3 hover:text-x-t1">{linkLabel}<Icon name="chevron" size={13} className="rtl:-scale-x-100" /></Link>}
    </div>
  );
}

export function TodayView({ ws, os, onDecision, onOpen, onAsk, asOf }: { ws: OwnerWorkspace; os?: OwnerOs | null; onDecision: (item: Intervention) => void; onOpen: (conversationId: string) => void; onTab?: (t: Tab) => void; onAsk: (q?: string) => void; asOf?: Date | null }) {
  const { lang, t } = useOwnerLang();
  const now = useNow(asOf);
  const tz = ws.business.timezone;
  const tk = timeKit(lang, tz, now);
  const { things, needs } = todayStory(ws);
  const queue = ws.interventions;
  const [hero, ...rest] = queue;
  const flows = workflows(ws, lang);
  const work = activeWork(ws);
  const openItems = flows.filter((f) => work.some((w) => w.workflow === f.kind)).reduce((n, f) => n + f.open, 0);
  const finished = ws.ownerOperations.filter((o) => (o.derivedState === "stopped" || o.derivedState === "completed" || o.derivedState === "failed") && now.getTime() - Date.parse(o.stoppedAt ?? o.updatedAt) < 2 * 864e5);
  const request = (opId: string) => ws.ownerCommands.find((c) => c.operationId === opId && !/^[a-z]:/.test(c.text))?.text;
  /** The last REAL movement of a follow-up rule: BARRY's last attempt; if none yet, when the oldest item was queued. */
  const lastChange = (kind: string): { at: string; queued: boolean } | undefined => {
    const items = ws.obligations.filter((o) => o.kind === kind);
    const attempt = items.map((o) => o.lastAttemptAt).filter((x): x is string => Boolean(x)).sort().at(-1);
    if (attempt) return { at: attempt, queued: false };
    const first = items.map((o) => o.createdAt).sort()[0];
    return first ? { at: first, queued: true } : undefined;
  };
  const feed = activityTimeline(ws, 120, lang);
  const waiting = ws.conversations.filter((c) => c.status === "waiting_on_customer").sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const arrived = useArrivals([...queue.map((i) => i.id), ...work.map((w) => w.id), ...feed.slice(0, 8).map((f) => f.id)]);
  const ai = ws.health.ai;

  const headline =
    lang === "he"
      ? needs
        ? `${needs === 1 ? "דבר אחד מחכה לך" : `${needs} דברים מחכים לך`}. BARRY ${things === 1 ? "עובד על דבר אחד" : `מטפל ב־${things}`}.`
        : things
          ? `BARRY עובד על ${things === 1 ? "דבר אחד" : `${things} דברים`}. שום דבר לא מחכה לך.`
          : "הכול שקט. BARRY על המשמר."
      : needs
        ? `${needs === 1 ? "One thing needs" : `${needs} things need`} you. BARRY is ${things === 1 ? "working on one thing" : `handling ${things}`}.`
        : things
          ? `BARRY is working on ${things === 1 ? "one thing" : `${things} things`}. Nothing needs you.`
          : "All clear. BARRY is watching.";

  const primary = hero ? hero.options.find((o) => o.primary && o.action !== "open_conversation") ?? hero.options.find((o) => o.action !== "open_conversation") : undefined;

  const pulse = <Pulse ws={ws} lang={lang} t={t} tk={tk} now={now} />;

  return (
    <div className="flex flex-col gap-6">
      {/* State of the business, in one line */}
      <header className="flex flex-col gap-1.5">
        <p className="text-[12.5px] text-x-t3">{tk.date}</p>
        <h1 className="text-[23px] font-[650] leading-[1.15] tracking-[-0.025em] text-x-t1 lg:text-[32px]" data-testid="today-headline">{headline}</h1>
        {feed[0] && (
          <p className="text-[13.5px] text-x-t3">
            {t("Last movement", "התנועה האחרונה")} <span className="x-num text-x-t2">{tk.clock(feed[0].at)}</span> · <span className="text-x-t2">{feed[0].text}</span>
          </p>
        )}
        {(ai.status === "unavailable" || ai.status === "degraded") && <p className="mt-1 text-[13.5px] font-medium text-x-warn">{ai.status === "unavailable" ? t("BARRY can't understand customers right now — they get a safe reply and nothing is done.", "BARRY לא מצליח להבין לקוחות כרגע — הם מקבלים תשובה בטוחה ושום דבר לא מתבצע.") : t("BARRY had trouble understanding some messages; those weren't acted on.", "BARRY התקשה להבין חלק מההודעות; לא נעשה בהן שימוש.")}</p>}
      </header>

      {/* The state rail: where everything stands, in four numbers — each opens what's behind it */}
      <nav className="x-panel grid grid-cols-4 overflow-hidden [&>*+*]:border-s [&>*+*]:border-x-line" aria-label={t("Where things stand", "איפה הדברים עומדים")} data-testid="state-rail">
        {[
          { n: String(needs), label: t("Need you", "מחכים לך"), short: t("Need you", "מחכים לך"), tone: needs ? "text-x-hot" : "text-x-t3", href: "/owner?tab=work#needs-you" },
          { n: String(things), label: t(`Running · ${openItems} items`, `רצים · ${openItems} פריטים`), short: t("Running", "רצים"), tone: things ? "text-x-live" : "text-x-t3", href: "/owner?tab=work#working" },
          { n: String(waiting.length), label: t("Waiting on customers", "מחכים ללקוחות"), short: t("Waiting", "מחכים"), tone: "text-x-t1", href: "/owner?tab=customers" },
          { n: money(lang, ws.opportunities.summary.atRisk, "0"), label: t("At risk", "בסיכון"), short: t("At risk", "בסיכון"), tone: hasMoney(ws.opportunities.summary.atRisk) ? "text-x-warn" : "text-x-t3", href: "/owner?tab=money" },
        ].map((c) => (
          <Link key={c.label} href={c.href} className="x-row flex min-w-0 flex-col gap-1 px-3 py-2.5 lg:px-4 lg:py-3">
            <span className={`x-num truncate text-[19px] font-[650] leading-none lg:text-[24px] ${c.tone}`}><bdi>{c.n}</bdi></span>
            <span className="truncate text-[11px] text-x-t3 lg:text-[12px]"><span className="lg:hidden">{c.short}</span><span className="hidden lg:inline">{c.label}</span></span>
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:gap-7">
        <div className="flex min-w-0 flex-col gap-7">
          {/* NEEDS YOUR ATTENTION */}
          <section aria-label={t("Needs your attention", "צריך את תשומת הלב שלך")}>
            <SectionHead title={t("Needs your attention", "צריך את תשומת הלב שלך")} dot={needs ? "hot" : undefined} meta={needs ? <span className="x-num font-semibold text-x-hot">{needs}</span> : undefined} href="/owner?tab=work#needs-you" linkLabel={t("Work", "עבודה")} />
            {hero ? (
              <>
                <article className={`x-raised relative overflow-hidden ${arrived.has(hero.id) ? "x-arrived" : ""}`} data-testid="attention-hero">
                  <span className="absolute inset-y-0 start-0 w-[3px] bg-x-hot" />
                  <div className="flex flex-col gap-3.5 p-4 ps-5 lg:gap-4 lg:p-5 lg:ps-6">
                    <div className="flex items-center justify-between gap-3">
                      <span className="x-label text-x-hot">{INTERVENTION_KIND[hero.kind].label[lang]}</span>
                      <span className="x-num text-[12.5px] text-x-t3">{t("waiting", "מחכה")} {tk.age(hero.since)}</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      <h3 className="text-[19px] font-semibold leading-[1.25] tracking-[-0.015em] text-x-t1 lg:text-[23px]">{hero.title}</h3>
                      <p className="line-clamp-3 text-[14px] leading-[1.5] text-x-t2 lg:text-[14.5px]">{hero.why}</p>
                      {hero.tried.length > 0 && (
                        <p className="text-[13px] leading-[1.45] text-x-t3"><span className="font-semibold text-x-live">BARRY</span> · <span>{hero.tried[hero.tried.length - 1]}</span></p>
                      )}
                    </div>
                    <div className={`items-center gap-3 border-t border-x-line pt-3.5 ${hero.title.includes(hero.customer) && !hero.amount ? "hidden lg:flex" : "flex"}`}>
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] bg-x-3 text-[14px] font-semibold text-x-t2">{hero.customer.replace(/[^\p{L}]/gu, "").slice(0, 1).toUpperCase() || "?"}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium text-x-t1">{hero.customer}</p>
                        <p className="truncate text-[12.5px] text-x-t3">{hero.decision}</p>
                      </div>
                      {hero.amount && <span className="x-num shrink-0 text-[20px] font-semibold text-x-t1">{hero.amount}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {primary && (
                        <button type="button" onClick={() => onDecision(hero)} className="h-10 rounded-[6px] bg-x-t1 px-4 text-[14px] font-semibold text-x-0 hover:bg-white" data-testid="hero-primary">{primary.label}</button>
                      )}
                      <button type="button" onClick={() => onDecision(hero)} className="h-10 rounded-[6px] border border-x-line-2 px-4 text-[14px] font-medium text-x-t1 hover:bg-x-3">{t("See details", "פרטים")}</button>
                      <button type="button" onClick={() => onOpen(hero.conversationId)} className="ms-auto grid h-10 w-10 place-items-center rounded-[6px] text-x-t3 hover:bg-x-3 hover:text-x-t1" aria-label={t("Open the conversation", "לפתוח את השיחה")} title={t("Open the conversation", "לפתוח את השיחה")}><Icon name="chat" size={17} /></button>
                    </div>
                  </div>
                </article>
                {rest.length > 0 && (
                  <div className="x-panel mt-2 divide-y divide-x-line overflow-hidden">
                    {rest.map((i) => (
                      <button key={i.id} type="button" onClick={() => onDecision(i)} className={`x-row flex w-full items-center gap-3 px-4 py-3 text-start ${arrived.has(i.id) ? "x-arrived" : ""}`} data-testid="decision-row">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-x-hot" />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 block text-[14.5px] font-medium leading-[1.3] text-x-t1 lg:truncate">{i.title}</span>
                          <span className="block truncate text-[12.5px] text-x-t3">{i.why}</span>
                        </span>
                        {i.amount && <span className="x-num shrink-0 text-[14px] font-semibold text-x-t1">{i.amount}</span>}
                        <span className="x-num shrink-0 whitespace-nowrap text-end text-[12.5px] text-x-t3">{tk.age(i.since)}</span>
                        <Icon name="chevron" size={14} className="shrink-0 text-x-t4 rtl:-scale-x-100" />
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="x-panel flex items-center gap-3 px-4 py-4">
                <Icon name="check" size={16} className="text-x-live" />
                <p className="text-[14.5px] text-x-t2">{t("Nothing waits on your decision. BARRY brings anything above your limits here first.", "שום דבר לא מחכה להחלטה שלך. כל מה שמעל הגבולות שלך יגיע לכאן קודם.")}</p>
              </div>
            )}
          </section>

          <div className="lg:hidden">{pulse}</div>

          {/* BARRY IS RUNNING */}
          <section aria-label={t("BARRY is running", "BARRY רץ")}>
            <SectionHead title={t("BARRY is running", "BARRY רץ")} dot={things ? "live" : undefined} meta={things ? t(`${things} active · ${openItems} open items`, `${things} פעילים · ${openItems} פריטים פתוחים`) : t("idle", "במנוחה")} href="/owner?tab=work#working" linkLabel={t("Work", "עבודה")} />
            <div className="x-panel divide-y divide-x-line overflow-hidden">
              {work.map((w) => {
                const flow = flows.find((f) => f.kind === w.workflow);
                const op = w.operationId ? ws.ownerOperations.find((o) => o.id === w.operationId) : undefined;
                const working = w.state === "working";
                const done = op ? op.progress.contacted : flow?.contacted ?? 0;
                const total = op ? op.progress.cohort : flow?.open ?? w.customers;
                const last = op ? { at: op.updatedAt, queued: false } : lastChange(w.workflow);
                const sub = op
                  ? t(`${op.progress.contacted} of ${op.progress.cohort} reached · ${op.progress.replied} replied · ${op.progress.purchased} bought`, `${op.progress.contacted} מתוך ${op.progress.cohort} קיבלו הודעה · ${op.progress.replied} ענו · ${op.progress.purchased} קנו`)
                  : flow
                    ? flow.contacted
                      ? t(`${flow.contacted} of ${flow.open} followed up · ${flow.waiting} waiting on the customer`, `${flow.contacted} מתוך ${flow.open} קיבלו מעקב · ${flow.waiting} מחכים ללקוח`)
                      : t(`${flow.open} open · queued, nothing sent yet`, `${flow.open} פתוחים · בתור, עוד לא נשלח כלום`)
                    : "";
                return (
                  <Link key={w.id} href={op ? `/owner?tab=work&operation=${encodeURIComponent(op.id)}` : "/owner?tab=work#working"} className={`x-row flex items-center gap-3 px-4 py-3 ${arrived.has(w.id) ? "x-arrived" : ""}`} data-testid="now-row">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] border border-x-line bg-x-0 text-x-t2"><Icon name={GLYPH[w.workflow] ?? "pulse"} size={15} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-x-t1">{proactiveWords(w.workflow, lang).title}</span>
                      <span className="block truncate text-[12.5px] text-x-t3">{sub}</span>
                      <span className={`mt-0.5 block text-[11.5px] lg:hidden ${working ? "text-x-live" : "text-x-t3"}`}>{working ? t("Working", "בעבודה") : t("Waiting on customers", "מחכה ללקוחות")}{last ? <span className="x-num text-x-t4"> · {last.queued ? t("queued since", "בתור מאז") : t("last attempt", "ניסיון אחרון")} {tk.at(last.at)}</span> : null}</span>
                    </span>
                    <span className="hidden shrink-0 flex-col items-end gap-0.5 lg:flex">
                      <span className={`text-[12px] font-medium ${working ? "text-x-live" : "text-x-t3"}`}>{working ? t("Working", "בעבודה") : t("Waiting on customers", "מחכה ללקוחות")}</span>
                      {last && <span className="x-num text-[11.5px] text-x-t4">{last.queued ? t("queued since", "בתור מאז") : t("last attempt", "ניסיון אחרון")} {tk.at(last.at)}</span>}
                    </span>
                    <Ring value={done} total={total} live={working} />
                  </Link>
                );
              })}
              {finished.map((o) => (
                <div key={o.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-x-t4"><Icon name="check" size={15} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-x-t2">{request(o.id) ? `“${request(o.id)}”` : proactiveWords(o.workflow, lang).title}</span>
                    <span className="block truncate text-[12.5px] text-x-t4">{o.derivedState === "stopped" ? t("Stopped by you", "נעצר על ידך") : o.derivedState === "completed" ? t("Completed", "הושלם") : t("Didn't finish", "לא הסתיים")} · {t(`${o.progress.contacted} reached · ${o.progress.purchased} bought`, `${o.progress.contacted} קיבלו הודעה · ${o.progress.purchased} קנו`)}</span>
                  </span>
                  <span className="x-num shrink-0 text-[12px] text-x-t4">{tk.at(o.stoppedAt ?? o.updatedAt)} {tk.clock(o.stoppedAt ?? o.updatedAt)}</span>
                </div>
              ))}
              {work.length === 0 && finished.length === 0 && <p className="px-4 py-4 text-[14px] text-x-t3">{t("Nothing running. BARRY picks up follow-ups under your rules, or when you ask.", "שום דבר לא רץ. BARRY לוקח מעקבים לפי הכללים שלך, או כשתבקש.")}</p>}
            </div>
          </section>

          {/* WAITING ON OTHERS */}
          <section aria-label={t("Waiting on customers", "מחכה ללקוחות")}>
            <SectionHead title={t("Waiting on customers", "מחכה ללקוחות")} meta={<span className="x-num">{waiting.length}</span>} href="/owner?tab=customers" linkLabel={t("Customers", "לקוחות")} />
            <div className="x-panel divide-y divide-x-line overflow-hidden">
              {waiting.slice(0, 4).map((c) => (
                <button key={c.id} type="button" onClick={() => onOpen(c.id)} className="x-row flex w-full items-center gap-3 px-4 py-2.5 text-start">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-x-t1">{c.customer}</span>
                    {c.lastMessage && <span className="block truncate text-[12.5px] text-x-t3">{c.lastMessage.from === "barry" ? "BARRY: " : ""}<bdi>{c.lastMessage.text}</bdi></span>}
                  </span>
                  <span className="x-num shrink-0 text-[12.5px] text-x-t3">{tk.age(c.lastActivityAt)}</span>
                </button>
              ))}
              {waiting.length === 0 && <p className="px-4 py-3.5 text-[14px] text-x-t3">{t("No one owes BARRY a reply.", "אף לקוח לא חייב תשובה.")}</p>}
              {waiting.length > 4 && <Link href="/owner?tab=customers" className="x-row block px-4 py-2.5 text-[12.5px] text-x-t3">{t(`+${waiting.length - 4} more waiting on a reply`, `+${waiting.length - 4} נוספים מחכים לתשובה`)}</Link>}
            </div>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-7">
          <div className="hidden lg:block">{pulse}</div>

          {/* RECENTLY */}
          <section aria-label={t("Recently", "לאחרונה")}>
            <SectionHead title={t("Recently", "לאחרונה")} href="/owner?tab=activity" linkLabel={t("All", "הכול")} />
            <div className="x-panel divide-y divide-x-line overflow-hidden" data-testid="today-feed">
              {feed.slice(0, 7).map((f) => {
                const mine = /^(You |שאלת|אישרת|דחית|עצרת|ענית)/.test(f.text);
                const done = f.tone === "ok";
                const row = (
                  <>
                    <span className={`mt-[3px] grid h-5 w-5 shrink-0 place-items-center rounded-[5px] ${done ? "bg-x-live/12 text-x-live" : "text-x-t4"}`}>
                      {done ? <Icon name="check" size={12} /> : mine ? <Icon name="users" size={12} /> : <span className="h-1 w-1 rounded-full bg-x-t4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] leading-[1.4] text-x-t1">{f.text}</span>
                      {f.sub && <span className="block truncate text-[12px] text-x-t3"><bdi>{f.sub}</bdi></span>}
                    </span>
                    <span className="x-num shrink-0 pt-[2px] text-[11.5px] text-x-t4">{tk.at(f.at) === tk.clock(f.at) ? tk.clock(f.at) : tk.at(f.at)}</span>
                  </>
                );
                const cls = `x-row flex w-full items-start gap-3 px-4 py-2.5 text-start ${arrived.has(f.id) ? "x-arrived" : ""}`;
                return f.conversationId ? <button key={f.id} type="button" onClick={() => onOpen(f.conversationId!)} className={cls}>{row}</button> : f.href ? <Link key={f.id} href={f.href} className={cls}>{row}</Link> : <div key={f.id} className={cls}>{row}</div>;
              })}
              {feed.length === 0 && <p className="px-4 py-3.5 text-[14px] text-x-t3">{t("Payments, follow-ups and decisions appear here as BARRY records them.", "תשלומים, מעקבים והחלטות יופיעו כאן ברגע ש־BARRY רושם אותם.")}</p>}
            </div>
          </section>

          {/* BARRY noticed — compact */}
          {ws.initiatives.length > 0 && (
            <section aria-label={t("BARRY noticed", "BARRY שם לב")}>
              <SectionHead title={t("BARRY noticed", "BARRY שם לב")} meta={<span className="x-num">{ws.initiatives.length}</span>} href="/owner?tab=work#noticed" linkLabel={t("Review", "לבדיקה")} />
              <div className="x-panel divide-y divide-x-line overflow-hidden">
                {ws.initiatives.slice(0, 3).map((i) => {
                  const c = noticedCard(i, lang);
                  return (
                    <Link key={i.id} href="/owner?tab=work#noticed" className="x-row block px-4 py-3" data-testid="brief-noticed">
                      <span className="block text-[14px] font-medium text-x-t1">{c.what}</span>
                      <span className="block truncate text-[12.5px] text-x-t3">{c.importance}{c.money ? ` · ${c.money}` : ""}</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {/* Tell BARRY */}
          <section className="x-panel p-4" aria-label={t("Ask BARRY", "שאל את BARRY")}>
            <button type="button" onClick={() => onAsk()} className="flex h-10 w-full items-center gap-2.5 rounded-[6px] border border-x-line-2 bg-x-0 px-3 text-start text-[14px] text-x-t3 hover:border-x-t4" data-testid="ask-entry">
              <Icon name="send" size={14} className="text-x-t4 rtl:-scale-x-100" />
              {t("Tell BARRY what to do…", "לבקש מ־BARRY…")}
            </button>
            <div className="mt-2 flex flex-col">
              {[needs ? t("Who needs me?", "מי צריך אותי?") : t("What are you working on?", "על מה אתה עובד?"), t("How much did we make today?", "כמה הרווחנו היום?"), t("Where is money stuck?", "איפה כסף תקוע?")].map((p) => (
                <button key={p} type="button" onClick={() => onAsk(p)} className="flex h-8 items-center gap-2 text-start text-[13px] text-x-t3 hover:text-x-t1">
                  <Icon name="arrow" size={12} className="text-x-t4 rtl:-scale-x-100" />{p}
                </button>
              ))}
            </div>
          </section>

          {os?.setup && !os.setup.supervisedReady && (
            <Link href="/owner/setup" className="flex items-center justify-between gap-3 px-1 text-[12.5px] text-x-t3 hover:text-x-t1" data-testid="brief-setup">
              <span><span className="font-semibold text-x-warn">{t("Setup", "הגדרה")}</span> · {os.setup.headline}</span>
              <Icon name="chevron" size={13} className="rtl:-scale-x-100" />
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The currency the business mostly deals in (from its own money records) — never invented. */
function mainCurrency(maps: Money[]): string {
  const n: Record<string, number> = {};
  for (const m of maps) for (const k of Object.keys(m ?? {})) n[k] = (n[k] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ILS";
}

/** BUSINESS PULSE — verified money first, then what's moving, at risk, and today's flow; the 7-day line is provider-verified only. */
function Pulse({ ws, lang, t, tk, now }: { ws: OwnerWorkspace; lang: OwnerLang; t: (en: string, he: string) => string; tk: ReturnType<typeof timeKit>; now: Date }) {
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const motion = sumMoney(s.waitingOnCustomer, s.stuckWithYou);
  const testItems = s.simulatedItems || r.potentialSimulatedItems;
  const made = hasMoney(r.direct);
  const trend = ws.trend;
  const max = Math.max(1, ...trend.made);
  const dayStart = now.getTime() - 24 * 3600e3;
  const events = activityTimeline(ws, 200, lang).filter((e) => Date.parse(e.at) >= dayStart);
  const hours = Array.from({ length: 24 }, (_, h) => events.filter((e) => Math.floor((Date.parse(e.at) - dayStart) / 3600e3) === h).length);
  const hmax = Math.max(1, ...hours);
  const waitingCount = ws.conversations.filter((c) => c.status === "waiting_on_customer").length;
  const rows: { label: string; value: React.ReactNode; tone?: "warn" | "live"; href: string }[] = [
    { label: t("In motion · not revenue yet", "בתנועה · עוד לא הכנסה"), value: money(lang, motion), href: "/owner?tab=money" },
    { label: t("At risk", "בסיכון"), value: money(lang, s.atRisk), tone: hasMoney(s.atRisk) ? "warn" : undefined, href: "/owner?tab=money" },
    { label: t("Conversations today", "שיחות היום"), value: String(ws.today.conversations), href: "/owner?tab=customers" },
    { label: t("Handled without you", "טופלו בלעדיך"), value: String(ws.today.handledAutonomously), tone: ws.today.handledAutonomously ? "live" : undefined, href: "/owner?tab=activity" },
    { label: t("Waiting on a customer reply", "מחכים לתשובת לקוח"), value: String(waitingCount), href: "/owner?tab=customers" },
  ];
  return (
    <section className="x-panel overflow-hidden" aria-label={t("Business pulse", "הדופק של העסק")} data-testid="today-money">
      <div className="flex items-center gap-2 px-4 pt-4">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-x-t1">{t("Business pulse", "הדופק של העסק")}</h2>
        <span className="ms-auto text-[12px] text-x-t3">{t(`Made ${ws.window.label}`, `נגבה ${ws.window.label}`)}</span>
      </div>
      <div className="flex items-end justify-between gap-4 px-4 pb-3 pt-2">
        <div>
          <p className={`x-num text-[34px] font-[650] leading-none ${made ? "text-x-t1" : "text-x-t3"}`}><bdi>{made ? money(lang, r.direct) : amount(lang, 0, trend.currency ?? mainCurrency([motion, s.atRisk, r.potential]))}</bdi></p>
          <p className="mt-1.5 text-[12.5px] text-x-t3">{made ? t("Verified by your payment provider", "אומת מול ספק התשלומים") : t("Nothing collected yet — only verified payments count", "עוד לא נגבה כלום — רק תשלום מאומת נספר")}</p>
        </div>
        <div className="flex h-10 items-end gap-[3px]" aria-label={t("Verified revenue, last 7 days", "הכנסה מאומתת, 7 ימים")}>
          {trend.made.map((v, i) => <span key={i} className={`w-[7px] rounded-[1px] ${v ? "bg-x-t1" : "bg-x-line-2"}`} style={{ height: `${Math.max(2, (v / max) * 40)}px` }} />)}
        </div>
      </div>
      <div className="border-t border-x-line">
        {rows.map((row) => (
          <Link key={row.label} href={row.href} className="x-row flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[13px] text-x-t2">{row.label}</span>
            <span className={`x-num text-[14px] font-semibold ${row.tone === "warn" ? "text-x-warn" : row.tone === "live" ? "text-x-live" : "text-x-t1"}`}><bdi>{row.value}</bdi></span>
          </Link>
        ))}
      </div>
      <div className="border-t border-x-line px-4 py-3">
        <div className="flex items-center justify-between text-[11.5px] text-x-t3">
          <span>{t(`Last 24 h · ${events.length} events`, `24 שעות אחרונות · ${events.length} אירועים`)}</span>
          <span className="x-num">{tk.clock(now)}</span>
        </div>
        <div className="mt-2 flex h-7 items-end gap-[2px]" aria-hidden>
          {hours.map((n, h) => <span key={h} className={`flex-1 rounded-[1px] ${n ? "bg-x-live/80" : "bg-x-line"}`} style={{ height: `${n ? Math.max(4, (n / hmax) * 28) : 2}px` }} />)}
        </div>
        {testItems ? <p className="mt-2.5 text-[11.5px] text-x-t4">{t(`${testItems} test payment links on BARRY's simulator — never counted.`, `${testItems} קישורי תשלום של בדיקה על הסימולטור — לא נספרים.`)}</p> : null}
      </div>
    </section>
  );
}
