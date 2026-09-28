import type { BusinessGraph, Offer } from "@/lib/business-graph";
import type { SchedulingConstraint } from "@/lib/scheduling/resolver";
import { isValidPhoneValue } from "./customer-fields";

const STOPWORDS = new Set([
  "the", "and", "for", "any", "are", "can", "you", "that", "this", "with",
  "have", "want", "like", "need", "about", "could", "would", "please",
  "hello", "there", "morning", "afternoon", "evening", "tomorrow", "today",
  "book", "booking", "chance", "some", "your", "our", "off", "get",
]);

/**
 * Unicode-aware: keeps any letter/digit in any script (Hebrew included),
 * not just a-z0-9. Losing non-ASCII characters here was the root cause of
 * a live bug where Hebrew offer references ("זוגי") never matched
 * anything — every Hebrew letter was silently stripped before the
 * token-overlap comparison ever ran.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
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

/**
 * Hebrew weekday forms — the full "יום X" phrase (safest: unambiguous)
 * plus the bare compact form (ראשון/שני/... — same words also used as
 * ordinals ("first"/"second"/...) in unrelated contexts, a real but
 * accepted ambiguity, mirroring the same short-form tradeoff the English
 * table above already makes for "sun"/"mon"/etc). No "next"-equivalent
 * qualifier support yet — not requested, and Hebrew expresses it as a
 * suffix ("הבא") rather than a prefix, which the matcher below doesn't
 * attempt to parse.
 */
// Hebrew possessive forms already encode "my" in the word itself (unlike
// English "wife", which needs an explicit "my"/"our" prefix to be
// unambiguous) — so these are checked as whole-token matches on their
// own, no surrounding "my"-equivalent required. Includes a common
// spelling variant (אשתי/אישתי, both mean "my wife").
const HEBREW_PARTNER_WORDS = ["אשתי", "אישתי", "בעלי", "בן הזוג", "בת הזוג"];

// Short-reply accept/decline vocabulary — the Hebrew equivalents of the
// English "yes"/"yeah"/"sure" and "no"/"nope" whole-word checks above.
// "סבבה" and "יאללה" are casual affirmatives extremely common in
// everyday Hebrew texting, not formal registers a naive translation
// would guess.
const HEBREW_ACCEPT_WORDS = ["כן", "סבבה", "יאללה", "בסדר", "מעולה"];
const HEBREW_DECLINE_WORDS = ["לא"];

const HEBREW_WEEKDAY_TOKENS: { weekday: number; forms: string[] }[] = [
  { weekday: 0, forms: ["יום ראשון", "ראשון"] },
  { weekday: 1, forms: ["יום שני", "שני"] },
  { weekday: 2, forms: ["יום שלישי", "שלישי"] },
  { weekday: 3, forms: ["יום רביעי", "רביעי"] },
  { weekday: 4, forms: ["יום חמישי", "חמישי"] },
  { weekday: 5, forms: ["יום שישי", "שישי"] },
  { weekday: 6, forms: ["יום שבת", "שבת"] },
];

const HEBREW_LETTER_RANGE = /[א-ת]/;
// Standard single-letter Hebrew prepositions/conjunctions that attach
// directly to the following word with no space ("ב"+"יום" = "ביום", "on
// the day") — sometimes stacked two deep ("ו"+"ב" = "וב", "and on").
const HEBREW_PREFIX_LETTERS = new Set(["ב", "ה", "ו", "כ", "ל", "מ", "ש"]);

function isHebrewLetter(ch: string | undefined): boolean {
  return ch !== undefined && HEBREW_LETTER_RANGE.test(ch);
}

/**
 * Whole-token match for a Hebrew form, tolerant of up to two stacked
 * single-letter prefixes glued directly onto the front (as Hebrew
 * grammar requires — "ביום חמישי", not "יום חמישי", is how "on Thursday"
 * is actually written). Still rejects the form being embedded inside an
 * unrelated longer word: an ASCII `\b`-style boundary check, generalized
 * to the Hebrew alphabet since `\b` itself only recognizes `[A-Za-z0-9_]`
 * and never fires correctly around Hebrew letters.
 */
