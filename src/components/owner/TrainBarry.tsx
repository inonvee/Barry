"use client";

import { useCallback, useEffect, useState } from "react";
import type { useOwnerApi } from "./useOwnerApi";
import { Section, Skeleton, StateNotice, btn, primary, quiet } from "./ui";
import { Disclosure, StatusPill, type Status } from "@/components/ds/primitives";
import type { TrainBarryView } from "@/lib/learn-business/train";

/**
 * TRAIN BARRY (Learn Business V1) — what BARRY understands, what it is unsure about, what changed,
 * what needs confirmation, what it can do now / after setup, and what to teach next. Owner words only;
 * confirm / correct / reject / decide happens here. Sources: website, catalog, document, systems, facts.
 */

type Api = ReturnType<typeof useOwnerApi>;
const AVAIL: Record<string, { status: Status; word: string }> = { can_do_now: { status: "ok", word: "Can do now" }, after_setup: { status: "not_ready", word: "After setup" }, simulator_only: { status: "simulator", word: "Simulator only" }, not_supported: { status: "neutral", word: "Not supported" } };

export function TrainBarry({ api }: { api: Api }) {
  const { businessId, call, authorized } = api;
  const [view, setView] = useState<TrainBarryView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [factsText, setFactsText] = useState("");
  const [doc, setDoc] = useState({ name: "", text: "" });
  const load = useCallback(() => {
    if (!businessId || !authorized) return;
    call<TrainBarryView>(`/api/learnbusiness/train?businessId=${encodeURIComponent(businessId)}`)
      .then((v) => {
        setView(v);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [businessId, call, authorized]);
  useEffect(() => load(), [load]);
  const act = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await call<{ train?: TrainBarryView }>(path, { body: { businessId, ...body } });
      if (r.train) setView(r.train);
      else load();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };
  if (!authorized) return null;
  if (error) return <StateNotice tone="bad" title="Couldn't load what BARRY has learned">{error}</StateNotice>;
  if (!view) return <div className="rounded-2xl bg-white p-5"><Skeleton lines={4} /></div>;
  return (
    <div className="flex flex-col gap-5">
      <Section title="What needs your confirmation" subtitle={view.needsConfirmation.length ? "One question each. BARRY keeps your approved values until you decide." : "Nothing waits on you."}>
        {view.needsConfirmation.length > 0 && (
          <ul className="divide-y divide-[#f2f4f7]">
            {view.needsConfirmation.map((n) => (
              <li key={n.id} className="flex flex-col gap-2 py-3">
                <p className="text-[14px] font-medium text-[#101828]">{n.question}</p>
                <p className="text-[13px] text-[#667085]">{n.explanation}</p>
                <div className="flex flex-wrap gap-2">
                  {n.refs.changeId && (<><button className={primary} disabled={busy} onClick={() => void act("/api/learnbusiness/changes", { changeId: n.refs.changeId, decision: "accepted" })}>Use the new value</button><button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/changes", { changeId: n.refs.changeId, decision: "kept_previous" })}>Keep mine</button></>)}
                  {n.refs.factId && !n.refs.changeId && (<><button className={primary} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: n.refs.factId, action: "verify" })}>Yes, that&apos;s right</button><button className={btn} disabled={busy} onClick={() => { const value = window.prompt("The correct value?"); if (value) void act("/api/learnbusiness/facts", { factId: n.refs.factId, action: "correct", value }); }}>Correct it</button><button className={quiet} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: n.refs.factId, action: "reject" })}>Not true</button></>)}
                  {n.refs.sourceId && <button className={quiet} disabled={busy} onClick={() => void act("/api/learnbusiness/sources", { type: "revoke", sourceId: n.refs.sourceId })}>Stop using this source</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="What BARRY understands" subtitle={`${view.counts.understands} things BARRY acts on. Each says where it came from and whether you approved it.`}>
        <ul className="divide-y divide-[#f2f4f7]">
          {view.understands.slice(0, 12).map((u) => (
            <li key={u.key} className="flex flex-col gap-0.5 py-2 text-[13px]">
              <span><span className="font-medium text-[#101828]">{u.label}</span>: {u.value}</span>
              <span className="text-[12px] text-[#667085]">{u.why}{u.freshness !== "n/a" ? ` · ${u.freshness}` : ""}</span>
            </li>
          ))}
        </ul>
        {view.understands.length > 12 && <p className="mt-2 text-[12px] text-[#667085]">+{view.understands.length - 12} more.</p>}
      </Section>

      {view.unsure.length > 0 && (
        <Section title="What BARRY is unsure about" subtitle="Learned but not confirmed — BARRY does not act on these.">
          <ul className="divide-y divide-[#f2f4f7]">
            {view.unsure.map((u) => (
              <li key={u.factId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                <span><span className="font-medium text-[#101828]">{u.label}</span>: {u.value} <span className="text-[#98a2b3]">· from {u.from} · {u.confidence} confidence</span></span>
                <span className="flex gap-2"><button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: u.factId, action: "verify" })}>Confirm</button><button className={quiet} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: u.factId, action: "reject" })}>Reject</button></span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="What BARRY can do" subtitle="From what it really runs on.">
        <ul className="divide-y divide-[#f2f4f7]">
          {[...view.canDoNow, ...view.afterSetup, ...view.notSupported].map((p) => (
            <li key={p.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
              <span className="flex flex-wrap items-center gap-2"><StatusPill status={AVAIL[p.availability].status}>{AVAIL[p.availability].word}</StatusPill><span className="font-medium text-[#101828]">{p.title}</span></span>
              <span className="text-[12px] text-[#667085]">{p.how}{p.missing.length ? ` · needs: ${p.missing.join(", ")}` : ""}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What to teach BARRY next" subtitle={view.teachNext.length ? "The minimum questions, most important first." : "Nothing missing for what BARRY does today."}>
        {view.teachNext.length > 0 && (
          <ul className="divide-y divide-[#f2f4f7]">
            {view.teachNext.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 py-2 text-[13px]">
                <span className="font-medium text-[#101828]">{t.question}</span>
                <span className="text-[12px] text-[#667085]">{t.why}</span>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem("answer") as HTMLInputElement).value; if (v.trim()) void act("/api/learnbusiness/answers", { key: t.key, value: v }); }}>
                  <input name="answer" placeholder="Your answer" className="min-h-10 min-w-0 flex-1 rounded-lg border border-[#d0d5dd] bg-white px-3 text-sm" />
                  <button className={btn} disabled={busy}>Teach</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Teach BARRY from a source" subtitle="You approve exactly what BARRY reads. Nothing is fetched or believed without that.">
        <div className="flex flex-col gap-3">
          <Disclosure summary="Tell BARRY facts directly (one per line: key = value)">
            <textarea value={factsText} onChange={(e) => setFactsText(e.target.value)} rows={3} placeholder={"hours.opening = Sun–Thu 10:00–19:00\npolicy.returns = 14 days with a receipt"} className="w-full rounded-lg border border-[#d0d5dd] p-2 text-sm" />
            <button className={`${btn} mt-2`} disabled={busy || !factsText.trim()} onClick={() => { const facts = factsText.split("\n").map((l) => l.split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => ({ key: k.trim(), value: v.join("=").trim() })); void act("/api/learnbusiness/sources", { type: "owner_facts", facts, approved: true }).then(() => setFactsText("")); }}>Teach these facts</button>
          </Disclosure>
          <Disclosure summary="Give BARRY a document (paste its text)">
            <input value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} placeholder="Document name (e.g. Store policy)" className="mb-2 w-full rounded-lg border border-[#d0d5dd] px-3 py-2 text-sm" />
            <textarea value={doc.text} onChange={(e) => setDoc({ ...doc, text: e.target.value })} rows={4} placeholder="Paste the document text" className="w-full rounded-lg border border-[#d0d5dd] p-2 text-sm" />
            <button className={`${btn} mt-2`} disabled={busy || !doc.name.trim() || !doc.text.trim()} onClick={() => void act("/api/learnbusiness/sources", { type: "document", name: doc.name, text: doc.text, approved: true }).then(() => setDoc({ name: "", text: "" }))}>Let BARRY read it</button>
          </Disclosure>
          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/sources", { type: "catalog", approved: true })}>Read the connected catalog</button>
            <button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/sources", { type: "connected_system", approved: true })}>Read what the connected systems report</button>
          </div>
          {view.sources.length > 0 && (
            <ul className="divide-y divide-[#f2f4f7] text-[13px]">
              {view.sources.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="font-medium text-[#101828]">{s.ref}</span> <span className="text-[#98a2b3]">· {s.type.replace(/_/g, " ")} · approved by {s.approvedBy}</span></span>
                  <StatusPill status={s.status === "fetched" ? (s.freshness === "stale" ? "attention" : "ok") : s.status === "approved" ? "neutral" : "blocked"}>{s.status === "fetched" ? s.freshness : s.status}</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}
