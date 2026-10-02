"use client";

import { useCallback, useEffect, useState } from "react";
import type { useOwnerApi } from "./useOwnerApi";
import { Pill, Section, Skeleton, StateNotice, btn, input, primary, quiet, type Tone } from "./ui";
import { Icon, IconTile, Panel, PanelHeader } from "./kit";
import type { TrainBarryView } from "@/lib/learn-business/train";

/**
 * TRAIN BARRY (Learn Business V1) — what BARRY understands, what it is unsure about, what changed,
 * what needs confirmation, what it can do now / after setup, and what to teach next. Owner words only;
 * confirm / correct / reject / decide happens here. Sources: website, catalog, document, systems, facts.
 */

type Api = ReturnType<typeof useOwnerApi>;
/** The operational statuses, made visual: what each means for BARRY right now. */
const FIELD: Record<string, { tone: Tone; meaning: string }> = {
  active: { tone: "good", meaning: "BARRY runs on this" },
  understood_only: { tone: "neutral", meaning: "On record — doesn't change what BARRY does" },
  replaced: { tone: "neutral", meaning: "A newer rule of yours replaced it" },
  needs_review: { tone: "warn", meaning: "Needs your answer before BARRY uses it" },
  blocked: { tone: "bad", meaning: "Can't become operational" },
};

