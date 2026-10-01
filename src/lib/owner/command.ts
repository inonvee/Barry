import type { OwnerWorkspace } from "./service";
import type { ObligationKind } from "@/lib/operator/obligation-model";
import { PROACTIVE, workflowState, workflows, type Workflow } from "./control-room";

/**
 * THE OWNER COMMAND (pure, client-safe) — "Tell BARRY what to do…".
 *
 * One object for every surface the owner directs BARRY from: the web command bar today, the Owner
 * WhatsApp Command Channel and voice later. The same text always resolves to the same intent, against
 * the same records, rules and plan — so a command typed on the web and one sent by WhatsApp are the
 * same thing, with the same plan, cohort, authority and results.
 *
 * Interpreting a command never executes anything. It says what the command maps to in what BARRY
 * really does:
 *   ask        — a question; answered by Ask BARRY from this business's records (read-only)
 *   operation  — work the proactive operator runs under the owner's follow-up rules; the answer is the
 *                LIVE operation (its cohort and verified results) and whether it runs (rule / plan)
 *   decide     — approve / decline something: opens that decision; the owner decides on the card
 *   teach      — a rule or limit for BARRY ("don't offer more than 5%"): goes to Train BARRY, where
 *                it is reviewed before the runtime enforces it
 *   unsupported— something BARRY can't do (e.g. message customers who never wrote in); says so
 */

export type CommandSource = "web" | "whatsapp" | "voice";

export type CommandIntent =
  | { kind: "ask"; question: string }
  | { kind: "operation"; workflow: ObligationKind; title: string; state: Workflow["state"]; live?: Workflow; rule?: { afterHours: number; maxAttempts: number } }
  | { kind: "decide"; interventionId?: string; customer?: string }
  | { kind: "teach"; text: string }
  | { kind: "unsupported"; reason: string };

export type OwnerCommand = { text: string; source: CommandSource; intent: CommandIntent };

const OPERATIONS: { kind: ObligationKind; match: RegExp }[] = [
  { kind: "abandoned_checkout_recovery", match: /\b(abandon\w*|cart|carts|checkouts?)\b|עגל|נטש/i },
  { kind: "booking_deposit_missing", match: /\bdeposits?\b|מקדמ/i },
  { kind: "unpaid_payment_followup", match: /\b(unpaid|payment links?|payments?|orders? (?:not|un)paid|pay)\b|לא שולמ|תשלום/i },
  { kind: "appointment_reminder", match: /\b(remind\w*|appointments?)\b|תזכור/i },
  { kind: "failed_action_recovery", match: /\b(retry|failed|didn'?t go through)\b|נכשל/i },
];
const DO = /^(please\s+)?(barry,?\s+)?(go\s+)?(recover|follow[\s-]?up|chase|remind|retry|collect|nudge|re-?engage|get back|send)\b|^(תחזיר|תעקוב|תזכיר|תגבה|תשלח)/i;
const QUESTION = /\?\s*$|^(what|who|where|when|why|how|which|is|are|did|do|does|can|could|show|tell me|list|give me)\b|^(מה|מי|איפה|מתי|למה|איך|כמה|תראה|תגיד)/i;
const DECIDE = /^(please\s+)?(barry,?\s+)?(approve|decline|reject|accept|refuse)\b|^(אשר|תאשר|דחה|תדחה)/i;
const RULE = /\b(don'?t|do not|never|always|only|no more than|not more than|at most|max(?:imum)?|limit|up to|from now on|stop offering)\b|^(אל|לעולם|תמיד|רק|לא יותר)/i;
const OUTBOUND = /\b(campaign|broadcast|blast|newsletter|message (?:all|every)|text (?:all|every)|announce)\b|קמפיין|דיוור/i;

/** What a command means for this business right now. Never executes; never invents a capability. */
export function interpretCommand(text: string, ws: Pick<OwnerWorkspace, "obligations" | "operator" | "interventions">, source: CommandSource = "web"): OwnerCommand {
  const t = text.trim().replace(/\s+/g, " ");
  const intent = ((): CommandIntent => {
    if (!t) return { kind: "ask", question: t };
    if (DECIDE.test(t)) {
      const hit = ws.interventions.find((i) => t.toLowerCase().includes(i.customer.toLowerCase().split(" ")[0] ?? "\u0000")) ?? (ws.interventions.length === 1 ? ws.interventions[0] : undefined);
      return { kind: "decide", ...(hit ? { interventionId: hit.id, customer: hit.customer } : {}) };
    }
    if (OUTBOUND.test(t)) return { kind: "unsupported", reason: "BARRY only messages customers who are already talking to the business, inside their conversation. Campaigns and broadcasts to other customers aren't something BARRY can run." };
    const op = OPERATIONS.find((o) => o.match.test(t));
    if (op && DO.test(t) && !RULE.test(t)) {
      const meta = PROACTIVE.find((p) => p.kind === op.kind)!;
      const live = workflows(ws).find((w) => w.kind === op.kind);
      const rule = ws.operator.rules.find((r) => r.kind === op.kind);
      return { kind: "operation", workflow: op.kind, title: meta.title, state: workflowState(op.kind, ws.operator), ...(live ? { live } : {}), ...(rule ? { rule: { afterHours: rule.afterHours, maxAttempts: rule.maxAttempts } } : {}) };
    }
    if (RULE.test(t) && !QUESTION.test(t)) return { kind: "teach", text: t };
    return { kind: "ask", question: t };
  })();
  return { text: t, source, intent };
}

/** Command suggestions from what this business really has — operations only when the rule and plan let them run. */
export function commandSuggestions(ws: Pick<OwnerWorkspace, "obligations" | "operator" | "interventions">): string[] {
  const out: string[] = [];
  if (ws.interventions.length) out.push("Who needs me?");
  const open = workflows(ws).filter((w) => w.state === "running");
  if (open.some((w) => w.kind === "abandoned_checkout_recovery") || workflowState("abandoned_checkout_recovery", ws.operator) === "running") out.push("Recover abandoned checkouts");
  if (open.some((w) => w.kind === "unpaid_payment_followup") || workflowState("unpaid_payment_followup", ws.operator) === "running") out.push("Follow up unpaid payment links");
  out.push("Where is money stuck?", "What happened today?");
  return out.slice(0, 4);
}
