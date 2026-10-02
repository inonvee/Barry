"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpIcon, ChevronRightIcon, CopyIcon, CircleAlertIcon, MessageSquareIcon, MessageSquareTextIcon, ShoppingBagIcon, TriangleAlertIcon, UsersIcon, WalletIcon } from "lucide-react";
import type { OwnerReply } from "@/lib/owner/command-service";
import { interpretCommand, commandSuggestions, type QueryTopic } from "@/lib/owner/command";
import { isAtRisk } from "@/lib/owner/opportunity-risk";
import { hasMoney } from "@/lib/format/money";
import { amount, money } from "@/lib/owner/lang";
import { useOwnerLang } from "@/components/owner/lang";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/basics";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bars, Metric, Panel, Thumb, type Tone } from "@/components/app-shell/kit";
import { STAND, ageOf, buildRows, clockOf, mainCurrency, sumMoney, type Row } from "./model";
import type { NextCtx } from "./NextFrame";

/**
 * ASK BARRY — a business question goes to the SAME owner command service the WhatsApp channel uses (it answers only
 * from records). The answer leads; the lines it is made of become its factors; the evidence beside it is read from
 * the same workspace records the question is about. Buttons in a reply go back through the command service, which
 * re-checks authority — and they ask first here.
 */

type Answer = { question: string; text: string; reply?: OwnerReply; at: string; topic: QueryTopic | "action" };

