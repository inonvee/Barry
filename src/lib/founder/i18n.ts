import type { FounderActionKind } from "./command";

/**
 * Founder BARRY's confirmation flow in the founder's language (English / Hebrew) — NOT a localization project:
 * only the control confirmation, its result, its replay note and the few UI words around them. A confirmation is
 * part of the SAME conversational turn, so its language is the language of the ORIGINAL command (stored on the
 * record), never inferred from the button. Business names are never translated.
 */
export type Lang = "en" | "he";

const T = {
  title: {
    en: { pause_business: (n: string) => `Pause BARRY for ${n}`, resume_business: (n: string) => `Resume ${n}`, safe_mode_on: (n: string) => `Put ${n} in safe mode`, safe_mode_off: (n: string) => `Take ${n} out of safe mode` },
    he: { pause_business: (n: string) => `השהיית BARRY עבור ${n}`, resume_business: (n: string) => `חידוש הפעילות של ${n}`, safe_mode_on: (n: string) => `מעבר של ${n} למצב בטוח`, safe_mode_off: (n: string) => `יציאה של ${n} ממצב בטוח` },
  },
  asked: {
    en: (title: string, effect: string) => `${title}?\n${effect}\nConfirm to apply it through the audited founder control.`,
    he: (title: string, effect: string) => `${title}?\n${effect}\nכדי להחיל זאת דרך בקרת המייסד המתועדת — צריך לאשר.`,
  },
  effect: {
    he: { pause_business: "BARRY יפסיק לענות בכל הערוצים, ידחה כל פעולה משמעותית ולא ישלח דבר ביוזמתו. שום דבר לא נמחק.", resume_business: "BARRY חוזר לענות ולפעול לפי הכללים של העסק עצמו. שום דבר אחר לא משתנה.", safe_mode_on: "כל פעולה משמעותית תחכה לאישור הבעלים, ו-BARRY לא ישלח דבר ביוזמתו. קריאות ותשובות נמשכות.", safe_mode_off: "פעולות משמעותיות חוזרות לפעול לפי הכללים של העסק, וההודעות היזומות חוזרות." } as Record<FounderActionKind, string>,
  },
  done: {
    en: (title: string) => `Done — ${title.replace(/^\w/, (c) => c.toLowerCase())}${title.endsWith(".") ? "" : "."} Verified in the durable controls; the audit records you, the time and the reason.`,
    he: (title: string) => `בוצע — ${title}. אומת בבקרות הקבועות; הרישום מציין אותך, את הזמן ואת הסיבה.`,
  },
  verified: {
    en: (name: string, field: string, value: string, at: string | null, by: string | null) => `${name}: ${field} = ${value} in the durable controls (updated ${at} by ${by}).`,
    he: (name: string, field: string, value: string, at: string | null, by: string | null) => `${name}: ‏${field} = ${value} בבקרות הקבועות (עודכן ${at} על ידי ${by}).`,
  },
  unverified: {
    en: (detail: string) => `I applied the change but couldn't verify it: ${detail}`,
    he: (detail: string) => `החלתי את השינוי אבל לא הצלחתי לאמת אותו: ${detail}`,
  },
  failed: { en: "The control change failed; nothing was verified as changed.", he: "שינוי הבקרה נכשל; לא אומת שבוצע שינוי." },
  noChange: {
    en: (name: string) => `${name} is already in that state — nothing to change.`,
    he: (name: string) => `${name} כבר במצב הזה — אין מה לשנות.`,
  },
  replay: {
    en: (past: string, name: string, at: string) => `Already done — this confirmation was already used: ${name} ${past} at ${at}. Nothing ran again.`,
    he: (past: string, name: string, at: string) => `כבר בוצע — האישור הזה כבר נוצל: ${name} ${past} ב-${at}. שום דבר לא רץ שוב.`,
  },
  past: {
    en: { pause_business: "was paused", resume_business: "was resumed", safe_mode_on: "was put in safe mode", safe_mode_off: "was taken out of safe mode" } as Record<FounderActionKind, string>,
    he: { pause_business: "הושהה", resume_business: "חזר לפעולה", safe_mode_on: "עבר למצב בטוח", safe_mode_off: "יצא ממצב בטוח" } as Record<FounderActionKind, string>,
  },
  followUp: {
    en: { pause_business: (n: string) => `Resume ${n}`, safe_mode_on: (n: string) => `Take ${n} out of safe mode` },
    he: { pause_business: (n: string) => `תחזיר את ${n} לפעולה`, safe_mode_on: (n: string) => `תוציא את ${n} ממצב בטוח` },
  },
};

export const actionTitle = (lang: Lang, kind: FounderActionKind, name: string) => T.title[lang][kind](name);
export const actionEffect = (lang: Lang, kind: FounderActionKind, english: string) => (lang === "he" ? T.effect.he[kind] : english);
export const askedText = (lang: Lang, title: string, effect: string) => T.asked[lang](title, effect);
export const doneText = (lang: Lang, title: string) => T.done[lang](title);
export const verifiedText = (lang: Lang, ...a: Parameters<typeof T.verified.en>) => T.verified[lang](...a);
export const unverifiedText = (lang: Lang, detail: string) => T.unverified[lang](detail);
export const failedText = (lang: Lang) => T.failed[lang];
export const noChangeText = (lang: Lang, name: string) => T.noChange[lang](name);
export const replayText = (lang: Lang, kind: FounderActionKind, name: string, at: string) => T.replay[lang](T.past[lang][kind], name, at);
export const followUpFor = (lang: Lang, kind: FounderActionKind, name: string): string[] => {
  const f = (T.followUp[lang] as Record<string, (n: string) => string>)[kind];
  return f ? [f(name)] : [];
};

/** The few UI words around the confirmation flow. */
export const UI = {
  en: { needs_confirmation: "Needs your confirmation", executed: "Done · verified", replay: "Already done", confirm: "Confirm", confirmed: "Confirmed" },
  he: { needs_confirmation: "דורש אישור", executed: "בוצע ואומת", replay: "כבר בוצע", confirm: "אשר", confirmed: "אושר" },
} as const;