function Fold({ summary, children, open, id }: { summary: string; children: React.ReactNode; open?: boolean; id?: string }) {
  return (
    <details id={id} open={open} className="group rounded-xl bg-o-sunken/60 px-3.5 py-3 ring-1 ring-inset ring-o-line">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[13.5px] font-medium text-o-ink-2">
        {summary}
        <Icon name="chevron" size={14} className="text-o-faint transition group-open:rotate-90" />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/**
 * `part` splits the one teaching surface across the Owner OS: "rules" (the rule questions and teaching a
 * rule — on Rules BARRY follows) and "knowledge" (what BARRY knows, is unsure about, should learn next and
 * where it came from — on What BARRY knows). Both read and write through the same Learn Business endpoints.
 */
export function TrainBarry({ api, part }: { api: Api; part: "rules" | "knowledge" }) {
  const { businessId, call, authorized } = api;
  const [view, setView] = useState<TrainBarryView | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [factsText, setFactsText] = useState("");
  const [doc, setDoc] = useState({ name: "", text: "" });
  // A rule typed into the command bar ("Don't offer more than 5% today") arrives as ?rule=… and goes
  // through the same reviewed path as any document: BARRY reads it, the owner sees how it will be
  // applied, and only then does the runtime enforce it.
  const [fromCommand, setFromCommand] = useState(false);
  useEffect(() => {
    const rule = new URLSearchParams(window.location.search).get("rule")?.trim();
    if (!rule) return;
    const t = setTimeout(() => {
      setDoc({ name: "Rule from the command bar", text: rule.slice(0, 1000) });
      setFromCommand(true);
      document.getElementById("teach-rule")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return () => clearTimeout(t);
  }, []);
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
      setActionError("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };
  if (!authorized) return null;
  if (error) return <StateNotice tone="bad" title="Couldn't load what BARRY has learned">{error}</StateNotice>;
  if (!view) return <Panel className="p-5"><Skeleton lines={4} /></Panel>;
  const questions = view.needsConfirmation.filter((n) => n.id.startsWith("rule:") === (part === "rules"));
  const questionsPanel = questions.length > 0 ? (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="flag" tone="warn" title="Needs your answer" sub="One question each. BARRY keeps your approved values until you decide." />
          <ul className="mt-3 flex flex-col gap-2">
            {questions.map((n) => (
              <li key={n.id} className="flex flex-col gap-2 rounded-xl bg-o-warn-bg/50 px-4 py-3 ring-1 ring-inset ring-o-warn-line">
                <p className="text-[14px] font-medium text-o-ink">{n.question}</p>
                <p className="text-[13px] text-o-muted">{n.explanation}</p>
                <div className="flex flex-wrap gap-2">
                  {n.refs.changeId && (<><button className={primary} disabled={busy} onClick={() => void act("/api/learnbusiness/changes", { changeId: n.refs.changeId, decision: "accepted" })}>Use the new value</button><button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/changes", { changeId: n.refs.changeId, decision: "kept_previous" })}>Keep mine</button></>)}
                  {n.refs.factId && !n.refs.changeId && (<><button className={primary} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: n.refs.factId, action: "verify" })}>Yes, that&apos;s right</button><button className={btn} disabled={busy} onClick={() => { const value = window.prompt("The correct value?"); if (value) void act("/api/learnbusiness/facts", { factId: n.refs.factId, action: "correct", value }); }}>Correct it</button><button className={quiet} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: n.refs.factId, action: "reject" })}>Not true</button></>)}
                  {n.refs.sourceId && <button className={quiet} disabled={busy} onClick={() => void act("/api/learnbusiness/sources", { type: "revoke", sourceId: n.refs.sourceId })}>Stop using this source</button>}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
  ) : null;
  if (part === "rules") {
    return (
      <div className="flex flex-col gap-5">
        {actionError && <StateNotice tone="bad" title="BARRY didn't save that">{actionError}</StateNotice>}
        {questionsPanel}
        <Panel className="p-4 md:p-5" id="teach-rule">
          <PanelHeader icon="shield" title="Teach BARRY a rule" sub="Write it like you'd tell a new employee (“Up to 5% discount without asking me”). BARRY reads it, shows you how it will apply it, and only uses it once you confirm." />
          <div className="mt-3 flex flex-col gap-2">
            <input value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} placeholder="A name for it (e.g. Discount rule)" className={`${input} text-sm`} />
            <textarea value={doc.text} onChange={(e) => setDoc({ ...doc, text: e.target.value })} rows={3} placeholder="The rule, in your words" className={`${input} min-h-0 py-2 text-sm`} />
            <button className={`${primary} w-fit`} disabled={busy || !doc.name.trim() || !doc.text.trim()} onClick={() => void act("/api/learnbusiness/sources", { type: "document", name: doc.name, text: doc.text, approved: true }).then(() => setDoc({ name: "", text: "" }))}>{fromCommand ? "Let BARRY read your rule" : "Let BARRY read it"}</button>
          </div>
        </Panel>
      </div>
    );
  }
  const statusCounts = view.understands.reduce<Record<string, number>>((m, u) => ((m[u.status] = (m[u.status] ?? 0) + 1), m), {});
  return (
    <div className="flex flex-col gap-5">
      {actionError && <StateNotice tone="bad" title="BARRY didn't save that">{actionError}</StateNotice>}


      {questionsPanel}

      {/* WHAT BARRY KNOWS — every row says what it means for BARRY now */}
      <Panel className="p-4 md:p-5">
        <PanelHeader icon="book" title="What BARRY knows" sub={`${view.counts.active} active — BARRY runs on them. “Understood only” is on record but doesn't change what BARRY does.`} />
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Status legend">
          {(["active", "understood_only", "replaced", "needs_review", "blocked"] as const).filter((k) => statusCounts[k] || k === "active").map((k) => (
            <li key={k} className="flex items-center gap-1.5 rounded-full bg-o-sunken/60 px-2.5 py-1 text-[12px] text-o-muted ring-1 ring-inset ring-o-line">
              <Pill tone={FIELD[k].tone}>{k === "understood_only" ? "UNDERSTOOD ONLY" : k === "needs_review" ? "NEEDS REVIEW" : k === "blocked" ? "BLOCKED" : k.toUpperCase()}</Pill>
              <span className="tabular-nums">{statusCounts[k] ?? 0}</span>
              <span className="hidden sm:inline">· {FIELD[k].meaning}</span>
            </li>
          ))}
        </ul>
        <ul className="mt-3 divide-y divide-o-line">
          {view.understands.slice(0, 12).map((u, i) => (
            <li key={`${u.key}:${i}`} className="flex flex-col gap-1 py-2.5 text-[13.5px]">
              <span className="flex flex-wrap items-center gap-2"><Pill tone={FIELD[u.status]?.tone ?? "neutral"}>{u.statusWords}</Pill><span className="text-o-ink-2"><span className="font-medium text-o-ink">{u.label}</span>: {u.value}</span></span>
              <span className="text-[12px] text-o-muted">{u.why}{u.freshness !== "n/a" ? ` · ${u.freshness}` : ""}</span>
            </li>
          ))}
        </ul>
        {view.understands.length > 12 && <p className="mt-2 text-[12px] text-o-muted">+{view.understands.length - 12} more.</p>}
      </Panel>

      {view.unsure.length > 0 && (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="alert" tone="warn" title="What BARRY is unsure about" sub="Learned but not confirmed — BARRY does not act on these." />
          <ul className="mt-3 divide-y divide-o-line">
            {view.unsure.map((u) => (
              <li key={u.factId} className="flex flex-col gap-2 py-2.5 text-[13.5px] sm:flex-row sm:items-center sm:justify-between">
                <span className="text-o-ink-2"><span className="font-medium text-o-ink">{u.label}</span>: {u.value} <span className="text-o-faint">· from {u.from} · {u.confidence} confidence</span></span>
                <span className="flex gap-2"><button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: u.factId, action: "verify" })}>Confirm</button><button className={quiet} disabled={busy} onClick={() => void act("/api/learnbusiness/facts", { factId: u.factId, action: "reject" })}>Reject</button></span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Section id="teach" title="What to teach BARRY next" subtitle={view.teachNext.length ? "The minimum questions, most important first." : "Nothing missing for what BARRY does today."}>
        {view.teachNext.length > 0 && (
          <ul className="flex flex-col gap-2">
            {view.teachNext.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 rounded-xl bg-o-sunken/60 px-3.5 py-3 ring-1 ring-inset ring-o-line">
                <span className="text-[14px] font-medium text-o-ink">{t.question}</span>
                <span className="text-[12px] text-o-muted">{t.why}</span>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem("answer") as HTMLInputElement).value; if (v.trim()) void act("/api/learnbusiness/answers", { key: t.key, value: v }); }}>
                  <input name="answer" placeholder="Tell BARRY, like you'd tell a new employee" className={`${input} min-h-10 min-w-0 flex-1 text-sm`} />
                  <button className={primary} disabled={busy}>Teach</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* SOURCES — where the knowledge came from */}
      <Panel className="p-4 md:p-5">
        <PanelHeader icon="receipt" title="Sources" sub="You approve exactly what BARRY reads. Nothing is fetched or believed without that." />
        {view.sources.length > 0 && (
          <ul className="mt-3 divide-y divide-o-line text-[13px]">
            {view.sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex min-w-0 items-center gap-2.5"><IconTile name="book" tone="neutral" size={28} /><span className="min-w-0"><span className="block truncate font-medium text-o-ink">{s.ref}</span><span className="text-o-faint">{s.type.replace(/_/g, " ")} · approved by {s.approvedBy}</span></span></span>
                <Pill tone={s.status === "fetched" ? (s.freshness === "stale" ? "warn" : "good") : s.status === "approved" ? "neutral" : "bad"}>{s.status === "fetched" ? s.freshness : s.status}</Pill>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-col gap-2">
          <Fold summary="Tell BARRY facts directly (one per line: key = value)">
            <textarea value={factsText} onChange={(e) => setFactsText(e.target.value)} rows={3} placeholder={"hours.opening = Sun–Thu 10:00–19:00\npolicy.returns = 14 days with a receipt"} className={`${input} min-h-0 py-2 text-sm`} />
            <button className={`${btn} mt-2`} disabled={busy || !factsText.trim()} onClick={() => { const facts = factsText.split("\n").map((l) => l.split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => ({ key: k.trim(), value: v.join("=").trim() })); void act("/api/learnbusiness/sources", { type: "owner_facts", facts, approved: true }).then(() => setFactsText("")); }}>Teach these facts</button>
          </Fold>
          <Fold summary="Give BARRY a document (paste its text)">
            <input value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} placeholder="Document name (e.g. Store policy)" className={`${input} mb-2 text-sm`} />
            <textarea value={doc.text} onChange={(e) => setDoc({ ...doc, text: e.target.value })} rows={4} placeholder="Paste the document text" className={`${input} min-h-0 py-2 text-sm`} />
            <button className={`${btn} mt-2`} disabled={busy || !doc.name.trim() || !doc.text.trim()} onClick={() => void act("/api/learnbusiness/sources", { type: "document", name: doc.name, text: doc.text, approved: true }).then(() => setDoc({ name: "", text: "" }))}>Let BARRY read it</button>
          </Fold>
          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/sources", { type: "catalog", approved: true })}>Read the connected catalog</button>
            <button className={btn} disabled={busy} onClick={() => void act("/api/learnbusiness/sources", { type: "connected_system", approved: true })}>Read what the connected systems report</button>
          </div>
        </div>
      </Panel>

    </div>
  );
}
