"use client";

import { useCallback, useEffect, useState } from "react";
import type { useOwnerApi } from "./useOwnerApi";
import { btn, primary, quiet } from "./ui";
import { Icon, LiveDot, Panel, PanelHeader } from "./kit";

type Api = ReturnType<typeof useOwnerApi>;
type LinkRow = { id: string; number: string; status: "active" | "revoked" | "inactive"; linkedAt: string; lastMessageAt: string | null };
type State = { line: { configured: boolean; sendMode: "live" | "dry_run"; display: string | null }; links: LinkRow[] };

/**
 * YOUR WHATSAPP — link the owner's own number to this business. The owner (signed in here) gets a
 * one-time code and sends it FROM their WhatsApp to BARRY's owner line; that proves the number is
 * theirs. One business per link; revoking (or a change of owner access) stops it immediately.
 */
export function WhatsAppLink({ api, onChanged }: { api: Api; onChanged?: () => void }) {
  const { businessId, call } = api;
  const [state, setState] = useState<State | null>(null);
  const [code, setCode] = useState<{ send: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => call<State>(`/api/owner/whatsapp?businessId=${encodeURIComponent(businessId)}`).then(setState).catch((e: Error) => setError(e.message)), [businessId, call]);
  useEffect(() => {
    if (businessId) void load();
  }, [businessId, load]);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const r = await call<{ send?: string; expiresAt?: string }>("/api/owner/whatsapp", { body: { businessId, ...body } });
      if (r.send && r.expiresAt) setCode({ send: r.send, expiresAt: r.expiresAt });
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  const active = state?.links.filter((l) => l.status === "active") ?? [];
  return (
    <Panel className="scroll-mt-24 p-4 md:p-5" id="whatsapp">
      <PanelHeader icon="chat" tone="ok" title="Run BARRY from your WhatsApp" sub="Your own number, linked to this business only. BARRY answers from your records, starts work only within your plan and rules, and asks before anything above your limits." />
      {!state ? null : !state.line.configured ? (
        <p className="mt-3 text-[13px] text-o-muted">BARRY&apos;s owner WhatsApp line isn&apos;t set up yet — the BARRY team turns it on. Until then, ask BARRY in Ask BARRY; it&apos;s the same service.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {state.line.sendMode === "dry_run" && <p className="text-[12.5px] text-o-warn">Test mode: BARRY records its WhatsApp replies but doesn&apos;t send them yet.</p>}
          {active.length > 0 && (
            <ul className="divide-y divide-o-line">
              {state.links.filter((l) => l.status !== "revoked").map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13.5px]">
                  <span className="flex items-center gap-2 text-o-ink">
                    <LiveDot state={l.status === "active" ? "live" : "off"} /> WhatsApp {l.number}
                    <span className="text-[12px] text-o-faint">{l.status === "active" ? (l.lastMessageAt ? `last message ${new Date(l.lastMessageAt).toLocaleString()}` : "linked") : "inactive — owner access changed; link again"}</span>
                  </span>
                  <button type="button" className={quiet} disabled={busy} onClick={() => void act({ action: "revoke", id: l.id })}>Revoke</button>
                </li>
              ))}
            </ul>
          )}
          {code ? (
            <div className="rounded-xl bg-o-sunken/70 p-3.5 ring-1 ring-inset ring-o-line">
              <p className="text-[13px] text-o-muted">From your WhatsApp, send this to BARRY{state.line.display ? ` (+${state.line.display})` : ""} within 15 minutes:</p>
              <p className="mt-1.5 select-all font-mono text-[20px] font-semibold tracking-wider text-o-ink">{code.send}</p>
              {state.line.display && (
                <a className={`${primary} mt-3`} href={`https://wa.me/${state.line.display}?text=${encodeURIComponent(code.send)}`} target="_blank" rel="noreferrer">
                  Open WhatsApp <Icon name="arrow" size={15} />
                </a>
              )}
            </div>
          ) : (
            <button type="button" className={`${active.length ? btn : primary} self-start`} disabled={busy} onClick={() => void act({ action: "code" })}>
              {active.length ? "Link another number" : "Link WhatsApp"}
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-[12.5px] text-o-bad">{error}</p>}
    </Panel>
  );
}
