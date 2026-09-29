import type { CompileOutcome } from "./ir";

/**
 * The customer details BARRY asks for are DETERMINISTIC TRUTH: exactly the
 * fields the compiler reported missing (from the Business Genome / the
 * business playbook). A model may phrase the request naturally, but it may
 * not change the requirement — asking for "full name" when the business
 * needs "name", or for an email nobody requires.
 *
 * This checker knows the common contact fields' vocabulary in the
 * languages BARRY has deterministic strings for. It is deliberately
 * conservative: when in doubt it reports a violation, and the runtime
 * falls back to the localized deterministic request — always correct,
 * just plainer. Business-specific custom fields are never forbidden (they
 * can't be checked generically); they are only ever asked for when missing.
 */

type Terms = Partial<Record<string, RegExp[]>>;

/** Words that mean the common contact fields (per language). */
const FIELD_TERMS: Record<string, Terms> = {
  name: { en: [/\bname\b/i], he: [/(^|[^\p{L}])(ה|ו|ש)?שם(?![\p{L}])/u] },
  phone: { en: [/\bphone\b/i, /\bmobile\b/i, /\bcell\b/i], he: [/טלפון/, /נייד/, /פלאפון/] },
  email: { en: [/\be-?mail\b/i], he: [/אימייל/, /מייל/, /דוא"?ל/] },
  // "email address" / "כתובת (ה)אימייל" is the email field, not a postal address.
  address: { en: [/(?<!e-?mail\s)\baddress\b/i], he: [/כתובת(?!\s+(ה)?(אימייל|מייל|דוא))/] },
};

/** Stricter versions of a field the business did NOT ask for. */
const QUALIFIED: Record<string, Terms> = {
  name: { en: [/\bfull\s+name\b/i, /\b(first|last|sur)\s*name\b/i], he: [/שם\s+מלא/, /שם\s+פרטי/, /שם\s+משפחה/] },
};

/** Localised labels used by deterministic fallbacks (and removed before scanning, see below). */
export const FIELD_LABELS: Record<string, Record<string, string>> = {
  en: { name: "name", phone: "phone number", email: "email address", address: "address" },
  he: { name: "שם", phone: "מספר טלפון", email: "כתובת אימייל", address: "כתובת" },
};

export function fieldLabel(field: string, lang: string): string {
  return FIELD_LABELS[lang]?.[field] ?? FIELD_LABELS.en[field] ?? field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export function infoRequestFields(outcome: CompileOutcome | undefined): string[] | undefined {
  if (!outcome) return undefined;
  if (outcome.kind === "needs_info" || outcome.kind === "checkout_needs_info" || outcome.kind === "capability_needs_input") return outcome.missingFields;
  return undefined;
}

const matchesAny = (text: string, terms: RegExp[] | undefined) => (terms ?? []).some((re) => re.test(text));

export type ContractViolation = { reason: string };

/** Does a composed reply ask for exactly the missing fields — no more, no stricter, none dropped? */
export function checkInfoRequest(text: string, missing: string[], lang: string): ContractViolation | undefined {
  const langs = [...new Set([lang, "en"])];
  // A missing field's own label may contain another field's word
  // ("כתובת אימייל" = email ADDRESS); take the requested labels out first.
  let scan = text;
  for (const field of missing) for (const l of langs) scan = scan.split(fieldLabel(field, l)).join(" ");

  for (const field of missing) {
    const terms = FIELD_TERMS[field];
    if (!terms) continue; // custom business field: can't be checked generically
    const asked = langs.some((l) => matchesAny(text, terms[l]));
    if (!asked) return { reason: `does not ask for "${field}"` };
  }
  for (const [field, terms] of Object.entries(FIELD_TERMS)) {
    if (missing.includes(field)) continue;
    if (langs.some((l) => matchesAny(scan, terms[l]))) return { reason: `asks for "${field}", which is not missing` };
  }
  for (const [field, terms] of Object.entries(QUALIFIED)) {
    if (!missing.includes(field)) continue;
    const stricter = ["full_name", "first_name", "last_name"].some((f) => missing.includes(f));
    if (!stricter && langs.some((l) => matchesAny(text, terms[l]))) return { reason: `asks for a stricter "${field}" than the business requires` };
  }
  return undefined;
}
