import type { BusinessGraph, Goal, Offer } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { getTool } from "@/lib/tools";
import type { BarryIR, CartSubjectGrounding, CompileDebugInfo, CompileOutcome, OfferFact } from "@/lib/reasoner/ir";
import { normalizeCustomerInfoField } from "@/lib/reasoner/customer-fields";
import type { ConversationStage, ConversationState } from "@/lib/state";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";
import { actionSupported, type CapabilityProfiles } from "@/lib/capabilities/model";
import { getCapability } from "@/lib/fabric/capability";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import type { GroundedContext } from "@/lib/reasoner/types";
import { paymentTermsFromQuote, quoteOffer } from "./pricing";

export type { CompileOutcome, CompileDebugInfo } from "@/lib/reasoner/ir";

/**
 * Internal scratch keys BARRY threads through ConversationState.knownFields
 * between turns. Never shown to the customer. Owned by the compiler — this
 * is the ONE place that reads and writes them; no reasoner (mock or LLM)
 * touches them directly.
 */
export const SCRATCH_KEYS = {
  offeredStart: "__offeredSlotStart",
  offeredEnd: "__offeredSlotEnd",
  offeredResource: "__offeredSlotResource",
  paymentRequestId: "__paymentRequestId",
  paid: "__paid",
  discountPct: "__discountPct",
  mentionedEarliest: "__mentionedEarliest",
  mentionedLatest: "__mentionedLatest",
  mentionedPartySize: "__mentionedPartySize",
  slotAccepted: "__slotAccepted",
  inventoryChecked: "__inventoryChecked",
  /** Units the customer wants of the offer under discussion (latest correction wins). */
  quantity: "__quantity",
  /** The customer's hard spending cap: {amount, currency?, includesShipping} — enforced at every payment write. */
  budgetCap: "__budgetCap",
  /** Exactly which cart lines the customer consented to check out (line ids) — "all" when they meant the whole cart. */
  checkoutScope: "__checkoutScope",
  lastSchedulingDate: "__lastSchedulingDate",
  /** The last time-of-day the customer set ("after 3", "morning") — kept when a later turn only names a day. */
  lastSchedulingTime: "__lastSchedulingTime",
  /** The customer's window has an explicit end: a slot must END by it, not just start before it. */
  windowEndIsHard: "__windowEndIsHard",
  commerceLastProductIds: "__commerceLastProductIds",
  commercePendingProductId: "__commercePendingProductId",
  commercePendingReplaceLineId: "__commercePendingReplaceLineId",
  commerceCartId: "__commerceCartId",
  commerceCartLineId: "__commerceCartLineId",
  commerceCartTotal: "__commerceCartTotal",
  commerceCheckoutId: "__commerceCheckoutId",
  commerceCartSnapshot: "__commerceCartSnapshot",
  commerceOrderId: "__commerceOrderId",
  /** The customer decided to buy (or asked to check out): BARRY carries the cart forward to checkout. */
  commerceCheckoutRequested: "__commerceCheckoutRequested",
  /**
   * The customer decided to buy what they're choosing THIS turn. Only an
   * intent: it becomes checkout eligibility (commerceCheckoutRequested)
   * solely when the requested cart mutation verifiably succeeds.
   */
  commerceCheckoutOnSuccess: "__commerceCheckoutOnSuccess",
  /**
   * The customer DECIDED to buy what they're choosing this turn (playbook: on_purchase_decision) but
   * did not ask to check out: once the cart change verifiably succeeds, BARRY OFFERS checkout — it
   * never starts collecting checkout details or pricing on that basis.
   */
  commerceCheckoutOfferOnSuccess: "__commerceCheckoutOfferOnSuccess",
  /** A checkout offer is due to the customer (consumed by the one reply that makes it). */
  commerceCheckoutOffered: "__commerceCheckoutOffered",
  /** A discount the runtime granted (allowed by policy or approved by the owner): {pct, item, cartId}. Only this ever prices a checkout. */
  discountGranted: "__discountGranted",
  /** The customer decided to buy the selected offer (consent to send a payment link). */
  purchaseDecided: "__purchaseDecided",
  /** The language this conversation is held in (from the latest customer message with words). */
  conversationLanguage: "__conversationLanguage",
  /** Recent results of generic capability calls (JSON), for the next reasoning step. */
  capabilityResults: "__capabilityResults",
};

/**
 * Grounds commerce semantics against what BARRY actually showed/holds.
 * The model says "the first one"; the ids come ONLY from persisted state
 * written by real tool results. Never trusts a product/line id from IR.
 */
/**
 * Which shown product does the customer mean? DETERMINISTIC grounding of a
 * reference the model already understood — never language interpretation:
 *  - an explicit position the model gave -> that result, if it exists;
 *  - an explicit position that grounding rejected -> nothing (ask, never guess);
 *  - no position ("it", "that one", "I'll take it"): the item BARRY is
 *    currently waiting on (a pending variant choice), else the ONLY shown
 *    result when exactly one was shown; with several, nothing (ask).
 */
