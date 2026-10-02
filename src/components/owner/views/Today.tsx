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
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Icon } from "../kit";
import { useOwnerLang } from "../lang";
import { INTERVENTION_KIND, type Tab } from "./shared";

/**
 * TODAY answers three questions, in this order, and nothing else:
 *   1. What needs me right now?        one dominant action, then a compact list
 *   2. What is BARRY handling?         one line per piece of live work
 *   3. Is anything important happening? one line of business pulse
 * Everything else opens on demand: a decision opens its sheet, live work opens its stations, the pulse line opens
 * the numbers. Colour is state only (hot = needs you · live = BARRY handling · warn = at risk). The page re-reads the
 * records every minute while open; ages tick from real timestamps; only items that genuinely arrive animate.
 */

/** The command round trip: the SAME owner command service the WhatsApp channel uses. */
export type RunCommand = (body: { text?: string; actionId?: string }) => Promise<OwnerReply>;

/** The story counts, from the canonical definitions (Work shows the same numbers). */
export function todayStory(ws: OwnerWorkspace) {
  const things = activeWork(ws).length;
  const needs = ws.interventions.length;
  return { things, needs };
}

type T = (en: string, he: string) => string;

const sumMoney = (a: Money, b: Money): Money => {
  const out: Money = { ...a };
  for (const [c, v] of Object.entries(b)) out[c] = Math.round(((out[c] ?? 0) + v) * 100) / 100;
  return out;
};