export function matchHebrewToken(text: string, form: string): number | undefined {
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf(form, searchFrom);
    if (idx === -1) return undefined;
    searchFrom = idx + 1;

    if (isHebrewLetter(text[idx + form.length])) continue; // extends into a longer word

    const before1 = idx > 0 ? text[idx - 1] : undefined;
    if (!isHebrewLetter(before1)) return idx; // clean word start
    if (!HEBREW_PREFIX_LETTERS.has(before1!)) continue; // embedded in an unrelated word

    const before2 = idx > 1 ? text[idx - 2] : undefined;
    if (!isHebrewLetter(before2)) return idx; // exactly one glued prefix letter
    if (HEBREW_PREFIX_LETTERS.has(before2!)) {
      const before3 = idx > 2 ? text[idx - 3] : undefined;
      if (!isHebrewLetter(before3)) return idx; // two stacked prefix letters
    }
  }
}

function findExplicitWeekdayHebrew(text: string): { weekday: number; qualifier?: "next"; index: number } | undefined {
  let best: { weekday: number; index: number } | undefined;
  for (const { weekday, forms } of HEBREW_WEEKDAY_TOKENS) {
    for (const form of forms) {
      const idx = matchHebrewToken(text, form);
      if (idx !== undefined && (best === undefined || idx < best.index)) {
        best = { weekday, index: idx };
      }
    }
  }
  return best ? { ...best, qualifier: undefined } : undefined;
}

const HEBREW_NUMBER_WORDS: Record<string, number> = {
  "אחת": 1, "אחד": 1, "שתיים": 2, "שניים": 2, "שלוש": 3, "ארבע": 4, "חמש": 5,
  "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9, "עשר": 10,
  "אחת עשרה": 11, "שתים עשרה": 12,
};

/**
 * Hebrew explicit time forms: "ב3"/"ב-3" (glued), "בשעה 3"/"בשעה שלוש"
 * ("at hour 3"/"at hour three"), "3 בצהריים"/"שלוש בצהריים" ("3/three in
 * the afternoon" — an explicit PM marker, unlike the other two forms).
 * Bare small hours (1-7) without an explicit AM/PM marker default to
 * afternoon, the same booking-context convention English's
 * `parseTimeToken` already uses for "at 3"/"around three".
 */
function parseHebrewTimeToken(text: string): { hour: number; minute: number } | undefined {
  const explicitAfternoonDigit = text.match(/(\d{1,2})\s*בצהריים/);
  if (explicitAfternoonDigit) {
    let hour = parseInt(explicitAfternoonDigit[1], 10);
    if (hour >= 1 && hour <= 11) hour += 12;
    return { hour, minute: 0 };
  }
  for (const [word, num] of Object.entries(HEBREW_NUMBER_WORDS)) {
    if (matchHebrewToken(text, `${word} בצהריים`) !== undefined) {
      return { hour: num >= 1 && num <= 11 ? num + 12 : num, minute: 0 };
    }
  }

  const hourWordDigit = text.match(/בשעה\s+(\d{1,2})\b/);
  if (hourWordDigit) {
    let hour = parseInt(hourWordDigit[1], 10);
    if (hour >= 1 && hour <= 7) hour += 12;
    return { hour, minute: 0 };
  }
  for (const [word, num] of Object.entries(HEBREW_NUMBER_WORDS)) {
    if (matchHebrewToken(text, `בשעה ${word}`) !== undefined) {
      return { hour: num >= 1 && num <= 7 ? num + 12 : num, minute: 0 };
    }
  }

  const gluedDigit = text.match(/ב-?(\d{1,2})\b/);
  if (gluedDigit) {
    let hour = parseInt(gluedDigit[1], 10);
    if (hour >= 1 && hour <= 7) hour += 12;
    return { hour, minute: 0 };
  }

  for (const [word, num] of Object.entries(HEBREW_NUMBER_WORDS)) {
    if (matchHebrewToken(text, `ב${word}`) !== undefined) {
      return { hour: num >= 1 && num <= 7 ? num + 12 : num, minute: 0 };
    }
  }

  return undefined;
}

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
  /** An explicit decline of whatever was just offered (e.g. an offered slot) — "no"/"nope"/"לא". Context-free by construction, same as `accepted`: the compiler only acts on it when there's actually something on file to decline. */
  declined: boolean;
  paidConfirmed: boolean;
  discountPct?: number;
  email?: string;
  phone?: string;
  name?: string;
};

