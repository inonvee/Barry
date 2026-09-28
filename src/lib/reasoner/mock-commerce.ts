import type { CommerceSemantics } from "./ir";

/**
 * OFFLINE STAND-IN ONLY. Production understanding comes from the model
 * (OpenAIReasoner); this exists so the simulator and test suite can run
 * without an API key. It deliberately covers a small, generic slice of
 * commerce phrasing and never encodes a catalog or an industry: option
 * names/values come from the customer's words, and search is delegated
 * to the business's own commerce provider with the raw text.
 *
 * Anything this misses is a gap in the stand-in, not a production rule —
 * never "fix" a paraphrase by adding it here AND to the runtime.
 */

const ORDINALS: [RegExp, number][] = [
  [/\b(first|1st|number one)\b|הראשונה|הראשון|ראשונה|ראשון/i, 0],
  [/\b(second|2nd|number two)\b|השנייה|השניה|השני|שנייה|שניה/i, 1],
  [/\b(third|3rd|number three)\b|השלישית|השלישי|שלישית|שלישי/i, 2],
  [/\b(fourth|4th)\b|הרביעית|הרביעי/i, 3],
];

const SIZE_WORDS: Record<string, string> = {
  xs: "XS", s: "S", m: "M", l: "L", xl: "XL", xxl: "XXL",
  small: "S", medium: "M", large: "L",
  "מדיום": "M", "בינוני": "M", "בינונית": "M", "סמול": "S", "קטן": "S", "קטנה": "S", "לארג'": "L", "גדול": "L", "גדולה": "L",
};

const COLOR_WORDS: Record<string, string> = {
  black: "black", white: "white", red: "red", blue: "blue", green: "green", pink: "pink", beige: "beige", grey: "grey", gray: "grey",
  "שחור": "black", "שחורה": "black", "לבן": "white", "לבנה": "white", "אדום": "red", "אדומה": "red", "כחול": "blue", "כחולה": "blue",
  "ירוק": "green", "ירוקה": "green", "ורוד": "pink", "ורודה": "pink", "בז'": "beige", "אפור": "grey", "אפורה": "grey",
};

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((t) => t.replace(/^[בהלמוש](?=[֐-׿]{2,})/u, ""))
    .filter(Boolean);
}

function rawTokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
}

export function mockVariant(text: string): Record<string, string> | undefined {
  for (const token of [...rawTokens(text), ...tokens(text)]) {
    const size = SIZE_WORDS[token.replace(/^-+/, "")];
    if (size) return { size };
  }
  const glued = text.match(/(?:^|[\s(])(?:ב-?|in\s+)?(XXL|XL|XS|S|M|L)\b/);
  if (glued) return { size: glued[1].toUpperCase() };
  return undefined;
}

function mockColor(text: string): string | undefined {
  for (const token of [...rawTokens(text), ...tokens(text)]) {
    if (COLOR_WORDS[token]) return COLOR_WORDS[token];
  }
  return undefined;
}

function mockBudget(text: string): { amount: number; currency?: string } | undefined {
  const match = text.match(/(?:under|up to|below|max|עד|מתחת ל-?)\s*(?:₪|ils|nis)?\s*(\d{2,6})|₪\s*(\d{2,6})|(\d{2,6})\s*(?:₪|ש"ח|שקל|שקלים|ils|nis)/i);
  const amount = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: "ILS" } : undefined;
}

function ordinal(text: string): number | undefined {
  for (const [re, index] of ORDINALS) if (re.test(text)) return index;
  return undefined;
}

const SELECT_VERB = /\b(take|add|want|get|buy|i'?ll have|go with)\b|אקח|ניקח|תוסיף|תוסיפי|שים לי|שימי לי|תביא לי|תביאי לי|רוצה את|בא לי את/i;
const CHANGE_VERB = /\b(make it|change (?:it|size)?|switch (?:it|to)|instead)\b|תחליף|תחליפי|תשנה|תשני|במקום|עזוב/i;
const CHECKOUT = /\b(checkout|check out|pay now|ready to pay)\b|לתשלום|לקופה|אני רוצה לשלם|בוא נשלם|איך משלמים/i;
const NEGOTIATE = /(?:יש מצב|אפשר ב-?|תעשה לי|can you do|would you take|for)\s*(?:₪)?\s*(\d{2,6})\s*\??/i;

export function mockCommerceSemantics(
  text: string,
  context: { hasPreviousResults: boolean; hasCart: boolean; canSearch: boolean }
): CommerceSemantics | undefined {
  if (!context.canSearch) return undefined;

  if (CHECKOUT.test(text) && context.hasCart) return { intent: "checkout" };

  const negotiate = text.match(NEGOTIATE);
  if (negotiate && (context.hasCart || context.hasPreviousResults) && /\?|יש מצב|can you|would you/i.test(text)) {
    return { intent: "negotiate_price", requestedPrice: { amount: Number(negotiate[1]) } };
  }

  const index = ordinal(text);
  const variant = mockVariant(text);

  if (CHANGE_VERB.test(text)) {
    if (index !== undefined && context.hasPreviousResults) {
      return { intent: "select", reference: { type: "previous_result", index }, variant };
    }
    if (variant && context.hasCart) return { intent: "change_variant", reference: { type: "cart_line", index: 0 }, variant };
    if (variant && context.hasPreviousResults) return { intent: "select", variant };
  }

  if (index !== undefined && context.hasPreviousResults && (SELECT_VERB.test(text) || text.trim().split(/\s+/).length <= 4)) {
    return { intent: "select", reference: { type: "previous_result", index }, variant };
  }

  if (SELECT_VERB.test(text) && context.hasPreviousResults && /\b(it|this one|that one)\b|אותה|אותו/i.test(text)) {
    return { intent: "select", reference: { type: "previous_result", index: 0 }, variant };
  }

  if (variant && !context.hasCart && context.hasPreviousResults && text.trim().split(/\s+/).length <= 3) {
    return { intent: "select", variant };
  }

  // Anything else descriptive becomes a catalog search with the customer's
  // own words — the business's provider decides what matches.
  const budget = mockBudget(text);
  const color = mockColor(text);
  const looksLikeRequest = /\b(need|looking for|want|show|have|any|search)\b|צריך|צריכה|מחפש|מחפשת|רוצה|יש לכם|תראה|תראי/i.test(text);
  if (!looksLikeRequest && !budget && !color) return undefined;
  return {
    intent: "search",
    query: {
      text,
      attributes: color ? { color } : undefined,
      budget,
    },
    variant,
  };
}
