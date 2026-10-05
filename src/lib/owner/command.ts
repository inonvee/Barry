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
 *   mode_query            which mode BARRY is in (and who paused it)
 *   mode_switch_request   "switch to supervised" / "go live" — answered truthfully: the operating mode (practice /
 *                         supervised / live) is set by the BARRY team through the launch checklist; the owner's own
 *                         control is pause / resume. Nothing changes.
 *   approval_explain      what a waiting request is for, before deciding
 *   affirm / negate       a bare "yes" / "no" — resolved ONLY against the owner's current, fresh context
 *   conversation_takeover the owner takes a customer conversation (BARRY stops replying in it)
 *   conversation_reply    the owner's message to a customer (drafted, confirmed, sent through BARRY's channel)
 *   conversation_giveback give a conversation back to BARRY
 *   unsupported           something BARRY can't do (e.g. broadcast to people who never wrote in)
 */

export type CommandSource = "web" | "whatsapp" | "voice";

export type QueryTopic = "initiatives" | "needs_you" | "working" | "money" | "waiting_customers" | "waiting" | "customer" | "operation" | "capabilities" | "with_team" | "general";
/** A money question's focus: totals (default), money stuck / at risk, links awaiting payment, what failed. */
export type MoneyFocus = "stuck" | "awaiting" | "failed";

