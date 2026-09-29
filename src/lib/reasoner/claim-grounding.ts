import type { ComposeResponseInput, ReasonerContext } from "./types";
import { buildReceipts, operationKinds, type OperationKind } from "./receipts";

/**
 * Claim grounding — the last check between a model-written reply and the customer.
 *
 * The composer is told to describe only what BARRY's receipts show; this verifies it did, for the
 * claims that matter to a transaction. It does NOT interpret what the customer said and does not
 * judge tone. It recognises completion/status CLAIMS in BARRY's own outgoing reply and requires
 * evidence for each from BARRY's records:
 *  - "it was refunded / changed / cancelled / sent / created" -> a real operation of that kind
 *    (this turn, or earlier in the conversation's recorded results);
 *  - "I asked the owner / the owner approved" -> an owner request that exists;
 *    "still waiting for the owner" -> one that is actually still waiting;
 *  - a price/amount -> one from the business's facts or results (or plain arithmetic on them:
 *    quantity, a stated percentage, a sum);
 *  - a measurement -> one present in the business's facts or the customer's own words.
 * An unsupported claim is removed; when that leaves nothing useful, the receipt-bound deterministic
 * reply is used. Every intervention is recorded in the trace.
 */

export type ClaimEvidence = {
  kinds: Set<OperationKind>;
  ownerRequestExists: boolean;
  ownerRequestWaiting: boolean;
  amounts: number[];
  /** Figures the customer stated themselves (repeatable as-is). */
  mentioned: number[];
  percentages: number[];
  factText: string;
  /** Lower-cased text of what the business's systems reported (statuses etc.). */
  reportedText: string;
};

