"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarClockIcon, ChevronRightIcon, ClockIcon, EyeIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import type { Opportunity } from "@/lib/owner/opportunities";
import { isAtRisk } from "@/lib/owner/opportunity-risk";
import { noticedCard } from "@/lib/owner/os";
import { hasMoney } from "@/lib/format/money";
import { amount, money, type OwnerLang } from "@/lib/owner/lang";
import { useOwnerLang } from "@/components/owner/lang";
import { Button } from "@/components/ui/button";
import { Metric, Panel, Spark, Status, Thumb, type Tone } from "@/components/app-shell/kit";
import { ageOf, mainCurrency, sumMoney, type T } from "./model";
import type { NextCtx, Range } from "./NextFrame";

/**
 * MONEY — the one place for richer charts, under the existing money rules: only provider-verified payments are
 * revenue; in motion and at risk are never revenue; test money is shown apart and never counted; each currency
 * stays itself; anything BARRY can't read (payouts today) says so instead of showing a number.
 */

const OPP: Record<Opportunity["kind"], [string, string]> = {
  unpaid_link: ["Payment link not paid", "קישור תשלום שלא שולם"],
  approval_blocking_sale: ["Sale waiting on your approval", "מכירה שמחכה לאישורך"],
  held_blocking_sale: ["Sale held — re-check", "מכירה מוחזקת — לבדוק"],
  stalled_purchase: ["Purchase stalled", "רכישה נתקעה"],
  payment_failed: ["Payment failed", "תשלום נכשל"],
  unpaid_deposit: ["Deposit not paid", "מקדמה לא שולמה"],
  enquiry_open: ["Open enquiry", "פנייה פתוחה"],
  blocked_by_limit: ["Stopped by the customer's limits", "נעצר לפי מגבלות הלקוח"],
};
const WHO: Record<Opportunity["next"]["who"], { tone: Tone; label: [string, string] }> = {
  you: { tone: "hot", label: ["Your move", "התור שלך"] },
  customer: { tone: "info", label: ["Customer's move", "התור של הלקוח"] },
  barry: { tone: "live", label: ["BARRY's move", "התור של BARRY"] },
};

