"use client";

import * as React from "react";
import Link from "next/link";
import { CheckIcon, CircleAlertIcon, FileTextIcon, InboxIcon, ListChecksIcon, MessageSquareIcon, MoreHorizontalIcon, OctagonAlertIcon, XIcon } from "lucide-react";
import type { OwnerWorkspace, OwnerApproval } from "@/lib/owner/service";
import type { Intervention, InterventionOption } from "@/lib/owner/interventions";
import type { InitiativeView } from "@/lib/initiative/model";
import type { OwnerReply } from "@/lib/owner/command-service";
import type { ActiveWork } from "@/lib/owner/control-room";
import { noticedCard } from "@/lib/owner/os";
import { money, type OwnerLang } from "@/lib/owner/lang";
import { hasMoney } from "@/lib/format/money";
import { useOwnerLang } from "@/components/owner/lang";
import { INTERVENTION_KIND, LIFECYCLE } from "@/components/owner/views/shared";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/basics";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/item";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Progress, Status, Thumb, toneText, type Tone } from "@/components/app-shell/kit";
import { STAND, ageOf, buildRows, clockOf, workProgress, KIND_ICON, type Row, type T } from "./model";
import type { NextCtx } from "./NextFrame";
import { MobileDetail } from "./MobileDetail";

/**
 * WORK — master/detail. A row says what it is, who it's about, where it stands (one pill), the amount when there is
 * one, and its age. The selected situation explains what happened, what BARRY already did, what is blocking it and
 * the next steps — the same records and the same owner endpoints as the current UI; nothing is invented.
 */

type Filter = "all" | "you" | "customer" | "running" | "noticed" | "done";

export type WorkActions = {
  decide: (item: Intervention, action: InterventionOption["action"]) => Promise<string>;
  initiative: (id: string, action: "review" | "dismiss" | "snooze" | "act") => Promise<OwnerReply | undefined>;
};

/** The same owner endpoints the current UI calls; they re-check authority, freshness and limits before any effect. */
export function useWorkActions({ call, businessId, reload }: Pick<NextCtx, "call" | "businessId" | "reload">, t: T, lang: OwnerLang): WorkActions {
  return {
    decide: async (item, action) => {
      if (action === "approve" || action === "decline" || action === "recheck") {
        const res = await call<{ message?: string; held?: { reason: string } | null; recheck?: { revalidated: number; changedRequests: number } }>("/api/owner/approvals", { body: { businessId, approvalId: item.refs.approvalId, action } });
        await reload();
        if (res.recheck) return res.recheck.revalidated === 0 ? t("BARRY still can't read the customer's later message — the request stays held.", "BARRY עדיין לא מצליח לקרוא את ההודעה המאוחרת — הבקשה נשארת מוחזקת.") : res.recheck.changedRequests > 0 ? t("The customer's later message changed this request — it was replaced.", "ההודעה המאוחרת שינתה את הבקשה — היא הוחלפה.") : t("Re-checked: nothing changed. You can decide it now.", "נבדק שוב: שום דבר לא השתנה. אפשר להחליט עכשיו.");
        if (res.held) return t("Not carried out — the customer was asked to confirm first.", "לא בוצע — הלקוח התבקש לאשר קודם.");
        return action === "approve" ? t("Approved — BARRY carried it out and told the customer.", "אושר — BARRY ביצע ועדכן את הלקוח.") : t("Declined — BARRY told the customer; nothing was sent or changed.", "נדחה — BARRY עדכן את הלקוח; שום דבר לא נשלח או השתנה.");
      }
      await call("/api/owner/handoffs", { body: { businessId, conversationId: item.conversationId, handoffId: item.refs.handoffId, action } });
      await reload();
      return action === "acknowledge" ? t("Marked as seen by your team. The customer was not messaged.", "סומן שהצוות ראה. לא נשלחה הודעה ללקוח.") : t("Resolved. BARRY continues the conversation as usual.", "טופל. BARRY ממשיך את השיחה כרגיל.");
    },
    initiative: async (id, action) => {
      const res = await call<{ reply?: OwnerReply }>("/api/owner/initiatives", { body: { businessId, id, action, lang, ...(action === "snooze" ? { days: 7 } : {}), ...(action === "act" ? { requestId: crypto.randomUUID() } : {}) } });
      if (action !== "review") await reload();
      return res.reply;
    },
  };
}

