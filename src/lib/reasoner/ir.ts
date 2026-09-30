import type { Goal } from "@/lib/business-graph";
import type { ConversationStage } from "@/lib/state";
import type { SchedulingConstraint } from "@/lib/scheduling/resolver";

export type { SchedulingConstraint, DateSpec, TimeSpec } from "@/lib/scheduling/resolver";

/**
 * BARRY IR v0.1 — the ONLY thing a Reasoner (mock or LLM) is allowed to
 * produce. It is understanding, not execution: no reasoner, LLM-backed or
 * not, ever constructs a tool call. That is the deterministic Action
 * Compiler's job (`src/lib/runtime/compiler.ts`) — it assembles a
 * `ToolCall` from this IR plus accumulated ConversationState plus the
 * Business Graph, and validates it against the tool's own Zod schema
 * before anything downstream (Policy Engine, `callTool`) ever sees it.
 *
 * `constraints` are the only typed signals the compiler trusts for
 * assembling tool input. `entities` is a free-form bag kept only for
 * Inspector/debugging — the compiler never reads it.
 */
export type BarryIRConstraints = {
  /**
   * SEMANTIC scheduling info only ("Sunday", "at 2pm") — never a resolved
   * timestamp. A Reasoner (LLM or regex-based) must never compute a UTC
   * instant itself; `src/lib/scheduling/resolver.ts` is the one place
   * that turns this into an absolute instant, using the business's own
   * timezone (`business.timezone`), and only the Action Compiler calls it.
   */
  schedulingWindow?: SchedulingConstraint;
  partySize?: number;
  discountPct?: number;
  /** Customer confirmed the previously offered slot works for them. */
  slotAccepted?: boolean;
  /** Customer explicitly declined the previously offered slot ("no"/"לא") — never inferred from anything else. */
  slotDeclined?: boolean;
  /** Units of the offer/product under discussion the customer wants (a correction replaces the earlier number). */
  quantity?: number;
  /** A HARD maximum the customer set for what they'll pay; `budgetIncludesShipping` when they said "including everything". */
  budgetMax?: number;
  budgetIncludesShipping?: boolean;
};

/**
 * What the customer is referring to — a pointer into something BARRY
 * already showed them, never a raw id the model made up. The model says
 * "the first one I just showed"; BARRY's grounding layer (verifyIR +
 * compiler) resolves that to a real product/line id from persisted state.
 */
export type SemanticReference =
  | { type: "previous_result"; index: number }
  | { type: "cart_line"; index: number };

/**
 * Commerce semantics, in the model's own understanding — capability-
 * level, never catalog- or industry-specific. Option/attribute names are
 * open-ended (`size`, `color`, `length`, `flavor`, ...): whatever the
 * business's catalog uses. BARRY resolves them against real variants.
 */
export type CommerceSemantics = {
  /**
   * `replace` = swap the item already in the cart for another shown
   * result ("actually, switch to the first one"): `reference` names the
   * new item; the current cart line is replaced on the provider.
   */
  intent: "search" | "select" | "inquire" | "replace" | "change_variant" | "change_quantity" | "remove" | "checkout" | "negotiate_price";
  query?: {
    text?: string;
    category?: string;
    attributes?: Record<string, string>;
    budget?: { amount: number; currency?: string };
  };
  reference?: SemanticReference;
  /** Set by grounding when the model's explicit reference points outside what BARRY showed / holds: BARRY asks, never guesses. */
  referenceInvalid?: boolean;
  /** Variant options the customer asked for, e.g. { size: "M" }. */
  variant?: Record<string, string>;
  quantity?: number;
  requestedPrice?: { amount: number; currency?: string };
};

/**
 * Things the customer ASSERTS about the outside world. A claim is never
 * a fact: "I paid" becomes `paymentCompleted: true` here, and the only
 * thing BARRY does with it is ask the trusted provider (verifyPayment).
 */
export type CustomerClaims = {
  paymentCompleted?: boolean;
};

/**
 * Advisory-only hint about what the customer wants next. The compiler
 * decides what BARRY actually does from Business Graph capabilities and
 * accumulated state — it is free to ignore this. Only a small recognized
 * vocabulary affects compiler behavior at all (currently: "ask_price",
 * "ask_duration", "ask_deposit").
 */
export type RequestedCapability = "ask_price" | "ask_duration" | "ask_deposit" | string;

