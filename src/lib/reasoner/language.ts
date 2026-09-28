/**
 * Which language should BARRY reply in?
 *
 * A message that is only a phone number, an email, an order code, a link,
 * a price or an emoji carries no language — it must never switch the
 * conversation. This is a narrow, general signal (the Unicode SCRIPT of the
 * words a message actually contains), not language understanding and not a
 * phrase table. Resolution order:
 *   1. the current customer message, if it contains words;
 *   2. the most recent earlier customer message that does;
 *   3. the language already stored for this conversation;
 *   4. the business locale;
 *   5. English.
 *
 * Script maps to a language family, so it is a HINT: the model composer is
 * also given the actual text the choice was based on and mirrors it (e.g.
 * Spanish vs English, both Latin); deterministic fallbacks localise the
 * languages they have strings for.
 */

export type ReplyLanguage = {
  code: string;
  basis: "current_turn" | "recent_turn" | "stored" | "business_locale" | "default";
  /** The customer text the choice was based on, when it came from the conversation. */
  sample?: string;
};

const SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Hebrew}/u, "he"],
  [/\p{Script=Arabic}/u, "ar"],
  [/\p{Script=Cyrillic}/u, "ru"],
  [/\p{Script=Greek}/u, "el"],
  [/\p{Script=Thai}/u, "th"],
  [/\p{Script=Hangul}/u, "ko"],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "ja"],
  [/\p{Script=Han}/u, "zh"],
  [/\p{Script=Latin}/u, "en"],
];

/** Minimum letters of words for a message to count as linguistic ("ok", "👍" and "M" don't). */
const MIN_LETTERS = 3;

/** The part of a message that is actual words: no links, emails, or tokens containing digits (phones, codes, prices). */
export function linguisticText(text: string): string {
  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\S+@\S+/g, " ")
    .replace(/\S*\d\S*/g, " ");
}

/** The language family of a message's words, or undefined when it has none. */
export function scriptLanguage(text: string): string | undefined {
  const counts = new Map<string, number>();
  for (const ch of linguisticText(text)) {
    if (!/\p{L}/u.test(ch)) continue;
    const hit = SCRIPTS.find(([re]) => re.test(ch));
    if (hit) counts.set(hit[1], (counts.get(hit[1]) ?? 0) + 1);
  }
  // A non-Latin script with real words wins over Latin fragments inside it
  // (brand names, sizes, "M", "Onyx" in a Hebrew sentence).
  const nonLatin = [...counts.entries()].filter(([code]) => code !== "en").sort((a, b) => b[1] - a[1])[0];
  if (nonLatin && nonLatin[1] >= MIN_LETTERS) return nonLatin[0];
  const latin = counts.get("en") ?? 0;
  if (latin >= MIN_LETTERS) return "en";
  return undefined;
}

export function localeLanguage(locale: string | undefined): string | undefined {
  const code = locale?.split(/[-_]/)[0]?.toLowerCase();
  return code && /^[a-z]{2,3}$/.test(code) ? code : undefined;
}

export function resolveReplyLanguage(input: {
  /** Customer messages in order, oldest first; the last one is the current turn. */
  customerMessages: string[];
  stored?: string;
  businessLocale?: string;
}): ReplyLanguage {
  const messages = input.customerMessages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const code = scriptLanguage(messages[i]);
    if (code) return { code, basis: i === messages.length - 1 ? "current_turn" : "recent_turn", sample: messages[i].slice(0, 200) };
  }
  if (input.stored) return { code: input.stored, basis: "stored" };
  const locale = localeLanguage(input.businessLocale);
  if (locale) return { code: locale, basis: "business_locale" };
  return { code: "en", basis: "default" };
}
