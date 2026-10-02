"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonPrimary, button, input } from "@/components/ds/primitives";
import { recoverFounderReply, sendFounderCommand, type SendOutcome } from "@/lib/founder/reconcile";
import { itemsMode } from "@/lib/founder/presentation";

/**
 * ASK BARRY (founder) — a conversation with the founder's chief of staff over the fleet. Every command goes to the
 * Founder BARRY command service; a founder control comes back as a confirmation the founder must press, and only
 * then runs (once) through the audited control. Follow-ups ("Why?", "and Midtown?") carry the conversation.
 *
 * The answer is primary. Evidence and links stay one tap away under "Details"; confirmations, proposals,
 * verification and failures stay prominent. A response lost on the way (mobile) is recovered by its key —
 * never re-sent.
 */

type Item = { title: string; detail?: string; href?: string; severity?: "high" | "medium" | "low" | "ok" | "info" };
export type Reply = { key: string; status: string; answer: string; items: Item[]; followUps: string[]; proposalIds: string[]; verification?: string; stopReason?: string; intent: string; scope: { kind: "fleet" | "business"; businessIds: string[] }; confirmation?: { key: string; title: string; effect: string }; duplicate: boolean; voice?: "composer" | "grounded" };
type Exchange = { id: string; key: string; text: string; reply?: Reply; error?: string; lost?: string; recovering?: boolean };

const DOT: Record<string, string> = { high: "bg-[#d92d20]", medium: "bg-[#f79009]", low: "bg-[#98a2b3]", ok: "bg-[#17b26a]", info: "bg-[#2e90fa]" };
const STATUS_WORDS: Record<string, string> = { needs_confirmation: "Needs your confirmation", executed: "Done · verified", proposed: "Proposal prepared", handled: "Handled", clarify: "Which one?", failed: "Failed" };
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? `fc_${crypto.randomUUID()}` : `fc_${Date.now()}_${Math.random().toString(36).slice(2)}`);
const deps = (onRecovering?: () => void) => ({ fetch: (u: string, i?: RequestInit) => fetch(u, i), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), onRecovering });

