"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { InitiativeView } from "@/lib/initiative/model";
import type { Intervention } from "@/lib/owner/interventions";
import type { OwnerReply } from "@/lib/owner/command-service";
import { activeWork, proactiveWords, workflows, type ActiveWork } from "@/lib/owner/control-room";
import { noticedCard, workStateWords, type WorkState } from "@/lib/owner/os";
import { ago, money, type OwnerLang } from "@/lib/owner/lang";
import { hasMoney } from "@/lib/format/money";
import { useOwnerLang } from "../lang";
import { Button, Chip, ConfirmButton, Disclosure, Empty, Field, Group, Lead, PageHeader, Row, Segments, Sheet, type Tone } from "../os-ui";
import { DecisionRow } from "./decision";
import { LIFECYCLE } from "./shared";

/**
 * WORK — everything BARRY is doing or noticed, in one vocabulary, three tabs:
 *   NEEDS YOU     decisions (the same queue WhatsApp approves from) — not audit records
 *   IN PROGRESS   real active work only (the same definition Today counts)
 *   NOTICED       observations with evidence; the engine's dedupe / fatigue rules decide what shows
 * Rows answer what / state / why it matters; a sheet carries the rest. Nothing here acts on its own.
 */

export type InitiativeAct = (id: string, action: "review" | "dismiss" | "snooze" | "act") => Promise<OwnerReply | void>;
type View = "needs" | "working" | "noticed";
const HASH: Record<string, View> = { "#needs-you": "needs", "#working": "working", "#noticed": "noticed" };

export const WORK_TONE: Record<WorkState, Tone> = { new: "violet", watching: "neutral", working: "info", waiting_on_you: "warn", waiting_on_customer: "neutral", done: "ok", dismissed: "neutral", snoozed: "neutral" };

