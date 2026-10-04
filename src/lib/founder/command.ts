import { z } from "zod";

/**
 * THE FOUNDER COMMAND (pure) — what a piece of founder text MEANS, over the HQ fleet. Interpretation
 * never executes anything, never grants authority and never invents a business: a business name is only
 * a hint until `resolveBusinesses` grounds it against the fleet directory.
 *
 *   fleet_read        the Founder Brief, who needs attention, what changed
 *   business_inspect  one business, and the follow-ups on it (why / incidents / what changed / what can I do)
 *   commercial_read   cost to serve, plans, MRR — only from commercial / usage / support records
 *   value_read        who is not getting value — verified MADE / SAVED semantics only
 *   incident_read     open incidents, broken integrations
 *   initiative_read   what BARRY noticed across the fleet (persisted initiatives only)
 *   initiative_scan   run ONE bounded scan of ONE business through the Initiative Engine (force = explicit QA wording only)
 *   release_read      the release candidate, build and runtime
 *   founder_action    an EXISTING founder control: pause / resume a business, safe mode on / off
 *   proposal          rollout / runtime / capability / configuration → a durable, gated proposal
 *   handle_safe       resolve what is safe without approval; leave the rest as proposals
 *   unsupported       anything else — arbitrary SQL, env, secrets, deploys, bypassing an owner
 */

export type FleetTopic = "brief" | "attention" | "changed" | "approvals" | "launch";
export type BusinessFollowUp = "overview" | "why" | "incidents" | "changed" | "options" | "readiness" | "money" | "approvals";
export type CommercialTopic = "cost_to_serve" | "plans" | "models";
export type IncidentTopic = "integrations" | "incidents";
export type FounderActionKind = "pause_business" | "resume_business" | "safe_mode_on" | "safe_mode_off" | "require_approval_on" | "require_approval_off" | "pause_capability" | "resume_capability" | "set_mode";
export type FounderMode = "simulator" | "supervised" | "live";
/** Capability families a founder can pause by name (the founder control matches "family.*"). Generic, never a business type. */
export const CAPABILITY_FAMILIES = ["payments", "commerce", "scheduling", "support", "messaging", "shipping"] as const;
export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];
export type ProposalKindIntent = "rollout" | "runtime" | "capability" | "configuration";

export type FounderIntent =
  | { family: "fleet_read"; topic: FleetTopic }
  | { family: "business_inspect"; followUp: BusinessFollowUp }
  | { family: "commercial_read"; topic: CommercialTopic }
  | { family: "value_read" }
  | { family: "incident_read"; topic: IncidentTopic }
  | { family: "initiative_read" }
  | { family: "initiative_scan"; force: boolean }
  | { family: "release_read" }
  | { family: "founder_action"; action: FounderActionKind; capability?: CapabilityFamily; mode?: FounderMode }
  | { family: "proposal"; kind: ProposalKindIntent }
  | { family: "handle_safe" }
  | { family: "unsupported"; reason: string };

export type FounderFamily = FounderIntent["family"];

