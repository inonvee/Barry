import { getCapability } from "@/lib/fabric/capability";
import type { ConversationState } from "@/lib/state";
import type { ToolCallResult } from "@/lib/tools";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import { money } from "@/lib/reasoner/deterministic-compose";

/**
 * THE EFFECT LEDGER — an append-only record of what BARRY's operations actually did to the
 * business, per conversation.
 *
 * Transport success is not a business effect. `allowed`, `ok: true`, an HTTP 200 or a completed
 * tool call only say the call returned; the ledger records the DOMAIN outcome of that return:
 * a payment check that came back "pending" is `payment.pending`, not `payment.settled`; a ticket
 * awaiting the owner is `awaiting_owner`, not `support.ticket.create` effected; an executed write the
 * system did not confirm is `effected_unconfirmed`.
 *
 * Entries are IMMUTABLE: each freezes the exact operation, its exact customer-safe terms (the
 * references, quantities and amounts it was executed with), the owner-request revision it came
 * from, and the business reference it produced. Later conversation — a new reference, a
 * correction, a summary the model writes — can never rewrite them: lifecycle changes (withdrawn,
 * superseded, declined, executed) are NEW entries that point at the same request.
 */

export type EffectStatus =
  /** The business effect happened and (for writes) the system confirmed it. Reads that returned count here. */
  | "effected"
  /** A write was executed but the system did not confirm it: uncertain, never "done". */
  | "effected_unconfirmed"
  /** The call returned but the requested change did not happen (e.g. variant unavailable). */
  | "no_effect"
  | "failed"
  | "awaiting_owner"
  | "owner_declined"
  | "withdrawn"
  | "superseded";

export type LedgerEntry = {
  seq: number;
  at: string;
  /** BARRY's operation (typed action name or capability id). */
  operation: string;
  /** Domain effect type, e.g. "booking.created", "payment.pending", "support.ticket.create". */
  effect: string;
  status: EffectStatus;
  /** What it was, in plain words. */
  describes: string;
  /** Frozen, customer-safe terms it ran (or was requested) with. */
  terms: Record<string, string | number>;
  /** Owner request (approval id) this entry belongs to, when any. */
  requestId?: string;
  /** The business reference the operation produced (ticket, booking, order number). */
  reference?: string;
  /** Domain outcome details (e.g. slots found, payment status, stock). */
  outcome?: Record<string, string | number | boolean>;
  /** How many conversation messages existed when this was recorded (ordering against what was said, without clocks). */
  messageIndex?: number;
};

export const LEDGER_KEY = "__effectLedger";

export type CartLineSnapshot = { position: number; id: string; title: string; options: Record<string, string>; quantity: number };

const lineLabel = (l: { title: string; options: Record<string, string> }) => `${l.title}${Object.keys(l.options).length ? ` (${Object.values(l.options).join(" / ")})` : ""}`;
const cartLabel = (lines: { title: string; options: Record<string, string>; quantity: number }[]) => (lines.length ? lines.map((l) => `${l.quantity} × ${lineLabel(l)}`).join(", ") : "empty");

const OPERATION_WORDS: Record<string, string> = {
  checkAvailability: "availability lookup",
  createBooking: "appointment booking",
  checkInventory: "stock check",
  createPaymentRequest: "payment link",
  searchProducts: "catalog search",
  addToCart: "add to cart",
  updateCartLine: "cart change",
  createCommerceCheckout: "checkout payment link",
  createCommerceOrder: "order",
  verifyPayment: "payment status check",
  createFollowUp: "follow-up message",
  fulfillOrder: "order confirmation",
  createLead: "enquiry for the team",
  sendMedia: "media",
};