export function WorkView({ ws, onDecision, onOpen, onInitiative, onAsk }: { ws: OwnerWorkspace; onDecision: (item: Intervention) => void; onOpen: (id: string) => void; onInitiative: InitiativeAct; onAsk: (q: string) => void }) {
  const { lang, t } = useOwnerLang();
  const work = activeWork(ws);
  const queue = ws.interventions;
  const noticed = ws.initiatives;
  const [view, setView] = useState<View>(() => (queue.length ? "needs" : work.length ? "working" : noticed.length ? "noticed" : "needs"));
  const [opened, setOpened] = useState<ActiveWork | null>(null);
  const [openedNoticed, setOpenedNoticed] = useState<InitiativeView | null>(null);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    const fromHash = () => {
      const v = HASH[window.location.hash];
      if (v) setView(v);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  // A deep link to an operation (?operation=…) opens it.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("operation");
    const hit = id ? work.find((w) => w.operationId === id) : undefined;
    if (!hit) return;
    const t0 = setTimeout(() => {
      setView("working");
      setOpened(hit);
    }, 0);
    return () => clearTimeout(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const decided = ws.approvals.filter((a) => !(a.actionable || a.lifecycle === "held")).slice(0, 12);
  const pastOps = ws.ownerOperations.filter((o) => o.derivedState === "completed" || o.derivedState === "stopped" || o.derivedState === "blocked" || o.derivedState === "failed").slice(0, 6);
  const shownNoticed = history ? ws.initiativeHistory ?? [] : noticed;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("Work", "עבודה")} sub={t("Decisions waiting for you, what BARRY is doing, and what it noticed.", "החלטות שמחכות לך, מה BARRY עושה, ומה הוא שם לב.")} />
      <Segments<View>
        ariaLabel={t("Work", "עבודה")}
        value={view}
        onChange={(v) => {
          setView(v);
          setHistory(false);
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${v === "needs" ? "needs-you" : v}`);
        }}
        options={[
          { id: "needs", label: t("Needs you", "צריך אותך"), count: queue.length },
          { id: "working", label: t("In progress", "בעבודה"), count: work.length },
          { id: "noticed", label: t("Noticed", "שם לב"), count: noticed.length },
        ]}
      />

      {view === "needs" && (
        <section id="needs-you" className="flex flex-col gap-3">
          {queue.length ? (
            <Group label={t("Needs you", "צריך אותך")}>{queue.map((i) => <DecisionRow key={i.id} item={i} onOpen={() => onDecision(i)} />)}</Group>
          ) : (
            <Empty title={t("Nothing needs you", "שום דבר לא מחכה לך")}>{t("BARRY is handling everything inside your rules. Approvals, customers who need a person and anything that didn't go through land here first.", "BARRY מטפל בהכול בתוך הכללים שלך. אישורים, לקוחות שצריכים אדם וכל מה שלא הצליח — יגיעו לכאן קודם.")}</Empty>
          )}
          {decided.length > 0 && (
            <div className="o-group px-4">
              <Disclosure summary={t(`Decided recently (${decided.length})`, `הוחלט לאחרונה (${decided.length})`)}>
                <ul className="flex flex-col divide-y divide-o-line">
                  {decided.map((a) => {
                    const l = LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved;
                    return (
                      <li key={a.id}>
                        <button type="button" onClick={() => onOpen(a.conversationId)} className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-start">
                          <span className="min-w-0">
                            <span className="block truncate text-[14px] text-o-ink"><bdi>{a.customer}</bdi> · <bdi>{a.what}</bdi></span>
                            <span className="text-[12px] text-o-faint">{ago(lang, a.createdAt)}</span>
                          </span>
                          <Chip tone={l.tone}>{l.label[lang]}</Chip>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Disclosure>
            </div>
          )}
        </section>
      )}

      {view === "working" && (
        <section id="working" className="flex flex-col gap-3">
          {work.length ? (
            <Group label={t("In progress", "בעבודה")}>
              {work.map((w) => (
                <Row key={w.id} testId="work-row" lead={<Lead icon={w.kind === "operation" ? "bolt" : "clock"} tone="info" />} title={proactiveWords(w.workflow, lang).title} sub={w.kind === "operation" ? t(`You asked · ${w.customers} customers`, `ביקשת · ${w.customers} לקוחות`) : t(`Your follow-up rule · ${w.customers} open`, `כלל המעקב שלך · ${w.customers} פתוחים`)} chip={<Chip tone={w.state === "working" ? "info" : "neutral"}>{workStateWords(w.state, lang)}</Chip>} onClick={() => setOpened(w)} />
              ))}
            </Group>
          ) : (
            <Empty title={t("Nothing running right now", "שום דבר לא רץ כרגע")}>{t("When a payment link goes unpaid or a checkout is left behind, BARRY follows up under your rules — or ask it to (“Recover abandoned checkouts”).", "כשקישור תשלום לא משולם או שעגלה ננטשת, BARRY עוקב לפי הכללים שלך — או שתבקש ממנו (״תחזיר עגלות נטושות״).")}</Empty>
          )}
          {pastOps.length > 0 && (
            <div className="o-group px-4">
              <Disclosure summary={t(`Finished or stopped (${pastOps.length})`, `הסתיים או נעצר (${pastOps.length})`)}>
                <ul className="flex flex-col divide-y divide-o-line text-[14px]">
                  {pastOps.map((o) => (
                    <li key={o.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                      <span className="min-w-0 truncate text-o-ink">{proactiveWords(o.workflow, lang).title}</span>
                      <span className="shrink-0 text-[12px] text-o-faint">{t(`${o.progress.contacted} contacted · ${o.progress.purchased} bought`, `${o.progress.contacted} קיבלו הודעה · ${o.progress.purchased} קנו`)}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </div>
          )}
        </section>
      )}

      {view === "noticed" && (
        <section id="noticed" className="flex flex-col gap-3">
          {shownNoticed.length ? (
            <Group label={t("BARRY noticed", "BARRY שם לב")}>
              {shownNoticed.map((i) => {
                const c = noticedCard(i, lang);
                return <Row key={i.id} testId="noticed-row" lead={<Lead icon="spark" tone="violet" />} title={c.what} sub={c.importance} chip={<Chip tone={WORK_TONE[c.state]}>{c.stateWords}</Chip>} onClick={() => setOpenedNoticed(i)} />;
              })}
            </Group>
          ) : (
            <Empty title={history ? t("Nothing in the last two weeks", "אין כלום בשבועיים האחרונים") : t("Nothing new", "אין משהו חדש")}>{history ? undefined : t("BARRY looks over your records a few times a day and only speaks up with evidence.", "BARRY עובר על הרשומות שלך כמה פעמים ביום, ומדבר רק כשיש ראיות.")}</Empty>
          )}
          {(ws.initiativeHistory?.length ?? 0) > 0 && (
            <button type="button" className="self-start px-1 text-[13.5px] font-medium text-o-accent" onClick={() => setHistory((h) => !h)}>
              {history ? t("Back to open items", "חזרה לפתוחים") : t(`Done & dismissed (${ws.initiativeHistory!.length})`, `הושלם ונדחה (${ws.initiativeHistory!.length})`)}
            </button>
          )}
        </section>
      )}

      {opened && <WorkSheet w={opened} ws={ws} onClose={() => setOpened(null)} onAsk={onAsk} lang={lang} />}
      {openedNoticed && <NoticedSheet i={openedNoticed} onClose={() => setOpenedNoticed(null)} onAct={onInitiative} onAsk={onAsk} />}
    </div>
  );
}

function WorkSheet({ w, ws, onClose, onAsk, lang }: { w: ActiveWork; ws: OwnerWorkspace; onClose: () => void; onAsk: (q: string) => void; lang: OwnerLang }) {
  const { t } = useOwnerLang();
  const words = proactiveWords(w.workflow, lang);
  const op = w.operationId ? ws.ownerOperations.find((o) => o.id === w.operationId) : undefined;
  const flow = workflows(ws, lang).find((f) => f.kind === w.workflow);
  const command = op ? ws.ownerCommands.find((c) => c.operationId === op.id) : undefined;
  const p = op?.progress;
  return (
    <Sheet open onClose={onClose} title={words.title} testId="work-sheet" footer={<Button full onClick={() => onAsk(lang === "he" ? `תעצור: ${words.command}` : `Stop: ${words.command}`)}>{t("Ask BARRY to stop it", "לבקש מ־BARRY לעצור")}</Button>}>
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-o-muted"><Chip tone={w.state === "working" ? "info" : "neutral"}>{workStateWords(w.state, lang)}</Chip>{op ? t(`Started ${op.requestedBy.source === "whatsapp" ? "on WhatsApp" : "here"} · ${ago(lang, op.createdAt)}`, `התחיל ${op.requestedBy.source === "whatsapp" ? "בוואטסאפ" : "כאן"} · ${ago(lang, op.createdAt)}`) : t("Runs under your follow-up rule", "רץ לפי כלל המעקב שלך")}</p>
        {command && <p className="rounded-xl bg-o-sunken px-3 py-2 text-[14px] text-o-ink-2" dir="auto">“{command.text}”</p>}
        {p ? (
          <dl className="grid grid-cols-2 gap-3">
            <Field label={t("Customers found", "לקוחות שנמצאו")}>{p.cohort}</Field>
            <Field label={t("Contacted", "קיבלו הודעה")}>{p.contacted}</Field>
            <Field label={t("Replied", "ענו")}>{p.replied}</Field>
            <Field label={t("Bought", "קנו")}>{p.purchased}</Field>
            {p.stillTalking > 0 && <Field label={t("Still talking", "עדיין מדברים")}>{p.stillTalking}</Field>}
            {p.failed > 0 && <Field label={t("Failed", "נכשלו")}>{p.failed}</Field>}
            {hasMoney(p.recovered) && <Field label={t("Recovered (verified)", "הוחזר (מאומת)")}><bdi>{money(lang, p.recovered)}</bdi></Field>}
          </dl>
        ) : flow ? (
          <dl className="grid grid-cols-2 gap-3">
            <Field label={t("Open now", "פתוחים עכשיו")}>{flow.open}</Field>
            <Field label={t("Followed up", "קיבלו מעקב")}>{flow.contacted}</Field>
            <Field label={t("Waiting on customer", "מחכים ללקוח")}>{flow.waiting}</Field>
            <Field label={flow.closedLabel}>{flow.closed}</Field>
            {hasMoney(flow.recovered) && <Field label={t("Recovered (verified)", "הוחזר (מאומת)")}><bdi>{money(lang, flow.recovered)}</bdi></Field>}
            {hasMoney(flow.atStake) && <Field label={t("Still open (not revenue)", "עדיין פתוח (לא הכנסה)")}><bdi>{money(lang, flow.atStake)}</bdi></Field>}
          </dl>
        ) : null}
        {(p?.test || flow?.testItems) ? <p className="text-[13px] text-o-muted">{t("Some customers here are on BARRY's simulator — counted, never as money.", "חלק מהלקוחות כאן על הסימולטור של BARRY — נספרים, אבל אף פעם לא ככסף.")}</p> : null}
        {op?.stoppedAt && <p className="text-[13px] text-o-muted">{t("Stopped by you — messages already sent stay sent.", "נעצר על ידך — הודעות שכבר נשלחו נשארות.")}</p>}
        <p className="text-[13px] leading-5 text-o-muted">{t("BARRY only messages customers who already talk to you, within your follow-up rules.", "BARRY שולח הודעות רק ללקוחות שכבר מדברים איתך, לפי כללי המעקב שלך.")} <Link href="/owner/rules" className="font-medium text-o-accent">{t("Rules", "כללים")}</Link></p>
      </div>
    </Sheet>
  );
}

function NoticedSheet({ i, onClose, onAct, onAsk }: { i: InitiativeView; onClose: () => void; onAct: InitiativeAct; onAsk: (q: string) => void }) {
  const { lang, t } = useOwnerLang();
  const c = noticedCard(i, lang);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const live = c.state === "new" || c.state === "watching" || c.state === "working";
  useEffect(() => {
    if (c.state === "new") void onAct(i.id, "review").catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (action: Parameters<InitiativeAct>[1]) => {
    setBusy(true);
    try {
      const r = await onAct(i.id, action);
      if (r) setReply(r.text);
      else if (action !== "act") onClose();
    } catch {
      setReply(t("Something went wrong — nothing was changed.", "משהו השתבש — שום דבר לא השתנה."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={c.what}
      testId="noticed-sheet"
      footer={
        live ? (
          <div className="flex flex-col gap-2">
            {c.canAct && c.action?.kind === "command" && <ConfirmButton testId="noticed-act" label={c.action.label} confirmLabel={t("Yes, go ahead", "כן, להתחיל")} consequence={t("BARRY runs it through your rules and shows you exactly who it reaches.", "BARRY מריץ את זה לפי הכללים שלך ומראה לך בדיוק למי זה מגיע.")} onConfirm={() => run("act")} disabled={busy} />}
            {c.action?.kind === "link" && <Button kind="primary" full href={c.action.href}>{c.action.label}</Button>}
            <div className="grid grid-cols-3 gap-2">
              <Button kind="quiet" onClick={() => onAsk(lang === "he" ? `ספר לי עוד על: ${c.what}` : `Tell me more about: ${c.what}`)}>{t("Ask", "לשאול")}</Button>
              <Button kind="quiet" disabled={busy} onClick={() => void run("snooze")}>{t("Snooze", "לדחות")}</Button>
              <Button kind="quiet" disabled={busy} onClick={() => void run("dismiss")}>{t("Dismiss", "להסיר")}</Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-o-muted"><Chip tone={WORK_TONE[c.state]}>{c.stateWords}</Chip>{c.importance}{c.testData ? ` · ${t("test data", "נתוני בדיקה")}` : ""}</p>
        <p className="text-[15px] leading-6 text-o-ink"><bdi>{c.observation}</bdi></p>
        <dl className="flex flex-col gap-3">
          <Field label={t("Why it matters", "למה זה חשוב")}>{c.whyItMatters}</Field>
          {c.money && <Field label={t("Money involved", "כסף מעורב")}><bdi>{c.money}</bdi></Field>}
          <Field label={t("Next step", "הצעד הבא")}><bdi>{c.next}</bdi></Field>
          <Field label={t("Who decides", "מי מחליט")}>{c.approval}</Field>
          <Field label={t("Can BARRY act?", "BARRY יכול לפעול?")}>{c.canActWords}</Field>
          {c.handling && <Field label={t("Being handled", "בטיפול")}>{c.handling}</Field>}
          {c.result && <Field label={t("Result", "תוצאה")}>{c.result}</Field>}
        </dl>
        <div className="border-y border-o-line">
          <Disclosure summary={t("Evidence", "ראיות")}>
            <p className="text-[13.5px] text-o-ink-2">{c.evidence}</p>
            <p className="mt-1 text-[12.5px] text-o-faint">{c.confidence}</p>
          </Disclosure>
        </div>
        {reply && <p className="whitespace-pre-wrap rounded-xl bg-o-sunken px-3 py-2.5 text-[14px] leading-6 text-o-ink-2" dir="auto">{reply}</p>}
      </div>
    </Sheet>
  );
}
