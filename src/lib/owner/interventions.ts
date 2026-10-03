import type { BusinessGraph } from "@/lib/business-graph";
import { lastSaid } from "@/lib/operator/execution-state";
import type { ConversationState } from "@/lib/state";
import type { PaymentRequestRecord } from "@/lib/store/types";
import { getCapability } from "@/lib/fabric/capability";
import { readLedger, termsAmount, termsOf, type LedgerEntry } from "@/lib/runtime/ledger";
import { readHandoffs, handoffPath, type HandoffRecord } from "@/lib/runtime/handoff";
import type { ApprovalWithLifecycle } from "@/lib/runtime/owner-requests";
import { readDeliveries } from "@/lib/channels/gateway";
import { money } from "@/lib/reasoner/deterministic-compose";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import { conversationStory } from "./story";
import { L, amount as fmtAmount, type OwnerLang } from "./lang";

/**
 * THE INTERVENTION QUEUE — the one list of everything that needs the owner, whatever kind of record
 * it comes from: a request waiting for approval, a request held until the customer confirms, a
 * customer handed to the team, an operation that failed, a checkout the customer's own limits blocked,
 * a message BARRY couldn't understand, a reply the channel couldn't deliver.
 *
 * Each item answers, from records only: why BARRY escalated, what it already did, exactly what
 * decision is needed, what each option causes, what BARRY resumes afterwards, and whether the item is
 * still current. Nothing here executes anything: the actions point at the existing owner endpoints,
 * which re-check everything (customer intent, the final-write gate) before an effect.
 */

export type InterventionKind = "approval" | "held_approval" | "handoff" | "failed_action" | "blocked_write" | "not_understood" | "delivery_failed";
export type InterventionAction = "approve" | "decline" | "recheck" | "acknowledge" | "resolve" | "open_conversation";

export type InterventionOption = {
  action: InterventionAction;
  label: string;
  /** What happens if the owner picks this (plain words, from how the runtime really behaves). */
  consequence: string;
  primary?: boolean;
  destructive?: boolean;
};

export type Intervention = {
  /** Stable across reloads: kind + the record it stands for. */
  id: string;
  kind: InterventionKind;
  /** 1 = a decision a customer or a sale is waiting on; 2 = something broke; 3 = worth knowing. */
  priority: 1 | 2 | 3;
  customer: string;
  conversationId: string;
  since: string;
  /** One line: what needs the owner. */
  title: string;
  /** Why BARRY escalated (your rule, the customer's ask, the failure). */
  why: string;
  /** What BARRY already did in this conversation, oldest first. */
  tried: string[];
  /** Exactly what is needed from the owner. */
  decision: string;
  options: InterventionOption[];
  /** What happens after / what BARRY resumes on its own. */
  then: string;
  /** Is the item still current, and how BARRY knows. */
  freshness: string;
  amount?: string;
  terms?: Record<string, string | number>;
  /** The records this item stands on. */
  evidence: string[];
  refs: { approvalId?: string; handoffId?: string; paymentRequestId?: string; seq?: number };
};

export type InterventionInput = {
  graph: BusinessGraph;
  conversations: ConversationState[];
  approvals: ApprovalWithLifecycle[];
  payments: PaymentRequestRecord[];
  customerLabel: (c: ConversationState) => string;
  now?: Date;
  /** The owner's language for every word below (default English — the Owner WhatsApp channel). */
  lang?: OwnerLang;
};

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const RECHECK_NOTE = (lang: OwnerLang) => L(lang, "Before anything runs, BARRY re-reads what the customer said since and re-checks their own limits; if something changed, it holds instead of running.", "לפני שמשהו רץ, BARRY קורא שוב מה הלקוח כתב מאז ובודק שוב את המגבלות שלו; אם משהו השתנה — הוא עוצר במקום לבצע.");
/** Hebrew "to <name>": the prefix joins Hebrew names directly and takes a maqaf before other scripts. */
const le = (name: string) => (/^[\u0590-\u05FF]/.test(name) ? `ל${name}` : `ל־${name}`);
const cash = (lang: OwnerLang, v: number, c: string) => (lang === "he" ? fmtAmount("he", v, c) : money(v, c));