/** The currency the business mostly deals in (from its own money records) — never invented. */
function mainCurrency(maps: Money[]): string {
  const n: Record<string, number> = {};
  for (const m of maps) for (const k of Object.keys(m ?? {})) n[k] = (n[k] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ILS";
}

function timeKit(lang: OwnerLang, tz: string, now: Date) {
  const loc = lang === "he" ? "he-IL" : "en-GB";
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: tz, ...o });
  const key = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const clock = (iso: string | Date) => fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const at = (iso: string) => {
    const d = new Date(iso);
    if (key(d) === key(now)) return clock(d);
    if (key(d) === key(new Date(now.getTime() - 864e5))) return `${lang === "he" ? "אתמול" : "Yesterday"} ${clock(d)}`;
    return fmt({ day: "numeric", month: "short" }).format(d);
  };
  /** Compact age: 4m · 3h · 2d. */
  const age = (iso: string) => {
    const m = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60000));
    if (m < 1) return lang === "he" ? "עכשיו" : "now";
    if (m < 60) return lang === "he" ? `${m} דק׳` : `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return lang === "he" ? `${h} שע׳` : `${h}h`;
    const d = Math.floor(h / 24);
    return lang === "he" ? `${d} ימ׳` : `${d}d`;
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

function Label({ children, count, tone }: { children: React.ReactNode; count?: number; tone?: "hot" | "live" }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium text-x-t3">
      {children}
      {count ? <span className={`x-num ${tone === "hot" ? "text-x-hot" : tone === "live" ? "text-x-live" : "text-x-t2"}`}>{count}</span> : null}
    </h2>
  );
}

// ── BARRY's live work ─────────────────────────────────────────────────────────────────────────────────────

type Step = { key: string; label: string; n: number };
type Running = { id: string; title: string; working: boolean; line: string; last?: string; steps: Step[]; href: string };

function runningOf(ws: OwnerWorkspace, lang: OwnerLang, t: T, tk: ReturnType<typeof timeKit>): Running[] {
  const flows = workflows(ws, lang);
  return activeWork(ws).map((w) => {
    const flow = flows.find((f) => f.kind === w.workflow);
    const op = w.operationId ? ws.ownerOperations.find((o) => o.id === w.operationId) : undefined;
    const items = ws.obligations.filter((o) => o.kind === w.workflow);
    const attempt = items.map((o) => o.lastAttemptAt).filter((x): x is string => Boolean(x)).sort().at(-1);
    const queuedSince = items.map((o) => o.createdAt).sort()[0];
    const steps: Step[] = op
      ? [
          { key: `${w.id}:in`, label: t("In scope", "בטווח"), n: op.progress.cohort },
          { key: `${w.id}:reached`, label: t("Reached", "קיבלו פנייה"), n: op.progress.contacted },
          { key: `${w.id}:replied`, label: t("Replied", "ענו"), n: op.progress.replied },
          { key: `${w.id}:out`, label: t("Bought", "קנו"), n: op.progress.purchased },
        ]
      : [
          { key: `${w.id}:open`, label: t("Found", "נמצאו"), n: flow?.open ?? w.customers },
          { key: `${w.id}:reached`, label: t("Reached", "קיבלו פנייה"), n: flow?.contacted ?? 0 },
          { key: `${w.id}:waiting`, label: t("Waiting", "ממתינים"), n: flow?.waiting ?? 0 },
          { key: `${w.id}:out`, label: flow?.closedLabel ?? t("Done", "הושלם"), n: flow?.closed ?? 0 },
        ];
    const found = steps[0].n;
    const reached = steps[1].n;
    const line = reached || op ? t(`${reached} of ${found} reached`, `${reached} מתוך ${found} קיבלו פנייה`) : t(`${found} found · queued, nothing sent yet`, `${found} נמצאו · בתור, עוד לא נשלח כלום`);
    const lastAt = op ? op.updatedAt : attempt;
    return {
      id: w.id,
      title: proactiveWords(w.workflow, lang).title,
      working: w.state === "working",
      line,
      last: lastAt ? t(`Last attempt ${tk.at(lastAt)}`, `ניסיון אחרון ${tk.at(lastAt)}`) : queuedSince ? t(`Queued since ${tk.at(queuedSince)}`, `בתור מאז ${tk.at(queuedSince)}`) : undefined,
      steps,
      href: op ? `/owner?tab=work&operation=${encodeURIComponent(op.id)}` : "/owner?tab=work#working",
    };
  });
}

function RunningSheet({ item, onClose, t, dir, lang }: { item: Running | null; onClose: () => void; t: T; dir: "ltr" | "rtl"; lang: OwnerLang }) {
  return (
    <Sheet open={Boolean(item)} onOpenChange={(o) => !o && onClose()}>
      {item && (
        <SheetContent dir={dir} lang={lang} data-testid="running-sheet">
          <SheetHeader>
            <p className={`flex items-center gap-2 text-[12.5px] ${item.working ? "text-x-live" : "text-x-t3"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${item.working ? "bg-x-live" : "bg-x-t3"}`} />
              {item.working ? t("BARRY is working on this", "BARRY עובד על זה") : t("Waiting on customers", "מחכה ללקוחות")}
            </p>
            <SheetTitle>{item.title}</SheetTitle>
            {item.last && <SheetDescription className="x-num">{item.last}</SheetDescription>}
          </SheetHeader>
          <SheetBody>
            <ol className="flex flex-col">
              {item.steps.map((st, i) => (
                <li key={st.key} className="flex items-center gap-3 border-b border-x-line py-3 last:border-0">
                  <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] ${st.n ? (item.working ? "bg-x-live/15 text-x-live" : "bg-x-3 text-x-t2") : "border border-x-line-2 text-x-t4"}`}>{i + 1}</span>
                  <span className="flex-1 text-[14px] text-x-t2">{st.label}</span>
                  <span className={`x-num text-[15px] font-semibold ${st.n ? "text-x-t1" : "text-x-t4"}`}>{st.n}</span>
                </li>
              ))}
            </ol>
          </SheetBody>
          <SheetFooter>
            <Button asChild variant="outline" className="flex-1">
              <Link href={item.href}>{t("Open in Work", "לפתוח בעבודה")}</Link>
            </Button>
          </SheetFooter>
        </SheetContent>
      )}
    </Sheet>
  );
}

// ── Business pulse ────────────────────────────────────────────────────────────────────────────────────────

