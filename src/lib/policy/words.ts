import type { Policy } from "@/lib/business-graph";
import { L, amount, number, type OwnerLang } from "@/lib/owner/lang";

/**
 * THE ONE WORDING OF A POLICY RULE (pure). Every surface that describes a policy — Rules BARRY follows,
 * What BARRY knows, the Genome view — says what the RULE VALUE means, never the free-text description
 * stored next to it (a description can be stale: a profile once read "No bookings" over a rule that
 * allowed bookings). Limits are compared in each order's own currency, so a currency is named only when
 * the business's offers state one.
 */
export type PolicyWords = { title: string; summary: string; words: string };

export function policyWords(rule: Policy["rule"], currency: string | null, lang: OwnerLang = "en"): PolicyWords {
  const T = (en: string, he: string) => L(lang, en, he);
  const cash = (v: number) => (currency ? amount(lang, v, currency) : T(`${number(lang, v)} (in the order's currency)`, `${number(lang, v)} (במטבע של ההזמנה)`));
  switch (rule.type) {
    case "max_auto_discount_pct":
      return rule.value === 0
        ? { title: T("Discounts", "הנחות"), summary: T("None without asking you", "אף הנחה בלי לשאול אותך"), words: T("BARRY gives no discount on its own. Every discount needs your approval.", "BARRY לא נותן הנחה לבד. כל הנחה דורשת את האישור שלך.") }
        : { title: T("Discounts", "הנחות"), summary: T(`Up to ${rule.value}% without asking`, `עד ${rule.value}% בלי לשאול`), words: T(`BARRY may offer up to ${rule.value}% without asking you. More than ${rule.value}% needs your approval.`, `BARRY רשאי לתת עד ${rule.value}% הנחה בלי לשאול אותך. מעבר לזה — רק באישורך.`) };
    case "max_auto_payment_amount":
      return { title: T("Payment links", "קישורי תשלום"), summary: T(`Up to ${cash(rule.value)} on their own`, `עד ${cash(rule.value)} בלי אישור`), words: T(`Payment requests up to ${cash(rule.value)} go out on their own; above that, you approve.`, `בקשות תשלום עד ${cash(rule.value)} נשלחות לבד; מעל זה — רק באישורך.`) };
    case "refund_requires_approval":
      return rule.value
        ? { title: T("Refunds", "החזרים כספיים"), summary: T("Always with your approval", "תמיד באישורך"), words: T("Refunds always need your approval.", "כל החזר כספי דורש את האישור שלך.") }
        : { title: T("Refunds", "החזרים כספיים"), summary: T("Without your approval", "בלי אישור"), words: T("Refunds don't need your approval.", "החזרים כספיים לא דורשים את האישור שלך.") };
    case "bookings_auto_allowed":
      return rule.value
        ? { title: T("Bookings", "תורים"), summary: T("Allowed on its own", "מותר לבד"), words: T("BARRY is allowed to book appointments on its own.", "BARRY רשאי לקבוע תורים לבד.") }
        : { title: T("Bookings", "תורים"), summary: T("Only with your approval", "רק באישורך"), words: T("Every booking needs your approval.", "כל תור דורש את האישור שלך.") };
    case "custom_pricing_requires_approval":
      return rule.value
        ? { title: T("Prices", "מחירים"), summary: T("Changes need your approval", "שינוי — רק באישורך"), words: T("Any price change needs your approval.", "כל שינוי מחיר דורש את האישור שלך.") }
        : { title: T("Prices", "מחירים"), summary: T("May adjust within your rules", "רשאי להתאים לפי הכללים"), words: T("BARRY may adjust prices within your rules.", "BARRY רשאי להתאים מחירים בתוך הכללים שלך.") };
    case "free_shipping_over":
      return { title: T("Delivery", "משלוחים"), summary: T(`Free above ${cash(rule.value)}`, `חינם מעל ${cash(rule.value)}`), words: T(`Free delivery above ${cash(rule.value)}.`, `משלוח חינם בהזמנה מעל ${cash(rule.value)}.`) };
    case "flat_shipping_fee":
      return { title: T("Delivery", "משלוחים"), summary: T(`${cash(rule.value)} per order`, `${cash(rule.value)} להזמנה`), words: T(`Delivery costs ${cash(rule.value)}.`, `משלוח עולה ${cash(rule.value)}.`) };
  }
}