/** The owner's own rule behind an approval, in their words — never a capability id or rule syntax. */
export function whyApproval(graph: BusinessGraph, a: ApprovalWithLifecycle, lang: OwnerLang = "en"): string {
  const T = (en: string, he: string) => L(lang, en, he);
  const input = (a.requestedInput ?? {}) as Record<string, unknown>;
  const currency = typeof input.currency === "string" ? input.currency : (graph.offers[0]?.currency ?? "USD");
  const rule = graph.authority.find((r) => r.id === a.policyId);
  if (rule) return rule.reason?.trim() ? T(`Your rule: ${rule.reason.trim()}`, `הכלל שלך: ${rule.reason.trim()}`) : T("Your authority rules say you approve this first.", "לפי הכללים שלך, זה דורש את האישור שלך קודם.");
  const policy = graph.policies.find((p) => p.rule.type === a.policyId);
  switch (policy?.rule.type) {
    case "max_auto_payment_amount":
      return T(`Above your automatic payment limit of ${money(policy.rule.value, currency)}.`, `מעל גבול התשלום האוטומטי שלך (${cash("he", policy.rule.value, currency)}).`);
    case "max_auto_discount_pct":
      return policy.provenance?.source === "owner_trained" ? T(`Above the ${policy.rule.value}% you taught BARRY it may give on its own.`, `מעל ה־${policy.rule.value}% שלימדת את BARRY לתת לבד.`) : T(`Above the ${policy.rule.value}% discount BARRY may give on its own.`, `מעל ${policy.rule.value}% הנחה ש־BARRY רשאי לתת לבד.`);
    case "custom_pricing_requires_approval":
      return T("Your rules: any custom price needs your approval.", "לפי הכללים שלך: כל מחיר מיוחד דורש את האישור שלך.");
    case "bookings_auto_allowed":
      return T("Your rules: every booking needs your approval.", "לפי הכללים שלך: כל תור דורש את האישור שלך.");
    case "refund_requires_approval":
      return T("Your rules: refunds need your approval.", "לפי הכללים שלך: החזרים כספיים דורשים את האישור שלך.");
  }
  return lang === "he" ? "לפי הכללים שלך, זה דורש את האישור שלך לפני ש־BARRY מבצע." : a.reason?.trim() ? a.reason : "Your rules say you approve this before BARRY does it.";
}

function systemWords(graph: BusinessGraph, a: ApprovalWithLifecycle): string {
  const input = (a.requestedInput ?? {}) as Record<string, unknown>;
  if (a.requestedAction === INVOKE_CAPABILITY) {
    const purpose = getCapability(String(input.capability))?.purpose;
    return purpose ? purpose.toLowerCase() : "the request";
  }
  return a.summary;
}

/** What BARRY does once the owner approves — by the kind of operation, from how the runtime resumes. */
export function afterApproval(graph: BusinessGraph, a: ApprovalWithLifecycle, lang: OwnerLang = "en"): string {
  const amount = termsAmount(termsOf(a.requestedAction, a.requestedInput));
  if (lang === "he") {
    switch (a.requestedAction) {
      case "createCommerceCheckout":
      case "createPaymentRequest":
        return `BARRY שולח בצ׳אט את קישור התשלום${amount ? ` על ${amount}` : ""} ומחכה שספק התשלומים יאשר — זה נחשב כנגבה רק אחרי אימות. שום דבר אחר לא רץ לבד.`;
      case "grantDiscount":
        return (a.requestedInput as { cartId?: unknown })?.cartId ? "BARRY מעדכן את הלקוח שההנחה אושרה ומתמחר את התשלום בדיוק לפיה, פעם אחת — האישור עצמו לא שולח ולא גובה כלום." : "BARRY מעדכן את הלקוח שההנחה אושרה. שום דבר לא נוסף לעגלה, נשלח או נגבה: היא חלה רק אם יזמין את הפריט הזה במחיר הזה.";
      case "createBooking":
        return "BARRY קובע את התור במערכת התורים שלך ומאשר אותו ללקוח.";
      case "refund":
        return "BARRY מבצע את ההחזר דרך ספק התשלומים שלך ומאשר אותו ללקוח.";
      case INVOKE_CAPABILITY:
        return "BARRY מבצע את זה פעם אחת דרך המערכת המחוברת ומעדכן את הלקוח בתוצאה, עם האסמכתה שהתקבלה. אם המערכת לא מאשרת — הלקוח מקבל עדכון שזה לא אושר.";
      default:
        return "BARRY מבצע את זה פעם אחת ומעדכן את הלקוח בתוצאה.";
    }
  }
  switch (a.requestedAction) {
    case "createCommerceCheckout":
    case "createPaymentRequest":
      return `BARRY sends the payment link${amount ? ` for ${amount}` : ""} in the chat and waits for the payment provider to confirm payment — it counts as collected only once verified. Nothing else runs on its own.`;
    case "grantDiscount":
      return (a.requestedInput as { cartId?: unknown })?.cartId
        ? "BARRY tells the customer the discount is approved and prices their checkout with exactly it, once — nothing is sent or charged by the approval itself."
        : "BARRY tells the customer the discount is approved. Nothing is added to a cart, sent or charged: it applies only if they order this item at this price — if the price changes, it needs a fresh look.";
    case "createBooking":
      return "BARRY books the appointment through your scheduling system and confirms it to the customer.";
    case "refund":
      return "BARRY issues the refund through your payment provider and confirms it to the customer.";
    case INVOKE_CAPABILITY:
      return `BARRY runs it once — ${systemWords(graph, a)} — through your connected system and tells the customer the result, with the reference it returns. If the system doesn't confirm it, the customer is told it isn't confirmed.`;
    default:
      return "BARRY carries it out once and tells the customer the result.";
  }
}

