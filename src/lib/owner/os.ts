import type { BusinessGraph, Policy } from "@/lib/business-graph";
import type { TrainedRule } from "@/lib/policy/effective-rules";
import { policyWords } from "@/lib/policy/words";
import type { InitiativeView } from "@/lib/initiative/model";
import type { OperationState } from "./operation-model";
import type { PilotReadiness, ReadinessCheck } from "./readiness";
import type { OwnerChannels, OwnerOperator, OwnerWorkspace } from "./service";
import { activityFeed, kindCount, proactiveWords, type ActivityItem } from "./control-room";
import { L, cityOf, money as fmtMoney, type OwnerLang } from "./lang";

/**
 * THE OWNER BUSINESS OS (pure, client-safe) — owner-language projections over the systems that already
 * exist, in English or Hebrew. Nothing here decides or enforces anything: the policy engine, founder
 * controls, the initiative engine, the capability-readiness model and the connection registry stay
 * authoritative. These functions only say, in the owner's words, what those systems already hold:
 *
 *   initiatives → "BARRY noticed"        approvals/handoffs → "Needs you"     operations → "BARRY is working"
 *   policy      → "Rules BARRY follows"  business knowledge → "What BARRY knows"  connections → "Connected systems"
 *   audit       → "Activity"             readiness → "BARRY setup"            controls → "How autonomous BARRY is"
 *
 * Honesty rules: a simulator is never "real"; a rule's source is the provenance the runtime recorded; a
 * PERMISSION (what a rule allows) is never presented as a CAPABILITY (what a connected system can do);
 * a readiness level is the server's assessment (never computed here); a blocker says who acts and where.
 */

type T = (en: string, he: string) => string;
const tr = (lang: OwnerLang): T => (en, he) => L(lang, en, he);

// ── Work: one state vocabulary for everything BARRY is doing or noticed ──────────────────────────────

export type WorkState = "new" | "watching" | "working" | "waiting_on_you" | "waiting_on_customer" | "done" | "dismissed" | "snoozed";

export const WORK_STATE_WORDS: Record<WorkState, string> = { new: "New", watching: "Watching", working: "Working", waiting_on_you: "Waiting on you", waiting_on_customer: "Waiting on customer", done: "Done", dismissed: "Dismissed", snoozed: "Snoozed" };
export const WORK_STATE_WORDS_HE: Record<WorkState, string> = { new: "חדש", watching: "במעקב", working: "בעבודה", waiting_on_you: "מחכה לך", waiting_on_customer: "מחכה ללקוח", done: "הושלם", dismissed: "נדחה", snoozed: "נדחה לשבוע" };
export const workStateWords = (s: WorkState, lang: OwnerLang = "en") => (lang === "he" ? WORK_STATE_WORDS_HE : WORK_STATE_WORDS)[s];

/** An initiative's lifecycle (the engine's) in the owner's work vocabulary. */
export function noticedState(i: Pick<InitiativeView, "state" | "alreadyHandled" | "ownerActionNeeded">): WorkState {
  switch (i.state) {
    case "verified":
    case "surfaced":
      return i.alreadyHandled ? "working" : "new";
    case "reviewed":
      return i.alreadyHandled ? "working" : "watching";
    case "accepted":
    case "acting":
      return "working";
    case "measured":
    case "resolved":
      return "done";
    case "snoozed":
      return "snoozed";
    case "dismissed":
    case "invalidated":
      return "dismissed";
  }
}

/** An owner operation's derived state in the same vocabulary. */
export function operationWorkState(s: OperationState): WorkState {
  switch (s) {
    case "proposed":
    case "blocked":
    case "failed":
      return "waiting_on_you";
    case "running":
      return "working";
    case "waiting_on_customers":
      return "waiting_on_customer";
    case "completed":
    case "stopped":
      return "done";
  }
}

// ── BARRY noticed ───────────────────────────────────────────────────────────────────────────────────

const TOPIC_HE: Record<string, string> = { returns: "החזרות", return: "החזרות", exchanges: "החלפות", shipping: "משלוחים", delivery: "משלוחים", refunds: "החזרים כספיים", refund: "החזרים כספיים", sizes: "מידות", size: "מידות", hours: "שעות פתיחה", payment: "תשלום", payments: "תשלום", warranty: "אחריות", stock: "מלאי", availability: "זמינות", price: "מחיר", prices: "מחירים" };
const topicWords = (lang: OwnerLang, topic: string) => (lang === "he" ? (TOPIC_HE[topic.toLowerCase()] ?? topic.replace(/[_-]+/g, " ")) : topic.replace(/[_-]+/g, " ").trim());

/** Owner-safe link for a recommendation (the technical connections page is never an owner destination). */
const ownerHref = (href: string) => (href.startsWith("/connections") ? "/owner/systems" : href.startsWith("/owner/train") ? href.replace("/owner/train", "/owner/knowledge") : href);

/** The persisted initiative in Hebrew, recomputed from its detector, subject and metric — never invented. */
function initiativeHe(i: InitiativeView): { title: string; observation: string; basis: string; recommendation: string; actionLabel?: string } | undefined {
  const m = i.metric;
  const money = fmtMoney("he", i.metric.amount ?? i.impact.amount, "");
  const t = topicWords("he", i.subject);
  switch (i.detector) {
    case "repeated_question": {
      const friction = i.impact.type === "conversion";
      return {
        title: friction ? `לקוחות שואלים על ${t} — ורבים לא קונים` : `${t}: שאלה שחוזרת`,
        observation: `${m.count === 1 ? "לקוח אחד שאל" : `${m.count} לקוחות שאלו`} על ${t} בשבוע האחרון.${friction ? ` ${m.total ?? 0} מהם הוסיפו לעגלה ועדיין לא השלימו רכישה.` : ""}`,
        basis: `נספר מ־${m.count} שיחות שבהן BARRY ענה מהמידע שלך על ${t}.`,
        recommendation: friction ? `כדאי להציג את התשובה על ${t} מוקדם יותר — בעמוד המוצר, בתשובה הראשונה או בתשלום — כדי שלקוחות לא יצטרכו לשאול.` : `אם התשובה על ${t} עוד לא מופיעה באתר, הוספה שלה תחסוך ללקוחות שאלה.`,
        actionLabel: "לבדוק מה BARRY עונה",
      };
    }
    case "unanswered_questions":
      return {
        title: "לקוחות שואלים דברים ש־BARRY עוד לא יודע",
        observation: `השבוע, ב־${m.count === 1 ? "שיחה אחת" : `${m.count} שיחות`}, לקוחות שאלו ${m.total ?? m.count} שאלות שהמידע של העסק לא מכסה — ו־BARRY לא יכול היה לענות.`,
        basis: `נספר מ־${m.total ?? m.count} תשובות שבהן BARRY סימן שאלה כלא נענתה.`,
        recommendation: "עבור על השיחות האלה ולמד את BARRY את התשובות החסרות — כל תשובה חוסכת המתנה ללקוח הבא.",
        actionLabel: "ללמד את BARRY",
      };
    case "abandoned_demand": {
      const kind = i.subject as Parameters<typeof kindCount>[1];
      const open = kindCount("he", kind, m.total ?? m.count);
      return {
        title: `${kindCount("he", kind, m.count)} בלי מעקב עדיין`,
        observation: `${open} עדיין פתוחים. ${m.count} עוד לא קיבלו מעקב${money ? ` (${money} — לא הכנסה)` : ""}.`,
        basis: "מהרשומות הפתוחות ש־BARRY עוקב אחריהן. פריטי בדיקה נספרים, אבל אף פעם לא ככסף.",
        recommendation: i.canAct ? "BARRY יכול לעקוב אחריהם לפי הכללים שלך — אתה מאשר את ההתחלה ורואה מי קיבל הודעה." : "כדאי לעבור עליהם — כל אחד אומר של מי התור עכשיו.",
        actionLabel: i.recommendation.action?.kind === "command" ? proactiveWords(kind, "he").command : "לפתוח",
      };
    }
    case "repeat_approvals":
      return {
        title: "אתה מאשר שוב ושוב את אותו סוג בקשה",
        observation: `ב־14 הימים האחרונים אישרת ${m.total ?? 0} מתוך ${m.count} בקשות ש־BARRY עצר לשאול עליהן.`,
        basis: `מ־${m.count} בקשות שנרשמו ומההחלטה שלך בכל אחת.`,
        recommendation: "אפשר ללמד את BARRY כלל קבוע כדי שלקוחות לא יחכו לך. BARRY לא משנה את הגבולות שלך לבד — אתה בודק את הכלל לפני שהוא נכנס לתוקף.",
        actionLabel: "ללמד כלל",
      };
    case "product_interest":
      return {
        title: `${i.subject}: עניין רב, מעט רכישות`,
        observation: `${m.count === 1 ? "לקוח אחד הוסיף" : `${m.count} לקוחות הוסיפו`} את ${i.subject} לעגלה בשבוע האחרון; ${m.total ?? 0} השלימו רכישה.`,
        basis: "משינויי עגלה שאושרו מול החנות שלך, ומההזמנות שבאו אחריהם.",
        recommendation: "אנשים רוצים את המוצר אבל נעצרים בעגלה. כדאי לבדוק מחיר, מידות וזמינות או משלוח — ולפתוח כמה מהשיחות כדי לראות איפה עצרו.",
        actionLabel: "לשיחות",
      };
    case "money_at_risk":
      return {
        title: `${money || "כסף"} בסיכון`,
        observation: `${money} ב־${m.count === 1 ? "מכירה אחת" : `${m.count} מכירות`} עלולים ללכת לאיבוד אם אף אחד לא יפעל — תשלומים שנכשלו, רכישות שנתקעו או קישורים ישנים שלא שולמו.`,
        basis: "מרשומות פתוחות אצל ספק התשלומים האמיתי. זו לא הכנסה; כסף של בדיקות לא נכלל.",
        recommendation: "כל אחד אומר של מי התור. בדרך כלל כדאי להתחיל מהגדול.",
        actionLabel: "לכסף",
      };
    case "cost_evidence_missing":
      return {
        title: "BARRY עוד לא יכול לחפש חיסכון",
        observation: "התוכנית שלך כוללת ניתוח עלויות ורווחיות, אבל לא מחוברות רשומות עלות מאומתות — אין עם מה להשוות.",
        basis: "אין רשומות עלות מאומתות.",
        recommendation: "חבר את המערכת שמחזיקה את עלויות הספקים, המשלוחים או העמלות — ו־BARRY ישווה תקופות רק מהרשומות האלה.",
        actionLabel: "למערכות",
      };
    case "cost_increase":
      return {
        title: `העלויות של ${i.subject} עלו ב־${Math.round((m.rate ?? 0) * 100)}%`,
        observation: `העלויות של ${i.subject} עלו ב־${Math.round((m.rate ?? 0) * 100)}%${money ? ` (תוספת של ${money})` : ""} ב־30 הימים האחרונים, לעומת 30 הימים שלפני.`,
        basis: `מ־${m.count} רשומות עלות מאומתות. אין מספיק ראיות כדי לטעון לחיסכון.`,
        recommendation: "כדאי לבדוק מה השתנה אצל הספק. BARRY לא יטען לחיסכון עד שתוכח חלופה זולה יותר.",
      };
  }
  return undefined;
}

