import type { OwnerWorkspace } from "./service";
import { activityFeed, nowWorking } from "./control-room";

/**
 * BARRY'S PRESENCE for the owner (client-safe, pure): one state, one word and one sentence, derived
 * from the workspace — never from a timer or an animation. The orb, the top bar and Today all show the
 * same presence, so "BARRY is working" only ever appears when the records say BARRY has work open.
 *
 *   unavailable — BARRY can't understand customers (AI down / misconfigured)
 *   needs_you   — a decision or handoff is waiting on the owner
 *   degraded    — some recent messages weren't understood
 *   completed   — BARRY just finished something verified (last 15 minutes)
 *   working     — BARRY has follow-ups to run, scheduled work, or a live conversation
 *   waiting     — everything open is waiting on customers
 *   idle        — nothing open; ready for the next customer
 *   paused      — reserved for a paused business (never inferred here)
 */
export type PresenceState = "unavailable" | "needs_you" | "degraded" | "completed" | "working" | "waiting" | "idle" | "paused";
export type OwnerPresence = { state: PresenceState; text: string; href?: string };

export const PRESENCE_WORD: Record<PresenceState, string> = {
  unavailable: "Unavailable",
  needs_you: "Needs you",
  degraded: "Degraded",
  completed: "Just finished",
  working: "Working",
  waiting: "Waiting",
  idle: "Ready",
  paused: "Paused",
};

const RECENT_MS = 15 * 60 * 1000;

export function ownerPresence(ws: Pick<OwnerWorkspace, "interventions" | "health" | "today" | "obligations" | "capabilities" | "outcomes" | "approvals" | "conversations">, now = new Date()): OwnerPresence {
  if (ws.health.ai.status === "unavailable") return { state: "unavailable", text: "BARRY can't understand customers right now", href: "/owner?tab=today" };
  if (ws.interventions.length) return { state: "needs_you", text: `${ws.interventions.length} thing${ws.interventions.length === 1 ? "" : "s"} need${ws.interventions.length === 1 ? "s" : ""} you`, href: "/owner?tab=actions" };
  if (ws.health.ai.status === "degraded") return { state: "degraded", text: ws.health.ai.summary, href: "/owner?tab=today" };
  const done = activityFeed(ws, 5).find((f) => f.tone === "ok" && now.getTime() - Date.parse(f.at) < RECENT_MS);
  if (done) return { state: "completed", text: done.text, href: "/owner?tab=today" };
  const lines = nowWorking(ws);
  const active = lines.find((l) => l.state === "working");
  const live = ws.conversations.filter((c) => c.status === "in_progress").length;
  if (active) return { state: "working", text: active.text, href: "/owner?tab=today" };
  if (live) return { state: "working", text: `In ${live} live conversation${live === 1 ? "" : "s"}`, href: "/owner?tab=inbox" };
  const waiting = lines.find((l) => l.id === "waiting");
  if (waiting) return { state: "waiting", text: waiting.text, href: "/owner?tab=inbox" };
  return { state: "idle", text: ws.today.conversations ? `${ws.today.conversations} conversation${ws.today.conversations === 1 ? "" : "s"} today, ${ws.today.handledAutonomously} handled without you` : "Ready for the next customer" };
}