function resolveShownProduct(commerce: NonNullable<BarryIR["commerce"]>, known: Record<string, string>): string | undefined {
  const lastIds = known[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
  if (commerce.referenceInvalid) return undefined;
  if (commerce.reference?.type === "previous_result") return lastIds[commerce.reference.index];
  const pending = known[SCRATCH_KEYS.commercePendingProductId];
  if (pending) return pending;
  return lastIds.length === 1 ? lastIds[0] : undefined;
}

/**
 * THE product a NAMED item to add/ask about grounds to — the one canonical binding of a customer's
 * name to a catalog item. Candidates are real, provider-read products only: what BARRY showed, what
 * the cart holds, and the catalog lookup made for exactly this name. Exactly one product may carry the
 * name; none or several means NOTHING is added (the customer is asked). A pending choice, the only
 * shown item, the last-touched line or a position never stand in for a name — and a position that
 * points at a different product than the name is a conflict, not a choice.
 */
export function groundNamedProduct(commerce: NonNullable<BarryIR["commerce"]>, known: Record<string, string>, options: CompileOptions): CartSubjectGrounding {
  const named = commerce.subject!.trim();
  const base = { named };
  const namedBy = (title: string) => lineNamedBy(named, { title, options: {} });
  const candidates = new Map<string, { id: string; title: string; from: "shown" | "catalog" }>();
  for (const p of options.shownProducts ?? []) if (namedBy(p.title) && !candidates.has(p.id)) candidates.set(p.id, { id: p.id, title: p.title, from: "shown" });
  for (const l of options.cartLines ?? []) if (l.productId && namedBy(l.title) && !candidates.has(l.productId)) candidates.set(l.productId, { id: l.productId, title: l.title, from: "shown" });
  for (const p of options.namedProducts ?? []) if (namedBy(p.title) && !candidates.has(p.id)) candidates.set(p.id, { id: p.id, title: p.title, from: "catalog" });
  const found = [...candidates.values()];
  if (found.length === 0) return { ...base, basis: "not_in_catalog", candidates: (options.shownProducts ?? []).map((p) => p.title) };
  if (found.length > 1) return { ...base, basis: "ambiguous", candidates: found.map((p) => p.title) };
  const chosen = found[0];
  if (!commerce.referenceInvalid && commerce.reference?.type === "previous_result") {
    const lastIds = known[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
    const byPosition = lastIds[commerce.reference.index];
    if (byPosition && byPosition !== chosen.id) return { ...base, basis: "conflict", candidates: [chosen.title] };
  }
  return { ...base, basis: chosen.from, product: { id: chosen.id, title: chosen.title } };
}

/** The named product for a select/inquire, recorded for the Inspector; undefined when the name grounds to no single product. */
function resolveNamedProduct(commerce: NonNullable<BarryIR["commerce"]>, known: Record<string, string>, options: CompileOptions): { productId?: string; grounding: CartSubjectGrounding } {
  const grounding = groundNamedProduct(commerce, known, options);
  if (options.debug) options.debug.cartSubject = grounding;
  return { productId: grounding.product?.id, grounding };
}

function unresolvedNamedAdd(grounding: CartSubjectGrounding, options: CompileOptions): CompileOutcome {
  return {
    kind: "cart_subject_unresolved",
    subject: grounding.named ?? "",
    reason: grounding.basis === "ambiguous" ? "ambiguous_catalog" : grounding.basis === "conflict" ? "conflict" : "not_in_catalog",
    inCart: grounding.basis === "ambiguous" ? (grounding.candidates ?? []) : (options.cartLines?.map((l) => l.title) ?? []),
    stage: "offer_selection",
  };
}

function compileCommerce(ir: BarryIR, known: Record<string, string>, options: CompileOptions = {}): CompileOutcome | undefined {
  const commerce = ir.commerce!;
  const lastIds = known[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
  const cartId = known[SCRATCH_KEYS.commerceCartId];
  const lineId = known[SCRATCH_KEYS.commerceCartLineId];

  switch (commerce.intent) {
    case "search":
      return finalizeAction(
        "searchProducts",
        {
          text: commerce.query?.text,
          category: commerce.query?.category,
          attributes: commerce.query?.attributes,
          options: commerce.variant,
          budgetAmount: commerce.query?.budget?.amount,
          currency: commerce.query?.budget?.currency,
        },
        "discovery",
        "completePurchase"
      );

    case "select": {
      // A NAMED item is bound to exactly one real product (shown, in the cart, or looked up in the
      // catalog by that name) — never to a pending choice, the only shown item or a nearby product.
      // Ungrounded or ambiguous: nothing is added; the customer hears exactly why.
      const named = commerce.subject?.trim() ? resolveNamedProduct(commerce, known, options) : undefined;
      if (named && !named.productId) return unresolvedNamedAdd(named.grounding, options);
      const productId = named?.productId ?? resolveShownProduct(commerce, known);
      if (!productId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      // Completing a swap that was waiting on a variant choice.
      const pendingReplace =
        !commerce.reference && productId === known[SCRATCH_KEYS.commercePendingProductId] ? known[SCRATCH_KEYS.commercePendingReplaceLineId] : undefined;
      return finalizeAction(
        "addToCart",
        {
          productId,
          options: commerce.variant,
          quantity: commerce.quantity ?? 1,
          ...(pendingReplace && cartId ? { replaceLine: { cartId, lineId: pendingReplace } } : {}),
        },
        "offer_selection",
        "completePurchase"
      );
    }

    case "inquire": {
      // A question about a shown product is answered from the provider's
      // real data re-read this turn — never from the model's belief.
      const named = commerce.subject?.trim() ? resolveNamedProduct(commerce, known, options) : undefined;
      if (named && !named.productId) return unresolvedNamedAdd(named.grounding, options);
      const productId = named?.productId ?? resolveShownProduct(commerce, known);
      const product = productId ? [...(options.shownProducts ?? []), ...(options.namedProducts ?? [])].find((p) => p.id === productId) : undefined;
      if (!product) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      return { kind: "product_info", productTitle: product.title, variants: product.variants, asked: commerce.variant, stage: "offer_selection" };
    }

    case "replace": {
      // Without an item in the cart there is nothing to replace: it is a plain selection.
      if (!cartId || !lineId) return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select" } }, known, options);
      const productId = !commerce.referenceInvalid && commerce.reference?.type === "previous_result" ? lastIds[commerce.reference.index] : undefined;
      if (!productId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      // The line being replaced: the one the customer named (never another), else the only/remembered line.
      const replaced = resolveCartLine({ ...commerce, reference: undefined }, known, options);
      const g = options.debug?.cartSubject;
      if (!replaced && commerce.subject && g) return { kind: "cart_subject_unresolved", subject: commerce.subject, reason: g.basis as "not_in_cart", inCart: options.cartLines?.map((l) => l.title) ?? [], stage: "offer_selection" };
      if (!replaced) return { kind: "clarify_reference", available: options.cartLines?.length ?? 0, stage: "offer_selection" };
      return finalizeAction(
        "addToCart",
        { productId, options: commerce.variant, quantity: commerce.quantity ?? 1, replaceLine: { cartId, lineId: replaced } },
        "offer_selection",
        "completePurchase"
      );
    }

    case "change_variant":
    case "change_quantity":
    case "remove": {
      const targetLine = resolveCartLine(commerce, known, options);
      // A NAMED target that grounds to no single line: nothing is changed, and the customer hears exactly why.
      const unresolved = options.debug?.cartSubject;
      if (!targetLine && commerce.subject && unresolved && ["not_in_cart", "ambiguous", "conflict", "keep", "unreadable"].includes(unresolved.basis)) {
        return { kind: "cart_subject_unresolved", subject: commerce.subject, reason: unresolved.basis as "not_in_cart", inCart: options.cartLines?.map((l) => l.title) ?? [], stage: "offer_selection" };
      }
      if (!targetLine && unresolved?.basis === "keep") return { kind: "clarify_reference", available: options.cartLines?.length ?? 0, stage: "offer_selection" };
      // BARRY just asked which option the customer wants for a pending
      // item; an option named without pointing at a cart line answers it.
      if (commerce.intent === "change_variant" && known[SCRATCH_KEYS.commercePendingProductId] && commerce.reference?.type !== "cart_line") {
        return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select", reference: undefined } }, known, options);
      }
      if (!cartId || !targetLine) {
        // Nothing in the cart yet: a variant choice completes a pending selection.
        const cartEmpty = !cartId || (options.cartLines ? options.cartLines.length === 0 : !lineId);
        if (cartEmpty && commerce.intent === "change_variant" && (known[SCRATCH_KEYS.commercePendingProductId] || lastIds.length === 1)) {
          return compileCommerce({ ...ir, commerce: { ...commerce, intent: "select", reference: undefined } }, known, options);
        }
        return { kind: "clarify_reference", available: options.cartLines?.length ?? lastIds.length, stage: "offer_selection" };
      }
      return finalizeAction(
        "updateCartLine",
        {
          cartId,
          lineId: targetLine,
          options: commerce.intent === "change_variant" ? commerce.variant : undefined,
          quantity: commerce.intent === "remove" ? 0 : commerce.quantity,
        },
        "offer_selection",
        "completePurchase"
      );
    }

    case "checkout":
      if (!cartId) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
      // The request is recorded in compileCore; the goal planner decides what checkout still needs.
      return undefined;

    case "negotiate_price": {
      const total = known[SCRATCH_KEYS.commerceCartTotal] ? (JSON.parse(known[SCRATCH_KEYS.commerceCartTotal]) as { amount: number; currency: string }) : undefined;
      if (!commerce.requestedPrice) return undefined;
      return { kind: "price_request", requested: commerce.requestedPrice, current: total, stage: "offer_selection" };
    }
  }
}

/**
 * STATE-DRIVEN commerce goal planner: once the customer has decided to
 * buy (or asked to check out), the next safe step toward completePurchase
 * is derived from real state alone — never from new customer words — so
 * the runtime can run it as a continuation. It stops at anything that
 * needs a human: missing customer details, or a provider that can't do it.
 */
function planCommerceGoal(graph: BusinessGraph, known: Record<string, string>, options: CompileOptions): CompileOutcome | undefined {
  const cartId = known[SCRATCH_KEYS.commerceCartId];
  if (!cartId) return undefined;
  if (known[SCRATCH_KEYS.paymentRequestId] || known[SCRATCH_KEYS.paid] || known[SCRATCH_KEYS.commerceOrderId]) return undefined;
  if (!known[SCRATCH_KEYS.commerceCheckoutRequested]) {
    // A decided customer (per the playbook) is OFFERED checkout once — nothing is collected or priced
    // until they take it up; their next message is understood like any other.
    if (known[SCRATCH_KEYS.commerceCheckoutOffered]) {
      delete known[SCRATCH_KEYS.commerceCheckoutOffered];
      const total = known[SCRATCH_KEYS.commerceCartTotal] ? (JSON.parse(known[SCRATCH_KEYS.commerceCartTotal]) as { amount: number; currency: string }) : undefined;
      return { kind: "offer_checkout", ...(total ? { total } : {}), stage: "offer_selection" };
    }
    return undefined;
  }

  const missingFields = graph.playbook.commerce.checkoutRequires.filter((field) => !known[field]);
  if (missingFields.length > 0) return { kind: "checkout_needs_info", missingFields, stage: "info_gathering" };

  const supported = actionSupported(options.profiles, "createCommerceCheckout");
  if (!supported.ok) return { kind: "capability_unavailable", action: "createCommerceCheckout", missing: supported.missing, stage: "offer_selection" };

  const total = known[SCRATCH_KEYS.commerceCartTotal] ? (JSON.parse(known[SCRATCH_KEYS.commerceCartTotal]) as { amount: number; currency: string }) : undefined;
  // Only a discount the RUNTIME granted (policy-allowed or owner-approved, on this cart) ever prices a
  // checkout — never the customer's ask or the model's belief.
  const granted = readGrantedDiscount(known);
  // A PRODUCT-scoped grant (asked before the cart existed) applies only to that product's lines, at the
  // price it was granted for — the checkout tool re-reads the cart and fails closed if the price changed.
  const discount =
    granted && granted.cartId === cartId
      ? { discountPct: granted.pct, discountItem: granted.item }
      : granted?.productId
        ? { discountPct: granted.pct, discountItem: granted.item, discountProductId: granted.productId, ...(typeof granted.unitAmount === "number" ? { discountUnitAmount: granted.unitAmount } : {}), ...(granted.variant ? { discountVariant: granted.variant } : {}) }
        : {};
  return finalizeAction(
    "createCommerceCheckout",
    // expectedTotal lets policy judge the real amount; the tool refuses if the provider's total differs.
    { cartId, ...(total ? { expectedTotal: total, amount: total.amount } : {}), ...discount },
    "payment",
    "completePurchase"
  );
}

/** A runtime-granted discount: on a cart, or (asked before any cart) on one product at one unit price. */
export type GrantedDiscount = { pct: number; item: string; cartId?: string; productId?: string; unitAmount?: number; currency?: string; variant?: Record<string, string> };

export function readGrantedDiscount(known: Record<string, string>): GrantedDiscount | undefined {
  try {
    const raw = known[SCRATCH_KEYS.discountGranted];
    const g = raw ? (JSON.parse(raw) as GrantedDiscount) : undefined;
    return g && typeof g.pct === "number" && g.pct > 0 && typeof g.item === "string" && (typeof g.cartId === "string" || typeof g.productId === "string") ? g : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A discount the customer asks for on a cart is a DISCOUNT ACTION with exact terms (percentage, the
 * item it applies to, the total before and after) — granted by policy when within the business's
 * automatic limit, else an owner request that resumes exactly this grant once. Never a handoff, never
 * a checkout, never applied from the ask itself.
 */
function planDiscountGrant(ir: BarryIR, known: Record<string, string>, options: CompileOptions): CompileOutcome | undefined {
  const pct = ir.constraints.discountPct;
  const cartId = known[SCRATCH_KEYS.commerceCartId];
  if (!pct || pct <= 0 || pct >= 100 || ir.withdrawsRequest) return undefined;
  if (known[SCRATCH_KEYS.paid] || known[SCRATCH_KEYS.commerceOrderId]) return undefined;
  const mutating = ir.commerce && ["select", "replace", "change_variant", "change_quantity", "remove"].includes(ir.commerce.intent);
  if (mutating) return undefined;
  const lines = options.cartLines ?? [];
  // No cart (or nothing in it): the discount is asked on a PRODUCT — grounded in the real catalog first.
  // (Only for a commerce request about an item — a search or an offer/booking is never re-read as one.)
  if (!cartId || (options.cartLines && lines.length === 0)) return ir.commerce && !["search", "checkout"].includes(ir.commerce.intent) ? planProductDiscount(ir, pct, known, options) : undefined;
  const already = readGrantedDiscount(known);
  if (already && already.cartId === cartId && already.pct === pct) return undefined;
  // The item it applies to: the line the customer named (grounded exactly), else the only line, else the whole cart.
  let item = "the whole cart";
  if (ir.commerce?.subject?.trim()) {
    const g = groundCartSubject({ ...ir.commerce, intent: "change_quantity" }, known, options);
    if (options.debug) options.debug.cartSubject = g;
    // Named, not in the cart, but a real catalog product: the discount is asked on that product.
    if (!g.line && g.basis === "not_in_cart" && groundNamedProduct(ir.commerce, known, options).product) return planProductDiscount(ir, pct, known, options);
    if (!g.line) return { kind: "cart_subject_unresolved", subject: ir.commerce.subject, reason: g.basis === "ambiguous" ? "ambiguous" : "not_in_cart", inCart: lines.map((l) => l.title), stage: "offer_selection" };
    item = g.line.title;
  } else if (lines.length === 1) {
    item = lines[0].title;
  }
  const total = known[SCRATCH_KEYS.commerceCartTotal] ? (JSON.parse(known[SCRATCH_KEYS.commerceCartTotal]) as { amount: number; currency: string }) : undefined;
  return finalizeAction(
    "grantDiscount",
    { cartId, discountPct: pct, item, ...(total ? { currency: total.currency, listAmount: total.amount } : {}) },
    "offer_selection",
    "completePurchase"
  );
}

const parsePrice = (p: string): { amount: number; currency: string } | undefined => {
  const m = /^\s*(\d+(?:\.\d+)?)\s+([A-Za-z]{3})\s*$/.exec(p);
  return m ? { amount: Number(m[1]), currency: m[2].toUpperCase() } : undefined;
};
const optionsCarry = (options: Record<string, string>, wanted: Record<string, string> | undefined) => {
  if (!wanted) return true;
  const have = Object.fromEntries(Object.entries(options).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
  return Object.entries(wanted).every(([k, v]) => have[k.toLowerCase()] === String(v).toLowerCase());
};

/**
 * A discount asked on a PRODUCT before any cart exists ("10% off <a named item>?"): the name
 * is grounded to exactly one real catalog product (never invented); the price the terms are made on is
 * the one price the matching variants share — when variants differ in price and none was named, the
 * customer is asked only for that option. The result is a grantDiscount on that product, decided by
 * policy like any discount: within the limit it is granted, above it the owner approves EXACT terms.
 * It never adds to a cart and never starts a checkout.
 */
function planProductDiscount(ir: BarryIR, pct: number, known: Record<string, string>, options: CompileOptions): CompileOutcome | undefined {
  const lastIds = known[SCRATCH_KEYS.commerceLastProductIds]?.split(",").filter(Boolean) ?? [];
  const commerce = ir.commerce;
  let productId: string | undefined;
  if (commerce?.subject?.trim()) {
    const named = resolveNamedProduct(commerce, known, options);
    if (!named.productId) return unresolvedNamedAdd(named.grounding, options);
    productId = named.productId;
  } else {
    productId = commerce ? resolveShownProduct(commerce, known) : known[SCRATCH_KEYS.commercePendingProductId] || (lastIds.length === 1 ? lastIds[0] : undefined);
  }
  const product = productId ? [...(options.shownProducts ?? []), ...(options.namedProducts ?? [])].find((p) => p.id === productId) : undefined;
  if (!productId || !product) return { kind: "clarify_reference", available: lastIds.length, stage: "offer_selection" };
  const wanted = commerce?.variant && Object.keys(commerce.variant).length > 0 ? commerce.variant : undefined;
  const matching = product.variants.filter((v) => optionsCarry(v.options, wanted));
  const askOption = (available: Record<string, string>[]): CompileOutcome => ({ kind: "ask_variant", productTitle: product.title, ...(wanted ? { requested: wanted } : {}), availableOptions: available, stage: "offer_selection" });
  if (matching.length === 0) return askOption(product.variants.map((v) => v.options));
  const prices = [...new Map(matching.map((v) => parsePrice(v.price)).filter((x): x is { amount: number; currency: string } => Boolean(x)).map((x) => [`${x.amount}:${x.currency}`, x])).values()];
  if (prices.length !== 1 || matching.some((v) => !parsePrice(v.price))) return askOption(matching.map((v) => v.options));
  const already = readGrantedDiscount(known);
  if (already && already.productId === productId && already.pct === pct && already.unitAmount === prices[0].amount) return undefined;
  // The variant is part of the terms only when it is what made the price unique.
  const pricedByVariant = wanted && new Set(product.variants.map((v) => v.price)).size > 1;
  return finalizeAction(
    "grantDiscount",
    { productId, discountPct: pct, item: product.title, currency: prices[0].currency, listAmount: prices[0].amount, ...(pricedByVariant ? { variant: wanted } : {}) },
    "offer_selection"
  );
}

/** One generic capability call as an action — or what the customer still needs to provide for it. */
export function planCapabilityCall(request: NonNullable<BarryIR["capabilityRequest"]>, stage: ConversationStage): CompileOutcome | undefined {
  const contract = getCapability(request.capability);
  if (!contract) return undefined;
  const { idempotencyKey: _k, ...semantic } = request.input;
  void _k;
  const probe = contract.idempotency === "key_required" ? { ...semantic, idempotencyKey: "probe-key-00000000" } : semantic;
  const parsed = contract.input.safeParse(probe);
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.filter((i) => i.path.length > 0 && semantic[String(i.path[0])] === undefined).map((i) => String(i.path[0])))];
    if (missing.length > 0) return { kind: "capability_needs_input", capability: request.capability, missingFields: missing, stage };
    return { kind: "compiler_error", reason: `The ${request.capability} request does not fit its contract`, stage };
  }
  return finalizeAction(INVOKE_CAPABILITY, { capability: request.capability, input: semantic, purpose: request.purpose.slice(0, 300) }, stage);
}


/** Validate a deterministically-assembled input against the tool's real Zod schema before it can ever become an "action" outcome. */
function finalizeAction(
  name: string,
  input: Record<string, unknown>,
  stage: ConversationStage,
  goal?: Goal
): CompileOutcome {
  const tool = getTool(name);
  if (!tool) {
    return { kind: "compiler_error", reason: `Unknown tool "${name}"`, stage };
  }
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    console.error("[barry:compiler] assembled input failed schema validation", {
      tool: name,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
    });
    return { kind: "compiler_error", reason: `Could not assemble a complete "${name}" call yet`, stage };
  }
  // Return the original assembled input, not the Zod-stripped `parsed.data`
  // — some fields (discountPct, isCustomPrice) are policy-relevant metadata
  // the tool's own schema doesn't declare but decide() still needs to see.
  // `callTool()` re-validates against the tool schema at execution time
  // regardless, so this loses no safety.
  return { kind: "action", action: { name, input }, stage, goal };
}

/** The read an offer supports (open times for bookable services, stock for stocked goods) — never a write. */
function plannedRead(offer: Offer, known: Record<string, string>, stage: ConversationStage): CompileOutcome | undefined {
  if (offer.requiresScheduling) {
    const earliest = known[SCRATCH_KEYS.mentionedEarliest];
    if (!earliest) return { kind: "ask_datetime", offerName: offer.name, stage };
    return finalizeAction(
      "checkAvailability",
      { offerId: offer.id, earliest, latest: known[SCRATCH_KEYS.mentionedLatest], partySize: Number(known[SCRATCH_KEYS.mentionedPartySize] ?? 1), ...(known[SCRATCH_KEYS.windowEndIsHard] ? { endBy: known[SCRATCH_KEYS.mentionedLatest] } : {}) },
      stage
    );
  }
  if (offer.requiresInventory) return finalizeAction("checkInventory", { offerId: offer.id, quantity: Number(known[SCRATCH_KEYS.quantity] ?? 1) }, stage);
  return undefined;
}

function missingCustomerInfo(offer: Offer, known: Record<string, string>): string[] {
  return offer.requiredCustomerInfo.filter((field) => !known[field]);
}

/**
 * Answers a small, recognized set of fact questions straight from the
 * resolved Offer — never invented, never requiring any transaction-gate
 * field first. `requestedCapability` is advisory (a reasoner's best guess
 * at intent); an unrecognized value or a fact the offer doesn't have
 * (e.g. price on a quote-only offer) simply returns nothing, and the
 * normal flow continues.
 */
function resolveOfferFact(requestedCapability: string | undefined, offer: Offer): OfferFact | undefined {
  switch (requestedCapability) {
    case "ask_price":
      return offer.price !== null ? { type: "price", price: offer.price, currency: offer.currency } : undefined;
    case "ask_duration":
      return offer.durationMinutes !== undefined ? { type: "duration", minutes: offer.durationMinutes } : undefined;
    case "ask_deposit":
      return {
        type: "deposit",
        required: offer.requiresPayment,
        amount: offer.depositAmount,
        currency: offer.currency,
      };
    default:
      return undefined;
  }
}

function resolveOfferId(graph: BusinessGraph, state: ConversationState, ir: BarryIR): string | undefined {
  // The CURRENT task wins over stale context: when the customer names another offer and nothing is
  // committed on the old one (no link, slot, decision or pending request), the named offer is the subject.
  const k = state.knownFields;
  const committed = Boolean(k[SCRATCH_KEYS.paymentRequestId] || k[SCRATCH_KEYS.offeredStart] || k[SCRATCH_KEYS.purchaseDecided] || state.pendingApprovalId);
  if (ir.selectedOfferId && ir.selectedOfferId !== state.selectedOfferId && findOffer(graph, ir.selectedOfferId) && !committed) {
    delete k[SCRATCH_KEYS.inventoryChecked];
    return ir.selectedOfferId;
  }
  // Sticky: once an offer is chosen for this conversation, new candidate
  // guesses from later turns never override it.
  if (state.selectedOfferId && findOffer(graph, state.selectedOfferId)) {
    return state.selectedOfferId;
  }

  if (ir.selectedOfferId && findOffer(graph, ir.selectedOfferId)) {
    return ir.selectedOfferId;
  }

  return undefined;
}

/**
 * The deterministic Action Compiler. Takes BARRY IR (what the customer
 * seems to want, per whichever Reasoner produced it) plus the accumulated
 * ConversationState plus the Business Graph, and decides what BARRY does
 * next. Never performs I/O. Never trusts IR enough to skip validating a
 * compiled tool input against the tool's own schema.
 *
 * Thin wrapper so every return point inside `compileCore` stays a plain
 * `CompileOutcome` (existing tests destructure `outcome.kind` etc. and
 * must keep working) while still attaching debug/observability info
 * uniformly at the one exit point, instead of touching every return.
 */
export type CompileOptions = {
  /** What the business's connected providers can actually do (planning never promises what they can't). */
  profiles?: CapabilityProfiles;
  /** What BARRY last showed, re-read from the provider this turn (real ids, real stock). */
  shownProducts?: ShownProduct[];
  /** The cart's lines as the provider holds them now, with real ids, in the order shown to the customer. */
  cartLines?: NonNullable<GroundedContext["cartLines"]>;
  /** Catalog products looked up for the item the customer NAMED this turn (real ids), so a name grounds to a catalog item. */
  namedProducts?: NonNullable<GroundedContext["namedProducts"]>;
  /** Filled by compile(): how a cart change was bound to its line (for the Inspector). */
  debug?: CompileDebugInfo;
};

/**
 * THE exact cart line a mutation targets — the one canonical binding of a cart change to a line.
 *
 * - The customer NAMED the target (commerce.subject): only a cart line that name identifies may be
 *   changed. No such line -> nothing is changed (not_in_cart); several -> ambiguous; a position that
 *   points at a different line -> conflict. Never the only line, the last-touched line or a position.
 * - An item the customer said to KEEP is never the target (contrast evidence against inversion).
 * - Otherwise: the line their position grounds to in the REAL cart, or the only line when there is
 *   exactly one. Several lines and no reference: nothing is guessed. Unreadable cart + named target:
 *   nothing is changed. Name matching is structural (all of the name's words appear in the line's
 *   title/options, any script) — never language rules.
 */
const nameWords = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 || /\p{N}/u.test(w));

type CartLine = NonNullable<CompileOptions["cartLines"]>[number];

export function lineNamedBy(name: string, line: Pick<CartLine, "title" | "options">): boolean {
  const wanted = nameWords(name);
  if (wanted.length === 0) return false;
  const have = new Set(nameWords([line.title, ...Object.values(line.options ?? {})].join(" ")));
  return wanted.every((w) => have.has(w));
}

export function groundCartSubject(commerce: NonNullable<BarryIR["commerce"]>, known: Record<string, string>, options: CompileOptions): CartSubjectGrounding {
  const lines = options.cartLines;
  const named = commerce.subject?.trim() || undefined;
  const keep = commerce.keep?.filter((k) => k.trim()) ?? [];
  const base = { ...(named ? { named } : {}), ...(keep.length ? { keep } : {}) };
  const view = (l: CartLine) => ({ id: l.id, title: l.title, options: l.options, quantity: l.quantity });
  if (!lines) {
    if (named || keep.length) return { ...base, basis: "unreadable" };
    const remembered = known[SCRATCH_KEYS.commerceCartLineId];
    return remembered ? { ...base, basis: "remembered", line: { id: remembered, title: "", options: {}, quantity: 0 } } : { ...base, basis: "no_reference" };
  }
  const titles = lines.map((l) => l.title + (Object.keys(l.options).length ? ` (${Object.values(l.options).join(" / ")})` : ""));
  if (commerce.referenceInvalid) return { ...base, basis: "invalid_reference", candidates: titles };
  const byReference = commerce.reference?.type === "cart_line" ? lines[commerce.reference.index] : undefined;
  let chosen: CartLine | undefined;
  let basis: CartSubjectGrounding["basis"];
  if (named) {
    let matches = lines.filter((l) => lineNamedBy(named, l));
    if (matches.length === 0) return { ...base, basis: "not_in_cart", candidates: titles };
    // Requested options narrow several same-named lines (e.g. two sizes of one product).
    if (matches.length > 1 && commerce.variant && commerce.intent !== "change_variant") {
      const narrowed = matches.filter((l) => Object.entries(commerce.variant!).every(([k, v]) => Object.entries(l.options).some(([lk, lv]) => lk.toLowerCase() === k.toLowerCase() && lv.toLowerCase() === v.toLowerCase())));
      if (narrowed.length > 0) matches = narrowed;
    }
    if (byReference && !matches.includes(byReference)) return { ...base, basis: "conflict", candidates: matches.map((l) => l.title) };
    if (matches.length > 1 && !byReference) return { ...base, basis: "ambiguous", candidates: matches.map((l) => l.title + (Object.keys(l.options).length ? ` (${Object.values(l.options).join(" / ")})` : "")) };
    chosen = byReference ?? matches[0];
    basis = "subject";
  } else if (commerce.reference?.type === "cart_line") {
    chosen = byReference;
    basis = "reference";
    if (!chosen) return { ...base, basis: "invalid_reference", candidates: titles };
  } else if (lines.length === 1) {
    chosen = lines[0];
    basis = "only_line";
  } else {
    return { ...base, basis: "no_reference", candidates: titles };
  }
  // A line the customer said to keep is never the one changed.
  if (keep.some((k) => lineNamedBy(k, chosen!))) {
    return { ...base, basis: "keep", line: view(chosen), candidates: titles };
  }
  return { ...base, basis, line: view(chosen) };
}

function resolveCartLine(commerce: NonNullable<BarryIR["commerce"]>, known: Record<string, string>, options: CompileOptions): string | undefined {
  const g = groundCartSubject(commerce, known, options);
  if (options.debug) options.debug.cartSubject = g;
  return g.line?.id;
}

type ShownProduct = NonNullable<GroundedContext["shownProducts"]>[number];

export function compile(graph: BusinessGraph, state: ConversationState, ir: BarryIR, options: CompileOptions = {}): CompileOutcome {
  const debug: CompileDebugInfo = { appliedCustomerInfo: {} };
  const outcome = compileCore(graph, state, ir, debug, { ...options, debug });
  return { ...outcome, debug };
}

function compileCore(graph: BusinessGraph, state: ConversationState, ir: BarryIR, debug: CompileDebugInfo, options: CompileOptions): CompileOutcome {
  const known = state.knownFields;
  const scratchUpdate: Record<string, string> = {};
  // The ONLY place a semantic scheduling constraint ("Sunday", "at 2pm")
  // becomes an absolute timestamp — using the business's own timezone,
  // never the server's or a hardcoded one. Neither Reasoner is ever asked
  // to compute this itself.
  if (ir.constraints.schedulingWindow) {
    let window = ir.constraints.schedulingWindow;
    // A TIME-ONLY constraint (e.g. "actually 5pm instead" — a correction
    // that never re-states the day) must not silently reset the day to
    // today when a day was already established earlier in this same
    // conversation. Carry the last EXPLICIT date forward only when this
    // turn's constraint supplied none itself; a turn that does name a
    // date always wins outright and becomes the new carryover value.
    if (!window.date && state.knownFields[SCRATCH_KEYS.lastSchedulingDate]) {
      const lastDate = JSON.parse(state.knownFields[SCRATCH_KEYS.lastSchedulingDate]);
      window = { ...window, date: lastDate };
    }
    // Symmetrically, a DAY-ONLY mention ("Friday", or a later turn restating the day) keeps the
    // time the customer already set — it never silently widens back to the whole day.
    if (!window.time && state.knownFields[SCRATCH_KEYS.lastSchedulingTime]) {
      const last = JSON.parse(state.knownFields[SCRATCH_KEYS.lastSchedulingTime]);
      // Stored as the whole time constraint (start, explicit end, exclusivity) — carried together.
      window = "kind" in last ? { ...window, time: last } : { ...window, ...last };
    }
    const resolved = resolveSchedulingWindow(window, graph.business.timezone);
    if (resolved) {
      if (
        known[SCRATCH_KEYS.offeredStart] &&
        known[SCRATCH_KEYS.offeredStart] !== resolved.earliest &&
        !ir.constraints.slotAccepted
      ) {
        delete known[SCRATCH_KEYS.offeredStart];
        delete known[SCRATCH_KEYS.offeredEnd];
        delete known[SCRATCH_KEYS.offeredResource];
        delete known[SCRATCH_KEYS.slotAccepted];
      }
      scratchUpdate[SCRATCH_KEYS.mentionedEarliest] = resolved.earliest;
      scratchUpdate[SCRATCH_KEYS.mentionedLatest] = resolved.latest;
      debug.resolvedSchedulingWindow = resolved;
    }
    if (window.date) {
      scratchUpdate[SCRATCH_KEYS.lastSchedulingDate] = JSON.stringify(window.date);
    }
    if (window.time) {
      scratchUpdate[SCRATCH_KEYS.lastSchedulingTime] = JSON.stringify({ time: window.time, ...(window.end ? { end: window.end } : {}), ...(window.startExclusive ? { startExclusive: true } : {}) });
    }
    if (resolved?.explicitEnd) scratchUpdate[SCRATCH_KEYS.windowEndIsHard] = "1";
    else if (resolved) scratchUpdate[SCRATCH_KEYS.windowEndIsHard] = "";
  }
  if (ir.constraints.partySize && ir.constraints.partySize > 1) {
    scratchUpdate[SCRATCH_KEYS.mentionedPartySize] = String(ir.constraints.partySize);
  } else if (ir.constraints.partySize === 1) {
    delete known[SCRATCH_KEYS.mentionedPartySize];
  }
  if (ir.constraints.discountPct) {
    scratchUpdate[SCRATCH_KEYS.discountPct] = String(ir.constraints.discountPct);
  }
  // A stated hard cap (or a search budget) binds every later payment write until the customer changes it.
  const cap = ir.constraints.budgetMax ?? ir.commerce?.query?.budget?.amount;
  if (cap && cap > 0) {
    scratchUpdate[SCRATCH_KEYS.budgetCap] = JSON.stringify({ amount: cap, includesShipping: ir.constraints.budgetIncludesShipping === true });
  }
  if (ir.constraints.quantity && Number.isInteger(ir.constraints.quantity) && ir.constraints.quantity > 0 && ir.constraints.quantity <= 1000) {
    scratchUpdate[SCRATCH_KEYS.quantity] = String(ir.constraints.quantity);
  }
  if (ir.constraints.slotAccepted) {
    scratchUpdate[SCRATCH_KEYS.slotAccepted] = "1";
  }
  if (ir.purchaseDecision === true) {
    scratchUpdate[SCRATCH_KEYS.purchaseDecided] = "1";
  }
  // `customerInfo` is THE single authoritative key/value bag for
  // customer-provided identity fields (name/email/phone/...) — a
  // reasoner controls the KEY NAMES, not just the values. `__`-prefixed
  // keys are the compiler's own scratch namespace (booking slots,
  // payment/approval state, discount %, ...); never let untrusted IR set
  // one directly, or a hallucinating/adversarial model could fabricate
  // e.g. `{ key: "__paid", value: "1" }` and have it treated as a
  // verified payment confirmation without the payment tool ever having
  // run. Only the runtime (patchStateAfterTool, webhook handlers) may
  // ever write a scratch key.
  //
  // Live bug: a strict-JSON-schema Reasoner sometimes literalizes a
  // sentinel string ("null", "undefined", ...) in place of actually
  // omitting a key/value pair it has nothing new to report for.
  // normalizeCustomerInfoField() rejects those (and empty/whitespace
  // values) BEFORE they ever reach persistent state — an empty/sentinel
  // value must never overwrite a real one already on file. This is the
  // ONE place ANY reasoner's customer-info values are trusted from, and
  // it runs BEFORE missingCustomerInfo() below computes what's still
  // missing — a value supplied this turn must count immediately.
  const appliedCustomerInfo: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(ir.customerInfo)) {
    if (key.startsWith("__")) continue;
    const value = normalizeCustomerInfoField(key, rawValue);
    if (value !== undefined) appliedCustomerInfo[key] = value;
  }
  debug.appliedCustomerInfo = appliedCustomerInfo;
  Object.assign(state.knownFields, scratchUpdate, appliedCustomerInfo);

  // The customer's CURRENT intent is authoritative over any transaction in progress. A withdrawal
  // clears every consent BARRY holds (the runtime also withdraws requests waiting on the owner);
  // a message that doesn't advance the transaction never runs the funnel (details, availability,
  // payment) — questions, status checks and recaps are answered, not converted into a next step.
  if (ir.withdrawsRequest) {
    for (const key of [
      SCRATCH_KEYS.purchaseDecided,
      SCRATCH_KEYS.commerceCheckoutRequested,
      SCRATCH_KEYS.commerceCheckoutOnSuccess,
      SCRATCH_KEYS.commerceCheckoutOfferOnSuccess,
      SCRATCH_KEYS.commerceCheckoutOffered,
      SCRATCH_KEYS.slotAccepted,
      SCRATCH_KEYS.offeredStart,
      SCRATCH_KEYS.offeredEnd,
      SCRATCH_KEYS.offeredResource,
      SCRATCH_KEYS.discountPct,
    ]) {
      delete known[key];
    }
    const somethingElse = ir.capabilityRequest || ir.knowledgeTopic || (ir.commerce && ir.commerce.intent !== "checkout") || ir.offerChangeRequested;
    if (!somethingElse) return { kind: "withdrawn", withdrawnRequests: 0, stage: state.stage === "closed" ? "closed" : "discovery" };
  }
  const advancing = ir.withdrawsRequest ? false : ir.advancesTransaction;
  // Checkout consent is its own signal: "don't check out" blocks every step toward payment this turn.
  const checkoutBlocked = ir.checkoutConsent === false;
  if (checkoutBlocked) {
    delete known[SCRATCH_KEYS.commerceCheckoutRequested];
    delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
    delete known[SCRATCH_KEYS.commerceCheckoutOfferOnSuccess];
    delete known[SCRATCH_KEYS.commerceCheckoutOffered];
  }

  if (state.stage === "closed") {
    return advancing === false ? { kind: "conversation", stage: "closed" } : { kind: "generic_confirm", stage: "closed" };
  }

  // A customer ASSERTING payment is a claim, never a fact. The only thing
  // BARRY does with it is ask the trusted provider (verifyPayment); paid
  // state can only come from that tool's result or a verified webhook.
  if (ir.customerClaims?.paymentCompleted && !known[SCRATCH_KEYS.paid]) {
    if (known[SCRATCH_KEYS.paymentRequestId]) {
      return finalizeAction("verifyPayment", { paymentRequestId: known[SCRATCH_KEYS.paymentRequestId] }, "payment");
    }
    return { kind: "no_payment_to_verify", stage: state.stage };
  }

  // Verified payment for a cart -> exactly one order, re-verified by the
  // tool against the payment's bound cart snapshot.
  if (known[SCRATCH_KEYS.paid] && known[SCRATCH_KEYS.commerceCartId] && !known[SCRATCH_KEYS.commerceOrderId] && known[SCRATCH_KEYS.paymentRequestId]) {
    return finalizeAction(
      "createCommerceOrder",
      { cartId: known[SCRATCH_KEYS.commerceCartId], paymentRequestId: known[SCRATCH_KEYS.paymentRequestId] },
      "confirmation",
      "completePurchase"
    );
  }

  // A proposal to use one of the business's own capabilities (already
  // grounded: on this business's surface, inputs stated by the customer or
  // known). The compiler only checks the contract's required inputs are
  // present — asking for what's missing, never guessing it. Authority and
  // system selection happen later, deterministically.
  if (ir.capabilityRequest) {
    const planned = planCapabilityCall(ir.capabilityRequest, state.stage);
    if (planned) return planned;
  }

  // Knowledge answers come verbatim from the business's own stored item
  // for the topic the model named — BARRY never paraphrases policy.
  // A message that both changes the cart and asks a question does BOTH: the mutation is executed
  // here, and the question is answered from the business's knowledge in the reply's facts.
  const mutatesCart = ir.commerce && ["select", "replace", "change_variant", "change_quantity", "remove", "checkout"].includes(ir.commerce.intent);
  if (ir.knowledgeTopic && !mutatesCart) {
    const item = graph.knowledge.find((k) => k.topic === ir.knowledgeTopic);
    if (item) return { kind: "knowledge_answer", answer: item.content, stage: state.stage };
  }

  // A discount asked on a cart is its own exact action (policy or owner decides) — before any cart planning.
  const discountStep = planDiscountGrant(ir, known, options);
  if (discountStep) return discountStep;

  if (ir.commerce) {
    // Live failure (gpt-4o-mini, "I'll take it in medium" with ONE shown item):
    // the model filed "I'll take it" as CHECKOUT while the cart was still
    // empty, and checkout-without-cart asked "which item?". Structurally,
    // asking to buy with nothing in the cart IS a decided selection of the
    // item under discussion — resolved by the same deterministic grounding
    // as any other reference (unique shown item or explicit position; else ask).
    const cartlessCheckout = ir.commerce.intent === "checkout" && !known[SCRATCH_KEYS.commerceCartId];
    if (cartlessCheckout) ir = { ...ir, commerce: { ...ir.commerce, intent: "select" } };
    // Record the customer's purchase decision (the model's judgment, applied
    // per the business playbook). A new search means they're browsing again.
    const c = ir.commerce!;
    if (c.intent === "search") {
      delete known[SCRATCH_KEYS.commerceCheckoutRequested];
      delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
      delete known[SCRATCH_KEYS.commerceCheckoutOfferOnSuccess];
      delete known[SCRATCH_KEYS.commerceCheckoutOffered];
    }
    // Consent given WITH a selection ("add it and check out") scopes to the cart as it stands after that
    // verified add (the state patch sets it); only consent about the existing cart is scoped here.
    const selecting = c.intent === "select" || c.intent === "replace";
    if ((c.intent === "checkout" || ir.checkoutConsent === true) && !checkoutBlocked && !selecting) {
      // Consent is SCOPED: an item the customer pointed at is the whole consent; a reference that
      // doesn't ground to anything real is no consent at all (ask, never check out the whole cart).
      if (c.referenceInvalid) {
        delete known[SCRATCH_KEYS.commerceCheckoutRequested];
        delete known[SCRATCH_KEYS.checkoutScope];
        return { kind: "clarify_reference", available: options.cartLines?.length ?? 0, stage: "offer_selection" };
      }
      const scopeLine =
        c.reference?.type === "cart_line"
          ? options.cartLines?.[c.reference.index]?.id
          : c.reference?.type === "previous_result"
            ? options.cartLines?.find((l) => l.title === options.shownProducts?.find((p) => p.position === c.reference!.index + 1)?.title)?.id
            : undefined;
      if (c.reference && !scopeLine) {
        delete known[SCRATCH_KEYS.commerceCheckoutRequested];
        return { kind: "clarify_reference", available: options.cartLines?.length ?? 0, stage: "offer_selection" };
      }
      known[SCRATCH_KEYS.checkoutScope] = JSON.stringify(scopeLine ? { lineIds: [scopeLine], quantity: c.quantity ?? null } : "all");
      if (c.intent === "checkout") known[SCRATCH_KEYS.commerceCheckoutRequested] = "1";
    }
    if (c.intent === "select" || c.intent === "replace" || c.intent === "change_variant" || c.intent === "change_quantity") {
      // CART INTENT is not CHECKOUT INTENT. A cart change carries checkout eligibility ONLY with the
      // customer's explicit word for checkout/payment (checkoutConsent, or "buy it" with an empty cart
      // that is a selection) — and even then only once the change verifiably succeeds (see the
      // runtime's state patch). A decision to buy (purchaseDecision) is never progression: per the
      // playbook it makes BARRY OFFER checkout after the change, and the customer's answer decides.
      // "Not ready to check out" (checkoutConsent false) blocks both.
      if (!checkoutBlocked && (cartlessCheckout || ir.checkoutConsent === true)) {
        known[SCRATCH_KEYS.commerceCheckoutOnSuccess] = "1";
        delete known[SCRATCH_KEYS.commerceCheckoutOfferOnSuccess];
      } else {
        delete known[SCRATCH_KEYS.commerceCheckoutOnSuccess];
        if (!checkoutBlocked && ir.purchaseDecision === true && graph.playbook.commerce.advanceToCheckout === "on_purchase_decision") {
          known[SCRATCH_KEYS.commerceCheckoutOfferOnSuccess] = "1";
        } else {
          delete known[SCRATCH_KEYS.commerceCheckoutOfferOnSuccess];
        }
      }
      if (ir.purchaseDecision === false) delete known[SCRATCH_KEYS.commerceCheckoutRequested];
    }
    const commerceOutcome = compileCommerce(ir, known, options);
    if (commerceOutcome) return commerceOutcome;
  }

  // Nothing new to act on from the customer's words: take the next safe
  // step toward the commerce goal, if one is in progress — unless this
  // message doesn't advance it (a question mid-checkout is answered).
  const commerceStep = advancing === false || checkoutBlocked ? undefined : planCommerceGoal(graph, known, options);
  if (commerceStep) return commerceStep;

  // An explicit decline of a previously offered slot ("no"/"לא") only
  // means anything when there's actually a slot on file to decline —
  // otherwise it's a no-op, never a spurious state change. Clears the
  // offer so the compiler falls through to `ask_datetime` again on this
  // same turn, prompting for an alternative instead of silently
  // re-asking about the same rejected slot forever.
  if (ir.constraints.slotDeclined && known[SCRATCH_KEYS.offeredStart]) {
    delete known[SCRATCH_KEYS.offeredStart];
    delete known[SCRATCH_KEYS.offeredEnd];
    delete known[SCRATCH_KEYS.offeredResource];
    delete known[SCRATCH_KEYS.slotAccepted];
    delete known[SCRATCH_KEYS.mentionedEarliest];
    delete known[SCRATCH_KEYS.mentionedLatest];
  }

  // Explicit change-of-mind ("actually, solo instead") is the ONE way the
  // sticky offer selection can be replaced mid-conversation. Ordinary
  // selectedOfferId/offerCandidateIds guesses from later turns never
  // override it (see resolveOfferId) — only this dedicated signal can,
  // and only when it actually names a different, real offer.
  if (
    ir.offerChangeRequested &&
    findOffer(graph, ir.offerChangeRequested) &&
    ir.offerChangeRequested !== state.selectedOfferId
  ) {
    state.selectedOfferId = ir.offerChangeRequested;
    // The old offer's booking/payment progress doesn't apply to the new
    // one — clear it so the new offer starts its own flow from scratch.
    // Customer identity (name/email/phone) and scheduling PREFERENCES
    // (day/time/party size the customer already stated) are kept; they're
    // not specific to which service was chosen.
    delete known[SCRATCH_KEYS.offeredStart];
    delete known[SCRATCH_KEYS.offeredEnd];
    delete known[SCRATCH_KEYS.offeredResource];
    delete known[SCRATCH_KEYS.slotAccepted];
    delete known[SCRATCH_KEYS.paymentRequestId];
    delete known[SCRATCH_KEYS.paid];
    delete known[SCRATCH_KEYS.inventoryChecked];
    delete known[SCRATCH_KEYS.purchaseDecided];
    // The party size belonged to the old service (e.g. a couples booking): the new one starts from
    // what the customer says now, never a stale party.
    if (!ir.constraints.partySize) delete known[SCRATCH_KEYS.mentionedPartySize];
  }

  let selectedOfferId = resolveOfferId(graph, state, ir);

  if (!selectedOfferId && ir.offerCandidateIds && ir.offerCandidateIds.length > 0) {
    const validCandidates = ir.offerCandidateIds.filter((id) => findOffer(graph, id));
    if (validCandidates.length === 1) {
      selectedOfferId = validCandidates[0];
    } else if (validCandidates.length > 1) {
      return {
        kind: "clarify_offer",
        offerNames: validCandidates.map((id) => findOffer(graph, id)!.name),
        stage: "discovery",
      };
    }
  }

  if (!selectedOfferId && known[SCRATCH_KEYS.mentionedEarliest]) {
    // No offer named yet, but scheduling intent is clear (a day/time was
    // mentioned). Narrow by which offers actually require scheduling
    // instead of asking a generic "what are you looking for?" again.
    const schedulable = graph.offers.filter((o) => o.active && o.requiresScheduling);
    if (schedulable.length === 1) {
      selectedOfferId = schedulable[0].id;
    } else if (schedulable.length > 1) {
      return { kind: "clarify_offer", offerNames: schedulable.map((o) => o.name), stage: "discovery" };
    }
  }

  if (!selectedOfferId) {
    if (advancing === false) return { kind: "conversation", stage: state.stage };
    return {
      kind: "ask_general",
      offerNames: graph.offers.filter((o) => o.active).map((o) => o.name).slice(0, 5),
      stage: "discovery",
    };
  }

  // Persist the resolved offer immediately — every subsequent turn's
  // resolveOfferId() call reads state.selectedOfferId, not the IR.
  state.selectedOfferId = selectedOfferId;

  const offer = findOffer(graph, selectedOfferId)!;

  // Safe Business Graph facts are answerable BEFORE any transaction-gate
  // field is collected: requiredCustomerInfo means "needed to fulfill a
  // booking/purchase," not "needed before BARRY may state a price." A
  // "How much is it?" must never be blocked on a phone number.
  // Correcting a pending request's terms is a transaction step, not a fact question.
  const fact = ir.changesPendingRequest ? undefined : resolveOfferFact(ir.requestedCapability, offer);
  if (fact) {
    return { kind: "offer_fact", offerName: offer.name, fact, stage: state.stage };
  }
  // Not advancing: nothing is asked for or bought — but an explicitly requested READ still runs
  // (open times, stock), because looking something up is not committing to anything.
  if (advancing === false) {
    if (ir.readRequested) {
      const read = plannedRead(offer, known, state.stage);
      if (read) return read;
    }
    return { kind: "conversation", stage: state.stage };
  }

  const missing = missingCustomerInfo(offer, known);
  if (missing.length > 0) {
    return { kind: "needs_info", offerName: offer.name, missingFields: missing, stage: "info_gathering" };
  }

  // This conversation's transaction already completed (booking created,
  // order fulfilled, or lead filed) — never re-issue createBooking/
  // fulfillOrder/createLead a second time. Without this guard, a
  // DUPLICATE payment webhook (the same paymentRequestId reported "paid"
  // twice — a real, expected occurrence with any real payment provider,
  // not just a test artifact) re-entered this exact code path and
  // attempted a second createBooking for the identical resource/start,
  // which the tool's own conflict check correctly rejected — but as a
  // customer-facing ERROR ("Slot no longer available... try a different
  // option?") on a booking that had, in fact, already succeeded.
  // Quote / lead-only offers: no scheduling, no inventory, no fixed price.
  if (!offer.requiresScheduling && !offer.requiresInventory && offer.price === null) {
    return finalizeAction(
      "createLead",
      { summary: `${offer.name} inquiry from customer ${state.customerId}`, contactInfo: known.email ?? known.phone },
      "confirmation",
      "qualifyLead"
    );
  }

  if (offer.requiresScheduling) {
    const offeredStart = known[SCRATCH_KEYS.offeredStart];

    if (!offeredStart) {
      const earliest = known[SCRATCH_KEYS.mentionedEarliest];
      if (!earliest) {
        return { kind: "ask_datetime", offerName: offer.name, stage: "scheduling" };
      }
      const partySize = Number(known[SCRATCH_KEYS.mentionedPartySize] ?? 1);
      return finalizeAction(
        "checkAvailability",
        { offerId: offer.id, earliest, latest: known[SCRATCH_KEYS.mentionedLatest], partySize, ...(known[SCRATCH_KEYS.windowEndIsHard] ? { endBy: known[SCRATCH_KEYS.mentionedLatest] } : {}) },
        "scheduling",
        "bookAppointment"
      );
    }

    if (!known[SCRATCH_KEYS.slotAccepted]) {
      return { kind: "ask_slot_confirm", offeredStart, stage: "scheduling" };
    }

    if (offer.requiresPayment) {
      if (!known[SCRATCH_KEYS.paymentRequestId]) {
        if (checkoutBlocked) return { kind: "conversation", stage: state.stage };
        const quote = quoteOffer(graph, offer, 1, Number(known[SCRATCH_KEYS.discountPct] ?? 0), "deposit");
        if (!quote) return { kind: "compiler_error", reason: `No deposit or price for ${offer.name}`, stage: state.stage };
        return finalizeAction("createPaymentRequest", paymentTermsFromQuote(quote, `Deposit for ${offer.name}`), "payment", "collectDeposit");
      }
      if (!known[SCRATCH_KEYS.paid]) {
        return { kind: "waiting_payment", stage: "payment" };
      }
    }

    const partySize = Number(known[SCRATCH_KEYS.mentionedPartySize] ?? 1);
    return finalizeAction(
      "createBooking",
      {
        offerId: offer.id,
        resourceId: known[SCRATCH_KEYS.offeredResource],
        start: offeredStart,
        end: known[SCRATCH_KEYS.offeredEnd],
        partySize,
      },
      "confirmation",
      "bookAppointment"
    );
  }

  if (offer.requiresInventory) {
    // Stock is checked for the quantity the customer wants now; a changed quantity re-checks.
    const quantity = Number(known[SCRATCH_KEYS.quantity] ?? 1);
    if (known[SCRATCH_KEYS.inventoryChecked] !== String(quantity) && !(quantity === 1 && known[SCRATCH_KEYS.inventoryChecked] === "1")) {
      return finalizeAction("checkInventory", { offerId: offer.id, quantity }, "payment", "completePurchase");
    }
    if (offer.requiresPayment && !known[SCRATCH_KEYS.paymentRequestId]) {
      // A payment link needs the customer's decision, not just their interest.
      if (!known[SCRATCH_KEYS.purchaseDecided]) {
        return { kind: "confirm_purchase", offerName: offer.name, stage: "offer_selection" };
      }
      if (checkoutBlocked) return { kind: "conversation", stage: state.stage };
      // ONE quantity-aware quote is the amount the owner reviews, the link charges and the reply states.
      const quote = quoteOffer(graph, offer, quantity, Number(known[SCRATCH_KEYS.discountPct] ?? 0));
      if (!quote) return { kind: "compiler_error", reason: `No price for ${offer.name}`, stage: state.stage };
      return finalizeAction("createPaymentRequest", paymentTermsFromQuote(quote, `Payment for ${offer.name}`), "payment", "completePurchase");
    }
    if (!known[SCRATCH_KEYS.paid]) {
      return { kind: "waiting_payment", stage: "payment" };
    }
    return finalizeAction("fulfillOrder", { offerId: offer.id }, "confirmation", "completePurchase");
  }

  return { kind: "generic_confirm", stage: "confirmation" };
}
