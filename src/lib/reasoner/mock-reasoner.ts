import { extractEntities, findOfferCandidates, matchHebrewToken } from "./entities";
import { composeDeterministic } from "./deterministic-compose";
import type { BarryIR, BarryIRConstraints, ComposeResponseInput, Reasoner, ReasonerContext } from "./types";

/**
 * Deterministic, rule-based reasoner. Needs no API key, so the simulator
 * and test suite work offline. It ONLY understands text into BARRY IR —
 * it never decides which tool to call or with what input; that's the
 * deterministic Action Compiler's job (`src/lib/runtime/compiler.ts`),
 * shared by every Reasoner including the LLM-backed one.
 */

const PRICE_QUESTION = /\b(how much|what('s| is) the price|cost|pricing)\b/i;
const DURATION_QUESTION = /\b(how long|how much time|what('s| is) the duration)\b/i;
const DEPOSIT_QUESTION = /\b(deposit|do (you|i) (need|require)|require(d)? (a )?(deposit|payment)( upfront)?)\b/i;
const CHANGE_OF_MIND_SIGNAL = /\b(actually|instead|change (it |that )?to|switch (it |that )?to|rather have|no,? (i want|make it|let'?s do))\b/i;

// Hebrew equivalents — same recognized-vocabulary approach as the
// English regexes above (a fixed, narrow keyword set, not general
// language understanding), so a Hebrew fact question deterministically
// resolves through the exact same `resolveOfferFact` path.
const HEBREW_PRICE_WORDS = ["מחיר", "עולה"];
const HEBREW_DURATION_WORDS = ["זמן"]; // "כמה זמן" (how much time) — "זמן" alone is unambiguous enough in this fixed vocabulary
const HEBREW_DEPOSIT_WORDS = ["פיקדון", "מקדמה"];

function matchesAnyHebrewWord(text: string, words: string[]): boolean {
  return words.some((w) => matchHebrewToken(text, w) !== undefined);
}

export class MockReasoner implements Reasoner {
  readonly name = "mock" as const;

  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const { graph, state, customerMessage } = ctx;
    const entities = extractEntities(customerMessage);

    const requestedCapability =
      PRICE_QUESTION.test(customerMessage) || matchesAnyHebrewWord(customerMessage, HEBREW_PRICE_WORDS)
        ? "ask_price"
        : DURATION_QUESTION.test(customerMessage) || matchesAnyHebrewWord(customerMessage, HEBREW_DURATION_WORDS)
          ? "ask_duration"
          : DEPOSIT_QUESTION.test(customerMessage) || matchesAnyHebrewWord(customerMessage, HEBREW_DEPOSIT_WORDS)
            ? "ask_deposit"
            : undefined;

    const constraints: BarryIRConstraints = {};
    if (entities.schedulingConstraint) constraints.schedulingWindow = entities.schedulingConstraint;
    if (entities.partySize > 1) constraints.partySize = entities.partySize;
    if (entities.discountPct) constraints.discountPct = entities.discountPct;
    if (entities.accepted) constraints.slotAccepted = true;

    const customerInfo: Record<string, string> = {};
    if (entities.email) customerInfo.email = entities.email;
    if (entities.phone) customerInfo.phone = entities.phone;
    if (entities.name) {
      // An explicit self-announcement ("my name is X", "call me X") is
      // unambiguous — capture it regardless of what else is in the same
      // message (e.g. "My name is Inon and my phone number is ...").
      customerInfo.name = entities.name;
    } else if (
      // Otherwise, only treat the raw message as "the name" when BARRY's
      // previous turn was actually asking for it — otherwise short
      // messages like "Couples" or "Sunday" (or a short fact QUESTION like
      // "How much is it?") get misread as a name.
      state.missingFields[0] === "name" &&
      !state.knownFields.name &&
      !customerInfo.email &&
      !customerInfo.phone &&
      !entities.accepted &&
      !entities.schedulingConstraint &&
      !requestedCapability &&
      !customerMessage.includes("?") &&
      customerMessage.trim().split(/\s+/).length <= 4
    ) {
      customerInfo.name = customerMessage.trim();
    }

    let selectedOfferId: string | undefined;
    let offerCandidateIds: string[] | undefined;
    let offerChangeRequested: string | undefined;
    if (!state.selectedOfferId) {
      const candidates = findOfferCandidates(graph, customerMessage);
      if (candidates.length === 1) selectedOfferId = candidates[0].id;
      else if (candidates.length > 1) offerCandidateIds = candidates.map((o) => o.id);
    } else if (CHANGE_OF_MIND_SIGNAL.test(customerMessage)) {
      // An offer is already chosen for this conversation — only an
      // explicit change-of-mind phrase plus a single, confident, DIFFERENT
      // offer match can replace it. An unrelated later message never
      // silently switches the offer (see resolveOfferId in compiler.ts).
      const candidates = findOfferCandidates(graph, customerMessage);
      if (candidates.length === 1 && candidates[0].id !== state.selectedOfferId) {
        offerChangeRequested = candidates[0].id;
      }
    }

    return {
      intent: selectedOfferId || state.selectedOfferId ? "offer_interest" : "discovery",
      selectedOfferId,
      offerCandidateIds,
      offerChangeRequested,
      entities: entities as Record<string, unknown>,
      constraints,
      customerInfo,
      requestedCapability,
    };
  }

  async composeResponse(_ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    return composeDeterministic(input);
  }
}