/** Things Founder BARRY never does, whatever the words. Checked first. */
const FORBIDDEN: { about: RegExp; reason: string }[] = [
  { about: /\b(sql|select \*|drop table|delete from|truncate|database query|run (?:a )?query)\b/i, reason: "Founder BARRY never runs arbitrary SQL." },
  { about: /\b(env(?:ironment)? var\w*|\.env\b|set (?:the )?env|vercel env)\b/i, reason: "Founder BARRY never changes environment variables." },
  { about: /\b(secrets?|tokens?|api[ -]?keys?|passwords?|credentials?|private keys?)\b/i, reason: "Founder BARRY never reads or reveals secrets or credentials." },
  { about: /\b(deploy|push|merge|ship)\b.*\b(prod\w*|main|code|now)\b|\bpromote to prod\w*/i, reason: "Founder BARRY never deploys code — a rollout can only be prepared as a proposal." },
  { about: /\b(approve|decline|reject)\b.*\b(for (?:the )?owner|owner'?s|on behalf)\b|\bbypass\b|\boverride (?:the )?owner\b/i, reason: "Owner approvals belong to the owner; Founder BARRY never decides for them or bypasses approval." },
  { about: /\b(change|edit|set|update)\b.*\b(discount|price|pricing|policy|policies|rules?)\b.*\b(for|of|at)\b/i, reason: "Owner and customer policies are the owner's; Founder BARRY doesn't change them." },
];

const HANDLE = /\bhandle (?:what|whatever|everything) (?:you )?(?:safely )?can\b|\btake care of (?:what|whatever) you (?:safely )?can\b|\bdo what(?:ever)? you (?:safely )?can\b/i;
const PROPOSE = /\b(prepare|propose|draft|plan|set up|stage)\b/i;
const ROLLOUT = /\b(roll ?outs?|roll (?:it )?out|upgrade|new (?:build|release|version))\b/i;
const RUNTIME = /\b(runtime|model|reasoner|composer)\b/i;
const CAPABILITY = /\b(capabilit\w+|enable \w+ (?:for|at)|turn on \w+ (?:for|at))\b/i;
const CONFIG = /\b(config\w*|setting\w*|mode change|switch \w+ to (?:supervised|live))\b/i;
const PAUSE = /^(?:please\s+|barry,?\s+)*(?:pause|stop|halt|freeze)\b|\bpause barry\b/i;
const RESUME = /^(?:please\s+|barry,?\s+)*(?:resume|unpause|restart|un-?freeze|start .* again)\b/i;
const SAFE_ON = /\b(?:put|turn|switch|enable|move)\b.*\bsafe mode\b(?!.*\boff\b)|\bsafe mode on\b/i;
const SAFE_OFF = /\b(?:take|turn|switch|disable|leave|exit|lift)\b.*\bsafe mode\b.*?(?:\boff\b|\bout\b)?|\bsafe mode off\b|\bout of safe mode\b/i;

// Founder controls beyond pause / safe mode — the same audited founder control HQ uses.
const CAP_WORDS = "payments?|payment links?|checkouts?|carts?|commerce|orders?|bookings?|appointments?|scheduling|support|tickets?|messaging|outbound messages|shipping|shipments?|refunds?";
const PAUSE_CAP = new RegExp(`\\b(?:pause|disable|stop|block|turn off|freeze)\\s+(?:the\\s+|all\\s+)?(${CAP_WORDS})\\b`, "i");
const RESUME_CAP = new RegExp(`\\b(?:resume|unpause|re-?enable|enable|turn on|unblock|unfreeze)\\s+(?:the\\s+|all\\s+)?(${CAP_WORDS})\\b`, "i");
const APPROVAL_ON = /\b(?:require|demand|need|make)\b[^.?!]*\bapprovals?\b[^.?!]*\b(?:every|all|each|any)\b|\bapproval (?:for|on) (?:every|all|each|any)\b|\bhuman[- ]only\b(?![^.?!]*\b(?:off|lift|remove)\b)/i;
const APPROVAL_OFF = /\b(?:lift|remove|stop|drop|turn off|cancel|end|relax)\b[^.?!]*\b(?:approval|human[- ]only)\b/i;
const SET_MODE = /\b(?:switch|move|put|set|change|take)\b[^.?!]*\b(?:to|into|in)\s+(simulator|supervised|live|practice)\b/i;
const READINESS = /\b(?:why (?:is|isn'?t)\b[^?]*\b(?:not )?ready|not ready|ready to (?:go live|launch)|readiness|launch (?:gate|blockers?|checklist)|what(?:'s| is) blocking (?:the )?(?:launch|go-?live))\b/i;
const LAUNCH_RANK = /\b(?:closest to (?:going live|launch(?:ing)?|live|ready)|nearest to (?:launch|live)|who(?:'s| is) (?:most |almost )?ready|which (?:business(?:es)?|one) (?:is|are) (?:most |almost )?ready)\b/i;
const APPROVALS = /\b(?:approvals? (?:waiting|pending|open)|pending approvals?|waiting (?:for|on) (?:an? )?approvals?|any approvals?|open approvals?)\b/i;
const MODELS = /\b(?:model (?:usage|costs?|spend\w*|bill)|spend\w* on (?:the )?(?:ai |llm )?models?|ai (?:costs?|spend\w*|usage)|tokens? (?:costs?|usage|spend\w*)|llm (?:costs?|spend\w*)|openai (?:costs?|bill|spend\w*))\b/i;
const BIZ_MONEY = /\b(?:money|revenue|paid|payments?|sales|made|collected)\b/i;

const BRIEF = /\b(need to know|brief(?:ing)?|catch me up|what(?:'s| is) (?:up|happening)(?: today| across| in the fleet)?|anything i should know|morning)\b/i;
const ATTENTION = /\b(need\w* (?:my )?attention|need\w* me|unhealthy|in trouble|at risk|struggling|which businesses? (?:are|is) (?:not )?(?:ok|healthy|degraded|blocked|paused))\b/i;
const CHANGED = /\b(what changed|changes? since|since yesterday|what(?:'s| is) new|what happened)\b/i;
const COST = /\b(cost\w* (?:us )?(?:the )?most|cost to serve|cost-to-serve|most expensive|expensive to serve|spend\w*|margin\w*|unit economics)\b/i;
const PLANS = /\b(plans?|mrr|recurring revenue|subscriptions?|free month|trial|billing|setup fee)\b/i;
const VALUE = /\b(value|getting enough|worth it|benefit\w*|roi)\b/i;
/** Asks to RUN a scan (an action), as opposed to asking what was already noticed (a read). */
const SCAN = /\b(?:run|start|do|kick off|trigger|fire|force)\b[^.?!]*\b(?:scan|initiative scan)\b|\bscan\b[^.?!]*\b(?:for|at|of)\b[^.?!]*\binitiatives?\b|^(?:please\s+)?scan\b|\bsee if (?:barry )?notices?\b|\bcheck (?:if|whether) (?:barry )?notices?\b|\blook for (?:new )?initiatives\b/i;
const FORCE_SCAN = /\bforce[d]?\b|\bbypass (?:the )?(?:daily )?(?:scan )?limit\b|\bfor qa\b/i;
const NOTICED = /\b(notice[d]?|initiatives?|spotted|opportunit\w+|ideas)\b/i;
const INTEGRATIONS = /\b(integrations?|connections?|providers?|connectors?|webhooks?)\b.*\b(broken|failing|down|unhealthy|degraded|issues?|problems?)\b|\b(broken|failing|down|unhealthy|degraded)\b.*\b(integrations?|connections?|providers?|connectors?)\b/i;
const INCIDENTS = /\b(incidents?|what broke|broken|failures?|errors?)\b/i;
const RELEASE = /\b(release|build|version|deploy(?:ed|ment)? state|candidate|sha|runtime)\b/i;
const WHY = /^(?:and\s+)?why\b|\bwhy (?:is|are|does)\b/i;
const OPTIONS = /\bwhat can i do\b|\bwhat are my options\b|\bhow do i fix\b/i;
const SHOW_INCIDENT = /\bshow (?:me )?(?:the )?incidents?\b/i;
const OVERVIEW = /\b(what'?s going on|how is|how'?s|status of|tell me about|look at|inspect|drill)\b/i;

// Hebrew (and code-switched Hebrew + English names): the same closed intent set, recognised by meaning.
const HE_FORBIDDEN = /סיסמ|טוקן|מפתח(?:ות)? API|מפתח סודי|סוד(?:ות)?\b|משתני סביבה|תמחק את ה(?:נתונים|טבלה)|תעשה deploy|תעלה לפרודקשן/;
const HE_CAP = "(?:ה)?(?:תשלומים|תשלום|סליקה|קישורי תשלום|הזמנות|עגלה|עגלות|תורים|קביעת תורים|תמיכה|פניות|הודעות|משלוחים|החזרים)";
const heCapability = (t: string): CapabilityFamily | undefined => {
  const m = t.match(new RegExp(HE_CAP));
  const w = m?.[0].replace(/^ה/, "") ?? "";
  if (/תשלו|סליקה/.test(w)) return "payments";
  if (/הזמנות|עגל/.test(w)) return "commerce";
  if (/תורים/.test(w)) return "scheduling";
  if (/תמיכה|פניות/.test(w)) return "support";
  if (/הודעות/.test(w)) return "messaging";
  if (/משלוחים/.test(w)) return "shipping";
  if (/החזרים/.test(w)) return "payments";
  return undefined;
};
const HE_MODE: Record<string, FounderMode> = { מפוקח: "supervised", פיקוח: "supervised", סימולטור: "simulator", תרגול: "simulator", לייב: "live", חי: "live", פעיל: "live" };
const HE: { re: RegExp; needs?: "business"; intent: (t: string) => FounderIntent | undefined }[] = [
  // Founder controls with a target (before the plain pause / resume rules below).
  { re: new RegExp(`^(?:בבקשה\\s+)?(?:תשהה|השהה|תעצור|עצור|תחסום|חסום|תכבה|כבה)\\s+(?:את\\s+)?${HE_CAP}`), intent: (t) => (/\?\s*$/.test(t) ? undefined : { family: "founder_action", action: "pause_capability", capability: heCapability(t) }) },
  { re: new RegExp(`^(?:בבקשה\\s+)?(?:תחזיר|החזר|תפעיל|הפעל|תחדש|חדש|תשחרר|שחרר)\\s+(?:את\\s+)?${HE_CAP}`), intent: (t) => (/\?\s*$/.test(t) ? undefined : { family: "founder_action", action: "resume_capability", capability: heCapability(t) }) },
  { re: /(?:תבטל|בטל|תוריד|הורד|תסיר|הסר)\s+(?:את\s+)?(?:דרישת|חובת|ה?דרישה ל)\s*(?:ה)?אישור/, intent: () => ({ family: "founder_action", action: "require_approval_off" }) },
  { re: /(?:תדרוש|דרוש|תחייב|חייב|תבקש|בקש)\s+(?:ש?)?אישור|אישור (?:על|ל)\s*כל (?:פעולה|דבר)/, intent: (t) => (/\?\s*$/.test(t) ? undefined : { family: "founder_action", action: "require_approval_on" }) },
  { re: /(?:תעביר|העבר|תשים|שים|תחזיר|החזר|תכניס|הכנס)\s+[^?]*?(?:ל|למצב\s+|במצב\s+)(מפוקח|פיקוח|סימולטור|תרגול|לייב|חי|פעיל)(?:\s|$|[.!])/, intent: (t) => {
    const m = t.match(/(?:ל|למצב\s+|במצב\s+)(מפוקח|פיקוח|סימולטור|תרגול|לייב|חי|פעיל)(?:\s|$|[.!])/);
    return m ? { family: "founder_action", action: "set_mode", mode: HE_MODE[m[1]] } : undefined;
  } },
  { re: /(?:מי|איזה עסק|איזה)\s+(?:הכי\s+)?קרוב (?:ל)?(?:עלות|לעלות|השקה|להשקה)|מי (?:הכי )?מוכן (?:לעלות|להשקה)/, intent: () => ({ family: "fleet_read", topic: "launch" }) },
  { re: /לא מוכן (?:לעלות|להשקה|לאוויר)|למה [^?]*לא (?:מוכן|עולה)|מה חוסם (?:את )?(?:העלייה|ההשקה)|מוכנות (?:ל)?(?:עלייה|השקה)/, needs: "business", intent: () => ({ family: "business_inspect", followUp: "readiness" }) },
  { re: /(?:כמה )?(?:אנחנו )?(?:מוציאים|משלמים) על (?:ה)?(?:מודלים|AI|בינה)|עלות (?:ה)?מודלים|שימוש (?:ב)?מודלים|טוקנים/i, intent: () => ({ family: "commercial_read", topic: "models" }) },
  { re: /(?:יש )?אישורים (?:ש)?(?:מחכים|ממתינים|פתוחים)|יש אישורים/, intent: () => ({ family: "fleet_read", topic: "approvals" }) },
  { re: /(?:ה)?כסף|הכנסות|שילמו|תשלומים|מכירות/, needs: "business", intent: (t) => (/(?:תשהה|השהה|תעצור|עצור|תחזיר|החזר)/.test(t) ? undefined : { family: "business_inspect", followUp: "money" }) },
  { re: /תטפל במה ש(?:אתה )?(?:יכול|אפשר)|תטפל בכל מה ש/, intent: () => ({ family: "handle_safe" }) },
  { re: /(?:תכין|הכן|תנסח)\s+(?:פריסה|rollout|רולאאוט)/i, intent: () => ({ family: "proposal", kind: "rollout" }) },
  { re: /מצב בטוח/, intent: (t) => (/\?\s*$/.test(t) ? undefined : /(?:תכבה|כבה|תוציא|הוצא|צא|בטל|תבטל)/.test(t) ? { family: "founder_action", action: "safe_mode_off" } : /(?:תפעיל|הפעל|תכניס|הכנס|תשים|שים|תעביר)/.test(t) ? { family: "founder_action", action: "safe_mode_on" } : undefined) },
  { re: /^(?:בבקשה\s+)?(?:תחזיר|החזר|תחדש|חדש|תפעיל מחדש|הפעל מחדש)/, intent: () => ({ family: "founder_action", action: "resume_business" }) },
  { re: /^(?:בבקשה\s+)?(?:תשהה|השהה|תעצור|עצור|תקפיא|הקפא)/, intent: (t) => (/\?\s*$/.test(t) ? undefined : { family: "founder_action", action: "pause_business" }) },
  { re: /(?:תריץ|הרץ|תעשה|תבצע|תפעיל)\s+(?:סריקה|סריקת|(?:an?\s+)?(?:initiative\s+)?scan)|^(?:תסרוק|סרוק)|(?:תבדוק|בדוק) אם (?:BARRY|בארי|ברי) (?:שם לב|מזהה|רואה)/i, intent: (t) => ({ family: "initiative_scan", force: /בכפייה|תכפה|כפה|לבדיקה|\bQA\b|תעקוף/.test(t) }) },
  { re: /^ו?למה(?:\s|\?|$)/, needs: "business", intent: () => ({ family: "business_inspect", followUp: "why" }) },
  { re: /מה אני יכול לעשות|מה האפשרויות/, needs: "business", intent: () => ({ family: "business_inspect", followUp: "options" }) },
  { re: /(?:תראה|הראה)(?: לי)? (?:את )?(?:ה)?תקל/, needs: "business", intent: () => ({ family: "business_inspect", followUp: "incidents" }) },
  { re: /(?:עולה|עולים|עלו)\s+(?:לנו\s+)?הכי הרבה|עלות (?:ה)?שירות|הכי יקר/, intent: () => ({ family: "commercial_read", topic: "cost_to_serve" }) },
  { re: /מספיק ערך|לא מקבלים ערך/, intent: () => ({ family: "value_read" }) },
  { re: /(?:מה|מי)\s+(?:BARRY|בארי|ברי)\s+(?:שם לב|זיהה|גילה|מצא)|יוזמות|מה (?:שמת|שמת לב|מצאת)/i, intent: () => ({ family: "initiative_read" }) },
  { re: /(?:אינטגרציות|חיבורים|ספקים|חיבור).*(?:שבור|לא עובד|תקול|נפל)/, intent: () => ({ family: "incident_read", topic: "integrations" }) },
  { re: /מה קורה (?:עם|אצל|ב)|מה המצב (?:של|עם|ב|אצל)|ספר לי על|איך הולך (?:ל|עם|ב|אצל)|מה (?:ברי|בארי|BARRY) עושה/i, needs: "business", intent: () => ({ family: "business_inspect", followUp: "overview" }) },
  { re: /^מה השתנה\??$/, needs: "business", intent: () => ({ family: "business_inspect", followUp: "changed" }) },
  { re: /מה השתנה|מאתמול|מה חדש/, intent: () => ({ family: "fleet_read", topic: "changed" }) },
  { re: /מה (?:אני )?צריך לדעת|תדריך|תעדכן אותי|מה המצב(?:\?|$)|מה קורה היום/, intent: () => ({ family: "fleet_read", topic: "brief" }) },
  { re: /צרי(?:כים|כה|ך) (?:תשומת לב|אותי)|(?:אילו|איזה) (?:עסקים|עסק) (?:בבעיה|צריכים|צריך)/, intent: () => ({ family: "fleet_read", topic: "attention" }) },
  { re: /תקלות|מה נשבר|אירועים פתוחים/, intent: () => ({ family: "incident_read", topic: "incidents" }) },
  { re: /גרסה|ריליס|שחרור|בילד/, intent: () => ({ family: "release_read" }) },
];

function interpretHebrew(t: string, hasBusiness: boolean): FounderIntent | undefined {
  if (HE_FORBIDDEN.test(t)) return { family: "unsupported", reason: "Founder BARRY never touches secrets, environment settings, data deletion or deploys." };
  for (const h of HE) {
    if (h.needs === "business" && !hasBusiness) continue;
    if (!h.re.test(t)) continue;
    const i = h.intent(t);
    if (i) return i;
  }
  return hasBusiness ? { family: "business_inspect", followUp: "overview" } : undefined;
}

/** Interpret founder text. `hasBusiness` = a business is named or carried from context. Pure. */
export function interpretFounder(text: string, opts: { hasBusiness?: boolean } = {}): FounderIntent {
  const t = text.trim().replace(/\s+/g, " ").slice(0, 1000);
  if (!t) return { family: "unsupported", reason: "Say what you want to know or do." };
  for (const f of FORBIDDEN) if (f.about.test(t)) return { family: "unsupported", reason: f.reason };
  if (/[֐-׿]/.test(t)) {
    const he = interpretHebrew(t, Boolean(opts.hasBusiness));
    if (he) return he;
  }
  if (HANDLE.test(t)) return { family: "handle_safe" };
  if (PROPOSE.test(t) && (ROLLOUT.test(t) || RUNTIME.test(t) || CAPABILITY.test(t) || CONFIG.test(t))) {
    return { family: "proposal", kind: ROLLOUT.test(t) ? "rollout" : RUNTIME.test(t) ? "runtime" : CAPABILITY.test(t) ? "capability" : "configuration" };
  }
  if (/\bsafe mode\b/i.test(t) && !/\?\s*$/.test(t)) {
    if (SAFE_OFF.test(t) && /\b(off|out|disable|leave|exit|lift|take)\b/i.test(t)) return { family: "founder_action", action: "safe_mode_off" };
    if (SAFE_ON.test(t)) return { family: "founder_action", action: "safe_mode_on" };
  }
  if (!/\?\s*$/.test(t)) {
    const capPause = t.match(PAUSE_CAP);
    if (capPause) return { family: "founder_action", action: "pause_capability", capability: capabilityFamily(capPause[1]) };
    const capResume = t.match(RESUME_CAP);
    if (capResume) return { family: "founder_action", action: "resume_capability", capability: capabilityFamily(capResume[1]) };
    if (APPROVAL_OFF.test(t)) return { family: "founder_action", action: "require_approval_off" };
    if (APPROVAL_ON.test(t)) return { family: "founder_action", action: "require_approval_on" };
    const mode = t.match(SET_MODE);
    if (mode) return { family: "founder_action", action: "set_mode", mode: mode[1].toLowerCase() === "practice" ? "simulator" : (mode[1].toLowerCase() as FounderMode) };
  }
  if (RESUME.test(t)) return { family: "founder_action", action: "resume_business" };
  if (PAUSE.test(t) && !/\?\s*$/.test(t)) return { family: "founder_action", action: "pause_business" };
  if (SCAN.test(t) && !/\b(what|which)\b.*\b(did|has|have)\b/i.test(t)) return { family: "initiative_scan", force: FORCE_SCAN.test(t) };
  if (LAUNCH_RANK.test(t)) return { family: "fleet_read", topic: "launch" };
  if (MODELS.test(t)) return { family: "commercial_read", topic: "models" };
  if (opts.hasBusiness) {
    if (READINESS.test(t)) return { family: "business_inspect", followUp: "readiness" };
    if (APPROVALS.test(t)) return { family: "business_inspect", followUp: "approvals" };
    if (BIZ_MONEY.test(t) && !COST.test(t)) return { family: "business_inspect", followUp: "money" };
    if (SHOW_INCIDENT.test(t)) return { family: "business_inspect", followUp: "incidents" };
    if (OPTIONS.test(t)) return { family: "business_inspect", followUp: "options" };
    if (WHY.test(t)) return { family: "business_inspect", followUp: "why" };
    if (/^what changed\??$/i.test(t) || (CHANGED.test(t) && !/\b(fleet|across|everyone|all businesses|since yesterday)\b/i.test(t))) return { family: "business_inspect", followUp: "changed" };
  }
  if (COST.test(t)) return { family: "commercial_read", topic: "cost_to_serve" };
  if (VALUE.test(t) && /\b(not|aren'?t|isn'?t|enough|low|least|weak|without)\b/i.test(t)) return { family: "value_read" };
  if (NOTICED.test(t)) return { family: "initiative_read" };
  if (INTEGRATIONS.test(t)) return { family: "incident_read", topic: "integrations" };
  if (opts.hasBusiness && OVERVIEW.test(t)) return { family: "business_inspect", followUp: "overview" };
  if (APPROVALS.test(t)) return { family: "fleet_read", topic: "approvals" };
  if (CHANGED.test(t)) return { family: "fleet_read", topic: "changed" };
  if (BRIEF.test(t)) return { family: "fleet_read", topic: "brief" };
  if (ATTENTION.test(t)) return { family: "fleet_read", topic: "attention" };
  if (INCIDENTS.test(t)) return { family: "incident_read", topic: "incidents" };
  if (PLANS.test(t)) return { family: "commercial_read", topic: "plans" };
  if (RELEASE.test(t)) return { family: "release_read" };
  if (VALUE.test(t)) return { family: "value_read" };
  if (opts.hasBusiness) return { family: "business_inspect", followUp: "overview" };
  return { family: "unsupported", reason: UNSUPPORTED_HELP };
}

/** The capability family a founder's word names (generic families only). */
export function capabilityFamily(word: string): CapabilityFamily | undefined {
  const w = word.toLowerCase();
  if (/payment|checkout|refund/.test(w)) return "payments";
  if (/cart|commerce|order/.test(w)) return "commerce";
  if (/booking|appointment|scheduling/.test(w)) return "scheduling";
  if (/support|ticket/.test(w)) return "support";
  if (/messag/.test(w)) return "messaging";
  if (/ship/.test(w)) return "shipping";
  return undefined;
}

/** The reason given when the words matched nothing (as opposed to a forbidden request). */
export const UNSUPPORTED_HELP = "I can answer about the fleet, a business (status, readiness, money, approvals), incidents, cost and model usage, value, initiatives or the release; pause / resume a business, switch safe mode or its operating mode, require approval for everything, pause / resume a capability; or prepare a proposal.";

// ── Business resolution (grounding, pure) ─────────────────────────────────────────────────────────

export type DirectoryEntry = { id: string; name: string; /** Other names the business goes by (e.g. its name in Hebrew) — reference data, matched like the name. */ aliases?: string[] };
export type BusinessResolution = { matched: DirectoryEntry[]; ambiguous: { word: string; candidates: DirectoryEntry[] }[] };

/** Words that never name a business on their own. */
const GENERIC = new Set(["the", "and", "for", "with", "barry", "business", "businesses", "store", "shop", "studio", "company", "co", "inc", "ltd", "llc", "demo", "fleet", "all", "every", "everyone", "what", "whats", "going", "pause", "resume", "rollout", "roll", "out", "prepare", "safe", "mode", "today", "yesterday", "since", "about", "how", "why", "show", "incident", "incidents", "changed", "customers", "customer", "value", "going", "need", "needs", "know", "cost", "costing", "most"]);

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/[\s-]+/).filter(Boolean);

/**
 * Ground business mentions against the fleet directory. A word names a business only when it is one of
 * that business's own name / id words; a word that fits more than one business is AMBIGUOUS (never
 * guessed). An exact id always wins.
 */
export function resolveBusinesses(text: string, directory: DirectoryEntry[]): BusinessResolution {
  const lower = text.toLowerCase();
  const matched = new Map<string, DirectoryEntry>();
  const ambiguous: BusinessResolution["ambiguous"] = [];
  // An exact slug id ("acme-retail") names its business; a bare-word id ("acme") is treated like any name word.
  for (const b of directory) if (/[-\d]/.test(b.id) && new RegExp(`(^|[^\\p{L}\\p{N}-])${b.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}-])`, "u").test(lower)) matched.set(b.id, b);
  const index = new Map<string, DirectoryEntry[]>();
  for (const b of directory) for (const w of new Set([...words(b.name), ...words(b.id), ...(b.aliases ?? []).flatMap(words)])) if (w.length >= 3 && !GENERIC.has(w)) index.set(w, [...(index.get(w) ?? []), b]);
  const seen = new Set<string>();
  for (const w of words(text)) {
    if (w.length < 3 || GENERIC.has(w) || seen.has(w)) continue;
    seen.add(w);
    // Hebrew attaches prepositions to the word ("לרינה", "ברינה", "שלרינה"): the bare word is tried when the whole one isn't known.
    const bare = !index.has(w) && /^[\u05D0-\u05EA]/.test(w) ? [w.replace(/^(?:של|ול|וב|ומ|וה|ש|ו|ה|ב|ל|מ|כ)/, "")].filter((x) => x.length >= 3 && x !== w) : [];
    const hits = [...(index.get(w) ?? []), ...bare.flatMap((x) => index.get(x) ?? [])].filter((b, i, a) => a.findIndex((x) => x.id === b.id) === i);
    if (hits.length === 1) matched.set(hits[0].id, hits[0]);
    else if (hits.length > 1 && !hits.some((h) => matched.has(h.id))) ambiguous.push({ word: w, candidates: hits });
  }
  return { matched: [...matched.values()], ambiguous };
}

// ── Model interpretation (optional) ──────────────────────────────────────────────────────────────

/**
 * A model may help INTERPRET (intent family, topic, business hints). Its output is schema-checked into
 * the same closed intent set — it can't name an action outside it, can't carry authority, and every
 * business hint is grounded against the directory like the founder's own words.
 */
export const ModelIntentSchema = z.object({
  family: z.enum(["fleet_read", "business_inspect", "commercial_read", "value_read", "incident_read", "initiative_read", "initiative_scan", "release_read", "founder_action", "proposal", "handle_safe", "unsupported"]),
  topic: z.string().max(40).optional(),
  action: z.enum(["pause_business", "resume_business", "safe_mode_on", "safe_mode_off", "require_approval_on", "require_approval_off", "pause_capability", "resume_capability", "set_mode"]).optional(),
  capability: z.enum(CAPABILITY_FAMILIES).optional(),
  mode: z.enum(["simulator", "supervised", "live"]).optional(),
  kind: z.enum(["rollout", "runtime", "capability", "configuration"]).optional(),
  businesses: z.array(z.string().max(80)).max(10).optional(),
});

export type FounderInterpreter = (text: string) => Promise<unknown>;

export function intentFromModel(raw: unknown): { intent: FounderIntent; businessHints: string[] } | undefined {
  const p = ModelIntentSchema.safeParse(raw);
  if (!p.success) return undefined;
  const d = p.data;
  const hints = d.businesses ?? [];
  const intent = ((): FounderIntent | undefined => {
    switch (d.family) {
      case "fleet_read":
        return { family: "fleet_read", topic: (["attention", "changed", "approvals", "launch"] as const).find((x) => x === d.topic) ?? "brief" };
      case "business_inspect":
        return { family: "business_inspect", followUp: (["why", "incidents", "changed", "options", "readiness", "money", "approvals"] as const).find((x) => x === d.topic) ?? "overview" };
      case "commercial_read":
        return { family: "commercial_read", topic: d.topic === "plans" ? "plans" : d.topic === "models" ? "models" : "cost_to_serve" };
      case "incident_read":
        return { family: "incident_read", topic: d.topic === "integrations" ? "integrations" : "incidents" };
      case "founder_action":
        // A model can name a control (it still needs the founder's explicit confirmation); a target it can't ground is dropped.
        return d.action ? { family: "founder_action", action: d.action, ...(d.capability ? { capability: d.capability } : {}), ...(d.mode ? { mode: d.mode } : {}) } : undefined;
      case "proposal":
        return { family: "proposal", kind: d.kind ?? "configuration" };
      case "initiative_scan":
        // A model can ask for a scan but never for a forced one: force needs the founder's own explicit words.
        return { family: "initiative_scan", force: false };
      case "unsupported":
        return { family: "unsupported", reason: "That isn't something Founder BARRY can do." };
      default:
        return { family: d.family };
    }
  })();
  return intent ? { intent, businessHints: hints } : undefined;
}
