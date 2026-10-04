import type { OwnerWorkspace } from "./service";
import type { ObligationKind } from "@/lib/operator/obligation-model";
import { PROACTIVE, workflowState, workflows } from "./control-room";

/**
 * THE OWNER COMMAND (pure, client-safe) — the canonical semantic contract for everything an owner asks
 * BARRY, on every surface: the web command bar, the Owner WhatsApp channel, voice later. The transport
 * never decides business behavior: the same words mean the same intent on every surface, and the same
 * command service (lib/owner/command-service) grounds, authorizes, plans, executes and verifies it.
 *
 * Interpretation is semantic, not phrase-matching per command: a small set of intent classes, each
 * recognised by what the owner is trying to do (ask about state, start / stop work on a class of
 * customers, decide a request, change a rule), with the subject grounded later against real records.
 * Interpretation never executes anything and never invents a target: a customer name is only a hint
 * until the records confirm it.
 *
 *   query                 read current state (who needs me, what are you doing, money, a customer, an operation)
 *   operation_request     start bounded work on a class of customers (a proactive workflow) for a scope
 *   operation_confirm     go ahead with a proposed operation
 *   operation_stop        stop an active operation (or all BARRY-initiated outreach)
 *   approval_response     approve / decline a request — resolved only against an exact, current request
 *   policy_change_request a rule or limit ("don't offer more than 5% today") → the reviewed Train BARRY path
 *   mode_change           pause BARRY for this business / lift the owner's own pause
 *   unsupported           something BARRY can't do (e.g. broadcast to people who never wrote in)
 */

export type CommandSource = "web" | "whatsapp" | "voice";

export type QueryTopic = "initiatives" | "needs_you" | "working" | "money" | "waiting_customers" | "customer" | "operation" | "capabilities" | "general";

export type CommandIntent =
  | { kind: "query"; topic: QueryTopic; subject?: string; workflow?: ObligationKind }
  | { kind: "operation_request"; workflow: ObligationKind; scope: "today" | "open" }
  | { kind: "operation_confirm" }
  | { kind: "operation_stop"; workflow?: ObligationKind; everything?: boolean }
  | { kind: "approval_response"; decision: "approve" | "decline"; subject?: string }
  | { kind: "policy_change_request"; text: string }
  | { kind: "mode_change"; to: "paused" | "resumed" }
  | { kind: "unsupported"; reason: string };

export type OwnerCommand = { text: string; source: CommandSource; intent: CommandIntent };