function ItemList({ items }: { items: Item[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.slice(0, 8).map((i, n) => (
        <li key={n} className="flex min-w-0 items-start gap-2 text-[13px]">
          <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${DOT[i.severity ?? "info"]}`} aria-hidden />
          <span className="min-w-0" dir="auto">
            {i.href ? <Link href={i.href} className="font-medium text-[#101828] hover:underline">{i.title}</Link> : <span className="font-medium text-[#101828]">{i.title}</span>}
            {i.detail && <span className="block text-[#667085]">{i.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One reply: the conversational answer is primary. Raw items that merely back the answer sit under a compact
 * "Details & links" disclosure; a confirmation, a proposal, a verification or a failure stays prominent.
 */
export function FounderReplyView({ reply: r, busy, onConfirm, onFollowUp }: { reply: Reply; busy: boolean; onConfirm: (c: { key: string; title: string }) => void; onFollowUp: (text: string) => void }) {
  const mode = itemsMode(r.status, r.items.length);
  return (
    <div className="flex flex-col gap-2">
      {STATUS_WORDS[r.status] && <span className="w-fit rounded-full bg-[#f2f4f7] px-2 py-0.5 text-[11px] font-medium text-[#344054]">{STATUS_WORDS[r.status]}</span>}
      <p dir="auto" className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[#101828]">{r.answer}</p>
      {r.verification && <p dir="auto" className="text-[12px] text-[#067647]">✓ {r.verification}</p>}
      {mode === "open" && <ItemList items={r.items} />}
      {mode === "details" && (
        <details className="group text-[13px]" data-testid="founder-details">
          <summary className="cursor-pointer list-none text-[12px] font-medium text-[#475467] hover:text-[#101828]">Details &amp; links ({Math.min(r.items.length, 8)}) <span className="group-open:hidden">›</span></summary>
          <div className="mt-2"><ItemList items={r.items} /></div>
        </details>
      )}
      <div className="flex flex-wrap gap-1.5">
        {r.confirmation && (
          <button type="button" className={buttonPrimary} disabled={busy} onClick={() => onConfirm(r.confirmation!)} data-testid="founder-confirm">Confirm — {r.confirmation.title}</button>
        )}
        {r.proposalIds.length > 0 && <Link href="/hq/proposals" className={button}>Open proposals</Link>}
        {r.followUps.filter((f) => f !== "Confirm").map((f) => (
          <button key={f} type="button" disabled={busy} onClick={() => onFollowUp(f)} className="rounded-full bg-[#f2f4f7] px-2.5 py-1 text-[12px] text-[#344054] hover:bg-[#e4e7ec] disabled:opacity-50">{f}</button>
        ))}
      </div>
    </div>
  );
}

export function FounderCommand({ initial, draft, suggestions }: { initial?: string; draft?: string; suggestions: string[] }) {
  const [text, setText] = useState(draft ?? "");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Exchange[]>([]);
  const [context, setContext] = useState<string | undefined>(undefined);
  const started = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const settle = useCallback((id: string, out: SendOutcome<Reply>) => {
    setLog((l) => l.map((e) => (e.id !== id ? e : out.kind === "reply" ? { ...e, reply: out.reply, recovering: false, lost: undefined } : out.kind === "lost" ? { ...e, lost: out.message, recovering: false } : { ...e, error: out.message, recovering: false })));
    if (out.kind === "reply" && out.reply.scope?.kind === "business" && out.reply.scope.businessIds.length === 1) setContext(out.reply.scope.businessIds[0]);
  }, []);

  const post = useCallback(async (body: Record<string, unknown>, key: string, label: string) => {
    const id = `${key}:${Date.now()}`;
    setLog((l) => [...l, { id, key, text: label }]);
    setBusy(true);
    try {
      const out = await sendFounderCommand<Reply>(body, key, deps(() => setLog((l) => l.map((e) => (e.id === id ? { ...e, recovering: true } : e)))));
      settle(id, out);
    } finally {
      setBusy(false);
    }
  }, [settle]);

  const checkAgain = useCallback(async (e: Exchange) => {
    setLog((l) => l.map((x) => (x.id === e.id ? { ...x, lost: undefined, recovering: true } : x)));
    setBusy(true);
    try {
      settle(e.id, await recoverFounderReply<Reply>(e.key, deps()));
    } finally {
      setBusy(false);
    }
  }, [settle]);

  const send = useCallback((t: string) => {
    const q = t.trim();
    if (!q) return;
    setText("");
    // The previous reply is conversation context ("and Rina?", "yes", "is that real money?") — never authority.
    const previousKey = [...log].reverse().find((e) => e.reply)?.reply?.key;
    const key = newKey();
    void post({ text: q, key, ...(context ? { context: { businessId: context } } : {}), ...(previousKey ? { previousKey } : {}) }, key, q);
  }, [post, context, log]);

  useEffect(() => {
    if (!initial) return;
    const t = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      send(initial);
    }, 0);
    return () => clearTimeout(t);
  }, [initial, send]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [log.length]);

  return (
    <div className="flex flex-col gap-3">
      {log.map((e) => {
        const r = e.reply;
        return (
          <div key={e.id} className="flex flex-col gap-2" data-testid="founder-exchange">
            <p dir="auto" className="ml-auto max-w-[85%] rounded-2xl bg-[#1d2939] px-3.5 py-2 text-[14px] text-white">{e.text}</p>
            <div className="max-w-full rounded-2xl bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_0_0_1px_rgba(16,24,40,0.04)]" data-testid="founder-reply">
              {!r && !e.error && !e.lost && <p className="text-[13px] text-[#98a2b3]">{e.recovering ? "Recovering BARRY's answer…" : "Thinking…"}</p>}
              {e.error && <p className="text-[13px] text-[#b42318]">{e.error}</p>}
              {e.lost && (
                <div className="flex flex-col gap-2">
                  <p className="text-[13px] text-[#b54708]">{e.lost}</p>
                  <button type="button" className={`${button} w-fit`} disabled={busy} onClick={() => void checkAgain(e)}>Check again</button>
                </div>
              )}
              {r && <FounderReplyView reply={r} busy={busy} onConfirm={(c) => void post({ confirmKey: c.key }, c.key, `Confirm: ${c.title}`)} onFollowUp={send} />}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
      <form onSubmit={(ev) => { ev.preventDefault(); if (!busy) send(text); }} className="flex flex-col gap-2 sm:flex-row">
        <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Tell BARRY what you need — “What do I need to know today?”" className={`${input} min-h-12 text-[15px]`} aria-label="Ask BARRY" dir="auto" autoFocus />
        <button className={`${buttonPrimary} min-h-12 sm:shrink-0`} disabled={busy || !text.trim()}>{busy ? "Working…" : "Ask BARRY"}</button>
      </form>
      {log.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} disabled={busy} className="rounded-full bg-white px-2.5 py-1 text-[12px] text-[#344054] ring-1 ring-inset ring-[#e4e7ec] hover:bg-[#f9fafb] disabled:opacity-50">{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}
