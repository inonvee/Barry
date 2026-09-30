import { requestsText } from "./status-render";
import type { ComposeResponseInput, OwnerRequestView } from "./types";
import { fieldLabel } from "./reply-contract";

/**
 * A "needs_info" reply asks for EXACTLY what `missingFields` names, one
 * per real-world field, never invented or pluralized based on unrelated
 * context (a live bug: partySize=2 made BARRY ask for "names and phone
 * numbers" when only ONE customer's info was missing).
 */
function formatMissingFieldsList(missingFields: string[], lang = "en"): string {
  const labels = missingFields.map((f) => fieldLabel(f, lang));
  const and = lang === "he" ? " ו" : " and ";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]}${and}${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")},${and}${labels[labels.length - 1]}`;
}

/**
 * Canned, deterministic phrasing for every CompileOutcome. This is
 * MockReasoner's entire composeResponse() — and also what OpenAIReasoner
 * falls back to if the LLM call for phrasing a reply fails, so a natural-
 * language provider outage degrades to "correct but plain" instead of
 * losing the conversation.
 */
function askVariantText(title: string, requested: Record<string, string> | undefined, available: Record<string, string>[]): string {
  const options = [...new Set(available.map((o) => Object.values(o).join(" / ")))];
  const asked = requested && Object.keys(requested).length ? Object.values(requested).join(" / ") : undefined;
  if (options.length === 0) return `${title} isn't available right now${asked ? ` in ${asked}` : ""}.`;
  return asked
    ? `${title} isn't available in ${asked}. Available: ${options.join(", ")}. Which would you like?`
    : `Which option would you like for ${title}? Available: ${options.join(", ")}.`;
}

const CURRENCY_SYMBOLS: Record<string, string> = { ILS: "₪", NIS: "₪", USD: "$", EUR: "€", GBP: "£" };

/** An amount the way people write it: a symbol instead of a currency code (420 ₪ / ₪420 / $420). */
export function money(amount: number | string, currency: string | undefined, lang = "en"): string {
  const symbol = currency ? CURRENCY_SYMBOLS[currency.toUpperCase()] : undefined;
  if (!symbol) return currency ? `${amount} ${currency}` : String(amount);
  return lang === "he" && symbol === "₪" ? `${amount} ₪` : `${symbol}${amount}`;
}

export function composeDeterministic(input: ComposeResponseInput): string {
  const base = composeDeterministicCore(input);
  const he = input.language?.code === "he";
  // A policy the customer asked about is quoted exactly as the business wrote it — never paraphrased.
  const quoted = new Set<string>();
  const quote = (text: string) => `${he ? "המדיניות שלנו" : "Our policy"}: “${text}”`;
  const parts = [base];
  if (input.policyQuote && input.outcome.kind !== "knowledge_answer") {
    parts.push(quote(input.policyQuote.text));
    quoted.add(input.policyQuote.text);
  }
  // ASK COMPLETENESS: when the message asked several things, every informational ask gets its grounded
  // representation here — so a reply rebuilt after a guard rejection can never silently drop one.
  const asks = (input.asks ?? []).filter((a) => a.kind !== "other");
  if (asks.length > 1) {
    const answeredInline = input.outcome.kind === "knowledge_answer" ? input.outcome.answer : undefined;
    for (const a of asks) {
      if (a.kind !== "question") continue;
      if (a.answer) {
        if (quoted.has(a.answer.text) || a.answer.text === answeredInline) continue;
        quoted.add(a.answer.text);
        parts.push(quote(a.answer.text));
      } else if (a.status === "not_done") {
        parts.push(he ? `לגבי „${a.ask}”: אין לי מידע מאושר על זה.` : `About “${a.ask}”: I don't have confirmed information on that.`);
      }
    }
  }
  const core = parts.join(" ");
  const text = input.handoff ? `${core} ${handoffText(input.handoff, input.language?.code)}` : core;
  if (!input.notDone?.length) return text;
  // What the customer asked for and was NOT done is always said — partial work is never presented as complete.
  const list = input.notDone.join("; ");
  return input.language?.code === "he" ? `${text} עוד לא טיפלתי ב: ${list}. להמשיך עם זה?` : `${text} Not done yet: ${list}. Want me to go ahead with that?`;
}

function composeDeterministicCore(input: ComposeResponseInput): string {
  if (input.revisionWithoutReplacement) {
    const rest = composeDeterministicCore({ ...input, revisionWithoutReplacement: false });
    const lead =
      input.language?.code === "he"
        ? "ביטלתי את הבקשה הקודמת כי הפרטים השתנו, וכרגע שום דבר לא ממתין לבעל העסק."
        : "I've cancelled the earlier request because the details changed — nothing is waiting on the owner right now.";
    return `${lead} ${rest}`;
  }
  // A blocked write is the whole story of the turn's outcome: nothing was created — say why.
  if (input.writeBlocked) {
    // What really happened before the blocked write this turn (each from its own receipt), then why it wasn't created.
    const before = (input.steps ?? []).map((st) => composeLocalized({ outcome: st.outcome, toolResult: st.toolResult, existingOwnerRequest: st.existingOwnerRequest, language: input.language }));
    return [...before, writeBlockedText(input.writeBlocked, input.language?.code)].join(" ");
  }
  const language = input.language;
  const one = (part: ComposeResponseInput) => composeLocalized({ ...part, language });
  if (input.steps && input.steps.length > 0) {
    // Several things happened: say each in order, then the one thing still needed.
    const parts = input.steps.map((st, i) =>
      one({ outcome: st.outcome, toolResult: st.toolResult, policyReason: st.policyReason, refused: st.refused, existingOwnerRequest: st.existingOwnerRequest, scheduling: i === input.steps!.length - 1 ? input.scheduling : undefined })
    );
    if (input.next) parts.push(one({ outcome: input.next }));
    return parts.join(" ");
  }
  if (input.next) return `${one(input)} ${one({ outcome: input.next })}`;
  return one(input);
}