export function useIsDesktop() {
  const [desktop, setDesktop] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

export const conversationHref = (id: string) => `/owner?tab=work&conversation=${encodeURIComponent(id)}`;

export function WorkNext(ctx: NextCtx) {
  const { ws } = ctx;
  const { lang, dir, t } = useOwnerLang();
  const actions = useWorkActions(ctx, t, lang);
  const desktop = useIsDesktop();
  const { needs, progress, noticed, done } = buildRows(ws, lang, t);
  const all = [...needs, ...progress, ...noticed];
  const [filter, setFilter] = React.useState<Filter>("all");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; bad?: boolean } | null>(null);
  const now = ctx.now;

  // Deep links: ?intervention= and ?operation= select their row.
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const iv = q.get("intervention");
    const op = q.get("operation");
    const hit = iv ? needs.find((r) => r.key === iv) : op ? progress.find((r) => r.open.kind === "work" && r.open.item.operationId === op) : undefined;
    if (!hit) return;
    const t0 = setTimeout(() => setSelected(hit.key), 0);
    return () => clearTimeout(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lists: Record<Filter, Row[]> = {
    all,
    you: needs,
    customer: progress.filter((r) => r.stand === "customer"),
    running: progress.filter((r) => r.stand === "running"),
    noticed,
    done,
  };
  const rows = lists[filter];
  // Desktop always shows a selected situation (the first one) so the detail pane is never empty.
  const current = [...all, ...done].find((r) => r.key === selected) ?? (desktop ? rows[0] : undefined);

  const pills: { id: Filter; label: string; tone?: Tone }[] = [
    { id: "all", label: t("All", "הכול") },
    { id: "you", label: t("Needs you", "מחכה לך"), tone: "hot" },
    { id: "customer", label: t("Waiting on customer", "מחכה ללקוח"), tone: "info" },
    { id: "running", label: t("Running", "רץ"), tone: "live" },
    { id: "noticed", label: t("Noticed", "שם לב"), tone: "plum" },
    { id: "done", label: t("Completed", "הסתיים") },
  ];

  const detail = current ? <Detail key={current.key} row={current} ws={ws} actions={actions} lang={lang} t={t} now={now} onClose={() => setSelected(null)} onDone={(text, bad) => setNotice({ text, bad })} closable={!desktop} /> : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(400px,500px)] xl:gap-8">
      <div className="flex min-w-0 flex-col gap-4 sm:gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("Work", "עבודה")}</h2>
          <p className="hidden text-[15px] text-muted-foreground sm:block">{t("Active situations across your business. BARRY handles the rest.", "מה פתוח בעסק עכשיו. BARRY מטפל בשאר.")}</p>
        </div>

        {notice && (
          <Alert variant={notice.bad ? "destructive" : "default"} data-testid="work-notice">
            {notice.bad ? <CircleAlertIcon /> : <CheckIcon className="text-live" />}
            <AlertDescription className="flex w-full flex-row items-start justify-between gap-3 text-foreground">
              <span>{notice.text}</span>
              <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setNotice(null)} aria-label={t("Dismiss", "סגירה")}><XIcon className="size-4" /></button>
            </AlertDescription>
          </Alert>
        )}

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:px-0" role="tablist" aria-label={t("Filter", "סינון")}>
          {pills.map((p) => {
            const n = lists[p.id].length;
            const on = filter === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setFilter(p.id);
                  setSelected(null);
                }}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium sm:h-9 sm:gap-2 sm:px-3.5 sm:text-sm transition-colors ${on ? "border-info/60 bg-selected text-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
                data-testid={`work-filter-${p.id}`}
              >
                {p.tone && <span className={`size-1.5 rounded-full ${p.tone === "hot" ? "bg-hot" : p.tone === "info" ? "bg-info" : p.tone === "live" ? "bg-live" : "bg-plum"}`} />}
                {p.label}
                {p.id !== "done" && n > 0 && <span className="rounded-full bg-surface-2 px-1.5 text-xs tabular-nums text-foreground/80">{n}</span>}
              </button>
            );
          })}
        </div>

        {rows.length ? (
          <div role="list" className="flex flex-col overflow-hidden rounded-xl border bg-card" data-testid={`work-group-${filter}`}>
            {rows.map((r, i) => (
              <WorkRow key={r.key} row={r} lang={lang} t={t} now={now} selected={desktop && current?.key === r.key} first={i === 0} onOpen={() => setSelected(r.key)} />
            ))}
          </div>
        ) : (
          <Empty className="bg-card/40">
            <EmptyHeader>
              <EmptyMedia><InboxIcon /></EmptyMedia>
              <EmptyTitle>{filter === "you" ? t("Nothing needs you", "שום דבר לא מחכה לך") : t("Nothing here", "אין כאן כלום")}</EmptyTitle>
              <EmptyDescription>{filter === "you" ? t("Approvals, customers who need a person and anything that didn't go through land here first.", "אישורים, לקוחות שצריכים אדם וכל מה שלא הצליח — יגיעו לכאן קודם.") : t("BARRY is watching. New situations appear here as they happen.", "BARRY על המשמר. מצבים חדשים יופיעו כאן כשיקרו.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>

      {/* Desktop: the selected situation beside the list. Phones: the same detail in a bottom Sheet. */}
      {desktop ? (
        <aside className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] self-start overflow-y-auto rounded-xl border bg-card lg:block" data-testid="work-detail">
          {detail}
        </aside>
      ) : (
        <Sheet open={Boolean(current)} onOpenChange={(o) => !o && setSelected(null)}>
          {current && (
            <SheetContent side="bottom" dir={dir} className="max-h-[90dvh] gap-0 rounded-t-2xl bg-card p-0" showClose={false} data-testid="work-sheet">
              <SheetHeader className="sr-only">
                <SheetTitle>{current.title}</SheetTitle>
                <SheetDescription>{current.context}</SheetDescription>
              </SheetHeader>
              <MobileDetail key={current.key} row={current} ws={ws} actions={actions} lang={lang} t={t} now={now} onClose={() => setSelected(null)} onDone={(text, bad) => setNotice({ text, bad })} />
            </SheetContent>
          )}
        </Sheet>
      )}
    </div>
  );
}

/** Short status words for phones (the full words stay on desktop). */
const SHORT: Record<string, [string, string]> = { customer: ["Waiting", "ממתין"] };

export function WorkRow({ row, lang, t, now, selected, first, onOpen }: { row: Row; lang: OwnerLang; t: T; now: number; selected?: boolean; first?: boolean; onOpen: () => void; compact?: boolean }) {
  const s = STAND[row.stand];
  const he = lang === "he" ? 1 : 0;
  const status = row.stand === "you" || row.stand === "noticed" ? s.label[he] : row.status ?? s.label[he];
  const shortStatus = SHORT[row.stand]?.[he] ?? status;
  return (
    <div role="listitem" className={`group relative flex items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 sm:py-3 ${first ? "" : "border-t"} ${selected ? "bg-selected" : "hover:bg-surface-2 active:bg-surface-2"}`} data-testid="work-row">
      {selected && <span className="absolute inset-y-2 start-0 w-0.5 rounded-full bg-info" aria-hidden />}
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-start outline-none" aria-current={selected ? "true" : undefined}>
        <Thumb icon={row.person ? undefined : row.icon} name={row.person} tone={row.person ? "muted" : s.tone} size="md" className="sm:size-12" />
        {/* Phones: two lines — title · age, then context · amount · status. Desktop keeps its columns. */}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium leading-snug">{row.title}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground sm:hidden">{ageOf(lang, row.at, now)}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            {row.context && <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground sm:text-sm">{row.context}</span>}
            {!row.context && <span className="flex-1" />}
            {row.amount && <span className="shrink-0 text-[13px] font-semibold tabular-nums text-warn sm:hidden"><bdi>{row.amount}</bdi></span>}
            <Status tone={s.tone} className="h-5 px-2 text-[11px] sm:hidden">{shortStatus}</Status>
          </span>
        </span>
      </button>
      {row.amount && <span className="hidden w-20 shrink-0 text-end text-[15px] font-semibold tabular-nums text-warn sm:block"><bdi>{row.amount}</bdi></span>}
      <span className="hidden shrink-0 justify-end sm:flex">
        <Status tone={s.tone}>{status}</Status>
      </span>
      <span className="hidden w-9 shrink-0 text-end text-xs tabular-nums text-muted-foreground sm:block">{ageOf(lang, row.at, now)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="hidden shrink-0 text-muted-foreground sm:inline-flex" aria-label={t("More", "עוד")}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={onOpen}>{t("Open details", "לפתוח פרטים")}</DropdownMenuItem>
          {"item" in row.open && "conversationId" in row.open.item && (
            <DropdownMenuItem asChild>
              <Link href={conversationHref((row.open.item as { conversationId: string }).conversationId)}>{t("Open the conversation", "לפתוח את השיחה")}</Link>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── Detail ────────────────────────────────────────────────────────────────────────────────────────────────

function Section({ icon: Icon, tone = "muted", title, children }: { icon: React.ComponentType<{ className?: string }>; tone?: Tone; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${tone === "muted" ? "bg-surface-2 text-muted-foreground" : tone === "hot" ? "bg-hot/12 text-hot" : tone === "live" ? "bg-live/12 text-live" : "bg-info/12 text-info"}`}><Icon className="size-4" /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </section>
  );
}

function Facts({ items }: { items: { label: string; value: React.ReactNode; sub?: string; tone?: Tone }[] }) {
  return (
    <dl className="grid grid-cols-3 overflow-hidden rounded-xl border bg-background/40 [&>*+*]:border-s">
      {items.map((f) => (
        <div key={f.label} className="flex min-w-0 flex-col gap-1 p-3">
          <dt className="truncate text-xs text-muted-foreground">{f.label}</dt>
          <dd className={`line-clamp-2 text-[15px] font-semibold leading-snug tabular-nums ${f.tone ? toneText(f.tone) : ""}`}><bdi>{f.value}</bdi></dd>
          {f.sub && <dd className="truncate text-xs text-muted-foreground">{f.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function Detail({ row, ws, actions, lang, t, now, onClose, onDone, closable }: { row: Row; ws: OwnerWorkspace; actions: WorkActions; lang: OwnerLang; t: T; now: number; onClose: () => void; onDone: (text: string, bad?: boolean) => void; closable?: boolean }) {
  const s = STAND[row.stand];
  return (
    <div className="flex flex-col gap-6 p-5 sm:p-6" data-testid="work-detail-body">
      <header className="flex items-start gap-4">
        <Thumb icon={row.person ? undefined : row.icon} name={row.person} tone={row.person ? "muted" : s.tone} size="xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Status tone={s.tone}>{row.status ?? s.label[lang === "he" ? 1 : 0]}</Status>
            <span className="text-xs tabular-nums text-muted-foreground">{ageOf(lang, row.at, now)}</span>
          </div>
          <h2 className="text-xl font-semibold leading-snug tracking-tight">{row.title}</h2>
          {row.context && <p className="text-sm text-muted-foreground">{row.context}</p>}
        </div>
        {closable && (
          <Button variant="ghost" size="icon-sm" className="-me-2 -mt-1 shrink-0 text-muted-foreground" onClick={onClose} aria-label={t("Close", "סגירה")}>
            <XIcon />
          </Button>
        )}
      </header>
      {row.open.kind === "decision" && <DecisionBody item={row.open.item} ws={ws} actions={actions} lang={lang} t={t} now={now} onClose={onClose} onDone={onDone} />}
      {row.open.kind === "work" && <ProgressBody w={row.open.item} ws={ws} lang={lang} t={t} now={now} />}
      {row.open.kind === "noticed" && <NoticedBody i={row.open.item} actions={actions} lang={lang} t={t} onClose={onClose} onDone={onDone} />}
      {row.open.kind === "approval" && <ApprovalBody a={row.open.item} lang={lang} t={t} />}
      {row.open.kind === "finished" && <FinishedBody o={row.open.item} lang={lang} t={t} />}
    </div>
  );
}

function DecisionBody({ item, ws, actions, lang, t, now, onClose, onDone }: { item: Intervention; ws: OwnerWorkspace; actions: WorkActions; lang: OwnerLang; t: T; now: number; onClose: () => void; onDone: (text: string, bad?: boolean) => void }) {
  const [confirm, setConfirm] = React.useState<InterventionOption | null>(null);
  const [busy, setBusy] = React.useState(false);
  const run = async (o: InterventionOption) => {
    setBusy(true);
    try {
      onDone(await actions.decide(item, o.action));
    } catch (e) {
      onDone(t(`That didn't go through — nothing was changed. (${e instanceof Error ? e.message : "error"})`, `זה לא עבר — שום דבר לא השתנה. (${e instanceof Error ? e.message : "error"})`), true);
    } finally {
      setBusy(false);
      setConfirm(null);
      onClose();
    }
  };
  const options = item.options.filter((o) => o.action !== "open_conversation");
  const ordered = [...options.filter((o) => o.primary || o.action === "approve"), ...options.filter((o) => !(o.primary || o.action === "approve") && !o.destructive && o.action !== "decline"), ...options.filter((o) => o.destructive || o.action === "decline")];
  const needsConfirm = (o: InterventionOption) => o.action === "approve" || o.action === "decline" || Boolean(o.destructive);
  const KindIcon = KIND_ICON[item.kind];
  return (
    <>
      <Facts
        items={[
          item.amount ? { label: t("Amount", "סכום"), value: item.amount, tone: "warn" as Tone } : { label: t("Type", "סוג"), value: INTERVENTION_KIND[item.kind].label[lang] },
          { label: t("Waiting", "מחכה"), value: ageOf(lang, item.since, now), sub: clockOf(lang, ws.business.timezone, item.since, now) },
          { label: t("Customer", "לקוח"), value: item.customer },
        ]}
      />
      <Section icon={FileTextIcon} title={t("What happened", "מה קרה")}>
        <p>{item.why}</p>
      </Section>
      {item.tried.length > 0 && (
        <Section icon={ListChecksIcon} tone="live" title={t("What BARRY already did", "מה BARRY כבר עשה")}>
          <ol className="flex flex-col gap-2">
            {item.tried.map((x, i) => (
              <li key={i} className="flex gap-2.5 text-foreground/90">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-live text-background"><CheckIcon className="size-3" strokeWidth={3} /></span>
                <span>{x}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section icon={OctagonAlertIcon} tone="hot" title={t("What is blocking progress", "מה עוצר את ההתקדמות")}>
        <div className="rounded-lg border border-hot/25 bg-hot/8 px-3 py-2.5 text-foreground/90">
          <p className="font-medium text-foreground">{item.decision}</p>
          <p className="mt-1 text-muted-foreground">{item.then}</p>
        </div>
      </Section>
      <section className="flex flex-col gap-2.5">
        <h3 className="text-[15px] font-semibold">{t("Suggested next steps", "הצעדים הבאים")}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {ordered.map((o, i) => (
            <button
              key={o.action}
              type="button"
              disabled={busy}
              onClick={() => (needsConfirm(o) ? setConfirm(o) : void run(o))}
              className={`flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-xl border px-4 py-2.5 text-start transition-colors disabled:opacity-50 ${i === 0 ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90" : "bg-background/40 hover:bg-surface-2"} ${o.destructive || o.action === "decline" ? "text-hot" : ""}`}
              data-testid={`work-act-${o.action}`}
            >
              <span className="text-sm font-semibold">{o.label}</span>
              <span className={`line-clamp-2 text-xs ${i === 0 ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{o.consequence}</span>
            </button>
          ))}
          <Link href={conversationHref(item.conversationId)} className="flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-xl border bg-background/40 px-4 py-2.5 text-start hover:bg-surface-2">
            <span className="flex items-center gap-2 text-sm font-semibold"><MessageSquareIcon className="size-4" />{t("Review messages", "לקרוא את השיחה")}</span>
            <span className="text-xs text-muted-foreground">{t("Open the conversation", "לפתוח את השיחה")}</span>
          </Link>
        </div>
      </section>
      <footer className="flex items-center gap-3 border-t pt-4">
        <Thumb name={item.customer} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{t("Customer", "לקוח")}</p>
          <p className="truncate text-sm font-medium"><bdi>{item.customer}</bdi></p>
        </div>
        <KindIcon className="size-4 text-muted-foreground" />
      </footer>
      <details className="rounded-lg border px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none text-muted-foreground">{t("How current this is · records", "כמה זה עדכני · רשומות")}</summary>
        <p className="mt-2">{item.freshness}</p>
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground" dir="ltr">{item.evidence.map((e) => <li key={e} className="break-all">{e}</li>)}</ul>
      </details>

      <Dialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.label}?</DialogTitle>
            <DialogDescription>{confirm?.consequence}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("Cancel", "ביטול")}</Button>
            </DialogClose>
            <Button variant={confirm?.destructive || confirm?.action === "decline" ? "destructive" : "default"} disabled={busy} onClick={() => confirm && void run(confirm)} data-testid="work-confirm">
              {confirm?.action === "decline" ? t("Yes, decline", "כן, לדחות") : t("Yes, go ahead", "כן, להמשיך")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProgressBody({ w, ws, lang, t, now }: { w: ActiveWork; ws: OwnerWorkspace; lang: OwnerLang; t: T; now: number }) {
  const p = workProgress(ws, w, lang, t);
  const command = p.op ? ws.ownerCommands.find((c) => c.operationId === p.op!.id) : undefined;
  const tz = ws.business.timezone;
  const done = p.op ? p.op.progress.purchased : p.flow?.closed ?? 0;
  return (
    <>
      <Facts
        items={[
          { label: p.steps[0].label, value: p.steps[0].n },
          { label: p.steps[1].label, value: p.steps[1].n, tone: p.steps[1].n ? "live" : undefined },
          { label: p.steps[3].label, value: done },
        ]}
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm"><span className="text-muted-foreground">{p.line}</span><span className="tabular-nums">{p.reached}/{p.found}</span></div>
        <Progress value={p.reached} max={p.found} tone={w.state === "working" ? "live" : "info"} />
      </div>
      <Section icon={FileTextIcon} title={t("What happened", "מה קרה")}>
        <p>
          {p.op
            ? t(`You asked BARRY${p.op.requestedBy.source === "whatsapp" ? " on WhatsApp" : ""}${command ? `: “${command.text}”` : "."}`, `ביקשת מ־BARRY${p.op.requestedBy.source === "whatsapp" ? " בוואטסאפ" : ""}${command ? `: “${command.text}”` : "."}`)
            : t(`Your follow-up rule picked up ${p.found} open item${p.found === 1 ? "" : "s"}${p.since ? ` (first on ${clockOf(lang, tz, p.since, now)})` : ""}.`, `כלל המעקב שלך זיהה ${p.found} פריטים פתוחים${p.since ? ` (הראשון ב־${clockOf(lang, tz, p.since, now)})` : ""}.`)}
        </p>
      </Section>
      <Section icon={ListChecksIcon} tone="live" title={t("What BARRY already did", "מה BARRY כבר עשה")}>
        <ul className="flex flex-col gap-2">
          {p.steps.map((st) => (
            <li key={st.label} className="flex items-center justify-between gap-3 text-foreground/90">
              <span className="flex items-center gap-2.5">
                <span className={`flex size-4 items-center justify-center rounded-full ${st.n ? "bg-live text-background" : "border border-border"}`}>{st.n ? <CheckIcon className="size-3" strokeWidth={3} /> : null}</span>
                {st.label}
              </span>
              <span className="tabular-nums">{st.n}</span>
            </li>
          ))}
        </ul>
        {p.lastAttempt && <p className="mt-2 text-xs">{t(`Last attempt ${clockOf(lang, tz, p.lastAttempt, now)}`, `ניסיון אחרון ${clockOf(lang, tz, p.lastAttempt, now)}`)}</p>}
      </Section>
      <Section icon={OctagonAlertIcon} tone={p.reached ? "info" : "muted"} title={t("What is blocking progress", "מה עוצר את ההתקדמות")}>
        <p>{p.reached ? t("Customers who were reached haven't replied yet. BARRY follows up again inside your rules.", "לקוחות שקיבלו פנייה עוד לא ענו. BARRY ימשיך לפי הכללים שלך.") : t("Nothing has been sent yet — the items are queued until your follow-up rule's timing allows it.", "עוד לא נשלח כלום — הפריטים בתור עד שהתזמון בכלל המעקב יאפשר.")}</p>
        {(p.op?.progress.test || p.flow?.testItems) ? <p className="mt-1.5 text-xs">{t("Some customers here are on BARRY's simulator — counted, never as money.", "חלק מהלקוחות כאן על הסימולטור — נספרים, אבל אף פעם לא ככסף.")}</p> : null}
        {p.flow && hasMoney(p.flow.atStake) && <p className="mt-1.5 text-xs">{t(`Still open (not revenue): ${money(lang, p.flow.atStake)}`, `עדיין פתוח (לא הכנסה): ${money(lang, p.flow.atStake)}`)}</p>}
      </Section>
      <section className="flex flex-col gap-2.5">
        <h3 className="text-[15px] font-semibold">{t("Suggested next steps", "הצעדים הבאים")}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <Link href={`/owner/next/ask?q=${encodeURIComponent(lang === "he" ? `מה הסטטוס של ${p.title}?` : `What's the status of ${p.command.toLowerCase()}?`)}`} className="flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-xl bg-primary px-4 py-2.5 text-start text-primary-foreground hover:bg-primary/90">
            <span className="text-sm font-semibold">{t("Ask BARRY about it", "לשאול את BARRY")}</span>
            <span className="text-xs text-primary-foreground/70">{t("Status, who was reached, what's next", "סטטוס, למי פנו, מה הלאה")}</span>
          </Link>
          <Link href={`/owner?tab=ask&q=${encodeURIComponent(lang === "he" ? `תעצור: ${p.command}` : `Stop: ${p.command}`)}`} className="flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-xl border bg-background/40 px-4 py-2.5 text-start hover:bg-surface-2">
            <span className="text-sm font-semibold">{t("Ask BARRY to stop it", "לבקש מ־BARRY לעצור")}</span>
            <span className="text-xs text-muted-foreground">{t("Messages already sent stay sent", "הודעות שנשלחו נשארות")}</span>
          </Link>
        </div>
      </section>
    </>
  );
}

function NoticedBody({ i, actions, lang, t, onClose, onDone }: { i: InitiativeView; actions: WorkActions; lang: OwnerLang; t: T; onClose: () => void; onDone: (text: string, bad?: boolean) => void }) {
  const c = noticedCard(i, lang);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const live = c.state === "new" || c.state === "watching" || c.state === "working";
  React.useEffect(() => {
    if (c.state === "new") void actions.initiative(i.id, "review").catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (action: "dismiss" | "snooze" | "act") => {
    setBusy(true);
    try {
      const r = await actions.initiative(i.id, action);
      onDone(r?.text ?? (action === "dismiss" ? t("Dismissed.", "הוסר.") : action === "snooze" ? t("Snoozed for a week.", "נדחה לשבוע.") : t("Started.", "התחיל.")));
    } catch {
      onDone(t("Something went wrong — nothing was changed.", "משהו השתבש — שום דבר לא השתנה."), true);
    } finally {
      setBusy(false);
      setConfirm(false);
      onClose();
    }
  };
  return (
    <>
      <Section icon={FileTextIcon} title={t("What BARRY saw", "מה BARRY ראה")}>
        <p>{c.observation}</p>
      </Section>
      <Section icon={ListChecksIcon} tone="info" title={t("Why it matters", "למה זה חשוב")}>
        <p>{c.whyItMatters}</p>
        {c.money && <p className="mt-1.5 font-medium text-warn"><bdi>{c.money}</bdi></p>}
      </Section>
      <Section icon={OctagonAlertIcon} title={t("Next step", "הצעד הבא")}>
        <p>{c.next}</p>
        <p className="mt-1 text-xs">{c.approval}</p>
      </Section>
      {live && (
        <section className="grid gap-2 sm:grid-cols-3">
          {c.canAct && c.action?.kind === "command" && <Button disabled={busy} onClick={() => setConfirm(true)} data-testid="noticed-act" className="sm:col-span-3">{c.action.label}</Button>}
          {c.action?.kind === "link" && <Button asChild className="sm:col-span-3"><Link href={c.action.href}>{c.action.label}</Link></Button>}
          <Button variant="outline" disabled={busy} onClick={() => void run("snooze")}>{t("Snooze a week", "לדחות לשבוע")}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void run("dismiss")}>{t("Dismiss", "להסיר")}</Button>
        </section>
      )}
      <details className="rounded-lg border px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none text-muted-foreground">{t("Evidence", "ראיות")}</summary>
        <p className="mt-2">{c.evidence}</p>
        <p className="mt-1 text-xs text-muted-foreground">{c.confidence}</p>
      </details>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{c.action?.label}?</DialogTitle>
            <DialogDescription>{t("BARRY runs it through your rules and shows you exactly who it reaches.", "BARRY מריץ את זה לפי הכללים שלך ומראה לך בדיוק למי זה מגיע.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("Cancel", "ביטול")}</Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void run("act")}>{t("Yes, go ahead", "כן, להתחיל")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ApprovalBody({ a, lang, t }: { a: OwnerApproval; lang: OwnerLang; t: T }) {
  const l = LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved;
  return (
    <>
      <Facts items={[{ label: t("Result", "תוצאה"), value: l.label[lang] }, { label: t("Amount", "סכום"), value: a.amount ?? "—" }, { label: t("Customer", "לקוח"), value: a.customer }]} />
      <Section icon={FileTextIcon} title={t("Why it needed you", "למה זה היה צריך אותך")}>
        <p>{a.whyApproval}</p>
        {a.result && <p className="mt-1.5">{a.result}</p>}
      </Section>
      <Button variant="outline" asChild>
        <Link href={conversationHref(a.conversationId)}>{t("Open the conversation", "לפתוח את השיחה")}</Link>
      </Button>
    </>
  );
}

function FinishedBody({ o, lang, t }: { o: OwnerWorkspace["ownerOperations"][number]; lang: OwnerLang; t: T }) {
  const p = o.progress;
  return (
    <>
      <Facts items={[{ label: t("Reached", "קיבלו פנייה"), value: p.contacted }, { label: t("Replied", "ענו"), value: p.replied }, { label: t("Bought", "קנו"), value: p.purchased }]} />
      {hasMoney(p.recovered) && <p className="text-sm">{t("Recovered (verified)", "הוחזר (מאומת)")}: <bdi className="font-semibold text-live">{money(lang, p.recovered)}</bdi></p>}
      {o.stoppedAt && <p className="text-sm text-muted-foreground">{t("Stopped by you — messages already sent stay sent.", "נעצר על ידך — הודעות שכבר נשלחו נשארות.")}</p>}
    </>
  );
}
