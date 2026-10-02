"use client";

import * as React from "react";
import Link from "next/link";
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, ClockIcon, EyeIcon, InboxIcon, RefreshCwIcon } from "lucide-react";
import type { OwnerWorkspace, OwnerApproval } from "@/lib/owner/service";
import type { Intervention, InterventionOption } from "@/lib/owner/interventions";
import type { InitiativeView } from "@/lib/initiative/model";
import type { OwnerReply } from "@/lib/owner/command-service";
import { activeWork, proactiveWords, workflows, type ActiveWork } from "@/lib/owner/control-room";
import { noticedCard } from "@/lib/owner/os";
import { money, type OwnerLang } from "@/lib/owner/lang";
import { hasMoney } from "@/lib/format/money";
import { useOwnerLang } from "@/components/owner/lang";
import { INTERVENTION_KIND, LIFECYCLE } from "@/components/owner/views/shared";
import { Section } from "@/components/app-shell/AppShell";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, Badge } from "@/components/ui/basics";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/item";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NextCtx } from "./NextFrame";

/**
 * WORK, rebuilt in the shadcn shell from the same records and the same owner endpoints:
 *   a row says WHAT it is, WHERE it stands, and whether YOU need to act — one line each, nothing more;
 *   everything else (why, what BARRY already did, what happens next, evidence, actions) is in the row's sheet.
 * Filters: All (grouped) · Needs you · In progress · Noticed · Done.
 */

type T = (en: string, he: string) => string;
type Filter = "all" | "needs" | "progress" | "noticed" | "done";
type Stand = "you" | "working" | "customer" | "noticed" | "done";

type Row = {
  key: string;
  stand: Stand;
  title: string;
  /** Where it stands, in words (first), then the one fact that matters. */
  state: string;
  detail?: string;
  amount?: string;
  at?: string;
  open: Opened;
};

type Opened =
  | { kind: "decision"; item: Intervention }
  | { kind: "work"; item: ActiveWork }
  | { kind: "noticed"; item: InitiativeView }
  | { kind: "approval"; item: OwnerApproval }
  | { kind: "finished"; item: OwnerWorkspace["ownerOperations"][number] };

const ICON: Record<Stand, React.ComponentType<{ className?: string }>> = { you: CircleAlertIcon, working: RefreshCwIcon, customer: ClockIcon, noticed: EyeIcon, done: CheckIcon };

function ageOf(lang: OwnerLang, iso: string | undefined, now: number) {
  if (!iso) return "";
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (m < 1) return lang === "he" ? "עכשיו" : "now";
  if (m < 60) return lang === "he" ? `${m} דק׳` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return lang === "he" ? `${h} שע׳` : `${h}h`;
  return lang === "he" ? `${Math.floor(h / 24)} ימ׳` : `${Math.floor(h / 24)}d`;
}