const CONFIDENCE = { en: { high: "High confidence", medium: "Medium confidence", low: "Low confidence" }, he: { high: "ודאות גבוהה", medium: "ודאות בינונית", low: "ודאות נמוכה" } } as const;
const IMPORTANCE_HE = { high: "כדאי לטפל בקרוב", medium: "שווה הצצה", low: "כשיהיה לך רגע" } as const;

/**
 * One "BARRY noticed" item, every question the owner asks of it answered from the persisted initiative:
 * what, why it matters, the evidence, how sure, the money involved (never called revenue), the next step,
 * whether BARRY can act, whether it needs approval, whether it is already handled, and the result.
 */
export function noticedCard(i: InitiativeView, lang: OwnerLang = "en") {
  const T = tr(lang);
  const he = lang === "he" ? initiativeHe(i) : undefined;
  const amount = fmtMoney(lang, i.impact.amount, "");
  const verified = fmtMoney(lang, i.result?.verifiedValue, "");
  const state = noticedState(i);
  const kind = i.impact.type;
  const a = i.recommendation.action;
  return {
    id: i.id,
    state,
    stateWords: workStateWords(state, lang),
    importance: lang === "he" ? IMPORTANCE_HE[i.importance] : i.importanceWords,
    what: he?.title ?? i.title.replace(/^\p{Ll}/u, (c) => c.toUpperCase()),
    observation: he?.observation ?? i.observation,
    whyItMatters: lang === "he" ? (kind === "revenue_at_risk" ? "כסף שעלול ללכת לאיבוד — לא הכנסה." : kind === "recoverable_demand" ? "ביקוש פתוח שאפשר להחזיר — לא הכנסה." : kind === "conversion" ? "רכישות שלא הושלמו — לא נתון הכנסה." : kind === "owner_time" ? "זמן שלך ושל הלקוחות." : kind === "cost_increase" ? "עלייה במה ששילמת." : IMPORTANCE_HE[i.importance]) : (i.impact.note ?? i.importanceWords),
    evidence: lang === "he" ? `${he?.basis ?? ""} · ${i.evidence.length === 1 ? "רשומה אחת" : `${i.evidence.length} רשומות`}` : `${i.basis} · ${i.evidence.length} record${i.evidence.length === 1 ? "" : "s"}`,
    confidence: CONFIDENCE[lang][i.confidence],
    // Money an initiative points at is at stake / recoverable — never made. Only a measured result is verified.
    money: amount ? `${amount} ${kind === "revenue_at_risk" ? T("at risk", "בסיכון") : kind === "recoverable_demand" ? T("could be recovered", "אפשר להחזיר") : kind === "cost_increase" ? T("in higher costs", "בעלויות גבוהות יותר") : T("involved", "מעורבים")} ${T("(not revenue)", "(לא הכנסה)")}` : null,
    next: he?.recommendation ?? i.recommendation.text,
    action: a ? (a.kind === "command" ? { kind: "command" as const, label: he?.actionLabel ?? a.label } : { kind: "link" as const, label: he?.actionLabel ?? a.label, href: ownerHref(a.href) }) : undefined,
    canAct: i.canAct && i.entitlement !== "not_included",
    canActWords: i.entitlement === "not_included" ? T("Not on your current plan — a recommendation only.", "לא כלול בתוכנית שלך — זו המלצה בלבד.") : i.canAct ? T("BARRY can do this for you.", "BARRY יכול לעשות את זה בשבילך.") : T("BARRY can't do this itself — it's for you or your team.", "BARRY לא יכול לעשות את זה בעצמו — זה בשבילך או בשביל הצוות."),
    approval: i.authority === "owner_decides" ? T("You decide — BARRY won't act on this by itself", "אתה מחליט — BARRY לא יפעל על זה לבד") : i.authority === "within_owner_rules" ? T("BARRY can do this within your rules once you say go", "BARRY יכול לעשות את זה לפי הכללים שלך, אחרי שתאשר") : T("Only you can do this", "רק אתה יכול לעשות את זה"),
    handling: i.alreadyHandled ? T("Already being handled.", "כבר מטופל.") : null,
    result: verified ? T(`${verified} verified by your provider`, `${verified} אומתו מול הספק`) : (lang === "he" ? (i.result?.note ? "יש תוצאה — פרטים בשיחות" : null) : (i.result?.note ?? null)),
    testData: Boolean(i.testData),
  };
}
export type NoticedCard = ReturnType<typeof noticedCard>;

// ── Capability truth: what a connected system can actually do (separate from what a rule allows) ─────

export type Availability = "real" | "simulated" | "not_connected" | "not_used";
export type CapabilityTruth = { bookings: Availability; payments: Availability; refunds: Availability; checkout: Availability };

/** One line about availability, in owner words. A permission never implies the capability exists. */
export function availabilityWords(what: keyof CapabilityTruth, a: Availability, lang: OwnerLang = "en"): string | undefined {
  const T = tr(lang);
  const noun = { bookings: T("booking system", "מערכת תורים"), payments: T("payment provider", "ספק תשלומים"), refunds: T("refunds through your payment provider", "החזרים דרך ספק התשלומים"), checkout: T("store checkout", "תשלום בחנות") }[what];
  switch (a) {
    case "real":
      return undefined;
    case "simulated":
      return what === "bookings" ? T("Runs on BARRY's simulator — no real appointment is booked.", "רץ על הסימולטור של BARRY — לא נקבע תור אמיתי.") : T("Runs on BARRY's simulator — no real money moves.", "רץ על הסימולטור של BARRY — שום כסף אמיתי לא זז.");
    case "not_connected":
      return T(`No ${noun} is connected — BARRY can't do this yet.`, `לא מחוברת ${noun} — BARRY עוד לא יכול לעשות את זה.`).replace("מחוברת החזרים", "מחוברים החזרים");
    case "not_used":
      return what === "bookings" ? T("Bookings aren't part of your setup — no booking system is connected.", "תורים לא חלק מההגדרה שלך — לא מחוברת מערכת תורים.") : T(`Not part of your setup — no ${noun} is connected.`, `לא חלק מההגדרה שלך.`);
  }
}

// ── Rules BARRY follows ───────────────────────────────────────────────────────────────────────────

export type RuleSource = "built_in" | "profile" | "owner" | "founder";
export type RuleChange = "teach" | "team" | "fixed";
export type RuleArea = "discounts" | "payments" | "refunds" | "bookings" | "prices" | "delivery" | "actions" | "followups" | "safety";
export type OwnerRule = {
  id: string;
  area: RuleArea;
  /** A few words, e.g. "Discounts". */
  title: string;
  /** The rule at a glance, e.g. "Up to 5% without asking". */
  summary: string;
  /** The full rule in one sentence. */
  words: string;
  source: RuleSource;
  sourceWords: string;
  change: RuleChange;
  changeWords: string;
  state: "active" | "needs_answer" | "replaced" | "blocked";
  question?: string;
  /** What a connected system can actually do here — separate from what the rule ALLOWS. */
  availability?: { state: Availability; words: string };
};

export const RULE_SOURCE_WORDS: Record<RuleSource, string> = { built_in: "Built into BARRY", profile: "From your business profile", owner: "Taught by you", founder: "Restriction from the BARRY team" };
export const RULE_SOURCE_WORDS_HE: Record<RuleSource, string> = { built_in: "מובנה ב־BARRY", profile: "מפרופיל העסק", owner: "לימדת את BARRY", founder: "הגבלה של צוות BARRY" };
export const ruleSourceWords = (s: RuleSource, lang: OwnerLang = "en") => (lang === "he" ? RULE_SOURCE_WORDS_HE : RULE_SOURCE_WORDS)[s];
const changeWords = (c: RuleChange, lang: OwnerLang) =>
  ({ teach: L(lang, "You can change this by teaching BARRY a new limit.", "אפשר לשנות — מלמדים את BARRY גבול חדש."), team: L(lang, "View only — the BARRY team changes it with you.", "לצפייה בלבד — צוות BARRY משנה את זה איתך."), fixed: L(lang, "Always on — it can't be switched off.", "תמיד פעיל — אי אפשר לכבות.") })[c];
