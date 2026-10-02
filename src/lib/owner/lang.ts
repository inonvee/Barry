/**
 * OWNER LANGUAGE (pure, client-safe) — the two product languages of the Owner OS: English and Hebrew.
 *
 * The language is a PRESENTATION choice only. It never changes business policy, authority or what BARRY
 * does — it changes the words the owner reads. Every owner-facing text producer takes a `lang` and
 * defaults to English, so channels that don't pass one (the Owner WhatsApp channel) behave exactly as
 * before. Source content (customer messages, provider evidence, facts the owner wrote) is shown as it is.
 */

export type OwnerLang = "en" | "he";
export const OWNER_LANGS: OwnerLang[] = ["en", "he"];
export const isOwnerLang = (x: unknown): x is OwnerLang => x === "en" || x === "he";
export const dirOf = (lang: OwnerLang) => (lang === "he" ? "rtl" : "ltr");
/** The language a request asked for (query `lang`), English when absent or unknown. */
export const langFrom = (raw: string | null | undefined): OwnerLang => (raw === "he" ? "he" : "en");

/** Bilingual inline text for text producers: L(lang, "English", "עברית"). */
export const L = (lang: OwnerLang, en: string, he: string) => (lang === "he" ? he : en);

const LOCALE: Record<OwnerLang, string> = { en: "en", he: "he-IL" };
export const localeOf = (lang: OwnerLang) => LOCALE[lang];

/**
 * A count with its noun. English: "1 decision" / "3 decisions". Hebrew counts read naturally with the
 * number after the noun for one ("החלטה אחת") and before it otherwise ("3 החלטות").
 */
export function count(lang: OwnerLang, n: number, en: [string, string], he: [string, string, ("m" | "f")?]): string {
  if (lang === "he") return n === 1 ? `${he[0]} ${(he[2] ?? (/[הת]$/.test(he[0]) ? "f" : "m")) === "f" ? "אחת" : "אחד"}` : `${n} ${he[1]}`;
  return `${n} ${n === 1 ? en[0] : en[1]}`;
}

/** Money in its own currency(ies), never converted; "—" when there is none. */
export function money(lang: OwnerLang, m: Record<string, number> | undefined, empty = "—"): string {
  const parts = Object.entries(m ?? {}).filter(([, v]) => v !== 0);
  if (!parts.length) return empty;
  return parts.map(([c, v]) => amount(lang, v, c)).join(" + ");
}

export function amount(lang: OwnerLang, v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency, maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);
  } catch {
    return `${v} ${currency}`;
  }
}

export const number = (lang: OwnerLang, v: number) => new Intl.NumberFormat(LOCALE[lang]).format(v);

/** "5m ago" / "לפני 5 דק׳" — relative, compact. */
export function ago(lang: OwnerLang, iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return L(lang, "just now", "עכשיו");
  if (m < 60) return L(lang, `${m}m ago`, `לפני ${m} דק׳`);
  const h = Math.round(m / 60);
  if (h < 24) return L(lang, `${h}h ago`, h === 1 ? "לפני שעה" : h === 2 ? "לפני שעתיים" : `לפני ${h} שעות`);
  const d = Math.round(h / 24);
  return L(lang, `${d}d ago`, d === 1 ? "אתמול" : d === 2 ? "לפני יומיים" : `לפני ${d} ימים`);
}

/** A date/time in the business's own time zone, in the owner's language. */
export function when(lang: OwnerLang, iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** The city of an IANA time zone, in owner words ("Asia/Jerusalem" → "Jerusalem" / "ירושלים"). */
const CITY_HE: Record<string, string> = { Jerusalem: "ירושלים", Tel_Aviv: "תל אביב", London: "לונדון", New_York: "ניו יורק", Paris: "פריז", Berlin: "ברלין", Los_Angeles: "לוס אנג׳לס" };
export function cityOf(lang: OwnerLang, timeZone: string): string {
  const city = timeZone.split("/").at(-1) ?? timeZone;
  return lang === "he" ? (CITY_HE[city] ?? city.replace(/_/g, " ")) : city.replace(/_/g, " ");
}
