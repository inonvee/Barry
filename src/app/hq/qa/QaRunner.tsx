"use client";

import { useState } from "react";

type Check = { stage: string; name: string; ok: boolean; detail?: unknown };
type Report = { runId?: string; verdict?: "PASS" | "FAIL"; passed?: number; failed?: number; startedAt?: string; finishedAt?: string; deployment?: Record<string, unknown>; conversations?: string[]; checks?: Check[]; error?: string; missing?: string[] };

const STAGES = ["channel", "handoff", "supervised", "mode", "cron"];
const btn: React.CSSProperties = { padding: "6px 12px", border: "1px solid #999", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14 };

/** Calls the same-origin acceptance API with the HQ session cookie; renders what it returns. No logic here. */
export function QaRunner({ endpoint = "/api/qa/acceptance", stages = STAGES, label = "Run full Preview acceptance" }: { endpoint?: string; stages?: readonly string[]; label?: string } = {}) {
  const [running, setRunning] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [cleanup, setCleanup] = useState<string | null>(null);

  const call = async (label: string, body: Record<string, unknown>) => {
    setRunning(label);
    const started = Date.now();
    try {
      const res = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as Report & { conversationsDeleted?: number };
      if ("cleanup" in body) setCleanup(`Deleted ${json.conversationsDeleted ?? 0} synthetic conversation(s) for ${String(body.cleanup)} (${res.status}).`);
      else {
        setStatus(res.status);
        setReport(json);
        setCleanup(null);
      }
    } catch (err) {
      setStatus(0);
      setReport({ error: err instanceof Error ? err.message : "request failed" });
    } finally {
      setRunning(null);
      console.info(`[qa] ${label} took ${Math.round((Date.now() - started) / 1000)}s`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button style={{ ...btn, fontWeight: 600 }} disabled={Boolean(running)} onClick={() => void call("full", {})}>{label}</button>
        {stages.map((s) => (
          <button key={s} style={btn} disabled={Boolean(running)} onClick={() => void call(s, { stages: [s] })}>{s}</button>
        ))}
      </div>
      {running && <p role="status">Running {running}… (a full run takes a few minutes; keep this tab open)</p>}
      {report && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 16 }}>
            <strong style={{ color: report.verdict === "PASS" ? "#15803d" : "#b91c1c" }}>{report.verdict ?? "ERROR"}</strong>
            {" · "}HTTP {status}
            {report.runId && <> · runId <code>{report.runId}</code></>}
            {report.checks && <> · {report.passed}/{report.checks.length} checks passed</>}
          </p>
          {report.error && <p style={{ color: "#b91c1c" }}>{report.error}{report.missing ? ` — missing: ${report.missing.join(", ")}` : ""}</p>}
          {report.deployment && <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{JSON.stringify(report.deployment, null, 1)}</pre>}
          {report.checks && (
            <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr><th style={{ textAlign: "left", padding: 4 }}>Result</th><th style={{ textAlign: "left", padding: 4 }}>Stage</th><th style={{ textAlign: "left", padding: 4 }}>Check</th></tr>
              </thead>
              <tbody>
                {report.checks.map((c, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #8884", verticalAlign: "top" }}>
                    <td style={{ padding: 4, fontWeight: 600, color: c.ok ? "#15803d" : "#b91c1c" }}>{c.ok ? "PASS" : "FAIL"}</td>
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
          )}
          {report.conversations && report.conversations.length > 0 && <p style={{ fontSize: 12 }}>Synthetic conversations: {report.conversations.join(", ")}</p>}
          {report.runId && (
            <div>
              <button style={btn} disabled={Boolean(running)} onClick={() => void call("cleanup", { cleanup: report.runId })}>Clean synthetic conversations</button>
            </div>
          )}
          {cleanup && <p style={{ fontSize: 13 }}>{cleanup}</p>}
        </section>
      )}
    </div>
  );
}