/** Current-UI paths in a reply → their rebuilt equivalents where one exists. */
const nextPath = (href: string) =>
  href.replace(/^\/owner\?tab=work(#\w+)?$/, "/owner/next/work").replace(/^\/owner\?tab=money$/, "/owner/next/money").replace(/^\/owner\?tab=today$/, "/owner/next");

/** "Header:\n• line\n  more\n2. line" → the headline and its parts (continuation lines stay with their item). */
function parse(text: string) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const head = (lines.shift() ?? "").trim();
  const items: { title: string; more: string[] }[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const item = raw.match(/^\s*(?:[•\-–]|\d+\.)\s+(.*)$/);
    if (item || !raw.startsWith("  ")) items.push({ title: (item ? item[1] : raw).trim(), more: [] });
    else if (items.length) items[items.length - 1].more.push(raw.trim().replace(/^→\s*/, "→ "));
  }
  return { head: head.replace(/:$/, ""), items };
}

export function AskNext(ctx: NextCtx) {
  const { ws, call, businessId, reload, now } = ctx;
  const { lang, t } = useOwnerLang();
  const tz = ws.business.timezone;
  const [q, setQ] = React.useState("");
  const [answer, setAnswer] = React.useState<Answer | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [confirm, setConfirm] = React.useState<{ id: string; title: string } | null>(null);
  const input = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const pre = new URLSearchParams(window.location.search).get("q");
    if (pre) {
      const t0 = setTimeout(() => setQ(pre), 0);
      return () => clearTimeout(t0);
    }
  }, []);

  const ask = async (body: { text?: string; actionId?: string }, label: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await call<{ reply: OwnerReply }>("/api/owner/command", { body: { businessId, requestId: crypto.randomUUID(), lang, ...body } });
      const intent = body.text ? interpretCommand(body.text).intent : null;
      setAnswer({ question: label, text: res.reply.text, reply: res.reply, at: new Date().toISOString(), topic: intent?.kind === "query" ? intent.topic : "action" });
      setQ("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  };

  const suggestions = Array.from(new Set([...commandSuggestions(ws), "Where is money stuck?", "Who needs me?", "What are you working on?"])).slice(0, 4);
  const recent = ws.ownerCommands.filter((c) => !/^[a-z]:/.test(c.text) && c.reply).slice(0, 5);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] xl:gap-8">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-3xl font-semibold tracking-tight">{t("Ask BARRY", "שאל את BARRY")}</h2>
          <p className="text-[15px] text-muted-foreground">{t("Answers from your records, and the actions BARRY can take for you.", "תשובות מתוך הרשומות שלך, והפעולות ש־BARRY יכול לבצע בשבילך.")}</p>
        </div>

        <form
          className="flex items-center gap-2 rounded-2xl border bg-card p-2 ps-4 shadow-sm focus-within:border-info/60"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim() && !busy) void ask({ text: q.trim() }, q.trim());
          }}
        >
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Ask about your business…", "לשאול על העסק…")} className="h-12 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground" aria-label={t("Ask BARRY", "שאל את BARRY")} data-testid="ask-input" dir="auto" />
          <Button type="submit" size="icon" className="size-11 shrink-0 rounded-xl bg-info text-white hover:bg-info/90" disabled={busy || !q.trim()} aria-label={t("Ask", "לשאול")} data-testid="ask-send">
            <ArrowUpIcon className="size-5" />
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("Try asking:", "אפשר לשאול:")}</span>
          {suggestions.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => void ask({ text: s }, s)} className="h-8 rounded-full border bg-card px-3 text-sm text-foreground/90 transition-colors hover:border-info/50 hover:bg-selected" data-testid="ask-suggestion">
              {s}
            </button>
          ))}
        </div>

        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{t(`That didn't go through — nothing was changed. (${error})`, `זה לא עבר — שום דבר לא השתנה. (${error})`)}</AlertDescription>
          </Alert>
        )}

        {busy && !answer && <div className="h-40 animate-pulse rounded-2xl border bg-card" aria-busy />}

        {answer && <AnswerCard answer={answer} ctx={ctx} busy={busy} onAction={(a) => setConfirm(a)} />}

        {!answer && !busy && (
          <p className="rounded-2xl border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">{t("BARRY answers only from your records — payments, conversations, follow-ups and what it noticed. If it can't prove something, it says so.", "BARRY עונה רק מתוך הרשומות שלך — תשלומים, שיחות, מעקבים ומה שהוא שם לב. אם הוא לא יכול להוכיח משהו, הוא אומר את זה.")}</p>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-6">
        <KeyNumbers ctx={ctx} />
        <Panel title={t("Recent questions", "שאלות אחרונות")} bodyClassName="flex flex-col p-2">
          {recent.length ? (
            recent.map((c) => (
              <button key={c.id} type="button" onClick={() => setAnswer({ question: c.text, text: c.reply, at: c.at, topic: (() => { const i = interpretCommand(c.text).intent; return i.kind === "query" ? i.topic : "action"; })() })} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-start hover:bg-surface-2" data-testid="ask-recent">
                <Thumb icon={MessageSquareIcon} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium" dir="auto">{c.text}</span>
                  <span className="text-xs text-muted-foreground">{clockOf(lang, tz, c.at, now)} · {c.source === "whatsapp" ? "WhatsApp" : t("Here", "כאן")}</span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
              </button>
            ))
          ) : (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t("Your questions — here or on WhatsApp — show up here.", "השאלות שלך — כאן או בוואטסאפ — יופיעו כאן.")}</p>
          )}
        </Panel>
      </aside>

      <Dialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}?</DialogTitle>
            <DialogDescription>{t("BARRY carries this out through the same checks as on WhatsApp — your rules and approvals still apply.", "BARRY מבצע את זה עם אותן בדיקות כמו בוואטסאפ — הכללים והאישורים שלך עדיין חלים.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("Cancel", "ביטול")}</Button>
            </DialogClose>
            <Button
              disabled={busy}
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c) void ask({ actionId: c.id }, c.title);
              }}
            >
              {t("Yes, go ahead", "כן, להמשיך")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AnswerCard({ answer, ctx, busy, onAction }: { answer: Answer; ctx: NextCtx; busy: boolean; onAction: (a: { id: string; title: string }) => void }) {
  const { ws, now } = ctx;
  const { lang, t } = useOwnerLang();
  const parsed = parse(answer.text);
  // A short label header ("Today:") isn't an answer: lead with the reply's first fact, keep the label above it.
  const labelOnly = parsed.head.split(/\s+/).length < 3 && parsed.items.length > 1;
  const head = labelOnly ? parsed.items[0].title : parsed.head;
  const items = labelOnly ? parsed.items.slice(1) : parsed.items;
  const factors = items.slice(0, 3);
  const extra = items.slice(3);
  const evidence = evidenceFor(answer.topic, ctx, lang, t);
  const tones: Tone[] = ["hot", "info", "warn"];
  return (
    <section className="flex flex-col gap-5 rounded-2xl border bg-card p-5 sm:p-6" data-testid="ask-answer">
      <header className="flex items-start gap-4">
        <Thumb icon={MessageSquareTextIcon} tone="info" size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm text-muted-foreground" dir="auto">“{answer.question}”{labelOnly ? ` · ${parsed.head}` : ""}</p>
          <h3 className="text-xl font-semibold leading-snug tracking-tight" dir="auto">{head || answer.text}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="hidden tabular-nums sm:inline">{clockOf(lang, ws.business.timezone, answer.at, now)}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => void navigator.clipboard?.writeText(answer.text)} aria-label={t("Copy", "העתקה")}><CopyIcon /></Button>
        </div>
      </header>

      {factors.length > 0 && (
        <div className="grid gap-3 md:grid-cols-3" data-testid="ask-factors">
          {factors.map((f, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl border bg-background/40 p-4">
              <span className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold ${tones[i] === "hot" ? "bg-hot/15 text-hot" : tones[i] === "info" ? "bg-info/15 text-info" : "bg-warn/15 text-warn"}`}>{i + 1}</span>
              <p className="text-sm font-medium leading-snug" dir="auto"><bdi>{f.title}</bdi></p>
              {f.more.length > 0 && <p className="text-sm leading-relaxed text-muted-foreground" dir="auto"><bdi>{f.more.join(" ")}</bdi></p>}
            </div>
          ))}
        </div>
      )}
      {extra.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          {extra.map((f, i) => <li key={i} dir="auto"><bdi>{f.title}{f.more.length ? ` — ${f.more.join(" ")}` : ""}</bdi></li>)}
        </ul>
      )}

      {evidence.metrics.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{t("From your records", "מתוך הרשומות שלך")}</h4>
          <div className="grid gap-2 sm:grid-cols-3">{evidence.metrics}</div>
        </div>
      )}

      {(answer.reply?.actions?.length || answer.reply?.links?.length || evidence.records.length) ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{t("Suggested next steps", "הצעדים הבאים")}</h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {answer.reply?.actions?.map((a) => (
              <button key={a.id} type="button" disabled={busy} onClick={() => onAction(a)} className="flex min-h-12 items-center justify-between gap-3 rounded-xl border bg-background/40 px-4 py-2.5 text-start text-sm font-medium hover:bg-surface-2" data-testid="ask-action">
                {a.title}
                <ChevronRightIcon className="size-4 text-muted-foreground rtl:rotate-180" />
              </button>
            ))}
            {answer.reply?.links?.map((l) => (
              <Link key={l.href} href={nextPath(l.href)} className="flex min-h-12 items-center justify-between gap-3 rounded-xl border bg-background/40 px-4 py-2.5 text-sm font-medium hover:bg-surface-2">
                {l.label}
                <ChevronRightIcon className="size-4 text-muted-foreground rtl:rotate-180" />
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {evidence.records.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">{t("Related records", "רשומות קשורות")}</h4>
          <div className="flex flex-col">
            {evidence.records.map((r) => (
              <Link key={r.key} href={r.href} className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-surface-2">
                <Thumb icon={r.person ? undefined : r.icon} name={r.person} tone={r.person ? "muted" : r.tone} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium"><bdi>{r.title}</bdi></span>
                  {r.sub && <span className="truncate text-xs text-muted-foreground"><bdi>{r.sub}</bdi></span>}
                </span>
                {r.amount && <span className="text-sm font-semibold tabular-nums text-warn"><bdi>{r.amount}</bdi></span>}
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type Rec = { key: string; title: string; sub?: string; amount?: string; href: string; icon: Row["icon"]; tone: Tone; person?: string };

/** The records a question is about, read from the workspace (never computed on top of the answer). */
function evidenceFor(topic: Answer["topic"], ctx: NextCtx, lang: "en" | "he", t: (en: string, he: string) => string): { metrics: React.ReactNode[]; records: Rec[] } {
  const { ws, now } = ctx;
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const motion = sumMoney(s.waitingOnCustomer, s.stuckWithYou);
  const cur = mainCurrency([motion, s.atRisk, r.potential], ws.trend.currency);
  const rows = buildRows(ws, lang, t);
  const asRec = (x: Row): Rec => ({ key: x.key, title: x.title, sub: x.context, amount: x.amount, href: `/owner/next/work`, icon: x.icon, tone: STAND[x.stand].tone, person: x.person });
  if (topic === "money") {
    const risky = ws.opportunities.items.filter((o) => !o.simulated && isAtRisk(o));
    return {
      metrics: [
        <Metric key="m" tone="live" icon={ShoppingBagIcon} label={t(`Made ${ws.window.label} · verified`, `נגבה ${ws.window.label} · מאומת`)} value={hasMoney(r.direct) ? money(lang, r.direct) : amount(lang, 0, cur)} chart={<Bars values={ws.trend.made} />} />,
        <Metric key="i" tone="info" icon={WalletIcon} label={t("In motion · not revenue", "בתנועה · לא הכנסה")} value={hasMoney(motion) ? money(lang, motion) : amount(lang, 0, cur)} />,
        <Metric key="r" tone={hasMoney(s.atRisk) ? "warn" : "muted"} icon={TriangleAlertIcon} label={t("At risk", "בסיכון")} value={hasMoney(s.atRisk) ? money(lang, s.atRisk) : amount(lang, 0, cur)} />,
      ],
      records: risky.slice(0, 3).map((o) => ({ key: o.id, title: o.customer, sub: `${o.reasoning} · ${ageOf(lang, o.since, now)}`, amount: o.amount !== undefined && o.currency ? amount(lang, o.amount, o.currency) : undefined, href: o.next.interventionId ? `/owner/next/work?intervention=${encodeURIComponent(o.next.interventionId)}` : `/owner?tab=money&conversation=${encodeURIComponent(o.conversationId)}`, icon: WalletIcon, tone: "warn" as Tone, person: o.customer })),
    };
  }
  if (topic === "needs_you") return { metrics: [], records: rows.needs.slice(0, 4).map(asRec) };
  if (topic === "working" || topic === "operation") return { metrics: [], records: rows.progress.map(asRec) };
  if (topic === "initiatives") return { metrics: [], records: rows.noticed.slice(0, 3).map(asRec) };
  if (topic === "waiting_customers") {
    const waiting = ws.conversations.filter((c) => c.status === "waiting_on_customer").slice(0, 4);
    return { metrics: [], records: waiting.map((c) => ({ key: c.id, title: c.customer, sub: ageOf(lang, c.lastActivityAt, now), href: `/owner?tab=customers&conversation=${encodeURIComponent(c.id)}`, icon: UsersIcon, tone: "info" as Tone, person: c.customer })) };
  }
  return { metrics: [], records: rows.needs.slice(0, 3).map(asRec) };
}

function KeyNumbers({ ctx }: { ctx: NextCtx }) {
  const { ws } = ctx;
  const { lang, t } = useOwnerLang();
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const motion = sumMoney(s.waitingOnCustomer, s.stuckWithYou);
  const cur = mainCurrency([motion, s.atRisk, r.potential], ws.trend.currency);
  return (
    <Panel title={t("Key numbers", "מספרים מרכזיים")} action={{ label: t("Money", "כסף"), href: "/owner/next/money" }} bodyClassName="grid grid-cols-2 gap-2 p-3">
      <Metric tone="live" label={t("Made today · verified", "נגבה היום · מאומת")} value={hasMoney(r.direct) ? money(lang, r.direct) : amount(lang, 0, cur)} chart={<Bars values={ws.trend.made} height={22} />} />
      <Metric tone={hasMoney(s.atRisk) ? "warn" : "muted"} label={t("At risk", "בסיכון")} value={hasMoney(s.atRisk) ? money(lang, s.atRisk) : amount(lang, 0, cur)} />
      <Metric tone="info" label={t("In motion", "בתנועה")} value={hasMoney(motion) ? money(lang, motion) : amount(lang, 0, cur)} />
      <Metric label={t("Conversations today", "שיחות היום")} value={ws.today.conversations} />
    </Panel>
  );
}