const NEGATED = /\b(not|n't|never|no|can't|cannot|unable|won't|haven't|hasn't|wasn't|isn't|didn't)\b|לא |אין |אי אפשר|אינו|אינה|טרם/i;
const MODAL = /\b(will|'ll|can|could|would|may|might|if|once|after|when|before|want|like to|shall|should|able to|going to)\b|\?$|^(אם|האם) /i;
/** The customer did it ("once you've sent…"), not BARRY. */
const CUSTOMER_SUBJECT = /\byou(?:'ve| have)?\s+(?:\w+\s+)?(?:sent|updated|changed|cancell?ed|paid)\b/i;

type ClaimRule = { kind: OperationKind | "owner" | "owner_waiting"; en: RegExp; he: RegExp; needsCompletion?: boolean };

const COMPLETION_EN = /\b(i've|i have|we've|we have|has been|have been|was|were|is now|are now|is all|got|just|already|successfully|processed|issued|done)\b/i;

const RULES: ClaimRule[] = [
  { kind: "refund", en: /\b(refund(?:ed)?|reimburs\w*|credited)\b/i, he: /(החזרתי|הוחזר|הוחזרה|הוחזרו|זיכיתי|זוכית|זוכה|בוצע החזר|ההחזר (?:בוצע|אושר|עבר))/, needsCompletion: true },
  { kind: "update", en: /\b(updated|changed|rescheduled|moved|modified|amended|adjusted)\b/i, he: /(עדכנתי|עודכן|עודכנה|עודכנו|שיניתי|שונה|שונתה|שונו|הזזתי|הוזז|הוזזה|קבעתי מחדש)/, needsCompletion: true },
  { kind: "cancel", en: /\b(cancell?ed|withdrawn|voided|removed)\b/i, he: /(ביטלתי|בוטל|בוטלה|בוטלו|הסרתי|הוסר|הוסרה)/, needsCompletion: true },
  { kind: "send", en: /\b(sent|emailed|texted|forwarded)\b/i, he: /(שלחתי|נשלח|נשלחה|נשלחו)/, needsCompletion: true },
  { kind: "owner_waiting", en: /\b(owner|manager|boss)\b.*\b(waiting|pending|hear back|haven't heard|still)\b|\b(waiting|pending|still)\b.*\b(owner|manager|boss)('s)?\b/i, he: /(מחכה|ממתין|ממתינה|עדיין).*(בעל העסק|בעלת העסק|הבעלים|המנהל|האחראי)|(בעל העסק|בעלת העסק|הבעלים|המנהל|האחראי).*(מחכה|ממתין|ממתינה|עדיין)/ },
  { kind: "owner", en: /\b(owner|manager|boss)\b/i, he: /(בעל העסק|בעלת העסק|הבעלים|המנהל|האחראי)/ },
];

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MONEY = /(?:([$₪€£])\s?(\d[\d,]*(?:\.\d+)?))|(?:(\d[\d,]*(?:\.\d+)?)\s?(₪|\$|€|£|ILS|USD|EUR|NIS|ש["״]ח|שקל(?:ים)?|דולר(?:ים)?|dollars?|shekels?|euros?)(?![\p{L}]))/giu;
const MEASURE = /(\d+(?:\.\d+)?)\s?(inches|inch|in\b|["”]|cm\b|mm\b|ס["״]מ|סנטימטר\w*|אינץ['׳]?|מ["״]מ|kg\b|ק["״]ג|lbs?\b)/giu;

const num = (s: string) => Number(s.replace(/,/g, ""));

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => num(m[0])).filter((n) => Number.isFinite(n));
}

/** Amounts written as money (with a currency) inside free text. */
function moneyIn(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => num(m[2] ?? m[3])).filter((n) => Number.isFinite(n));
}

const MONEY_KEY = /amount|price|total|cost|fee|deposit|subtotal|shipping|balance/i;

/** Money inside structured results: numbers under money-named keys, and money written in strings. */
function collectMoney(value: unknown, into: number[], depth = 0, moneyKey = false): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "number") {
    if (moneyKey) into.push(value);
  } else if (typeof value === "string") {
    into.push(...moneyIn(value));
    if (moneyKey) into.push(...numbersIn(value));
  } else if (Array.isArray(value)) value.slice(0, 100).forEach((v) => collectMoney(v, into, depth + 1, moneyKey));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) collectMoney(v, into, depth + 1, moneyKey || MONEY_KEY.test(k));
}

/** Everything BARRY can show as evidence for a reply's claims. */
export function claimEvidence(ctx: ReasonerContext, input: ComposeResponseInput, earlier: { capabilityIds: string[]; actions: string[] }): ClaimEvidence {
  const kinds = new Set<OperationKind>();
  for (const r of buildReceipts(input)) if (r.result === "done" || r.result === "done_unconfirmed") r.kinds.forEach((k) => kinds.add(k));
  for (const id of earlier.capabilityIds) operationKinds("invokeCapability", id).forEach((k) => kinds.add(k));
  for (const a of earlier.actions) operationKinds(a).forEach((k) => kinds.add(k));
  if (input.outcome.kind === "withdrawn" && input.outcome.withdrawnRequests > 0) kinds.add("cancel");

  const requests = ctx.grounded?.ownerRequests ?? [];
  const ownerRequestWaiting = Boolean(input.policyReason) || input.existingOwnerRequest === "still_pending" || requests.some((r) => r.status === "waiting_on_owner");
  const ownerRequestExists = ownerRequestWaiting || Boolean(input.ownerDecision) || Boolean(input.existingOwnerRequest) || requests.length > 0 || (input.outcome.kind === "withdrawn" && input.outcome.withdrawnRequests > 0);

  const g = ctx.graph;
  // Amounts that arithmetic may start from: real prices/money only — never a day count, a stock
  // quantity or a phone digit that happens to sit in the same text.
  const base: number[] = [];
  const knowledge = g.knowledge.map((k) => k.content).join("\n");
  const customerText = ctx.state.messages.filter((m) => m.role === "customer").map((m) => m.content).join("\n");
  for (const o of g.offers) {
    base.push(...moneyIn(o.description));
    if (o.price !== null) base.push(o.price);
    if (o.depositAmount) base.push(o.depositAmount);
  }
  base.push(...moneyIn(knowledge), ...moneyIn(customerText));
  collectMoney(ctx.grounded?.shownResults, base);
  collectMoney(ctx.grounded?.cart, base);
  if (ctx.grounded?.cartTotal) base.push(...numbersIn(ctx.grounded.cartTotal));
  collectMoney(input.toolResult?.output, base);
  for (const st of input.steps ?? []) collectMoney(st.toolResult?.output, base);
  if (input.outcome.kind === "price_request") collectMoney({ current: input.outcome.current, requested: input.outcome.requested }, base);
  if (input.outcome.kind === "offer_fact") collectMoney(input.outcome.fact, base);
  for (const r of requests) base.push(...moneyIn(r.about));
  // The customer's own figures may be repeated back as they said them (no arithmetic on them).
  const mentioned = numbersIn(customerText);

  const percentages = new Set<number>([0]);
  for (const text of [knowledge, customerText, ...requests.map((r) => r.about)]) for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?(%|אחוז|percent)/giu)) percentages.add(Number(m[1]));
  for (const p of g.policies) if (typeof p.rule.value === "number") percentages.add(p.rule.value);
  if (ctx.state.knownFields.__discountPct) percentages.add(Number(ctx.state.knownFields.__discountPct));

  const factText = [
    ...g.offers.map((o) => `${o.name} ${o.description}`),
    knowledge,
    customerText,
    JSON.stringify(ctx.grounded?.shownResults ?? []),
    JSON.stringify(ctx.grounded?.cart ?? []),
    JSON.stringify(input.toolResult?.output ?? null),
  ].join("\n");

  const reportedText = JSON.stringify([input.toolResult?.output ?? null, ...(input.steps ?? []).map((st) => st.toolResult?.output ?? null), ctx.grounded?.capabilityResults ?? []]).toLowerCase();
  return { kinds, ownerRequestExists, ownerRequestWaiting, amounts: [...new Set(base.filter((n) => Number.isFinite(n) && n > 0))], mentioned, percentages: [...percentages], factText, reportedText };
}

