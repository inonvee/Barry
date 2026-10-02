"use client";

import type { Intervention, InterventionAction } from "@/lib/owner/interventions";
import type { OwnerConversationRow, OwnerWorkspace } from "@/lib/owner/service";
import type { OwnerLang } from "@/lib/owner/lang";
import type { IconName } from "../kit";
import type { Tone } from "../os-ui";

/** Owner-facing words, tones and navigation shared by the Owner OS views (English + Hebrew). */

export type Tab = "today" | "ask" | "work" | "money" | "more" | "customers" | "activity";
export const TABS: Tab[] = ["today", "ask", "work", "money", "more", "customers", "activity"];
/** Earlier tab names stay valid: WhatsApp messages and briefs already sent link to them. */
export const TAB_ALIASES: Record<string, Tab> = { inbox: "customers", actions: "work" };
export function tabOf(raw: string | null): Tab {
  const t = raw ? (TAB_ALIASES[raw] ?? raw) : "today";
  return (TABS as string[]).includes(t) ? (t as Tab) : "today";
}

/** One action handler for every decision: the owner endpoints re-check everything before an effect. */
export type Act = (item: Intervention, action: InterventionAction) => Promise<void> | void;

/** The conversation states the owner scans for. */
export type ConversationState = "you" | "customer" | "barry" | "resolved";
export const CONVERSATION_STATE: Record<ConversationState, { tone: Tone; label: Record<OwnerLang, string> }> = {
  you: { tone: "warn", label: { en: "Needs you", he: "צריך אותך" } },
  customer: { tone: "neutral", label: { en: "Waiting on customer", he: "מחכה ללקוח" } },
  barry: { tone: "info", label: { en: "BARRY is handling", he: "BARRY מטפל" } },
  resolved: { tone: "ok", label: { en: "Resolved", he: "הסתיים" } },
};
export function conversationState(c: OwnerConversationRow): ConversationState {
  if (c.status === "needs_you") return "you";
  if (c.status === "waiting_on_customer") return "customer";
  if (c.status === "completed" || c.status === "lost") return "resolved";
  return "barry";
}

export const INTERVENTION_KIND: Record<Intervention["kind"], { icon: IconName; tone: Tone; label: Record<OwnerLang, string> }> = {
  approval: { icon: "shield", tone: "warn", label: { en: "Your approval", he: "אישור שלך" } },
  held_approval: { icon: "clock", tone: "warn", label: { en: "Held — re-check", he: "מוחזק — לבדוק שוב" } },
  handoff: { icon: "users", tone: "info", label: { en: "Needs a person", he: "צריך אדם" } },
  failed_action: { icon: "alert", tone: "bad", label: { en: "Didn't go through", he: "לא הצליח" } },
  blocked_write: { icon: "cart", tone: "neutral", label: { en: "Stopped by their limits", he: "נעצר לפי המגבלות" } },
  not_understood: { icon: "chat", tone: "bad", label: { en: "Not understood", he: "לא הובן" } },
  delivery_failed: { icon: "alert", tone: "bad", label: { en: "Not delivered", he: "לא נמסר" } },
};

export const LIFECYCLE: Record<string, { tone: Tone; label: Record<OwnerLang, string> }> = {
  active: { tone: "warn", label: { en: "Waiting for you", he: "מחכה לך" } },
  held: { tone: "bad", label: { en: "Held", he: "מוחזק" } },
  executed: { tone: "ok", label: { en: "Done", he: "בוצע" } },
  executed_unconfirmed: { tone: "warn", label: { en: "Done · unconfirmed", he: "בוצע · לא אושר" } },
  failed: { tone: "bad", label: { en: "Didn't go through", he: "לא הצליח" } },
  declined: { tone: "neutral", label: { en: "Declined", he: "נדחה" } },
  withdrawn: { tone: "neutral", label: { en: "Withdrawn", he: "בוטל" } },
  superseded: { tone: "neutral", label: { en: "Replaced", he: "הוחלף" } },
  approved: { tone: "info", label: { en: "Approved", he: "אושר" } },
};

export function greeting(lang: OwnerLang, now = new Date()): string {
  const h = now.getHours();
  if (lang === "he") return h < 5 ? "ערב טוב" : h < 12 ? "בוקר טוב" : h < 18 ? "צהריים טובים" : "ערב טוב";
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export const initial = (name: string) => name.replace(/[^\p{L}]/gu, "").slice(0, 1).toUpperCase() || "?";

export type Workspace = OwnerWorkspace;
export type { InterventionAction };