const AREA_TITLE: Record<RuleArea, [string, string]> = { discounts: ["Discounts", "הנחות"], payments: ["Payment links", "קישורי תשלום"], refunds: ["Refunds", "החזרים כספיים"], bookings: ["Bookings", "תורים"], prices: ["Prices", "מחירים"], delivery: ["Delivery", "משלוחים"], actions: ["Actions", "פעולות"], followups: ["Follow-ups", "מעקבים"], safety: ["Safety", "בטיחות"] };
export const areaTitle = (a: RuleArea, lang: OwnerLang = "en") => AREA_TITLE[a][lang === "he" ? 1 : 0];

export type RulesInput = {
  /** The EFFECTIVE graph's policies (static baseline + owner-trained overlay, with provenance). */
  policies: Policy[];
  /** The business's currency when its offers state one; null when unknown — then no currency is invented. */
  currency: string | null;
  /** Per-capability authority rules (already in owner words). */
  authority: { capability: string; effect: "allow" | "require_approval" | "deny"; reason?: string }[];
  /** Owner-taught rules that are NOT operational (needs review / clarification / blocked / replaced). */
  trained: Pick<TrainedRule, "factId" | "state" | "words" | "question" | "value">[];
  followUps: OwnerOperator;
  /** Follow-up kinds the business profile sets explicitly (the rest are BARRY's defaults). */
  declaredFollowUps: string[];
  controls: { mode: "simulator" | "supervised" | "live"; pauseConsequentialWrites: boolean; approvalRequiredForAll: boolean; pausedCapabilities: string[]; disabledChannels: string[]; pausedBusiness: boolean; safeMode: boolean; reason: string };
  hardMaxDiscountPct: number;
  /** What the connected systems can actually do (permission ≠ capability). */
  capabilities?: CapabilityTruth;
};

const AVAIL_FOR: Partial<Record<Policy["rule"]["type"], keyof CapabilityTruth>> = { bookings_auto_allowed: "bookings", max_auto_payment_amount: "payments", refund_requires_approval: "refunds" };
const AREA_FOR: Record<Policy["rule"]["type"], RuleArea> = { max_auto_discount_pct: "discounts", max_auto_payment_amount: "payments", refund_requires_approval: "refunds", bookings_auto_allowed: "bookings", custom_pricing_requires_approval: "prices", free_shipping_over: "delivery", flat_shipping_fee: "delivery" };

/** The rules BARRY follows right now, each with where it came from and whether the owner can change it here. */
export function ownerRules(input: RulesInput, lang: OwnerLang = "en"): { rules: OwnerRule[]; pending: OwnerRule[]; notSupported: string[] } {
  const T = tr(lang);
  const rules: OwnerRule[] = [];
  const add = (r: Omit<OwnerRule, "sourceWords" | "changeWords" | "state" | "title"> & Partial<Pick<OwnerRule, "state" | "title">>) =>
    rules.push({ state: "active", title: areaTitle(r.area, lang), ...r, sourceWords: ruleSourceWords(r.source, lang), changeWords: changeWords(r.change, lang) });

  // Founder restrictions first: they override everything below while they are on.
  const c = input.controls;
  if (c.pausedBusiness) add({ id: "founder.paused", area: "safety", summary: T("BARRY is paused", "BARRY מושהה"), words: T("BARRY is paused: it doesn't answer customers, nothing proactive runs and nothing is changed.", "BARRY מושהה: הוא לא עונה ללקוחות, לא יוזם כלום ולא משנה כלום."), source: "founder", change: "team" });
  if (c.pauseConsequentialWrites) add({ id: "founder.writes", area: "safety", summary: T("Answers only — no actions", "רק עונה — בלי פעולות"), words: T("BARRY may only look things up and answer — every action that changes something is held.", "BARRY רק בודק ועונה — כל פעולה שמשנה משהו מוחזקת."), source: "founder", change: "team" });
  if (c.approvalRequiredForAll) add({ id: "founder.approve_all", area: "safety", summary: T("Every action needs your approval", "כל פעולה — רק באישורך"), words: T("Every action that changes something needs your approval first, even where your rules would allow it.", "כל פעולה שמשנה משהו דורשת קודם את האישור שלך, גם כשהכללים שלך היו מרשים אותה."), source: "founder", change: "team" });
  if (c.safeMode) add({ id: "founder.safe", area: "safety", summary: T("Safe mode", "מצב בטוח"), words: T("Safe mode: every consequential action needs your approval and BARRY sends no proactive messages.", "מצב בטוח: כל פעולה משמעותית דורשת את האישור שלך, ו־BARRY לא שולח הודעות ביוזמתו."), source: "founder", change: "team" });
  if (c.pausedCapabilities.length) add({ id: "founder.capabilities", area: "safety", summary: T(`${c.pausedCapabilities.length} kind${c.pausedCapabilities.length === 1 ? "" : "s"} of action paused`, c.pausedCapabilities.length === 1 ? "סוג פעולה אחד מושהה" : `${c.pausedCapabilities.length} סוגי פעולות מושהים`), words: T(`Paused for now: ${c.pausedCapabilities.length} kind${c.pausedCapabilities.length === 1 ? "" : "s"} of action — BARRY won't do ${c.pausedCapabilities.length === 1 ? "it" : "them"} until the BARRY team lifts the pause.`, `מושהה כרגע — BARRY לא יבצע את הפעולות האלה עד שצוות BARRY יסיר את ההשהיה.`), source: "founder", change: "team" });
  if (c.disabledChannels.length) add({ id: "founder.channels", area: "safety", summary: T(`Not answering on ${c.disabledChannels.join(", ")}`, `לא עונה ב־${c.disabledChannels.join(", ")}`), words: T(`BARRY doesn't answer on: ${c.disabledChannels.join(", ")}.`, `BARRY לא עונה ב־${c.disabledChannels.join(", ")}.`), source: "founder", change: "team" });

  for (const p of input.policies) {
    const w = policyWords(p.rule, input.currency, lang);
    const avail = AVAIL_FOR[p.rule.type];
    const state = avail ? input.capabilities?.[avail] : undefined;
    const note = avail && state ? availabilityWords(avail, state, lang) : undefined;
    add({ id: `policy.${p.id}`, area: AREA_FOR[p.rule.type], title: w.title, summary: w.summary, words: w.words, source: p.provenance?.source === "owner_trained" ? "owner" : "profile", change: p.rule.type === "max_auto_discount_pct" ? "teach" : "team", ...(note && state ? { availability: { state, words: note } } : {}) });
  }
  if (!input.policies.some((p) => p.rule.type === "max_auto_discount_pct")) {
    add({ id: "policy.discount.none", area: "discounts", summary: T("None without asking you", "אף הנחה בלי לשאול אותך"), words: T("No discount limit is set, so BARRY offers no discount on its own — any discount comes to you.", "לא הוגדר גבול הנחה, אז BARRY לא נותן הנחה לבד — כל הנחה מגיעה אליך."), source: "built_in", change: "teach" });
  }

  for (const [i, a] of input.authority.entries()) {
    add({ id: `authority.${i}`, area: "actions", summary: a.effect === "allow" ? T("Allowed", "מותר") : a.effect === "require_approval" ? T("You approve first", "באישורך בלבד") : T("Never", "אף פעם"), words: a.effect === "allow" ? T(`BARRY may: ${a.capability}.`, `BARRY רשאי: ${a.capability}.`) : a.effect === "require_approval" ? T(`You approve first: ${a.capability}.`, `באישורך בלבד: ${a.capability}.`) : T(`Never: ${a.capability}.`, `אף פעם: ${a.capability}.`), title: a.capability.length > 40 ? `${a.capability.slice(0, 38)}…` : a.capability, source: "profile", change: "team" });
  }

  if (!input.followUps.included) {
    add({ id: "followups.plan", area: "followups", summary: T("Only when you ask", "רק כשתבקש"), words: T("Proactive follow-ups aren't part of your current plan — BARRY only follows up when you ask.", "מעקבים יזומים לא כלולים בתוכנית שלך — BARRY עוקב רק כשתבקש."), source: "profile", change: "team" });
  } else {
    for (const f of input.followUps.rules) {
      const title = proactiveWords(f.kind, lang).command;
      const team = f.kind === "unresolved_handoff";
      const after = f.afterHours === 0 ? T("right away", "מיד") : T(`after ${f.afterHours}h`, `אחרי ${f.afterHours} שע׳`);
      const times = f.maxAttempts === 1 ? T("once", "פעם אחת") : T(`up to ${f.maxAttempts}×`, `עד ${f.maxAttempts} פעמים`);
      const who = team ? T("a nudge to your team, never to the customer", "תזכורת לצוות שלך — אף פעם לא ללקוח") : T("only to customers already talking to you", "רק ללקוחות שכבר מדברים איתך");
      add({
        id: `followups.${f.kind}`,
        area: "followups",
        title,
        summary: f.enabled ? `${after.replace(/^\w/, (x) => x.toUpperCase())} · ${times}` : T("Off", "כבוי"),
        words: f.enabled ? `${title}: ${after}, ${times}${f.maxAttempts > 1 ? T(`, ${f.intervalHours}h apart`, `, בהפרש של ${f.intervalHours} שעות`) : ""} — ${who}.` : T(`${title}: off.`, `${title}: כבוי.`),
        source: input.declaredFollowUps.includes(f.kind) ? "profile" : "built_in",
        change: "team",
      });
    }
  }

  add({ id: "builtin.discount_ceiling", area: "safety", title: T("Discount ceiling", "תקרת הנחה"), summary: T(`Never above ${input.hardMaxDiscountPct}% on its own`, `אף פעם לא יותר מ־${input.hardMaxDiscountPct}% לבד`), words: T(`BARRY never gives more than ${input.hardMaxDiscountPct}% on its own, whatever it is taught.`, `BARRY לעולם לא נותן לבד יותר מ־${input.hardMaxDiscountPct}%, לא משנה מה לימדו אותו.`), source: "built_in", change: "fixed" });
  add({ id: "builtin.no_broadcast", area: "safety", title: T("No broadcasts", "בלי הודעות תפוצה"), summary: T("Only customers who wrote to you", "רק ללקוחות שפנו אליך"), words: T("BARRY only messages customers who already wrote to you — no campaigns or broadcasts.", "BARRY שולח הודעות רק ללקוחות שכבר כתבו לך — בלי קמפיינים ובלי הודעות תפוצה."), source: "built_in", change: "fixed" });
  add({ id: "builtin.verified_money", area: "safety", title: T("Verified money", "כסף מאומת"), summary: T("Paid only when your provider confirms", "שולם — רק כשהספק מאשר"), words: T("Nothing counts as paid until your payment provider verifies it.", "שום דבר לא נחשב ששולם עד שספק התשלומים שלך מאמת אותו."), source: "built_in", change: "fixed" });

  const pending: OwnerRule[] = input.trained
    .filter((t) => t.state !== "active")
    .map((t) => ({
      id: `trained.${t.factId}`,
      area: "discounts",
      title: areaTitle("discounts", lang),
      summary: t.state === "superseded" ? T("Replaced", "הוחלף") : t.state === "blocked" ? T("Not used — above BARRY's limit", "לא בשימוש — מעל הגבול של BARRY") : T("Not used yet — needs your answer", "עוד לא בשימוש — מחכה לתשובה שלך"),
      words: lang === "he" ? `לימדת: “${t.value}”.` : t.words,
      source: "owner",
      sourceWords: ruleSourceWords("owner", lang),
      change: "teach",
      changeWords: t.state === "superseded" ? T("Replaced — kept for the record.", "הוחלף — נשמר לתיעוד.") : T("BARRY does not use this until it's answered.", "BARRY לא משתמש בזה עד שתענה."),
      state: t.state === "superseded" ? "replaced" : t.state === "blocked" ? "blocked" : "needs_answer",
      ...(t.question ? { question: lang === "he" ? "מה הכי הרבה הנחה ש־BARRY רשאי לתת בלי לשאול אותך (למשל 5%)?" : t.question } : {}),
    }));

  return {
    rules,
    pending,
    notSupported: [
      T("Rules that switch off by themselves (“only today”) — a rule stays until you change it.", "כללים שמתבטלים מעצמם (״רק היום״) — כלל נשאר עד שתשנה אותו."),
      T("Different limits per customer or per product.", "גבולות שונים ללקוח מסוים או למוצר מסוים."),
      T("Changing follow-up timing or payment limits yourself — the BARRY team changes those with you for now.", "שינוי עצמאי של זמני המעקב או של גבול התשלום — בינתיים צוות BARRY משנה אותם איתך."),
    ],
  };
}