function buildRows(ws: OwnerWorkspace, lang: OwnerLang, t: T) {
  const flows = workflows(ws, lang);
  const needs: Row[] = ws.interventions.map((i) => ({
    key: i.id,
    stand: "you",
    title: i.title,
    // The title already names the kind ("… needs a person"); the second line is what the owner has to do.
    state: i.title.toLowerCase().includes(INTERVENTION_KIND[i.kind].label[lang].toLowerCase()) ? "" : INTERVENTION_KIND[i.kind].label[lang],
    detail: i.decision,
    amount: i.amount,
    at: i.since,
    open: { kind: "decision", item: i },
  }));
  const progress: Row[] = activeWork(ws).map((w) => {
    const op = w.operationId ? ws.ownerOperations.find((o) => o.id === w.operationId) : undefined;
    const flow = flows.find((f) => f.kind === w.workflow);
    const items = ws.obligations.filter((o) => o.kind === w.workflow);
    const lastAttempt = items.map((o) => o.lastAttemptAt).filter((x): x is string => Boolean(x)).sort().at(-1);
    const detail = op
      ? t(`${op.progress.contacted} of ${op.progress.cohort} reached · ${op.progress.replied} replied`, `${op.progress.contacted} מתוך ${op.progress.cohort} קיבלו פנייה · ${op.progress.replied} ענו`)
      : flow
        ? flow.contacted
          ? t(`${flow.contacted} of ${flow.open} reached · ${flow.waiting} waiting`, `${flow.contacted} מתוך ${flow.open} קיבלו פנייה · ${flow.waiting} ממתינים`)
          : t(`${flow.open} found · nothing sent yet`, `${flow.open} נמצאו · עוד לא נשלח כלום`)
        : undefined;
    const working = w.state === "working";
    return {
      key: w.id,
      stand: working ? "working" : "customer",
      title: proactiveWords(w.workflow, lang).title,
      state: working ? t("BARRY working", "BARRY עובד") : t("Waiting on customers", "מחכה ללקוחות"),
      detail,
      at: op ? op.updatedAt : lastAttempt ?? items.map((o) => o.createdAt).sort()[0],
      open: { kind: "work", item: w },
    } satisfies Row;
  });
  const noticed: Row[] = ws.initiatives.map((i) => {
    const c = noticedCard(i, lang);
    return { key: i.id, stand: "noticed", title: c.what, state: c.stateWords, detail: c.importance, amount: c.money || undefined, at: i.provenance.detectedAt, open: { kind: "noticed", item: i } };
  });
  const done: Row[] = [
    ...ws.approvals
      .filter((a) => !(a.actionable || a.lifecycle === "held"))
      .slice(0, 12)
      .map((a): Row => ({ key: `ap:${a.id}`, stand: "done", title: `${a.customer} · ${a.what}`, state: (LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved).label[lang], amount: a.amount, at: a.createdAt, open: { kind: "approval", item: a } })),
    ...ws.ownerOperations
      .filter((o) => o.derivedState === "completed" || o.derivedState === "stopped" || o.derivedState === "blocked" || o.derivedState === "failed")
      .slice(0, 6)
      .map((o): Row => ({
        key: `op:${o.id}`,
        stand: "done",
        title: proactiveWords(o.workflow, lang).title,
        state: o.derivedState === "stopped" ? t("Stopped by you", "נעצר על ידך") : o.derivedState === "completed" ? t("Completed", "הושלם") : t("Didn't finish", "לא הסתיים"),
        detail: t(`${o.progress.contacted} reached · ${o.progress.purchased} bought`, `${o.progress.contacted} קיבלו פנייה · ${o.progress.purchased} קנו`),
        at: o.stoppedAt ?? o.updatedAt,
        open: { kind: "finished", item: o },
      })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return { needs, progress, noticed, done };
}

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

export function WorkNext(ctx: NextCtx) {
  const { ws } = ctx;
  const { lang, dir, t } = useOwnerLang();
  const actions = useWorkActions(ctx, t, lang);
  const { needs, progress, noticed, done } = buildRows(ws, lang, t);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; bad?: boolean } | null>(null);
  const [now] = React.useState(() => Date.now());

  // Deep links from the current UI keep working: ?intervention= and ?operation= open their sheet.
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const iv = q.get("intervention");
    const op = q.get("operation");
    const hit: Opened | null = iv ? (needs.find((r) => r.key === iv)?.open ?? null) : op ? (progress.find((r) => r.open.kind === "work" && r.open.item.operationId === op)?.open ?? null) : null;
    if (!hit) return;
    const t0 = setTimeout(() => setOpened(hit), 0);
    return () => clearTimeout(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups: { id: Filter; label: string; rows: Row[]; empty: string }[] = [
    { id: "needs", label: t("Needs you", "מחכה לך"), rows: needs, empty: t("Nothing needs you. Approvals, customers who need a person and anything that didn't go through land here first.", "שום דבר לא מחכה לך. אישורים, לקוחות שצריכים אדם וכל מה שלא הצליח — יגיעו לכאן קודם.") },
    { id: "progress", label: t("In progress", "בעבודה"), rows: progress, empty: t("Nothing running. BARRY follows up under your rules, or when you ask.", "שום דבר לא רץ. BARRY עוקב לפי הכללים שלך, או כשתבקש.") },
    { id: "noticed", label: t("Noticed", "שם לב"), rows: noticed, empty: t("Nothing new. BARRY only speaks up with evidence.", "אין משהו חדש. BARRY מדבר רק כשיש ראיות.") },
    { id: "done", label: t("Done", "הסתיים"), rows: done, empty: t("Nothing finished in the last while.", "לא הסתיים כלום לאחרונה.") },
  ];
  const shown = filter === "all" ? groups.filter((g) => g.id !== "done" && g.rows.length) : groups.filter((g) => g.id === filter);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">{t("Work", "עבודה")}</h2>
        <p className="text-sm text-muted-foreground">{t("What needs you, what BARRY is doing, and what it noticed.", "מה מחכה לך, מה BARRY עושה, ומה הוא שם לב.")}</p>
      </div>

      {notice && (
        <Alert variant={notice.bad ? "destructive" : "default"} data-testid="work-notice">
          {notice.bad ? <CircleAlertIcon /> : <CheckIcon />}
          <AlertDescription className="flex w-full flex-row items-start justify-between gap-3 text-foreground">
            <span>{notice.text}</span>
            <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setNotice(null)}>{t("Dismiss", "סגירה")}</button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} dir={dir}>
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0">
          <TabsList className="w-max">
            <TabsTrigger value="all">{t("All", "הכול")}</TabsTrigger>
            {groups.map((g) => (
              <TabsTrigger key={g.id} value={g.id} data-testid={`work-filter-${g.id}`}>
                {g.label}
                {g.id !== "done" && g.rows.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{g.rows.length}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      {shown.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia><InboxIcon /></EmptyMedia>
            <EmptyTitle>{t("All clear", "הכול שקט")}</EmptyTitle>
            <EmptyDescription>{t("Nothing needs you and nothing is running. BARRY is watching.", "שום דבר לא מחכה לך ושום דבר לא רץ. BARRY על המשמר.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        shown.map((g) => (
          <Section key={g.id} title={filter === "all" ? `${g.label} · ${g.rows.length}` : g.label}>
            {g.rows.length ? (
              <div role="list" className="flex flex-col divide-y overflow-hidden rounded-lg border" data-testid={`work-group-${g.id}`}>
                {g.rows.map((r) => <WorkRow key={r.key} row={r} lang={lang} now={now} onOpen={() => setOpened(r.open)} />)}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{g.empty}</p>
            )}
          </Section>
        ))
      )}

      <WorkSheet opened={opened} onClose={() => setOpened(null)} ws={ws} actions={actions} lang={lang} dir={dir} t={t} now={now} onDone={(text, bad) => setNotice({ text, bad })} />
    </>
  );
}

function WorkRow({ row, lang, now, onOpen }: { row: Row; lang: OwnerLang; now: number; onOpen: () => void }) {
  const Icon = ICON[row.stand];
  const you = row.stand === "you";
  return (
    <button type="button" role="listitem" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-start outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50" data-testid="work-row">
      <Icon className={`size-4 shrink-0 ${you ? "text-foreground" : "text-muted-foreground"}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{row.title}</span>
        <span className="truncate text-sm text-muted-foreground">
          {row.state && <span className={you ? "text-foreground" : undefined}>{row.state}</span>}
          {row.state && row.detail ? " · " : null}
          {row.detail}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {row.amount ? <span className="text-sm font-medium tabular-nums"><bdi>{row.amount}</bdi></span> : null}
        <span className="text-xs tabular-nums text-muted-foreground">{ageOf(lang, row.at, now)}</span>
      </span>
      <ChevronRightIcon className="hidden size-4 shrink-0 text-muted-foreground sm:block rtl:rotate-180" />
    </button>
  );
}

// ── Detail ────────────────────────────────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm leading-relaxed">{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums"><bdi>{value}</bdi></span>
    </div>
  );
}

function WorkSheet({ opened, onClose, ws, actions, lang, dir, t, now, onDone }: { opened: Opened | null; onClose: () => void; ws: OwnerWorkspace; actions: WorkActions; lang: OwnerLang; dir: "ltr" | "rtl"; t: T; now: number; onDone: (text: string, bad?: boolean) => void }) {
  return (
    <Sheet open={Boolean(opened)} onOpenChange={(o) => !o && onClose()}>
      {opened && (
        <SheetContent side="auto" dir={dir} data-testid="work-sheet">
          {opened.kind === "decision" && <DecisionDetail item={opened.item} actions={actions} lang={lang} t={t} now={now} onClose={onClose} onDone={onDone} />}
          {opened.kind === "work" && <ProgressDetail w={opened.item} ws={ws} lang={lang} t={t} />}
          {opened.kind === "noticed" && <NoticedDetail i={opened.item} actions={actions} lang={lang} t={t} onClose={onClose} onDone={onDone} />}
          {opened.kind === "approval" && <ApprovalDetail a={opened.item} lang={lang} t={t} now={now} />}
          {opened.kind === "finished" && <FinishedDetail o={opened.item} lang={lang} t={t} />}
        </SheetContent>
      )}
    </Sheet>
  );
}

const conversationHref = (id: string) => `/owner?tab=work&conversation=${encodeURIComponent(id)}`;

function DecisionDetail({ item, actions, lang, t, now, onClose, onDone }: { item: Intervention; actions: WorkActions; lang: OwnerLang; t: T; now: number; onClose: () => void; onDone: (text: string, bad?: boolean) => void }) {
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
  const needsConfirm = (o: InterventionOption) => o.action === "approve" || o.action === "decline" || o.destructive;
  return (
    <>
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge>{t("Needs you", "מחכה לך")}</Badge>
          <span>{INTERVENTION_KIND[item.kind].label[lang]}</span>
          <span>·</span>
          <span className="tabular-nums">{ageOf(lang, item.since, now)}</span>
        </div>
        <SheetTitle className="text-lg leading-snug">{item.title}</SheetTitle>
        <SheetDescription><bdi>{item.customer}</bdi></SheetDescription>
      </SheetHeader>
      <SheetBody>
        <dl className="flex flex-col gap-5">
          {item.amount && <Field label={t("Amount", "סכום")}><span className="text-xl font-semibold tabular-nums"><bdi>{item.amount}</bdi></span></Field>}
          <Field label={t("What you need to do", "מה צריך ממך")}><span className="font-medium">{item.decision}</span></Field>
          <Field label={t("Why it's with you", "למה זה אצלך")}>{item.why}</Field>
          {item.tried.length > 0 && (
            <Field label={t("What BARRY already did", "מה BARRY כבר עשה")}>
              <ol className="flex flex-col gap-1.5">
                {item.tried.map((x, i) => (
                  <li key={i} className="flex gap-2"><CheckIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" /><span><bdi>{x}</bdi></span></li>
                ))}
              </ol>
            </Field>
          )}
          <Field label={t("What happens next", "מה קורה אחר כך")}>{item.then}</Field>
          <details className="group rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer select-none text-muted-foreground">{t("How current this is · records", "כמה זה עדכני · רשומות")}</summary>
            <p className="mt-2">{item.freshness}</p>
            <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground" dir="ltr">{item.evidence.map((e) => <li key={e} className="break-all">{e}</li>)}</ul>
          </details>
        </dl>
      </SheetBody>
      <SheetFooter className="border-t">
        {ordered.map((o, i) => (
          <Button key={o.action} variant={i === 0 ? "default" : o.destructive || o.action === "decline" ? "outline" : "secondary"} className={o.destructive || o.action === "decline" ? "text-destructive" : undefined} disabled={busy} onClick={() => (needsConfirm(o) ? setConfirm(o) : void run(o))} data-testid={`work-act-${o.action}`}>
            {o.label}
          </Button>
        ))}
        <Button variant="ghost" asChild>
          <Link href={conversationHref(item.conversationId)}>{t("Open the conversation", "לפתוח את השיחה")}</Link>
        </Button>
      </SheetFooter>

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

function ProgressDetail({ w, ws, lang, t }: { w: ActiveWork; ws: OwnerWorkspace; lang: OwnerLang; t: T }) {
  const words = proactiveWords(w.workflow, lang);
  const op = w.operationId ? ws.ownerOperations.find((o) => o.id === w.operationId) : undefined;
  const flow = workflows(ws, lang).find((f) => f.kind === w.workflow);
  const command = op ? ws.ownerCommands.find((c) => c.operationId === op.id) : undefined;
  const p = op?.progress;
  const working = w.state === "working";
  return (
    <>
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={working ? "secondary" : "outline"}>{working ? t("BARRY working", "BARRY עובד") : t("Waiting on customers", "מחכה ללקוחות")}</Badge>
          <span>{op ? (op.requestedBy.source === "whatsapp" ? t("You asked on WhatsApp", "ביקשת בוואטסאפ") : t("You asked here", "ביקשת כאן")) : t("Your follow-up rule", "כלל המעקב שלך")}</span>
        </div>
        <SheetTitle className="text-lg leading-snug">{words.title}</SheetTitle>
        {command && <SheetDescription dir="auto">“{command.text}”</SheetDescription>}
      </SheetHeader>
      <SheetBody>
        <div className="flex flex-col gap-5">
          <div className="divide-y rounded-lg border px-4">
            {p ? (
              <>
                <Stat label={t("Customers in scope", "לקוחות בטווח")} value={p.cohort} />
                <Stat label={t("Reached", "קיבלו פנייה")} value={p.contacted} />
                <Stat label={t("Replied", "ענו")} value={p.replied} />
                <Stat label={t("Bought", "קנו")} value={p.purchased} />
                {p.failed > 0 && <Stat label={t("Failed", "נכשלו")} value={p.failed} />}
                {hasMoney(p.recovered) && <Stat label={t("Recovered (verified)", "הוחזר (מאומת)")} value={money(lang, p.recovered)} />}
              </>
            ) : flow ? (
              <>
                <Stat label={t("Found", "נמצאו")} value={flow.open} />
                <Stat label={t("Reached", "קיבלו פנייה")} value={flow.contacted} />
                <Stat label={t("Waiting on the customer", "מחכים ללקוח")} value={flow.waiting} />
                <Stat label={flow.closedLabel} value={flow.closed} />
                {hasMoney(flow.recovered) && <Stat label={t("Recovered (verified)", "הוחזר (מאומת)")} value={money(lang, flow.recovered)} />}
                {hasMoney(flow.atStake) && <Stat label={t("Still open · not revenue", "עדיין פתוח · לא הכנסה")} value={money(lang, flow.atStake)} />}
              </>
            ) : null}
          </div>
          {(p?.test || flow?.testItems) ? <p className="text-sm text-muted-foreground">{t("Some customers here are on BARRY's simulator — counted, never as money.", "חלק מהלקוחות כאן על הסימולטור — נספרים, אבל אף פעם לא ככסף.")}</p> : null}
          <p className="text-sm text-muted-foreground">{t("BARRY only messages customers who already talk to you, within your follow-up rules.", "BARRY שולח הודעות רק ללקוחות שכבר מדברים איתך, לפי כללי המעקב שלך.")}</p>
        </div>
      </SheetBody>
      <SheetFooter className="border-t">
        <Button variant="outline" asChild>
          <Link href={`/owner?tab=ask&q=${encodeURIComponent(lang === "he" ? `תעצור: ${words.command}` : `Stop: ${words.command}`)}`}>{t("Ask BARRY to stop it", "לבקש מ־BARRY לעצור")}</Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link href="/owner/rules">{t("Follow-up rules", "כללי מעקב")}</Link>
        </Button>
      </SheetFooter>
    </>
  );
}

function NoticedDetail({ i, actions, lang, t, onClose, onDone }: { i: InitiativeView; actions: WorkActions; lang: OwnerLang; t: T; onClose: () => void; onDone: (text: string, bad?: boolean) => void }) {
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
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{c.stateWords}</Badge>
          <span>{c.importance}</span>
          {c.testData && <span>· {t("test data", "נתוני בדיקה")}</span>}
        </div>
        <SheetTitle className="text-lg leading-snug">{c.what}</SheetTitle>
      </SheetHeader>
      <SheetBody>
        <dl className="flex flex-col gap-5">
          <Field label={t("What BARRY saw", "מה BARRY ראה")}><bdi>{c.observation}</bdi></Field>
          <Field label={t("Why it matters", "למה זה חשוב")}>{c.whyItMatters}</Field>
          {c.money && <Field label={t("Money involved", "כסף מעורב")}><bdi>{c.money}</bdi></Field>}
          <Field label={t("Next step", "הצעד הבא")}><bdi>{c.next}</bdi></Field>
          <Field label={t("Who decides", "מי מחליט")}>{c.approval}</Field>
          {c.handling && <Field label={t("Being handled", "בטיפול")}>{c.handling}</Field>}
          {c.result && <Field label={t("Result", "תוצאה")}>{c.result}</Field>}
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer select-none text-muted-foreground">{t("Evidence", "ראיות")}</summary>
            <p className="mt-2">{c.evidence}</p>
            <p className="mt-1 text-xs text-muted-foreground">{c.confidence}</p>
          </details>
        </dl>
      </SheetBody>
      {live && (
        <SheetFooter className="border-t">
          {c.canAct && c.action?.kind === "command" && <Button disabled={busy} onClick={() => setConfirm(true)} data-testid="noticed-act">{c.action.label}</Button>}
          {c.action?.kind === "link" && <Button asChild><Link href={c.action.href}>{c.action.label}</Link></Button>}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void run("snooze")}>{t("Snooze a week", "לדחות לשבוע")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void run("dismiss")}>{t("Dismiss", "להסיר")}</Button>
          </div>
        </SheetFooter>
      )}
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

function ApprovalDetail({ a, lang, t, now }: { a: OwnerApproval; lang: OwnerLang; t: T; now: number }) {
  const l = LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved;
  return (
    <>
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{l.label[lang]}</Badge>
          <span className="tabular-nums">{ageOf(lang, a.createdAt, now)}</span>
        </div>
        <SheetTitle className="text-lg leading-snug"><bdi>{a.what}</bdi></SheetTitle>
        <SheetDescription><bdi>{a.customer}</bdi></SheetDescription>
      </SheetHeader>
      <SheetBody>
        <dl className="flex flex-col gap-5">
          {a.amount && <Field label={t("Amount", "סכום")}><bdi>{a.amount}</bdi></Field>}
          <Field label={t("Why it needed you", "למה זה היה צריך אותך")}>{a.whyApproval}</Field>
          {a.result && <Field label={t("Result", "תוצאה")}><bdi>{a.result}</bdi></Field>}
        </dl>
      </SheetBody>
      <SheetFooter className="border-t">
        <Button variant="outline" asChild>
          <Link href={conversationHref(a.conversationId)}>{t("Open the conversation", "לפתוח את השיחה")}</Link>
        </Button>
      </SheetFooter>
    </>
  );
}

function FinishedDetail({ o, lang, t }: { o: OwnerWorkspace["ownerOperations"][number]; lang: OwnerLang; t: T }) {
  const p = o.progress;
  return (
    <>
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{o.derivedState === "stopped" ? t("Stopped by you", "נעצר על ידך") : o.derivedState === "completed" ? t("Completed", "הושלם") : t("Didn't finish", "לא הסתיים")}</Badge>
        </div>
        <SheetTitle className="text-lg leading-snug">{proactiveWords(o.workflow, lang).title}</SheetTitle>
      </SheetHeader>
      <SheetBody>
        <div className="divide-y rounded-lg border px-4">
          <Stat label={t("Customers in scope", "לקוחות בטווח")} value={p.cohort} />
          <Stat label={t("Reached", "קיבלו פנייה")} value={p.contacted} />
          <Stat label={t("Replied", "ענו")} value={p.replied} />
          <Stat label={t("Bought", "קנו")} value={p.purchased} />
          {hasMoney(p.recovered) && <Stat label={t("Recovered (verified)", "הוחזר (מאומת)")} value={money(lang, p.recovered)} />}
        </div>
        {o.stoppedAt && <p className="mt-4 text-sm text-muted-foreground">{t("Stopped by you — messages already sent stay sent.", "נעצר על ידך — הודעות שכבר נשלחו נשארות.")}</p>}
      </SheetBody>
    </>
  );
}
