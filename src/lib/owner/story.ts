import type { ConversationState, TurnLog } from "@/lib/state";
import { ledgerView, readLedger, termsAmount, type LedgerEntry } from "@/lib/runtime/ledger";
import { transactionSnapshot } from "@/lib/runtime/handoff";
import type { OwnerLang } from "./lang";

/**
 * THE STORY OF ONE CONVERSATION — what the customer asked, what BARRY did about it, and what became of
 * it, turn by turn, in the owner's words. Built only from records: the turn log (asks, understanding,
 * stop reason), the immutable effect ledger (each effect's status, frozen terms and reference) and the
 * handoff/transaction snapshot. Nothing here is model prose, and nothing names an internal id.
 *
 * Every owner surface that has to answer "why?" reads this: the intervention queue ("what BARRY
 * already did"), the inbox detail, and Owner Barry.
 */

export type StoryOutcome = "done" | "answered" | "awaiting_owner" | "needs_customer" | "blocked" | "failed" | "not_understood" | "handoff" | "owner_decision";

export type StoryStep = {
  at: string;
  turnId: string;
  /** What the customer asked (their own asks when recorded, else their message). */
  customer: string;
  /** What BARRY did about it, one line per recorded effect (owner words). */
  barry: string[];
  outcome: StoryOutcome;
  /** Why it stopped there, when it didn't simply finish. */
  stopped?: string;
  /** BARRY's reply, shortened. */
  reply?: string;
};

export type ConversationStory = {
  steps: StoryStep[];
  /** Where the transaction stands now (from the ledger's current view). */
  standing: string[];
  /** Everything consequential BARRY did or attempted in this conversation, oldest first (deduplicated). */
  tried: string[];
};

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const STOP_WORDS_EN: Record<string, string> = {
  owner_approval_required: "needs your approval",
  policy_denied: "not allowed by your rules",
  write_blocked: "blocked by the customer's own limits",
  tool_failed: "the system didn't go through",
  capability_unavailable: "needs a system that isn't connected",
  needs_customer: "waiting for the customer",
  requested_change_not_applied: "the requested change didn't apply",
  understanding_unavailable: "couldn't understand the message",
  approval_held_customer_intent_unverified: "held until the customer confirms",
  approval_execution_failed: "your approved request didn't go through",
};

const STOP_WORDS_HE: Record<string, string> = {
  owner_approval_required: "צריך את האישור שלך",
  policy_denied: "לא מותר לפי הכללים שלך",
  write_blocked: "נחסם לפי המגבלות שהלקוח עצמו ביקש",
  tool_failed: "המערכת לא השלימה את הפעולה",
  capability_unavailable: "צריך מערכת שעוד לא מחוברת",
  needs_customer: "מחכה ללקוח",
  requested_change_not_applied: "השינוי שהתבקש לא בוצע",
  understanding_unavailable: "לא הצליח להבין את ההודעה",
  approval_held_customer_intent_unverified: "מוחזק עד שהלקוח יאשר",
  approval_execution_failed: "הבקשה שאישרת לא הצליחה",
};

/** What an effect was about, in Hebrew (from the effect type — never the English free text). */
function nounHe(e: LedgerEntry): string {
  const x = e.effect;
  if (/^payment\./.test(x) || /payment|checkout/i.test(e.operation)) return "קישור תשלום";
  if (/^booking\./.test(x) || /booking/i.test(e.operation)) return "תור";
  if (/^order\./.test(x) || /order/i.test(e.operation)) return "הזמנה";
  if (/^cart\./.test(x) || /cart/i.test(e.operation)) return "שינוי בעגלה";
  if (/discount/i.test(x) || /discount/i.test(e.operation)) return "הנחה";
  if (/refund/i.test(x) || /refund/i.test(e.operation)) return "החזר כספי";
  if (/^handoff\./.test(x)) return "העברה לצוות";
  if (/^enquiry\./.test(x)) return "פנייה";
  return "פעולה";
}