// ── What BARRY knows ─────────────────────────────────────────────────────────────────────────────────

export type KnowledgeConcept = "products" | "delivery" | "returns" | "discounts" | "payments" | "bookings" | "hours" | "support" | "contact" | "about" | "other";
export type KnowledgeSource = "profile" | "owner" | "approved_source" | "built_in" | "connected";
export type KnowledgeItem = {
  id: string;
  concept: KnowledgeConcept;
  title: string;
  /** What BARRY believes, in owner words (owner-written content shown as written). */
  belief: string;
  status: "known" | "unsure" | "missing" | "needs_answer";
  source: KnowledgeSource | null;
  sourceWords: string | null;
  /** What the owner can do about it here. */
  action?: { kind: "teach"; key: string; question: string } | { kind: "confirm"; factId: string; question: string } | { kind: "choose"; changeId: string; question: string; previous: string; proposed: string } | { kind: "team"; words: string };
  /** Quiet provenance for the detail view. */
  detail?: { from?: string; checked?: string | null };
};
export type KnowledgeGroup = { concept: KnowledgeConcept; title: string; items: KnowledgeItem[]; attention: number };

const CONCEPT_TITLE: Record<KnowledgeConcept, [string, string]> = {
  products: ["Products & services", "מוצרים ושירותים"],
  delivery: ["Delivery", "משלוחים"],
  returns: ["Returns & refunds", "החזרות והחזרים"],
  discounts: ["Discounts", "הנחות"],
  payments: ["Payment", "תשלום"],
  bookings: ["Bookings", "תורים"],
  hours: ["Hours & location", "שעות ומיקום"],
  support: ["Support & handoff", "שירות והעברה לצוות"],
  contact: ["Contact", "יצירת קשר"],
  about: ["About the business", "על העסק"],
  other: ["More BARRY knows", "עוד דברים ש־BARRY יודע"],
};
export const conceptTitle = (c: KnowledgeConcept, lang: OwnerLang = "en") => CONCEPT_TITLE[c][lang === "he" ? 1 : 0];
const CONCEPT_ORDER: KnowledgeConcept[] = ["products", "delivery", "returns", "discounts", "payments", "bookings", "hours", "support", "contact", "about", "other"];

const KEY_CONCEPT: [RegExp, KnowledgeConcept][] = [
  [/^policy\.(returns|exchanges|refunds|cancellation)/, "returns"],
  [/^policy\.(shipping|delivery)/, "delivery"],
  [/^hours\.|^location\.|^address/, "hours"],
  [/^contact\./, "contact"],
  [/^authority\.escalation|^handoff/, "support"],
  [/discount/, "discounts"],
  [/^catalog\.|^offers?\.|^products?\./, "products"],
  [/^payments?\./, "payments"],
  [/^booking|^scheduling\./, "bookings"],
  [/^business\./, "about"],
];
export const conceptOfKey = (key: string): KnowledgeConcept => KEY_CONCEPT.find(([re]) => re.test(key))?.[1] ?? "other";
const TOPIC_CONCEPT: [RegExp, KnowledgeConcept][] = [
  [/return|exchange|refund|cancel/i, "returns"],
  [/ship|deliver/i, "delivery"],
  [/hour|open|locat|address/i, "hours"],
  [/contact|phone|email|whatsapp/i, "contact"],
  [/pay/i, "payments"],
  [/book|appoint/i, "bookings"],
  [/discount|sale|coupon/i, "discounts"],
];