/** The action in a few owner words, from the real proposal — for button labels ("Approve ₪2480 payment link"). */
export function actionWords(graph: BusinessGraph, a: ApprovalWithLifecycle, lang: OwnerLang = "en"): string {
  const terms = termsOf(a.requestedAction, a.requestedInput);
  const amount = termsAmount(terms);
  if (lang === "he") {
    switch (a.requestedAction) {
      case "createCommerceCheckout":
      case "createPaymentRequest":
        return `קישור תשלום${amount ? ` על ${amount}` : ""}${typeof terms.discountPct === "number" && terms.discountPct > 0 ? ` עם ${terms.discountPct}% הנחה` : ""}`;
      case "grantDiscount": {
        const pct = Number(terms.discountPct);
        const list = typeof terms.listAmount === "number" && typeof terms.currency === "string" ? ` (${cash("he", terms.listAmount, terms.currency)} → ${cash("he", Math.round(terms.listAmount * (100 - pct)) / 100, terms.currency)})` : "";
        return `${pct}% הנחה על ${terms.item === "the whole cart" ? "כל העגלה" : String(terms.item ?? "העגלה")}${list}`;
      }
      case "createBooking":
        return "תור";
      case "refund":
        return `החזר כספי${amount ? ` של ${amount}` : ""}`;
      default:
        return "הבקשה";
    }
  }
  switch (a.requestedAction) {
    case "createCommerceCheckout":
    case "createPaymentRequest":
      return `${amount ? `${amount} ` : ""}payment link${typeof terms.discountPct === "number" && terms.discountPct > 0 ? ` with ${terms.discountPct}% off` : ""}`;
    case "grantDiscount": {
      const pct = Number(terms.discountPct);
      const list = typeof terms.listAmount === "number" && typeof terms.currency === "string" ? ` (${money(terms.listAmount, terms.currency)} → ${money(Math.round(terms.listAmount * (100 - pct)) / 100, terms.currency)})` : "";
      return `${pct}% off ${terms.item === "the whole cart" ? "the whole cart" : String(terms.item ?? "the cart")}${list}`;
    }
    case "createBooking":
      return "booking";
    case "refund":
      return `${amount ? `${amount} ` : ""}refund`;
    case INVOKE_CAPABILITY: {
      const purpose = systemWords(graph, a).replace(/\.$/, "");
      const ref = Object.values(terms).find((v) => typeof v === "string" && /\d/.test(v));
      return `${purpose}${ref ? ` (${ref})` : ""}`;
    }
    default:
      return a.summary.length > 40 ? `${a.summary.slice(0, 39)}…` : a.summary;
  }
}

function holdWords(a: ApprovalWithLifecycle, lang: OwnerLang = "en"): string {
  if (lang === "he") return a.hold?.reason === "conflicting_reference" ? `אחרי הבקשה הזאת הלקוח כתב ${a.hold.detail ?? "משהו אחר"}, וזה סותר אותה — BARRY לא יבצע את התנאים הישנים.` : "אחרי הבקשה הזאת הלקוח שלח הודעה ש־BARRY לא הצליח להבין — ייתכן שהבקשה השתנתה או בוטלה, אז BARRY לא מבצע אותה עדיין.";
  if (a.hold?.reason === "conflicting_reference") return `After this request the customer wrote ${a.hold.detail ?? "a different reference"}, which conflicts with it — BARRY won't run the old terms.`;
  return "After this request the customer sent a message BARRY couldn't understand — it may have changed or withdrawn the request, so BARRY won't run it yet.";
}

