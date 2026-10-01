import type { Fleet } from "./fleet";
import { hasMoney, moneyWords } from "@/lib/format/money";

/**
 * FOCUS — the founder's top 1–5 items across the fleet, ranked deterministically from the fleet
 * summary: businesses that need the founder (high incidents, held requests, AI down, supervised
 * incidents), then money blocked, then not-ready supervised businesses. Pure.
 */
export type FocusEntry = { key: string; rank: number; status: "blocked" | "attention" | "degraded" | "not_ready"; title: string; why: string; move: string; href: string; businessId: string };

export function focusItems(fleet: Fleet, limit = 5): FocusEntry[] {
  const out: Omit<FocusEntry, "rank">[] = [];
  const href = (id: string, view?: string) => `/hq/${encodeURIComponent(id)}${view ? `?view=${view}` : ""}`;
  for (const n of fleet.summary.needFounder) {
    const b = fleet.businesses.find((x) => x.id === n.id)!;
    const down = b.model.status === "unavailable";
    out.push({ key: `need:${n.id}`, status: down ? "degraded" : b.incidents.high ? "blocked" : "attention", title: `${n.name} needs you`, why: n.why, move: down ? "Check the model configuration, then the incidents." : b.incidents.high ? "Open the incident; acknowledge or resolve with evidence." : b.approvalsHeld ? "The owner must re-check held requests; nudge them or review the conversation." : "Review the open incidents for this supervised business.", href: href(n.id, "attention"), businessId: n.id });
  }
  for (const m of fleet.summary.moneyBlocked) {
    if (out.some((o) => o.businessId === m.id)) continue;
    const parts = [hasMoney(m.stuckWithOwner) ? `${moneyWords(m.stuckWithOwner)} waits on the owner` : "", hasMoney(m.atRisk) ? `${moneyWords(m.atRisk)} at risk` : ""].filter(Boolean);
    out.push({ key: `money:${m.id}`, status: "attention", title: `Money blocked at ${m.name}`, why: parts.join(" · "), move: "See whose move it is; nudge the owner if a decision is waiting.", href: href(m.id, "money"), businessId: m.id });
  }
  for (const n of fleet.summary.notReady) {
    const b = fleet.businesses.find((x) => x.id === n.id)!;
    if (b.controls.mode === "simulator" || out.some((o) => o.businessId === n.id)) continue;
    out.push({ key: `ready:${n.id}`, status: "not_ready", title: `${n.name} is ${b.controls.mode} but not ready`, why: n.blocker || n.level.replace(/_/g, " ").toLowerCase(), move: "Open the launch checklist; one blocker is on top.", href: href(n.id, "launch"), businessId: n.id });
  }
  return out.slice(0, limit).map((o, i) => ({ ...o, rank: i + 1 }));
}

/** The one sentence at the top of HQ. */
export function focusHeadline(fleet: Fleet, needs: number): string {
  const n = fleet.summary.businesses;
  const running = `BARRY is running ${n} business${n === 1 ? "" : "es"}.`;
  return needs === 0 ? `${running} Nothing needs you.` : `${running} ${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you.`;
}
