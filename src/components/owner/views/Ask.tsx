"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OwnerReply } from "@/lib/owner/command-service";
import { proactiveWords } from "@/lib/owner/control-room";
import { BarryOrb, Icon } from "../kit";
import { useOwnerLang } from "../lang";
import { Button, ConfirmButton, Disclosure, Notice } from "../os-ui";

/**
 * ASK BARRY — BARRY inside the business, not a generic chat. Every question and instruction goes
 * through the SAME owner command service as the WhatsApp owner channel: answers come only from this
 * business's records, work is grounded before anything runs, a decision runs only against the exact
 * request shown. Replies are in the owner's language; buttons that change something take two taps.
 * The conversation stays for this visit (per business) so moving around the OS doesn't lose it.
 */

export type RunCommand = (body: { text?: string; actionId?: string }) => Promise<OwnerReply>;
type Exchange = { id: string; q: string; reply?: OwnerReply; error?: boolean; pending?: boolean };

const CONSEQUENTIAL = /approve|decline|start|stop|לאשר|לדחות|להתחיל|לעצור|לבטל|cancel/i;

function store(businessId: string): Exchange[] {
  try {
    return JSON.parse(window.sessionStorage.getItem(`barry.ask.${businessId}`) ?? "[]") as Exchange[];
  } catch {
    return [];
  }
}

export function AskView({ ws, onCommand, initialQuestion }: { ws: OwnerWorkspace; onCommand: RunCommand; initialQuestion?: string }) {
  const { lang, t } = useOwnerLang();
  const [q, setQ] = useState("");
  const [log, setLog] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const businessId = ws.business.id;

  useEffect(() => {
    const t0 = setTimeout(() => setLog(store(businessId).filter((e) => e.reply)), 0);
    return () => clearTimeout(t0);
  }, [businessId]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(`barry.ask.${businessId}`, JSON.stringify(log.filter((e) => e.reply).slice(-20)));
    } catch {
      /* private mode */
    }
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [log, businessId]);

  const send = async (body: { text?: string; actionId?: string }, label: string) => {
    const id = `${Date.now()}`;
    setLog((l) => [...l, { id, q: label, pending: true }]);
    setBusy(true);
    try {
      const reply = await onCommand(body);
      setLog((l) => l.map((e) => (e.id === id ? { ...e, reply, pending: false } : e)));
    } catch {
      setLog((l) => l.map((e) => (e.id === id ? { ...e, error: true, pending: false } : e)));
    } finally {
      setBusy(false);
    }
  };
  const submit = (text: string) => {
    const v = text.trim();
    if (!v || busy) return;
    setQ("");
    void send({ text: v }, v);
  };

  useEffect(() => {
    if (!initialQuestion?.trim() || asked.current) return;
    const t0 = setTimeout(() => {
      if (asked.current) return;
      asked.current = true;
      if (/^(stop|תעצור)/i.test(initialQuestion)) {
        setQ(initialQuestion); // an instruction is never sent for the owner — they press send
        inputRef.current?.focus();
      } else submit(initialQuestion);
    }, 0);
    return () => clearTimeout(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const running = ws.ownerOperations.find((o) => o.derivedState === "running" || o.derivedState === "waiting_on_customers");
  const prompts = [
    ws.interventions.length ? t("Who needs me?", "מי צריך אותי?") : t("What are you working on?", "על מה אתה עובד?"),
    t("How much did we make today?", "כמה הרווחנו היום?"),
    running ? t(`How is ${proactiveWords(running.workflow, "en").title.toLowerCase()} going?`, `איך מתקדם ${proactiveWords(running.workflow, "he").command}?`) : t("Where is money stuck?", "איפה כסף תקוע?"),
    t("What did you notice?", "על מה שמת לב?"),
  ];

  return (
    <div className="flex min-h-[calc(100dvh-14rem)] flex-col gap-4">
      <header className="flex items-center gap-3 pt-1">
        <BarryOrb size={34} state={busy ? "working" : "idle"} />
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight text-o-ink">{t("Ask BARRY", "שאל את BARRY")}</h1>
          <p className="text-[13px] text-o-muted">{t("Answers from your records only — same as on WhatsApp.", "תשובות רק מהרשומות שלך — בדיוק כמו בוואטסאפ.")}</p>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4" aria-live="polite">
        {log.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="px-1 text-[13px] text-o-muted">{t("Try:", "אפשר לשאול:")}</p>
            <div className="flex flex-wrap gap-2">
              {prompts.map((p) => (
                <button key={p} type="button" onClick={() => submit(p)} className="min-h-10 rounded-full bg-o-surface px-3.5 text-[14px] text-o-ink-2 ring-1 ring-inset ring-o-line hover:text-o-ink" data-testid="ask-prompt">{p}</button>
              ))}
            </div>
          </div>
        )}
        {log.map((e) => (
          <div key={e.id} className="flex flex-col gap-2">
            <p dir="auto" className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-ee-md bg-o-accent px-3.5 py-2 text-[15px] leading-6 text-white" data-testid="ask-question">{e.q}</p>
            <div className="flex max-w-full gap-2.5 self-start" data-testid="ask-reply">
              <span className="mt-1 shrink-0"><BarryOrb size={24} state={e.pending ? "working" : "idle"} /></span>
              <div className="min-w-0 flex-1 rounded-2xl rounded-ss-md bg-o-surface px-4 py-3 ring-1 ring-inset ring-o-line">
                {e.pending && <p className="text-[14px] text-o-muted">{t("BARRY is looking at your records…", "BARRY בודק ברשומות…")}</p>}
                {e.error && (
                  <div className="flex flex-col gap-2">
                    <p className="text-[14px] text-o-ink-2">{t("That didn't reach BARRY — nothing was changed.", "זה לא הגיע ל־BARRY — שום דבר לא השתנה.")}</p>
                    <div><Button onClick={() => void send({ text: e.q }, e.q)}>{t("Try again", "לנסות שוב")}</Button></div>
                  </div>
                )}
                {e.reply && <Reply reply={e.reply} busy={busy} onAction={(id, title) => void send({ actionId: id }, title)} lang={lang} />}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Keyboard-safe composer: sticks above the bottom bar on phones */}
      <form onSubmit={(ev) => { ev.preventDefault(); submit(q); }} className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))] z-10 -mx-1 flex items-end gap-2 rounded-2xl bg-o-canvas/95 p-1 backdrop-blur lg:bottom-4">
        <textarea
          ref={inputRef}
          value={q}
          onChange={(ev) => setQ(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !ev.shiftKey) {
              ev.preventDefault();
              submit(q);
            }
          }}
          rows={1}
          dir="auto"
          aria-label={t("Ask BARRY", "שאל את BARRY")}
          placeholder={t("Ask or tell BARRY…", "לשאול או לבקש מ־BARRY…")}
          className="max-h-32 min-h-12 flex-1 resize-none rounded-2xl bg-o-surface px-4 py-3 text-[16px] leading-6 text-o-ink ring-1 ring-inset ring-o-line-strong placeholder:text-o-faint focus:outline-none focus:ring-2 focus:ring-o-accent"
          data-testid="ask-input"
        />
        <button type="submit" disabled={busy || !q.trim()} aria-label={t("Send", "שליחה")} className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-o-accent text-white transition disabled:opacity-40" data-testid="ask-send">
          <Icon name="send" size={18} className="rtl:-scale-x-100" />
        </button>
      </form>
    </div>
  );
}

