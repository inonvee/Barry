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

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
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

export function extractEntities(message: string): ExtractedEntities {
  const text = message.toLowerCase();

  let partySize = 1;
  const explicitCount = text.match(/(\d+)\s*(people|person|guests?|pax)/);
  if (explicitCount) {
    partySize = parseInt(explicitCount[1], 10);
  } else if (/\b(my|our)\s+(girlfriend|boyfriend|wife|husband|partner|friend|spouse)\b/.test(text)) {
    partySize = 2;
  }

  let schedulingConstraint: SchedulingConstraint | undefined;
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const idx = text.indexOf(WEEKDAYS[i]);
    if (idx !== -1) {
      const qualifier = text.slice(Math.max(0, idx - 6), idx).includes("next") ? "next" : undefined;
      const time = parseTimeToken(text);
      schedulingConstraint = {
        date: { kind: "weekday", weekday: i, qualifier },
        time: time ? { kind: "explicitTime", ...time } : undefined,
      };
      break;
    }
  }
  if (!schedulingConstraint && /\btomorrow\b/.test(text)) {
    const time = parseTimeToken(text);
    schedulingConstraint = {
      date: { kind: "relativeDay", days: 1 },
      time: time ? { kind: "explicitTime", ...time } : undefined,
    };
  }

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

export function findOfferCandidates(graph: BusinessGraph, message: string): Offer[] {
  const words = new Set(tokenize(message));
  if (words.size === 0) return [];

  const scores = new Map<string, number>();
  for (const offer of graph.offers) {
    if (!offer.active) continue;
    const offerWords = tokenize(`${offer.name} ${offer.description}`);
    let score = 0;
    for (const w of offerWords) if (words.has(w)) score++;
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
