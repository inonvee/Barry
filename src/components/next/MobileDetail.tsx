"use client";

import * as React from "react";
import Link from "next/link";
import { CheckIcon, ChevronDownIcon, MoreHorizontalIcon, OctagonAlertIcon, XIcon } from "lucide-react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { Intervention, InterventionOption } from "@/lib/owner/interventions";
import type { InitiativeView } from "@/lib/initiative/model";
import type { ActiveWork } from "@/lib/owner/control-room";
import { noticedCard } from "@/lib/owner/os";
import { money, type OwnerLang } from "@/lib/owner/lang";
import { hasMoney } from "@/lib/format/money";
import { INTERVENTION_KIND, LIFECYCLE } from "@/components/owner/views/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress, Status, Thumb, toneText, type Tone } from "@/components/app-shell/kit";
import { STAND, ageOf, clockOf, workProgress, type Row, type T } from "./model";
import { conversationHref, type WorkActions } from "./WorkNext";

/**
 * THE PHONE DETAIL — the same situation as the desktop pane, reorganised for a thumb:
 *   a small facts strip · Situation · What BARRY did (latest few, the rest on demand) · What is blocking (said once) ·
 *   and the owner's action pinned to the bottom of the sheet so it's always reachable. Same actions, same endpoints,
 *   same confirmations as desktop.
 */

type Props = { row: Row; ws: OwnerWorkspace; actions: WorkActions; lang: OwnerLang; t: T; now: number; onClose: () => void; onDone: (text: string, bad?: boolean) => void };
type Act = { key: string; label: string; run?: () => void; href?: string; tone?: "danger" };

