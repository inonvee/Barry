import type { OwnerWorkspace } from "./service";
import { activeWork, activityFeed, nowWorking } from "./control-room";
import { L, type OwnerLang } from "./lang";

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
  idle: "Watching",
  paused: "Paused",
};

export const PRESENCE_WORD_HE: Record<PresenceState, string> = {
  unavailable: "לא זמין",
  needs_you: "צריך אותך",
  degraded: "בעיות הבנה",
  completed: "סיים עכשיו",
  working: "עובד",
  waiting: "מחכה ללקוחות",
  idle: "על המשמר",
  paused: "מושהה",
};
export const presenceWord = (s: PresenceState, lang: OwnerLang = "en") => (lang === "he" ? PRESENCE_WORD_HE[s] : PRESENCE_WORD[s]);

const RECENT_MS = 15 * 60 * 1000;

export function ownerPresence(ws: Pick<OwnerWorkspace, "interventions" | "health" | "today" | "obligations" | "capabilities" | "outcomes" | "approvals" | "conversations"> & Partial<Pick<OwnerWorkspace, "ownerOperations" | "operator">>, now = new Date(), lang: OwnerLang = "en"): OwnerPresence {
  const T = (en: string, he: string) => L(lang, en, he);
  const n = ws.interventions.length;
  if (ws.health.ai.status === "unavailable") return { state: "unavailable", text: T("BARRY can't understand customers right now", "BARRY לא מצליח להבין לקוחות כרגע"), href: "/owner?tab=today" };
  if (n) return { state: "needs_you", text: T(`${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you`, n === 1 ? "דבר אחד מחכה לך" : `${n} דברים מחכים לך`), href: "/owner?tab=work" };
  if (ws.health.ai.status === "degraded") return { state: "degraded", text: T(ws.health.ai.summary, "חלק מההודעות האחרונות לא הובנו"), href: "/owner?tab=today" };
  const done = activityFeed(ws, 5, lang).find((f) => f.tone === "ok" && now.getTime() - Date.parse(f.at) < RECENT_MS);
  if (done) return { state: "completed", text: done.text, href: "/owner?tab=activity" };
  // Working = the canonical active work (the same count Today and Work show), never a guess.
  const work = activeWork({ obligations: ws.obligations, ownerOperations: ws.ownerOperations ?? [], operator: ws.operator });
  const active = nowWorking(ws, lang).find((l) => l.state === "working");
  if (work.some((w) => w.state === "working") && active) return { state: "working", text: active.text, href: "/owner?tab=work" };
  const live = ws.conversations.filter((c) => c.status === "in_progress").length;
  if (live) return { state: "working", text: T(`In ${live} live conversation${live === 1 ? "" : "s"}`, live === 1 ? "בשיחה פעילה אחת" : `ב־${live} שיחות פעילות`), href: "/owner?tab=customers" };
  const waiting = nowWorking(ws, lang).find((l) => l.id === "waiting");
  if (waiting) return { state: "waiting", text: waiting.text, href: "/owner?tab=work" };
  const c = ws.today.conversations;
  return { state: "idle", text: c ? T(`${c} conversation${c === 1 ? "" : "s"} today, ${ws.today.handledAutonomously} handled without you`, `${c === 1 ? "שיחה אחת" : `${c} שיחות`} היום, ${ws.today.handledAutonomously} בלי צורך בך`) : T("Watching for the next customer", "מחכה ללקוח הבא") };
}
