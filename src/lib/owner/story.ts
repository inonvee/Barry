import type { ConversationState, TurnLog } from "@/lib/state";
import { readLedger, termsAmount, type LedgerEntry } from "@/lib/runtime/ledger";
import { transactionSnapshot } from "@/lib/runtime/handoff";

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

const STOP_WORDS: Record<string, string> = {
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

function termsWords(e: LedgerEntry): string {
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
export function describeEffect(e: LedgerEntry): string {
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

const READ_EFFECT = /\.read$|^catalog\.|^availability\.|^stock\.|^payment\.(pending|not_paid)$|^understanding\./;

function customerWords(turn: TurnLog): string {
  if (turn.understood.intent === "approval_resumed") return turn.understood.entities?.decision === "declined" ? "(you declined the request)" : "(you approved the request)";
  if (turn.understood.intent === "approval_already_resolved") return "(a request was decided twice)";
  const asks = turn.understood.asks?.map((a) => a.ask).filter(Boolean) ?? [];
  return asks.length ? asks.join("; ") : clip(turn.customerMessage);
}

function outcomeOf(turn: TurnLog, effects: LedgerEntry[]): { outcome: StoryOutcome; stopped?: string } {
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

export function conversationStory(state: ConversationState): ConversationStory {
  const ledger = readLedger(state);
  const bySeq = new Map(ledger.map((e) => [e.seq, e]));
  const steps: StoryStep[] = state.turns.map((turn) => {
    const effects = (turn.trace?.effects ?? []).map((e) => bySeq.get(e.seq)).filter((e): e is LedgerEntry => Boolean(e));
    const { outcome, stopped } = outcomeOf(turn, effects);
    return {
      at: turn.at,
      turnId: turn.id,
      customer: customerWords(turn),
      barry: effects.map(describeEffect),
      outcome,
      ...(stopped ? { stopped } : {}),
      ...(turn.response ? { reply: clip(turn.response) } : {}),
    };
  });
  const tried: string[] = [];
  for (const e of ledger) {
    if (READ_EFFECT.test(e.effect) && e.status !== "failed") continue;
    const line = describeEffect(e);
    if (tried.at(-1) !== line) tried.push(line);
  }
  return { steps, standing: transactionSnapshot(state), tried: tried.slice(-10) };
}