function termsWords(e: LedgerEntry, lang: OwnerLang = "en"): string {
  if (lang === "he") {
    const amount = termsAmount(e.terms);
    const parts = [typeof e.terms.item === "string" ? e.terms.item : "", typeof e.terms.items === "string" ? e.terms.items : "", amount ?? ""].filter(Boolean);
    return parts.length ? ` — ${parts.join(", ")}` : "";
  }
  const amount = termsAmount(e.terms);
  const parts: string[] = [];
  if (typeof e.terms.item === "string") parts.push(e.terms.item);
  if (typeof e.terms.items === "string") parts.push(e.terms.items);
  if (amount) parts.push(amount);
  for (const [k, v] of Object.entries(e.terms)) {
    if (["item", "items", "amount", "currency", "quantityBefore", "quantityAfter", "itemAfter", "quantity"].includes(k)) continue;
    if (typeof v === "string" && v.length <= 60) parts.push(`${k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}: ${v}`);
  }
  return parts.length ? ` — ${parts.join(", ")}` : "";
}

/** One effect in owner words: what it was, what became of it, its terms and any reference. */
export function describeEffect(e: LedgerEntry, lang: OwnerLang = "en"): string {
  if (lang === "he") return describeEffectHe(e);
  const ref = e.reference ? ` (${e.reference})` : "";
  const t = termsWords(e);
  switch (e.status) {
    case "awaiting_owner":
      return `Asked you to approve: ${e.describes}${t}`;
    case "owner_declined":
      return `You declined: ${e.describes}${t}`;
    case "withdrawn":
      return `The customer withdrew: ${e.describes}${t}`;
    case "superseded":
      return `Replaced by a newer request: ${e.describes}${t}`;
    case "failed":
      return e.operation === "understand" ? "Couldn't understand the customer's message" : `Tried ${e.describes}${t} — it FAILED; nothing changed`;
    case "effected_unconfirmed":
      return `Submitted ${e.describes}${t}${ref} — the system hasn't confirmed it yet`;
    case "no_effect":
      if (e.effect === "write.blocked") return `Did NOT send ${e.describes}${t}: blocked by the customer's own limits`;
      if (e.effect === "understanding.partial") return "Only partly understood the customer's message";
      if (e.effect === "understanding.revalidated") return "Re-read an earlier message it couldn't understand";
      if (e.effect === "cart.not_changed") return `Couldn't make the cart change${t}`;
      return `${cap(e.describes)}${t}: no change`;
  }
  switch (e.effect) {
    case "handoff.created":
      return e.outcome?.responseCommitted ? "Handed the conversation to your team (customer told you follow up as your playbook says)" : "Handed the conversation to your team (customer told no reply time is promised)";
    case "handoff.resolved":
      return "Your team closed the handoff";
    case "payment.link_created":
      return `Sent a payment link${t} — not paid yet`;
    case "payment.settled":
      return `Payment verified by the provider${t}`;
    case "payment.pending":
      return "Checked the payment: not paid yet";
    case "payment.not_paid":
      return "Checked the payment: not paid";
    case "booking.created":
      return `Booked the appointment${t}${ref}`;
    case "order.created":
      return `Created the order${t}${ref}`;
    case "order.fulfilled":
      return `Confirmed the order${ref}`;
    case "enquiry.created":
      return `Recorded an enquiry for your team${ref}`;
    case "followup.scheduled":
      return "Scheduled a follow-up";
    case "catalog.searched":
      return `Searched the catalog${typeof e.outcome?.results === "number" ? ` (${e.outcome.results} result${e.outcome.results === 1 ? "" : "s"})` : ""}`;
    case "availability.found":
      return "Looked up open times: found some";
    case "availability.none":
      return "Looked up open times: none in that window";
    case "stock.available":
      return "Checked stock: available";
    case "stock.insufficient":
      return "Checked stock: not enough";
    case "cart.line_added":
      return `Added to the cart${t}`;
    case "cart.line_updated":
      return `Changed a cart line${t}`;
    case "cart.line_replaced":
      return `Swapped a cart item${t}`;
    case "cart.line_removed":
      return `Removed from the cart${t}`;
  }
  if (e.effect.endsWith(".read")) return `Looked up: ${e.describes}${t}`;
  return `${cap(e.describes)}${t}${ref}`;
}