// Deliberately does NOT include a bare "this is" marker — "this is
// regarding my appointment" would capture "regarding" as a name. Every
// marker here is specific enough that what follows is almost always
// actually a name. "I'm"/"I am" is riskier ("I'm looking for a
// massage") but is protected the same way "call me" is: the captured
// word must start with a capital letter, which rejects the common
// "I'm <verb/adjective>" case in properly-cased English.
const NAME_ANNOUNCEMENT_MARKERS = [/\bmy name is\b/i, /\bmy name'?s\b/i, /\bcall me\b/i, /\bi'?m\b/i, /\bi am\b/i];
// Words that end a captured name — stops "my name is Inon AND my phone
// number is..." from swallowing the rest of the sentence into the name,
// and stops non-name replies to "call me"/"I'm" ("call me back", "I'm
// good thanks") from being captured at all.
const NAME_STOP_WORDS = new Set([
  "and", "my", "phone", "email", "number", "is", "here", "back", "now",
  "later", "tomorrow", "today", "tonight", "soon", "when", "then",
  "please", "at", "on", "in", "up", "over", "asap", "good", "fine",
  "great", "ok", "okay", "sure", "not", "just", "still", "also", "coming",
  "looking", "interested", "trying", "hoping", "wondering", "free",
  "instead", "actually", "rather",
]);

/**
 * Extract a self-announced name from English markers ("my name is
 * Inon", "call me Jordan Lee", "I'm Inon" — or, in a mixed-language
 * message, "My name is ינון") straight from the ORIGINAL (not
 * lowercased) message, so capitalization survives — and, for a
 * LATIN-script candidate, is REQUIRED: a real English name is written
 * capitalized, so this rejects a stray lowercase word ("call me
 * tomorrow" already stops at the NAME_STOP_WORDS check, but this
 * catches anything that slips past it, like "call me anytime"). A
 * non-Latin-script candidate (e.g. Hebrew) has no case to check, so it
 * only needs to survive the stop-word list.
 */
function extractAnnouncedNameEnglish(message: string): string | undefined {
  for (const marker of NAME_ANNOUNCEMENT_MARKERS) {
    const match = message.match(marker);
    if (!match || match.index === undefined) continue;

    const rest = message.slice(match.index + match[0].length);
    const words: string[] = [];
    for (const rawWord of rest.trim().split(/\s+/)) {
      const cleaned = rawWord.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, "");
      if (!cleaned || NAME_STOP_WORDS.has(cleaned.toLowerCase())) break;
      words.push(cleaned);
      if (words.length === 3) break;
    }
    // Reject only a stray LOWERCASE Latin word (the actual false-positive
    // class: "looking", "back", ...) — a non-Latin script (e.g. Hebrew)
    // has no case to check, so it's accepted once it survives the
    // stop-word list above.
    if (words.length > 0 && !/^[a-z]/.test(words[0])) return words.join(" ");
  }
  return undefined;
}

// "קוראים לי X" ("[they] call me X") and "השם שלי X" ("my name [is] X")
// are structurally unambiguous, with one Hebrew-specific wrinkle:
// colloquial messages often insert a copula/filler ("זה"/"הוא"/"היא")
// before the actual name.
const HEBREW_NAME_MARKERS = ["קוראים לי", "השם שלי"];
const HEBREW_NAME_COPULAS = new Set(["זה", "הוא", "היא"]);
// The bare "אני X" ("I [am] X") pattern is far riskier: "אני" alone
// starts countless Hebrew sentences that are NOT a self-identification
// ("אני רוצה" = "I want", "אני בא עם אשתי" = "I'm coming with my
// wife", "אני עם בעלי" = "I'm with my husband"). Hebrew has no letter
// casing to lean on the way English's capitalization check does, so
// this is guarded by an explicit blocklist of common words/relationship
// terms that follow "אני" without being a name — this is exactly the
// live bug class Part 8 exists to prevent (a relationship word like
// "אישתי" must never become the customer's name).
const HEBREW_NAME_BLOCK_AFTER_ANI = new Set([
  "רוצה", "צריך", "צריכה", "בא", "באה", "מגיע", "מגיעה", "עם",
  "גם", "כבר", "פה", "כאן", "יכול", "יכולה", "אוהב", "אוהבת", "מעוניין",
  "מעוניינת", "אשמח", "חושב", "חושבת", "חוזר", "חוזרת", "מתעניין",
  "מתעניינת", "לא", "כן", "הולך", "הולכת", "נמצא", "נמצאת", "פנוי",
  "פנויה", "זמין", "זמינה",
  ...HEBREW_NAME_COPULAS,
  ...HEBREW_PARTNER_WORDS,
]);

