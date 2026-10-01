"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { useOwnerApi } from "@/components/owner/useOwnerApi";
import { Pill, Section, btn, primary } from "@/components/owner/ui";
import type { QaScenario, QaScenarioRun } from "@/lib/qa/scenarios";
import type { QaResetResult } from "@/lib/qa/reset";

/**
 * QA FAST LANE — sign in as a test owner without a secret, build an acceptance state in one click,
 * reset the QA data, and read the acceptance manifest for this build. Preview / QA mode only.
 */

type Api = ReturnType<typeof useOwnerApi>;
type Manifest = { state: string; sha: string | null; preview: string | null; environment: string; nextProofRequired: string[]; gates: { id: string; label: string; status: string; detail: string }[]; manifest: { candidate: string; liveProofRequired: { id: string; title: string; where: string; risk: string }[]; doNotRetest: string[]; knownUnverified: string[]; knownBlockers: string[]; riskAreas: string[] }; verdict: { verdict: string; sha: string; at: string } | null };

export function TestOwnerSignIn({ api }: { api: Api }) {
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string; businesses: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/qa/owner-session").then((r) => (r.ok ? r.json() : { available: false, reason: "not available", businesses: [] })).then(setAvailability).catch(() => setAvailability(null));
  }, [api.session]);
  const signIn = async (businessId: string) => {
    setBusy(true);
    setError("");
    try {
      await api.call("/api/qa/owner-session", { body: { businessId } });
      api.setBusinessId(businessId);
      api.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Sign in as a test owner" subtitle="QA mode only. Issues the ordinary owner session for a TEST business — the token never leaves the server. Never on Production.">
      {!availability ? <p className="text-sm text-[#667085]">Checking…</p> : !availability.available ? <p className="text-sm text-[#b42318]">Not available: {availability.reason}.</p> : availability.businesses.length === 0 ? <p className="text-sm text-[#667085]">No test business has its own owner token in this environment (BARRY team: add one per test business to the Preview settings).</p> : (
        <div className="flex flex-wrap gap-2">
          {availability.businesses.map((id) => (
            <button key={id} className={api.businessId === id ? primary : btn} disabled={busy} onClick={() => void signIn(id)}>
              Sign in as {api.businesses.find((b) => b.id === id)?.name ?? id} test owner
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-[#b42318]">{error}</p>}
    </Section>
  );
}

export function ScenarioFactory({ api }: { api: Api }) {
  const [scenarios, setScenarios] = useState<QaScenario[]>([]);
  const [runs, setRuns] = useState<QaScenarioRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reset, setReset] = useState<QaResetResult | null>(null);
  const load = useCallback(() => {
    fetch(`/api/qa/scenarios?businessId=${encodeURIComponent(api.businessId)}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { scenarios: [], runs: [] }))
      .then((d: { scenarios: QaScenario[]; runs: QaScenarioRun[] }) => {
        setScenarios(d.scenarios);
        setRuns(d.runs);
      })
      .catch(() => undefined);
  }, [api.businessId]);
  useEffect(() => load(), [load, api.session]);
  const run = async (id: string) => {
    setBusy(id);
    setError("");
    setReset(null);
    try {
      const r = await api.call<{ run: QaScenarioRun }>("/api/qa/scenarios", { body: { businessId: api.businessId, scenario: id } });
      setRuns((rs) => [r.run, ...rs]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };
  const doReset = async () => {
    if (!window.confirm(`Delete every qa:-tagged record of ${api.business?.name ?? api.businessId}? Nothing else is touched.`)) return;
    setBusy("reset");
    setError("");
    try {
      const r = await api.call<{ result: QaResetResult }>("/api/qa/reset", { body: { businessId: api.businessId, confirm: true } });
      setReset(r.result);
      setRuns([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };
  const mine = scenarios.filter((s) => s.businessId === api.businessId);
  return (
    <Section
      title="Scenario factory"
      subtitle="One click builds an acceptance state through the real runtime (scripted understanding, simulated providers). Everything it creates is qa:-tagged test data; nothing is ever sent."
      right={<button className={btn} disabled={busy !== null || !api.authorized} onClick={() => void doReset()}>Reset QA data</button>}
    >
      {!api.authorized && <p className="text-sm text-[#b42318]">Sign in as this business&apos;s owner (or a test owner above) to run scenarios.</p>}
      {mine.length === 0 ? <p className="text-sm text-[#667085]">No scenarios for this business. Scenarios exist for: {[...new Set(scenarios.map((s) => s.businessId))].join(", ") || "—"}.</p> : (
        <ul className="divide-y divide-[#f2f4f7]">
          {mine.map((s) => (
            <li key={s.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-[12px] text-[#667085]">Expect: {s.expect}</p>
                <p className="text-[12px] text-[#98a2b3]">Creates: {s.creates.join(", ")}</p>
              </div>
              <button className={`${primary} shrink-0`} disabled={busy !== null || !api.authorized} onClick={() => void run(s.id)}>
                {busy === s.id ? "Running…" : "Run"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-[#b42318]">{error}</p>}
      {reset && <p className="mt-2 rounded-lg bg-[#fffaeb] px-3 py-2 text-sm text-[#b54708]">Reset {reset.businessId}: {reset.conversations} conversations, {Object.entries(reset.records).map(([k, v]) => `${v} ${k}`).join(", ")}, {reset.scenarioRuns} scenario runs, {reset.obligations} obligations, {reset.incidents} incident states — only records under “{reset.prefix}”.</p>}
      {runs.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {runs.slice(0, 8).map((r) => (
            <li key={r.runId} className="rounded-lg border border-[#eaecf0] p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {r.outcome === "expectedly_blocked" ? <Pill tone="good">EXPECTEDLY BLOCKED · PASS</Pill> : <Pill tone="good">created</Pill>}
                <span className="font-medium">{scenarios.find((s) => s.id === r.scenario)?.title ?? r.scenario}</span>
                <span className="break-all font-mono text-xs text-[#667085]">{r.conversationId}</span>
              </div>
              <p className="mt-1 text-[12px] text-[#667085]">Created: {r.created.join(", ")}{r.records.approvalId ? ` · approval ${r.records.approvalId.slice(0, 14)}` : ""}{r.records.paymentRequestId ? ` · payment ${r.records.paymentRequestId.slice(0, 14)}` : ""}{r.records.orderId ? ` · order ${r.records.orderId}` : ""}{r.records.handoffId ? ` · handoff ${r.records.handoffId.slice(0, 14)}` : ""}</p>
              {r.outcome === "expectedly_blocked" && r.blocked && <p className="mt-1 text-[12px] text-[#067647]">The {r.blocked.step} was refused by {r.blocked.policyId.replace("founder_control:", "the founder control “").replace(/_/g, " ")}” — the refusal is the expected result of that control, not a failure. No payment request was created.</p>}
              {r.note && r.outcome !== "expectedly_blocked" && <p className="mt-1 text-[12px] text-[#b54708]">{r.note}</p>}
              <div className="mt-1 flex flex-wrap gap-1.5">
                {r.links.map((l) => (
                  <Link key={l.href + l.label} href={l.href} className="rounded-full bg-[#f2f4f7] px-2 py-0.5 text-[12px] hover:underline">{l.label}</Link>
                ))}
              </div>
              {r.replies.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[12px] text-[#667085]">BARRY&apos;s replies ({r.replies.length})</summary>
                  <ul className="mt-1 space-y-1 text-[12px]">
                    {r.replies.map((t, i) => <li key={i} className="whitespace-pre-wrap rounded-md bg-[#f9fafb] px-2 py-1">{t}</li>)}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function ManifestView() {
  const [m, setM] = useState<Manifest | null>(null);
  useEffect(() => {
    fetch("/api/qa/manifest").then((r) => (r.ok ? r.json() : null)).then(setM).catch(() => setM(null));
  }, []);
  if (!m) return null;
  return (
    <Section title="Acceptance manifest (this build)" subtitle="What changed, what is proven, and the few things that need live proof. Only the founder's recorded verdict makes a build LIVE PASSED.">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill tone={m.state === "LIVE_PASSED" ? "good" : m.state === "BLOCKED" ? "bad" : "warn"}>{m.state.replace(/_/g, " ")}</Pill>
        <span className="font-mono text-xs">{m.sha ?? "local build"}</span>
        <span className="text-[#667085]">{m.environment}{m.preview ? ` · ${m.preview}` : ""}</span>
        {m.verdict && <span className="text-[#667085]">last verdict: {m.verdict.verdict} on {m.verdict.sha.slice(0, 7)}</span>}
      </div>
      <p className="mt-1 text-[13px] text-[#475467]">{m.manifest.candidate}</p>
      <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3]">Live proof required ({m.manifest.liveProofRequired.length})</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
        {m.manifest.liveProofRequired.map((c) => (
          <li key={c.id}>
            <span className="font-medium">{c.title}</span> <span className="text-[12px] text-[#667085]">· {c.where} · {c.risk}</span>
          </li>
        ))}
      </ol>
      <div className="mt-2 grid gap-2 text-[12px] text-[#475467] sm:grid-cols-2">
        <div>
          <p className="font-semibold text-[#98a2b3]">DO NOT RETEST</p>
          <ul className="list-disc pl-4">{m.manifest.doNotRetest.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
        <div>
          <p className="font-semibold text-[#98a2b3]">KNOWN UNVERIFIED · RISK AREAS</p>
          <ul className="list-disc pl-4">{[...m.manifest.knownUnverified, ...m.manifest.riskAreas].map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {m.gates.map((g) => (
          <li key={g.id}><Pill tone={g.status === "pass" ? "good" : g.status === "fail" ? "bad" : "neutral"}>{g.label}: {g.status}</Pill></li>
        ))}
      </ul>
    </Section>
  );
}