export type BarryIR = {
  intent: string;
  /** A single confident offer match. */
  selectedOfferId?: string;
  /** Multiple plausible offers — the compiler asks which one instead of guessing. */
  offerCandidateIds?: string[];
  /**
   * An EXPLICIT request to replace the already-selected offer with a
   * different one (e.g. "actually, solo instead"). Distinct from
   * `selectedOfferId`/`offerCandidateIds`, which only ever apply to the
   * *initial* selection — once an offer is chosen for a conversation, it's
   * sticky against everything except this explicit signal. This is what
   * lets a deliberate change-of-mind through without random model drift
   * silently reinterpreting an unrelated later message as a new choice.
   */
  offerChangeRequested?: string;
  /**
   * Free-form, debug-only semantic entities (Inspector display) — NEVER
   * a channel for persistent customer identity. `customerInfo` below is
   * the ONE authoritative representation of customer-provided fields
   * (name/email/phone/...); the compiler never reads `entities` at all.
   * A Reasoner must not treat these two fields as duplicates of the same
   * fact — that's exactly the live bug this split guards against: a
   * Reasoner correctly describing a fact in `entities` while omitting it
   * from `customerInfo` (the field that actually reaches persistent
   * state) must never again lose that fact.
   */
  entities: Record<string, unknown>;
  constraints: BarryIRConstraints;
  /**
   * THE single authoritative representation of customer-provided
   * identity/contact fields (name, phone, email, or any other field a
   * Business Graph's `requiredCustomerInfo` names) extracted THIS turn.
   * This is the only field the compiler merges into persistent
   * `ConversationState.knownFields` — see `normalizeCustomerFieldValue`
   * in `customer-fields.ts` for the trust boundary every value passes
   * through first.
   */
  customerInfo: Record<string, string>;
  requestedCapability?: RequestedCapability;
  goal?: Goal;
  commerce?: CommerceSemantics;
  customerClaims?: CustomerClaims;
  /**
   * The model's judgment that the customer has DECIDED to buy what's being
   * discussed ("I'll take it", "let's do it", "יאללה סגור") — as opposed
   * to asking, comparing or still browsing. It is consent to move the
   * purchase forward (cart -> checkout / payment link), never a payment,
   * an order or a price.
   */
  purchaseDecision?: boolean;
  /**
   * Which of the business's OWN knowledge topics the customer is asking
   * about (the model is given the topic list). The compiler answers only
   * with that item's stored content, verbatim — never a paraphrase of
   * something the Business Genome doesn't say.
   */
  knowledgeTopic?: string;
  /**
   * Evidence for claims that will be PERSISTED as customer facts: a map
   * from claim path (e.g. "customerInfo.name") to the exact span of the
   * customer's message that supports it. verifyIR() rejects any
   * customerInfo value whose evidence is missing or not actually present
   * in the message — it never invents a value of its own.
   */
  evidence?: Record<string, string>;
  /**
   * The model's proposal to use ONE of the business's registered
   * capabilities (from the capability surface it was shown), with the
   * semantic input and why. A PROPOSAL: grounding checks the capability is
   * on this business's surface and every input value is something the
   * customer said or BARRY knows; the business's authority rules decide
   * whether it may run; the fabric decides which system runs it.
   */
  capabilityRequest?: CapabilityRequest;
  /**
   * The model's judgment of what THIS message does to an ongoing purchase/booking — the customer's
   * current intent is authoritative over any transaction already in progress:
   * - advancesTransaction: true when the message moves it forward (choosing, deciding, giving the
   *   details it needs, accepting a time, asking to book/pay); false when it only asks, checks
   *   status, recaps, browses or chats. BARRY's funnel (asking for details, availability, payment)
   *   runs only when this is not false. Undefined = not judged (the funnel's previous behavior).
   * - withdrawsRequest: the customer withdraws, cancels or declines what they asked for — BARRY stops
   *   the transaction and withdraws any request still waiting on the owner.
   * - changesPendingRequest: the customer changed the terms/details of a request that is still
   *   waiting on the owner (another reference, amount, option) — the old request is withdrawn
   *   so the owner never approves stale terms.
   */
  advancesTransaction?: boolean;
  withdrawsRequest?: boolean;
  changesPendingRequest?: boolean;
  /**
   * READ intent, separate from purchase and checkout: the customer asks BARRY to actually look
   * something up now (open times, stock) without committing. Reads run even when the message does
   * not advance a transaction — and never imply a purchase.
   */
  readRequested?: boolean;
  /**
   * CHECKOUT consent, separate from choosing or changing items: true = they asked to pay / check out
   * now; false = they said not to (e.g. "only change the size, don't check out"). A cart change never
   * implies checkout by itself.
   */
  checkoutConsent?: boolean;
  /**
   * When withdrawing, the identifiers (references/numbers) of exactly the requests withdrawn — a
   * selective "don't reopen A" never withdraws B. Empty/absent = everything still pending.
   */
  withdrawScope?: string[];
};

