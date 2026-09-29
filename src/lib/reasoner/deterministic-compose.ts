import type { ComposeResponseInput } from "./types";
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
  const language = input.language;
  const one = (part: ComposeResponseInput) => composeLocalized({ ...part, language });
  if (input.steps && input.steps.length > 0) {
    // Several things happened: say each in order, then the one thing still needed.
    const parts = input.steps.map((st, i) =>
      one({ outcome: st.outcome, toolResult: st.toolResult, policyReason: st.policyReason, scheduling: i === input.steps!.length - 1 ? input.scheduling : undefined })
    );
    if (input.next) parts.push(one({ outcome: input.next }));
    return parts.join(" ");
  }
  if (input.next) return `${one(input)} ${one({ outcome: input.next })}`;
  return one(input);
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

/** The conversation's language when BARRY has strings for it; otherwise English. */
function composeLocalized(input: ComposeResponseInput): string {
  const lang = input.language?.code;
  if (input.refused) return deniedText(input.language);
  if (input.policyReason) return approvalRequestedText(lang);
  if (input.ownerDecision === "declined") return ownerDeclinedText(lang);
  if (input.ownerDecision === "approved") {
    const rest = composeLocalized({ ...input, ownerDecision: undefined });
    return lang === "he" ? `בעל העסק אישר. ${rest}` : `Good news — the owner approved it. ${rest}`;
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
          return `תודה על הפרטים — העברתי את זה ונחזור אליך עם הצעה.`;
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
          return `Thanks for the details — I've passed this along and we'll follow up with a quote shortly.`;
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

