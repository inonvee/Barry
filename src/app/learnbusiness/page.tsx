"use client";

import { useEffect, useState } from "react";
import { OwnerBar, useOwnerApi } from "@/components/owner/useOwnerApi";
import type { LearnedFactRecord, LearningRunRecord, OperatingStrategyRecord } from "@/lib/store/types";

type Question = { key: string; question: string; reason: string; capability: string; kind: "missing_fact" | "owner_decision" };
type Blocker = { capability: string; reason: string; fix: string };
type Workspace = {
  business: { id: string; name: string };
  capabilities: string[];
  run: LearningRunRecord | null;
  facts: LearnedFactRecord[];
  questions: Question[];
  needsReview: { key: string; factId: string }[];
  readiness: {
    understanding: { state: string; verifiedFacts: number; candidateFacts: number; requirementsMet: number; requirementsTotal: number };
    operational: { state: "ready" | "blocked"; blockers: Blocker[] };
  };
  strategy: OperatingStrategyRecord | null;
};

const card = "rounded-lg border border-[#d0d5dd] bg-white p-4 md:p-5";
const btn = "rounded-md border border-[#98a2b3] px-3 py-1.5 text-sm font-medium text-[#344054] disabled:opacity-50";
const primary = "rounded-md bg-[#1d2939] px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

function statusTone(status: LearnedFactRecord["status"]): string {
  switch (status) {
    case "verified":
    case "corrected":
      return "bg-[#ecfdf3] text-[#027a48]";
    case "rejected":
      return "bg-[#fef3f2] text-[#b42318]";
    default:
      return "bg-[#fffaeb] text-[#b54708]";
  }
}

