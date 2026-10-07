"use client";

import { useEffect, useRef, useState } from "react";

type Check = { stage: string; name: string; ok: boolean; detail?: unknown };
type Report = { runId?: string; verdict?: "PASS" | "FAIL"; passed?: number; failed?: number; deployment?: Record<string, unknown>; conversations?: string[]; checks?: Check[]; error?: string; missing?: string[]; timedOut?: boolean; busy?: boolean; restore?: unknown; state?: unknown };
type Status = "pending" | "running" | "pass" | "fail" | "timeout" | "error" | "skipped";
type StageRun = { stage: string; status: Status; startedAt?: number; ms?: number; httpStatus?: number; runId?: string; report?: Report; why?: string };
type RestoreState = { status: "idle" | "running" | "done" | "failed"; detail?: unknown; attempts?: number };

const DEFAULT_ENDPOINT = "/api/qa/owner-whatsapp";
/** The client gives a stage a little longer than Vercel's 300s limit before calling it a timeout. */
const CLIENT_TIMEOUT_MS = 320_000;
const RESTORE_RETRY_MS = 15_000;
const RESTORE_MAX_MS = 6 * 60_000;
const btn: React.CSSProperties = { padding: "8px 14px", border: "1px solid #999", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14 };
const color: Record<Status, string> = { pending: "inherit", running: "#1d4ed8", pass: "#15803d", fail: "#b91c1c", timeout: "#b45309", error: "#b91c1c", skipped: "#6b7280" };
const word: Record<Status, string> = { pending: "pending", running: "running", pass: "PASS", fail: "FAIL", timeout: "TIMEOUT", error: "ERROR", skipped: "not run" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (ms?: number) => (ms === undefined ? "" : `${Math.round(ms / 1000)}s`);

async function post(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; json: Report; text?: string }> {
  const res = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as Report };
  } catch {
    // e.g. Vercel's own FUNCTION_INVOCATION_TIMEOUT page
    return { status: res.status, json: { error: text.slice(0, 200) || `HTTP ${res.status}` }, text };
  }
}

/** The exact request each stage sends: one POST per stage, carrying ONLY that stage (pure — tested). */
export function stageRequestBodies(stages: readonly string[]): { stages: string[] }[] {
  return stages.map((stage) => ({ stages: [stage] }));
}

/** The checks whose evidence is always shown, pass or fail: by name prefix and/or by stage (pure — tested). */
export function evidenceChecks<C extends { stage: string; name: string }>(checks: C[], o: { evidenceCheck?: string; evidenceStage?: string }): C[] {
  return checks.filter((c) => (o.evidenceCheck !== undefined && c.name.startsWith(o.evidenceCheck)) || (o.evidenceStage !== undefined && c.stage === o.evidenceStage));
}

/**
 * One click: every stage as its own POST, one after another (each fits Vercel's 300s limit), live progress, stop
 * at the first failure or timeout, then restore the test business (retrying while a killed stage's lock expires).
 * No logic of its own beyond sequencing — every check runs on the server; this page only sends the HQ cookie.
 */
