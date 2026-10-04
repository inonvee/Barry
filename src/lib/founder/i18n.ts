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
    en: { pause_business: (n: string) => `Pause BARRY for ${n}`, resume_business: (n: string) => `Resume ${n}`, safe_mode_on: (n: string) => `Put ${n} in safe mode`, safe_mode_off: (n: string) => `Take ${n} out of safe mode`, require_approval_on: (n: string) => `Require approval for every consequential action at ${n}`, require_approval_off: (n: string) => `Lift approval-for-everything at ${n}`, pause_capability: (n: string, d?: string) => `Pause ${d ?? "a capability"} at ${n}`, resume_capability: (n: string, d?: string) => `Resume ${d ?? "a capability"} at ${n}`, set_mode: (n: string, d?: string) => `Switch ${n} to ${(d ?? "").toUpperCase()} mode` } as Record<FounderActionKind, (n: string, d?: string) => string>,
    he: { pause_business: (n: string) => `השהיית BARRY עבור ${n}`, resume_business: (n: string) => `חידוש הפעילות של ${n}`, safe_mode_on: (n: string) => `מעבר של ${n} למצב בטוח`, safe_mode_off: (n: string) => `יציאה של ${n} ממצב בטוח`, require_approval_on: (n: string) => `דרישת אישור לכל פעולה משמעותית אצל ${n}`, require_approval_off: (n: string) => `ביטול דרישת האישור לכל פעולה אצל ${n}`, pause_capability: (n: string, d?: string) => `השהיית ${HE_CAP[d ?? ""] ?? "יכולת"} אצל ${n}`, resume_capability: (n: string, d?: string) => `חידוש ${HE_CAP[d ?? ""] ?? "יכולת"} אצל ${n}`, set_mode: (n: string, d?: string) => `העברת ${n} למצב ${HE_MODE[d ?? ""] ?? d}` } as Record<FounderActionKind, (n: string, d?: string) => string>,
  },
  asked: {
    en: (title: string, effect: string) => `${title}?\n${effect}\nConfirm to apply it through the audited founder control.`,
    he: (title: string, effect: string) => `${title}?\n${effect}\nכדי להחיל זאת דרך בקרת המייסד המתועדת — צריך לאשר.`,
  },
  effect: {
    he: { pause_business: "BARRY יפסיק לענות בכל הערוצים, ידחה כל פעולה משמעותית ולא ישלח דבר ביוזמתו. שום דבר לא נמחק.", resume_business: "BARRY חוזר לענות ולפעול לפי הכללים של העסק עצמו. שום דבר אחר לא משתנה.", safe_mode_on: "כל פעולה משמעותית תחכה לאישור הבעלים, ו-BARRY לא ישלח דבר ביוזמתו. קריאות ותשובות נמשכות.", safe_mode_off: "פעולות משמעותיות חוזרות לפעול לפי הכללים של העסק, וההודעות היזומות חוזרות.", require_approval_on: "כל פעולה משמעותית שהכללים של העסק היו מתירים תחכה לאישור הבעלים. שום דבר שהכללים אוסרים לא מותר.", require_approval_off: "זה מרפה את הבקרה: פעולות משמעותיות חוזרות לפעול לפי הכללים של העסק עצמו (בקשות שממתינות נשארות ממתינות).", pause_capability: "היכולת תידחה עד שתחודש — למשל עבור ספק לא תקין או תקלה. קריאות ותשובות נמשכות.", resume_capability: "זה מרפה את הבקרה: היכולת חוזרת לפעול לפי הכללים של העסק.", set_mode: "מצב הפעולה משתנה; הכללים של העסק עצמם לא משתנים." } as Record<FounderActionKind, string>,
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
    en: { pause_business: "was paused", resume_business: "was resumed", safe_mode_on: "was put in safe mode", safe_mode_off: "was taken out of safe mode", require_approval_on: "was set to require approval for everything", require_approval_off: "had approval-for-everything lifted", pause_capability: "had a capability paused", resume_capability: "had a capability resumed", set_mode: "had its operating mode changed" } as Record<FounderActionKind, string>,
    he: { pause_business: "הושהה", resume_business: "חזר לפעולה", safe_mode_on: "עבר למצב בטוח", safe_mode_off: "יצא ממצב בטוח", require_approval_on: "עבר לדרישת אישור לכל פעולה", require_approval_off: "דרישת האישור לכל פעולה בוטלה", pause_capability: "יכולת הושהתה", resume_capability: "יכולת חודשה", set_mode: "מצב הפעולה שונה" } as Record<FounderActionKind, string>,
  },
  followUp: {
    en: { pause_business: (n: string) => `Resume ${n}`, safe_mode_on: (n: string) => `Take ${n} out of safe mode`, require_approval_on: (n: string) => `Lift approval-for-everything at ${n}` },
    he: { pause_business: (n: string) => `תחזיר את ${n} לפעולה`, safe_mode_on: (n: string) => `תוציא את ${n} ממצב בטוח`, require_approval_on: (n: string) => `תבטל את דרישת האישור אצל ${n}` },
  },
};

const HE_CAP: Record<string, string> = { payments: "התשלומים", commerce: "ההזמנות והעגלות", scheduling: "קביעת התורים", support: "פניות התמיכה", messaging: "ההודעות היוצאות", shipping: "המשלוחים" };
const HE_MODE: Record<string, string> = { simulator: "סימולטור", supervised: "מפוקח", live: "פעיל (LIVE)" };

export const actionTitle = (lang: Lang, kind: FounderActionKind, name: string, detail?: string) => T.title[lang][kind](name, detail);
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
