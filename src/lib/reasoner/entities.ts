import type { BusinessGraph, Offer } from "@/lib/business-graph";

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
};

export type ExtractedEntities = {
  partySize: number;
  earliest?: string; // ISO
  latest?: string; // ISO
  accepted: boolean;
  paidConfirmed: boolean;
  discountPct?: number;
  email?: string;
  phone?: string;
};

/** Find the next date (from `now`) that falls on `weekday` (0=Sun..6=Sat). */
function nextWeekday(now: Date, weekday: number): Date {
  const result = new Date(now);
  const diff = (weekday - now.getDay() + 7) % 7 || 7;
  result.setDate(now.getDate() + diff);
  return result;
}

function parseTimeToken(text: string): { hour: number; minute: number } | undefined {
  const explicit = text.match(/(\d{1,2})(:(\d{2}))?\s*(am|pm)/i);
  if (explicit) {
    let hour = parseInt(explicit[1], 10);
    const minute = explicit[3] ? parseInt(explicit[3], 10) : 0;
    const meridiem = explicit[4].toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }
  for (const [word, time] of Object.entries(TIME_WORDS)) {
    if (text.includes(word)) {
      const [h, m] = time.split(":").map(Number);
      return { hour: h, minute: m };
    }
  }
  return undefined;
}

export function extractEntities(message: string, now: Date = new Date()): ExtractedEntities {
  const text = message.toLowerCase();

  let partySize = 1;
  const explicitCount = text.match(/(\d+)\s*(people|person|guests?|pax)/);
  if (explicitCount) {
    partySize = parseInt(explicitCount[1], 10);
  } else if (/\b(my|our)\s+(girlfriend|boyfriend|wife|husband|partner|friend|spouse)\b/.test(text)) {
    partySize = 2;
  }

  let earliest: string | undefined;
  let latest: string | undefined;
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (text.includes(WEEKDAYS[i])) {
      const date = nextWeekday(now, i);
      const time = parseTimeToken(text) ?? { hour: 9, minute: 0 };
      date.setHours(time.hour, time.minute, 0, 0);
      earliest = date.toISOString();
      const latestDate = new Date(date);
      latestDate.setHours(latestDate.getHours() + 3);
      latest = latestDate.toISOString();
      break;
    }
  }
  if (!earliest && /\btomorrow\b/.test(text)) {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    const time = parseTimeToken(text) ?? { hour: 9, minute: 0 };
    date.setHours(time.hour, time.minute, 0, 0);
    earliest = date.toISOString();
    const latestDate = new Date(date);
    latestDate.setHours(latestDate.getHours() + 3);
    latest = latestDate.toISOString();
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

  return {
    partySize,
    earliest,
    latest,
    accepted,
    paidConfirmed,
    discountPct,
    email: emailMatch?.[0],
    phone: phoneMatch?.[0],
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
