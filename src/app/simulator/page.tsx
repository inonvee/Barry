"use client";

import { useCallback, useEffect, useState } from "react";
import { BusinessSwitcher } from "@/components/BusinessSwitcher";
import { ChatPanel } from "@/components/ChatPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { ApprovalsPanel, type ApprovalView } from "@/components/ApprovalsPanel";
import { GraphPanel } from "@/components/GraphPanel";
import type { ConversationState } from "@/lib/state";
import type { BusinessGraph } from "@/lib/business-graph";
import {
  createConversationId,
  getOrCreateCustomerId,
  getStoredConversationId,
  setStoredConversationId,
} from "@/lib/simulator-session";

type BusinessSummary = { id: string; name: string; description: string };
type Tab = "chat" | "inspector" | "approvals" | "graph";

export default function SimulatorPage() {
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [graph, setGraph] = useState<BusinessGraph | null>(null);
  const [state, setState] = useState<ConversationState | null>(null);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  // null until the per-business restore effect below resolves them — every
  // action that needs these already gates on businessId/graph being ready,
  // so a brief null window here causes no bad requests.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [sending, setSending] = useState(false);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/simulator/businesses")
      .then((r) => r.json())
      .then((d) => {
        setBusinesses(d.businesses);
        if (d.businesses[0]) setBusinessId(d.businesses[0].id);
      });
  }, []);

  const refreshApprovals = useCallback((bizId: string) => {
    fetch(`/api/simulator/approvals?businessId=${bizId}`)
      .then((r) => r.json())
      .then((d) => setApprovals(d.approvals));
  }, []);

  // Restore (or create) this business's conversation identity from
  // localStorage whenever the active business changes — this is what
  // makes a page refresh, or leaving and reopening the simulator, resume
  // the same conversation instead of silently starting a new one the
  // server has never heard of. This is a legitimate synchronization with
  // an external system (browser storage), which is exactly what effects
  // are for; there is no render-time-safe way to read localStorage (it
  // doesn't exist during server rendering), so the usual "derive during
  // render" alternative to this lint rule isn't available here.
  useEffect(() => {
    if (!businessId) return;
    const resolvedCustomerId = getOrCreateCustomerId(businessId);
    const existing = getStoredConversationId(businessId);
    const resolvedConversationId = existing ?? createConversationId();
    if (!existing) setStoredConversationId(businessId, resolvedConversationId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCustomerId(resolvedCustomerId);
    setConversationId(resolvedConversationId);
  }, [businessId]);

  // Once we know which conversation this business/browser was already in
  // the middle of, load its actual history from the server (a no-op,
  // empty-history conversation if it's brand new).
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    fetch(`/api/simulator/conversation?conversationId=${conversationId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setState(d.state ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!businessId) return;
    fetch(`/api/simulator/graph?businessId=${businessId}`)
      .then((r) => r.json())
      .then((d) => setGraph(d.graph));
    refreshApprovals(businessId);
  }, [businessId, refreshApprovals]);

  function switchBusiness(id: string) {
    setState(null);
    setConversationId(null);
    setBusinessId(id);
    setTab("chat");
  }

  function startNewConversation() {
    if (!businessId) return;
    const fresh = createConversationId();
    setStoredConversationId(businessId, fresh);
    setState(null);
    setConversationId(fresh);
  }

  async function sendMessage(message: string) {
    if (!businessId || !conversationId || !customerId) return;
    setSending(true);
    setState((prev) =>
      prev
        ? { ...prev, messages: [...prev.messages, { role: "customer", content: message, at: new Date().toISOString() }] }
        : prev
    );
    try {
      const res = await fetch("/api/simulator/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, conversationId, customerId, message }),
      });
      const data = await res.json();
      if (data.state) setState(data.state);
      // Every turn can create, reuse, supersede or withdraw a request — always show the current lifecycle.
      refreshApprovals(businessId);
    } finally {
      setSending(false);
    }
  }

  async function simulatePayment(outcome: "paid" | "failed") {
    if (!businessId || !conversationId || !paymentPrompt) return;
    const res = await fetch("/api/simulator/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, conversationId, paymentRequestId: paymentPrompt.paymentRequestId, outcome }),
    });
    const data = await res.json();
    if (data.state) setState(data.state);
  }

  async function decideApproval(approvalId: string, decision: "approved" | "declined") {
    if (!businessId) return;
    setBusyApprovalId(approvalId);
    try {
      const res = await fetch("/api/simulator/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, approvalId, decision, decidedBy: "owner (simulator)" }),
      });
      const data = await res.json();
      refreshApprovals(businessId);
      if (data.state && data.state.id === conversationId) setState(data.state);
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

  const pendingApprovalCount = approvals.filter((a) => ["active", "held"].includes(a.lifecycle ?? (a.status === "pending" ? "active" : a.status))).length;

  return (
    <div className="flex h-dvh flex-col bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <header className="border-b border-neutral-200 dark:border-neutral-800 p-3 space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">BARRY Simulator</h1>
          <button
            onClick={startNewConversation}
            className="text-xs rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 py-1.5 font-medium"
          >
            New conversation
          </button>
        </div>
        <BusinessSwitcher businesses={businesses} activeId={businessId} onSelect={switchBusiness} />
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
            messages={state?.messages ?? []}
            onSend={sendMessage}
            sending={sending}
            paymentPrompt={paymentPrompt}
            onSimulatePayment={simulatePayment}
          />
        )}
        {tab === "inspector" && <InspectorPanel state={state} />}
        {tab === "approvals" && (
          <ApprovalsPanel approvals={approvals} onDecide={decideApproval} busyId={busyApprovalId} currentConversationId={conversationId} />
        )}
        {tab === "graph" && <GraphPanel graph={graph} />}
      </main>
    </div>
  );
}
