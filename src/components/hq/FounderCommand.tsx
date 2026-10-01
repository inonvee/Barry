"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonPrimary, button, input } from "@/components/ds/primitives";

/**
 * ASK BARRY (founder) — the one command field over the fleet. Every command goes to the Founder BARRY
 * command service; a founder control comes back as a confirmation the founder must press, and only then
 * runs (once) through the audited control. Follow-ups ("Why?") carry the business being discussed.
 */

type Item = { title: string; detail?: string; href?: string; severity?: "high" | "medium" | "low" | "ok" | "info" };
type Reply = { key: string; status: string; answer: string; items: Item[]; followUps: string[]; proposalIds: string[]; verification?: string; stopReason?: string; intent: string; scope: { kind: "fleet" | "business"; businessIds: string[] }; confirmation?: { key: string; title: string; effect: string }; duplicate: boolean };
type Exchange = { id: string; text: string; reply?: Reply; error?: string };

const DOT: Record<string, string> = { high: "bg-[#d92d20]", medium: "bg-[#f79009]", low: "bg-[#98a2b3]", ok: "bg-[#17b26a]", info: "bg-[#2e90fa]" };
const STATUS_WORDS: Record<string, string> = { needs_confirmation: "Needs your confirmation", executed: "Done · verified", no_change: "No change needed", proposed: "Proposal prepared", handled: "Handled", clarify: "Which one?", refused: "Not something I do", failed: "Failed" };
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? `fc_${crypto.randomUUID()}` : `fc_${Date.now()}_${Math.random().toString(36).slice(2)}`);

export function FounderCommand({ initial, draft, suggestions }: { initial?: string; draft?: string; suggestions: string[] }) {
  const [text, setText] = useState(draft ?? "");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Exchange[]>([]);
  const [context, setContext] = useState<string | undefined>(undefined);
  const started = useRef(false);

  const post = useCallback(async (body: Record<string, unknown>, label: string) => {
    const id = newKey();
    setLog((l) => [{ id, text: label }, ...l]);
    setBusy(true);
    try {
      const r = await fetch("/api/hq/founder/command", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json()) as Reply & { error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setLog((l) => l.map((e) => (e.id === id ? { ...e, reply: d } : e)));
      if (d.scope.kind === "business" && d.scope.businessIds.length === 1) setContext(d.scope.businessIds[0]);
    } catch (err) {
      setLog((l) => l.map((e) => (e.id === id ? { ...e, error: err instanceof Error ? err.message : "failed" } : e)));
    } finally {
      setBusy(false);
    }
  }, []);

  const send = useCallback((t: string) => {
    const q = t.trim();
    if (!q) return;
    setText("");
    void post({ text: q, key: newKey(), ...(context ? { context: { businessId: context } } : {}) }, q);
  }, [post, context]);

  useEffect(() => {
    if (!initial) return;
    const t = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      send(initial);
    }, 0);
    return () => clearTimeout(t);
  }, [initial, send]);

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex flex-col gap-2 sm:flex-row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell BARRY what you need — “What do I need to know today?”" className={`${input} min-h-12 text-[15px]`} aria-label="Ask BARRY" autoFocus />
        <button className={`${buttonPrimary} min-h-12 sm:shrink-0`} disabled={busy || !text.trim()}>{busy ? "Working…" : "Ask BARRY"}</button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button key={s} type="button" onClick={() => send(s)} disabled={busy} className="rounded-full bg-white px-2.5 py-1 text-[12px] text-[#344054] ring-1 ring-inset ring-[#e4e7ec] hover:bg-[#f9fafb] disabled:opacity-50">{s}</button>
        ))}
      </div>
      {log.map((e) => (
        <div key={e.id} className="rounded-2xl bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_0_0_1px_rgba(16,24,40,0.04)]" data-testid="founder-reply">
          <p className="text-[12px] font-medium text-[#667085]">{e.text}</p>
          {!e.reply && !e.error && <p className="mt-2 text-[13px] text-[#98a2b3]">Grounding…</p>}
          {e.error && <p className="mt-2 text-[13px] text-[#b42318]">{e.error}</p>}
          {e.reply && (
            <div className="mt-2 flex flex-col gap-2">
              {STATUS_WORDS[e.reply.status] && <span className="w-fit rounded-full bg-[#f2f4f7] px-2 py-0.5 text-[11px] font-medium text-[#344054]">{STATUS_WORDS[e.reply.status]}{e.reply.duplicate ? " · already recorded" : ""}</span>}
              <pre className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-[#101828]">{e.reply.answer}</pre>
              {e.reply.verification && <p className="text-[12px] text-[#067647]">✓ {e.reply.verification}</p>}
              {e.reply.items.length > 0 && e.reply.status !== "needs_confirmation" && (
                <ul className="flex flex-col gap-1.5">
                  {e.reply.items.slice(0, 8).map((i, n) => (
                    <li key={n} className="flex min-w-0 items-start gap-2 text-[13px]">
                      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${DOT[i.severity ?? "info"]}`} aria-hidden />
                      <span className="min-w-0">
                        {i.href ? <Link href={i.href} className="font-medium text-[#101828] hover:underline">{i.title}</Link> : <span className="font-medium text-[#101828]">{i.title}</span>}
                        {i.detail && <span className="block text-[#667085]">{i.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-1.5">
                {e.reply.confirmation && (
                  <button type="button" className={buttonPrimary} disabled={busy} onClick={() => void post({ confirmKey: e.reply!.confirmation!.key }, `Confirm: ${e.reply!.confirmation!.title}`)}>Confirm — {e.reply.confirmation.title}</button>
                )}
                {e.reply.proposalIds.length > 0 && <Link href="/hq/proposals" className={button}>Open proposals</Link>}
                {e.reply.followUps.filter((f) => f !== "Confirm").map((f) => (
                  <button key={f} type="button" disabled={busy} onClick={() => send(f)} className="rounded-full bg-[#f2f4f7] px-2.5 py-1 text-[12px] text-[#344054] hover:bg-[#e4e7ec] disabled:opacity-50">{f}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
