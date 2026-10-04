"use client";

import { useCallback, useEffect, useState } from "react";

type Identity = { ref: string; number: string; status: string; active: boolean; linkedAt: string; lastInboundAt: string | null; revokedAt: string | null; label: string | null };
type Modes = { customer: string; owner: string; founder: string; ownerLine: string; founderLine: string };
const btn: React.CSSProperties = { padding: "6px 12px", border: "1px solid #999", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14 };

/** Same-origin calls with the HQ session cookie only. */
export function FounderWhatsappAccess() {
  const [ids, setIds] = useState<Identity[]>([]);
  const [modes, setModes] = useState<Modes | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string; howTo: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/hq/founder/whatsapp", { credentials: "same-origin" });
    if (res.ok) {
      const json = (await res.json()) as { identities: Identity[]; sendModes: Modes };
      setIds(json.identities);
      setModes(json.sendModes);
    }
  }, []);
  useEffect(() => {
    let live = true;
    fetch("/api/hq/founder/whatsapp", { credentials: "same-origin" })
      .then((res) => (res.ok ? (res.json() as Promise<{ identities: Identity[]; sendModes: Modes }>) : null))
      .then((json) => {
        if (live && json) {
          setIds(json.identities);
          setModes(json.sendModes);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const post = async (body: Record<string, unknown>) => {
    setError(null);
    const res = await fetch("/api/hq/founder/whatsapp", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) setError(String(json.error ?? `HTTP ${res.status}`));
    return json;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
      {modes && (
        <p style={{ fontSize: 13 }}>
          Send modes — founder line: <strong>{modes.founder}</strong> ({modes.founderLine}) · owner line: <strong>{modes.owner}</strong> · customers: <strong>{modes.customer}</strong>
        </p>
      )}
      <div>
        <button style={{ ...btn, fontWeight: 600 }} onClick={async () => setCode((await post({ action: "link_code" })) as never)}>Get a link code</button>
      </div>
      {code?.code && (
        <p style={{ fontSize: 15 }}>
          Send <code style={{ fontSize: 17 }}>LINK {code.code}</code> — valid until {new Date(code.expiresAt).toLocaleTimeString()}.
        </p>
      )}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>{["Number", "Status", "Linked", "Last message", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: 4 }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {ids.map((i) => (
            <tr key={i.ref} style={{ borderTop: "1px solid #8884" }}>
              <td style={{ padding: 4 }}>{i.number}{i.label ? ` (${i.label})` : ""}</td>
              <td style={{ padding: 4 }}>{i.active ? "active" : i.status === "revoked" ? "revoked" : "inactive (founder token changed)"}</td>
              <td style={{ padding: 4 }}>{i.linkedAt.slice(0, 16).replace("T", " ")}</td>
              <td style={{ padding: 4 }}>{i.lastInboundAt?.slice(0, 16).replace("T", " ") ?? "—"}</td>
              <td style={{ padding: 4 }}>{i.status === "active" && <button style={btn} onClick={async () => { await post({ action: "revoke", ref: i.ref }); await load(); }}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
