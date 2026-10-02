"use client";

import type { OwnerConversationRow, OwnerWorkspace } from "@/lib/owner/service";
import type { OutcomeEvent } from "@/lib/owner/revenue";
import type { Tone } from "../ui";
import type { LiveState } from "../kit";

/** Owner-facing words and tones shared by the control-room views. */

export type Tab = "today" | "ask" | "work" | "money" | "customers" | "activity";
export const TABS: Tab[] = ["today", "ask", "work", "money", "customers", "activity"];
/** Earlier tab names stay valid: WhatsApp messages and briefs already sent link to them. */
export const TAB_ALIASES: Record<string, Tab> = { inbox: "customers", actions: "work" };
export function tabOf(raw: string | null): Tab {
  const t = raw ? (TAB_ALIASES[raw] ?? raw) : "today";
  return (TABS as string[]).includes(t) ? (t as Tab) : "today";
}

/** The five conversation states the owner scans for. */
export type ConversationState = "barry" | "customer" | "you" | "review" | "resolved";

export const CONVERSATION_STATE: Record<ConversationState, { label: string; tone: Tone; live: LiveState }> = {
  barry: { label: "BARRY handling", tone: "info", live: "working" },
  customer: { label: "Waiting on customer", tone: "neutral", live: "waiting" },
  you: { label: "Waiting on you", tone: "warn", live: "attention" },
  review: { label: "Needs review", tone: "bad", live: "attention" },
  resolved: { label: "Resolved", tone: "good", live: "off" },
};

export function conversationState(c: OwnerConversationRow): ConversationState {
  if (c.attention.some((a) => a === "ai_unavailable" || a === "action_failed" || a === "blocked")) return "review";
  if (c.status === "needs_you") return "you";
  if (c.status === "waiting_on_customer") return "customer";
  if (c.status === "completed" || c.status === "lost") return "resolved";
  return "barry";
}

export const OUTCOME: Record<OutcomeEvent["kind"], { tone: Tone; label: string }> = {
  paid: { tone: "good", label: "Paid" },
  booked: { tone: "good", label: "Booked" },
  order_created: { tone: "good", label: "Order" },
  case_created: { tone: "info", label: "Case opened" },
  checkout_abandoned: { tone: "warn", label: "Checkout not completed" },
  blocked: { tone: "warn", label: "Stopped" },
  failed: { tone: "bad", label: "Didn't go through" },
  handoff: { tone: "info", label: "Handed to you" },
  declined_by_owner: { tone: "neutral", label: "You declined" },
};

export const LIFECYCLE: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "warn", label: "Waiting for you" },
  held: { tone: "bad", label: "Held" },
  executed: { tone: "good", label: "Done" },
  executed_unconfirmed: { tone: "warn", label: "Done · unconfirmed" },
  failed: { tone: "bad", label: "Didn't go through" },
  declined: { tone: "neutral", label: "Declined" },
  withdrawn: { tone: "neutral", label: "Withdrawn" },
  superseded: { tone: "neutral", label: "Replaced" },
  approved: { tone: "info", label: "Approved" },
};

export const CHANNEL: Record<OwnerConversationRow["channel"], string> = { whatsapp: "WhatsApp", web: "Web chat", instagram: "Instagram", simulator: "Simulator" };

export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type Workspace = OwnerWorkspace;