function approvalItem(graph: BusinessGraph, a: ApprovalWithLifecycle, convo: ConversationState | undefined, customer: string, lang: OwnerLang = "en"): Intervention {
  const T = (en: string, he: string) => L(lang, en, he);
  const terms = termsOf(a.requestedAction, a.requestedInput);
  const amount = termsAmount(terms);
  const story = convo ? conversationStory(convo, lang) : undefined;
  const held = a.lifecycle === "held";
  const what = lang === "he" ? actionWords(graph, a, "he") : a.summary;
  const evidence = [`request ${a.id.slice(0, 12)} · revision ${a.revision} · ${new Date(a.createdAt).toISOString()}`];
  if (held) {
    return {
      id: `held_approval:${a.id}`,
      kind: "held_approval",
      priority: 1,
      customer,
      conversationId: a.conversationId,
      since: a.createdAt,
      title: T(`Held: ${what} for ${customer}`, `מוחזק: ${what} ${le(customer)}`),
      why: holdWords(a, lang),
      tried: story?.tried ?? [],
      decision: T("Re-check the conversation before deciding. Approve isn't offered while the request may be stale.", "כדאי לבדוק שוב את השיחה לפני שמחליטים. אין אפשרות לאשר כל עוד הבקשה אולי לא עדכנית."),
      options: [
        { action: "recheck", label: T("Re-check customer correction", "לבדוק שוב את התיקון של הלקוח"), primary: true, consequence: T("BARRY re-reads the customer's later message. If it changed the request, this one is replaced and the corrected request comes back to you; if it withdrew it, it's cancelled; if unrelated, this request becomes approvable.", "BARRY קורא שוב את ההודעה המאוחרת של הלקוח. אם היא שינתה את הבקשה — הבקשה מוחלפת והבקשה המתוקנת חוזרת אליך; אם הלקוח ביטל — היא מבוטלת; אם זה לא קשור — אפשר יהיה לאשר.") },
        { action: "decline", label: T("Decline", "לדחות"), destructive: true, consequence: T("BARRY tells the customer this can't be done; nothing is sent or changed.", "BARRY מעדכן את הלקוח שאי אפשר; שום דבר לא נשלח ולא משתנה.") },
      ],
      then: T("After a successful re-check BARRY tells the customer what happened to the earlier request and, if there is a corrected one, that it's waiting for you.", "אחרי בדיקה מוצלחת BARRY מעדכן את הלקוח מה קרה לבקשה הקודמת, ואם יש בקשה מתוקנת — שהיא מחכה לך."),
      freshness: T("Not current: the customer wrote after this request and BARRY couldn't verify what they meant.", "לא עדכני: הלקוח כתב אחרי הבקשה ו־BARRY לא הצליח לוודא מה התכוון."),
      ...(amount ? { amount } : {}),
      terms,
      evidence,
      refs: { approvalId: a.id },
    };
  }
  return {
    id: `approval:${a.id}`,
    kind: "approval",
    priority: 1,
    customer,
    conversationId: a.conversationId,
    since: a.createdAt,
    title: T(`Approve ${what} for ${customer}?`, `לאשר ${what} ${le(customer)}?`),
    why: whyApproval(graph, a, lang),
    tried: story?.tried ?? [],
    decision: T(`Approve or decline exactly these terms${amount ? ` (${amount})` : ""}. BARRY can't change them for you; a different ask needs a new request from the customer.`, `לאשר או לדחות בדיוק את התנאים האלה${amount ? ` (${amount})` : ""}. BARRY לא יכול לשנות אותם בשבילך; בקשה אחרת צריכה להגיע מהלקוח מחדש.`),
    options: [
      { action: "approve", label: T(`Approve ${actionWords(graph, a)}`, `לאשר ${actionWords(graph, a, "he")}`), primary: true, consequence: `${afterApproval(graph, a, lang)} ${RECHECK_NOTE(lang)}` },
      { action: "decline", label: T("Decline", "לדחות"), destructive: true, consequence: T("BARRY tells the customer this can't be done; nothing is sent or changed. The same terms won't be sent to you again.", "BARRY מעדכן את הלקוח שאי אפשר; שום דבר לא נשלח ולא משתנה. אותם תנאים לא יגיעו אליך שוב.") },
    ],
    then: afterApproval(graph, a, lang),
    freshness: a.revision > 1 ? T(`Current (revision ${a.revision}: the customer changed the details; older revisions were replaced).`, `עדכני (גרסה ${a.revision}: הלקוח שינה פרטים; הגרסאות הקודמות הוחלפו).`) : T("Current: nothing the customer said since conflicts with it.", "עדכני: שום דבר שהלקוח אמר מאז לא סותר את זה."),
    ...(amount ? { amount } : {}),
    terms,
    evidence,
    refs: { approvalId: a.id },
  };
}