export function readLedger(state: ConversationState): LedgerEntry[] {
  try {
    const parsed = JSON.parse(state.knownFields[LEDGER_KEY] ?? "[]");
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

/** Append (never edit) one entry. Entries are frozen copies. */
export function appendLedger(state: ConversationState, entry: Omit<LedgerEntry, "seq" | "at">): LedgerEntry {
  const ledger = readLedger(state);
  const full: LedgerEntry = JSON.parse(JSON.stringify({ ...entry, seq: ledger.length + 1, at: new Date().toISOString(), messageIndex: state.messages.length }));
  ledger.push(full);
  state.knownFields[LEDGER_KEY] = JSON.stringify(ledger);
  return full;
}

const humanWords = (v: string) => (/^[a-z]+(?:_[a-z]+)+$/.test(v) ? v.replace(/_/g, " ") : v);

/** The customer-safe terms of an operation's input (never keys, ids of carts/lines or internal fields). */
export function termsOf(action: string, input: unknown): Record<string, string | number> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const src = action === INVOKE_CAPABILITY ? ((raw.input as Record<string, unknown>) ?? {}) : raw;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(src)) {
    if (/^(idempotencyKey|approvalId|cartId|lineId|paymentRequestId|resourceId|offerId|productId|isCustomPrice|expectedTotal|replaceLine|start|end|earliest|latest)$/.test(k)) continue;
    if (typeof v === "string" || typeof v === "number") out[k] = typeof v === "string" ? humanWords(v) : v;
    else if (k === "lines" && Array.isArray(v)) out.items = (v as { item: string; quantity: number }[]).map((l) => `${l.quantity} × ${l.item}`).join(", ");
  }
  return out;
}

function describe(action: string, input: unknown): string {
  if (action === INVOKE_CAPABILITY) {
    const id = String((input as { capability?: unknown })?.capability ?? "");
    return getCapability(id)?.purpose ?? id;
  }
  return OPERATION_WORDS[action] ?? action;
}

function operationOf(action: string, input: unknown): string {
  return action === INVOKE_CAPABILITY ? String((input as { capability?: unknown })?.capability ?? action) : action;
}

function referenceOf(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  const inner = o.output && typeof o.output === "object" ? (o.output as Record<string, unknown>) : o;
  const key = Object.keys(inner).find((k) => /(?:Id|Number|reference)$/.test(k) && typeof inner[k] === "string" && !/^(cartId|lineId|paymentRequestId|checkoutId|productId|offerId|resourceId|trackingNumber)$/.test(k));
  return key ? String(inner[key]) : undefined;
}

/**
 * The DOMAIN outcome of one executed call: effect type + status + reference + outcome. This is the
 * one place transport results become business effects.
 */