export type CapabilityRequest = { capability: string; input: Record<string, unknown>; purpose: string };

export type CompiledToolCall = { name: string; input: Record<string, unknown> };

/**
 * What the deterministic Action Compiler (`src/lib/runtime/compiler.ts`)
 * decided BARRY should do next, given some Reasoner's IR. `action` is the
 * only variant that reaches the Policy Engine / tool registry — every
 * other variant means "ask the customer something," with the exact thing
 * to ask carried as data. A Reasoner's `composeResponse()` phrases these
 * into natural language; it never invents which one applies.
 */
/**
 * A safe Business Graph fact, answerable without any transaction-required
 * customer info: `requiredCustomerInfo` means "required to FULFILL a
 * transaction," never "required before BARRY may state a fact that's
 * already sitting in the Business Graph." Never fabricated — every
 * variant here is read directly off the resolved `Offer`.
 */
export type OfferFact =
  | { type: "price"; price: number; currency: string }
  | { type: "duration"; minutes: number }
  | { type: "deposit"; required: boolean; amount?: number; currency?: string };

/**
 * Observability for the exact class of live bugs a raw IR/compile() call
 * can't otherwise prove happened after the fact: what the compiler
 * actually resolved a semantic scheduling constraint to (an absolute UTC
 * window), and what it actually merged into persistent customer-info
 * fields this turn, after sentinel-value filtering
 * (`normalizeCustomerFieldValue`). Attached to every CompileOutcome so
 * the Inspector can show ground truth instead of requiring log
 * spelunking.
 */
export type CompileDebugInfo = {
  appliedCustomerInfo: Record<string, string>;
  resolvedSchedulingWindow?: { earliest: string; latest: string; anomaly?: "nonexistent" | "ambiguous" };
};

export type CompileOutcome = { stage: ConversationStage; debug?: CompileDebugInfo } & (
  | { kind: "action"; action: CompiledToolCall; goal?: Goal }
  | { kind: "ask_general"; offerNames: string[] }
  | { kind: "clarify_offer"; offerNames: string[] }
  | { kind: "knowledge_answer"; answer: string }
  | { kind: "needs_info"; offerName: string; missingFields: string[] }
  | { kind: "ask_datetime"; offerName: string }
  | { kind: "ask_slot_confirm"; offeredStart: string }
  | { kind: "waiting_payment" }
  | { kind: "offer_fact"; offerName: string; fact: OfferFact }
  /** The customer referred to something that isn't grounded in what BARRY showed them (e.g. "the third one" when only two were shown). */
  | { kind: "clarify_reference"; available: number }
  /** A product was chosen but a required variant option is missing/unavailable — ask using REAL options only. */
  | { kind: "ask_variant"; productTitle: string; requested?: Record<string, string>; availableOptions: Record<string, string>[] }
  /** The customer asked for a different price. BARRY states the grounded price; it never negotiates on its own authority. */
  | { kind: "price_request"; requested: { amount: number; currency?: string }; current?: { amount: number; currency: string }; productTitle?: string }
  /** The customer claimed payment but there is no open payment request to verify. */
  | { kind: "no_payment_to_verify" }
  /** The item is available and everything is ready; BARRY needs the customer's go-ahead to send a payment link. */
  | { kind: "confirm_purchase"; offerName: string }
  /** Real, provider-read facts about a shown product the customer asked about (availability, price, options). */
  | { kind: "product_info"; productTitle: string; variants: { options: Record<string, string>; price: string; inStock: boolean }[]; asked?: Record<string, string> }
  /** The purchase is decided; the business needs these customer details before BARRY can send checkout. */
  | { kind: "checkout_needs_info"; missingFields: string[] }
  /** The next step toward the goal needs a provider operation this business hasn't connected. */
  | { kind: "capability_unavailable"; action: string; missing: string[] }
  /** A capability the customer needs, but its contract's required inputs aren't known yet — ask for exactly these. */
  | { kind: "capability_needs_input"; capability: string; missingFields: string[] }
  | { kind: "generic_confirm" }
  /** Nothing to execute this turn: the customer asked/said something BARRY answers from facts (never advances a transaction). */
  | { kind: "conversation" }
  /** The customer withdrew: the transaction stopped and requests still waiting on the owner were withdrawn. */
  | { kind: "withdrawn"; withdrawnRequests: number }
  /** Assembled input failed the tool's own schema — a compiler bug, not a customer data problem. Never reaches callTool(). */
  | { kind: "compiler_error"; reason: string }
);