const TRIGGER_WORDS: Record<HandoffRecord["trigger"], [string, string]> = {
  customer_asked: ["The customer asked for a person", "הלקוח ביקש לדבר עם אדם"],
  barry_cannot_help: ["BARRY couldn't help with what the customer needs", "BARRY לא יכול היה לעזור במה שהלקוח צריך"],
  ai_unavailable: ["BARRY couldn't understand two messages in a row", "BARRY לא הצליח להבין שתי הודעות ברצף"],
};

function handoffItem(graph: BusinessGraph, h: HandoffRecord, convo: ConversationState, customer: string, lang: OwnerLang = "en"): Intervention {
  const T = (en: string, he: string) => L(lang, en, he);
  const path = handoffPath(graph);
  const story = conversationStory(convo, lang);
  return {
    id: `handoff:${h.id}`,
    kind: "handoff",
    priority: h.urgency === "urgent" ? 1 : 2,
    customer,
    conversationId: h.conversationId,
    since: h.createdAt,
    title: T(`${customer} needs a person${h.urgency === "urgent" ? " — urgent" : ""}`, `${customer} צריך אדם${h.urgency === "urgent" ? " — דחוף" : ""}`),
    // The reason is BARRY's note from the conversation (kept as recorded).
    why: lang === "he" ? `${TRIGGER_WORDS[h.trigger][1]}.` : `${TRIGGER_WORDS[h.trigger][0]}: ${h.reason}`,
    tried: story.tried,
    decision: h.unresolved.length ? T(`Reply to the customer in your own channel about: ${h.unresolved.join("; ")}. Then mark it resolved.`, `לענות ללקוח בערוץ שלך לגבי: ${h.unresolved.join("; ")}. ואז לסמן שטופל.`) : T("Reply to the customer in your own channel, then mark it resolved.", "לענות ללקוח בערוץ שלך, ואז לסמן שטופל."),
    options: [
      ...(h.status === "open" ? [{ action: "acknowledge" as const, label: T("Acknowledge handoff", "ראיתי"), consequence: T("Marks it as seen by your team. The customer is not messaged.", "מסמן שהצוות שלך ראה. הלקוח לא מקבל הודעה.") }] : []),
      { action: "resolve", label: T("Mark resolved", "לסמן שטופל"), primary: true, consequence: T("Closes it in your inbox. BARRY keeps handling the conversation as usual; it won't claim you replied.", "סוגר את זה אצלך. BARRY ממשיך לנהל את השיחה כרגיל, ולא יטען שענית.") },
    ],
    then: h.responseCommitted && path ? T(`The customer was told your team follows up as your playbook says: “${path}”. BARRY can't send your reply for you yet.`, `הלקוח עודכן שהצוות שלך יחזור אליו כפי שקבעת: “${path}”. BARRY עוד לא יכול לשלוח את התשובה שלך בשמך.`) : T("The customer was told your team can see this, with no promised reply time. BARRY can't send your reply for you yet.", "הלקוח עודכן שהצוות שלך רואה את הפנייה, בלי הבטחה לזמן תשובה. BARRY עוד לא יכול לשלוח את התשובה שלך בשמך."),
    freshness: h.status === "acknowledged" ? T(`Acknowledged ${h.acknowledgedAt ? new Date(h.acknowledgedAt).toISOString() : ""} — still open until resolved.`, "סומן שנראה — עדיין פתוח עד שיטופל.") : T("Open: your team hasn't acknowledged it yet.", "פתוח: הצוות שלך עוד לא סימן שראה."),
    evidence: [`handoff ${h.id.slice(0, 12)} · ${h.trigger.replace(/_/g, " ")} · ${h.createdAt}`, ...(h.transaction.length ? [`where things stand: ${h.transaction.join(" · ")}`] : [])],
    refs: { handoffId: h.id },
  };
}

const FAILURE_WORDS: Record<string, [string, string]> = {
  provider_quota_exhausted: ["the AI provider account is out of credit", "נגמר הקרדיט בחשבון ספק ה־AI"],
  provider_rate_limited: ["the AI provider rate-limited BARRY", "ספק ה־AI הגביל את קצב הבקשות"],
  qa_forced_understanding_failure: ["a QA test forced this failure", "בדיקת QA יזמה את הכשל"],
  provider_unavailable: ["the AI provider was unavailable", "ספק ה־AI לא היה זמין"],
  semantic_validation_error: ["the AI's understanding wasn't usable", "ההבנה של ה־AI לא הייתה שמישה"],
};