export function MobileDetail(p: Props) {
  const { row, lang, t, now, onClose } = p;
  const s = STAND[row.stand];
  const o = row.open;
  const body =
    o.kind === "decision" ? <DecisionKind {...p} item={o.item} /> : o.kind === "work" ? <ProgressKind {...p} w={o.item} /> : o.kind === "noticed" ? <NoticedKind {...p} i={o.item} /> : o.kind === "approval" ? approval(p, o.item) : finished(p, o.item);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="work-detail-body">
      <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />
      <header className="flex shrink-0 items-start gap-3 px-4 pb-3 pt-3">
        <Thumb icon={row.person ? undefined : row.icon} name={row.person} tone={row.person ? "muted" : s.tone} size="md" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Status tone={s.tone} className="h-5 px-2 text-[11px]">{row.status ?? s.label[lang === "he" ? 1 : 0]}</Status>
            <span className="text-xs tabular-nums text-muted-foreground">{ageOf(lang, row.at, now)}</span>
          </div>
          <h2 className="line-clamp-2 text-[17px] font-semibold leading-snug">{row.title}</h2>
        </div>
        <Button variant="ghost" size="icon-sm" className="-me-1.5 shrink-0 text-muted-foreground" onClick={onClose} aria-label={t("Close", "סגירה")}>
          <XIcon />
        </Button>
      </header>
      {body}
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────────────────────────────────

function Facts({ items }: { items: { label: string; value: React.ReactNode; tone?: Tone; narrow?: boolean }[] }) {
  // Short values (an age, a count) take a narrow column so words like "Needs a person" don't truncate.
  return (
    <dl className="grid shrink-0 overflow-hidden rounded-lg border bg-background/40 [&>*+*]:border-s" style={{ gridTemplateColumns: items.map((i) => (i.narrow ? "minmax(0, 0.6fr)" : "minmax(0, 1.2fr)")).join(" ") }}>
      {items.map((f) => (
        <div key={f.label} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
          <dt className="truncate text-[11px] text-muted-foreground">{f.label}</dt>
          <dd className={`truncate text-[13px] font-semibold tabular-nums ${f.tone ? toneText(f.tone) : ""}`}><bdi>{f.value}</bdi></dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-semibold text-muted-foreground">{title}</h3>
      <div className="text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function Did({ items, t, more }: { items: string[]; t: T; more?: React.ReactNode }) {
  const [all, setAll] = React.useState(false);
  // The latest few tell the story; the full trail is one tap away.
  const shown = all || items.length <= 4 ? items : items.slice(-3);
  return (
    <Block title={t("What BARRY did", "מה BARRY עשה")}>
      <ol className="flex flex-col gap-1.5">
        {shown.map((x, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full bg-live text-background"><CheckIcon className="size-3" strokeWidth={3} /></span>
            <span className="min-w-0">{x}</span>
          </li>
        ))}
      </ol>
      {more}
      {items.length > 4 && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1.5 flex items-center gap-1 text-[13px] font-medium text-info">
          {all ? t("Show less", "פחות") : t(`View all activity (${items.length})`, `כל הפעילות (${items.length})`)}
          <ChevronDownIcon className={`size-4 transition-transform ${all ? "rotate-180" : ""}`} />
        </button>
      )}
    </Block>
  );
}

function Blocking({ title, children, tone = "hot" }: { title: string; children: React.ReactNode; tone?: "hot" | "info" | "muted" }) {
  const box = tone === "hot" ? "border-hot/25 bg-hot/8" : tone === "info" ? "border-info/25 bg-info/8" : "bg-background/40";
  const icon = tone === "hot" ? "text-hot" : tone === "info" ? "text-info" : "text-muted-foreground";
  return (
    <section className={`flex gap-2.5 rounded-lg border px-3 py-2.5 ${box}`}>
      <OctagonAlertIcon className={`mt-0.5 size-4 shrink-0 ${icon}`} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <div className="text-sm leading-relaxed text-foreground/90">{children}</div>
      </div>
    </section>
  );
}

function More({ t, children }: { t: T; children: React.ReactNode }) {
  return (
    <details className="group text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[13px] text-muted-foreground">
        {t("More details", "פרטים נוספים")}
        <ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-muted-foreground">{children}</div>
    </details>
  );
}

/** The owner's next move, pinned to the bottom of the sheet: one primary, the rest behind a menu. */
function ActionBar({ actions, t }: { actions: Act[]; t: T }) {
  const [primary, ...rest] = actions;
  const cls = "h-11 flex-1 rounded-xl text-[15px]";
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t bg-card px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3" data-testid="work-actionbar">
      {primary.href ? (
        <Button asChild className={cls}><Link href={primary.href}>{primary.label}</Link></Button>
      ) : (
        <Button className={cls} onClick={primary.run} data-testid={`work-act-${primary.key}`}>{primary.label}</Button>
      )}
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="size-11 shrink-0 rounded-xl" aria-label={t("More actions", "עוד פעולות")} data-testid="work-more">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-60">
            {rest.map((a) =>
              a.href ? (
                <DropdownMenuItem key={a.key} asChild>
                  <Link href={a.href}>{a.label}</Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={a.key} onSelect={a.run} variant={a.tone === "danger" ? "destructive" : "default"}>{a.label}</DropdownMenuItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </footer>
  );
}

function Confirm({ open, title, description, yes, danger, busy, onYes, onCancel, t }: { open: boolean; title: string; description: string; yes: string; danger?: boolean; busy: boolean; onYes: () => void; onCancel: () => void; t: T }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("Cancel", "ביטול")}</Button>
          </DialogClose>
          <Button variant={danger ? "destructive" : "default"} disabled={busy} onClick={onYes} data-testid="work-confirm">{yes}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Kinds (hooks live in small components so each kind keeps its own state) ──────────────────────────────

function approval(p: Props, a: OwnerWorkspace["approvals"][number]) {
  const { lang, t } = p;
  const l = LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved;
  return (
    <Shell
      t={t}
      content={(
      <>
        <Facts items={[{ label: t("Result", "תוצאה"), value: l.label[lang] }, { label: t("Amount", "סכום"), value: a.amount ?? "—" }, { label: t("Customer", "לקוח"), value: a.customer }]} />
        <Block title={t("Situation", "המצב")}>{a.whyApproval}{a.result ? <> {a.result}</> : null}</Block>
      </>
      )}
      actions={[{ key: "conversation", label: t("Open the conversation", "לפתוח את השיחה"), href: conversationHref(a.conversationId) }]}
    />
  );
}
function finished(p: Props, o: OwnerWorkspace["ownerOperations"][number]) {
  const { lang, t } = p;
  const pr = o.progress;
  return (
    <Shell
      t={t}
      actions={[]}
      content={(
      <>
        <Facts items={[{ label: t("Reached", "קיבלו פנייה"), value: pr.contacted }, { label: t("Replied", "ענו"), value: pr.replied }, { label: t("Bought", "קנו"), value: pr.purchased }]} />
        {hasMoney(pr.recovered) && <Block title={t("Recovered (verified)", "הוחזר (מאומת)")}><bdi className="font-semibold text-live">{money(lang, pr.recovered)}</bdi></Block>}
        {o.stoppedAt && <p className="text-sm text-muted-foreground">{t("Stopped by you — messages already sent stay sent.", "נעצר על ידך — הודעות שכבר נשלחו נשארות.")}</p>}
      </>
      )}
    />
  );
}

/** Every kind: a scrolling body and, when the owner can act, the pinned action bar. */
function Shell({ content, actions, dialogs, t }: { content: React.ReactNode; actions: Act[]; dialogs?: React.ReactNode; t: T }) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-4">{content}</div>
      {actions.length > 0 && <ActionBar actions={actions} t={t} />}
      {dialogs}
    </>
  );
}

function DecisionKind({ item, ws, actions, lang, t, now, onClose, onDone }: Props & { item: Intervention }) {
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
  const acts: Act[] = [
    ...ordered.map((o) => ({ key: o.action, label: o.label, run: () => (needsConfirm(o) ? setConfirm(o) : void run(o)), tone: o.destructive || o.action === "decline" ? ("danger" as const) : undefined })),
    { key: "conversation", label: t("Open the conversation", "לפתוח את השיחה"), href: conversationHref(item.conversationId) },
  ];
  return (
    <Shell
      t={t}
      actions={acts}
      content={
        <>
          <Facts
            items={[
              item.amount ? { label: t("Amount", "סכום"), value: item.amount, tone: "warn" as Tone } : { label: t("Type", "סוג"), value: INTERVENTION_KIND[item.kind].label[lang] },
              { label: t("Waiting", "מחכה"), value: ageOf(lang, item.since, now), narrow: true },
              { label: t("Customer", "לקוח"), value: item.customer },
            ]}
          />
          <Block title={t("Situation", "המצב")}>{item.why}</Block>
          {item.tried.length > 0 && <Did items={item.tried} t={t} />}
          <Blocking title={t("What is blocking progress", "מה עוצר את ההתקדמות")}>{item.decision}</Blocking>
          <More t={t}>
            <p>{item.then}</p>
            <p>{item.freshness} · {clockOf(lang, ws.business.timezone, item.since, now)}</p>
            <ul className="flex flex-col gap-1 text-xs" dir="ltr">{item.evidence.map((e) => <li key={e} className="break-all">{e}</li>)}</ul>
          </More>
        </>
      }
      dialogs={<Confirm open={Boolean(confirm)} title={`${confirm?.label ?? ""}?`} description={confirm?.consequence ?? ""} yes={confirm?.action === "decline" ? t("Yes, decline", "כן, לדחות") : t("Yes, go ahead", "כן, להמשיך")} danger={Boolean(confirm?.destructive || confirm?.action === "decline")} busy={busy} onYes={() => confirm && void run(confirm)} onCancel={() => setConfirm(null)} t={t} />}
    />
  );
}

function ProgressKind({ w, ws, lang, t, now }: Props & { w: ActiveWork }) {
  const p = workProgress(ws, w, lang, t);
  const command = p.op ? ws.ownerCommands.find((c) => c.operationId === p.op!.id) : undefined;
  const tz = ws.business.timezone;
  const done = p.op ? p.op.progress.purchased : p.flow?.closed ?? 0;
  const ask = lang === "he" ? `מה הסטטוס של ${p.title}?` : `What's the status of ${p.command.toLowerCase()}?`;
  return (
    <Shell
      t={t}
      actions={[
        { key: "ask", label: t("Ask BARRY about it", "לשאול את BARRY"), href: `/owner/next/ask?q=${encodeURIComponent(ask)}` },
        { key: "stop", label: t("Ask BARRY to stop it", "לבקש מ־BARRY לעצור"), href: `/owner?tab=ask&q=${encodeURIComponent(lang === "he" ? `תעצור: ${p.command}` : `Stop: ${p.command}`)}` },
        { key: "rules", label: t("Follow-up rules", "כללי מעקב"), href: "/owner/rules" },
      ]}
      content={
        <>
          <Facts items={[{ label: p.steps[0].label, value: p.steps[0].n }, { label: p.steps[1].label, value: p.steps[1].n, tone: p.steps[1].n ? "live" : undefined }, { label: p.steps[3].label, value: done }]} />
          <div className="flex items-center gap-3">
            <Progress value={p.reached} max={p.found} tone={w.state === "working" ? "live" : "info"} />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{p.reached}/{p.found}</span>
          </div>
          <Block title={t("Situation", "המצב")}>
            {p.op
              ? t(`You asked BARRY${p.op.requestedBy.source === "whatsapp" ? " on WhatsApp" : ""}${command ? `: “${command.text}”` : "."}`, `ביקשת מ־BARRY${p.op.requestedBy.source === "whatsapp" ? " בוואטסאפ" : ""}${command ? `: “${command.text}”` : "."}`)
              : t(`Your follow-up rule picked up ${p.found} open item${p.found === 1 ? "" : "s"}.`, `כלל המעקב שלך זיהה ${p.found} פריטים פתוחים.`)}
          </Block>
          <Did items={p.steps.filter((st) => st.n > 0).map((st) => `${st.label}: ${st.n}`)} t={t} more={p.lastAttempt ? <p className="mt-1 text-xs text-muted-foreground">{t(`Last attempt ${clockOf(lang, tz, p.lastAttempt, now)}`, `ניסיון אחרון ${clockOf(lang, tz, p.lastAttempt, now)}`)}</p> : null} />
          <Blocking tone={p.reached ? "info" : "muted"} title={t("What is blocking progress", "מה עוצר את ההתקדמות")}>
            {p.reached ? t("Customers who were reached haven't replied yet.", "לקוחות שקיבלו פנייה עוד לא ענו.") : t("Nothing sent yet — queued until your follow-up rule's timing allows it.", "עוד לא נשלח כלום — בתור עד שהתזמון בכלל יאפשר.")}
          </Blocking>
          {(p.op?.progress.test || p.flow?.testItems) || (p.flow && hasMoney(p.flow.atStake)) ? (
            <More t={t}>
              {(p.op?.progress.test || p.flow?.testItems) ? <p>{t("Some customers here are on BARRY's simulator — counted, never as money.", "חלק מהלקוחות כאן על הסימולטור — נספרים, אבל אף פעם לא ככסף.")}</p> : null}
              {p.flow && hasMoney(p.flow.atStake) && <p>{t(`Still open (not revenue): ${money(lang, p.flow.atStake)}`, `עדיין פתוח (לא הכנסה): ${money(lang, p.flow.atStake)}`)}</p>}
            </More>
          ) : null}
        </>
      }
    />
  );
}

function NoticedKind({ i, actions, lang, t, onClose, onDone }: Props & { i: InitiativeView }) {
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
  const acts: Act[] = !live
    ? []
    : [
        ...(c.canAct && c.action?.kind === "command" ? [{ key: "act", label: c.action.label, run: () => setConfirm(true) }] : []),
        ...(c.action?.kind === "link" ? [{ key: "link", label: c.action.label, href: c.action.href }] : []),
        { key: "snooze", label: t("Snooze a week", "לדחות לשבוע"), run: () => void run("snooze") },
        { key: "dismiss", label: t("Dismiss", "להסיר"), run: () => void run("dismiss"), tone: "danger" as const },
      ];
  return (
    <Shell
      t={t}
      actions={busy ? [] : acts}
      content={
        <>
          <Facts items={[{ label: t("Status", "מצב"), value: c.stateWords }, { label: t("Importance", "חשיבות"), value: c.importance }, ...(c.money ? [{ label: t("Money", "כסף"), value: c.money, tone: "warn" as Tone }] : [])]} />
          <Block title={t("Situation", "המצב")}>{c.observation}</Block>
          <Block title={t("Why it matters", "למה זה חשוב")}>{c.whyItMatters}</Block>
          <Blocking tone="info" title={t("Next step", "הצעד הבא")}>{c.next}</Blocking>
          <More t={t}>
            <p>{c.approval}</p>
            <p>{c.evidence}</p>
            <p className="text-xs">{c.confidence}</p>
          </More>
        </>
      }
      dialogs={<Confirm open={confirm} title={`${c.action?.label ?? ""}?`} description={t("BARRY runs it through your rules and shows you exactly who it reaches.", "BARRY מריץ את זה לפי הכללים שלך ומראה לך בדיוק למי זה מגיע.")} yes={t("Yes, go ahead", "כן, להתחיל")} busy={busy} onYes={() => void run("act")} onCancel={() => setConfirm(false)} t={t} />}
    />
  );
}
