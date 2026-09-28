import type { SourceDocument } from "./document";
import { groundingCorpus } from "./document";
import type { CandidateFact } from "./learner";

/**
 * Deterministic provenance check for learned facts — the Learn Business
 * equivalent of verifyIR. It never decides what a page MEANS; it only
 * keeps candidates whose cited quote really is on the page, whose numbers
 * come from that quote, and whose key is well-formed and not reserved for
 * the owner.
 */

export type GroundedFact = CandidateFact & { sourceUrl: string; sourceTitle?: string };
export type RejectedCandidate = { key: string; reason: string };

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[\p{Ll}\p{Lo}0-9_]+){1,3}$/u;
const MAX_VALUE = 500;
const MAX_QUOTE = 600;
const MAX_FACTS_PER_SOURCE = 60;

export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function numbersIn(text: string): string[] {
  return (text.normalize("NFKC").match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}

export function groundCandidateFacts(doc: SourceDocument, candidates: CandidateFact[]): { facts: GroundedFact[]; rejected: RejectedCandidate[] } {
  const corpus = normalizeForMatch(groundingCorpus(doc));
  const facts: GroundedFact[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const c of candidates.slice(0, MAX_FACTS_PER_SOURCE)) {
    const key = String(c.key ?? "").trim();
    const value = String(c.value ?? "").trim();
    const quote = String(c.quote ?? "").trim();
    const reject = (reason: string) => rejected.push({ key: key || "(missing key)", reason });

    if (!KEY_PATTERN.test(key) || key.length > 64) {
      reject("malformed key");
      continue;
    }
    if (key.startsWith("authority.")) {
      reject("authority comes only from the owner");
      continue;
    }
    if (!value || value.length > MAX_VALUE) {
      reject("empty or oversized value");
      continue;
    }
    if (!quote || quote.length > MAX_QUOTE) {
      reject("no supporting quote");
      continue;
    }
    if (!corpus.includes(normalizeForMatch(quote))) {
      reject("quote not found on the page");
      continue;
    }
    if (c.classification === "fact") {
      const quoteNumbers = new Set(numbersIn(quote));
      const unsupported = numbersIn(value).filter((n) => !quoteNumbers.has(n));
      if (unsupported.length > 0) {
        reject(`number(s) ${unsupported.join(", ")} not in the quote`);
        continue;
      }
    }
    if (facts.some((f) => f.key === key)) {
      reject("duplicate key");
      continue;
    }
    const classification = c.classification === "policy" ? "fact" : c.classification;
    const confidence = classification !== "fact" && c.confidence === "high" ? "medium" : c.confidence;
    facts.push({ key, value, quote, classification, confidence, sourceUrl: doc.url, sourceTitle: doc.title });
  }
  return { facts, rejected };
}