function stepError(convo: ConversationState, e: LedgerEntry): string | undefined {
  for (const t of [...convo.turns].reverse()) {
    if (!t.trace?.effects?.some((x) => x.seq === e.seq)) continue;
    const failed = t.trace.steps.find((s) => s.result && !s.result.ok);
    if (failed?.result && !failed.result.ok) return failed.result.error ? clip(failed.result.error, 160) : undefined;
    if (t.toolResult && !t.toolResult.ok) return t.toolResult.error ? clip(t.toolResult.error, 160) : undefined;
  }
  return undefined;
}

function conversationItems(graph: BusinessGraph, convo: ConversationState, customer: string, approvalsHere: ApprovalWithLifecycle[], hasOpenHandoff: boolean, lang: OwnerLang = "en"): Intervention[] {
  const T = (en: string, he: string) => L(lang, en, he);
  const out: Intervention[] = [];
  const ledger = readLedger(convo);
  const lastMsg = lastSaid(convo);
  const lastTurn = convo.turns.at(-1);
  const story = () => conversationStory(convo, lang);
  const openConversation = (en: string, he: string): InterventionOption => ({ action: "open_conversation", label: T("Open conversation", "לפתוח את השיחה"), primary: true, consequence: T(en, he) });

  // An operation that failed and hasn't since succeeded — the customer was told; nobody retried.
  const failures = ledger.filter((e) => e.status === "failed" && e.operation !== "understand");
  const latestFailure = failures.at(-1);
  if (latestFailure && !ledger.some((e) => e.seq > latestFailure.seq && e.operation === latestFailure.operation && (e.status === "effected" || e.status === "effected_unconfirmed"))) {
    const approved = latestFailure.requestId ? approvalsHere.find((a) => a.id === latestFailure.requestId) : undefined;
    const error = stepError(convo, latestFailure);
    out.push({
      id: `failed_action:${convo.id}:${latestFailure.seq}`,
      kind: "failed_action",
      priority: 2,
      customer,
      conversationId: convo.id,
      since: latestFailure.at,
      title: approved ? T(`Your approved request didn't go through for ${customer}`, `הבקשה שאישרת ${le(customer)} לא הצליחה`) : T(`${latestFailure.describes[0].toUpperCase()}${latestFailure.describes.slice(1)} failed for ${customer}`, `פעולה ${le(customer)} נכשלה`),
      why: error ? T(`The system reported: ${error}`, "המערכת דיווחה על שגיאה — הפרטים בשיחה.") : T("The connected system didn't complete it; BARRY recorded the failure and did not pretend otherwise.", "המערכת המחוברת לא השלימה את הפעולה; BARRY רשם את הכשל ולא העמיד פנים שהצליח."),
      tried: story().tried,
      decision: approved ? T("Check the system it runs through, then tell the customer or ask them to try again. BARRY didn't retry on its own.", "לבדוק את המערכת, ואז לעדכן את הלקוח או לבקש שינסה שוב. BARRY לא ניסה שוב לבד.") : T("Check the system, then tell the customer if needed. The customer was told it didn't go through; BARRY did not retry.", "לבדוק את המערכת ולעדכן את הלקוח אם צריך. הלקוח קיבל עדכון שזה לא הצליח; BARRY לא ניסה שוב."),
      options: [openConversation("Shows the messages and every effect, with the failure.", "מציג את ההודעות ואת כל הפעולות, כולל הכשל.")],
      then: T("If the customer asks again, BARRY tries again through the normal path (your rules and approvals apply as usual).", "אם הלקוח יבקש שוב, BARRY ינסה שוב בדרך הרגילה (הכללים והאישורים שלך חלים כרגיל)."),
      freshness: T("Current: nothing of this kind has succeeded since.", "עדכני: שום פעולה כזאת לא הצליחה מאז."),
      ...(termsAmount(latestFailure.terms) ? { amount: termsAmount(latestFailure.terms) } : {}),
      terms: latestFailure.terms,
      evidence: [`effect #${latestFailure.seq} · ${latestFailure.effect} · ${latestFailure.at}`, ...(approved ? [`request ${approved.id.slice(0, 12)} approved, then failed`] : [])],
      refs: { seq: latestFailure.seq, ...(approved ? { approvalId: approved.id } : {}) },
    });
  }

  // A write the customer's own limits blocked, still the state of play (the customer hasn't moved on).
  const blocked = ledger.filter((e) => e.effect === "write.blocked").at(-1);
  if (blocked && lastMsg?.role === "barry" && !ledger.some((e) => e.seq > blocked.seq && /^payment\.link_created$|^order\.|^booking\./.test(e.effect))) {
    const reason = String(blocked.outcome?.reason ?? "");
    const cur = typeof blocked.terms.currency === "string" ? blocked.terms.currency : (graph.offers[0]?.currency ?? "USD");
    const total = typeof blocked.outcome?.total === "number" ? cash(lang, blocked.outcome.total, cur) : undefined;
    const limit = typeof blocked.outcome?.cap === "number" ? cash(lang, blocked.outcome.cap, cur) : undefined;
    const why =
      reason === "shipping_unknown"
        ? T(`The customer set a budget${limit ? ` of ${limit}` : ""} including shipping, and BARRY doesn't know your shipping cost — so it couldn't promise the total.`, `הלקוח קבע תקציב${limit ? ` של ${limit}` : ""} כולל משלוח, ו־BARRY לא יודע כמה עולה המשלוח שלך — אז הוא לא יכול היה להבטיח את הסכום.`)
        : reason === "over_budget"
          ? T(`The total${total ? ` (${total})` : ""} is above the budget the customer stated${limit ? ` (${limit})` : ""}.`, `הסכום${total ? ` (${total})` : ""} גבוה מהתקציב שהלקוח ציין${limit ? ` (${limit})` : ""}.`)
          : T("The cart holds items the customer didn't agree to buy, so BARRY asked which ones before sending anything.", "בעגלה יש פריטים שהלקוח לא הסכים לקנות, אז BARRY שאל אילו לפני ששלח משהו.");
    out.push({
      id: `blocked_write:${convo.id}:${blocked.seq}`,
      kind: "blocked_write",
      priority: 3,
      customer,
      conversationId: convo.id,
      since: blocked.at,
      title: T(`Checkout for ${customer} stopped by their own limits`, `התשלום של ${customer} נעצר לפי המגבלות שלו`),
      why,
      tried: story().tried,
      decision: reason === "shipping_unknown" ? T("Tell the BARRY team your shipping fee (or free-shipping rule) so BARRY can quote totals. Nothing was sent or charged.", "ספר לצוות BARRY כמה עולה משלוח (או מתי הוא חינם) כדי ש־BARRY יוכל לציין סכום כולל. שום דבר לא נשלח ולא נגבה.") : T("Nothing is required: BARRY asked the customer how to proceed. Step in only if you want to offer something different.", "לא נדרש כלום: BARRY שאל את הלקוח איך להמשיך. אפשר להתערב רק אם תרצה להציע משהו אחר."),
      options: [openConversation("Shows what was in the cart and what BARRY told the customer.", "מציג מה היה בעגלה ומה BARRY אמר ללקוח.")],
      then: T("When the customer answers, BARRY continues within their limits; a payment link is only sent when the total fits what they agreed to.", "כשהלקוח יענה, BARRY ימשיך בתוך המגבלות שלו; קישור תשלום נשלח רק כשהסכום מתאים למה שהלקוח הסכים."),
      freshness: T("Current: the customer hasn't replied since.", "עדכני: הלקוח לא ענה מאז."),
      ...(total ? { amount: total } : {}),
      terms: blocked.terms,
      evidence: [`effect #${blocked.seq} · write.blocked (${reason || "limit"}) · ${blocked.at}`],
      refs: { seq: blocked.seq },
    });
  }

  // BARRY couldn't understand the last message (and no held request or handoff already carries it).
  const u = lastTurn?.trace?.understanding;
  if (u && !u.valid && !hasOpenHandoff && !approvalsHere.some((a) => a.lifecycle === "held")) {
    const kind = u.failure?.kind ?? "unknown";
    const quota = kind === "provider_quota_exhausted";
    const failure = FAILURE_WORDS[kind]?.[lang === "he" ? 1 : 0] ?? (lang === "he" ? "סיבה לא ידועה" : kind.replace(/_/g, " "));
    out.push({
      id: `not_understood:${convo.id}:${lastTurn!.id}`,
      kind: "not_understood",
      priority: quota ? 1 : 2,
      customer,
      conversationId: convo.id,
      since: lastTurn!.at,
      title: T(`BARRY couldn't understand ${customer}'s last message`, `BARRY לא הבין את ההודעה האחרונה של ${customer}`),
      why: T(`Understanding failed: ${failure}. Nothing was done with the message; the customer was told it couldn't be processed.`, `ההבנה נכשלה: ${failure}. לא נעשה כלום עם ההודעה; הלקוח קיבל עדכון שלא ניתן היה לטפל בה.`),
      tried: story().tried,
      decision: quota ? T("Add credit to the AI provider account. Until then BARRY can't understand anyone.", "צריך להוסיף קרדיט לחשבון ספק ה־AI. עד אז BARRY לא יכול להבין אף אחד.") : T("Nothing to decide right now — the customer was asked to try again. If this keeps happening, check Health.", "אין מה להחליט כרגע — הלקוח התבקש לנסות שוב. אם זה חוזר, כדאי לבדוק את המערכות."),
      options: [openConversation("Shows the message and the failure classification.", "מציג את ההודעה ואת סיבת הכשל.")],
      then: T("When the customer writes again, BARRY first re-reads the message it missed, then handles the new one.", "כשהלקוח יכתוב שוב, BARRY יקרא קודם את ההודעה שפספס ואז יטפל בחדשה."),
      freshness: T("Current: this is the latest message in the conversation.", "עדכני: זו ההודעה האחרונה בשיחה."),
      evidence: [`turn ${lastTurn!.id} · ${kind} · ${lastTurn!.at}`],
      refs: {},
    });
  }

  // A reply the channel couldn't deliver (the latest delivery attempt).
  const delivery = readDeliveries(convo.knownFields).at(-1);
  if (delivery?.status === "failed") {
    const channel = delivery.channel === "whatsapp" ? T("WhatsApp", "וואטסאפ") : delivery.channel;
    out.push({
      id: `delivery_failed:${convo.id}:${delivery.at}`,
      kind: "delivery_failed",
      priority: 2,
      customer,
      conversationId: convo.id,
      since: delivery.at,
      title: T(`BARRY's reply to ${customer} wasn't delivered`, `התשובה של BARRY ${le(customer)} לא נמסרה`),
      why: T(`${channel} reported: ${delivery.error ?? "delivery failed"}. The customer didn't get BARRY's last reply.`, `${channel} דיווח שהמסירה נכשלה. הלקוח לא קיבל את התשובה האחרונה של BARRY.`),
      tried: story().tried,
      decision: T("Check the channel connection (Health), and reach the customer another way if it matters now.", "לבדוק את חיבור הערוץ, ולפנות ללקוח בדרך אחרת אם זה דחוף."),
      options: [openConversation("Shows the reply that wasn't delivered.", "מציג את התשובה שלא נמסרה.")],
      then: T("BARRY keeps answering; each reply's delivery is recorded, so you'll see if it keeps failing.", "BARRY ממשיך לענות; המסירה של כל תשובה נרשמת, כך שתראה אם זה ממשיך להיכשל."),
      freshness: T("Current: this was the latest delivery attempt.", "עדכני: זה ניסיון המסירה האחרון."),
      evidence: [`delivery ${delivery.at} · ${delivery.status}${delivery.error ? ` · ${clip(delivery.error, 80)}` : ""}`],
      refs: {},
    });
  }
  return out;
}