export type CommandIntent =
  | { kind: "query"; topic: QueryTopic; subject?: string; workflow?: ObligationKind; money?: MoneyFocus }
  | { kind: "operation_request"; workflow: ObligationKind; scope: "today" | "open" }
  | { kind: "operation_confirm" }
  | { kind: "operation_stop"; workflow?: ObligationKind; everything?: boolean }
  | { kind: "approval_response"; decision: "approve" | "decline"; subject?: string }
  | { kind: "policy_change_request"; text: string }
  | { kind: "mode_change"; to: "paused" | "resumed" }
  | { kind: "mode_query" }
  | { kind: "mode_switch_request"; to: "supervised" | "live" | "simulator" }
  | { kind: "approval_explain"; subject?: string }
  | { kind: "affirm" }
  | { kind: "negate" }
  | { kind: "conversation_takeover"; subject?: string }
  | { kind: "conversation_reply"; subject?: string; text: string; exact: boolean }
  | { kind: "conversation_giveback"; subject?: string }
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
// Bare confirmations / refusals — meaningful only against the owner's current context (see command-service).
const AFFIRM = /^(?:yes|yeah|yep|sure|ok(?:ay)?|go|do it|send it|send that|כן|בטח|יאללה|סבבה|שלח|תשלח(?: את זה)?|אוקיי)[.!]*$/i;
const NEGATE = /^(?:no|nope|don'?t|cancel|לא|ביטול|עזוב)[.!]*$/i;
// "Don't do it" / "אל תאשר" — a decline of the request under discussion (before RULE, which also starts with "don't").
// (No \b after the Hebrew: JavaScript's \b only knows Latin word characters.)
const DECLINE_PHRASE = /^(?:please\s+)?(?:don'?t (?:do it|approve(?: it)?|do that)|do not (?:do it|approve)|no,? (?:don'?t|decline))\b|^(?:אל תאשר|לא לאשר|אל תעשה את זה|אל תעשה|לא מאשר)(?:\s|[.!]|$)/i;
const EXPLAIN = /\b(what(?:'s| is) (?:this|that|it|the (?:approval|request)) (?:approval |request )?for|why (?:does|do) (?:it|this|that|they) need (?:me|my approval)|explain (?:it|this|that|the request)|what am i approving|what (?:would|will) (?:happen|it do) if i approve)\b|^(?:מה זה|למה (?:צריך אותי|זה צריך אישור)|על מה (?:האישור|הבקשה)|מה יקרה אם אאשר|תסביר)/i;
const MODE_Q = /\b(what mode|which mode|are you (?:paused|running|live|on)|is barry (?:paused|running|live|on)|(?:current|operating) mode)\b|באיזה מצב|מה המצב של (?:ברי|barry)|(?:ברי|barry) (?:מושהה|עובד)\?/i;
const TAKEOVER = /\b(i'?ll (?:take|handle|answer) (?:it|this|her|him|them|the conversation|over)|let me (?:take|handle|answer) (?:it|this|her|him|them|the conversation|over)|take over|i(?:'m| am) taking (?:it|this|over|the conversation))\b|אני לוקח|אני לוקחת|אקח את השיחה|אני אענה|תן לי (?:את השיחה|לענות)/i;
// "Give it back to BARRY" in Hebrew, with "this conversation" or "the conversation with <name>" in between.
const GIVEBACK_HE = /^(?:תחזיר|תחזירי|להחזיר)\s+(?:את\s+)?(?:השיחה\s+)?(?:הזאת\s+|הזו\s+|עם\s+(\S+)\s+)?ל(?:ברי|בארי|barry)(?:$|[\s.!?])/i;
// Conversations a person (the owner or a team member) holds right now.
const WITH_TEAM = /אצל\s+(?:עובד|עובדת|העובד|הצוות|צוות)|ויתר\s+ל(?:עובד|עובדת|צוות)|(?:עובד|עובדת)\s+(?:לקח|לקחה|ענה|ענתה)|\bwith (?:the |my |a )?(?:team|staff|employee)s?\b|\b(?:handed|gave) (?:over )?to (?:the |a )?(?:team|staff|employee)s?\b|\bwho(?:'s| is) (?:handling|holding) (?:which|what) conversations?\b|\bwhich conversations (?:are|is) (?:with|held by) (?:a |the )?(?:person|people|team|staff)\b/i;
const GIVEBACK = /\b(give (?:it|this|her|him|them|the conversation)? ?back to barry|hand (?:it|this|her|him|them)? ?back(?: to barry)?|barry can (?:take it|continue|take over)|return (?:it|this|the conversation) to barry|back to barry)\b|תחזיר (?:את השיחה )?ל(?:ברי|barry)|ברי (?:ימשיך|יכול להמשיך)|תחזיר לו את השיחה/i;
// "tell her that…", "reply to Dana: …", "תענה לה ש…", "תגיד לדנה ש…"
const REPLY_EN = /^(?:please\s+)?(?:tell|reply to|answer|text|message|write to|send)\s+(her|him|them|[A-Z\u0590-\u05FF][\p{L}'-]{1,30})\s*(?::\s*(.+)|(?:that\s+)?(.+))$/iu;
const REPLY_HE = /^(?:תענה|תגיד|תכתוב|תשלח|תעני|תגידי)\s+(?:ל(ה|ו|הם|הן|\p{L}[\p{L}'-]{1,30}))\s*(?::\s*(.+)|ש(.+)|(.+))$/u;
const PAUSE_ALL = /^(?:please\s+|barry,?\s+)*(?:pause|stop|freeze|halt)\s+(?:barry|yourself|the business|all (?:of )?barry|all activity|everything you(?:'re| are)? doing)\b|^(?:please\s+)?(?:barry,?\s+)?(?:go quiet|take a break)\b|^(?:תשהה|השהה|תעצור|עצור) את (?:בארי|ברי|barry|העסק)|^(?:תעצור|עצור) (?:הכל|הכול)[.!]*$|^(?:תשהה|השהה) (?:הכל|הכול)/i;
const RESUME_ALL = /^(?:please\s+|barry,?\s+)*(?:resume|unpause|un-pause|start again|back to work|you can (?:continue|resume|start again))\b|^(?:תחזור לעבוד|תמשיך לעבוד|בטל השהיה|תחזיר אותו לעבוד|תחזיר את (?:ברי|בארי|barry) לעבוד|ברי יכול לחזור לעבוד)/i;
// "Switch to supervised", "go live", "תעבור למצב פיקוח" — a request to change the operating mode (not pause / resume).
const MODE_SWITCH = /^(?:please\s+|barry,?\s+)*(?:(?:switch|change|move|set|put)\b.{0,30}\b(?:to|into|in)\s+(?:the\s+)?(live|supervised|practice|test|simulator)(?:\s+mode)?\b|go(?:ing)?\s+(live)\b|(?:turn on|enable)\s+(live|supervised)\s+mode\b)|^(?:תעבור|תעביר|תחליף|להעביר|לעבור)(?: את (?:ברי|בארי|barry))?\s+(?:ל)?מצב\s+(פיקוח|מפוקח|חי|פעיל|לייב|תרגול|בדיקה|סימולטור)|^(?:תעלה|להעלות|לעלות)(?: את (?:ברי|בארי|barry))?\s+(?:לאוויר|ללייב)/i;
const MODE_WORD: Record<string, "supervised" | "live" | "simulator"> = { live: "live", supervised: "supervised", practice: "simulator", test: "simulator", simulator: "simulator", פיקוח: "supervised", מפוקח: "supervised", חי: "live", פעיל: "live", לייב: "live", תרגול: "simulator", בדיקה: "simulator", סימולטור: "simulator" };
// "Is anything stuck?" / "יש משהו תקוע?" — what is stuck or pending (not a money question unless it says money).
const STUCK = /\b(?:anything|something|what(?:'s| is)?)\s+(?:stuck|blocked)\b|\bstuck\b\??$|תקוע|תקועים|נתקע/i;
const MONEY_WORDS = /\b(money|payments?|paid|pay|revenue|sales)\b|כסף|תשלומ|שולם|שילמ/i;
// "Why is this customer waiting?" / "למה הלקוח הזה מחכה?" — the customer in the owner's current context.
const THIS_CUSTOMER = /\b(?:this|that) customer\b|(?:ה|ל|ל?ה)לקוח הזה|(?:ה|ל|ל?ה)לקוחה הזאת/i;
const SCOPE_TODAY = /\btoday\b|\bthis morning\b|היום/i;

const TOPICS: { topic: QueryTopic; about: RegExp }[] = [
  // Customers BARRY is waiting to hear back from ("who is waiting on the customer?", "מי מחכה ללקוח?").
  { topic: "waiting_customers", about: /\bwaiting (?:on|for) (?:the |a |our )?customers?\b|מחכה ל(?:ה)?לקוח|מחכים ל(?:ה)?לקוח/i },
  // What BARRY noticed on his own (answered only from persisted initiatives).
  { topic: "initiatives", about: /\b(notice[d]?|would you improve|should i (?:look at|improve|change|fix)|losing money|leak\w*|what can i improve|any (?:ideas|suggestions)|spot(?:ted)? anything)\b|מה שמת לב|איפה אני מפסיד/i },
  { topic: "needs_you", about: /\b(needs? me|need(?:s)? my|waiting (?:on|for) me|my (?:approval|decision)|for me to decide|approvals?|anything urgent|urgent|what should i (?:do|look at))\b|צריך אותי|צריכים אותי|דחוף|מה עליי|מה אני צריך לעשות|מי מחכה לי|מה מחכה לי|צריך אישור|צריכים אישור|מחכה לאישור|מחכים לאישור/i },
  { topic: "waiting", about: /\b(what are we waiting (?:on|for)|waiting on|waiting for|what'?s pending|what is pending|outstanding|unresolved)\b|על מה אנחנו מחכים|למה אנחנו מחכים|מה תקוע|מה פתוח|מה ממתין/i },
  { topic: "operation", about: /\b(recovery|operation|campaign|follow[\s-]?ups?) (?:i|you) (?:started|ran|asked)|\bhappened with the (?:recovery|follow[\s-]?ups?|carts?|abandoned)|\bhow (?:is|did) the (?:recovery|follow[\s-]?ups?)\b/i },
  { topic: "money", about: /\b(make|made|earn\w*|revenue|sales|money|collect\w*|paid today|how much|came in|payments?|stuck|awaiting payment|unpaid)\b|כמה (?:הרווחנו|מכרנו|נכנס|כסף)|הכנסות|כסף|תשלומ|שילמו|נכנס היום/i },
  { topic: "working", about: /\b(working on|are you doing|busy with|in progress|status|what'?s happening|what'?s going on|handling|is barry doing)\b|על מה אתה עובד|מה (?:ברי|בארי|barry|אתה) עושה|במה (?:ברי|אתה) מטפל|מה (?:ברי|אתה) מטפל|^מה קורה(?: היום| עכשיו)?\s*\??$|מה המצב היום/i },
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
      return { kind: "approval_response", decision: /approve|accept|אשר/i.test(decide[1] ?? decide[2] ?? "") ? "approve" : "decline", ...(named ? { subject: named } : {}) };
    }
    if (AFFIRM.test(t)) return { kind: "affirm" };
    if (NEGATE.test(t)) return { kind: "negate" };
    const replyEn = t.match(REPLY_EN);
    if (replyEn) {
      const who = replyEn[1];
      const body = (replyEn[2] ?? replyEn[3] ?? "").trim();
      if (body && !/^(me|us)$/i.test(who)) return { kind: "conversation_reply", ...(/^(her|him|them)$/i.test(who) ? {} : { subject: who }), text: body.slice(0, 1000), exact: Boolean(replyEn[2]) };
    }
    const replyHe = t.match(REPLY_HE);
    if (replyHe) {
      const who = replyHe[1];
      const body = (replyHe[2] ?? replyHe[3] ?? replyHe[4] ?? "").trim();
      if (body) return { kind: "conversation_reply", ...(/^(ה|ו|הם|הן)$/.test(who) ? {} : { subject: who }), text: body.slice(0, 1000), exact: Boolean(replyHe[2]) };
    }
    const heBack = t.match(GIVEBACK_HE);
    if (heBack) return { kind: "conversation_giveback", ...(heBack[1] ? { subject: heBack[1] } : {}) };
    if (GIVEBACK.test(t)) return { kind: "conversation_giveback", ...(customerHint(t) ? { subject: customerHint(t)! } : {}) };
    if (WITH_TEAM.test(t)) return { kind: "query", topic: "with_team" };
    if (TAKEOVER.test(t)) return { kind: "conversation_takeover", ...(customerHint(t) ? { subject: customerHint(t)! } : {}) };
    if (EXPLAIN.test(t)) return { kind: "approval_explain", ...(customerHint(t) ? { subject: customerHint(t)! } : {}) };
    if (MODE_Q.test(t)) return { kind: "mode_query" };
    const sw = t.match(MODE_SWITCH);
    if (sw) {
      const word = (sw[1] ?? sw[2] ?? sw[3] ?? sw[4] ?? (sw[0].match(/לאוויר|ללייב/) ? "live" : "")).toLowerCase();
      if (MODE_WORD[word]) return { kind: "mode_switch_request", to: MODE_WORD[word] };
    }
    if (PAUSE_ALL.test(t) && !QUESTION.test(t)) return { kind: "mode_change", to: "paused" };
    if (RESUME_ALL.test(t) && !QUESTION.test(t)) return { kind: "mode_change", to: "resumed" };
    if (DECLINE_PHRASE.test(t)) return { kind: "approval_response", decision: "decline", ...(customerHint(t) ? { subject: customerHint(t)! } : {}) };
    if (CONFIRM.test(t)) return { kind: "operation_confirm" };
    if (STOP.test(t) && !QUESTION.test(t)) return { kind: "operation_stop", ...(work ? { workflow: work } : {}), ...(/\b(everything|all|anyone|anybody|any more|anyone else)\b|הכל/i.test(t) && !work ? { everything: true } : {}) };
    if (OUTBOUND.test(t)) return { kind: "unsupported", reason: "BARRY only messages customers who are already talking to the business, inside their conversation — campaigns or broadcasts to other people aren't something BARRY can run." };
    if (RULE.test(t) && !QUESTION.test(t) && !(work && START.test(t) && !/\b(don'?t|never|no more than|not more than|at most|up to|limit)\b/i.test(t))) return { kind: "policy_change_request", text: t };
    if (work && START.test(t) && !QUESTION.test(t)) return { kind: "operation_request", workflow: work, scope: SCOPE_TODAY.test(t) ? "today" : "open" };
    // "What's going on with her?" — the customer in the owner's current context (resolved by the service).
    if (/\b(?:with|about) (?:her|him|them)\b|\b(?:what did|what does) (?:she|he|they) (?:say|want|need)\b|מה קורה (?:איתה|איתו|איתם)|מה (?:היא|הוא) (?:רצתה|רצה|כתבה|כתב|צריכה|צריך)|תן לי (?:הקשר|רקע)|give me (?:the )?context/i.test(t)) return { kind: "query", topic: "customer", ...(customerHint(t) ? { subject: customerHint(t)! } : {}) };
    if (THIS_CUSTOMER.test(t) && !customerHint(t)) return { kind: "query", topic: "customer" };
    if (STUCK.test(t) && !MONEY_WORDS.test(t)) return { kind: "query", topic: "waiting" };
    const topic = TOPICS.find((x) => x.about.test(t))?.topic;
    const subject = customerHint(t);
    if (topic === "operation" || (work && (QUESTION.test(t) || /\bhappened\b|\bstatus\b/i.test(t)) && topic !== "money" && topic !== "needs_you")) return { kind: "query", topic: "operation", ...(work ? { workflow: work } : {}) };
    if (subject && !topic) return { kind: "query", topic: "customer", subject };
    if (topic === "initiatives") return { kind: "query", topic, ...(/\b(money|losing|leak\w*|cost\w*|revenue)\b/i.test(t) ? { subject: "money" } : {}) };
    if (topic === "money") {
      const money: MoneyFocus | undefined = /\b(stuck|at risk|slipping|losing)\b|תקוע|בסיכון/i.test(t) ? "stuck" : /\b(fail\w*|declined|bounced|didn'?t go through)\b|נכשל|לא עבר/i.test(t) ? "failed" : /\b(awaiting|waiting for payment|unpaid|not paid|pending|owe)\b|מחכה לתשלום|ממתין|לא שילמו|לא שולם/i.test(t) ? "awaiting" : undefined;
      return { kind: "query", topic, ...(money ? { money } : {}) };
    }
    if (topic) return { kind: "query", topic, ...(subject ? { subject } : {}) };
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
