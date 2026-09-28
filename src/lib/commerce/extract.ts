import type { BarryIRConstraints } from "@/lib/reasoner/ir";

const SIZE_RE = /\b(?:size\s*)?([XSML]{1,2})\b/i;

function parseBudget(text: string): { amount: number; currency: string } | undefined {
  const match = text.match(/(?:under|up to|עד)\s*(?:₪|ils|nis|shekels?)?\s*(\d{2,5})|₪\s*(\d{2,5})/i);
  const amount = Number(match?.[1] ?? match?.[2]);
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: "ILS" } : undefined;
}

function parseSize(text: string): string | undefined {
  return text.match(SIZE_RE)?.[1]?.toUpperCase();
}

function selectionIndex(text: string): number {
  if (/\b(second|2nd)\b/i.test(text)) return 1;
  if (/\b(third|3rd)\b/i.test(text)) return 2;
  return 0;
}

export function extractCommerceConstraint(text: string): BarryIRConstraints["commerce"] | undefined {
  const lower = text.toLowerCase();
  const size = parseSize(text);

  if (/\bcheckout\b|לתשלום|לקופה/.test(lower)) return { action: "checkout" };
  if (/\b(?:actually\s+)?make it\b|\bchange (?:it|size)\b|תשנה|תשני/.test(lower)) {
    return size ? { action: "update_size", size } : undefined;
  }
  if (/\btake the\b|\badd (?:the )?(?:first|second|third|it)\b|אני אקח|תוסיף|תוסיפי/.test(lower)) {
    return { action: "add_first", selectionIndex: selectionIndex(text), size, quantity: /\btwo\b|שתיים|שניים/.test(lower) ? 2 : 1 };
  }
  if (!/\bdress\b|\bproduct\b|\bitem\b|שמלה|מוצר|פריט/.test(lower)) return undefined;

  const budget = parseBudget(text);
  return {
    action: "search",
    query: {
      text,
      category: /\bdress\b|שמלה/.test(lower) ? "dress" : undefined,
      occasion: /\bwedding\b|חתונה/.test(lower) ? "wedding" : undefined,
      color: /\bblack\b|שחור|שחורה/.test(lower) ? "black" : undefined,
      size,
      budgetAmount: budget?.amount,
      currency: budget?.currency,
    },
  };
}
