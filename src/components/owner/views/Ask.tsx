"use client";

import { useEffect, useRef, useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OwnerReply } from "@/lib/owner/command-service";
import type { RunCommand } from "./Today";
import { Empty } from "../ui";
import { ownerPresence } from "@/lib/owner/presence-model";
import { CommandReply } from "./live";
import { BarryOrb, CommandBar, Hero, Icon, IconTile, Panel, PanelHeader, type IconName } from "../kit";
import { WhatsAppCard } from "../OwnerShell";


const PROMPTS: { q: string; icon: IconName; hint: string }[] = [
  { q: "What should I focus on today?", icon: "flag", hint: "Priorities from your records" },
  { q: "What needs me?", icon: "shield", hint: "Decisions and handoffs" },
  { q: "Where is money stuck?", icon: "money", hint: "Unpaid, waiting, at risk" },
  { q: "What happened today?", icon: "pulse", hint: "What BARRY did" },
  { q: "What failed?", icon: "alert", hint: "Anything that didn't go through" },
  { q: "What can you do right now?", icon: "barry", hint: "Capabilities and limits" },
];

type Exchange = { q: string; reply: OwnerReply };

/**
 * ASK BARRY — ask or direct BARRY in words. Every question and instruction goes through the SAME owner
 * command service as the WhatsApp owner channel: answers come only from this business's records,
 * operations are grounded before anything runs, decisions run only against the exact request shown.
 */
export function AskView({ onCommand, ws, initialQuestion }: { onCommand: RunCommand; ws: OwnerWorkspace; onIntervention?: (id: string) => void; onOpen?: (id: string) => void; initialQuestion?: string }) {
  const [q, setQ] = useState(initialQuestion ?? "");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Exchange[]>([]);
  const presence = ownerPresence(ws);
  const asked = useRef(false);
  useEffect(() => {
    if (!initialQuestion?.trim() || asked.current) return;
    // The guard is set when the question actually fires, so a cancelled timer (StrictMode re-run) still asks once.
    const t = setTimeout(() => {
      asked.current = true;
      void ask({ text: initialQuestion }, initialQuestion);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);
  const ask = async (body: { text?: string; actionId?: string }, label: string) => {
    if (!body.text?.trim() && !body.actionId) return;
    setBusy(true);
    try {
      const reply = await onCommand(body);
      setHistory((h) => [{ q: label, reply }, ...h]);
      setQ("");
    } catch (e) {
      setHistory((h) => [{ q: label, reply: { text: e instanceof Error ? e.message : "Something went wrong", intent: "unsupported" } }, ...h]);
    } finally {
      setBusy(false);
    }
  };
  const canNow = ws.capabilities.now.slice(0, 6);
  return (
    <div className="flex flex-col gap-6">
      <Hero eyebrow={`BARRY · ${ws.business.name}`} title={<>Ask BARRY about <span className="o-hero-type">your business.</span></>} lead="Answers come only from your records, and link to the exact thing to decide, open or unlock. Tell him what to do and he'll show you how it really runs." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <CommandBar value={q} onChange={setQ} busy={busy} state={presence.state} placeholder="Ask BARRY, or tell him what to do…" onSubmit={(v) => void ask({ text: v }, v)} />

          {history.length === 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PROMPTS.map((p) => (
                <button key={p.q} onClick={() => void ask({ text: p.q }, p.q)} disabled={busy} className="o-panel flex items-center gap-3 rounded-2xl p-3.5 text-left transition hover:shadow-o-glow disabled:opacity-60">
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
                <button key={p.q} className="rounded-full bg-o-sunken px-3 py-1.5 text-[12.5px] text-o-ink-2 ring-1 ring-inset ring-o-line transition hover:text-o-ink" onClick={() => void ask({ text: p.q }, p.q)} disabled={busy}>
                  {p.q}
                </button>
              ))}
            </div>
          )}

          {busy && (
            <Panel className="p-4">
              <p className="flex items-center gap-2 text-[13px] text-o-muted">
                <BarryOrb size={18} state="working" /> BARRY is reading your records…
              </p>
            </Panel>
          )}

          <ul className="flex flex-col gap-1">
            {history.map((h, i) => (
              <li key={`${history.length - i}`}>
                <CommandReply text={h.q} reply={h.reply} busy={busy} onAction={(id) => void ask({ actionId: id }, h.q)} onClose={() => setHistory((x) => x.filter((_, j) => j !== i))} />
              </li>
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
