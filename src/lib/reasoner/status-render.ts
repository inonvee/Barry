import type { OwnerRequestView } from "./types";
import type { Quote } from "@/lib/runtime/pricing";
import type { LedgerEntry } from "@/lib/runtime/ledger";
import { money } from "./deterministic-compose";

/**
 * Task-specific deterministic rendering of WHERE THINGS STAND, from BARRY's records only:
 * each owner request with its own frozen terms and lifecycle, confirmed bookings/orders/payments
 * from the effect ledger, and the authoritative quote. Used when a model reply can't be grounded —
 * a plain but correct and complete answer ("nothing is booked", "nothing is pending", the right total).
 */

type Lang = "he" | "en";

const termsLabel = (t: Record<string, string | number>) =>
  Object.entries(t)
    .filter(([k]) => !/^(reason|currency|discountPct|isCustomPrice|shipping|purpose)$/.test(k))
    .map(([, v]) => String(v))
    .join(", ");

function requestLine(r: OwnerRequestView, lang: Lang): string {
  const what = `${r.about.replace(/\s*\(.*\)$/, "")}${termsLabel(r.terms) ? ` (${termsLabel(r.terms)})` : ""}`;
  const ref = r.reference ? (lang === "he" ? `, אסמכתא ${r.reference}` : `, reference ${r.reference}`) : "";
  const he: Record<string, string> = {
    active: "ממתין לאישור בעל העסק",
    held: "מוקפא עד שתאשר/י שזה עדיין מה שרצית, לא בוצע",
    superseded: "הוחלף בבקשה מעודכנת, לא בוצע",
    withdrawn: "בוטל לבקשתך, לא בוצע",
    declined: "בעל העסק לא אישר, לא בוצע",
    executed: `בוצע${ref}`,
    executed_unconfirmed: `הוגש אבל עדיין לא אושר שבוצע${ref}`,
    failed: "אושר אבל הביצוע לא עבר",
    approved: "אושר",
  };
  const en: Record<string, string> = {
    active: "waiting for the owner's approval",
    held: "on hold until you confirm it's still what you want, not carried out",
    superseded: "replaced by an updated request, not carried out",
    withdrawn: "withdrawn at your request, not carried out",
    declined: "not approved by the owner, not carried out",
    executed: `done${ref}`,
    executed_unconfirmed: `submitted but not confirmed yet${ref}`,
    failed: "approved, but carrying it out didn't go through",
    approved: "approved",
  };
  return `${what}: ${(lang === "he" ? he : en)[r.lifecycle] ?? r.lifecycle}`;
}

/** Each owner request with its own frozen terms, lifecycle and reference — one line each. */
export function requestsText(requests: OwnerRequestView[], lang: string | undefined): string {
  return requests.map((r) => requestLine(r, lang === "he" ? "he" : "en")).join("\n");
}

export function quoteText(q: Quote, lang: Lang): string {
  const items = q.lines.map((l) => `${l.quantity} × ${l.item}`).join(", ");
  const pct = q.discountPct ? (lang === "he" ? ` בהנחה של ${q.discountPct}%` : ` with ${q.discountPct}% off`) : "";
  const shipping =
    q.shipping.basis === "not_applicable"
      ? ""
      : q.shipping.amount === 0
        ? lang === "he" ? ", כולל משלוח חינם" : ", shipping free"
        : q.shipping.amount !== null
          ? lang === "he" ? `, כולל משלוח ${money(q.shipping.amount, q.currency, "he")}` : `, including ${money(q.shipping.amount, q.currency)} shipping`
          : lang === "he" ? " (לא כולל משלוח — העלות שלו לא ידועה לי)" : " (shipping not included — I don't know its cost)";
  return lang === "he" ? `${items}${pct}: ${money(q.total, q.currency, "he")}${shipping}.` : `${items}${pct}: ${money(q.total, q.currency)}${shipping}.`;
}

export function renderStatus(input: { requests: OwnerRequestView[]; ledger: LedgerEntry[]; quote?: Quote; lang: string }): string {
  const lang: Lang = input.lang === "he" ? "he" : "en";
  const lines: string[] = [];
  for (const r of input.requests) lines.push(requestLine(r, lang));
  const effected = input.ledger.filter((e) => e.status === "effected");
  const booked = effected.find((e) => e.effect === "booking.created");
  const paid = effected.find((e) => e.effect === "payment.settled");
  const linkSent = effected.some((e) => e.effect === "payment.link_created");
  const order = effected.find((e) => e.effect === "order.created" || e.effect === "order.fulfilled");
  const enquiry = effected.find((e) => e.effect === "enquiry.created");
  const blocked = input.ledger.filter((e) => e.effect === "write.blocked").at(-1);
  if (lang === "he") {
    lines.push(booked ? `יש תור מאושר${booked.reference ? ` (${booked.reference})` : ""}.` : "אין תור מאושר.");
    lines.push(paid ? "התשלום אומת." : linkSent ? "נשלח קישור לתשלום, והתשלום עוד לא אומת." : "לא נגבה תשלום.");
    if (order) lines.push(`ההזמנה נוצרה${order.reference ? ` (${order.reference})` : ""}.`);
    if (enquiry) lines.push("הפנייה שלך רשומה אצל הצוות (אי אפשר לערוך אותה מכאן).");
    if (blocked) lines.push("קישור התשלום האחרון לא נוצר, כי הוא לא עמד בתנאים שלך.");
    if (!input.requests.some((r) => r.lifecycle === "active" || r.lifecycle === "held")) lines.push("אין בקשה שממתינה לבעל העסק.");
  } else {
    lines.push(booked ? `You have a confirmed appointment${booked.reference ? ` (${booked.reference})` : ""}.` : "Nothing is booked.");
    lines.push(paid ? "Your payment is verified." : linkSent ? "A payment link was sent; no payment has been verified." : "No payment has been taken.");
    if (order) lines.push(`Your order was placed${order.reference ? ` (${order.reference})` : ""}.`);
    if (enquiry) lines.push("Your enquiry is recorded for the team (it can't be edited from here).");
    if (blocked) lines.push("The last payment link was not created, because it didn't meet your conditions.");
    if (!input.requests.some((r) => r.lifecycle === "active" || r.lifecycle === "held")) lines.push("Nothing is waiting on the owner.");
  }
  if (input.quote) lines.push(quoteText(input.quote, lang));
  return lines.join(lang === "he" ? "\n" : "\n");
}