const KEY_TITLE: Record<string, [string, string]> = {
  "business.name": ["Business name", "שם העסק"],
  "business.description": ["What the business does", "מה העסק עושה"],
  "contact.phone": ["Phone", "טלפון"],
  "contact.email": ["Email", "אימייל"],
  "contact.whatsapp": ["WhatsApp", "וואטסאפ"],
  "authority.escalation": ["Who takes over from BARRY", "למי BARRY מעביר"],
  "authority.discounts": ["Discount limit", "גבול הנחה"],
  "policy.discounts": ["Discount limit", "גבול הנחה"],
  "policy.returns": ["Returns & exchanges", "החזרות והחלפות"],
  "policy.exchanges": ["Exchanges", "החלפות"],
  "policy.refunds": ["Refunds", "החזרים כספיים"],
  "policy.cancellation": ["Cancellations", "ביטולים"],
  "policy.shipping": ["Delivery", "משלוחים"],
  "policy.delivery_time": ["Delivery time", "זמני משלוח"],
  "hours.opening": ["Opening hours", "שעות פתיחה"],
  "catalog.price_range": ["Price range", "טווח מחירים"],
  "catalog.categories": ["Categories", "קטגוריות"],
  "catalog.currency": ["Currency", "מטבע"],
  "catalog.variant_options": ["Sizes & options", "מידות ואפשרויות"],
};
export const keyTitle = (key: string, lang: OwnerLang = "en") => KEY_TITLE[key]?.[lang === "he" ? 1 : 0] ?? (lang === "he" ? "פרט נוסף" : (key.split(".").at(-1) ?? key).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

/** The few questions BARRY asks owners, in Hebrew (keyed by what they teach). */
const QUESTION_HE: Record<string, string> = {
  "business.name": "איך קוראים לעסק?",
  "contact.phone": "איך לקוחות יכולים להגיע לאדם בעסק?",
  "authority.escalation": "כש־BARRY לא יכול לעזור — למי להעביר את השיחה, ואיך?",
  "authority.discounts": "איזו הנחה, אם בכלל, מותר ל־BARRY לתת בלי לשאול אותך? (״בלי הנחות״ זו תשובה טובה)",
  "policy.returns": "מה מדיניות ההחזרות וההחלפות שלך?",
  "policy.shipping": "איך עובדים המשלוחים, וכמה הם עולים?",
  "hours.opening": "מה שעות הפתיחה שלך?",
  "policy.cancellation": "מה מדיניות הביטולים ושינוי התורים?",
  "policy.refunds": "מתי לקוחות מקבלים החזר כספי, ומי מאשר?",
};
export const teachQuestion = (key: string, en: string, lang: OwnerLang = "en") => (lang === "he" ? (QUESTION_HE[key] ?? `מה BARRY צריך לדעת על ${keyTitle(key, "he")}?`) : en);

export const KNOWLEDGE_SOURCE_WORDS: Record<KnowledgeSource, [string, string]> = {
  profile: ["From your business profile", "מפרופיל העסק"],
  owner: ["Taught by you", "לימדת את BARRY"],
  approved_source: ["From an approved source", "ממקור שאישרת"],
  built_in: ["Built into BARRY", "מובנה ב־BARRY"],
  connected: ["From your connected system", "מהמערכת המחוברת"],
};
const sourceWordsOf = (s: KnowledgeSource, lang: OwnerLang) => KNOWLEDGE_SOURCE_WORDS[s][lang === "he" ? 1 : 0];

export type KnowledgeInput = {
  graph: Pick<BusinessGraph, "business" | "offers" | "knowledge" | "policies" | "playbook">;
  currency: string | null;
  capabilities: CapabilityTruth;
  /** The connected catalog, when one is searched live. */
  catalog?: { provider: string | null; simulated: boolean };
  /** Owner-approved facts BARRY has on record (active or understood only). */
  known: { key: string; value: string; owner: boolean; from: string; checked: string | null }[];
  /** Learned facts not confirmed yet (BARRY doesn't use them). */
  unsure: { factId: string; key: string; value: string; from: string }[];
  /** What BARRY still needs to be taught (question + key). */
  missing: { key: string; question: string }[];
  /** Things that need the owner's answer (conflicts, unreviewed changes, rule questions). */
  questions: { id: string; kind: string; question: string; refs: { factId?: string; changeId?: string; sourceId?: string }; previous?: string | null; proposed?: string | null; value?: string }[];
  handoff?: string;
};

/**
 * WHAT BARRY KNOWS, organised by what a business owner thinks about (products, delivery, returns, …),
 * never by internal keys. Rules are described by the SAME wording as Rules BARRY follows (policyWords),
 * and permission is kept apart from what a connected system can do.
 */
export function ownerKnowledge(input: KnowledgeInput, lang: OwnerLang = "en"): KnowledgeGroup[] {
  const T = tr(lang);
  const items: KnowledgeItem[] = [];
  const g = input.graph;
  const src = (s: KnowledgeSource) => ({ source: s, sourceWords: sourceWordsOf(s, lang) });

  // Products: what BARRY sells from.
  const offers = g.offers.filter((o) => o.active);
  if (offers.length) items.push({ id: "products.offers", concept: "products", title: T("What you offer", "מה אתה מציע"), belief: lang === "he" ? (offers.length === 1 ? `מוצר או שירות אחד: ${offers[0].name}` : `${offers.length} מוצרים ושירותים, כולל ${offers.slice(0, 3).map((o) => o.name).join(", ")}`) : `${offers.length} product${offers.length === 1 ? "" : "s"} and service${offers.length === 1 ? "" : "s"}, including ${offers.slice(0, 3).map((o) => o.name).join(", ")}`, status: "known", ...src("profile") });
  if (input.catalog) items.push({ id: "products.catalog", concept: "products", title: T("Your catalog", "הקטלוג שלך"), belief: input.catalog.simulated ? T("BARRY searches your store catalog live — today it's BARRY's simulator, not your real store.", "BARRY מחפש בקטלוג החנות בזמן אמת — כרגע זה הסימולטור של BARRY, לא החנות האמיתית.") : T("BARRY searches your store catalog live, so prices and stock are always current.", "BARRY מחפש בקטלוג החנות בזמן אמת, כך שמחירים ומלאי תמיד עדכניים."), status: "known", ...src("connected") });
  if (!offers.length && !input.catalog) items.push({ id: "products.missing", concept: "products", title: T("What you offer", "מה אתה מציע"), belief: T("BARRY doesn't know what you sell yet.", "BARRY עוד לא יודע מה אתה מוכר."), status: "missing", source: null, sourceWords: null, action: { kind: "team", words: T("Connect your store or add your products with the BARRY team.", "חבר את החנות או הוסף מוצרים עם צוות BARRY.") } });

  // Rules as knowledge, with the same words as Rules BARRY follows.
  for (const p of g.policies) {
    const w = policyWords(p.rule, input.currency, lang);
    const concept: KnowledgeConcept = p.rule.type === "max_auto_discount_pct" ? "discounts" : p.rule.type === "max_auto_payment_amount" ? "payments" : p.rule.type === "refund_requires_approval" ? "returns" : p.rule.type === "bookings_auto_allowed" ? "bookings" : p.rule.type === "custom_pricing_requires_approval" ? "products" : "delivery";
    const avail = AVAIL_FOR[p.rule.type];
    const note = avail ? availabilityWords(avail, input.capabilities[avail], lang) : undefined;
    items.push({ id: `rule.${p.id}`, concept, title: w.title, belief: note ? `${w.words} ${note}` : w.words, status: "known", ...src(p.provenance?.source === "owner_trained" ? "owner" : "profile") });
  }
  if (!g.policies.some((p) => p.rule.type === "bookings_auto_allowed") && input.capabilities.bookings !== "not_used") {
    const note = availabilityWords("bookings", input.capabilities.bookings, lang);
    if (note) items.push({ id: "bookings.availability", concept: "bookings", title: T("Bookings", "תורים"), belief: note, status: "known", ...src("connected") });
  }
  if (g.policies.every((p) => p.rule.type !== "max_auto_payment_amount") && input.capabilities.payments !== "not_used") {
    const note = availabilityWords("payments", input.capabilities.payments, lang);
    if (note) items.push({ id: "payments.availability", concept: "payments", title: T("Payment provider", "ספק תשלומים"), belief: note, status: "known", ...src("connected") });
  }

  // Owner-written knowledge (policies, FAQs) — shown as written.
  for (const k of g.knowledge) {
    if (!k.content.trim()) continue;
    const concept = TOPIC_CONCEPT.find(([re]) => re.test(k.topic))?.[1] ?? "other";
    // Owner-written text BARRY quotes to customers, exactly as written.
    items.push({ id: `k.${k.id}`, concept, title: concept === "other" ? (lang === "he" ? (TOPIC_HE[k.topic.toLowerCase()] ?? k.topic) : k.topic.replace(/^\w/, (c) => c.toUpperCase())) : T("What BARRY tells customers", "מה BARRY עונה ללקוחות"), belief: `“${k.content.trim()}”`, status: "known", ...src("profile") });
  }

  // Hours & location.
  const hours = g.business.operatingHours;
  const DAY: Record<string, [string, string]> = { sun: ["Sun", "א׳"], mon: ["Mon", "ב׳"], tue: ["Tue", "ג׳"], wed: ["Wed", "ד׳"], thu: ["Thu", "ה׳"], fri: ["Fri", "ו׳"], sat: ["Sat", "ש׳"] };
  if (hours.length) items.push({ id: "hours.opening", concept: "hours", title: T("Opening hours", "שעות פתיחה"), belief: hours.map((h) => `${DAY[h.day]?.[lang === "he" ? 1 : 0] ?? h.day} ${h.open}–${h.close}`).join(" · "), status: "known", ...src("profile") });
  if (g.business.timezone) items.push({ id: "hours.timezone", concept: "hours", title: T("Time zone", "אזור זמן"), belief: T(`Times BARRY quotes are in ${cityOf("en", g.business.timezone)} time.`, `כל השעות ש־BARRY אומר הן לפי שעון ${cityOf("he", g.business.timezone)}.`), status: "known", ...src("profile") });

  // Support & handoff (set in the business profile — teaching it here wouldn't change what BARRY does).
  if (input.handoff) items.push({ id: "support.handoff", concept: "support", title: T("When a customer needs a person", "כשלקוח צריך אדם"), belief: input.handoff, status: "known", ...src("profile") });
  else items.push({ id: "support.handoff", concept: "support", title: T("When a customer needs a person", "כשלקוח צריך אדם"), belief: T("Not set: BARRY can hand a customer to your inbox, but can't promise them when your team will reply.", "לא הוגדר: BARRY יכול להעביר לקוח לתיבה שלך, אבל לא יכול להבטיח לו מתי הצוות יחזור אליו."), status: "missing", source: null, sourceWords: null, action: { kind: "team", words: T("Tell the BARRY team how your team takes over (who, how, how fast) — they add it to your profile.", "ספר לצוות BARRY איך הצוות שלך לוקח את השיחה (מי, איך, תוך כמה זמן) — והם יוסיפו את זה לפרופיל.") } });

  // Owner-approved facts on record.
  for (const f of input.known) {
    if (/^authority\.(discounts|discount_limit)$|^policy\.(discounts|discount_limit)$/.test(f.key)) continue; // shown as the discount rule
    items.push({ id: `fact.${f.key}`, concept: conceptOfKey(f.key), title: keyTitle(f.key, lang), belief: f.value, status: "known", ...src(f.owner ? "owner" : "approved_source"), detail: { from: f.from, checked: f.checked } });
  }
  // Learned, not confirmed — BARRY doesn't use them.
  for (const u of input.unsure) {
    items.push({ id: `unsure.${u.factId}`, concept: conceptOfKey(u.key), title: keyTitle(u.key, lang), belief: u.value, status: "unsure", ...src("approved_source"), action: { kind: "confirm", factId: u.factId, question: T(`Is “${u.value}” right?`, `האם “${u.value}” נכון?`) }, detail: { from: u.from } });
  }
  // Questions needing the owner's answer.
  for (const q of input.questions) {
    if (q.refs.changeId && q.previous != null && q.proposed != null) {
      items.push({ id: `q.${q.id}`, concept: "other", title: T("A source changed", "מקור השתנה"), belief: T(`Yours: “${q.previous}” · Source now: “${q.proposed}”`, `שלך: “${q.previous}” · המקור עכשיו: “${q.proposed}”`), status: "needs_answer", source: "approved_source", sourceWords: sourceWordsOf("approved_source", lang), action: { kind: "choose", changeId: q.refs.changeId, question: T("Which is right?", "מה נכון?"), previous: q.previous, proposed: q.proposed } });
    } else if (q.refs.factId) {
      items.push({ id: `q.${q.id}`, concept: "other", title: q.kind.includes("rule") ? T("A rule you taught", "כלל שלימדת") : T("Please confirm", "צריך אישור"), belief: q.value ? `“${q.value}”` : lang === "he" ? "פרט שנלמד ומחכה לאישורך" : q.question, status: "needs_answer", source: "approved_source", sourceWords: sourceWordsOf("approved_source", lang), action: { kind: "confirm", factId: q.refs.factId, question: lang === "he" ? (q.value ? `האם “${q.value}” נכון?` : "האם זה נכון?") : q.question } });
    }
  }
  // What BARRY still needs — except what the business already states (the same coverage readiness uses).
  for (const m of input.missing) {
    if (m.key === "authority.escalation") continue; // the handoff item above says it honestly
    if (coveredByBusiness(m.key, g)) continue;
    const concept = conceptOfKey(m.key);
    items.push({ id: `missing.${m.key}`, concept, title: keyTitle(m.key, lang), belief: T("BARRY doesn't know this yet — it says so instead of guessing.", "BARRY עוד לא יודע את זה — הוא אומר את זה במקום לנחש."), status: "missing", source: null, sourceWords: null, action: { kind: "teach", key: m.key, question: teachQuestion(m.key, m.question, lang) } });
  }

  return CONCEPT_ORDER.map((c) => {
    const list = items.filter((i) => i.concept === c).sort((a, b) => rank(a) - rank(b));
    return { concept: c, title: conceptTitle(c, lang), items: list, attention: list.filter((i) => i.status !== "known").length };
  }).filter((g2) => g2.items.length > 0);
}
const COVER_TOPICS: Record<string, RegExp> = { "policy.returns": /^(returns?|exchanges?)$/i, "policy.exchanges": /^(returns?|exchanges?)$/i, "policy.shipping": /^(shipping|delivery)$/i, "policy.delivery_time": /^(shipping|delivery)$/i, "policy.refunds": /^refunds?$/i, "policy.cancellation": /^(cancellations?|rescheduling)$/i, "contact.phone": /^(contact|phone|whatsapp|email)$/i };
/** Whether the business profile already answers what a learning question asks (mirrors the readiness check). */
function coveredByBusiness(key: string, g: KnowledgeInput["graph"]): boolean {
  const topic = COVER_TOPICS[key];
  if (topic && g.knowledge.some((k) => topic.test(k.topic) && k.content.trim().length > 0)) return true;
  if (key === "business.name") return Boolean(g.business.name?.trim());
  if (key === "hours.opening") return g.business.operatingHours.length > 0;
  if (key === "authority.discounts") return g.policies.some((p) => p.rule.type === "max_auto_discount_pct");
  if (key === "policy.refunds") return g.policies.some((p) => p.rule.type === "refund_requires_approval");
  if (key === "policy.shipping") return g.policies.some((p) => p.rule.type === "free_shipping_over" || p.rule.type === "flat_shipping_fee");
  return false;
}
const rank = (i: KnowledgeItem) => ({ needs_answer: 0, missing: 1, unsure: 2, known: 3 })[i.status];

// ── Connected systems ───────────────────────────────────────────────────────────────────────────────

export type SystemLabel = "REAL" | "SIMULATED" | "READ-ONLY" | "SUPERVISED" | "TEST MODE" | "UNAVAILABLE" | "NOT CONNECTED";
export const SYSTEM_LABEL_HE: Record<SystemLabel, string> = { REAL: "אמיתי", SIMULATED: "סימולציה", "READ-ONLY": "קריאה בלבד", SUPERVISED: "בפיקוח", "TEST MODE": "מצב בדיקה", UNAVAILABLE: "לא זמין", "NOT CONNECTED": "לא מחובר" };
export const systemLabelWords = (l: SystemLabel, lang: OwnerLang = "en") => (lang === "he" ? SYSTEM_LABEL_HE[l] : l);

export type SystemInput = {
  domain: string;
  provider: string | null;
  status: "connected" | "disconnected" | "error" | "not_configured";
  simulated: boolean;
  missing: string[];
  lastVerifiedAt: string | null;
  /** Capability ids the connected system provides, split by effect. */
  reads: string[];
  writes: string[];
  /** Whether this business's setup uses the domain at all. */
  used: boolean;
};

export type OwnerSystem = {
  id: string;
  name: string;
  provider: string | null;
  label: SystemLabel;
  labelWords: string;
  /** One line: what the label means for the owner. */
  meaning: string;
  reads: string[];
  does: string[];
  health: "healthy" | "degraded" | "down" | "not_set_up";
  lastCheck: string | null;
  missingForLaunch: string[];
  used: boolean;
};

const DOMAIN_NAME: Record<string, [string, string]> = { commerce: ["Store & catalog", "חנות וקטלוג"], payments: ["Payments", "תשלומים"], scheduling: ["Calendar & bookings", "יומן ותורים"], messaging: ["Messaging", "הודעות"], support: ["Support desk", "מוקד שירות"], crm: ["Customer records", "רשומות לקוחות"] };
const CAPABILITY_WORDS: Record<string, [string, string]> = {
  "commerce.catalog.search": ["Search your products", "חיפוש במוצרים שלך"],
  "commerce.catalog.schema": ["Read how your catalog is organised", "הבנת מבנה הקטלוג"],
  "commerce.variants.read": ["Read sizes, colours and prices", "קריאת מידות, צבעים ומחירים"],
  "commerce.inventory.read": ["Check live stock", "בדיקת מלאי עדכני"],
  "commerce.cart.create": ["Open a cart", "פתיחת עגלה"],
  "commerce.cart.update": ["Change cart items", "עדכון פריטים בעגלה"],
  "commerce.checkout.create": ["Create a checkout", "יצירת תשלום בחנות"],
  "commerce.order.create": ["Create the order after verified payment", "יצירת הזמנה אחרי תשלום מאומת"],
  "commerce.order.status": ["Look up an order", "בדיקת סטטוס הזמנה"],
  "payments.create_request": ["Send a payment link", "שליחת קישור תשלום"],
  "payments.verify": ["Check whether a payment really arrived", "בדיקה אם תשלום באמת התקבל"],
  "payments.webhook.verify": ["Confirm payment notices are genuine", "אימות הודעות תשלום"],
  "payments.refund": ["Refund a payment", "החזר כספי"],
  "scheduling.availability.read": ["Read open times", "קריאת זמנים פנויים"],
  "scheduling.booking.create": ["Book a confirmed slot", "קביעת תור"],
  "scheduling.booking.lookup": ["Look up a booking", "בדיקת תור קיים"],
  "messaging.send": ["Message a customer", "שליחת הודעה ללקוח"],
};
export const capabilityWords = (id: string, fallback: string, lang: OwnerLang = "en") => CAPABILITY_WORDS[id]?.[lang === "he" ? 1 : 0] ?? (lang === "he" ? "פעולה נוספת במערכת" : fallback);

const labelMeaning = (l: SystemLabel, lang: OwnerLang) =>
  ({
    REAL: L(lang, "Your real system — what BARRY does here really happens.", "המערכת האמיתית שלך — מה ש־BARRY עושה כאן באמת קורה."),
    SIMULATED: L(lang, "BARRY's simulator — nothing real reaches customers, stock or money.", "הסימולטור של BARRY — שום דבר אמיתי לא מגיע ללקוחות, למלאי או לכסף."),
    "READ-ONLY": L(lang, "BARRY can look things up here but can't change anything.", "BARRY יכול לבדוק כאן מידע, אבל לא לשנות כלום."),
    SUPERVISED: L(lang, "Real system, supervised start — actions follow your approvals.", "מערכת אמיתית, בהתחלה מפוקחת — פעולות לפי האישורים שלך."),
    "TEST MODE": L(lang, "Connected in test mode — nothing is sent.", "מחובר במצב בדיקה — שום דבר לא נשלח."),
    UNAVAILABLE: L(lang, "Connected but not working right now — BARRY won't act through it.", "מחובר אבל לא עובד כרגע — BARRY לא יפעל דרכו."),
    "NOT CONNECTED": L(lang, "BARRY can't use it until it's connected.", "BARRY לא יכול להשתמש בזה עד שזה יחובר."),
  })[l];

/** One system, labelled honestly: a simulator is SIMULATED whatever else is true. */
export function systemView(s: SystemInput, mode: "simulator" | "supervised" | "live", launchBlockers: string[] = [], lang: OwnerLang = "en", purpose: (id: string) => string = (id) => id): OwnerSystem {
  const label: SystemLabel =
    s.status === "not_configured" ? "NOT CONNECTED" : s.status !== "connected" || s.missing.length > 0 ? "UNAVAILABLE" : s.simulated ? "SIMULATED" : s.writes.length === 0 ? "READ-ONLY" : mode === "live" ? "REAL" : "SUPERVISED";
  return {
    id: s.domain,
    name: DOMAIN_NAME[s.domain]?.[lang === "he" ? 1 : 0] ?? s.domain[0].toUpperCase() + s.domain.slice(1),
    provider: s.provider,
    label,
    labelWords: systemLabelWords(label, lang),
    meaning: labelMeaning(label, lang),
    reads: s.reads.map((id) => capabilityWords(id, purpose(id), lang)),
    does: s.writes.map((id) => capabilityWords(id, purpose(id), lang)),
    health: s.status === "not_configured" ? "not_set_up" : s.status !== "connected" ? "down" : s.missing.length ? "degraded" : "healthy",
    lastCheck: s.lastVerifiedAt,
    missingForLaunch: launchBlockers,
    used: s.used,
  };
}

/** The channels and BARRY's understanding as systems, with the same honest labels. Owner and customer WhatsApp stay separate. */
export function channelSystems(ch: OwnerChannels, ai: { status: string; mode: string; summary: string }, mode: "simulator" | "supervised" | "live", lang: OwnerLang = "en"): OwnerSystem[] {
  const T = tr(lang);
  const customer: SystemLabel = ch.customerWhatsapp === "live" ? (mode === "live" ? "REAL" : "SUPERVISED") : ch.customerWhatsapp === "dry_run" ? "TEST MODE" : "NOT CONNECTED";
  const owner: SystemLabel = ch.ownerCommands === "connected" ? (ch.ownerSendMode === "dry_run" ? "TEST MODE" : "REAL") : "NOT CONNECTED";
  const aiLabel: SystemLabel = ai.mode !== "live_model" ? "SIMULATED" : ai.status === "unavailable" ? "UNAVAILABLE" : "REAL";
  const sys = (x: Omit<OwnerSystem, "labelWords">): OwnerSystem => ({ ...x, labelWords: systemLabelWords(x.label, lang) });
  return [
    sys({ id: "whatsapp_customers", name: T("WhatsApp — your customers", "וואטסאפ — הלקוחות שלך"), provider: ch.customerWhatsapp === "not_configured" || ch.customerWhatsapp === "not_routed" ? null : "WhatsApp Business", label: customer, meaning: ch.customerWhatsapp === "not_routed" ? T("WhatsApp is set up, but no number is routed to this business yet.", "וואטסאפ מוגדר, אבל עוד לא הופנה מספר לעסק הזה.") : customer === "TEST MODE" ? T("Connected in test mode — replies are recorded, not sent to customers.", "מחובר במצב בדיקה — התשובות נרשמות ולא נשלחות ללקוחות.") : labelMeaning(customer, lang), reads: [T("Customer messages", "הודעות מלקוחות")], does: ch.customerWhatsapp === "live" ? [T("Reply to customers", "מענה ללקוחות")] : [], health: ch.customerWhatsapp === "live" || ch.customerWhatsapp === "dry_run" ? "healthy" : "not_set_up", lastCheck: null, missingForLaunch: [], used: true }),
    sys({ id: "whatsapp_owner", name: T("WhatsApp — you and BARRY", "וואטסאפ — אתה ו־BARRY"), provider: ch.ownerCommands === "not_connected" ? null : "WhatsApp Business", label: owner, meaning: ch.ownerCommands === "not_linked" ? T("BARRY's owner line is ready — link your number in Settings.", "הקו של BARRY מוכן — קשר את המספר שלך בהגדרות.") : owner === "REAL" ? T("Message BARRY from your phone — same records and rules as this site.", "כתוב ל־BARRY מהטלפון — אותן רשומות ואותם כללים כמו באתר.") : labelMeaning(owner, lang), reads: [T("Your messages to BARRY", "ההודעות שלך ל־BARRY")], does: ch.ownerCommands === "connected" ? [T("Brief you", "לעדכן אותך"), T("Ask for your decisions", "לבקש החלטות")] : [], health: ch.ownerCommands === "connected" ? "healthy" : "not_set_up", lastCheck: null, missingForLaunch: [], used: true }),
    sys({ id: "understanding", name: T("BARRY's understanding (AI)", "ההבנה של BARRY (בינה מלאכותית)"), provider: ai.mode === "live_model" ? T("Live AI model", "מודל AI חי") : T("Simulator", "סימולטור"), label: aiLabel, meaning: aiLabel === "SIMULATED" ? T("Running on BARRY's simulator, not the live AI model.", "רץ על הסימולטור של BARRY, לא על מודל ה־AI החי.") : aiLabel === "UNAVAILABLE" ? T("Not working right now — customers get a safe “couldn't process” reply.", "לא עובד כרגע — לקוחות מקבלים תשובה בטוחה שההודעה לא עובדה.") : lang === "he" ? (ai.status === "degraded" ? "חלק מההודעות האחרונות לא הובנו." : "ההבנה עובדת כרגיל.") : ai.summary, reads: [T("What customers write", "מה שלקוחות כותבים")], does: [], health: ai.status === "unavailable" ? "down" : ai.status === "degraded" ? "degraded" : ai.mode === "live_model" ? "healthy" : "not_set_up", lastCheck: null, missingForLaunch: [], used: true }),
  ];
}

// ── BARRY setup (readiness, owner words) ─────────────────────────────────────────────────────────────

export type SetupGroupId = "owner" | "connection" | "team" | "optional";
export type SetupItem = { id: string; label: string; detail: string; fix?: string; href?: string; linkLabel?: string };

const GROUP_TITLE: Record<SetupGroupId, [string, string]> = { owner: ["Needs you", "צריך אותך"], connection: ["Connect", "חיבורים"], team: ["BARRY team", "צוות BARRY"], optional: ["Recommended", "מומלץ"] };

function groupOf(c: ReadinessCheck): SetupGroupId {
  if (c.status === "warn") return "optional";
  if (c.area === "knowledge" || c.area === "handoff" || c.area === "authority") return "owner";
  if (c.area === "systems" || c.area === "payments" || c.area === "channel") return "connection";
  return "team";
}

function linkOf(c: ReadinessCheck, lang: OwnerLang): Pick<SetupItem, "href" | "linkLabel"> {
  const T = tr(lang);
  if (c.area === "handoff") return { href: "/owner/knowledge#support", linkLabel: T("What BARRY knows", "מה BARRY יודע") };
  if (c.area === "knowledge") return { href: "/owner/knowledge#teach", linkLabel: T("Teach BARRY", "ללמד את BARRY") };
  if (c.area === "authority") return { href: "/owner/rules", linkLabel: T("Rules", "כללים") };
  if (c.area === "systems" || c.area === "payments") return { href: "/owner/systems", linkLabel: T("Connected systems", "מערכות מחוברות") };
  if (c.area === "channel") return { href: "/owner/systems#whatsapp_customers", linkLabel: T("Connected systems", "מערכות מחוברות") };
  return {};
}

const SYSTEM_HE: Record<string, string> = { commerce: "החנות", payments: "התשלומים", scheduling: "התורים", messaging: "ההודעות" };

/** A readiness check in the owner's language (Hebrew recomposed from the check's id; English as assessed). */
export function checkWords(c: ReadinessCheck, lang: OwnerLang = "en"): { label: string; detail: string; fix?: string } {
  if (lang !== "he") return { label: c.label, detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) };
  const pass = c.status === "pass";
  const id = c.id;
  if (id === "knowledge.offers") return { label: "מה העסק מוכר", detail: pass ? "BARRY יודע מה אתה מוכר." : "לא הוגדרו מוצרים או שירותים.", fix: "להוסיף מוצרים ושירותים עם מחירים." };
  if (id === "knowledge.goals") return { label: "מטרות העסק", detail: pass ? "BARRY יודע לאן לכוון כל שיחה." : "לא הוגדרו מטרות.", fix: "לבחור מה BARRY צריך להשיג (מכירה, תורים, לידים…)." };
  if (id === "knowledge.policies") return { label: "מדיניות ושאלות נפוצות", detail: pass ? "יש ל־BARRY מדיניות לצטט." : "אין מדיניות או שאלות נפוצות — BARRY יגיד שהוא לא יודע.", fix: "להוסיף מדיניות החזרות, משלוחים ועוד." };
  if (id === "knowledge.hours") return { label: "שעות פתיחה", detail: pass ? "שעות הפתיחה מוגדרות." : "אין שעות פתיחה — BARRY לא יציין שעות.", fix: "להוסיף שעות פתיחה." };
  if (id.startsWith("knowledge.review.")) return { label: keyTitle(id.slice("knowledge.review.".length), "he"), detail: "פרט שנלמד ומחכה לאישור שלך.", fix: "לאשר, לתקן או לדחות." };
  if (id.startsWith("knowledge.")) {
    const key = id.slice("knowledge.".length);
    return { label: keyTitle(key, "he"), detail: teachQuestion(key, c.detail, "he"), fix: "לענות — כמו שהיית מסביר לעובד חדש." };
  }
  if (id === "ai.model") return { label: "מודל AI חי", detail: pass ? "ההבנה רצה על המודל החי." : "BARRY רץ על ההבנה המדומה של הסימולטור.", fix: "צוות BARRY מפעיל את מודל ה־AI החי." };
  if (id === "ai.health" || id === "ai.traffic") return { label: id === "ai.health" ? "זמינות ה־AI" : "AI תקין תחת תנועה אמיתית", detail: pass ? "ההבנה עובדת כרגיל." : "ההבנה לא יציבה כרגע.", fix: "לבדוק את מצב ספק ה־AI." };
  if (id === "platform.persistence") return { label: "שמירה קבועה", detail: pass ? "שיחות, אישורים ותשלומים נשמרים לצמיתות." : "הנתונים נשמרים רק בזיכרון ויאבדו בהפעלה מחדש.", fix: "צוות BARRY מחבר את מסד הנתונים." };
  if (id === "platform.owner_access") return { label: "גישת בעלים לאישורים", detail: pass ? "יש לך גישה משלך, רק לעסק הזה." : c.status === "warn" ? "הגישה משתמשת בסיסמה משותפת שפותחת כל עסק." : "אין גישת בעלים — אף אחד לא יכול לאשר בקשות.", fix: "צוות BARRY מנפיק לך כניסה אישית." };
  if (id === "systems.connected") return { label: "מערכות העסק", detail: "כל המערכות מחוברות לספקים אמיתיים." };
  if (id === "systems.unavailable") return { label: "מערכות מחוברות", detail: "לא ניתן היה לקרוא את מצב החיבורים.", fix: "לבדוק את החיבור למסד הנתונים." };
  if (id.startsWith("systems.") || id.startsWith("payments.") && !id.startsWith("payments.proven")) {
    const cap = id.split(".")[1];
    return { label: `מערכת ${SYSTEM_HE[cap] ?? cap}`, detail: `${SYSTEM_HE[cap] ?? "המערכת"} עוד לא מחוברים למערכת אמיתית (או רצים על סימולטור).`.replace("החנות עוד לא מחוברים", "החנות עוד לא מחוברת"), fix: "צוות BARRY מחבר את המערכת איתך." };
  }
  if (id === "authority.consequential") return { label: "שליטה בפעולות משמעותיות", detail: pass ? "כל פעולה משמעותית כפופה לכללים שלך." : "יש פעולות ש־BARRY רשאי לבצע בלי לשאול, או שאין גבול סכום לקישורי תשלום.", fix: "לקבוע כללי אישור וגבולות לפעולות שמשנות משהו." };
  if (id === "handoff.path") return { label: "העברה לאדם", detail: pass ? "מוגדר מה קורה כשלקוח צריך אדם." : "עוד לא הגדרת איך הצוות שלך עונה — BARRY לא יכול להבטיח ללקוחות תשובה.", fix: "לספר לצוות BARRY איך הצוות שלך לוקח את השיחה." };
  if (id === "channel.configured") return { label: "ערוץ לקוחות (וואטסאפ)", detail: pass ? "מספר וואטסאפ מופנה לעסק." : "וואטסאפ ללקוחות עוד לא מחובר לעסק.", fix: "צוות BARRY מחבר את מספר הוואטסאפ העסקי." };
  if (id === "channel.live") return { label: "תשובות נשלחות באמת", detail: pass ? "תשובות בוואטסאפ נשלחות." : "תשובות בוואטסאפ במצב בדיקה — לא נשלחות.", fix: "אחרי התקופה המפוקחת, צוות BARRY מעביר לשליחה אמיתית." };
  if (id === "channel.proven") return { label: "הודעה אמיתית נענתה מקצה לקצה", detail: pass ? "הודעת וואטסאפ אמיתית התקבלה ונענתה." : "עוד לא התקבלה ונענתה הודעת וואטסאפ אמיתית.", fix: "לשלוח הודעת בדיקה מטלפון אמיתי." };
  if (id === "payments.proven") return { label: "תשלום אמיתי אומת מקצה לקצה", detail: pass ? "תשלום אמיתי נוצר ואומת מול הספק." : "עוד לא אומת תשלום אמיתי מול הספק.", fix: "לבצע תשלום קטן ואמיתי דרך BARRY." };
  return { label: c.label, detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) };
}