/**
 * The customer's message could not be understood this turn. Truthful and complete: it wasn't
 * processed, nothing changed or was sent, where things stand (when anything is pending or done), and
 * that a request waiting on the owner is held until the customer confirms it. Never a generic greeting.
 */
export function understandingUnavailableText(lang: string | undefined, opts: { status?: string; held?: boolean } = {}): string {
  const he = lang === "he";
  const lead = he
    ? "סליחה, לא הצלחתי לעבד את ההודעה האחרונה שלך, ולכן לא שיניתי ולא שלחתי שום דבר."
    : "Sorry, I couldn't process your last message, so I haven't changed or sent anything.";
  const held = opts.held
    ? he
      ? "הבקשה שממתינה לבעל העסק מוקפאת עד שתאשר/י לי שהיא עדיין מה שרצית."
      : "The request waiting on the owner is on hold until you confirm it's still what you want."
    : "";
  const ask = he ? "אפשר לשלוח את זה שוב?" : "Could you send that again?";
  return [lead, opts.status ?? "", held, ask].filter(Boolean).join(he ? "\n" : "\n");
}

/** What BARRY may truthfully say about a recorded handoff. */
export function handoffText(h: NonNullable<ComposeResponseInput["handoff"]>, lang: string | undefined): string {
  if (lang === "he") {
    return h.responseCommitted
      ? `העברתי את השיחה לצוות של העסק${h.how ? ` (${h.how})` : ""}.`
      : "העברתי את השיחה לצוות של העסק והם יכולים לראות אותה, אבל אני לא יכול להבטיח מתי או איך יחזרו אליך כאן.";
  }
  return h.responseCommitted
    ? `I've passed this to the business's team${h.how ? ` (${h.how})` : ""}.`
    : "I've passed this to the business's team and they can see this conversation, but I can't promise when or how they'll reply here.";
}

/** An earlier not-understood message, now understood, withdrew/changed a pending request: tell the customer. */
export function revalidatedChangeText(lang: string | undefined, recovered?: { outcome: string }): string {
  const he = lang === "he";
  if (recovered?.outcome === "proposed" || recovered?.outcome === "reused")
    return he
      ? "עכשיו הצלחתי לעבד את ההודעה הקודמת שלך: הבקשה הקודמת הוחלפה ושום דבר ממנה לא בוצע, והבקשה המתוקנת ממתינה לאישור בעל העסק."
      : "I've now been able to process your earlier message: the earlier request was replaced and nothing from it was carried out. Your corrected request is waiting for the owner's approval.";
  if (recovered?.outcome === "not_executed")
    return he
      ? "עכשיו הצלחתי לעבד את ההודעה הקודמת שלך: הבקשה הקודמת בוטלה ושום דבר ממנה לא בוצע. עוד לא ביצעתי את הבקשה המתוקנת — לאשר שאמשיך איתה?"
      : "I've now been able to process your earlier message: the earlier request was cancelled and nothing from it was carried out. I haven't done the corrected request yet — shall I go ahead with it?";
  return he
    ? "עכשיו הצלחתי לעבד את ההודעה הקודמת שלך: הבקשה הקודמת בוטלה כמו שביקשת, ושום דבר ממנה לא בוצע. אם צריך בקשה מתוקנת, כתבו לי את הפרטים."
    : "I've now been able to process your earlier message: the earlier request was cancelled as you asked, and nothing from it was carried out. If you'd like a corrected request, send me the details.";
}

/** The owner approved, but the customer's intent after the request is unverified: ask before doing it. */
export function intentHeldText(lang: string | undefined, about: string, conflicting?: string): string {
  if (lang === "he") {
    return conflicting
      ? `לפני שאני ממשיך עם ${about}: בהודעה מאוחרת יותר כתבת ${conflicting}. זה עדיין נכון, או שצריך לעדכן? עד שתאשר/י, שום דבר לא בוצע.`
      : `לפני שאני ממשיך עם ${about}: לא הצלחתי לעבד הודעה ששלחת אחרי הבקשה. זה עדיין מה שרצית? עד שתאשר/י, שום דבר לא בוצע.`;
  }
  return conflicting
    ? `Before I go ahead with ${about}: a later message of yours mentioned ${conflicting}. Is the request still right as it is, or should it change? Nothing has been done yet.`
    : `Before I go ahead with ${about}: I couldn't process a message you sent after that request. Is it still what you want? Nothing has been done yet.`;
}

/**
 * A policy refusal, in the conversation's language. The rule behind it is the business's internal
 * reasoning (it stays in the trace for the owner) — the customer hears what it means for them.
 */