/** The numbers behind the one-line pulse — verified money first; test money is named, never counted. */
export function PulseDetail({ ws, lang, t, now }: { ws: OwnerWorkspace; lang: OwnerLang; t: T; now: Date }) {
  const tk = timeKit(lang, ws.business.timezone, now);
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const motion = sumMoney(s.waitingOnCustomer, s.stuckWithYou);
  const testItems = s.simulatedItems || r.potentialSimulatedItems;
  const made = hasMoney(r.direct);
  const max = Math.max(1, ...ws.trend.made);
  const recent = activityTimeline(ws, 5, lang);
  const rows: { label: string; value: string; tone?: "warn" | "live"; href: string }[] = [
    { label: t("In motion · not revenue yet", "בתנועה · עוד לא הכנסה"), value: money(lang, motion, "0"), href: "/owner?tab=money" },
    { label: t("At risk", "בסיכון"), value: money(lang, s.atRisk, "0"), tone: hasMoney(s.atRisk) ? "warn" : undefined, href: "/owner?tab=money" },
    { label: t("Conversations today", "שיחות היום"), value: String(ws.today.conversations), href: "/owner?tab=customers" },
    { label: t("Handled without you", "טופלו בלעדיך"), value: String(ws.today.handledAutonomously), tone: ws.today.handledAutonomously ? "live" : undefined, href: "/owner?tab=activity" },
    { label: t("Waiting on a customer reply", "מחכים לתשובת לקוח"), value: String(ws.conversations.filter((c) => c.status === "waiting_on_customer").length), href: "/owner?tab=customers" },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className={`x-num text-[28px] font-[650] leading-none ${made ? "text-x-t1" : "text-x-t3"}`}><bdi>{made ? money(lang, r.direct) : amount(lang, 0, ws.trend.currency ?? mainCurrency([motion, s.atRisk, r.potential]))}</bdi></p>
          <p className="mt-1.5 text-[12.5px] text-x-t3">{made ? t("Made today · verified by your payment provider", "נגבה היום · אומת מול ספק התשלומים") : t("Made today · only verified payments count", "נגבה היום · רק תשלום מאומת נספר")}</p>
        </div>
        <div className="flex h-8 items-end gap-[3px]" aria-label={t("Verified revenue, last 7 days", "הכנסה מאומתת, 7 ימים")}>
          {ws.trend.made.map((v, i) => <span key={i} className={`w-[6px] rounded-[1px] ${v ? "bg-x-t1" : "bg-x-line-2"}`} style={{ height: `${Math.max(2, (v / max) * 32)}px` }} />)}
        </div>
      </div>
      <div className="flex flex-col">
        {rows.map((row) => (
          <Link key={row.label} href={row.href} className="flex items-center justify-between gap-3 border-b border-x-line py-2.5 last:border-0">
            <span className="text-[14px] text-x-t2">{row.label}</span>
            <span className={`x-num text-[14px] font-semibold ${row.tone === "warn" ? "text-x-warn" : row.tone === "live" ? "text-x-live" : "text-x-t1"}`}><bdi>{row.value}</bdi></span>
          </Link>
        ))}
      </div>
      {testItems ? <p className="text-[12.5px] text-x-t3">{t(`${testItems} test payment link${testItems === 1 ? "" : "s"} on BARRY's simulator — never counted.`, `${testItems} קישורי תשלום של בדיקה על הסימולטור — לא נספרים.`)}</p> : null}
      {recent.length > 0 && (
        <section>
          <h3 className="mb-1 text-[13px] font-medium text-x-t3">{t("Recently", "לאחרונה")}</h3>
          <ul className="flex flex-col">
            {recent.map((f) => (
              <li key={f.id} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-[13.5px] text-x-t2">{f.text}</span>
                <span className="x-num shrink-0 text-[12px] text-x-t4">{tk.at(f.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── Today ─────────────────────────────────────────────────────────────────────────────────────────────────

export function TodayView({ ws, os, onDecision, asOf }: { ws: OwnerWorkspace; os?: OwnerOs | null; onDecision: (item: Intervention) => void; onOpen: (conversationId: string) => void; onTab?: (t: Tab) => void; onAsk: (q?: string) => void; asOf?: Date | null }) {
  const { lang, dir, t } = useOwnerLang();
  const now = useNow(asOf);
  const tk = timeKit(lang, ws.business.timezone, now);
  const { things, needs } = todayStory(ws);
  const [hero, ...rest] = ws.interventions;
  const running = runningOf(ws, lang, t, tk);
  const arrived = useArrivals([...ws.interventions.map((i) => i.id), ...running.map((r) => r.id)]);
  const [openRun, setOpenRun] = useState<Running | null>(null);
  const [pulseOpen, setPulseOpen] = useState(false);
  const ai = ws.health.ai;

  const s = ws.opportunities.summary;
  const r = ws.revenue;
  const cur = ws.trend.currency ?? mainCurrency([s.waitingOnCustomer, s.atRisk, r.potential]);
  const waitingOnCustomers = ws.conversations.filter((c) => c.status === "waiting_on_customer").length;
  const noticed = ws.initiatives[0] ? noticedCard(ws.initiatives[0], lang) : null;
  const primary = hero ? hero.options.find((o) => o.primary && o.action !== "open_conversation") ?? hero.options.find((o) => o.action !== "open_conversation") : undefined;

  const youPart = lang === "he" ? (needs ? `${needs === 1 ? "דבר אחד מחכה לך" : `${needs} מחכים לך`}` : "שום דבר לא מחכה לך") : needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "Nothing needs you";
  const barryPart = lang === "he" ? (things ? `BARRY מטפל ב־${things}` : "BARRY על המשמר") : things ? `BARRY is handling ${things}` : "BARRY is watching";

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 lg:gap-9">
      {/* The state, in one line */}
      <header className="flex flex-col gap-1 pt-1">
        <p className="text-[12.5px] text-x-t3">{tk.date}</p>
        <h1 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.02em] lg:text-[28px]" data-testid="today-headline">
          <span className={needs ? "text-x-t1" : "text-x-t2"}>{youPart}</span>
          <span className="text-x-t4"> · </span>
          <span className="text-x-t2">{barryPart}</span>
        </h1>
        {(ai.status === "unavailable" || ai.status === "degraded") && <p className="mt-1 text-[13.5px] font-medium text-x-warn">{ai.status === "unavailable" ? t("BARRY can't understand customers right now — they get a safe reply and nothing is done.", "BARRY לא מצליח להבין לקוחות כרגע — הם מקבלים תשובה בטוחה ושום דבר לא מתבצע.") : t("BARRY had trouble understanding some messages; those weren't acted on.", "BARRY התקשה להבין חלק מההודעות; לא נעשה בהן שימוש.")}</p>}
      </header>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-10">
        {/* 1 — What needs me */}
        <section aria-label={t("Needs you", "מחכה לך")}>
          <Label count={needs} tone="hot">{t("Needs you", "מחכה לך")}</Label>
          {hero ? (
            <>
              <article className={`x-raised p-4 ${arrived.has(hero.id) ? "x-arrived" : ""}`} data-testid="attention-hero">
                <button type="button" onClick={() => onDecision(hero)} className="block w-full text-start">
                  <span className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="flex items-center gap-1.5 font-medium text-x-hot"><span className="h-1.5 w-1.5 rounded-full bg-x-hot" />{INTERVENTION_KIND[hero.kind].label[lang]}</span>
                    <span className="x-num text-x-t3">{tk.age(hero.since)}</span>
                  </span>
                  <span className="mt-2 flex items-start justify-between gap-3">
                    <span className="text-[17px] font-semibold leading-[1.3] tracking-[-0.01em] text-x-t1">{hero.title}</span>
                    {hero.amount && <span className="x-num shrink-0 text-[16px] font-semibold text-x-t1">{hero.amount}</span>}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-[13.5px] leading-[1.45] text-x-t2">{hero.decision}</span>
                </button>
                <Button onClick={() => onDecision(hero)} className="mt-3.5 w-full lg:w-auto" data-testid="hero-primary">{primary?.label ?? t("Decide", "להחליט")}</Button>
              </article>
              {rest.length > 0 && (
                <ul className="mt-1">
                  {rest.slice(0, 3).map((i) => (
                    <li key={i.id}>
                      <button type="button" onClick={() => onDecision(i)} className={`flex w-full items-center gap-3 border-b border-x-line py-3 text-start ${arrived.has(i.id) ? "x-arrived" : ""}`} data-testid="decision-row">
                        <span className="min-w-0 flex-1 truncate text-[14.5px] text-x-t1">{i.title}</span>
                        {i.amount && <span className="x-num shrink-0 text-[13.5px] font-medium text-x-t1">{i.amount}</span>}
                        <span className="x-num w-8 shrink-0 text-end text-[12.5px] text-x-t3">{tk.age(i.since)}</span>
                      </button>
                    </li>
                  ))}
                  {rest.length > 3 && (
                    <li><Link href="/owner?tab=work#needs-you" className="block py-3 text-[13px] text-x-t3 hover:text-x-t1">{t(`${rest.length - 3} more in Work`, `עוד ${rest.length - 3} בעבודה`)}</Link></li>
                  )}
                </ul>
              )}
            </>
          ) : (
            <p className="flex items-center gap-2 py-1 text-[14.5px] text-x-t2"><Icon name="check" size={15} className="text-x-live" />{t("Nothing waits on your decision.", "שום דבר לא מחכה להחלטה שלך.")}</p>
          )}
        </section>

        {/* 2 — What BARRY is handling */}
        <section aria-label={t("BARRY is handling", "BARRY מטפל")}>
          <Label count={things} tone="live">{t("BARRY is handling", "BARRY מטפל")}</Label>
          {running.length ? (
            <ul className="border-t border-x-line">
              {running.map((w) => (
                <li key={w.id}>
                  <button type="button" onClick={() => setOpenRun(w)} className={`flex w-full items-center gap-3 border-b border-x-line py-3 text-start ${arrived.has(w.id) ? "x-arrived" : ""}`} data-testid="now-row">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${w.working ? "bg-x-live" : "bg-x-t3"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] text-x-t1">{w.title}</span>
                      <span className="block truncate text-[12.5px] text-x-t3">{w.line}</span>
                    </span>
                    <Icon name="chevron" size={14} className="shrink-0 text-x-t4 rtl:-scale-x-100" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-1 text-[14.5px] text-x-t2">{t("Nothing running. BARRY picks up follow-ups under your rules, or when you ask.", "שום דבר לא רץ. BARRY לוקח מעקבים לפי הכללים שלך, או כשתבקש.")}</p>
          )}
          {noticed && (
            <Link href="/owner?tab=work#noticed" className="mt-3 flex items-center gap-2 text-[13px] text-x-t3 hover:text-x-t1" data-testid="brief-noticed">
              <span className="shrink-0 text-x-t2">{t("BARRY noticed", "BARRY שם לב")}</span>
              <span className="min-w-0 truncate">{noticed.what}</span>
              {ws.initiatives.length > 1 && <span className="x-num shrink-0">+{ws.initiatives.length - 1}</span>}
            </Link>
          )}
        </section>
      </div>

      {/* 3 — Is anything important happening: one line, the numbers open on demand */}
      <button type="button" onClick={() => setPulseOpen(true)} className="flex w-full items-center gap-3 border-y border-x-line py-3 text-start" data-testid="today-money">
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-x-t3">
          <span className="x-num font-medium text-x-t1"><bdi>{hasMoney(r.direct) ? money(lang, r.direct) : amount(lang, 0, cur)}</bdi></span> {t("made today", "נגבה היום")}
          {hasMoney(s.atRisk) && <> · <span className="x-num font-medium text-x-warn"><bdi>{money(lang, s.atRisk)}</bdi></span> {t("at risk", "בסיכון")}</>}
          {" · "}<span className="x-num font-medium text-x-t1">{waitingOnCustomers}</span> {t("waiting on replies", "מחכים לתשובה")}
        </span>
        <Icon name="chevron" size={14} className="shrink-0 text-x-t4 rtl:-scale-x-100" />
      </button>

      {os?.setup && !os.setup.supervisedReady && (
        <Link href="/owner/setup" className="-mt-3 text-[12.5px] text-x-t3 hover:text-x-t1" data-testid="brief-setup">
          <span className="text-x-warn">{t("Setup", "הגדרה")}</span> · {os.setup.headline}
        </Link>
      )}

      <RunningSheet item={openRun} onClose={() => setOpenRun(null)} t={t} dir={dir} lang={lang} />
      <Sheet open={pulseOpen} onOpenChange={setPulseOpen}>
        <SheetContent dir={dir} lang={lang} data-testid="pulse-sheet">
          <SheetHeader>
            <SheetTitle>{t("Business today", "העסק היום")}</SheetTitle>
            <SheetDescription className="x-num">{t(`As of ${tk.clock(now)}`, `נכון ל־${tk.clock(now)}`)}</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <PulseDetail ws={ws} lang={lang} t={t} now={now} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