const LEVEL_ORDER = ["NOT_READY", "READY_FOR_TESTING", "READY_FOR_SUPERVISED_PILOT", "READY_FOR_CUSTOMER_TRAFFIC"] as const;

export type SetupView = {
  headline: string;
  /** The server's assessed level — never recomputed here. */
  level: PilotReadiness["level"];
  supervisedReady: boolean;
  left: number;
  groups: { id: SetupGroupId; title: string; items: SetupItem[] }[];
  /** Release requirements before real customer traffic — the BARRY team's, shown apart so they don't read as the owner's to-do. */
  later: SetupItem[];
  journey: { id: string; title: string; state: "done" | "now" | "later"; detail: string; href?: string }[];
};

export function setupView(input: { readiness: PilotReadiness; mode: "simulator" | "supervised" | "live"; rulesActive: number; signedIn: boolean }, lang: OwnerLang = "en"): SetupView {
  const T = tr(lang);
  const r = input.readiness;
  const atLeast = (l: (typeof LEVEL_ORDER)[number]) => LEVEL_ORDER.indexOf(r.level) >= LEVEL_ORDER.indexOf(l);
  const supervisedReady = atLeast("READY_FOR_SUPERVISED_PILOT");
  const now = r.checks.filter((c) => c.gate !== "READY_FOR_CUSTOMER_TRAFFIC" && c.status !== "pass");
  const item = (c: ReadinessCheck): SetupItem => ({ id: c.id, ...checkWords(c, lang), ...linkOf(c, lang) });
  const groups = (["owner", "connection", "team", "optional"] as SetupGroupId[]).map((id) => ({ id, title: GROUP_TITLE[id][lang === "he" ? 1 : 0], items: now.filter((c) => groupOf(c) === id).map(item) })).filter((g) => g.items.length > 0);
  const left = now.filter((c) => c.status === "fail").length;
  const later = r.checks.filter((c) => c.gate === "READY_FOR_CUSTOMER_TRAFFIC" && c.status === "fail").map((c) => ({ id: c.id, ...checkWords(c, lang) }));
  const has = (g: SetupGroupId, area?: ReadinessCheck["area"][]) => now.some((c) => c.status === "fail" && groupOf(c) === g && (!area || area.includes(c.area)));
  const headline = atLeast("READY_FOR_CUSTOMER_TRAFFIC") ? T("Ready for real customers", "מוכן ללקוחות אמיתיים") : supervisedReady ? T("Ready to start supervised", "מוכן להתחלה מפוקחת") : T(`${left} thing${left === 1 ? "" : "s"} left before supervised start`, left === 1 ? "נשאר דבר אחד לפני התחלה מפוקחת" : `נשארו ${left} דברים לפני התחלה מפוקחת`);
  const step = (done: boolean) => (done ? "done" : "now") as "done" | "now";
  const connected = !has("connection");
  const taught = !has("owner", ["knowledge", "handoff"]);
  const decided = !has("owner", ["authority"]);
  return {
    headline,
    level: r.level,
    supervisedReady,
    left,
    groups,
    later,
    journey: [
      { id: "meet", title: T("Meet BARRY", "הכירו את BARRY"), state: input.signedIn ? "done" : "now", detail: T("Signed in — you see only your own business.", "מחובר — אתה רואה רק את העסק שלך.") },
      { id: "connect", title: T("Connect your business", "חיבור העסק"), state: step(connected), detail: connected ? T("Every system BARRY needs is connected.", "כל המערכות ש־BARRY צריך מחוברות.") : T("Some systems aren't connected yet, or run on a simulator.", "חלק מהמערכות עוד לא מחוברות, או רצות על סימולטור."), href: "/owner/systems" },
      { id: "teach", title: T("Teach BARRY", "ללמד את BARRY"), state: step(taught), detail: taught ? T("BARRY has the answers it needs to start.", "יש ל־BARRY את התשובות שהוא צריך כדי להתחיל.") : T("A few answers only you can give.", "כמה תשובות שרק אתה יכול לתת."), href: "/owner/knowledge#teach" },
      { id: "decide", title: T("Decide what BARRY may do", "להחליט מה BARRY רשאי לעשות"), state: step(decided), detail: T(`${input.rulesActive} rules in force. Above your limits, BARRY asks you first.`, `${input.rulesActive} כללים בתוקף. מעבר לגבולות שלך, BARRY שואל אותך קודם.`), href: "/owner/rules" },
      { id: "supervised", title: T("Supervised start", "התחלה מפוקחת"), state: input.mode !== "simulator" && supervisedReady ? "done" : supervisedReady ? "now" : "later", detail: supervisedReady ? T("BARRY works with real customers while the BARRY team watches closely and you approve what matters.", "BARRY עובד עם לקוחות אמיתיים, צוות BARRY צמוד, ואתה מאשר את מה שחשוב.") : T("Unlocks once everything above is done.", "ייפתח כשכל מה שלמעלה יושלם.") },
      { id: "autonomy", title: T("Earn more autonomy", "יותר עצמאות, בהדרגה"), state: input.mode === "live" ? "done" : "later", detail: T("Never automatic: after a supervised period, you and the BARRY team decide together what BARRY may do on its own.", "אף פעם לא אוטומטית: אחרי תקופה מפוקחת, אתה וצוות BARRY מחליטים יחד מה BARRY רשאי לעשות לבד.") },
    ],
  };
}

