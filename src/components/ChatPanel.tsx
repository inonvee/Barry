"use client";

import { useState } from "react";
import type { ConversationMessage } from "@/lib/state";

export function ChatPanel({
  messages,
  onSend,
  sending,
  paymentPrompt,
  onSimulatePayment,
}: {
  messages: ConversationMessage[];
  onSend: (text: string) => void;
  sending: boolean;
  paymentPrompt: { paymentRequestId: string; amount: number; currency: string } | null;
  onSimulatePayment: (outcome: "paid" | "failed") => void;
}) {
  const [text, setText] = useState("");

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto space-y-3 p-3">
        {messages.length === 0 && (
          <p className="text-sm text-neutral-500 text-center pt-8">
            Say hello as the customer to start the conversation.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "customer" ? "justify-end" : "justify-start"}`}>
            {m.role === "system" ? (
              <div className="w-full text-center text-xs text-neutral-400 py-1">{m.content}</div>
            ) : (
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                  m.role === "customer"
                    ? "bg-indigo-600 text-white rounded-br-sm"
                    : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100 rounded-bl-sm"
                }`}
              >
                {m.content}
              </div>
            )}
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-2 text-sm bg-neutral-100 text-neutral-400 dark:bg-neutral-800">
              BARRY is thinking…
            </div>
          </div>
        )}
      </div>

      {paymentPrompt && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 p-3 flex items-center justify-between gap-2 bg-amber-50 dark:bg-amber-950/30">
          <span className="text-xs text-amber-800 dark:text-amber-200">
            Simulate payment of {paymentPrompt.amount} {paymentPrompt.currency}
          </span>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => onSimulatePayment("paid")}
              className="rounded-lg bg-green-600 text-white text-xs font-medium px-3 py-2"
            >
              Mark paid
            </button>
            <button
              onClick={() => onSimulatePayment("failed")}
              className="rounded-lg bg-red-600 text-white text-xs font-medium px-3 py-2"
            >
              Mark failed
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-neutral-200 dark:border-neutral-800 p-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Type as the customer…"
          className="flex-1 rounded-full border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          onClick={submit}
          disabled={sending}
          className="rounded-full bg-indigo-600 text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
