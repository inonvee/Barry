"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OwnerAnswerLinks } from "@/lib/owner/ask";
import type { useOwnerApi } from "../useOwnerApi";
import { Empty, input } from "../ui";
import { Hero, Icon, IconTile, Orb, Panel, PanelHeader, type IconName } from "../kit";
import { WhatsAppCard } from "../OwnerShell";

type Api = ReturnType<typeof useOwnerApi>;

const PROMPTS: { q: string; icon: IconName; hint: string }[] = [
  { q: "What should I focus on today?", icon: "flag", hint: "Priorities from your records" },
  { q: "What needs me?", icon: "shield", hint: "Decisions and handoffs" },
  { q: "Where is money stuck?", icon: "money", hint: "Unpaid, waiting, at risk" },
  { q: "What happened today?", icon: "pulse", hint: "What BARRY did" },
  { q: "What failed?", icon: "alert", hint: "Anything that didn't go through" },
  { q: "What can you do right now?", icon: "barry", hint: "Capabilities and limits" },
];

type Answer = { q: string; a: string; note?: string; source: string; links?: OwnerAnswerLinks };

/**
 * ASK BARRY — business intelligence that leads to action. Answers come only from this business's
 * records; each answer links to the exact decision, conversation or setup step it talks about. BARRY
 * can't change anything from here — the only actions offered are ones the runtime already supports.
 */
export function AskView({ api, ws, onIntervention, onOpen, initialQuestion }: { api: Api; ws: OwnerWorkspace; onIntervention: (id: string) => void; onOpen: (id: string) => void; initialQuestion?: string }) {
  const [q, setQ] = useState(initialQuestion ?? "");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Answer[]>([]);
  const asked = useRef(false);
  useEffect(() => {
    if (!initialQuestion?.trim() || asked.current) return;
    asked.current = true;
    const t = setTimeout(() => void ask(initialQuestion), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    try {
      const res = await api.call<{ answer: string; source: string; note?: string; links?: OwnerAnswerLinks }>("/api/owner/ask", { body: { businessId: api.businessId, question } });
      setHistory((h) => [{ q: question, a: res.answer, note: res.note, source: res.source, links: res.links }, ...h]);
      setQ("");
    } catch (e) {
      setHistory((h) => [{ q: question, a: e instanceof Error ? e.message : "Something went wrong", source: "error" }, ...h]);
    } finally {
      setBusy(false);
    }
  };
  const canNow = ws.capabilities.now.slice(0, 6);
  return (
    <div className="flex flex-col gap-6">
      <Hero eyebrow={`BARRY · ${ws.business.name}`} title={<>Ask BARRY about <span className="o-hero-type">your business.</span></>} lead="Answers come only from your records, and link to the exact thing to decide, open or unlock." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <form
            className="o-panel flex items-center gap-2 rounded-2xl p-2 pl-3 shadow-o-glow"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(q);
            }}
          >
            <Orb size={28} alive={busy} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="BARRY, what should I focus on today?" aria-label="Ask BARRY" className={`${input} min-w-0 flex-1 bg-transparent ring-0 focus:ring-0`} maxLength={1000} />
            <button className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-o-accent text-white transition hover:brightness-110 disabled:opacity-40" disabled={busy || !q.trim()} aria-label="Ask">
              {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="send" size={18} />}
            </button>
          </form>

          {history.length === 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PROMPTS.map((p) => (
                <button key={p.q} onClick={() => void ask(p.q)} disabled={busy} className="o-panel flex items-center gap-3 rounded-2xl p-3.5 text-left transition hover:shadow-o-glow disabled:opacity-60">
                  <IconTile name={p.icon} tone="accent" size={34} />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium text-o-ink">{p.q}</span>
                    <span className="block text-[12px] text-o-muted">{p.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {PROMPTS.map((p) => (
                <button key={p.q} className="rounded-full bg-o-sunken px-3 py-1.5 text-[12.5px] text-o-ink-2 ring-1 ring-inset ring-o-line transition hover:text-o-ink" onClick={() => void ask(p.q)} disabled={busy}>
                  {p.q}
                </button>
              ))}
            </div>
          )}

          {busy && (
            <Panel className="p-4">
              <p className="flex items-center gap-2 text-[13px] text-o-muted">
                <Orb size={18} /> BARRY is reading your records…
              </p>
            </Panel>
          )}

          <ul className="flex flex-col gap-3">
            {history.map((h, i) => (
              <Panel key={i} as="li" className="p-4 md:p-5">
                <p className="flex items-center gap-2 text-[12.5px] font-medium text-o-muted">
                  <Icon name="chat" size={14} /> {h.q}
                </p>
                <p className="mt-2.5 whitespace-pre-wrap text-[15px] leading-7 text-o-ink">{h.a}</p>
                {h.note && <p className="mt-2 text-[12px] text-o-faint">{h.note}</p>}
                {h.links && (h.links.interventions.length > 0 || h.links.opportunities.length > 0 || h.links.steps.length > 0) && (
                  <div className="mt-4 border-t border-o-line pt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-o-faint">Take it from here</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {h.links.interventions.map((l) => (
                        <button key={l.id} className="inline-flex items-center gap-1.5 rounded-xl bg-o-warn-bg px-3 py-2 text-[13px] font-medium text-o-warn ring-1 ring-inset ring-o-warn-line transition hover:brightness-110" onClick={() => onIntervention(l.id)}>
                          <Icon name="shield" size={14} /> Decide: {l.customer}
                        </button>
                      ))}
                      {h.links.opportunities.map((l) => (
                        <button key={l.id} className="inline-flex items-center gap-1.5 rounded-xl bg-o-sunken px-3 py-2 text-[13px] font-medium text-o-ink-2 ring-1 ring-inset ring-o-line transition hover:text-o-ink" onClick={() => onOpen(l.conversationId)}>
                          <Icon name="money" size={14} /> {l.kind}: {l.customer}
                        </button>
                      ))}
                      {h.links.steps.map((l) => (
                        <Link key={l.id} href="/owner/train" className="inline-flex items-center gap-1.5 rounded-xl bg-o-violet/15 px-3 py-2 text-[13px] font-medium text-o-violet ring-1 ring-inset ring-o-violet/30 transition hover:brightness-110">
                          <Icon name="lock" size={14} /> Unlock: {l.title}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </Panel>
            ))}
          </ul>
          {history.length === 0 && <p className="text-[12.5px] text-o-faint">BARRY answers from the same records you see on Today, Inbox and Money — it can&apos;t change anything from here.</p>}
        </div>

        <div className="flex flex-col gap-4">
          <Panel className="p-4 md:p-5">
            <PanelHeader icon="barry" title="BARRY can do now" sub="For real, in your business." />
            {canNow.length === 0 ? (
              <div className="mt-3">
                <Empty>Nothing runs for real yet — see Train BARRY for what unlocks it.</Empty>
              </div>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {canNow.map((c) => (
                  <li key={c} className="flex items-start gap-2 text-[13.5px] text-o-ink-2">
                    <Icon name="check" size={15} className="mt-0.5 text-o-ok" /> {c}
                  </li>
                ))}
              </ul>
            )}
            {ws.capabilities.nowSimulated.length > 0 && <p className="mt-3 text-[12px] text-o-faint">On a simulator only: {ws.capabilities.nowSimulated.slice(0, 3).join(", ")}{ws.capabilities.nowSimulated.length > 3 ? "…" : ""}</p>}
          </Panel>
          <WhatsAppCard channels={ws.channels} />
        </div>
      </div>
    </div>
  );
}