export function buildInterventions(input: InterventionInput): Intervention[] {
  const lang = input.lang ?? "en";
  const byId = new Map(input.conversations.map((c) => [c.id, c]));
  const items: Intervention[] = [];
  for (const a of input.approvals) {
    if (a.lifecycle !== "active" && a.lifecycle !== "held") continue;
    const convo = byId.get(a.conversationId);
    items.push(approvalItem(input.graph, a, convo, convo ? input.customerLabel(convo) : L(lang, "Customer", "לקוח"), lang));
  }
  for (const convo of input.conversations) {
    const customer = input.customerLabel(convo);
    const handoffs = readHandoffs(convo).filter((h) => h.status !== "resolved");
    for (const h of handoffs) items.push(handoffItem(input.graph, h, convo, customer, lang));
    items.push(...conversationItems(input.graph, convo, customer, input.approvals.filter((a) => a.conversationId === convo.id), handoffs.length > 0, lang));
  }
  return items.sort((x, y) => x.priority - y.priority || x.since.localeCompare(y.since));
}

/** The queue as Owner Barry sees it (compact, customer-safe). */
export function interventionBriefing(items: Intervention[]) {
  return items.slice(0, 15).map((i) => ({
    kind: i.kind.replace(/_/g, " "),
    customer: i.customer,
    what: i.title,
    why: i.why,
    youDecide: i.decision,
    ...(i.amount ? { amount: i.amount } : {}),
    ifApproved: i.options.find((o) => o.action === "approve")?.consequence,
    since: i.since,
    current: i.freshness,
  }));
}
