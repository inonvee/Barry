import { extractEntities, findOfferCandidates, findOffersByExplicitNameReference, matchHebrewToken } from "./entities";
import { mockCommerceSemantics } from "./mock-commerce";
import { composeDeterministic } from "./deterministic-compose";
import type { BarryIR, BarryIRConstraints, ComposeResponseInput, Reasoner, ReasonerContext } from "./types";

/**
 * OFFLINE STAND-IN FOR THE MODEL. It exists so the simulator and the test
 * suite run with no API key; production refuses to use it (see
 * `getReasoner()`). Everything here is heuristic language handling — the
 * exact thing BARRY's architecture delegates to the model — so it must
 * never be imported by the runtime, verifier, or compiler. Like the real
 * model, it only produces IR (with evidence for anything that persists);
 * the deterministic grounding layer treats its output exactly like the
 * model's.
 */

const PRICE_QUESTION = /\b(how much|what('s| is) the price|cost|pricing)\b/i;
const DURATION_QUESTION = /\b(how long|how much time|what('s| is) the duration)\b/i;
const DEPOSIT_QUESTION = /\b(deposit|do (you|i) (need|require)|require(d)? (a )?(deposit|payment)( upfront)?)\b/i;
const POLICY_QUESTION = /\b(return|returns|exchange|refund)\b|החזר|להחזיר|החלפה|להחליף/i;
const CHANGE_OF_MIND_SIGNAL = /\b(actually|instead|change (it |that )?to|switch (it |that )?to|rather have|no,? (i want|make it|let'?s do))\b/i;
const PAYMENT_CLAIM = /\b(i('ve| have)?\s+(already\s+)?paid|paid already|already paid|payment (is )?(done|complete|completed|sent|went through)|sent the payment)\b|שילמתי|העברתי את התשלום|כבר שילמתי/i;

/** Stand-in for the model's judgment that the customer has decided to buy. */
const PURCHASE_DECISION =
  /\b(i'?ll take|take it|take the|let'?s (do it|buy|go with|try again)|i'?d like to buy|i want to buy|i'?ll buy|buy it|sold|put .* in my cart|go ahead|checkout|check out)\b|אקח|לוקחת|לוקח|קונה|אני רוצה לקנות|סגרנו|יאללה/i;
const STILL_BROWSING = /\b(also|too|as well|show me more|and more)\b|גם|עוד/i;

const HEBREW_PRICE_WORDS = ["מחיר", "עולה"];
const HEBREW_DURATION_WORDS = ["זמן"];
const HEBREW_DEPOSIT_WORDS = ["פיקדון", "מקדמה"];

function matchesAnyHebrewWord(text: string, words: string[]): boolean {
  return words.some((w) => matchHebrewToken(text, w) !== undefined);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2)
      .map((w) => w.replace(/(ies|es|s)$/, ""))
  );
}

/** Stand-in for the model picking which knowledge topic a question is about: best word overlap, or nothing. */
function mockKnowledgeTopic(graph: ReasonerContext["graph"], text: string): string | undefined {
  const asked = words(text);
  let best: { topic: string; score: number } | undefined;
  for (const item of graph.knowledge) {
    const have = words(`${item.topic} ${item.content}`);
    const score = [...asked].filter((w) => have.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { topic: item.topic, score };
  }
  return best?.topic;
}

/**
 * Stand-in only: a bare reply counts as a name when it is one or two
 * words and doesn't open with a pronoun ("אני אקח…", "I'll…") — a crude
 * approximation the real model replaces with actual understanding.
 */
const PRONOUN_OPENERS = new Set(["אני", "אנחנו", "אנו", "i", "i'm", "im", "i'll", "we", "we're", "it's", "its"]);
function isBareNameReply(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  return tokens.length <= 2 && !PRONOUN_OPENERS.has(tokens[0].toLowerCase());
}

export class MockReasoner implements Reasoner {
  readonly name = "mock" as const;

  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const { graph, state, customerMessage } = ctx;
    const entities = extractEntities(customerMessage);
    const canSearch = graph.availableActions.some((action) => action.name === "searchProducts");

    const commerce = mockCommerceSemantics(customerMessage, {
      canSearch,
      hasPreviousResults: Boolean(state.knownFields.__commerceLastProductIds),
      hasCart: Boolean(state.knownFields.__commerceCartId),
    });

    const requestedCapability = POLICY_QUESTION.test(customerMessage)
      ? "ask_policy"
      : PRICE_QUESTION.test(customerMessage) || matchesAnyHebrewWord(customerMessage, HEBREW_PRICE_WORDS)
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
    if (entities.declined) constraints.slotDeclined = true;
    else if (entities.accepted) constraints.slotAccepted = true;

    // Like the model, cite the exact span that supports each persisted
    // fact — the grounding layer rejects anything it can't find.
    const customerInfo: Record<string, string> = {};
    const evidence: Record<string, string> = {};
    const cite = (field: string, value: string, quote = value) => {
      customerInfo[field] = value;
      evidence[`customerInfo.${field}`] = quote;
    };
    if (entities.email) cite("email", entities.email);
    if (entities.phone) cite("phone", entities.phone);
    if (entities.name) {
      cite("name", entities.name);
    } else if (
      // A bare reply is treated as the name only when BARRY's previous
      // turn was actually asking for it and the reply isn't doing
      // something else (a question, a selection, a time, a claim).
      state.missingFields[0] === "name" &&
      !state.knownFields.name &&
      !customerInfo.email &&
      !customerInfo.phone &&
      !entities.accepted &&
      !entities.schedulingConstraint &&
      !requestedCapability &&
      !commerce &&
      !PAYMENT_CLAIM.test(customerMessage) &&
      !customerMessage.includes("?") &&
      isBareNameReply(customerMessage)
    ) {
      cite("name", customerMessage.trim());
    }

    let selectedOfferId: string | undefined;
    let offerCandidateIds: string[] | undefined;
    let offerChangeRequested: string | undefined;
    const explicit = findOffersByExplicitNameReference(graph, customerMessage);
    if (!state.selectedOfferId) {
      const candidates = explicit.length === 1 ? explicit : findOfferCandidates(graph, customerMessage);
      if (candidates.length === 1) selectedOfferId = candidates[0].id;
      else if (candidates.length > 1) offerCandidateIds = candidates.map((o) => o.id);
    } else if (CHANGE_OF_MIND_SIGNAL.test(customerMessage)) {
      const candidates = explicit.length === 1 ? explicit : findOfferCandidates(graph, customerMessage);
      if (candidates.length === 1 && candidates[0].id !== state.selectedOfferId) {
        offerChangeRequested = candidates[0].id;
      }
    }

    return {
      intent: commerce ? `commerce_${commerce.intent}` : selectedOfferId || state.selectedOfferId ? "offer_interest" : "discovery",
      selectedOfferId,
      offerCandidateIds,
      offerChangeRequested,
      entities: entities as Record<string, unknown>,
      constraints,
      customerInfo,
      evidence,
      requestedCapability,
      commerce,
      customerClaims: PAYMENT_CLAIM.test(customerMessage) ? { paymentCompleted: true } : undefined,
      // In context, a plain "yes" right after BARRY confirmed availability is a go-ahead.
      purchaseDecision:
        PURCHASE_DECISION.test(customerMessage) || (entities.accepted && Boolean(state.knownFields.__inventoryChecked))
          ? !STILL_BROWSING.test(customerMessage)
          : undefined,
      knowledgeTopic: requestedCapability === "ask_policy" ? mockKnowledgeTopic(graph, customerMessage) : undefined,
    };
  }

  async composeResponse(_ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    return composeDeterministic(input);
  }
}