function describeEffectHe(e: LedgerEntry): string {
  const ref = e.reference ? ` (${e.reference})` : "";
  const t = termsWords(e, "he");
  const noun = nounHe(e);
  switch (e.status) {
    case "awaiting_owner":
      return `ביקש את אישורך: ${noun}${t}`;
    case "owner_declined":
      return `דחית: ${noun}${t}`;
    case "withdrawn":
      return `הלקוח ביטל: ${noun}${t}`;
    case "superseded":
      return `הוחלף בבקשה חדשה יותר: ${noun}${t}`;
    case "failed":
      return e.operation === "understand" ? "לא הצליח להבין את ההודעה של הלקוח" : `ניסה: ${noun}${t} — זה נכשל; שום דבר לא השתנה`;
    case "effected_unconfirmed":
      return `שלח: ${noun}${t}${ref} — המערכת עוד לא אישרה`;
    case "no_effect":
      if (e.effect === "write.blocked") return `לא שלח ${noun}${t}: נחסם לפי המגבלות שהלקוח ביקש`;
      if (e.effect === "understanding.partial") return "הבין רק חלק מההודעה של הלקוח";
      if (e.effect === "understanding.revalidated") return "קרא שוב הודעה קודמת שלא הובנה";
      if (e.effect === "cart.not_changed") return `לא הצליח לשנות את העגלה${t}`;
      return `${noun}${t}: בלי שינוי`;
  }
  switch (e.effect) {
    case "handoff.created":
      return e.outcome?.responseCommitted ? "העביר את השיחה לצוות שלך (הלקוח עודכן שתחזרו אליו כמו שנקבע)" : "העביר את השיחה לצוות שלך (בלי הבטחה לזמן תשובה)";
    case "handoff.resolved":
      return "הצוות שלך סגר את ההעברה";
    case "payment.link_created":
      return `שלח קישור תשלום${t} — עוד לא שולם`;
    case "payment.settled":
      return `התשלום אומת מול הספק${t}`;
    case "payment.pending":
      return "בדק את התשלום: עוד לא שולם";
    case "payment.not_paid":
      return "בדק את התשלום: לא שולם";
    case "booking.created":
      return `קבע את התור${t}${ref}`;
    case "order.created":
      return `יצר את ההזמנה${t}${ref}`;
    case "order.fulfilled":
      return `אישר את ההזמנה${ref}`;
    case "enquiry.created":
      return `רשם פנייה לצוות שלך${ref}`;
    case "followup.scheduled":
      return "תזמן מעקב";
    case "catalog.searched":
      return `חיפש בקטלוג${typeof e.outcome?.results === "number" ? ` (${e.outcome.results} תוצאות)` : ""}`;
    case "availability.found":
      return "בדק זמנים פנויים: נמצאו";
    case "availability.none":
      return "בדק זמנים פנויים: אין בטווח הזה";
    case "stock.available":
      return "בדק מלאי: יש";
    case "stock.insufficient":
      return "בדק מלאי: אין מספיק";
    case "cart.line_added":
      return `הוסיף לעגלה${t}`;
    case "cart.line_updated":
      return `שינה שורה בעגלה${t}`;
    case "cart.line_replaced":
      return `החליף פריט בעגלה${t}`;
    case "cart.line_removed":
      return `הסיר מהעגלה${t}`;
  }
  if (e.effect.endsWith(".read")) return `בדק: ${noun}${t}`;
  return `${noun}${t}${ref}`;
}

const READ_EFFECT = /\.read$|^catalog\.|^availability\.|^stock\.|^payment\.(pending|not_paid)$|^understanding\./;

function customerWords(turn: TurnLog, lang: OwnerLang = "en"): string {
  if (turn.understood.intent === "approval_resumed") return turn.understood.entities?.decision === "declined" ? (lang === "he" ? "(דחית את הבקשה)" : "(you declined the request)") : lang === "he" ? "(אישרת את הבקשה)" : "(you approved the request)";
  if (turn.understood.intent === "approval_already_resolved") return lang === "he" ? "(בקשה הוחלטה פעמיים)" : "(a request was decided twice)";
  // In Hebrew the customer's own message is shown (the recorded asks are English paraphrases).
  if (lang === "he") return clip(turn.customerMessage);
  const asks = turn.understood.asks?.map((a) => a.ask).filter(Boolean) ?? [];
  return asks.length ? asks.join("; ") : clip(turn.customerMessage);
}