export function deniedText(language?: { code: string }): string {
  return language?.code === "he"
    ? "את זה אני לא יכול לעשות מכאן. אם צריך, הצוות יוכל לעזור בזה."
    : "That's not something I can do from here — the team can help with it if you need.";
}

/**
 * A tool error the customer may hear: short plain words only ("sold out", "slot already taken").
 * Anything shaped like an identifier, code, path or stack trace stays internal.
 */
function customerSafeError(error: string | undefined): string | undefined {
  const e = error?.trim();
  if (!e || e.length > 60) return undefined;
  return /^[\p{L}\p{N} ,'’-]+$/u.test(e) && !/[a-z][A-Z]|_/.test(e) ? e : undefined;
}

/** BARRY asked the owner (never quoting the rule that required it). The resume path makes the promise true. */
function approvalRequestedText(lang: string | undefined): string {
  return lang === "he"
    ? "בודק את זה מול בעל העסק ואחזור אליך כאן ברגע שיש תשובה."
    : "I'm checking that with the owner — I'll update you here as soon as I hear back.";
}

function ownerDeclinedText(lang: string | undefined): string {
  return lang === "he"
    ? "בדקתי עם בעל העסק, ולצערי את זה לא נוכל לעשות. אפשר לעזור במשהו אחר?"
    : "I checked with the owner and unfortunately we can't do that one. Anything else I can help with?";
}

/** Why a payment/checkout was NOT created — with the real numbers; nothing was sent or charged. */
export function writeBlockedText(b: NonNullable<ComposeResponseInput["writeBlocked"]>, lang: string | undefined): string {
  const amt = (n: number | undefined) => (n === undefined ? "" : money(n, b.currency, lang === "he" ? "he" : "en"));
  if (lang === "he") {
    if (b.reason === "stale_cart") return `לא יצרתי קישור לתשלום: לא הצלחתי לאמת את המצב העדכני של העגלה. לא נשלח ולא חויב שום דבר — נסו שוב בעוד רגע.`;
    if (b.reason === "over_budget") return `לא יצרתי קישור לתשלום: הסכום יוצא ${amt(b.total)}, מעל התקרה שלך של ${amt(b.cap)}. לא נשלח ולא חויב שום דבר.`;
    if (b.reason === "shipping_unknown") return `לא יצרתי קישור לתשלום: עלות המשלוח לא ידועה לי, אז אני לא יכול להבטיח שהסכום הכולל יישאר עד ${amt(b.cap)}. לא נשלח ולא חויב שום דבר.`;
    return `לא יצרתי קישור לתשלום: בסל יש גם ${b.extraItems?.join(", ")}, שלא אישרת לקנות. להסיר אותם קודם?`;
  }
  if (b.reason === "stale_cart") return `I haven't created a payment link: I couldn't confirm your cart's current state. Nothing was sent or charged — please try again in a moment.`;
  if (b.reason === "over_budget") return `I haven't created a payment link: the total comes to ${amt(b.total)}, above your ${amt(b.cap)} limit. Nothing was sent or charged.`;
  if (b.reason === "shipping_unknown") return `I haven't created a payment link: I don't know the shipping cost, so I can't guarantee the total stays within ${amt(b.cap)}. Nothing was sent or charged.`;
  return `I haven't created a payment link: your cart also has ${b.extraItems?.join(", ")}, which you didn't ask to buy. Want me to remove those first?`;
}

/** The real status of a request sent to the owner, from BARRY's records. */
export function ownerRequestStatusText(r: OwnerRequestView, lang: string | undefined): string {
  const ref = r.reference ? (lang === "he" ? ` (אסמכתא ${r.reference})` : ` (reference ${r.reference})`) : "";
  if (lang === "he") {
    if (r.status === "waiting_on_owner") return "זה עדיין אצל בעל העסק — אעדכן אותך כאן ברגע שתהיה תשובה.";
    if (r.status === "declined_by_owner") return "בעל העסק לא אישר את זה.";
    if (r.status === "withdrawn_by_customer") return "הבקשה בוטלה לפי בקשתך, אז שום דבר לא יתבצע.";
    if (r.result === "failed") return "בעל העסק אישר, אבל הביצוע לא עבר. הצוות יוכל לבדוק את זה.";
    if (r.result === "done_unconfirmed") return `בעל העסק אישר והבקשה הוגשה, אבל עדיין אין אישור שהיא בוצעה${ref}.`;
    return `בעל העסק אישר וזה בוצע${ref}.`;
  }
  if (r.status === "waiting_on_owner") return "That's still with the owner — I'll update you here as soon as I hear back.";
  if (r.status === "declined_by_owner") return "The owner didn't approve that one.";
  if (r.status === "withdrawn_by_customer") return "That request was withdrawn as you asked, so nothing will go ahead with it.";
  if (r.result === "failed") return "The owner approved it, but carrying it out didn't go through — the team can look into it.";
  if (r.result === "done_unconfirmed") return `The owner approved it and it was submitted, but it isn't confirmed yet${ref}.`;
  return `The owner approved it and it's done${ref}.`;
}

/** The conversation's language when BARRY has strings for it; otherwise English. */
function composeLocalized(input: ComposeResponseInput): string {
  const lang = input.language?.code;
  if (input.writeBlocked) return writeBlockedText(input.writeBlocked, lang);
  if (input.refused) return deniedText(input.language);
  if (input.policyReason) return approvalRequestedText(lang);
  if (input.existingOwnerRequest === "still_pending") {
    return lang === "he" ? "זה עדיין אצל בעל העסק — אעדכן אותך כאן ברגע שתהיה תשובה." : "That's still with the owner — I'll update you here as soon as I hear back.";
  }
  if (input.existingOwnerRequest === "declined_earlier") {
    return lang === "he"
      ? "בעל העסק כבר השיב שלילית על זה, אז לא שלחתי את זה שוב. אפשר לעזור במשהו אחר?"
      : "The owner already said no to that one, so I haven't sent it again. Anything else I can do?";
  }
  if (input.ownerDecision === "declined") return ownerDeclinedText(lang);
  if (input.ownerDecision === "approved") {
    const rest = composeLocalized({ ...input, ownerDecision: undefined });
    return lang === "he" ? `בעל העסק אישר. ${rest}` : `Good news — the owner approved it. ${rest}`;
  }
  if (input.outcome.kind === "withdrawn") {
    const n = input.outcome.withdrawnRequests;
    return lang === "he"
      ? `בסדר, עצרתי כאן — לא אשלח שום דבר נוסף.${n ? " ביטלתי גם את הבקשה שחיכתה לבעל העסק." : ""}`
      : `Okay, I've stopped here — nothing more will be sent.${n ? " I also withdrew the request that was waiting on the owner." : ""}`;
  }
  if (input.outcome.kind === "conversation") {
    if (input.statusText) return input.statusText;
    // Several requests: each answered from its own record (terms, lifecycle, reference) — never just the latest.
    if ((input.ownerRequests?.length ?? 0) > 1) return requestsText(input.ownerRequests!, lang);
    const latest = input.ownerRequests?.at(-1);
    if (latest) return ownerRequestStatusText(latest, lang);
    return lang === "he" ? "סליחה, לא הצלחתי לנסח תשובה כרגע — אפשר לשאול שוב?" : "Sorry — I couldn't put that answer together just now. Could you ask me again?";
  }
  if (lang === "he") {
    const he = composeHebrew(input);
    if (he !== undefined) return he;
  }
  return composeSingle(input);
}

const optionLabel = (o: Record<string, string>) => Object.values(o).join(" / ");

/** Hebrew for the operator-critical path (selection, cart, checkout, details, payment, order). */
type GenericCall = { ok: boolean; executed: boolean; verified: boolean; code?: string; output?: Record<string, unknown> };

/** Words from an identifier-shaped key or value ("in_transit" -> "in transit", "trackingNumber" -> "tracking number"). */
const words = (s: string) => s.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** A capability result's facts, as plain "field: value" pairs in words — whatever the capability is. */
function capabilityFacts(output: Record<string, unknown> | undefined): string {
  return Object.entries(output ?? {})
    .filter(([k, v]) => k !== "verified" && v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${words(k)}: ${typeof v === "string" && /^[a-z]+(?:_[a-z]+)+$/.test(v) ? words(v) : String(v)}`)
    .join(", ");
}

function genericCall(toolResult: ComposeResponseInput["toolResult"]): GenericCall | undefined {
  if (!toolResult) return undefined;
  return (toolResult.ok ? toolResult.output : (toolResult as { capability?: unknown }).capability) as GenericCall | undefined;
}

function genericText(toolResult: ComposeResponseInput["toolResult"], lang: "he" | "en"): string {
  const call = genericCall(toolResult);
  const facts = capabilityFacts(call?.output);
  if (call?.ok && call.executed) {
    if (lang === "he") return call.verified ? `בוצע${facts ? ` — ${facts}` : ""}.` : `הנה מה שמצאתי${facts ? `: ${facts}` : ""}.`;
    return call.verified ? `Done${facts ? ` — ${facts}` : ""}.` : `Here's the latest${facts ? ` — ${facts}` : ""}.`;
  }
  const code = call?.code;
  if (lang === "he") {
    if (code === "not_authorized") return "את זה אני לא יכול לעשות מכאן. אם צריך, הצוות יוכל לעזור בזה.";
    if (code === "unverified") return "לא קיבלתי אישור שזה עבר, אז אני לא אגיד שזה בוצע. הצוות יוכל לבדוק את זה.";
    return "אני לא מצליח להגיע לזה כרגע. אפשר לנסות שוב עוד מעט, או שהצוות יעזור.";
  }
  if (code === "not_authorized") return "That's not something I can do from here — the team can help with it if you need.";
  if (code === "unverified") return "I couldn't confirm that went through, so I won't say it's done yet — the team can check it for you.";
  return "I can't get to that right now — try again in a bit, or the team can help.";
}

function composeHebrew(input: ComposeResponseInput): string | undefined {
  const { outcome, toolResult, scheduling } = input;
  switch (outcome.kind) {
    case "ask_general":
      return outcome.offerNames.length ? `במה אפשר לעזור? יש לנו ${outcome.offerNames.join(", ")}.` : `במה אפשר לעזור?`;
    case "clarify_offer":
      return `בשמחה — מדובר על ${outcome.offerNames.join(" או ")}?`;
    case "knowledge_answer":
      return outcome.answer;
    case "ask_datetime":
      return `מתי נוח לך לקבוע ${outcome.offerName}?`;
    case "ask_slot_confirm":
      return scheduling?.offeredSlot ? `${scheduling.offeredSlot.localDate} ב-${scheduling.offeredSlot.localTime} מתאים?` : `השעה הזו מתאימה?`;
    case "waiting_payment":
      return `מחכה רק לתשלום כדי לאשר.`;
    case "offer_fact":
      switch (outcome.fact.type) {
        case "price":
          return `${outcome.offerName}: ${money(outcome.fact.price, outcome.fact.currency, "he")}.`;
        case "duration":
          return `${outcome.offerName} לוקח בערך ${outcome.fact.minutes} דקות.`;
        case "deposit":
          return outcome.fact.required
            ? `כן, ל${outcome.offerName} צריך מקדמה${outcome.fact.amount ? ` של ${money(outcome.fact.amount, outcome.fact.currency, "he")}` : ""}.`
            : `ל${outcome.offerName} לא צריך מקדמה.`;
      }
      return undefined;
    case "generic_confirm":
      if (input.statusText) return input.statusText;
      return outcome.stage === "closed" ? `הכול מסודר — זה כבר מאושר.` : `מסדר את זה עכשיו.`;
    case "compiler_error":
      return `סליחה, לא הבנתי עד הסוף — אפשר לפרט קצת?`;
    case "ask_variant": {
      const options = [...new Set(outcome.availableOptions.map(optionLabel))];
      const asked = outcome.requested && Object.keys(outcome.requested).length ? optionLabel(outcome.requested) : undefined;
      if (options.length === 0) return `${outcome.productTitle} לא זמינה כרגע${asked ? ` ב-${asked}` : ""}.`;
      return asked ? `${outcome.productTitle} לא זמינה ב-${asked}. זמין: ${options.join(", ")}. מה מתאים לך?` : `איזו אפשרות של ${outcome.productTitle}? זמין: ${options.join(", ")}.`;
    }
    case "needs_info":
      return `מעולה — ${outcome.offerName}. אפשר ${formatMissingFieldsList(outcome.missingFields, "he")}?`;
    case "checkout_needs_info":
      return `כדי לשלוח קישור מאובטח לתשלום, אפשר ${formatMissingFieldsList(outcome.missingFields, "he")}?`;
    case "confirm_purchase":
      return `לשלוח לך קישור מאובטח לתשלום עבור ${outcome.offerName}?`;
    case "clarify_reference":
      return outcome.available > 0 ? `לאיזה מהם התכוונת? הצגתי ${outcome.available} אפשרויות.` : `מה מחפשים? אחפש בקטלוג.`;
    case "cart_subject_unresolved": {
      const inCart = outcome.inCart.length ? outcome.inCart.join(", ") : "כלום";
      if (outcome.reason === "not_in_cart") return `„${outcome.subject}” לא נמצא כרגע בעגלה — בעגלה יש: ${inCart}. לא שיניתי כלום.`;
      if (outcome.reason === "unreadable") return `לא הצלחתי לקרוא את העגלה כרגע, אז לא שיניתי כלום. נסו שוב בעוד רגע.`;
      return `לא ברור לי לאיזה פריט בעגלה התכוונת (${inCart}), אז לא שיניתי כלום. איזה מהם?`;
    }
    case "capability_unavailable":
      return `את השלב הזה אני עוד לא יכול להשלים כאן — רשמתי את הבחירה שלך והצוות יחזור אליך כדי לסיים.`;
    case "no_payment_to_verify":
      return `אני לא רואה בקשת תשלום פתוחה בשיחה הזו, אז אין עדיין מה לאמת.`;
    case "price_request":
      return outcome.current
        ? `הסכום הנוכחי הוא ${money(outcome.current.amount, outcome.current.currency, "he")}. אני לא יכול לשנות מחירים בעצמי.`
        : `אני לא יכול לשנות מחירים בעצמי — זה המחיר שאני יכול להציע.`;
    case "product_info": {
      const inStock = outcome.variants.filter((v) => v.inStock);
      if (outcome.asked && Object.keys(outcome.asked).length > 0) {
        const hit = outcome.variants.find(
          (v) => v.inStock && Object.entries(outcome.asked!).every(([k, val]) => Object.entries(v.options).some(([ok, ov]) => ok.toLowerCase() === k.toLowerCase() && ov.toLowerCase() === val.toLowerCase()))
        );
        if (hit) return `כן — ${outcome.productTitle} במלאי במידה ${optionLabel(outcome.asked)} (${hit.price}).`;
        return `${outcome.productTitle} לא זמינה כרגע ב-${optionLabel(outcome.asked)}.${inStock.length ? ` במלאי: ${inStock.map((v) => optionLabel(v.options)).join(", ")}.` : ""}`;
      }
      return inStock.length ? `${outcome.productTitle} במלאי ב-${inStock.map((v) => `${optionLabel(v.options)} (${v.price})`).join(", ")}.` : `${outcome.productTitle} אזלה מהמלאי כרגע.`;
    }
    case "capability_needs_input":
      return `בשביל זה אצטרך ${formatMissingFieldsList(outcome.missingFields, "he")}.`;
    case "action": {
      if (!toolResult) return undefined;
      if (outcome.action.name === "invokeCapability") return genericText(toolResult, "he");
      if (!toolResult.ok) {
        const why = customerSafeError(toolResult.error);
        return `סליחה, זה לא עבר אצלנו${why ? ` (${why})` : ""}. ננסה אפשרות אחרת?`;
      }
      const output = toolResult.output as Record<string, unknown>;
      switch (outcome.action.name) {
        case "checkAvailability": {
          if ((output as { slots: unknown[] }).slots.length === 0) return `לא מצאתי שעות פנויות בטווח הזה — לנסות יום או שעה אחרים?`;
          const slot = scheduling?.availableSlots?.[0];
          return slot ? `${slot.localDate} ב-${slot.localTime} פנוי — מתאים?` : `מצאתי שעה פנויה — מתאים?`;
        }
        case "checkInventory":
          return (output as { quantityAvailable: number }).quantityAvailable > 0 ? `יש במלאי. להמשיך לתשלום?` : `זה אזל כרגע מהמלאי — לבחור משהו אחר?`;
        case "createPaymentRequest":
          return `הנה קישור מאובטח לתשלום — ברגע שהתשלום יאומת, אאשר הכול.`;
        case "createBooking":
          return `קבענו! התור מאושר (${(output as { bookingId: string }).bookingId}). נתראה.`;
        case "fulfillOrder":
          return `ההזמנה שלך (${(output as { orderId: string }).orderId}) מאושרת — תודה!`;
        case "createLead":
          return `תודה — רשמתי את הפנייה שלך עבור הצוות.`;
        case "createFollowUp":
          return `אין בעיה, אחזור אליך בקרוב.`;
        case "addToCart":
        case "updateCartLine": {
          const o = output as {
            added: boolean;
            cart?: { lines: { id: string; title: string; options: Record<string, string> }[]; total: { amount: number; currency: string } };
            lineId?: string;
            replacedLineId?: string;
            notAdded?: { productTitle: string; requested?: Record<string, string>; availableOptions: Record<string, string>[] };
          };
          if (!o.added && o.notAdded) {
            const options = [...new Set(o.notAdded.availableOptions.map(optionLabel))];
            const asked = o.notAdded.requested && Object.keys(o.notAdded.requested).length ? optionLabel(o.notAdded.requested) : undefined;
            if (options.length === 0) return `${o.notAdded.productTitle} לא זמינה כרגע${asked ? ` ב-${asked}` : ""}.`;
            return asked
              ? `${o.notAdded.productTitle} לא זמינה ב-${asked}. זמין: ${options.join(", ")}. מה מתאים לך?`
              : `איזו אפשרות של ${o.notAdded.productTitle}? זמין: ${options.join(", ")}.`;
          }
          if (!o.cart) return "בוצע.";
          const line = o.cart.lines.find((l) => l.id === o.lineId);
          const what = line ? `${line.title}${Object.keys(line.options).length ? ` (${optionLabel(line.options)})` : ""}` : "הפריט";
          const total = `סה״כ בעגלה: ${money(o.cart.total.amount, o.cart.total.currency, "he")}.`;
          if (outcome.action.name === "addToCart") return o.replacedLineId ? `החלפתי ל-${what}. ${total}` : `שמתי לך בעגלה את ${what}. ${total}`;
          return line ? `עדכנתי: ${what}. ${total}` : `הסרתי את הפריט מהעגלה. ${total}`;
        }
        case "createCommerceCheckout": {
          const o = output as { checkoutUrl?: string; amount: { amount: number; currency: string } };
          return o.checkoutUrl
            ? `העגלה מוכנה: ${money(o.amount.amount, o.amount.currency, "he")}. הנה קישור מאובטח לתשלום — ההזמנה תיווצר רק אחרי שספק התשלומים יאשר את התשלום.`
            : `העגלה מוכנה: ${money(o.amount.amount, o.amount.currency, "he")}. ההזמנה תיווצר רק אחרי שספק התשלומים יאשר את התשלום.`;
        }
        case "verifyPayment": {
          const status = (output as { status: string }).status;
          return status === "paid"
            ? `התשלום אומת.`
            : status === "pending"
              ? `בדקתי מול ספק התשלומים — התשלום עוד לא התקבל. ברגע שיאושר שם, אסיים את ההזמנה.`
              : `ספק התשלומים מדווח שהתשלום לא עבר. לנסות שוב?`;
        }
        case "createCommerceOrder":
          return `התשלום אומת וההזמנה שלך אושרה (${(output as { orderId: string }).orderId}).`;
        case "searchProducts": {
          const o = output as { products: { title: string; variants: { price: { amount: number; currency: string }; options: Record<string, string>; inventory: { available: number } }[] }[]; requestedOptions?: Record<string, string> };
          if (o.products.length === 0) return `לא מצאתי התאמה בקטלוג. רוצה לשנות משהו בחיפוש?`;
          const wanted = o.requestedOptions ?? {};
          const lines = o.products.slice(0, 3).map((product, index) => {
            const matching = product.variants.filter((v) => Object.entries(wanted).every(([k, val]) => v.options[k]?.toLowerCase() === val.toLowerCase()));
            const variant = matching.find((v) => v.inventory.available > 0) ?? matching[0] ?? product.variants[0];
            const stock = Object.keys(wanted).length ? ` (${optionLabel(wanted)}${matching.some((v) => v.inventory.available > 0) ? " במלאי" : " לא במלאי"})` : "";
            return `${index + 1}. ${product.title} - ${variant ? money(variant.price.amount, variant.price.currency, "he") : "מחיר לא זמין"}${stock}`;
          });
          return `הנה מה שמצאתי:\n${lines.join("\n")}`;
        }
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

function composeSingle(input: ComposeResponseInput): string {
  const { outcome, toolResult, scheduling } = input;

  switch (outcome.kind) {
    case "ask_general":
      return outcome.offerNames.length ? `What can I help you with? We offer ${outcome.offerNames.join(", ")}.` : `What can I help you with?`;
    case "clarify_offer":
      return `Sure — is that for ${outcome.offerNames.join(" or ")}?`;
    case "knowledge_answer":
      return outcome.answer;
    case "needs_info":
      return `Great choice — ${outcome.offerName}. Could you share your ${formatMissingFieldsList(outcome.missingFields, "en")}?`;
    case "ask_datetime":
      return `When would you like to come in for your ${outcome.offerName}?`;
    case "ask_slot_confirm":
      // Never interpret outcome.offeredStart (a raw UTC ISO string)
      // directly — it must always be rendered in the business's own
      // local timezone, via the display facts the runtime computed
      // deterministically before calling composeResponse.
      return scheduling?.offeredSlot
        ? `Does ${scheduling.offeredSlot.localDate} at ${scheduling.offeredSlot.localTime} work for you?`
        : `Does that time work for you?`;
    case "waiting_payment":
      return `Just waiting on your payment to confirm this.`;
    case "offer_fact":
      switch (outcome.fact.type) {
        case "price":
          return `${outcome.offerName} is ${money(outcome.fact.price, outcome.fact.currency)}.`;
        case "duration":
          return `${outcome.offerName} takes about ${outcome.fact.minutes} minutes.`;
        case "deposit":
          return outcome.fact.required
            ? `Yes, ${outcome.offerName} requires a deposit${outcome.fact.amount ? ` of ${money(outcome.fact.amount, outcome.fact.currency)}` : ""}.`
            : `No deposit is required for ${outcome.offerName}.`;
      }
    case "generic_confirm":
      // A guard-repaired reply states the real records instead of a generic "confirmed".
      if (input.statusText) return input.statusText;
      // stage "closed" means this is a duplicate-webhook/replayed-message
      // guard (compileCore already completed this transaction earlier) —
      // never claim to be "finalizing" something that's already done.
      return outcome.stage === "closed"
        ? `You're all set — that's already confirmed.`
        : `Let me get that finalized for you.`;
    case "compiler_error":
      return `Sorry, I didn't quite get that — could you tell me a bit more?`;
    case "clarify_reference":
      return outcome.available > 0
        ? `Which one did you mean? I showed you ${outcome.available} option${outcome.available === 1 ? "" : "s"}.`
        : `What are you looking for? I'll search the catalog for you.`;
    case "cart_subject_unresolved": {
      const inCart = outcome.inCart.length ? outcome.inCart.join(", ") : "nothing";
      if (outcome.reason === "not_in_cart") return `“${outcome.subject}” isn't in your cart right now — your cart has: ${inCart}. I didn't change anything.`;
      if (outcome.reason === "unreadable") return `I couldn't read your cart just now, so I didn't change anything. Please try again in a moment.`;
      return `I'm not sure which item in your cart you meant (${inCart}), so I didn't change anything. Which one?`;
    }
    case "ask_variant":
      return askVariantText(outcome.productTitle, outcome.requested, outcome.availableOptions);
    case "price_request":
      return outcome.current
        ? `The current total is ${money(outcome.current.amount, outcome.current.currency)}. I can't change prices myself.`
        : `I can't change prices myself — the listed price is what I can offer.`;
    case "product_info": {
      const label = (o: Record<string, string>) => Object.values(o).join(" / ");
      const matches = (o: Record<string, string>) =>
        Object.entries(outcome.asked ?? {}).every(([k, v]) => Object.entries(o).some(([ok, ov]) => ok.toLowerCase() === k.toLowerCase() && ov.toLowerCase() === v.toLowerCase()));
      const inStock = outcome.variants.filter((v) => v.inStock);
      if (outcome.asked && Object.keys(outcome.asked).length > 0) {
        const hit = outcome.variants.find((v) => matches(v.options) && v.inStock);
        if (hit) return `Yes — ${outcome.productTitle} is in stock in ${label(outcome.asked)} (${hit.price}).`;
        return `${outcome.productTitle} isn't available in ${label(outcome.asked)} right now.${inStock.length ? ` In stock: ${inStock.map((v) => label(v.options)).join(", ")}.` : ""}`;
      }
      return inStock.length
        ? `${outcome.productTitle} is in stock in ${inStock.map((v) => `${label(v.options)} (${v.price})`).join(", ")}.`
        : `${outcome.productTitle} is currently out of stock.`;
    }
    case "confirm_purchase":
      return `Shall I send you a secure payment link for the ${outcome.offerName}?`;
    case "checkout_needs_info":
      return `To send you a secure payment link, could you share your ${formatMissingFieldsList(outcome.missingFields, "en")}?`;
    case "capability_unavailable":
      return `I can't complete that step here yet — I've noted your choice and the team will follow up to finish it with you.`;
    case "no_payment_to_verify":
      return `I don't see an open payment request for this conversation yet, so there's nothing for me to verify.`;
    case "capability_needs_input":
      return `Sure — what's your ${formatMissingFieldsList(outcome.missingFields, "en")}?`;
    case "action": {
      if (!toolResult) return "Got it.";
      if (outcome.action.name === "invokeCapability") return genericText(toolResult, "en");
      if (!toolResult.ok) {
        const why = customerSafeError(toolResult.error);
        return `Sorry — that didn't go through${why ? ` (${why})` : " on our side"}. Want to try a different option?`;
      }
      switch (outcome.action.name) {
        case "checkAvailability": {
          const output = toolResult.output as { slots: { resourceId: string; start: string; end: string }[] };
          if (output.slots.length === 0) {
            return `I don't see any open slots in that window — want to try another day or time?`;
          }
          // Never interpret a raw UTC ISO string directly — always the
          // business-local display fact the runtime already computed.
          const slot = scheduling?.availableSlots?.[0];
          return slot
            ? `${slot.localDate} at ${slot.localTime} is available — does that work for you?`
            : `I found an available time — does that work for you?`;
        }
        case "checkInventory": {
          const output = toolResult.output as { quantityAvailable: number };
          return output.quantityAvailable > 0
            ? `Good news — that's in stock. Ready to go ahead with payment?`
            : `That item is out of stock right now — want me to notify you when it's back, or pick something else?`;
        }
        case "createPaymentRequest": {
          // The link itself is delivered in the channel's rich payload; its internal id is never shown.
          return `Here's your secure payment link — once the payment is verified, I'll confirm everything.`;
        }
        case "searchProducts": {
          const output = toolResult.output as {
            products: {
              title: string;
              variants: { price: { amount: number; currency: string }; options: Record<string, string>; inventory: { available: number } }[];
            }[];
            requestedOptions?: Record<string, string>;
          };
          if (output.products.length === 0) {
            return `I couldn't find a match in the catalog for that. Want to adjust what you're looking for?`;
          }
          const wanted = output.requestedOptions ?? {};
          const lines = output.products.slice(0, 3).map((product, index) => {
            const matching = product.variants.filter((v) =>
              Object.entries(wanted).every(([k, val]) => v.options[k]?.toLowerCase() === val.toLowerCase())
            );
            const variant = matching.find((v) => v.inventory.available > 0) ?? matching[0] ?? product.variants[0];
            const label = Object.keys(wanted).length ? ` (${Object.values(wanted).join(" / ")}${matching.some((v) => v.inventory.available > 0) ? " in stock" : " out of stock"})` : "";
            const price = variant ? money(variant.price.amount, variant.price.currency) : "price unavailable";
            return `${index + 1}. ${product.title} - ${price}${label}`;
          });
          return `Here's what I found:\n${lines.join("\n")}`;
        }
        case "verifyPayment": {
          const output = toolResult.output as { status: string };
          return output.status === "paid"
            ? `Your payment is verified.`
            : output.status === "pending"
              ? `I checked with the payment provider and the payment hasn't come through yet. Once it's confirmed there, I'll finalize everything.`
              : `The payment provider reports that payment didn't go through. Want to try again?`;
        }
        case "addToCart":
        case "updateCartLine": {
          const output = toolResult.output as {
            added: boolean;
            cart?: { lines: { id: string; title: string; options: Record<string, string> }[]; total: { amount: number; currency: string } };
            lineId?: string;
            notAdded?: { productTitle: string; requested?: Record<string, string>; availableOptions: Record<string, string>[] };
          };
          if (!output.added && output.notAdded) {
            return askVariantText(output.notAdded.productTitle, output.notAdded.requested, output.notAdded.availableOptions);
          }
          const line = output.cart?.lines.find((l) => l.id === output.lineId);
          const what = line ? `${line.title}${Object.keys(line.options).length ? ` (${Object.values(line.options).join(" / ")})` : ""}` : "your cart";
          if (!output.cart) return "Done.";
          const total = `Cart total is ${money(output.cart.total.amount, output.cart.total.currency)}.`;
          if (outcome.action.name === "addToCart") {
            return (output as { replacedLineId?: string }).replacedLineId
              ? `Swapped your item for ${what}. ${total}`
              : `Added ${what} to your cart. ${total}`;
          }
          return line ? `Updated your cart: ${what}. ${total}` : `Removed the item from your cart. ${total}`;
        }
        case "createCommerceCheckout": {
          const output = toolResult.output as { checkoutUrl?: string; amount: { amount: number; currency: string } };
          return output.checkoutUrl
            ? `Your cart is ready: ${money(output.amount.amount, output.amount.currency)}. Use the secure payment link below — I'll create the order only after the payment provider confirms it.`
            : `Your cart is ready: ${money(output.amount.amount, output.amount.currency)}. I'll create the order only after the payment provider confirms payment.`;
        }
        case "createCommerceOrder": {
          const output = toolResult.output as { orderId: string };
          return `Payment verified and your order is confirmed (${output.orderId}).`;
        }
        case "createBooking": {
          const output = toolResult.output as { bookingId: string };
          return `You're all set! Booking confirmed (${output.bookingId}). See you then.`;
        }
        case "fulfillOrder": {
          const output = toolResult.output as { orderId: string };
          return `Your order (${output.orderId}) is confirmed — thanks for shopping with us!`;
        }
        case "createLead":
          return `Thanks — I've recorded your enquiry for the team.`;
        case "createFollowUp":
          return `No problem, I'll follow up with you soon.`;
        default:
          return "Done!";
      }
    }
    default:
      return "Got it.";
  }
}

