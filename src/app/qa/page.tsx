"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { OwnerBar, useOwnerApi } from "@/components/owner/useOwnerApi";
import { TestShell, useQaStatus } from "@/components/shell/TestShell";
import { Pill, Section, btn, primary } from "@/components/owner/ui";
import { getStoredConversationId } from "@/lib/simulator-session";
import { ManifestView, ScenarioFactory, TestOwnerSignIn } from "@/components/qa/FastLane";

/**
 * QA TOOLS (Preview/dev only — the APIs refuse on Vercel Production): deployment status, the one-shot
 * forced understanding failure, and simulated inbound WhatsApp through the real adapter + gateway.
 */

type WaResult = {
  messageId: string;
  normalized: { conversationId: string; customerId: string; businessId: string; text: string };
  result: { status: "processed" | "duplicate" | "failed"; conversationId: string; reply?: string; delivery?: { status: string; at: string; error?: string }; error?: string };
};

export default function QaPage() {
  const api = useOwnerApi();
  const status = useQaStatus(api.businessId);
  const [conversationId, setConversationId] = useState("");
  const [forceNote, setForceNote] = useState("");
  const [from, setFrom] = useState("972500000001");
  const [text, setText] = useState("");
  const [wa, setWa] = useState<WaResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const simulatorConversation = useSyncExternalStore(
    () => () => {},
    () => (api.businessId ? getStoredConversationId(api.businessId) : null),
    () => null
  );

  const force = async (active: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await api.call<{ note: string }>("/api/qa/force-understanding-failure", { body: { businessId: api.businessId, conversationId: conversationId || simulatorConversation, active } });
      setForceNote(r.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const sendWa = async (messageId?: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await api.call<WaResult>("/api/qa/whatsapp-inbound", { body: { businessId: api.businessId, from, text: messageId ? (wa.find((w) => w.messageId === messageId)?.normalized.text ?? text) : text, ...(messageId ? { messageId } : {}) } });
      setWa((w) => [r, ...w]);
      if (!messageId) setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f9fafb] text-[#101828]">
      <TestShell active="qa" />
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6">
        <OwnerBar api={api} title="QA tools" subtitle="Test-only controls for this Preview. They never exist on Production and every action needs owner access to the business." />
        {status && !status.qaMode && <p className="rounded-lg border border-[#fecdca] bg-[#fef3f2] px-4 py-3 text-sm text-[#b42318]">QA mode is OFF on this deployment ({status.environment}). The tools below will be refused.</p>}
        {error && <p className="rounded-lg border border-[#fecdca] bg-[#fef3f2] px-4 py-3 text-sm text-[#b42318]">{error}</p>}

        <TestOwnerSignIn api={api} />
        <ScenarioFactory api={api} />
        <ManifestView />

        <Section title="Deployment status" subtitle="What is really configured — never secrets.">
          {status ? <pre className="overflow-x-auto rounded-lg bg-[#f9fafb] p-3 text-xs">{JSON.stringify(status, null, 2)}</pre> : <p className="text-sm text-[#667085]">Status unavailable.</p>}
        </Section>

        <Section title="Force the next understanding to fail (one shot)" subtitle="Tests what happens after BARRY can't understand a message: pending approvals must be HELD, nothing executes, and Re-check releases or supersedes them. Failure class: qa_forced_understanding_failure.">
          <label className="text-sm text-[#475467]">
            Conversation id
            <input value={conversationId} onChange={(e) => setConversationId(e.target.value)} placeholder={simulatorConversation ?? "open the simulator first"} className="mt-1 w-full rounded-md border border-[#d0d5dd] px-3 py-1.5 font-mono text-sm" />
          </label>
          <p className="mt-1 text-xs text-[#667085]">Empty = the simulator&apos;s current conversation for this business ({simulatorConversation ?? "none yet"}).</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={primary} disabled={busy || !(conversationId || simulatorConversation)} onClick={() => void force(true)}>
              Arm: fail next message
            </button>
            <button className={btn} disabled={busy || !(conversationId || simulatorConversation)} onClick={() => void force(false)}>
              Disarm
            </button>
          </div>
          {forceNote && <p className="mt-2 rounded-lg bg-[#fffaeb] px-3 py-2 text-sm text-[#b54708]">{forceNote}</p>}
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-[#475467]">
            <li>
              In the <Link className="underline" href="/simulator">simulator</Link>, create a request that needs approval (e.g. Logistics: a support case for a parcel).
            </li>
            <li>Arm the failure here, then send the customer&apos;s correction in the simulator.</li>
            <li>Owner → Approvals: the request is HELD (no Approve button). Inspector shows understanding failed (qa_forced_understanding_failure).</li>
            <li>Understanding is restored automatically (one shot). Press Re-check conversation: the correction is applied (request superseded) or, if unrelated, the hold is released.</li>
          </ol>
        </Section>

        <Section title="Simulate inbound WhatsApp (dry run)" subtitle="Builds a real Cloud API payload and runs it through the actual WhatsApp adapter and channel gateway. Replies are recorded as dry-run — nothing is ever sent to Meta.">
          <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
            <input aria-label="From (WhatsApp number)" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-[#d0d5dd] px-3 py-1.5 font-mono text-sm" />
            <input aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} placeholder="Customer message" className="rounded-md border border-[#d0d5dd] px-3 py-1.5 text-sm" />
            <button className={primary} disabled={busy || !text.trim()} onClick={() => void sendWa()}>
              Send inbound
            </button>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {wa.map((w, i) => (
              <li key={i} className="rounded-lg border border-[#eaecf0] p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={w.result.status === "processed" ? "good" : w.result.status === "duplicate" ? "warn" : "bad"}>{w.result.status === "duplicate" ? "DUPLICATE — ignored" : w.result.status.toUpperCase()}</Pill>
                  {w.result.delivery && <Pill tone={w.result.delivery.status === "dry_run" ? "neutral" : "bad"}>{`delivery: ${w.result.delivery.status}`}</Pill>}
                  <span className="break-all font-mono text-xs text-[#667085]">{w.messageId}</span>
                </div>
                <p className="mt-1 break-all text-xs text-[#667085]">conversation {w.normalized.conversationId} · customer {w.normalized.customerId}</p>
                <p className="mt-1">“{w.normalized.text}”</p>
                {w.result.reply && <p className="mt-1 whitespace-pre-wrap rounded-md bg-[#f2f4f7] px-2 py-1">BARRY (not sent): {w.result.reply}</p>}
                {w.result.error && <p className="mt-1 text-[#b42318]">{w.result.error}</p>}
                <button className={`${btn} mt-2`} disabled={busy} onClick={() => void sendWa(w.messageId)}>
                  Replay same message id
                </button>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Other acceptance recipes">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-[#475467]">
            <li>
              <b>Tenant isolation:</b> sign in with business A&apos;s token, switch the Business selector to B — the owner pages show &quot;signed in to a different business&quot; and every owner API returns 401. Sign in with B&apos;s token on A → &quot;That token belongs to a different business&quot;.
            </li>
            <li>
              <b>Handoff:</b> in the simulator, ask for a real person (&quot;I want to talk to a human&quot;). Owner → Health → Handoffs shows it OPEN with the summary; Acknowledge, then Mark resolved.
            </li>
            <li>
              <b>Revenue:</b> Owner → Today → &quot;Why these numbers&quot; lists every amount with its record; unpaid and simulated payments are never in COLLECTED.
            </li>
          </ul>
        </Section>
      </div>
    </main>
  );
}
