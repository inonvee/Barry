"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { TestShell } from "@/components/shell/TestShell";
import { useBusiness } from "@/components/shell/useBusiness";
import { ChatPanel } from "@/components/ChatPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { ApprovalsPanel, type ApprovalView } from "@/components/ApprovalsPanel";
import { GraphPanel } from "@/components/GraphPanel";
import type { ConversationState } from "@/lib/state";
import type { BusinessGraph } from "@/lib/business-graph";
import {
  acceptConversation,
  createConversationId,
  getOrCreateCustomerId,
  getStoredConversationId,
  scopeKey,
  setStoredConversationId,
  simulatorView,
  type SimulatorData,
  type SimulatorScope,
} from "@/lib/simulator-session";

type Tab = "chat" | "inspector" | "approvals" | "graph";

type Data = SimulatorData<ConversationState, ApprovalView, BusinessGraph>;
const EMPTY: Data = { scope: null, conversation: null, approvals: null, graph: null };

export default function SimulatorPage() {
  const { businessId: sharedBusinessId, business } = useBusiness();
  const businessId = sharedBusinessId || null;
  // Everything loaded is tagged with the business (and conversation) it belongs to; what renders is
  // derived from the CURRENT business only (simulatorView), so a business switch can never leave
  // another business's conversation, cart, approvals or Inspector data on screen.
  const [data, setData] = useState<Data>(EMPTY);
  const view = simulatorView(data, businessId);
  const { scope, state, approvals, approvalsLocked, graph } = view;
  const conversationId = scope?.conversationId ?? null;
  const [tab, setTab] = useState<Tab>("chat");
  const [sending, setSending] = useState(false);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);

  const refreshApprovals = useCallback((bizId: string) => {
    fetch(`/api/simulator/approvals?businessId=${encodeURIComponent(bizId)}`)
      .then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
      .then(({ ok, d }) => {
        setData((prev) => ({ ...prev, approvals: { businessId: bizId, list: Array.isArray(d.approvals) ? d.approvals : [], locked: !ok } }));
      });
  }, []);

  const setConversation = useCallback((at: SimulatorScope, next: ConversationState | null) => {
    setData((prev) =>
      prev.scope?.businessId === at.businessId && prev.scope.conversationId === at.conversationId && acceptConversation(prev.conversation, at, next)
        ? { ...prev, conversation: { businessId: at.businessId, conversationId: at.conversationId, state: next } }
        : prev
    );
  }, []);

  // Restore (or create) THIS business's own conversation identity from localStorage whenever the
  // active business changes (keys are per business, see simulator-session). Everything that belonged
  // to the previous business is dropped here too — and would be hidden by simulatorView regardless.
  useEffect(() => {
    if (!businessId) return;
    const customerId = getOrCreateCustomerId(businessId);
    const existing = getStoredConversationId(businessId);
    const resolvedConversationId = existing ?? createConversationId();
    if (!existing) setStoredConversationId(businessId, resolvedConversationId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData({ scope: { businessId, conversationId: resolvedConversationId, customerId }, conversation: null, approvals: null, graph: null });
  }, [businessId]);

  // Load the scoped conversation's history — the server answers only under its own business.
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    fetch(`/api/simulator/conversation?businessId=${encodeURIComponent(scope.businessId)}&conversationId=${encodeURIComponent(scope.conversationId)}`)
      .then((r) => r.json())
      .catch(() => ({}))
      .then((d) => {
        if (!cancelled) setConversation(scope, d.state ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, setConversation]);

  useEffect(() => {
    if (!businessId) return;
    fetch(`/api/simulator/graph?businessId=${encodeURIComponent(businessId)}`)
      .then((r) => r.json())
      .then((d) => setData((prev) => ({ ...prev, graph: { businessId, graph: d.graph ?? null } })));
    refreshApprovals(businessId);
  }, [businessId, refreshApprovals]);

  function startNewConversation() {
    if (!scope) return;
    const fresh = createConversationId();
    setStoredConversationId(scope.businessId, fresh);
    setData((prev) => ({ ...prev, scope: { ...scope, conversationId: fresh }, conversation: null }));
  }

  async function sendMessage(message: string) {
    if (!scope) return;
    const at = scope;
    setSending(true);
    if (state) setConversation(at, { ...state, messages: [...state.messages, { role: "customer", content: message, at: new Date().toISOString() }] });
    try {
      const res = await fetch("/api/simulator/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: at.businessId, conversationId: at.conversationId, customerId: at.customerId, message }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.state) setConversation(at, d.state);
      // Every turn can create, reuse, supersede or withdraw a request — always show the current lifecycle.
      refreshApprovals(at.businessId);
    } finally {
      setSending(false);
    }
  }

  async function simulatePayment(outcome: "paid" | "failed") {
    if (!scope || !paymentPrompt) return;
    const at = scope;
    const res = await fetch("/api/simulator/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: at.businessId, conversationId: at.conversationId, paymentRequestId: paymentPrompt.paymentRequestId, outcome }),
    });
    const d = await res.json().catch(() => ({}));
    if (d.state) setConversation(at, d.state);
  }

  async function decideApproval(approvalId: string, decision: "approved" | "declined") {
    if (!scope) return;
    const at = scope;
    setBusyApprovalId(approvalId);
    try {
      const res = await fetch("/api/simulator/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: at.businessId, approvalId, decision, decidedBy: "owner (simulator)" }),
      });
      const d = await res.json().catch(() => ({}));
      refreshApprovals(at.businessId);
      if (d.state) setConversation(at, d.state);
    } finally {
      setBusyApprovalId(null);
    }
  }

  function computePaymentPrompt() {
    if (!state) return null;
    const paymentRequestId = state.knownFields.__paymentRequestId;
    const paid = state.knownFields.__paid;
    if (!paymentRequestId || paid) return null;
    const offer = graph?.offers.find((o) => o.id === state.selectedOfferId);
    if (!offer) return null;
    const amount = offer.depositAmount ?? offer.price ?? 0;
    return { paymentRequestId, amount, currency: offer.currency };
  }
  const paymentPrompt = computePaymentPrompt();
  const viewKey = scopeKey(scope);

  const pendingApprovalCount = approvals.filter((a) => ["active", "held"].includes(a.lifecycle ?? (a.status === "pending" ? "active" : a.status))).length;

  return (
    <div className="flex h-dvh flex-col bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="shrink-0">
        <TestShell active="simulator" />
      </div>
      <header className="shrink-0 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Customer chat · {business?.name ?? "—"}</p>
            <p className="truncate font-mono text-[11px] text-neutral-500" title={conversationId ?? ""}>
              conversation {conversationId ?? "—"} · stage {state?.stage ?? "new"}
              {state?.pendingApprovalId ? " · waiting on owner" : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Link href="/owner" className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium dark:border-neutral-700">
              Owner approvals
            </Link>
            <Link href="/owner/train" className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium dark:border-neutral-700">
              Train
            </Link>
            <button onClick={startNewConversation} className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
              New conversation
            </button>
          </div>
        </div>
        {state?.knownFields.__qaForceUnderstandingFailure && (
          <p className="mx-auto mt-1.5 max-w-6xl rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">QA: the next message in this conversation will FAIL understanding (armed in QA tools).</p>
        )}
      </header>

      <nav className="flex border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        {(
          [
            ["chat", "Chat"],
            ["inspector", "Inspector"],
            ["approvals", `Approvals${pendingApprovalCount ? ` (${pendingApprovalCount})` : ""}`],
            ["graph", "Business Graph"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 py-2.5 text-xs font-medium text-center min-w-0 truncate ${
              tab === key
                ? "border-b-2 border-indigo-600 text-indigo-600 dark:text-indigo-400"
                : "text-neutral-500"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="flex-1 min-h-0">
        {tab === "chat" && (
          <ChatPanel
            key={viewKey}
            messages={state?.messages ?? []}
            onSend={sendMessage}
            sending={sending}
            paymentPrompt={paymentPrompt}
            onSimulatePayment={simulatePayment}
          />
        )}
        {tab === "inspector" && <InspectorPanel key={viewKey} state={state} />}
        {tab === "approvals" && approvalsLocked && (
          <p className="m-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Owner access is configured on this deployment: sign in as this business&apos;s owner in{" "}
            <Link href="/owner" className="underline">
              Owner
            </Link>{" "}
            to see and decide its requests here.
          </p>
        )}
        {tab === "approvals" && (
          <ApprovalsPanel key={viewKey} approvals={approvals} onDecide={decideApproval} busyId={busyApprovalId} currentConversationId={conversationId} />
        )}
        {tab === "graph" && <GraphPanel graph={graph} />}
      </main>
    </div>
  );
}
