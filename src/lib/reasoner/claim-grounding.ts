import type { ComposeResponseInput, ReasonerContext } from "./types";
import { operationKinds } from "./receipts";
import type { LedgerEntry } from "@/lib/runtime/ledger";

/** What a claim asserts happened — each is satisfied only by a matching domain effect in the ledger. */
export type ClaimKind = "refund" | "update" | "cancel" | "send" | "create" | "booking" | "payment" | "availability" | "delivery" | "callback" | "cart_empty";

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
  /** Claim kinds the ledger's domain effects support (never transport success or prior prose). */
  kinds: Set<ClaimKind>;
  ownerRequestExists: boolean;
  ownerRequestWaiting: boolean;
  amounts: number[];
  /** Figures the customer stated themselves (repeatable as-is). */
  mentioned: number[];
  percentages: number[];
  /** The business's own facts (Genome, provider data, results) — the only source for product facts. */
  factText: string;
  /** What the customer said — repeatable as THEIRS, never promoted to a product fact. */
  customerText: string;
  /** Lower-cased text of what the business's systems reported (statuses etc.). */
  reportedText: string;
};

const NEGATED = /\b(not|n't|never|no|can't|cannot|unable|won't|haven't|hasn't|wasn't|isn't|didn't)\b|לא |אין |אי אפשר|אינו|אינה|טרם/i;
const MODAL = /\b(will|'ll|can|could|would|may|might|if|once|after|when|before|want|like to|shall|should|able to|going to)\b|\?$|^(אם|האם) /i;
/** The customer did it ("once you've sent…"), not BARRY. */
const CUSTOMER_SUBJECT = /\byou(?:'ve| have)?\s+(?:\w+\s+)?(?:sent|updated|changed|cancell?ed|paid)\b/i;

/** `promiseToo`: a future promise ("we'll call you", "I'll email it") needs the same evidence as a completed claim. */
type ClaimRule = { kind: ClaimKind | "owner" | "owner_waiting"; en: RegExp; he: RegExp; needsCompletion?: boolean; promiseToo?: boolean };

const COMPLETION_EN = /\b(i've|i have|we've|we have|has been|have been|was|were|is now|are now|is all|got|just|already|successfully|processed|issued|done)\b/i;

const RULES: ClaimRule[] = [
  { kind: "refund", en: /\b(refund(?:ed)?|reimburs\w*|credited)\b/i, he: /(החזרתי|הוחזר|הוחזרה|הוחזרו|זיכיתי|זוכית|זוכה|בוצע החזר|ההחזר (?:בוצע|אושר|עבר))/, needsCompletion: true },
  { kind: "update", en: /\b(updated|changed|rescheduled|moved|modified|amended|adjusted)\b/i, he: /(עדכנתי|עודכן|עודכנה|עודכנו|שיניתי|שונה|שונתה|שונו|הזזתי|הוזז|הוזזה|קבעתי מחדש)/, needsCompletion: true },
  { kind: "cancel", en: /\b(cancell?ed|withdrawn|voided|removed)\b/i, he: /(ביטלתי|בוטל|בוטלה|בוטלו|הסרתי|הוסר|הוסרה|הוצאתי|הורדתי|הוצאו|הורדו)/, needsCompletion: true },
  // The cart's state is whatever the provider's cart says — never what was requested.
  { kind: "cart_empty", en: /\b(?:your )?cart is (?:now )?empty\b|\bnothing (?:left )?in your cart\b/i, he: /(הסל(?: שלך)? (?:כעת |עכשיו )?ריק|אין (?:כלום|שום דבר) בסל)/ },
  { kind: "send", en: /\b(sent|emailed|texted|forwarded)\b/i, he: /(שלחתי|נשלח|נשלחה|נשלחו)/, needsCompletion: true },
  // The effect vocabulary: each maps to domain effect types, and only the ledger can satisfy it.
  { kind: "create", en: /\b(opened|created|booked|placed|registered|filed|logged|reserved)\b/i, he: /(פתחתי|נפתח|נפתחה|יצרתי|נוצר|נוצרה|הזמנתי|רשמתי|נרשם|נרשמה|קבעתי לך|נקבע לך)/, needsCompletion: true },
  { kind: "booking", en: /\b(?:booking|appointment|reservation)\b[^.!?]*\b(?:confirmed|is set|all set|is booked|is reserved)\b|\b(?:you're|you are) (?:all )?(?:set|booked|confirmed)\b|\bconfirmed (?:your|the) (?:booking|appointment|reservation)\b/i, he: /(התור (?:נקבע|מאושר|אושר)|ההזמנה (?:מאושרת|אושרה)|התור שלך (?:מאושר|נקבע)|הכול מסודר|הוזמן|הוזמנה|הוזמנו|קבענו|נקבע ל)/ },
  // Different domain effects, never interchangeable: a payment LINK is not an email DELIVERY, and a
  // recorded enquiry is not an arranged CALLBACK.
  { kind: "delivery", en: /\b(?:emailed|e-mailed|sent (?:it |the link |this |you )?(?:to|at) your (?:e-?mail|inbox|address)|(?:to|in) your (?:e-?mail|inbox))\b/i, he: /(נשלח(?:ה)? ל(?:כתובת ה)?(?:אימייל|מייל)|שלחתי (?:לך )?ל(?:מייל|אימייל)|לתיבת הדואר|ישלח(?:ו)? למייל)/, promiseToo: true },
  { kind: "callback", en: /\b(?:(?:the |our )?team|someone|we|they|a (?:salesperson|representative|specialist))(?: will|'ll)? (?:reach out|call you|contact you|get back to you|be in touch|follow up with you)\b/i, he: /(יחזרו אליך|יצרו (?:איתך|אתך) קשר|ניצור (?:איתך|אתך) קשר|נחזור אליך|יתקשרו אליך|יחזור אליך)/, promiseToo: true },
  { kind: "payment", en: /\bpayment\b[^.!?]*\b(?:verified|received|confirmed|completed?|went through|successful|settled)\b|\b(?:paid|payment) (?:is |has been )?(?:verified|confirmed|received)\b/i, he: /(התשלום (?:אומת|התקבל|עבר|אושר)|קיבלתי את התשלום|שולם בהצלחה)/ },
  { kind: "availability", en: /\b(?:is|are|it's|we have|there's|there is|there are)\b[^.!?]*\b(?:available|in stock)\b|\b(?:slots?|openings?|times?|spots?) (?:available|free|open)\b/i, he: /(פנוי|פנויה|פנויים|פנויות|זמין|זמינה|זמינים|זמינות|במלאי|יש מקום)/ },
  { kind: "owner_waiting", en: /\b(?:waiting|wait) (?:for|on) (?:their|his|her|the|an?) ?(?:response|answer|reply|approval|decision|ok|sign-?off)\b|\b(?:pending|awaiting) (?:approval|sign-?off)\b|\b(owner|manager|boss)\b.*\b(waiting|pending|hear back|haven't heard|still)\b|\b(waiting|pending|still)\b.*\b(owner|manager|boss)('s)?\b|\b(?:owner|manager|boss)\b[^.!?]*\b(?:is |are )?(?:currently )?(?:reviewing|looking (?:into|at)|considering|checking)\b/i, he: /(?:מחכה|ממתין|ממתינה|ממתינים) (?:ל)?(?:תשובה|אישור|לאישור|לתשובה)|(מחכה|ממתין|ממתינה|עדיין).*(בעל העסק|בעלת העסק|הבעלים|המנהל|האחראי)|(בעל העסק|בעלת העסק|הבעלים|המנהל|האחראי).*(מחכה|ממתין|ממתינה|עדיין|בודק|בודקת|שוקל)/ },
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

/** The claim kinds one ledger entry supports (only real, confirmed domain effects). */
export function effectClaimKinds(e: LedgerEntry): ClaimKind[] {
  if (e.status === "withdrawn" || e.status === "superseded") return ["cancel"];
  if (e.status !== "effected") return [];
  switch (e.effect) {
    case "booking.created":
      return ["create", "booking"];
    case "order.created":
    case "order.fulfilled":
    case "enquiry.created":
      return ["create"];
    case "payment.settled":
      return ["payment"];
    case "payment.link_created":
      return ["send"];
    case "followup.scheduled":
      return ["send", "callback"];
    case "cart.line_added":
      return ["create"];
    case "cart.line_updated":
    case "cart.line_replaced":
      return ["update"];
    case "cart.line_removed":
      return ["cancel", "update"];
    case "availability.found":
    case "stock.available":
      return ["availability"];
  }
  if (e.effect.startsWith("request.") || e.effect.endsWith(".read") || e.effect.endsWith(".failed")) return [];
  // A confirmed consequential capability effect: its kind comes from BARRY's own operation id.
  return operationKinds("invokeCapability", e.operation).filter((k) => k !== "read") as ClaimKind[];
}

/**
 * Everything BARRY can show as evidence for a reply's claims: the conversation's effect LEDGER
 * (never transport success, never the assistant's own earlier prose), owner requests, and facts.
 * Availability is evidence only from a lookup in THIS turn (entries after `turnStartSeq`).
 */
export function claimEvidence(ctx: ReasonerContext, input: ComposeResponseInput, ledger: LedgerEntry[], turnStartSeq = 0): ClaimEvidence {
  const kinds = new Set<ClaimKind>();
  for (const e of ledger) {
    for (const k of effectClaimKinds(e)) {
      if (k === "availability" && e.seq <= turnStartSeq) continue;
      kinds.add(k);
    }
  }
  if (input.outcome.kind === "withdrawn" && input.outcome.withdrawnRequests > 0) kinds.add("cancel");
  // The cart is empty only if the provider's latest cart says so: the last cart receipt's after-state,
  // or (no cart change recorded) the cart as re-read this turn.
  const lastCart = [...ledger].reverse().find((e) => e.outcome && typeof e.outcome.cartAfter === "string");
  if (lastCart ? lastCart.outcome!.cartAfter === "empty" : !(ctx.grounded?.cart?.length)) kinds.add("cart_empty");
  // What the catalog itself reports as in stock (re-read from the provider this turn).
  if ((ctx.grounded?.shownResults ?? []).some((r) => r.variants.some((v) => v.inStock))) kinds.add("availability");

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
  for (const r of requests) base.push(...moneyIn(r.about), ...(typeof r.terms?.amount === "number" ? [r.terms.amount] : []));
  for (const e of ledger) if (typeof e.terms.amount === "number") base.push(e.terms.amount);
  collectMoney(input.quote, base);
  // The customer's own figures may be repeated back as they said them (no arithmetic on them).
  const mentioned = numbersIn(customerText);

  const percentages = new Set<number>([0]);
  for (const text of [knowledge, customerText, ...requests.map((r) => r.about)]) for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?(%|אחוז|percent)/giu)) percentages.add(Number(m[1]));
  for (const p of g.policies) if (typeof p.rule.value === "number") percentages.add(p.rule.value);
  if (ctx.state.knownFields.__discountPct) percentages.add(Number(ctx.state.knownFields.__discountPct));

  const factText = [
    ...g.offers.map((o) => `${o.name} ${o.description}`),
    knowledge,
    JSON.stringify(ctx.grounded?.shownResults ?? []),
    JSON.stringify(ctx.grounded?.cart ?? []),
    JSON.stringify(input.toolResult?.output ?? null),
  ].join("\n");

  const reportedText = JSON.stringify([input.toolResult?.output ?? null, ...(input.steps ?? []).map((st) => st.toolResult?.output ?? null), ctx.grounded?.capabilityResults ?? []]).toLowerCase();
  return { kinds, ownerRequestExists, ownerRequestWaiting, amounts: [...new Set(base.filter((n) => Number.isFinite(n) && n > 0))], mentioned, percentages: [...percentages], factText, customerText, reportedText };
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
    // Negation and modality are judged per clause: "it has been cancelled, and there will be no
    // charge" is a cancellation claim — the "no" belongs to the other clause.
    // Owner claims are judged on the whole sentence ("I asked the owner and I'm still waiting").
    const ownerHits = new Set(RULES.filter((r) => (r.kind === "owner" || r.kind === "owner_waiting") && (r.en.test(sentence) || r.he.test(sentence))).map((r) => r.kind));
    if (!NEGATED.test(sentence)) {
      if (ownerHits.has("owner_waiting")) {
        if (!ev.ownerRequestWaiting) out.push({ sentence, why: "says BARRY is waiting on the owner, but no request is waiting" });
      } else if (ownerHits.has("owner") && !ev.ownerRequestExists) {
        out.push({ sentence, why: "mentions an owner request that was never made" });
      }
    }
    for (const clause of clausesOf(sentence)) checkClause(clause, sentence, ownerHits.size > 0, ev, out);
    for (const m of sentence.matchAll(MONEY)) {
      const value = num(m[2] ?? m[3]);
      if (value > 0 && !derivable(value, ev)) out.push({ sentence, why: `states an amount (${m[0].trim()}) not in the business's facts or results` });
    }
    for (const m of sentence.matchAll(MEASURE)) {
      if (ev.factText.includes(m[1])) continue;
      // Provenance: a figure only the CUSTOMER gave (their room, a guess they relayed) may be repeated
      // as theirs — never asserted as a property of the product.
      const clause = clausesOf(sentence).find((c) => c.includes(m[0].trim())) ?? sentence;
      const attributedToCustomer = /\b(?:your|you|you've|you said|you mentioned)\b|שלך|שלכם|אצלך|ציינת|אמרת/i.test(clause) || NEGATED.test(clause);
      if (ev.customerText.includes(m[1]) && attributedToCustomer) continue;
      out.push({ sentence, why: `states a measurement (${m[0].trim()}) that no business fact supports` });
    }
  }
  return out;
}

function clausesOf(sentence: string): string[] {
  return sentence
    .split(/[,;—–]|\s(?:and|but|while|so)\s|\s-\s/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function checkClause(sentence: string, fullSentence: string, ownerSentence: boolean, ev: ClaimEvidence, out: ClaimViolation[]): void {
  {
    const negated = NEGATED.test(sentence);
    const modal = MODAL.test(sentence) || CUSTOMER_SUBJECT.test(sentence);
    const hits = new Set(RULES.filter((r) => r.en.test(sentence) || r.he.test(sentence)).map((r) => r.kind));
    if (!negated && hits.size > 0) {
      for (const rule of RULES) {
        if (rule.kind === "owner" || rule.kind === "owner_waiting" || !hits.has(rule.kind) || (modal && !rule.promiseToo)) continue;
        // Handing something to the owner is covered by the owner check, not a "sent" operation.
        if (rule.kind === "send" && ownerSentence) continue;
        const word = (sentence.match(rule.en) ?? sentence.match(rule.he))?.[0]?.toLowerCase();
        // A status the business's own system reported ("cancelled", "changed") is a fact, not a claim of BARRY's.
        if (word && ev.reportedText.includes(word)) continue;
        if (rule.needsCompletion && !rule.he.test(sentence) && !COMPLETION_EN.test(sentence)) continue;
        // A callback promise is kept when BARRY really will come back (an owner request that resumes the chat).
        if (rule.kind === "callback" && ev.ownerRequestWaiting) continue;
        if (!ev.kinds.has(rule.kind as ClaimKind)) out.push({ sentence: fullSentence, why: `claims a ${rule.kind} that no recorded business effect shows` });
      }
    }
  }
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

/**
 * Receipt identity: a business reference (e.g. a ticket number) belongs to the exact terms of the
 * request that produced it. A sentence that puts that reference next to ANOTHER request's
 * identifiers — and none of its own — re-attributes a receipt, and is rejected. Structural: the
 * pairs come from BARRY's frozen records, not from wording.
 */
export function findMisattributedReferences(text: string, records: { reference?: string; terms: Record<string, string | number> }[]): ClaimViolation[] {
  const idLike = (v: string | number) => typeof v === "string" && v.length >= 4 && /\d/.test(v);
  const withIds = records.map((r) => ({ reference: r.reference, own: Object.values(r.terms).filter(idLike).map(String) }));
  const all = new Set(withIds.flatMap((r) => r.own));
  const out: ClaimViolation[] = [];
  for (const sentence of splitSentences(text)) {
    for (const r of withIds) {
      if (!r.reference || !sentence.includes(r.reference)) continue;
      const mentioned = [...all].filter((id) => sentence.includes(id));
      if (mentioned.length > 0 && !mentioned.some((id) => r.own.includes(id))) {
        out.push({ sentence, why: `attributes ${r.reference} to ${mentioned.join(", ")}, but it belongs to ${r.own.join(", ") || "another request"}` });
      }
    }
  }
  return out;
}

/** The reply isn't in the conversation's language (by script — never by vocabulary). */
export function languageMismatch(text: string, code: string | undefined): string | undefined {
  if (code !== "he" && code !== "en") return undefined;
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 8) return undefined;
  const hebrew = letters.filter((ch) => /\p{Script=Hebrew}/u.test(ch)).length / letters.length;
  if (code === "he" && hebrew < 0.3) return "reply is not in Hebrew";
  if (code === "en" && hebrew > 0.3) return "reply is not in English";
  return undefined;
}