/** The word immediately after a Hebrew marker, in ANY script — a mixed-language message ("קוראים לי Inon") must still work. Unicode-letter-aware, mirroring extractAnnouncedNameEnglish's own cleaning. */
function wordAfter(message: string, markerIndex: number, markerLength: number): string | undefined {
  const rest = message.slice(markerIndex + markerLength).trim();
  const word = rest.split(/\s+/)[0]?.replace(/[^\p{L}'"-]+$/gu, "").replace(/^[^\p{L}]+/gu, "");
  return word && word.length > 0 ? word : undefined;
}

function firstNameWordAfterHebrewMarker(message: string, markerIndex: number, markerLength: number): string | undefined {
  const rest = message.slice(markerIndex + markerLength).trim();
  for (const rawWord of rest.split(/\s+/).slice(0, 4)) {
    const word = rawWord.replace(/[^\p{L}'"-]+$/gu, "").replace(/^[^\p{L}]+/gu, "");
    if (!word) continue;
    if (HEBREW_NAME_COPULAS.has(word)) continue;
    return word;
  }
  return undefined;
}

function extractAnnouncedNameHebrew(message: string): string | undefined {
  for (const marker of HEBREW_NAME_MARKERS) {
    const idx = matchHebrewToken(message, marker);
    if (idx === undefined) continue;
    const word = firstNameWordAfterHebrewMarker(message, idx, marker.length);
    if (word) return word;
  }

  // The bare "אני X" form is deliberately kept Hebrew-script-only here —
  // HEBREW_NAME_BLOCK_AFTER_ANI (the safety net for this risky pattern)
  // is a table of Hebrew words; a Latin continuation would be entirely
  // unguarded by it, so it's left to the Reasoner instead.
  const idx = matchHebrewToken(message, "אני");
  if (idx !== undefined) {
    const word = wordAfter(message, idx, "אני".length);
    if (word && word.length >= 2 && isHebrewLetter(word[0]) && !HEBREW_NAME_BLOCK_AFTER_ANI.has(word)) return word;
  }

  return undefined;
}

/** Language-independent dispatch: an explicit self-announcement in either language, whichever the raw text actually contains. */
export function extractAnnouncedName(message: string): string | undefined {
  return extractAnnouncedNameEnglish(message) ?? extractAnnouncedNameHebrew(message);
}

/** Extract an explicit phone number — a mostly-digit token at least 8 characters long. Unambiguous by construction: the regex only matches contiguous digit/space/hyphen runs, so it can't accidentally span unrelated words. */
export function extractExplicitPhone(message: string): string | undefined {
  return [...message.matchAll(/\+?\d[\d\s-]{6,}\d/g)].map((match) => match[0]).find(isValidPhoneValue);
}

/** Extract an explicit email address — unambiguous by construction (requires an "@" and a domain). */
export function extractExplicitEmail(message: string): string | undefined {
  return message.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
}

const IMPOSSIBLE_CUSTOMER_NAME_VALUES = new Set([
  "זה", "הוא", "היא",
  "אשתי", "אישתי", "בעלי", "בן הזוג", "בת הזוג",
  "wife", "husband", "partner", "spouse", "girlfriend", "boyfriend",
  "my wife", "my husband", "my partner",
  "tomorrow", "today", "tonight", "later",
]);

export function isInvalidCustomerNameCandidate(value: string | undefined): boolean {
  const normalized = value?.trim().replace(/\s+/g, " ").toLowerCase();
  return !normalized || IMPOSSIBLE_CUSTOMER_NAME_VALUES.has(normalized);
}

export function hasThirdPartyNameEvidence(message: string): boolean {
  return /\b(my|our)\s+(wife|husband|partner|spouse|girlfriend|boyfriend|friend)'?s\s+name\s+is\b/i.test(message);
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
  // Deliberately excludes "for" as a time preposition — "for 2"/"for two"
  // overwhelmingly means PARTY SIZE in a booking context ("table for
  // two"), not a time; see the party-size detection in extractEntities().
  const bareNumber = text.match(/\b(?:at|around)\s+(\d{1,2})\b/);
  if (bareNumber) {
    let hour = parseInt(bareNumber[1], 10);
    if (hour >= 1 && hour <= 7) hour += 12;
    return { hour, minute: 0 };
  }

  // Word numbers: "around one", "at three"
  const wordNumberMatch = text.match(
    /\b(?:at|around)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/
  );
  if (wordNumberMatch) {
    let hour = NUMBER_WORDS[wordNumberMatch[1]];
    if (hour >= 1 && hour <= 7) hour += 12;
    return { hour, minute: 0 };
  }

  return undefined;
}

/**
 * Whole-word, case-insensitive English weekday match with a STRUCTURAL
 * "next" qualifier (captured, not inferred from nearby characters) —
 * never a substring match. Picks the earliest weekday token in the text
 * if more than one is present.
 */
function findExplicitWeekdayEnglish(text: string): { weekday: number; qualifier?: "next"; index: number } | undefined {
  let best: { weekday: number; qualifier?: "next"; index: number } | undefined;
  for (const { weekday, alt } of WEEKDAY_TOKENS) {
    const match = new RegExp(`\\b(next\\s+)?(?:${alt})\\b`, "i").exec(text);
    if (match && (best === undefined || match.index < best.index)) {
      best = { weekday, qualifier: match[1] ? "next" : undefined, index: match.index };
    }
  }
  return best;
}

/**
 * Language-independent dispatch: tries every locale's weekday matcher
 * and keeps whichever explicit token appears earliest in the text (there
 * is normally only one, but a mixed-language message could in principle
 * contain both). Adding a new locale means adding a new matcher here,
 * never branching the rest of the pipeline on locale.
 */
function findExplicitWeekday(text: string): { weekday: number; qualifier?: "next" } | undefined {
  const en = findExplicitWeekdayEnglish(text);
  const he = findExplicitWeekdayHebrew(text);
  const best = !en ? he : !he ? en : en.index <= he.index ? en : he;
  return best ? { weekday: best.weekday, qualifier: best.qualifier } : undefined;
}

/**
 * Extract a scheduling constraint ONLY from directly-verifiable explicit
 * tokens in the raw text — a weekday word (Sunday..Saturday / יום ראשון..
 * יום שבת, optionally qualified by "next") or a relative-day word
 * ("today"/"tomorrow" / "היום"/"מחר"/"מחרתיים"). This is deliberately
 * narrower than general fuzzy scheduling understanding: it exists so
 * BARRY can cross-check whatever a Reasoner (LLM or mock) proposed
 * against ground truth actually present in the customer's own words, per
 * `verifyIR()` in `verify.ts`. Returns undefined when the raw text
 * contains none of these explicit tokens — that's not "no scheduling
 * intent," just "nothing here to verify against."
 */
export function extractExplicitSchedulingConstraint(message: string): SchedulingConstraint | undefined {
  const text = message.toLowerCase();

  const weekdayMatch = findExplicitWeekday(text);
  if (weekdayMatch) {
    const time = parseTimeToken(text) ?? parseHebrewTimeToken(text);
    return {
      date: { kind: "weekday", weekday: weekdayMatch.weekday, qualifier: weekdayMatch.qualifier },
      time: time ? { kind: "explicitTime", ...time } : undefined,
    };
  }
  // Check "מחרתיים" (day after tomorrow) before "מחר" (tomorrow) even
  // though matchHebrewToken's own trailing-boundary check already
  // prevents "מחר" from matching as a prefix of "מחרתיים" — this ordering
  // is just belt-and-suspenders clarity, not a correctness requirement.
  if (matchHebrewToken(text, "מחרתיים") !== undefined) {
    const time = parseTimeToken(text) ?? parseHebrewTimeToken(text);
    return { date: { kind: "relativeDay", days: 2 }, time: time ? { kind: "explicitTime", ...time } : undefined };
  }
  if (/\btomorrow\b/.test(text) || matchHebrewToken(text, "מחר") !== undefined) {
    const time = parseTimeToken(text) ?? parseHebrewTimeToken(text);
    return { date: { kind: "relativeDay", days: 1 }, time: time ? { kind: "explicitTime", ...time } : undefined };
  }
  if (/\btoday\b/.test(text) || matchHebrewToken(text, "היום") !== undefined) {
    const time = parseTimeToken(text) ?? parseHebrewTimeToken(text);
    return { date: { kind: "relativeDay", days: 0 }, time: time ? { kind: "explicitTime", ...time } : undefined };
  }
  // No date token at all, but a bare time is still real, verifiable
  // scheduling information — most commonly a time-only correction
  // ("actually 5pm instead"). Returning undefined here was a live bug:
  // with no `date` key, this looked identical to "no scheduling intent
  // whatsoever" to callers, so a time-only correction fell all the way
  // through to being misread as a customer NAME by the mock reasoner's
  // name-fallback heuristic. The compiler (`resolveDate`) already
  // defaults a missing date to "today" for a first-time mention; a
  // correction's date carryover from the prior turn is the compiler's
  // job, not this extractor's.
  const bareTime = parseTimeToken(text) ?? parseHebrewTimeToken(text);
  if (bareTime) {
    return { time: { kind: "explicitTime", ...bareTime } };
  }
  return undefined;
}

export function extractEntities(message: string): ExtractedEntities {
  const text = message.toLowerCase();

  let partySize = 1;
  const explicitCount = text.match(/(\d+)\s*(people|person|guests?|pax)/);
  const forDigit = text.match(/\bfor\s+(\d+)\b/);
  const forWord = text.match(/\bfor\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (explicitCount) {
    partySize = parseInt(explicitCount[1], 10);
  } else if (/\b(my|our)\s+(girlfriend|boyfriend|wife|husband|partner|friend|spouse)\b/.test(text)) {
    partySize = 2;
  } else if (HEBREW_PARTNER_WORDS.some((w) => matchHebrewToken(text, w) !== undefined)) {
    partySize = 2;
  } else if (forDigit) {
    partySize = parseInt(forDigit[1], 10);
  } else if (forWord) {
    partySize = NUMBER_WORDS[forWord[1]];
  }

  const schedulingConstraint = extractExplicitSchedulingConstraint(message);

  const accepted =
    /\b(yes|yep|yeah|yea|yup|sounds good|perfect|that works|confirm|book it|let's do it|sure)\b/.test(text) ||
    HEBREW_ACCEPT_WORDS.some((w) => matchHebrewToken(text, w) !== undefined);
  // Context-free by construction, same as `accepted` above — the compiler
  // is the one place that decides whether there's actually anything to
  // decline (an offered slot on file), never this extractor.
  const declined =
    /\b(no|nope|nah)\b/.test(text) || HEBREW_DECLINE_WORDS.some((w) => matchHebrewToken(text, w) !== undefined);
  const paidConfirmed = /\b(paid|payment (is )?done|i('| ha)ve paid|sent the payment)\b/.test(text);

  const discountMatch = text.match(/(\d+)\s*%.*(off|discount)|discount.*?(\d+)\s*%/);
  const discountPct = discountMatch
    ? parseInt(discountMatch[1] ?? discountMatch[3], 10)
    : undefined;

  return {
    partySize,
    schedulingConstraint,
    accepted,
    declined,
    paidConfirmed,
    discountPct,
    email: extractExplicitEmail(message),
    phone: extractExplicitPhone(message),
    name: extractAnnouncedName(message),
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
  return rankOffersByTokenOverlap(graph, message, (offer) =>
    tokenize([offer.name, offer.description, ...offer.aliases].join(" "))
  );
}

/**
 * Strict, high-confidence matching on the offer's OWN NAME/ALIASES ONLY
 * (never its description) — used for deterministic verification of an
 * explicit offer reference (`verifyIR()` in `verify.ts`), where matching
 * against description words too could produce a false-positive override
 * on incidental overlap (e.g. "two" appearing in an unrelated sentence
 * matching a description that happens to mention "for two"). `aliases`
 * is generic reference data any offer can declare (other-language names,
 * colloquial short forms, ...) — never business-type-specific logic in
 * the matcher itself.
 */
export function findOffersByExplicitNameReference(graph: BusinessGraph, message: string): Offer[] {
  return rankOffersByTokenOverlap(graph, message, (offer) => tokenize([offer.name, ...offer.aliases].join(" ")));
}
