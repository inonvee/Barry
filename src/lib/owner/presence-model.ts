import type { OwnerWorkspace } from "./service";

/**
 * BARRY'S PRESENCE for the owner (client-safe, pure): one word and one sentence from the workspace.
 */
export type OwnerPresence = { state: "working" | "waiting" | "needs_you" | "degraded" | "paused"; text: string; href?: string };

export function ownerPresence(ws: Pick<OwnerWorkspace, "interventions" | "health" | "today" | "obligations" | "capabilities">): OwnerPresence {
  if (ws.health.ai.status === "unavailable") return { state: "degraded", text: "BARRY can't understand customers right now", href: "/owner?tab=today" };
  if (ws.interventions.length) return { state: "needs_you", text: `${ws.interventions.length} thing${ws.interventions.length === 1 ? "" : "s"} need${ws.interventions.length === 1 ? "s" : ""} you`, href: "/owner?tab=today" };
  if (ws.health.ai.status === "degraded") return { state: "degraded", text: ws.health.ai.summary, href: "/owner?tab=today" };
  const waiting = ws.obligations.filter((o) => o.status === "waiting_on_customer").length;
  if (waiting && ws.today.conversations === 0) return { state: "waiting", text: `Waiting on ${waiting} customer${waiting === 1 ? "" : "s"}`, href: "/owner?tab=inbox" };
  return { state: "working", text: ws.today.conversations ? `${ws.today.conversations} conversation${ws.today.conversations === 1 ? "" : "s"} today, ${ws.today.handledAutonomously} handled without you` : "Quiet — ready for customers" };
}