// Classes of work, by what they are about (not by exact phrasing).
const WORK: { kind: ObligationKind; about: RegExp }[] = [
  { kind: "abandoned_checkout_recovery", about: /\b(abandon\w*|carts?|checkouts?|left (?:items|behind))\b|עגל|נטש/i },
  { kind: "booking_deposit_missing", about: /\bdeposits?\b|מקדמ/i },
  { kind: "unpaid_payment_followup", about: /\b(unpaid|(?:hasn'?t|haven'?t|didn'?t|not) paid|payment links?|waiting for payment|owe|outstanding)\b|לא שילמ|לא שולמ|תשלום/i },
  { kind: "appointment_reminder", about: /\b(remind\w*|appointments?|upcoming bookings?)\b|תזכור/i },
  { kind: "failed_action_recovery", about: /\b(retry|failed|didn'?t go through)\b|נכשל/i },
];
const START = /\b(recover|follow[\s-]?up|chase|remind|retry|collect|nudge|re-?engage|reach out|get back to|message|contact|ping|go after|win back)\b|תחזיר|תעקוב|תזכיר|תגבה|תשלח|תפנה/i;
const STOP = /^(?:please\s+|barry,?\s+)*(?:stop|pause|halt|cancel|abort|hold)\b|\bdon'?t (?:message|contact|send|follow up)\b|\b(?:stop|pause) (?:the |all |every )?(?:recovery|follow[\s-]?ups?|outreach|campaign|messages?|it)\b|^עצור|תפסיק/i;
const CONFIRM = /^(?:please\s+|barry,?\s+)*(?:start|go(?: ahead)?|yes,? (?:start|go)|do it|proceed|confirm|run it)\b[.!]*$|^(?:כן|תתחיל|קדימה)[.!]*$/i;
const DECIDE = /^(?:please\s+|barry,?\s+)*(approve|accept|yes,? approve|ok(?:ay)?,? approve|decline|reject|refuse|deny|no,? decline)\b|^(אשר|תאשר|דחה|תדחה)/i;
const QUESTION = /\?\s*$|^(?:barry,?\s+)?(what|who|where|when|why|how|which|is|are|did|do|does|has|have|can|could|show|tell me|list|give me|any)\b|^(מה|מי|איפה|מתי|למה|איך|כמה|האם|תראה|תגיד)/i;
const RULE = /\b(don'?t|do not|never|always|only|no more than|not more than|at most|max(?:imum)?|limit|up to|from now on|until (?:tomorrow|monday|further notice)|stop offering|no discounts?)\b|^(אל|לעולם|תמיד|רק|לא יותר)/i;
const OUTBOUND = /\b(campaign|broadcast|blast|newsletter|(?:message|text|email) (?:all|every(?:one)?) (?:my )?customers?(?! who))\b|קמפיין|דיוור/i;
// Pausing BARRY itself (not one workflow): "pause BARRY", "stop yourself", "freeze the business".
const PAUSE_ALL = /^(?:please\s+|barry,?\s+)*(?:pause|stop|freeze|halt)\s+(?:barry|yourself|the business|all (?:of )?barry|all activity|everything you(?:'re| are)? doing)\b|^(?:please\s+)?(?:barry,?\s+)?(?:go quiet|take a break)\b|^(?:תשהה|השהה|תעצור|עצור) את (?:בארי|barry|העסק)/i;
const RESUME_ALL = /^(?:please\s+|barry,?\s+)*(?:resume|unpause|un-pause|start again|back to work|you can (?:continue|resume|start again))\b|^(?:תחזור לעבוד|תמשיך לעבוד|בטל השהיה)/i;
const SCOPE_TODAY = /\btoday\b|\bthis morning\b|היום/i;

const TOPICS: { topic: QueryTopic; about: RegExp }[] = [
  // What BARRY noticed on his own (answered only from persisted initiatives).
  { topic: "initiatives", about: /\b(notice[d]?|would you improve|should i (?:look at|improve|change|fix)|losing money|leak\w*|what can i improve|any (?:ideas|suggestions)|spot(?:ted)? anything)\b|מה שמת לב|איפה אני מפסיד/i },
  { topic: "needs_you", about: /\b(needs? me|need(?:s)? my|waiting (?:on|for) me|my (?:approval|decision)|for me to decide|approvals?)\b|צריך אותי/i },
  { topic: "operation", about: /\b(recovery|operation|campaign|follow[\s-]?ups?) (?:i|you) (?:started|ran|asked)|\bhappened with the (?:recovery|follow[\s-]?ups?|carts?|abandoned)|\bhow (?:is|did) the (?:recovery|follow[\s-]?ups?)\b/i },
  { topic: "working", about: /\b(working on|are you doing|busy with|in progress|status|what'?s happening|what'?s going on)\b|על מה אתה עובד/i },
  { topic: "money", about: /\b(make|made|earn\w*|revenue|sales|money|collect\w*|paid today|how much)\b|כמה (?:הרווחנו|מכרנו)|הכנסות/i },
  { topic: "waiting_customers", about: /\b(customers? (?:are )?waiting|who(?:'s| is) waiting|waiting customers|waiting (?:more|longer) than)\b|מחכים/i },
  { topic: "capabilities", about: /\b(what can you do|can you do|capabilit\w+)\b/i },
];

/** A customer name hint ("with Maya", "did Maya pay", "about Dana") — confirmed only against records later. */
export function customerHint(text: string): string | undefined {
  const m = text.match(/\b(?:[Ww]ith|[Aa]bout|[Dd]id|[Ff]rom|[Ff]or|[Tt]o)\s+([A-Z֐-׿][\p{L}'-]{1,30})/u) ?? text.match(/\bhappened (?:to|with)\s+([\p{L}'-]{2,30})/u);
  const w = m?.[1];
  if (!w || /^(the|my|our|all|every|today|this|that|it|me|you|them|customers?|carts?|recovery|BARRY)$/i.test(w)) return undefined;
  return w;
}

/** What a piece of owner text means. Pure; never executes; never invents a target. */
export function interpretCommand(text: string, source: CommandSource = "web"): OwnerCommand {
  const t = text.trim().replace(/\s+/g, " ").slice(0, 1000);
  const intent = ((): CommandIntent => {
    if (!t) return { kind: "query", topic: "general" };
    const work = WORK.find((w) => w.about.test(t))?.kind;
    const decide = t.match(DECIDE);
    if (decide) {
      const named = customerHint(t) ?? t.slice(decide[0].length).match(/^\s+(?:it\b|the request\b|that\b)?\s*(?:for\s+)?([A-Z\u0590-\u05FF][\p{L}'-]{1,30})/u)?.[1];
      return { kind: "approval_response", decision: /approve|accept|אשר/i.test(decide[1]) ? "approve" : "decline", ...(named ? { subject: named } : {}) };
    }
    if (PAUSE_ALL.test(t) && !QUESTION.test(t)) return { kind: "mode_change", to: "paused" };
    if (RESUME_ALL.test(t) && !QUESTION.test(t)) return { kind: "mode_change", to: "resumed" };
    if (CONFIRM.test(t)) return { kind: "operation_confirm" };
    if (STOP.test(t) && !QUESTION.test(t)) return { kind: "operation_stop", ...(work ? { workflow: work } : {}), ...(/\b(everything|all|anyone|anybody|any more|anyone else)\b|הכל/i.test(t) && !work ? { everything: true } : {}) };
    if (OUTBOUND.test(t)) return { kind: "unsupported", reason: "BARRY only messages customers who are already talking to the business, inside their conversation — campaigns or broadcasts to other people aren't something BARRY can run." };
    if (RULE.test(t) && !QUESTION.test(t) && !(work && START.test(t) && !/\b(don'?t|never|no more than|not more than|at most|up to|limit)\b/i.test(t))) return { kind: "policy_change_request", text: t };
    if (work && START.test(t) && !QUESTION.test(t)) return { kind: "operation_request", workflow: work, scope: SCOPE_TODAY.test(t) ? "today" : "open" };
    const topic = TOPICS.find((x) => x.about.test(t))?.topic;
    const subject = customerHint(t);
    if (topic === "operation" || (work && (QUESTION.test(t) || /\bhappened\b|\bstatus\b/i.test(t)) && topic !== "money" && topic !== "needs_you")) return { kind: "query", topic: "operation", ...(work ? { workflow: work } : {}) };
    if (subject && !topic) return { kind: "query", topic: "customer", subject };
    if (topic === "initiatives") return { kind: "query", topic, ...(/\b(money|losing|leak\w*|cost\w*|revenue)\b/i.test(t) ? { subject: "money" } : {}) };
    if (topic) return { kind: "query", topic, ...(subject && topic !== "money" ? { subject } : {}) };
    return { kind: "query", topic: "general" };
  })();
  return { text: t, source, intent };
}

/** Command suggestions from what this business really has — operations only when the rule and plan let them run. */
export function commandSuggestions(ws: Pick<OwnerWorkspace, "obligations" | "operator" | "interventions">): string[] {
  const out: string[] = [];
  if (ws.interventions.length) out.push("Who needs me?");
  const running = workflows(ws).filter((w) => w.state === "running");
  for (const k of ["abandoned_checkout_recovery", "unpaid_payment_followup"] as const) {
    if (running.some((w) => w.kind === k) || workflowState(k, ws.operator) === "running") out.push(PROACTIVE.find((p) => p.kind === k)!.command);
  }
  out.push("What are you working on?", "How much did we make today?");
  return out.slice(0, 4);
}