function outcomeOf(turn: TurnLog, effects: LedgerEntry[], lang: OwnerLang = "en"): { outcome: StoryOutcome; stopped?: string } {
  const STOP_WORDS = lang === "he" ? STOP_WORDS_HE : STOP_WORDS_EN;
  const t = turn.trace;
  if (t?.understanding && !t.understanding.valid) return { outcome: "not_understood", stopped: STOP_WORDS.understanding_unavailable };
  if (turn.understood.intent === "approval_resumed") {
    const failed = effects.some((e) => e.status === "failed" || e.effect === "write.blocked");
    return { outcome: "owner_decision", ...(failed ? { stopped: STOP_WORDS.approval_execution_failed } : {}) };
  }
  if (t?.hold) return { outcome: "awaiting_owner", stopped: STOP_WORDS.approval_held_customer_intent_unverified };
  if (effects.some((e) => e.status === "awaiting_owner")) return { outcome: "awaiting_owner", stopped: STOP_WORDS.owner_approval_required };
  if (effects.some((e) => e.effect === "write.blocked")) return { outcome: "blocked", stopped: STOP_WORDS.write_blocked };
  if (effects.some((e) => e.status === "failed" && e.operation !== "understand")) return { outcome: "failed", stopped: STOP_WORDS.tool_failed };
  if (effects.some((e) => e.effect === "handoff.created")) return { outcome: "handoff" };
  const stop = t?.stop.reason;
  if (stop && (stop === "policy_denied" || stop === "capability_unavailable" || stop === "requested_change_not_applied")) return { outcome: "blocked", stopped: STOP_WORDS[stop] };
  if (stop === "needs_customer" || (t?.missingFields?.length ?? 0) > 0) return { outcome: "needs_customer", stopped: STOP_WORDS.needs_customer };
  if (effects.some((e) => (e.status === "effected" || e.status === "effected_unconfirmed") && !READ_EFFECT.test(e.effect))) return { outcome: "done" };
  return { outcome: "answered" };
}

/** Where the transaction stands, in Hebrew (from the same ledger view as transactionSnapshot). */
/** Where the transaction stands, in Hebrew — the same current ledger view the English snapshot reads. */
function standingHe(state: ConversationState): string[] {
  const view = ledgerView(readLedger(state));
  const out: string[] = [];
  const lastCart = [...view].reverse().find((e) => e.outcome && typeof e.outcome.cartAfter === "string");
  if (lastCart && lastCart.outcome!.cartAfter !== "empty") out.push(`עגלה: ${lastCart.outcome!.cartAfter}`);
  for (const e of view) {
    if (e.status === "awaiting_owner") out.push(`מחכה לאישורך: ${nounHe(e)}`);
    else if (e.effect === "payment.link_created") out.push("נשלח קישור תשלום (עוד לא אומת ששולם)");
    else if (e.effect === "payment.settled") out.push("התשלום אומת");
    else if (e.effect === "booking.created") out.push(`נקבע תור${e.reference ? ` (${e.reference})` : ""}`);
    else if (e.effect === "order.created") out.push(`הזמנה בוצעה${e.reference ? ` (${e.reference})` : ""}`);
    else if (e.effect === "write.blocked") out.push(`נחסם: ${nounHe(e)}`);
    else if (e.status === "effected" && e.reference) out.push(`${nounHe(e)} (${e.reference})`);
  }
  return [...new Set(out)].slice(-8);
}

export function conversationStory(state: ConversationState, lang: OwnerLang = "en"): ConversationStory {
  const ledger = readLedger(state);
  const bySeq = new Map(ledger.map((e) => [e.seq, e]));
  const steps: StoryStep[] = state.turns.map((turn) => {
    const effects = (turn.trace?.effects ?? []).map((e) => bySeq.get(e.seq)).filter((e): e is LedgerEntry => Boolean(e));
    const { outcome, stopped } = outcomeOf(turn, effects, lang);
    return {
      at: turn.at,
      turnId: turn.id,
      customer: customerWords(turn, lang),
      barry: effects.map((e) => describeEffect(e, lang)),
      outcome,
      ...(stopped ? { stopped } : {}),
      ...(turn.response ? { reply: clip(turn.response) } : {}),
    };
  });
  const tried: string[] = [];
  for (const e of ledger) {
    if (READ_EFFECT.test(e.effect) && e.status !== "failed") continue;
    const line = describeEffect(e, lang);
    if (tried.at(-1) !== line) tried.push(line);
  }
  return { steps, standing: lang === "he" ? standingHe(state) : transactionSnapshot(state), tried: tried.slice(-10) };
}