function FactRow({ fact, busy, onReview }: { fact: LearnedFactRecord; busy: boolean; onReview: (action: "verify" | "correct" | "reject", value?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fact.value);
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{fact.key}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${statusTone(fact.status)}`}>{fact.status}</span>
        <span className="rounded-full bg-[#f2f4f7] px-2 py-0.5 text-xs text-[#475467]">{fact.classification}</span>
        <span className="text-xs text-[#667085]">confidence: {fact.confidence}</span>
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={value} onChange={(e) => setValue(e.target.value)} className="flex-1 rounded-md border border-[#d0d5dd] px-3 py-1.5 text-sm" />
          <button className={btn} disabled={busy || !value.trim()} onClick={() => { onReview("correct", value); setEditing(false); }}>
            Save correction
          </button>
          <button className={btn} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <p className="mt-1 break-words text-[15px]">{fact.value}</p>
      )}
      {fact.correctedFrom && <p className="mt-1 text-xs text-[#667085]">Learned value was: {fact.correctedFrom}</p>}
      <p className="mt-1 break-words text-xs text-[#667085]">
        {fact.source.kind === "web" ? (
          <>
            Source:{" "}
            <a className="underline" href={fact.source.url} target="_blank" rel="noopener noreferrer">
              {fact.source.url}
            </a>{" "}
            — “{fact.source.quote}”
          </>
        ) : (
          <>Source: owner{fact.reviewedAt ? ` · ${new Date(fact.reviewedAt).toLocaleString()}` : ""}</>
        )}
      </p>
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          {fact.status !== "verified" && <button className={btn} disabled={busy} onClick={() => onReview("verify")}>Verify</button>}
          <button className={btn} disabled={busy} onClick={() => setEditing(true)}>Correct</button>
          {fact.status !== "rejected" && <button className={btn} disabled={busy} onClick={() => onReview("reject")}>Reject</button>}
        </div>
      )}
    </li>
  );
}

function QuestionRow({ q, busy, onAnswer }: { q: Question; busy: boolean; onAnswer: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <li className="rounded-md bg-[#f9fafb] p-4">
      <p className="font-medium">{q.question}</p>
      <p className="mt-1 text-sm text-[#667085]">{q.reason}</p>
      <p className="mt-1 text-xs uppercase tracking-[0.14em] text-[#667085]">
        {q.capability} · {q.kind === "owner_decision" ? "your decision" : "missing fact"}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Your answer" className="flex-1 rounded-md border border-[#d0d5dd] bg-white px-3 py-1.5 text-sm" />
        <button className={btn} disabled={busy || !value.trim()} onClick={() => { onAnswer(value); setValue(""); }}>
          Save
        </button>
      </div>
    </li>
  );
}

export default function LearnBusinessPage() {
  const api = useOwnerApi();
  const { businessId, call } = api;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [urls, setUrls] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    call<Workspace>(`/api/learnbusiness?businessId=${encodeURIComponent(businessId)}`)
      .then((data) => {
        if (cancelled) return;
        setWorkspace(data);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setWorkspace(null);
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, call]);

  async function act<T extends { workspace: Workspace }>(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const result = await call<T>(url, { body });
      setWorkspace(result.workspace);
      return result;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sourceList = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  const runSummary = workspace?.run?.summary as { learner?: string; sources?: { url: string; ok: boolean; error?: string; stored?: number; rejected?: { key: string; reason: string }[] }[] } | undefined;

  return (
    <main className="min-h-screen bg-[#f7f7f4] px-4 py-6 text-[#171717] md:px-5 md:py-8">
      <section className="mx-auto max-w-6xl space-y-6">
        <OwnerBar
          api={api}
          title="Learn your business"
          subtitle="Approve the pages BARRY may read. Every learned fact cites the exact text it came from, and nothing becomes operating truth until you verify it."
        />

        {error && <p className="rounded-md border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm text-[#b42318]">{error}</p>}

        <section className={card}>
          <h2 className="text-lg font-semibold">1. Approve sources</h2>
          <p className="mt-1 text-sm text-[#667085]">Public http(s) pages only, up to 8. BARRY fetches them once, safely, and treats their content as data — never as instructions.</p>
          <textarea
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            rows={3}
            placeholder={"https://your-site.example/\nhttps://your-site.example/shipping"}
            className="mt-3 w-full rounded-md border border-[#d0d5dd] px-3 py-2 font-mono text-sm"
          />
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-1" />
            I approve BARRY reading exactly these {sourceList.length || ""} page(s) for {workspace?.business.name ?? "this business"}.
          </label>
          <button
            className={`${primary} mt-3`}
            disabled={busy || !approved || sourceList.length === 0 || sourceList.length > 8}
            onClick={async () => {
              const result = await act<{ workspace: Workspace }>("/api/learnbusiness", { businessId, urls: sourceList, approved: true });
              if (result) setApproved(false);
            }}
          >
            {busy ? "Working…" : "Learn from these pages"}
          </button>
          {workspace?.run && (
            <div className="mt-4 text-sm">
              <p>
                Last run: <span className="font-medium">{workspace.run.status}</span> · learner: {runSummary?.learner ?? "—"} ·{" "}
                {new Date(workspace.run.createdAt).toLocaleString()}
              </p>
              <ul className="mt-2 space-y-1">
                {runSummary?.sources?.map((s) => (
                  <li key={s.url} className="break-words text-[#475467]">
                    {s.ok ? "✓" : "✗"} {s.url} {s.ok ? `— ${s.stored ?? 0} fact(s) stored${s.rejected?.length ? `, ${s.rejected.length} unsupported candidate(s) discarded` : ""}` : `— ${s.error}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {workspace && (
          <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
            <section className={card}>
              <h2 className="text-lg font-semibold">2. Review what BARRY learned</h2>
              {workspace.facts.length === 0 ? (
                <p className="mt-3 text-sm text-[#667085]">Nothing learned yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-[#eaecf0]">
                  {workspace.facts.map((fact) => (
                    <FactRow
                      key={`${fact.id}:${fact.status}:${fact.value}`}
                      fact={fact}
                      busy={busy}
                      onReview={(action, value) => void act("/api/learnbusiness/facts", { businessId, factId: fact.id, action, value })}
                    />
                  ))}
                </ul>
              )}
            </section>

            <div className="space-y-6">
              <section className={card}>
                <h2 className="text-lg font-semibold">3. Answer what&apos;s missing</h2>
                <p className="mt-1 text-sm text-[#667085]">Asked because of what BARRY will do for you ({workspace.capabilities.join(", ") || "no capabilities enabled"}), not because of your industry.</p>
                {workspace.questions.length === 0 ? (
                  <p className="mt-3 text-sm text-[#667085]">No open questions.</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {workspace.questions.map((q) => (
                      <QuestionRow key={q.key} q={q} busy={busy} onAnswer={(value) => void act("/api/learnbusiness/answers", { businessId, key: q.key, value })} />
                    ))}
                  </ul>
                )}
              </section>

              <section className={card}>
                <h2 className="text-lg font-semibold">4. Readiness</h2>
                <p className="mt-2 text-sm">
                  Understanding: <span className="font-medium">{workspace.readiness.understanding.state}</span> ({workspace.readiness.understanding.requirementsMet}/
                  {workspace.readiness.understanding.requirementsTotal} requirements verified)
                </p>
                <p className="mt-1 text-sm">
                  Operational: <span className="font-medium">{workspace.readiness.operational.state}</span>
                </p>
                <ul className="mt-3 space-y-2 text-sm">
                  {workspace.readiness.operational.blockers.map((b, i) => (
                    <li key={i} className="rounded-md bg-[#f9fafb] p-3">
                      <span className="text-xs uppercase tracking-[0.14em] text-[#667085]">{b.capability}</span>
                      <p>{b.reason}</p>
                      <p className="text-[#667085]">{b.fix}</p>
                    </li>
                  ))}
                </ul>
                <button className={`${btn} mt-3`} disabled={busy} onClick={() => void act("/api/learnbusiness/strategy", { businessId })}>
                  Generate operating strategy
                </button>
                {workspace.strategy && (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer">Operating strategy · {new Date(workspace.strategy.generatedAt).toLocaleString()}</summary>
                    <pre className="mt-2 overflow-x-auto rounded-md bg-[#f9fafb] p-3 text-xs">{JSON.stringify(workspace.strategy.strategy, null, 2)}</pre>
                  </details>
                )}
              </section>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
