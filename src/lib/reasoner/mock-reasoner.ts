import { extractEntities, findOfferCandidates } from "./entities";
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

export class MockReasoner implements Reasoner {
  readonly name = "mock" as const;

  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const { graph, state, customerMessage } = ctx;
    const entities = extractEntities(customerMessage);

    const constraints: BarryIRConstraints = {};
    if (entities.schedulingConstraint) constraints.schedulingWindow = entities.schedulingConstraint;
    if (entities.partySize > 1) constraints.partySize = entities.partySize;
    if (entities.discountPct) constraints.discountPct = entities.discountPct;
    if (entities.accepted) constraints.slotAccepted = true;

    const knownFieldsUpdate: Record<string, string> = {};
    if (entities.email) knownFieldsUpdate.email = entities.email;
    if (entities.phone) knownFieldsUpdate.phone = entities.phone;
    if (
      // Only treat the raw message as "the name" when BARRY's previous turn
      // was actually asking for it — otherwise short messages like "Couples"
      // or "Sunday" get misread as a name.
      state.missingFields[0] === "name" &&
      !state.knownFields.name &&
      !knownFieldsUpdate.email &&
      !knownFieldsUpdate.phone &&
      !entities.accepted &&
      !entities.schedulingConstraint &&
      customerMessage.trim().split(/\s+/).length <= 4
    ) {
      knownFieldsUpdate.name = customerMessage.trim();
    }

    let selectedOfferId: string | undefined;
    let offerCandidateIds: string[] | undefined;
    if (!state.selectedOfferId) {
      const candidates = findOfferCandidates(graph, customerMessage);
      if (candidates.length === 1) selectedOfferId = candidates[0].id;
      else if (candidates.length > 1) offerCandidateIds = candidates.map((o) => o.id);
    }

    return {
      intent: selectedOfferId || state.selectedOfferId ? "offer_interest" : "discovery",
      selectedOfferId,
      offerCandidateIds,
      entities: entities as Record<string, unknown>,
      constraints,
      knownFieldsUpdate,
      requestedCapability: PRICE_QUESTION.test(customerMessage) ? "ask_price" : undefined,
    };
  }

  async composeResponse(_ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    return composeDeterministic(input);
  }
}