function derivable(x: number, ev: ClaimEvidence): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) < 0.011 || Math.abs(Math.round(a) - b) < 0.011;
  if (ev.mentioned.some((m) => close(m, x))) return true;
  const amounts = ev.amounts.slice(0, 200);
  for (const a of amounts) {
    for (let q = 1; q <= 10; q++) {
      for (const p of ev.percentages) {
        if (close(a * q * (1 - p / 100), x)) return true;
        if (p > 0 && close(a * q * (p / 100), x)) return true;
      }
    }
  }
  for (let i = 0; i < amounts.length; i++) for (let j = i; j < amounts.length; j++) if (close(amounts[i] + amounts[j], x) || close(Math.abs(amounts[i] - amounts[j]), x)) return true;
  return false;
}

export type ClaimViolation = { sentence: string; why: string };

/** The unsupported claims in a reply (empty when every claim is backed by BARRY's records). */
export function findUnsupportedClaims(text: string, ev: ClaimEvidence): ClaimViolation[] {
  const out: ClaimViolation[] = [];
  for (const sentence of splitSentences(text)) {
    const negated = NEGATED.test(sentence);
    const modal = MODAL.test(sentence) || CUSTOMER_SUBJECT.test(sentence);
    const hits = new Set(RULES.filter((r) => r.en.test(sentence) || r.he.test(sentence)).map((r) => r.kind));
    if (!negated && hits.size > 0) {
      if (hits.has("owner_waiting")) {
        if (!ev.ownerRequestWaiting) out.push({ sentence, why: "says BARRY is waiting on the owner, but no request is waiting" });
      } else if (hits.has("owner") && !ev.ownerRequestExists) {
        out.push({ sentence, why: "mentions an owner request that was never made" });
      }
      const ownerSentence = hits.has("owner") || hits.has("owner_waiting");
      for (const rule of RULES) {
        if (rule.kind === "owner" || rule.kind === "owner_waiting" || !hits.has(rule.kind) || modal) continue;
        // Handing something to the owner is covered by the owner check, not a "sent" operation.
        if (rule.kind === "send" && ownerSentence) continue;
        const word = (sentence.match(rule.en) ?? sentence.match(rule.he))?.[0]?.toLowerCase();
        // A status the business's own system reported ("cancelled", "changed") is a fact, not a claim of BARRY's.
        if (word && ev.reportedText.includes(word)) continue;
        if (rule.needsCompletion && !rule.he.test(sentence) && !COMPLETION_EN.test(sentence)) continue;
        if (!ev.kinds.has(rule.kind as OperationKind)) out.push({ sentence, why: `claims a ${rule.kind} that no executed operation shows` });
      }
    }
    for (const m of sentence.matchAll(MONEY)) {
      const value = num(m[2] ?? m[3]);
      if (value > 0 && !derivable(value, ev)) out.push({ sentence, why: `states an amount (${m[0].trim()}) not in the business's facts or results` });
    }
    for (const m of sentence.matchAll(MEASURE)) {
      if (!ev.factText.includes(m[1])) out.push({ sentence, why: `states a measurement (${m[0].trim()}) not in the business's facts` });
    }
  }
  return out;
}

const CLOSER_EN = /^(?:(?:and )?if you (?:have|need) (?:any )?(?:other |more |further |additional )?(?:questions|help|assistance)|let me know if|feel free to|i'?m (?:here|happy|glad) (?:to help|for you|if you|whenever)|don'?t hesitate|is there anything else|anything else i can|happy to help with anything|just let me know|hope (?:this|that) helps)/i;
const CLOSER_HE = /^(?:אם יש (?:לך |לכם )?(?:עוד )?(?:שאלות|שאלה|משהו)|אם (?:תרצה|תרצי|תרצו) (?:עוד|משהו)|אני כאן(?: בשבילך| לכל)?[!.]?$|אשמח לעזור (?:בכל|אם|עם כל)|אל תהסס|אל תהססי|אם צריך עוד משהו)/;

/** Drop generic sign-off filler at the end of a reply (never the whole reply). */
export function trimClosers(text: string): string {
  const sentences = splitSentences(text);
  while (sentences.length > 1 && (CLOSER_EN.test(sentences.at(-1)!) || CLOSER_HE.test(sentences.at(-1)!))) sentences.pop();
  return sentences.length === splitSentences(text).length ? text : sentences.join(" ");
}

/** Remove the sentences carrying unsupported claims; undefined when nothing substantive would remain. */
export function withoutSentences(text: string, bad: ClaimViolation[]): string | undefined {
  const drop = new Set(bad.map((b) => b.sentence));
  const kept = splitSentences(text).filter((s) => !drop.has(s));
  const substantive = kept.filter((s) => !CLOSER_EN.test(s) && !CLOSER_HE.test(s));
  return substantive.length ? kept.join(" ") : undefined;
}