export function SequentialRunner({ stages, endpoint = DEFAULT_ENDPOINT, label = "Run full Owner WhatsApp acceptance", evidenceCheck, evidenceStage }: { stages: readonly string[]; endpoint?: string; label?: string; /** Always show this check's evidence (by name prefix), pass or fail. */ evidenceCheck?: string; /** Always show the evidence of EVERY check of this stage, pass or fail. */ evidenceStage?: string }) {
  const [runs, setRuns] = useState<StageRun[]>(() => stages.map((stage) => ({ stage, status: "pending" })));
  const [active, setActive] = useState(false);
  const [restore, setRestore] = useState<RestoreState>({ status: "idle" });
  const [cleanup, setCleanup] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const runsRef = useRef(runs);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const update = (i: number, patch: Partial<StageRun>) => setRuns((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** Restore from the durable restore point; while a (killed) stage still holds the lock, retry until it frees. */
  const restoreBusiness = async (why: string) => {
    setRestore({ status: "running", detail: why, attempts: 0 });
    const until = Date.now() + RESTORE_MAX_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await post(endpoint, { restore: true });
        if (r.status === 200) return setRestore({ status: "done", detail: r.json, attempts: attempt });
        if (r.status !== 409 || Date.now() > until) return setRestore({ status: "failed", detail: { http: r.status, ...r.json }, attempts: attempt });
        setRestore({ status: "running", detail: { waiting: "a stage still holds the lock — retrying", state: r.json.state }, attempts: attempt });
      } catch (err) {
        if (Date.now() > until) return setRestore({ status: "failed", detail: err instanceof Error ? err.message : "request failed", attempts: attempt });
      }
      await sleep(RESTORE_RETRY_MS);
    }
  };

  const runAll = async () => {
    setActive(true);
    setCleanup(null);
    setRestore({ status: "idle" });
    setRuns(stages.map((stage) => ({ stage, status: "pending" })));
    // Recover anything a previous interrupted run left behind before starting (waits while a run still holds the lock).
    setPreflight("Recovering the test business from any interrupted earlier run…");
    await restoreBusiness("before the run");
    setPreflight(null);
    let stopAt: number | null = null;
    const bodies = stageRequestBodies(stages);
    for (const i of stages.keys()) {
      const startedAt = Date.now();
      update(i, { status: "running", startedAt });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
      let patch: Partial<StageRun>;
      try {
        const r = await post(endpoint, bodies[i], controller.signal);
        const ms = Date.now() - startedAt;
        if (r.status === 200 && r.json.verdict === "PASS") patch = { status: "pass", ms, httpStatus: r.status, runId: r.json.runId, report: r.json };
        else if (r.status === 504 || r.json.timedOut || /FUNCTION_INVOCATION_TIMEOUT|timed out/i.test(r.text ?? "")) patch = { status: "timeout", ms, httpStatus: r.status, runId: r.json.runId, report: r.json, why: r.json.error ?? "the function hit its time limit" };
        else if (r.status === 422) patch = { status: "fail", ms, httpStatus: r.status, runId: r.json.runId, report: r.json, why: `${r.json.failed ?? "?"} check(s) failed` };
        else patch = { status: "error", ms, httpStatus: r.status, runId: r.json.runId, report: r.json, why: r.json.error ?? `HTTP ${r.status}` };
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        patch = { status: aborted ? "timeout" : "error", ms: Date.now() - startedAt, why: aborted ? `no response after ${CLIENT_TIMEOUT_MS / 1000}s` : err instanceof Error ? err.message : "request failed" };
      } finally {
        clearTimeout(timer);
      }
      update(i, patch);
      if (patch.status !== "pass") {
        stopAt = i;
        break;
      }
    }
    if (stopAt !== null) setRuns((rs) => rs.map((r, j) => (j > stopAt! ? { ...r, status: "skipped" } : r)));
    // Every stage restores itself; this confirms it (and repairs it after a timeout or a killed function).
    await restoreBusiness(stopAt === null ? "after the run (confirm)" : `after ${stages[stopAt]} stopped the run`);
    setActive(false);
  };

  const cleanAll = async () => {
    const ids = runsRef.current.map((r) => r.runId).filter((x): x is string => Boolean(x));
    let deleted = 0;
    for (const id of ids) deleted += ((await post(endpoint, { cleanup: id })).json as { conversationsDeleted?: number }).conversationsDeleted ?? 0;
    setCleanup(`Deleted ${deleted} synthetic conversation(s) across ${ids.length} stage run(s).`);
  };

  const allChecks = runs.flatMap((r) => (r.report?.checks ?? []).map((c) => ({ ...c, run: r.stage })));
  const failedChecks = allChecks.filter((c) => !c.ok);
  const finished = !active && runs.some((r) => r.status !== "pending");
  const allPass = runs.every((r) => r.status === "pass");
  const verdict = !finished ? null : allPass && restore.status === "done" ? "PASS" : "FAIL";
  const stopped = runs.find((r) => r.status === "fail" || r.status === "timeout" || r.status === "error");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
      <div>
        <button style={{ ...btn, fontWeight: 600 }} disabled={active} onClick={() => void runAll()}>
          {label}
        </button>
      </div>
      {preflight && <p role="status">{preflight}</p>}

      <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            {["Stage", "Status", "Time", "Checks", "runId"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: 4 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.stage} style={{ borderTop: "1px solid #8884" }}>
              <td style={{ padding: 4 }}>{r.stage}</td>
              <td style={{ padding: 4, fontWeight: 600, color: color[r.status] }}>{word[r.status]}{r.status === "running" ? "…" : ""}</td>
              <td style={{ padding: 4 }}>{r.status === "running" && r.startedAt ? secs(Math.max(0, now - r.startedAt)) : secs(r.ms)}</td>
              <td style={{ padding: 4 }}>{r.report?.checks ? `${r.report.passed}/${r.report.checks.length}` : ""}</td>
              <td style={{ padding: 4 }}>{r.runId ? <code>{r.runId}</code> : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {verdict && (
        <p style={{ fontSize: 18 }}>
          <strong style={{ color: verdict === "PASS" ? "#15803d" : "#b91c1c" }}>{verdict}</strong>
          {" · "}{allChecks.filter((c) => c.ok).length}/{allChecks.length} checks passed across {runs.filter((r) => r.report?.checks).length} stage(s)
          {" · "}business restore: {restore.status}
        </p>
      )}

      {stopped && (
        <section style={{ border: "1px solid #b91c1c", borderRadius: 6, padding: 10 }}>
          <p style={{ margin: 0, fontWeight: 600, color: color[stopped.status] }}>
            Stopped at “{stopped.stage}”: {word[stopped.status]}{stopped.httpStatus ? ` (HTTP ${stopped.httpStatus})` : ""} — {stopped.why}
          </p>
          {stopped.report?.checks?.filter((c) => !c.ok).map((c, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div><strong>[{c.stage}]</strong> {c.name}</div>
              {c.detail !== undefined && <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{JSON.stringify(c.detail, null, 1)}</pre>}
            </div>
          ))}
          {!stopped.report?.checks && stopped.report && <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>{JSON.stringify(stopped.report, null, 1)}</pre>}
        </section>
      )}

      {evidenceChecks(allChecks, { evidenceCheck, evidenceStage }).length > 0 && (
        <section style={{ border: "1px solid #8888", borderRadius: 6, padding: 10 }}>
          {evidenceChecks(allChecks, { evidenceCheck, evidenceStage }).map((c, i) => (
            <div key={i}>
              <div style={{ fontWeight: 600, color: c.ok ? "#15803d" : "#b91c1c" }}>{c.ok ? "PASS" : "FAIL"} — {c.name}</div>
              <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{JSON.stringify(c.detail ?? "no evidence recorded", null, 1)}</pre>
            </div>
          ))}
        </section>
      )}

      {restore.status !== "idle" && (
        <details open={restore.status !== "done"}>
          <summary style={{ fontWeight: 600, color: restore.status === "failed" ? "#b91c1c" : restore.status === "done" ? "#15803d" : "#1d4ed8" }}>
            Test business restore: {restore.status}{restore.attempts ? ` (attempt ${restore.attempts})` : ""}
          </summary>
          <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>{JSON.stringify(restore.detail, null, 1)}</pre>
        </details>
      )}
      {!active && restore.status === "failed" && (
        <div>
          <button style={btn} onClick={() => void restoreBusiness("manual retry")}>Retry restore</button>
        </div>
      )}

      {allChecks.length > 0 && (
        <details open={failedChecks.length > 0}>
          <summary>All checks ({allChecks.length}; {failedChecks.length} failed)</summary>
          <table style={{ borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
            <tbody>
              {allChecks.map((c, i) => (
                <tr key={i} style={{ borderTop: "1px solid #8884", verticalAlign: "top" }}>
                  <td style={{ padding: 4, fontWeight: 600, color: c.ok ? "#15803d" : "#b91c1c" }}>{c.ok ? "PASS" : "FAIL"}</td>
                  <td style={{ padding: 4 }}>{c.run}</td>
                  <td style={{ padding: 4 }}>{c.stage}</td>
                  <td style={{ padding: 4 }}>
                    {c.name}
                    {c.detail !== undefined && (
                      <details>
                        <summary style={{ fontSize: 12, opacity: 0.7 }}>detail</summary>
                        <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>{JSON.stringify(c.detail, null, 1)}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {finished && runs.some((r) => r.runId) && (
        <div>
          <button style={btn} disabled={active} onClick={() => void cleanAll()}>Clean synthetic conversations (all stage runs)</button>
          {cleanup && <p style={{ fontSize: 13 }}>{cleanup}</p>}
        </div>
      )}
    </div>
  );
}
