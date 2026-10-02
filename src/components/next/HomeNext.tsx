"use client";

import * as React from "react";
import Link from "next/link";
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, MoonIcon, ShoppingBagIcon, SunIcon, TriangleAlertIcon, UsersIcon, XIcon, ZapIcon } from "lucide-react";
import { activityTimeline } from "@/lib/owner/os";
import { hasMoney } from "@/lib/format/money";
import { amount, money } from "@/lib/owner/lang";
import { useOwnerLang } from "@/components/owner/lang";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/basics";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Bars, Count, Dot, Metric, Panel, Progress, Thumb, type Tone } from "@/components/app-shell/kit";
import { STAND, ageOf, buildRows, clockOf, greeting, mainCurrency, workProgress, type Row } from "./model";
import { Detail, conversationHref, useIsDesktop, useWorkActions } from "./WorkNext";
import { MobileDetail } from "./MobileDetail";
import type { NextCtx } from "./NextFrame";

/**
 * HOME — the state of the business in a few seconds:
 *   who needs the owner (one situation with presence, the rest compact) · what BARRY is handling (real progress) ·
 *   a compact business pulse (verified money, at risk, waiting) and the latest real events.
 * Every number is from the workspace; the micro-chart is the provider-verified 7-day series.
 */
export function HomeNext(ctx: NextCtx) {
  const { ws, now } = ctx;
  const { lang, dir, t } = useOwnerLang();
  const actions = useWorkActions(ctx, t, lang);
  const desktop = useIsDesktop();
  const { needs, progress } = buildRows(ws, lang, t);
  const [open, setOpen] = React.useState<Row | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; bad?: boolean } | null>(null);
  const tz = ws.business.timezone;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));
  const waiting = ws.conversations.filter((c) => c.status === "waiting_on_customer").length;
  const [hero, ...rest] = needs;
  const s = ws.opportunities.summary;
  const cur = mainCurrency([s.waitingOnCustomer, s.atRisk, ws.revenue.potential], ws.trend.currency);
  const events = activityTimeline(ws, 4, lang);
  const primary = hero && hero.open.kind === "decision" ? hero.open.item.options.find((o) => o.primary && o.action !== "open_conversation") ?? hero.open.item.options.find((o) => o.action !== "open_conversation") : undefined;

  return (
    <div className="flex flex-col gap-4 sm:gap-6 lg:gap-8">
      <header className="flex flex-col gap-1 sm:gap-2">
        <div className="flex items-center gap-2.5 sm:gap-3">
          {hour >= 6 && hour < 18 ? <SunIcon className="size-5 text-warn sm:size-7" /> : <MoonIcon className="size-5 text-info sm:size-7" />}
          <h2 className="text-xl font-semibold tracking-tight sm:text-3xl">{greeting(tz, now, t)}</h2>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[15px] text-muted-foreground sm:gap-x-2.5 sm:text-lg" data-testid="home-state">
          <span><Count value={needs.length} className="font-semibold text-hot" /> {t("need you", "מחכים לך")}</span>
          <span aria-hidden>·</span>
          <span>{t("BARRY is handling ", "BARRY מטפל ב־")}<Count value={progress.length} className="font-semibold text-live" /></span>
          <span aria-hidden>·</span>
          <span><Count value={waiting} className="font-semibold text-foreground" /> {t("waiting", "ממתינים")}<span className="hidden sm:inline">{t(" on customers", " ללקוחות")}</span></span>
        </p>
      </header>

      {notice && (
        <Alert variant={notice.bad ? "destructive" : "default"}>
          {notice.bad ? <CircleAlertIcon /> : <CheckIcon className="text-live" />}
          <AlertDescription className="flex w-full flex-row items-start justify-between gap-3 text-foreground">
            <span>{notice.text}</span>
            <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setNotice(null)} aria-label={t("Dismiss", "סגירה")}><XIcon className="size-4" /></button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-6">
        {/* Needs your attention */}
        <Panel title={t("Needs your attention", "צריך את תשומת הלב שלך")} count={needs.length} countTone="hot" action={{ label: t(`View all`, "הכול"), href: "/owner/next/work" }} className="self-start" bodyClassName="flex flex-col gap-2 p-3 sm:p-4">
          {hero ? (
            <>
              <article className="flex flex-col gap-3 rounded-xl border bg-surface-2/50 p-3 sm:gap-4 sm:p-4" data-testid="home-hero">
                <div className="flex gap-3 sm:gap-4">
                  <Thumb icon={hero.person ? undefined : hero.icon} name={hero.person} tone={hero.person ? "muted" : "hot"} size="lg" className="sm:size-16 sm:rounded-xl" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex items-center gap-2 font-medium text-hot"><Dot tone="hot" />{hero.status}</span>
                      <span className="tabular-nums text-muted-foreground">{ageOf(lang, hero.at, now)}</span>
                    </div>
                    <h3 className="line-clamp-2 text-base font-semibold leading-snug sm:text-lg">{hero.title}</h3>
                    {hero.context && <p className="line-clamp-1 text-sm text-muted-foreground sm:line-clamp-2">{hero.context}</p>}
                    {hero.amount && <p className="text-base font-semibold tabular-nums text-warn"><bdi>{hero.amount}</bdi></p>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button className="h-10 sm:h-10" onClick={() => setOpen(hero)} data-testid="home-primary">{primary?.label ?? t("Review", "לבדוק")}</Button>
                  {hero.open.kind === "decision" && (
                    <Button className="h-10" variant="outline" asChild>
                      <Link href={conversationHref(hero.open.item.conversationId)}>{t("Open conversation", "לפתוח שיחה")}</Link>
                    </Button>
                  )}
                </div>
              </article>
              {rest.slice(0, 4).map((r, i) => <HomeRow key={r.key} row={r} lang={lang} now={now} onOpen={() => setOpen(r)} className={i >= 2 ? "hidden sm:flex" : undefined} />)}
              {rest.length > 2 && <Link href="/owner/next/work" className="px-2 py-1.5 text-[13px] text-info hover:underline sm:hidden">{t(`${rest.length - 2} more in Work`, `עוד ${rest.length - 2} בעבודה`)}</Link>}
              {rest.length > 4 && <Link href="/owner/next/work" className="hidden px-2 py-2 text-sm text-info hover:underline sm:block">{t(`${rest.length - 4} more in Work`, `עוד ${rest.length - 4} בעבודה`)}</Link>}
            </>
          ) : (
            <p className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground"><CheckIcon className="size-4 text-live" />{t("Nothing waits on your decision.", "שום דבר לא מחכה להחלטה שלך.")}</p>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-6">
          {/* BARRY is handling */}
          <Panel title={t("BARRY is handling", "BARRY מטפל")} count={progress.length} countTone="live" action={{ label: t("View all", "הכול"), href: "/owner/next/work" }} bodyClassName="flex flex-col gap-1 p-2 sm:p-3">
            {progress.length ? (
              progress.map((r) => {
                const w = r.open.kind === "work" ? r.open.item : null;
                const p = w ? workProgress(ws, w, lang, t) : null;
                return (
                  <button key={r.key} type="button" onClick={() => setOpen(r)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-start hover:bg-surface-2" data-testid="home-running">
                    <Thumb icon={r.icon} tone="live" size="lg" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[15px] font-medium">{r.title}</span>
                      <span className="truncate text-sm text-muted-foreground">
                        <span className={r.stand === "running" ? "text-live" : "text-info"}>{r.stand === "running" ? (p?.since ? t(`Working since ${clockOf(lang, tz, p.since, now)}`, `עובד מאז ${clockOf(lang, tz, p.since, now)}`) : t("Working", "עובד")) : STAND.customer.label[lang === "he" ? 1 : 0]}</span>
                        {p ? <> · {t(`${p.found} customers`, `${p.found} לקוחות`)}</> : null}
                      </span>
                    </span>
                    {p && (
                      <span className="flex w-16 shrink-0 items-center gap-2 sm:w-32">
                        <Progress value={p.reached} max={p.found} tone={r.stand === "running" ? "live" : "info"} className="hidden sm:block" />
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{p.reached}/{p.found}</span>
                      </span>
                    )}
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                  </button>
                );
              })
            ) : (
              <p className="px-2 py-4 text-sm text-muted-foreground">{t("Nothing running. BARRY follows up under your rules, or when you ask.", "שום דבר לא רץ. BARRY עוקב לפי הכללים שלך, או כשתבקש.")}</p>
            )}
          </Panel>

          {/* Business pulse */}
          <Panel title={t("Business pulse", "הדופק של העסק")} action={{ label: t("Money", "כסף"), href: "/owner/next/money" }} bodyClassName="flex flex-col gap-4 p-3 sm:p-4">
            <div className="grid grid-cols-3 overflow-hidden rounded-xl border bg-background/40 sm:hidden [&>*+*]:border-s" data-testid="home-pulse-compact">
              {[
                { label: t("Made today", "נגבה היום"), value: hasMoney(ws.revenue.direct) ? money(lang, ws.revenue.direct) : amount(lang, 0, cur), tone: "text-live" },
                { label: t("At risk", "בסיכון"), value: hasMoney(s.atRisk) ? money(lang, s.atRisk) : amount(lang, 0, cur), tone: hasMoney(s.atRisk) ? "text-warn" : "" },
                { label: t("Waiting", "ממתינים"), value: String(waiting), tone: "text-info" },
              ].map((m) => (
                <Link key={m.label} href="/owner/next/money" className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
                  <span className={`truncate text-lg font-semibold tabular-nums ${m.tone}`}><Count value={m.value} /></span>
                  <span className="truncate text-[11px] text-muted-foreground">{m.label}</span>
                </Link>
              ))}
            </div>
            <div className="hidden grid-cols-2 gap-2 sm:grid sm:gap-3" data-testid="home-pulse">
              <Metric icon={ShoppingBagIcon} tone="live" label={t("Made today · verified", "נגבה היום · מאומת")} value={hasMoney(ws.revenue.direct) ? money(lang, ws.revenue.direct) : amount(lang, 0, cur)} chart={<Bars values={ws.trend.made} tone="live" />} href="/owner/next/money" />
              <Metric icon={TriangleAlertIcon} tone={hasMoney(s.atRisk) ? "warn" : "muted"} label={t("At risk", "בסיכון")} value={hasMoney(s.atRisk) ? money(lang, s.atRisk) : amount(lang, 0, cur)} href="/owner/next/money" />
              <Metric icon={UsersIcon} tone="info" label={t("Waiting on replies", "מחכים לתשובה")} value={waiting} />
              <Metric icon={ZapIcon} tone={ws.today.handledAutonomously ? "live" : "muted"} label={t("Handled without you today", "טופלו בלעדיך היום")} value={ws.today.handledAutonomously} />
            </div>
            {events.length > 0 && (
              <div className="hidden flex-col sm:flex">
                <h3 className="px-1 pb-1 text-sm font-medium">{t("Recent activity", "פעילות אחרונה")}</h3>
                {events.map((e) => {
                  const tone: Tone = e.tone === "ok" ? "live" : e.tone === "bad" ? "hot" : e.tone === "warn" ? "warn" : "info";
                  return (
                    <div key={e.id} className="flex items-center gap-3 rounded-lg px-1 py-1.5 text-sm">
                      <Dot tone={tone} />
                      <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{clockOf(lang, tz, e.at, now).replace(/^(Yesterday|אתמול) /, "")}</span>
                      <span className="min-w-0 flex-1 truncate">{e.text}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      </div>

      <Sheet open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)}>
        {open && (
          <SheetContent side={desktop ? "right" : "bottom"} dir={dir} className={desktop ? "gap-0 bg-card p-0 sm:max-w-lg" : "max-h-[90dvh] gap-0 rounded-t-2xl bg-card p-0"} showClose={false} data-testid="home-sheet">
            <SheetHeader className="sr-only">
              <SheetTitle>{open.title}</SheetTitle>
              <SheetDescription>{open.context}</SheetDescription>
            </SheetHeader>
            {desktop ? (
              <div className="min-h-0 overflow-y-auto">
                <Detail row={open} ws={ws} actions={actions} lang={lang} t={t} now={now} onClose={() => setOpen(null)} onDone={(text, bad) => setNotice({ text, bad })} closable />
              </div>
            ) : (
              <MobileDetail row={open} ws={ws} actions={actions} lang={lang} t={t} now={now} onClose={() => setOpen(null)} onDone={(text, bad) => setNotice({ text, bad })} />
            )}
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}

function HomeRow({ row, lang, now, onOpen, className }: { row: Row; lang: "en" | "he"; now: number; onOpen: () => void; className?: string }) {
  return (
    <button type="button" onClick={onOpen} className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start hover:bg-surface-2 sm:py-2.5 ${className ?? ""}`} data-testid="home-row">
      <Thumb icon={row.person ? undefined : row.icon} name={row.person} tone={row.person ? "muted" : STAND[row.stand].tone} size="md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-medium">{row.title}</span>
        {row.context && <span className="truncate text-[13px] text-muted-foreground sm:text-sm">{row.context}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {row.amount && <span className="text-sm font-semibold tabular-nums text-warn"><bdi>{row.amount}</bdi></span>}
        <span className="text-xs tabular-nums text-muted-foreground">{ageOf(lang, row.at, now)}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
    </button>
  );
}