export function MoneyNext(ctx: NextCtx) {
  const { ws, range, setRange, now } = ctx;
  const { lang, t } = useOwnerLang();
  const L = (x: [string, string]) => x[lang === "he" ? 1 : 0];
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const motion = sumMoney(s.waitingOnCustomer, s.stuckWithYou);
  const cur = mainCurrency([motion, s.atRisk, r.potential], ws.trend.currency);
  const real = ws.opportunities.items.filter((o) => !o.simulated);
  const risky = real.filter(isAtRisk);
  const fmt = (m: Record<string, number>) => (hasMoney(m) ? money(lang, m) : amount(lang, 0, cur));
  const testMoney = hasMoney(r.simulatedPaid) || r.potentialSimulatedItems > 0;
  const noticed = [...ws.initiatives].sort((a, b) => Number(Boolean(noticedCard(b, lang).money)) - Number(Boolean(noticedCard(a, lang).money))).slice(0, 3);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-3xl font-semibold tracking-tight">{t("Money", "כסף")}</h2>
          <p className="text-[15px] text-muted-foreground">{t("Only payments your provider verified count as revenue. Each currency stays on its own.", "רק תשלום שהספק אימת נחשב הכנסה. כל מטבע מוצג בנפרד.")}</p>
        </div>
        <div className="flex w-fit rounded-lg border bg-card p-1" role="tablist" aria-label={t("Period", "תקופה")}>
          {(
            [
              ["today", t("Today", "היום")],
              ["7d", t("7 days", "7 ימים")],
              ["30d", t("30 days", "30 ימים")],
            ] as [Range, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={range === id} onClick={() => setRange(id)} className={`h-8 rounded-md px-3 text-sm font-medium ${range === id ? "bg-selected text-foreground" : "text-muted-foreground hover:text-foreground"}`} data-testid={`money-range-${id}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="money-metrics">
        <Metric icon={ShieldCheckIcon} tone="live" label={t(`Verified revenue · ${ws.window.label}`, `הכנסה מאומתת · ${ws.window.label}`)} value={fmt(r.direct)} sub={r.directPayments ? t(`${r.directPayments} payment${r.directPayments === 1 ? "" : "s"}`, `${r.directPayments} תשלומים`) : t("No verified payments yet", "עוד אין תשלומים מאומתים")} chart={<Spark values={ws.trend.made} tone="live" width={72} />} testId="money-made" />
        <Metric icon={ClockIcon} tone="info" label={t("In motion · not revenue", "בתנועה · לא הכנסה")} value={fmt(motion)} sub={t(`${real.length} open item${real.length === 1 ? "" : "s"}`, `${real.length} פריטים פתוחים`)} />
        <Metric icon={TriangleAlertIcon} tone={hasMoney(s.atRisk) ? "warn" : "muted"} label={t("At risk", "בסיכון")} value={fmt(s.atRisk)} sub={t(`${risky.length} payment${risky.length === 1 ? "" : "s"}`, `${risky.length} תשלומים`)} />
        <Metric icon={CalendarClockIcon} tone="muted" label={t("Next payout", "ההעברה הבאה")} value={<span className="text-muted-foreground">{t("Unavailable", "לא זמין")}</span>} sub={t("Payouts aren't connected yet", "העברות עוד לא מחוברות")} testId="money-payout" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title={t("Verified revenue · last 7 days", "הכנסה מאומתת · 7 ימים אחרונים")} bodyClassName="p-4 sm:p-5">
          <RevenueChart days={ws.trend.days} values={ws.trend.made} currency={ws.trend.currency ?? cur} lang={lang} t={t} />
        </Panel>
        <Panel title={t("Where the money is", "איפה הכסף")} bodyClassName="flex flex-col gap-4 p-4 sm:p-5">
          <Where label={t("Waiting on customers", "מחכה ללקוחות")} value={s.waitingOnCustomer} max={motion} cur={cur} tone="info" lang={lang} />
          <Where label={t("Waiting on you", "מחכה לך")} value={s.stuckWithYou} max={motion} cur={cur} tone="hot" lang={lang} />
          <Where label={t("At risk (inside the above)", "בסיכון (מתוך הנ״ל)")} value={s.atRisk} max={motion} cur={cur} tone="warn" lang={lang} />
          <p className="text-xs leading-relaxed text-muted-foreground">{t("None of this is revenue until your payment provider verifies it.", "שום דבר מזה לא הכנסה עד שספק התשלומים מאמת.")}</p>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title={t("At-risk payments", "תשלומים בסיכון")} count={risky.length} countTone="warn" bodyClassName="p-2 sm:p-3">
          {risky.length ? (
            <div className="flex flex-col">
              <div className="hidden grid-cols-[minmax(0,1.6fr)_100px_90px_150px_72px] gap-3 border-b px-3 pb-2 text-xs text-muted-foreground md:grid">
                <span>{t("Customer", "לקוח")}</span>
                <span className="text-end">{t("Amount", "סכום")}</span>
                <span>{t("Since", "מאז")}</span>
                <span>{t("Whose move", "התור של")}</span>
                <span />
              </div>
              {risky.map((o) => <RiskRow key={o.id} o={o} lang={lang} t={t} now={now} L={L} />)}
            </div>
          ) : (
            <p className="px-2 py-4 text-sm text-muted-foreground">{t("Nothing at risk right now.", "אין כרגע כסף בסיכון.")}</p>
          )}
        </Panel>
        <Panel title={t("BARRY noticed", "BARRY שם לב")} action={{ label: t("Work", "עבודה"), href: "/owner/next/work" }} bodyClassName="flex flex-col gap-1 p-2 sm:p-3">
          {noticed.length ? (
            noticed.map((i) => {
              const c = noticedCard(i, lang);
              return (
                <Link key={i.id} href="/owner/next/work" className="flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
                  <Thumb icon={EyeIcon} tone="plum" size="sm" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{c.what}</span>
                    <span className="line-clamp-2 text-xs text-muted-foreground"><bdi>{c.money ? `${c.money} · ` : ""}{c.importance}</bdi></span>
                  </span>
                </Link>
              );
            })
          ) : (
            <p className="px-2 py-4 text-sm text-muted-foreground">{t("Nothing new about money.", "אין משהו חדש לגבי כסף.")}</p>
          )}
        </Panel>
      </div>

      {testMoney && (
        <p className="text-sm text-muted-foreground" data-testid="money-test">
          {t("Test money (simulator, never counted):", "כסף של בדיקות (סימולטור, לא נספר):")} <bdi>{hasMoney(r.simulatedPaid) ? t(`${money(lang, r.simulatedPaid)} paid`, `${money(lang, r.simulatedPaid)} שולם`) : t("none paid", "לא שולם")}</bdi>
          {r.potentialSimulatedItems ? <bdi>{t(` · ${money(lang, r.potentialSimulated)} pending`, ` · ${money(lang, r.potentialSimulated)} ממתין`)}</bdi> : null}
        </p>
      )}
    </div>
  );
}

function Where({ label, value, max, cur, tone, lang }: { label: string; value: Record<string, number>; max: Record<string, number>; cur: string; tone: Tone; lang: OwnerLang }) {
  const v = value[cur] ?? 0;
  const m = max[cur] ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums"><bdi>{hasMoney(value) ? money(lang, value) : amount(lang, 0, cur)}</bdi></span>
      </div>
      <span className="block h-1.5 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${tone === "info" ? "bg-info" : tone === "hot" ? "bg-hot" : "bg-warn"}`} style={{ width: `${m > 0 ? Math.min(100, (v / m) * 100) : 0}%` }} />
      </span>
    </div>
  );
}

function RiskRow({ o, lang, t, now, L }: { o: Opportunity; lang: OwnerLang; t: T; now: number; L: (x: [string, string]) => string }) {
  const w = WHO[o.next.who];
  const href = o.next.interventionId ? `/owner/next/work?intervention=${encodeURIComponent(o.next.interventionId)}` : `/owner?tab=money&conversation=${encodeURIComponent(o.conversationId)}`;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b px-3 py-3 last:border-0 md:grid-cols-[minmax(0,1.6fr)_100px_90px_150px_72px]">
      <span className="flex min-w-0 items-center gap-3">
        <Thumb name={o.customer} size="md" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium"><bdi>{o.customer}</bdi></span>
          <span className="truncate text-xs text-muted-foreground">{L(OPP[o.kind])}</span>
        </span>
      </span>
      <span className="text-end text-sm font-semibold tabular-nums text-warn"><bdi>{o.amount !== undefined && o.currency ? amount(lang, o.amount, o.currency) : "—"}</bdi></span>
      <span className="hidden text-sm tabular-nums text-muted-foreground md:block">{ageOf(lang, o.since, now)}</span>
      <span className="hidden md:block"><Status tone={w.tone}>{L(w.label)}</Status></span>
      <span className="col-span-2 flex items-center justify-between gap-2 md:col-span-1 md:justify-end">
        <span className="flex items-center gap-2 md:hidden"><Status tone={w.tone}>{L(w.label)}</Status><span className="text-xs text-muted-foreground">{ageOf(lang, o.since, now)}</span></span>
        <Button variant="outline" size="sm" asChild>
          <Link href={href}>{t("Open", "לפתוח")}<ChevronRightIcon className="rtl:rotate-180" /></Link>
        </Button>
      </span>
    </div>
  );
}

/** The provider-verified series as an area chart; an empty week says so instead of drawing a fake curve. */
function RevenueChart({ days, values, currency, lang, t }: { days: string[]; values: number[]; currency: string; lang: OwnerLang; t: T }) {
  const W = 640;
  const H = 200;
  const pad = { l: 8, r: 8, t: 12, b: 26 };
  const max = Math.max(...values, 0);
  const total = values.reduce((a, b) => a + b, 0);
  const x = (i: number) => pad.l + (i / Math.max(1, values.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (max ? (v / max) * (H - pad.t - pad.b) : 0);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const label = (d: string) => new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-semibold tabular-nums tracking-tight"><bdi>{amount(lang, total, currency)}</bdi></span>
        <span className="text-sm text-muted-foreground">{t("verified by your payment provider", "אומת מול ספק התשלומים")}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full rtl:-scale-x-100" preserveAspectRatio="none" role="img" aria-label={t("Verified revenue per day, last 7 days", "הכנסה מאומתת ליום, 7 ימים")}>
        <defs>
          <linearGradient id="rev" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--tone-live)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--tone-live)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={pad.l} x2={W - pad.r} y1={H - pad.b - f * (H - pad.t - pad.b)} y2={H - pad.b - f * (H - pad.t - pad.b)} stroke="var(--border)" strokeDasharray="3 5" />)}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--border)" />
        {max > 0 && <path d={`${line} L${x(values.length - 1)},${H - pad.b} L${x(0)},${H - pad.b} Z`} fill="url(#rev)" />}
        <path d={line} fill="none" stroke={max > 0 ? "var(--tone-live)" : "var(--muted-foreground)"} strokeOpacity={max > 0 ? 1 : 0.4} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        {max > 0 && values.map((v, i) => (v ? <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill="var(--tone-live)" /> : null))}
      </svg>
      <div className="flex justify-between px-1 text-xs text-muted-foreground">{days.map((d) => <span key={d}>{label(d)}</span>)}</div>
      {max === 0 && <p className="text-sm text-muted-foreground">{t("No verified payments in the last 7 days — nothing is drawn that didn't happen.", "אין תשלומים מאומתים ב־7 הימים האחרונים — לא מצויר שום דבר שלא קרה.")}</p>}
    </div>
  );
}
