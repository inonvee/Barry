import type { BusinessGraph } from "@/lib/business-graph";
import type { CompileOutcome } from "@/lib/reasoner/ir";
import type { AskOutcome, AskStatus } from "@/lib/reasoner/types";

/**
 * ASK COMPLETENESS — what became of every distinct thing the customer asked in one message.
 *
 * The model says WHAT was asked (its `asks`, in the customer's words, with a knowledge topic for a
 * question). The runtime alone decides what became of each ask, from what really happened this turn:
 * receipts and authority for changes, the business's own knowledge for questions. Nothing here reads
 * the customer's words — it is the same for every language, business and combination of asks.
 *
 * The reply contract that uses this: the final reply addresses EVERY ask with its status. A guard may
 * repair or replace a clause; it may never drop an ask (see guardReply / composeDeterministic).
 */

export type AskStep = {
  /** "customer" = done for one of the customer's own asks; "continuation" = BARRY's own next step. */
  trigger: "customer" | "continuation";
  policy: "allowed" | "requires_approval" | "denied";
  ok: boolean;
  blocked: boolean;
};

export type AskInput = {
  graph: Pick<BusinessGraph, "knowledge">;
  asks: { ask: string; kind: AskOutcome["kind"]; coveredByThisIR: boolean; topic?: string }[] | undefined;
  /** The IR-level knowledge topic (describes the ask this IR covers when it is a question). */
  knowledgeTopic?: string;
  outcome: CompileOutcome;
  steps: AskStep[];
  /** Change asks that were never reached this turn (their words). */
  notDone: string[];
  handoff: boolean;
};

const NEEDS_CUSTOMER = new Set<CompileOutcome["kind"]>(["needs_info", "checkout_needs_info", "capability_needs_input", "ask_variant", "ask_datetime", "ask_slot_confirm", "clarify_offer", "clarify_reference", "cart_subject_unresolved", "ask_general", "confirm_purchase"]);

function stepStatus(s: AskStep): AskStatus {
  if (s.blocked || s.policy === "denied") return "blocked";
  if (s.policy === "requires_approval") return "awaiting_approval";
  return s.ok ? "completed" : "blocked";
}

function statusWithoutStep(outcome: CompileOutcome, handoff: boolean): AskStatus {
  if (NEEDS_CUSTOMER.has(outcome.kind)) return "needs_info";
  if (outcome.kind === "capability_unavailable" || outcome.kind === "compiler_error") return handoff ? "handoff" : "blocked";
  if (outcome.kind === "withdrawn") return "completed";
  return handoff ? "handoff" : "not_done";
}

export function askOutcomes(input: AskInput): AskOutcome[] {
  const asks = input.asks ?? [];
  if (asks.length === 0) return [];
  const topics = new Map(input.graph.knowledge.map((k) => [k.topic, k.content]));
  const questions = asks.filter((a) => a.kind === "question");
  const customerSteps = input.steps.filter((s) => s.trigger === "customer");
  const notDone = new Set(input.notDone);
  let changeIndex = 0;

  return asks.map((a): AskOutcome => {
    const base = { ask: a.ask, kind: a.kind };
    if (a.kind === "change") {
      if (notDone.has(a.ask)) return { ...base, status: input.handoff ? "handoff" : "not_done" };
      const step = customerSteps[changeIndex++];
      return { ...base, status: step ? stepStatus(step) : statusWithoutStep(input.outcome, input.handoff) };
    }
    if (a.kind === "question") {
      // The ask's own topic; the IR-level topic describes the question only when it is the only one.
      const topic = [a.topic, questions.length === 1 ? input.knowledgeTopic : undefined].find((t): t is string => Boolean(t && topics.has(t)));
      if (topic) return { ...base, status: "answered", answer: { topic, text: topics.get(topic)! } };
      if (input.outcome.kind === "knowledge_answer" || input.outcome.kind === "offer_fact" || input.outcome.kind === "product_info") return { ...base, status: "answered" };
      // Nothing grounded answers it: said plainly (or passed to the team) — never guessed.
      return { ...base, status: input.handoff ? "handoff" : "not_done" };
    }
    // Status questions are answered from the deterministic request/ledger status; "other" (greetings,
    // thanks) needs no specific statement.
    return { ...base, status: "answered" };
  });
}

/** The asks a reply must visibly address (a greeting or thanks never makes a reply incomplete). */
export function mandatoryAsks(asks: AskOutcome[] | undefined): AskOutcome[] {
  return (asks ?? []).filter((a) => a.kind !== "other");
}
