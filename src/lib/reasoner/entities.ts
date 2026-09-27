import type { BusinessGraph, Offer } from "@/lib/business-graph";
import type { SchedulingConstraint } from "@/lib/scheduling/resolver";

const STOPWORDS = new Set([
  "the", "and", "for", "any", "are", "can", "you", "that", "this", "with",
  "have", "want", "like", "need", "about", "could", "would", "please",
  "hello", "there", "morning", "afternoon", "evening", "tomorrow", "today",
  "book", "booking", "chance", "some", "your", "our", "off", "get",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Whole-word alternations, never bare substrings — "fri" alone would
// match inside "friend", "mon" inside "money", "wed" inside "wedding",
// "sun" inside "sunflower", "sat" inside "satisfied". Each pattern's
// trailing \b (applied where it's used) only clears when either the
// short form ends the word exactly, or the full canonical suffix is
// present, so a continuing word never matches.
const WEEKDAY_TOKENS: { weekday: number; alt: string }[] = [
  { weekday: 0, alt: "sun(?:day)?" },
  { weekday: 1, alt: "mon(?:day)?" },
  { weekday: 2, alt: "tues?(?:day)?" },
  { weekday: 3, alt: "wed(?:nesday)?" },
  { weekday: 4, alt: "thu(?:rs)?(?:day)?" },
  { weekday: 5, alt: "fri(?:day)?" },
  { weekday: 6, alt: "sat(?:urday)?" },
];
const TIME_WORDS: Record<string, string> = {
  noon: "12:00",
  midday: "12:00",
  morning: "09:00",
  afternoon: "14:00",
  evening: "18:00",
  "after lunch": "14:00",
};
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

export type ExtractedEntities = {
  partySize: number;
  /**
   * SEMANTIC scheduling info only ("Sunday", "at 2pm") — never a resolved
   * timestamp. Converting this to an absolute instant, using the
   * business's own timezone, is `src/lib/scheduling/resolver.ts`'s job,
   * called only from the Action Compiler.
   */
  schedulingConstraint?: SchedulingConstraint;
  accepted: boolean;
  paidConfirmed: boolean;
  discountPct?: number;
  email?: string;
  phone?: string;
  name?: string;
};

const NAME_ANNOUNCEMENT_MARKERS = [/\bmy name is\b/i, /\bmy name'?s\b/i, /\bcall me\b/i, /\bthis is\b/i];
// Words that end a captured name — stops "my name is Inon AND my phone
// number is..." from swallowing the rest of the sentence into the name.
const NAME_STOP_WORDS = new Set(["and", "my", "phone", "email", "number", "is", "here"]);

/** Extract a self-announced name ("my name is Inon", "call me Jordan Lee") straight from the ORIGINAL (not lowercased) message, so capitalization/punctuation survive. */
function extractAnnouncedName(message: string): string | undefined {
  for (const marker of NAME_ANNOUNCEMENT_MARKERS) {
    const match = message.match(marker);
    if (!match || match.index === undefined) continue;

    const rest = message.slice(match.index + match[0].length);
    const words: string[] = [];
    for (const rawWord of rest.trim().split(/\s+/)) {
      const cleaned = rawWord.replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, "");
      if (!cleaned || NAME_STOP_WORDS.has(cleaned.toLowerCase())) break;
      words.push(cleaned);
      if (words.length === 3) break;
    }
    if (words.length > 0) return words.join(" ");
  }
  return undefined;
}

function parseTimeToken(text: string): { hour: number; minute: number } | undefined {
  // "3pm", "3:30 pm"
  const withMeridiem = text.match(/(\d{1,2})(:(\d{2}))?\s*(am|pm)/i);
  if (withMeridiem) {
    let hour = parseInt(withMeridiem[1], 10);
    const minute = withMeridiem[3] ? parseInt(withMeridiem[3], 10) : 0;
    const meridiem = withMeridiem[4].toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }

  // 24-hour "13:00" / "9:30"
  const twentyFourHour = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourHour) {
    return { hour: parseInt(twentyFourHour[1], 10), minute: parseInt(twentyFourHour[2], 10) };
  }

  for (const [word, time] of Object.entries(TIME_WORDS)) {
    if (text.includes(word)) {
      const [h, m] = time.split(":").map(Number);
      return { hour: h, minute: m };
    }
  }

  // Bare number: "around 1", "at 3" — assume afternoon for small hours,
  // since that's the common case for a same-day/near-term booking request.
  const bareNumber = text.match(/\b(?:at|around|for)\s+(\d{1,2})\b/);
  if (bareNumber) {
    let hour = parseInt(bareNumber[1], 10);
    if (hour >= 1 && hour <= 7) hour += 12;
    return { hour, minute: 0 };
  }

  // Word numbers: "around one", "at three"
  const wordNumberMatch = text.match(
    /\b(?:at|around|for)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/
  );
  if (wordNumberMatch) {
    let hour = NUMBER_WORDS[wordNumberMatch[1]];
    if (hour >= 1 && hour <= 7) hour += 12;
    return { hour, minute: 0 };
  }

  return undefined;
}

/**
 * Whole-word, case-insensitive weekday match with a STRUCTURAL "next"
 * qualifier (captured, not inferred from nearby characters) — never a
 * substring match. Picks the earliest weekday token in the text if more
 * than one is present.
 */
function findExplicitWeekday(text: string): { weekday: number; qualifier?: "next" } | undefined {
  let best: { weekday: number; qualifier?: "next"; index: number } | undefined;
  for (const { weekday, alt } of WEEKDAY_TOKENS) {
    const match = new RegExp(`\\b(next\\s+)?(?:${alt})\\b`, "i").exec(text);
    if (match && (best === undefined || match.index < best.index)) {
      best = { weekday, qualifier: match[1] ? "next" : undefined, index: match.index };
    }
  }
  return best ? { weekday: best.weekday, qualifier: best.qualifier } : undefined;
}

/**
 * Extract a scheduling constraint ONLY from directly-verifiable explicit
 * tokens in the raw text — a weekday word (Sunday..Saturday, optionally
 * qualified by "next") or a relative-day word ("today"/"tomorrow"). This
 * is deliberately narrower than general fuzzy scheduling understanding:
 * it exists so BARRY can cross-check whatever a Reasoner (LLM or mock)
 * proposed against ground truth actually present in the customer's own
 * words, per `verifyIR()` in `verify.ts`. Returns undefined when the raw
 * text contains none of these explicit tokens — that's not "no
 * scheduling intent," just "nothing here to verify against."
 */
export function extractExplicitSchedulingConstraint(message: string): SchedulingConstraint | undefined {
  const text = message.toLowerCase();

  const weekdayMatch = findExplicitWeekday(text);
  if (weekdayMatch) {
    const time = parseTimeToken(text);
    return {
      date: { kind: "weekday", weekday: weekdayMatch.weekday, qualifier: weekdayMatch.qualifier },
      time: time ? { kind: "explicitTime", ...time } : undefined,
    };
  }
  if (/\btomorrow\b/.test(text)) {
    const time = parseTimeToken(text);
    return { date: { kind: "relativeDay", days: 1 }, time: time ? { kind: "explicitTime", ...time } : undefined };
  }
  if (/\btoday\b/.test(text)) {
    const time = parseTimeToken(text);
    return { date: { kind: "relativeDay", days: 0 }, time: time ? { kind: "explicitTime", ...time } : undefined };
  }
  return undefined;
}

export function extractEntities(message: string): ExtractedEntities {
  const text = message.toLowerCase();

  let partySize = 1;
  const explicitCount = text.match(/(\d+)\s*(people|person|guests?|pax)/);
  if (explicitCount) {
    partySize = parseInt(explicitCount[1], 10);
  } else if (/\b(my|our)\s+(girlfriend|boyfriend|wife|husband|partner|friend|spouse)\b/.test(text)) {
    partySize = 2;
  }

  const schedulingConstraint = extractExplicitSchedulingConstraint(message);

  const accepted = /\b(yes|yep|sounds good|perfect|that works|confirm|book it|let's do it|sure)\b/.test(
    text
  );
  const paidConfirmed = /\b(paid|payment (is )?done|i('| ha)ve paid|sent the payment)\b/.test(text);

  const discountMatch = text.match(/(\d+)\s*%.*(off|discount)|discount.*?(\d+)\s*%/);
  const discountPct = discountMatch
    ? parseInt(discountMatch[1] ?? discountMatch[3], 10)
    : undefined;

  const emailMatch = message.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phoneMatch = message.match(/\+?\d[\d\s-]{6,}\d/);
  const name = extractAnnouncedName(message);

  return {
    partySize,
    schedulingConstraint,
    accepted,
    paidConfirmed,
    discountPct,
    email: emailMatch?.[0],
    phone: phoneMatch?.[0],
    name,
  };
}

function rankOffersByTokenOverlap(graph: BusinessGraph, message: string, offerTokens: (offer: Offer) => string[]): Offer[] {
  const words = new Set(tokenize(message));
  if (words.size === 0) return [];

  const scores = new Map<string, number>();
  for (const offer of graph.offers) {
    if (!offer.active) continue;
    let score = 0;
    for (const w of offerTokens(offer)) if (words.has(w)) score++;
    if (score > 0) scores.set(offer.id, score);
  }
  if (scores.size === 0) return [];
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0][1];
  return ranked
    .filter(([, score]) => score === top)
    .map(([offerId]) => graph.offers.find((o) => o.id === offerId)!)
    .filter(Boolean);
}

/** Broad discovery matching (name + description) — for free-form "I want something relaxing for two" style requests, where MockReasoner picks an initial offer. */
export function findOfferCandidates(graph: BusinessGraph, message: string): Offer[] {
  return rankOffersByTokenOverlap(graph, message, (offer) => tokenize(`${offer.name} ${offer.description}`));
}

/**
 * Strict, high-confidence matching on the offer's OWN NAME ONLY (never
 * its description) — used for deterministic verification of an explicit
 * offer reference (`verifyIR()` in `verify.ts`), where matching against
 * description words too could produce a false-positive override on
 * incidental overlap (e.g. "two" appearing in an unrelated sentence
 * matching a description that happens to mention "for two").
 */
export function findOffersByExplicitNameReference(graph: BusinessGraph, message: string): Offer[] {
  return rankOffersByTokenOverlap(graph, message, (offer) => tokenize(offer.name));
}