function Reply({ reply, busy, onAction, lang }: { reply: OwnerReply; busy: boolean; onAction: (id: string, title: string) => void; lang: "en" | "he" }) {
  const { t } = useOwnerLang();
  const [first, ...rest] = reply.text.split("\n\n");
  const op = reply.operation;
  return (
    <div className="flex flex-col gap-2.5">
      <p dir="auto" className="whitespace-pre-wrap break-words text-[15px] leading-6 text-o-ink">{first}</p>
      {rest.length > 0 && (rest.join("\n\n").length > 280 ? (
        <Disclosure summary={t("Details", "פרטים")}>
          <p dir="auto" className="whitespace-pre-wrap break-words text-[14px] leading-6 text-o-ink-2">{rest.join("\n\n")}</p>
        </Disclosure>
      ) : (
        <p dir="auto" className="whitespace-pre-wrap break-words text-[14.5px] leading-6 text-o-ink-2">{rest.join("\n\n")}</p>
      ))}
      {op && (
        <Notice tone={op.derivedState === "running" || op.derivedState === "waiting_on_customers" ? "info" : "neutral"}>
          {proactiveWords(op.workflow, lang).title} · {t(`${op.progress.contacted} contacted · ${op.progress.replied} replied · ${op.progress.purchased} bought`, `${op.progress.contacted} קיבלו הודעה · ${op.progress.replied} ענו · ${op.progress.purchased} קנו`)}
        </Notice>
      )}
      {(reply.actions?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-2" data-testid="ask-actions">
          {reply.actions!.map((a) =>
            CONSEQUENTIAL.test(a.title) ? (
              <ConfirmButton key={a.id} label={a.title} confirmLabel={t(`Yes — ${a.title.toLowerCase()}`, `כן — ${a.title}`)} kind={/decline|stop|cancel|לדחות|לעצור|לבטל/i.test(a.title) ? "danger" : "primary"} consequence={t("This acts on the exact request shown above, once.", "זה פועל על הבקשה המדויקת שמוצגת למעלה, פעם אחת.")} onConfirm={() => onAction(a.id, a.title)} disabled={busy} testId="ask-action" />
            ) : (
              <Button key={a.id} onClick={() => onAction(a.id, a.title)} disabled={busy}>{a.title}</Button>
            ),
          )}
        </div>
      )}
      {(reply.links?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {reply.links!.map((l) => (
            <Link key={l.href} href={l.href} className="inline-flex min-h-9 items-center gap-1 text-[14px] font-medium text-o-accent">{l.label}<Icon name="chevron" size={14} className="rtl:-scale-x-100" /></Link>
          ))}
        </div>
      )}
    </div>
  );
}
