import { formatLocalDateTime } from "@/lib/scheduling/resolver";
import { money } from "./deterministic-compose";
import type { ReasonerContext } from "./types";

/**
 * The facts a reply may state, projected for the composer from the SAME sources the runtime acts
 * on: the Genome (offers with exact prices, knowledge), what BARRY showed/holds (products, cart),
 * the customer's own details, and the transaction's real state. A good employee answers from these —
 * prices are quoted exactly, a recap reflects the latest correction, a known name is never asked again.
 *
 * Deliberately excluded: policy rule text (internal), ids of systems/capabilities/approvals.
 */

const MAX_KNOWLEDGE = 40;
const MAX_TEXT = 600;

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function weekday(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(new Date(iso));
}

function localMoment(iso: string | undefined, timeZone: string, twentyFour: boolean) {
  if (!iso) return undefined;
  const d = formatLocalDateTime(iso, timeZone);
  return { day: weekday(iso, timeZone), date: d.localDate, time: twentyFour ? d.localTime24 : d.localTime };
}

export function businessFacts(ctx: ReasonerContext, lang = "en") {
  const { graph } = ctx;
  return {
    offers: graph.offers
      .filter((o) => o.active)
      .map((o) => ({
        name: o.name,
        description: clip(o.description),
        price: o.price !== null ? money(o.price, o.currency, lang) : "quote on request",
        ...(o.requiresPayment && o.depositAmount ? { deposit: money(o.depositAmount, o.currency, lang) } : {}),
        ...(o.durationMinutes ? { durationMinutes: o.durationMinutes } : {}),
        bookable: o.requiresScheduling,
      })),
    knowledge: graph.knowledge.slice(0, MAX_KNOWLEDGE).map((k) => ({ topic: k.topic, content: clip(k.content) })),
    // What BARRY showed the customer and what is in their cart, re-read from the provider this turn.
    shownProducts: ctx.grounded?.shownResults ?? [],
    cart: ctx.grounded?.cart ?? [],
    cartTotal: ctx.grounded?.cartTotal ?? null,
  };
}

/** What the customer told BARRY about themselves (their own words, already grounded) — never to be asked again. */
export function customerFacts(ctx: ReasonerContext): Record<string, string> {
  return Object.fromEntries(Object.entries(ctx.state.knownFields).filter(([k]) => !k.startsWith("__")));
}

/** Where the transaction really stands — the source for recaps and status answers. */
export function transactionFacts(ctx: ReasonerContext, lang = "en") {
  const { graph, state } = ctx;
  const k = state.knownFields;
  const tz = graph.business.timezone;
  const twentyFour = lang === "he";
  const offer = state.selectedOfferId ? graph.offers.find((o) => o.id === state.selectedOfferId) : undefined;
  const bookingConfirmed = state.stage === "closed" && state.outcome === "won" && Boolean(offer?.requiresScheduling);
  return {
    service: offer?.name ?? null,
    requestedTime: k.__mentionedEarliest ? { from: localMoment(k.__mentionedEarliest, tz, twentyFour), to: localMoment(k.__mentionedLatest, tz, twentyFour) } : null,
    offeredTime: localMoment(k.__offeredSlotStart, tz, twentyFour) ?? null,
    customerAcceptedTime: Boolean(k.__slotAccepted),
    customerDecidedToBuy: Boolean(k.__purchaseDecided || k.__commerceCheckoutRequested),
    paymentLinkSent: Boolean(k.__paymentRequestId),
    paymentVerified: Boolean(k.__paid),
    bookingConfirmed,
    orderPlaced: Boolean(k.__commerceOrderId),
    waitingOnOwner: Boolean(state.pendingApprovalId),
  };
}