// ── Activity ───────────────────────────────────────────────────────────────────────────────────────

export type TimelineItem = ActivityItem & { href?: string };

/** Everything that happened, in human words, newest first — each item drills down to its record. */
export function activityTimeline(ws: Pick<OwnerWorkspace, "outcomes" | "approvals" | "obligations" | "conversations" | "ownerCommands" | "ownerOperations" | "initiatives"> & Partial<Pick<OwnerWorkspace, "initiativeHistory">>, limit = 60, lang: OwnerLang = "en"): TimelineItem[] {
  const T = tr(lang);
  const out: TimelineItem[] = activityFeed(ws, limit, lang);
  const SOURCE = { web: T("on the site", "באתר"), whatsapp: T("on WhatsApp", "בוואטסאפ"), voice: T("by voice", "בקול") } as const;
  for (const c of ws.ownerCommands) {
    if (!c.at) continue;
    out.push({ id: `cmd:${c.id}`, at: c.at, icon: "chat", tone: "violet", text: T(`You asked BARRY ${SOURCE[c.source] ?? ""}: “${c.text}”`, `שאלת את BARRY ${SOURCE[c.source] ?? ""}: “${c.text}”`), sub: lang === "he" ? undefined : c.reply || undefined, ...(c.operationId ? { href: `/owner?tab=work&operation=${encodeURIComponent(c.operationId)}` } : {}) });
  }
  for (const o of ws.ownerOperations) {
    if (o.stoppedAt) out.push({ id: `op-stop:${o.id}`, at: o.stoppedAt, icon: "shield", tone: "neutral", text: T(`You stopped: ${o.title}`, `עצרת: ${proactiveWords(o.workflow, "he").title}`), href: `/owner?tab=work&operation=${encodeURIComponent(o.id)}` });
  }
  for (const i of [...ws.initiatives, ...(ws.initiativeHistory ?? [])]) {
    const card = noticedCard(i, lang);
    out.push({ id: `ini:${i.id}`, at: i.surfacedAt ?? i.firstSeenAt, icon: "flag", tone: "violet", text: T(`BARRY noticed: ${card.what}`, `BARRY שם לב: ${card.what}`), href: "/owner?tab=work#noticed" });
    if (i.decidedAt && (i.state === "dismissed" || i.state === "snoozed")) out.push({ id: `ini-d:${i.id}`, at: i.decidedAt, icon: "flag", tone: "neutral", text: i.state === "dismissed" ? T(`You dismissed: ${card.what}`, `דחית: ${card.what}`) : T(`You snoozed: ${card.what}`, `דחית לשבוע: ${card.what}`) });
  }
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, limit);
}