export function classifyExecution(action: string, input: unknown, result: ToolCallResult, cartBefore?: CartLineSnapshot[]): Omit<LedgerEntry, "seq" | "at"> {
  const base = { operation: operationOf(action, input), describes: describe(action, input), terms: termsOf(action, input) };
  if (!result.ok) {
    const cap = (result as { capability?: { executed?: boolean } }).capability;
    return { ...base, effect: `${base.operation}.failed`, status: "failed", ...(cap && cap.executed === false ? { outcome: { executed: false } } : {}) };
  }
  const out = (result.output ?? {}) as Record<string, unknown>;
  switch (action) {
    case INVOKE_CAPABILITY: {
      const contract = getCapability(base.operation);
      const call = out as { ok?: boolean; executed?: boolean; verified?: boolean; output?: Record<string, unknown> };
      if (call.ok === false || call.executed === false) return { ...base, effect: `${base.operation}.failed`, status: "failed" };
      const reference = referenceOf(call.output);
      const outcome = Object.fromEntries(Object.entries(call.output ?? {}).filter(([k, v]) => k !== "verified" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")).map(([k, v]) => [k, typeof v === "string" ? humanWords(v) : v])) as Record<string, string | number | boolean>;
      if (contract?.effect === "read") return { ...base, effect: `${base.operation}.read`, status: "effected", outcome };
      return { ...base, effect: base.operation, status: call.verified ? "effected" : "effected_unconfirmed", ...(reference ? { reference } : {}), outcome };
    }
    case "checkAvailability": {
      const slots = (out.slots as unknown[] | undefined)?.length ?? 0;
      return { ...base, effect: slots > 0 ? "availability.found" : "availability.none", status: "effected", outcome: { slotsFound: slots } };
    }
    case "checkInventory": {
      const available = Number(out.quantityAvailable ?? 0);
      const wanted = Number((input as { quantity?: unknown })?.quantity ?? 1);
      return { ...base, effect: available >= wanted ? "stock.available" : "stock.insufficient", status: "effected", outcome: { quantityWanted: wanted, inStock: available >= wanted } };
    }
    case "verifyPayment": {
      const status = String(out.status ?? "unknown");
      // Only the payment provider saying "paid" is a settled payment. "pending" is a CHECK, not a payment.
      return { ...base, effect: status === "paid" ? "payment.settled" : status === "pending" ? "payment.pending" : "payment.not_paid", status: "effected", outcome: { paymentStatus: status } };
    }
    case "createPaymentRequest":
    case "createCommerceCheckout":
      return { ...base, effect: "payment.link_created", status: "effected" };
    case "createBooking":
      return { ...base, effect: "booking.created", status: "effected", ...(referenceOf(out) ? { reference: referenceOf(out) } : {}) };
    case "createCommerceOrder":
      return { ...base, effect: "order.created", status: "effected", ...(referenceOf(out) ? { reference: referenceOf(out) } : {}) };
    case "fulfillOrder":
      return { ...base, effect: "order.fulfilled", status: "effected", ...(referenceOf(out) ? { reference: referenceOf(out) } : {}) };
    case "createLead":
      return { ...base, effect: "enquiry.created", status: "effected", ...(referenceOf(out) ? { reference: referenceOf(out) } : {}) };
    case "createFollowUp":
      return { ...base, effect: "followup.scheduled", status: "effected" };
    case "searchProducts":
      return { ...base, effect: "catalog.searched", status: "effected", outcome: { results: ((out.products as unknown[]) ?? []).length } };
    case "addToCart":
    case "updateCartLine": {
      // A cart receipt freezes the EXACT subject: which line (product + options), its quantity before
      // and after, and the whole cart after — read from the provider's returned cart, never from the request.
      const after = ((out.cart as { lines?: CartLineSnapshot[] } | undefined)?.lines ?? []) as CartLineSnapshot[];
      const targetId = action === "updateCartLine" ? String((input as { lineId?: unknown })?.lineId ?? "") : String(out.lineId ?? "");
      const before = cartBefore?.find((l) => l.id === targetId);
      // The line the change produced, as the PROVIDER returned it. A variant change can replace the line
      // (new line id): the provider's returned line id is authoritative, never the request's old id.
      const resultId = action === "updateCartLine" && typeof out.lineId === "string" && out.lineId ? out.lineId : targetId;
      const afterLine = after.find((l) => l.id === resultId);
      const subject = before ?? afterLine;
      const qty = (input as { quantity?: unknown })?.quantity;
      const wantedOptions = (input as { options?: Record<string, string> })?.options ?? {};
      const removing = action === "updateCartLine" && qty === 0;
      const terms = {
        ...base.terms,
        ...(subject ? { item: lineLabel(subject) } : {}),
        ...(!removing && before && afterLine && lineLabel(afterLine) !== lineLabel(before) ? { itemAfter: lineLabel(afterLine) } : {}),
        quantityBefore: before?.quantity ?? 0,
        quantityAfter: removing ? (after.find((l) => l.id === targetId)?.quantity ?? 0) : (afterLine?.quantity ?? 0),
      };
      const outcome = { cartAfter: cartLabel(after) };
      if (out.added === false) return { ...base, terms, effect: "cart.not_changed", status: "no_effect", outcome };
      if (action === "updateCartLine") {
        // The requested change must be visible on the resulting line in the returned cart: its quantity,
        // and every option asked for.
        const wanted = typeof qty === "number" ? qty : undefined;
        const optionsApplied = Boolean(afterLine) && Object.entries(wantedOptions).every(([k, v]) => afterLine!.options[k]?.toLowerCase() === String(v).toLowerCase());
        const applied = removing ? !after.some((l) => l.id === targetId) : optionsApplied && (wanted === undefined || afterLine?.quantity === wanted);
        if (!applied || (cartBefore && !before)) return { ...base, terms, effect: "cart.change_not_verified", status: "failed", outcome };
      }
      const effect = action === "addToCart" ? (out.replacedLineId ? "cart.line_replaced" : "cart.line_added") : qty === 0 ? "cart.line_removed" : "cart.line_updated";
      return { ...base, terms, effect, status: "effected", outcome };
    }
    default:
      return { ...base, effect: `${action}.done`, status: "effected" };
  }
}

/** A write the final-write gate stopped before anything was proposed or executed. */
export function classifyBlocked(action: string, input: unknown): Omit<LedgerEntry, "seq" | "at"> {
  return { operation: operationOf(action, input), describes: describe(action, input), terms: termsOf(action, input), effect: "write.blocked", status: "no_effect" };
}

/** An owner request's lifecycle event (asked, withdrawn, superseded, declined) as a new entry. */
export function requestEntry(action: string, input: unknown, requestId: string, status: "awaiting_owner" | "owner_declined" | "withdrawn" | "superseded"): Omit<LedgerEntry, "seq" | "at"> {
  return { operation: operationOf(action, input), describes: describe(action, input), terms: termsOf(action, input), effect: `request.${status}`, status, requestId };
}

/** The current view of the ledger: each owner request collapsed to its latest entry; everything else as recorded. */
export function ledgerView(entries: LedgerEntry[]) {
  const latestByRequest = new Map<string, LedgerEntry>();
  for (const e of entries) if (e.requestId) latestByRequest.set(e.requestId, e);
  return entries.filter((e) => !e.requestId || latestByRequest.get(e.requestId) === e);
}

/** A customer-facing amount phrase for a payment's frozen terms. */
export function termsAmount(terms: Record<string, string | number>): string | undefined {
  return typeof terms.amount === "number" && typeof terms.currency === "string" ? money(terms.amount, terms.currency) : undefined;
}

/** What an entry means, in plain words for the composer (never an internal id). */
export function effectPhrase(e: LedgerEntry): string {
  switch (e.status) {
    case "awaiting_owner":
      return "asked the owner — waiting for their decision; NOT carried out";
    case "owner_declined":
      return "the owner declined — NOT carried out";
    case "withdrawn":
      return "withdrawn at the customer's request — NOT carried out";
    case "superseded":
      return "replaced by a newer revision — NOT carried out";
    case "failed":
      return "attempted and FAILED — nothing changed";
    case "no_effect":
      return "the requested change did NOT happen";
    case "effected_unconfirmed":
      return "submitted, but the system has NOT confirmed it happened";
  }
  switch (e.effect) {
    case "write.blocked":
      return "NOT created — it would break the customer's own consent or limits; nothing was sent or charged";
    case "cart.change_not_verified":
      return "the requested cart change could NOT be verified on the cart — do not say it happened";
    case "payment.pending":
      return "checked with the payment provider: NOT paid yet (pending)";
    case "payment.not_paid":
      return "checked with the payment provider: NOT paid";
    case "payment.settled":
      return "payment received and verified by the provider";
    case "payment.link_created":
      return "payment link created and sent (not paid)";
    case "booking.created":
      return "appointment booked and confirmed";
    case "availability.found":
      return "looked up open times: slots found";
    case "availability.none":
      return "looked up open times: NO slots in that window";
    case "stock.available":
      return "checked stock: enough in stock";
    case "stock.insufficient":
      return "checked stock: NOT enough in stock";
    case "cart.line_added":
      return "added to the cart";
    case "cart.line_updated":
      return "changed an existing cart line (nothing new added)";
    case "cart.line_replaced":
      return "swapped the cart item";
    case "cart.line_removed":
      return "removed from the cart";
    case "order.created":
    case "order.fulfilled":
      return "order placed";
    case "enquiry.created":
      return "a new enquiry recorded for the team";
    case "followup.scheduled":
      return "follow-up message scheduled";
    case "catalog.searched":
      return "searched the catalog";
  }
  return e.effect.endsWith(".read") ? "looked it up in the business's system" : "done, confirmed by the business's system";
}
