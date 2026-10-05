import type { ConnectionView } from "@/lib/connections/status";
import type { ConversationState } from "@/lib/state";
import type { JobRecord } from "@/lib/background/runner";
import { readDeliveries } from "@/lib/channels/gateway";
import { getBackend } from "@/lib/store";
import { L, type OwnerLang } from "./lang";
import type { PaymentHealthEvent } from "@/lib/payments/health";
export { listPaymentHealthEvents } from "@/lib/payments/health";

/**
 * BUSINESS PROBLEMS — what is broken for the whole business (not one conversation), in the owner's words, from
 * records only. Every problem answers the same six questions, so the owner never gets silence or system language:
 *
 *   what happened · what is affected · is a customer blocked · did anything already happen · does the owner need to
 *   do something · the safest next step
 *
 * Sources (each durable): connection status (a real system disconnected / erroring / incomplete), the background
 * job ledger (a scheduled run that failed and was not followed by a good one), owner-channel deliveries (BARRY's
 * WhatsApp replies / notices to the owner that the provider refused), customer reply deliveries (several customers'
 * replies refused), and payment health events (a provider event that could not be verified against BARRY's records).
 * Nothing here claims a recovery: "already happened" says only what the records prove.
 *
 * The same list feeds the owner's "what needs me?", proactive owner notices, and the founder's incidents.
 */

export type ProblemKind = "connection" | "background_job" | "owner_channel" | "customer_delivery" | "payment_verification";
type Words = { en: string; he: string };
export type BusinessProblem = {
  /** Stable for the problem's episode (kind + subject + first failure) — notices dedupe on it. */
  key: string;
  kind: ProblemKind;
  severity: "high" | "medium";
  since: string;
  lastSeen: string;
  occurrences: number;
  what: Words;
  affected: Words;
  /** true / false from the records; "unknown" when the records can't say. */
  customerBlocked: boolean | "unknown";
  alreadyHappened: Words;
  ownerAction: Words | null;
  nextStep: Words;
  /** Founder / BARRY-team evidence (provider error codes, record ids) — never a secret. */
  evidence: string[];
};

export type OwnerDeliveryEvidence = { at: string; to: "owner"; status: string; reason?: string; via: "reply" | "notice" };

const H = 3600_000;

/** The owner's WhatsApp deliveries (replies to their commands, proactive notices) — what the provider accepted or refused. */
export async function listOwnerDeliveries(businessId: string): Promise<OwnerDeliveryEvidence[]> {
  const records = await getBackend().listOperatorRecords(businessId, "owner_command").catch(() => []);
  const briefs = await getBackend().listOperatorRecords(businessId, "owner_brief").catch(() => []);
  const replies = records.map((r) => r.data as { delivery?: { status: string; at: string; reason?: string } }).filter((c) => c?.delivery?.at).map((c) => ({ at: c.delivery!.at, to: "owner" as const, status: c.delivery!.status, ...(c.delivery!.reason ? { reason: c.delivery!.reason } : {}), via: "reply" as const }));
  const notices = briefs.map((r) => r.data as { at?: string; status?: string; reason?: string }).filter((b) => b?.at && b.status).map((b) => ({ at: b.at!, to: "owner" as const, status: b.status!, ...(b.reason ? { reason: b.reason } : {}), via: "notice" as const }));
  return [...replies, ...notices];
}

/** "WhatsApp send failed (401 / 190)" → the provider's own error code, and what it means in plain words. */
export function providerError(reason: string | undefined): { code: string | null; plain: Words } {
  const m = reason?.match(/\((\d{3})(?:\s*\/\s*(\d+))?\)/);
  const code = m ? (m[2] ? `${m[1]}/${m[2]}` : m[1]) : null;
  const sub = m?.[2];
  if (sub === "190" || m?.[1] === "401") return { code, plain: { en: "WhatsApp refused BARRY's access (the access token expired or was revoked)", he: "וואטסאפ דחה את הגישה של BARRY (ההרשאה פגה או בוטלה)" } };
  if (sub === "131047") return { code, plain: { en: "WhatsApp only allows an approved template more than 24 hours after the person last wrote", he: "וואטסאפ מאפשר רק הודעת תבנית מאושרת אחרי 24 שעות מההודעה האחרונה" } };
  if (sub === "131026") return { code, plain: { en: "WhatsApp could not deliver to that number", he: "וואטסאפ לא הצליח למסור למספר הזה" } };
  if (sub === "131056" || sub === "130429" || m?.[1] === "429") return { code, plain: { en: "WhatsApp is rate-limiting BARRY", he: "וואטסאפ מגביל זמנית את קצב ההודעות של BARRY" } };
  return { code, plain: { en: "WhatsApp did not accept the message", he: "וואטסאפ לא קיבל את ההודעה" } };
}

const DOMAIN: Record<string, { name: Words; does: Words; blocked: Words }> = {
  payments: { name: { en: "payment provider", he: "ספק התשלומים" }, does: { en: "create payment links or confirm payments", he: "ליצור קישורי תשלום או לאשר תשלומים" }, blocked: { en: "Customers who want to pay are told it can't be done right now — nothing is charged.", he: "לקוחות שרוצים לשלם מקבלים הודעה שזה לא אפשרי כרגע — שום דבר לא נגבה." } },
  scheduling: { name: { en: "calendar / booking system", he: "מערכת היומן / ההזמנות" }, does: { en: "check availability or book appointments", he: "לבדוק זמינות או לקבוע תורים" }, blocked: { en: "Customers who want to book are told it can't be done right now — nothing is booked.", he: "לקוחות שרוצים לקבוע תור מקבלים הודעה שזה לא אפשרי כרגע — שום דבר לא נקבע." } },
  commerce: { name: { en: "store system", he: "מערכת החנות" }, does: { en: "search products, check stock, build carts or create orders", he: "לחפש מוצרים, לבדוק מלאי, לבנות עגלה או ליצור הזמנות" }, blocked: { en: "Customers who want to buy are told it can't be done right now — no order is created.", he: "לקוחות שרוצים לקנות מקבלים הודעה שזה לא אפשרי כרגע — לא נוצרת הזמנה." } },
  messaging: { name: { en: "messaging connection", he: "חיבור ההודעות" }, does: { en: "send or receive messages", he: "לשלוח או לקבל הודעות" }, blocked: { en: "Customers may not get answers until it's fixed.", he: "ייתכן שלקוחות לא יקבלו תשובות עד שזה יתוקן." } },
};

export type ProblemInput = { connections: ConnectionView[]; jobs: JobRecord[]; ownerDeliveries: OwnerDeliveryEvidence[]; conversations: ConversationState[]; payments: PaymentHealthEvent[]; now: Date };

/** Pure: every business-level problem the records show right now. */
export function businessProblems(input: ProblemInput): BusinessProblem[] {
  const t = input.now.getTime();
  const nowIso = input.now.toISOString();
  const out: BusinessProblem[] = [];

  // 1) A REAL system BARRY works through is down or incomplete (simulators and never-connected systems are setup, not failures).
  for (const v of input.connections) {
    if (v.simulated || v.origin === "none" || v.status === "not_configured") continue;
    const broken = v.status === "error" || v.status === "disconnected" || (v.status === "connected" && v.missing.length > 0);
    if (!broken) continue;
    const d = DOMAIN[v.capability] ?? { name: { en: `${v.capability} system`, he: `מערכת ${v.capability}` }, does: { en: `use ${v.capability}`, he: `להשתמש ב־${v.capability}` }, blocked: { en: "Customers who need it are told it can't be done right now.", he: "לקוחות שצריכים את זה מקבלים הודעה שזה לא אפשרי כרגע." } };
    const state = v.status === "connected" ? { en: "is missing settings", he: "חסרות בו הגדרות" } : v.status === "disconnected" ? { en: "is disconnected", he: "מנותק" } : { en: "is returning errors", he: "מחזיר שגיאות" };
    out.push({
      key: `connection:${v.capability}:${v.provider ?? "unknown"}:${v.status}`,
      kind: "connection",
      severity: v.capability === "payments" || v.capability === "messaging" ? "high" : "medium",
      since: v.lastVerifiedAt ?? nowIso,
      lastSeen: nowIso,
      occurrences: 1,
      what: { en: `Your ${d.name.en}${v.provider ? ` (${v.provider})` : ""} ${state.en}.`, he: `${d.name.he}${v.provider ? ` (${v.provider})` : ""} ${state.he}.` },
      affected: { en: `BARRY can't ${d.does.en} until it's fixed.`, he: `BARRY לא יכול ${d.does.he} עד שזה יתוקן.` },
      customerBlocked: true,
      alreadyHappened: { en: d.blocked.en, he: d.blocked.he },
      ownerAction: { en: `Reconnect your ${d.name.en} (Settings → Systems), or tell the BARRY team.`, he: `לחבר מחדש את ${d.name.he} (הגדרות ← מערכות), או לפנות לצוות BARRY.` },
      nextStep: { en: "Until it's reconnected BARRY keeps failing safely — nothing is charged, booked or ordered. Customers who need it wait for you.", he: "עד שיחובר מחדש BARRY נכשל בצורה בטוחה — שום דבר לא נגבה, נקבע או הוזמן. לקוחות שצריכים את זה מחכים לך." },
      evidence: [`connection ${v.capability} · ${v.status}${v.provider ? ` · ${v.provider}` : ""}${v.missing.length ? ` · ${v.missing.length} missing setting(s)` : ""}`],
    });
  }

  // 2) A scheduled run failed and no later run of the same job succeeded.
  const latest = new Map<string, JobRecord>();
  for (const j of [...input.jobs].sort((a, b) => a.claimedAt.localeCompare(b.claimedAt))) latest.set(j.job, j);
  for (const j of latest.values()) {
    if (j.status !== "failed" || t - Date.parse(j.finishedAt ?? j.claimedAt) > 48 * H) continue;
    const name = j.job === "followups" ? { en: "Scheduled follow-ups", he: "המעקבים המתוזמנים" } : j.job === "owner_brief" ? { en: "Your daily brief", he: "הסיכום היומי שלך" } : j.job === "owner_alerts" ? { en: "Owner alerts", he: "ההתראות אליך" } : { en: "BARRY's background check", he: "הבדיקה הקבועה של BARRY" };
    const sent = j.summary?.sent ?? 0;
    out.push({
      key: `background_job:${j.job}:${j.slot}`,
      kind: "background_job",
      severity: j.job === "followups" ? "medium" : "medium",
      since: j.claimedAt,
      lastSeen: j.finishedAt ?? j.claimedAt,
      occurrences: j.attempts,
      what: { en: `${name.en} didn't run (the scheduled run failed).`, he: `${name.he} לא רצו (ההרצה המתוזמנת נכשלה).` },
      affected: j.job === "followups" ? { en: "Follow-ups that were due weren't sent.", he: "מעקבים שהגיע זמנם לא נשלחו." } : { en: "BARRY couldn't prepare it this time.", he: "BARRY לא הצליח להכין את זה הפעם." },
      customerBlocked: false,
      alreadyHappened: j.job === "followups" ? { en: sent ? `${sent} follow-up${sent === 1 ? " was" : "s were"} sent before it failed; nothing was sent twice.` : "No follow-up was sent in that run; nothing was sent twice.", he: sent ? `${sent} מעקבים נשלחו לפני הכישלון; שום דבר לא נשלח פעמיים.` : "לא נשלח שום מעקב בהרצה הזאת; שום דבר לא נשלח פעמיים." } : { en: "Nothing was sent by that run.", he: "שום דבר לא נשלח בהרצה הזאת." },
      ownerAction: null,
      nextStep: { en: j.retry ? "BARRY retries it automatically in this time slot; the BARRY team sees the failure." : "It runs again at the next scheduled time; the BARRY team sees the failure.", he: j.retry ? "BARRY ינסה שוב אוטומטית; צוות BARRY רואה את הכישלון." : "זה ירוץ שוב בזמן המתוזמן הבא; צוות BARRY רואה את הכישלון." },
      evidence: [`job ${j.job} slot ${j.slot} · failed · attempts ${j.attempts}${j.error ? ` · ${j.error.slice(0, 120)}` : ""}`],
    });
  }

  // 3) BARRY's WhatsApp messages to the OWNER are being refused by the provider (replies or notices, last 24h).
  const ownerFailed = input.ownerDeliveries.filter((d) => d.status === "failed" && t - Date.parse(d.at) <= 24 * H).sort((a, b) => a.at.localeCompare(b.at));
  if (ownerFailed.length) {
    const last = ownerFailed[ownerFailed.length - 1];
    const err = providerError(last.reason);
    out.push({
      key: `owner_channel:${ownerFailed[0].at.slice(0, 13)}`,
      kind: "owner_channel",
      severity: ownerFailed.length >= 2 ? "high" : "medium",
      since: ownerFailed[0].at,
      lastSeen: last.at,
      occurrences: ownerFailed.length,
      what: { en: `BARRY's WhatsApp messages to you aren't being delivered — ${err.plain.en}.`, he: `ההודעות של BARRY אליך בוואטסאפ לא נמסרות — ${err.plain.he}.` },
      affected: { en: "Answers to your WhatsApp questions and BARRY's alerts to you. Customers are not affected by this one.", he: "תשובות לשאלות שלך בוואטסאפ וההתראות של BARRY אליך. הלקוחות לא מושפעים מזה." },
      customerBlocked: false,
      alreadyHappened: { en: `${ownerFailed.length} message${ownerFailed.length === 1 ? "" : "s"} to you didn't arrive. Nothing was marked as sent, and nothing will be re-sent by itself.`, he: `${ownerFailed.length === 1 ? "הודעה אחת" : `${ownerFailed.length} הודעות`} אליך לא הגיעו. שום דבר לא סומן כנשלח, ושום דבר לא יישלח שוב מעצמו.` },
      ownerAction: { en: "Check what needs you here in BARRY (web) until it's fixed.", he: "בדוק מה מחכה לך כאן ב־BARRY (באתר) עד שזה יתוקן." },
      nextStep: { en: "The BARRY team fixes the WhatsApp connection; everything waiting is still in “What needs me”.", he: "צוות BARRY מתקן את החיבור לוואטסאפ; כל מה שמחכה עדיין מופיע ב״מה מחכה לי״." },
      evidence: ownerFailed.slice(-3).map((d) => `owner ${d.via} ${d.status} at ${d.at}${err.code ? ` · provider error ${err.code}` : ""}${d.reason ? ` · ${d.reason.slice(0, 80)}` : ""}`),
    });
  }

  // 4) Replies to SEVERAL customers refused by the channel (one customer's failure is that conversation's item).
  const failedConvos = input.conversations
    .map((c) => ({ c, last: readDeliveries(c.knownFields).at(-1) }))
    .filter((x) => x.last?.status === "failed" && t - Date.parse(x.last.at) <= 24 * H && !/not processed|interrupted/.test(x.last.error ?? ""));
  if (failedConvos.length >= 2) {
    const sorted = failedConvos.sort((a, b) => a.last!.at.localeCompare(b.last!.at));
    const err = providerError(sorted.at(-1)!.last!.error);
    out.push({
      key: `customer_delivery:${sorted[0].last!.at.slice(0, 13)}`,
      kind: "customer_delivery",
      severity: "high",
      since: sorted[0].last!.at,
      lastSeen: sorted.at(-1)!.last!.at,
      occurrences: failedConvos.length,
      what: { en: `BARRY's replies to customers aren't being delivered — ${err.plain.en}.`, he: `התשובות של BARRY ללקוחות לא נמסרות — ${err.plain.he}.` },
      affected: { en: `${failedConvos.length} customers didn't receive BARRY's last reply.`, he: `${failedConvos.length} לקוחות לא קיבלו את התשובה האחרונה של BARRY.` },
      customerBlocked: true,
      alreadyHappened: { en: "Those replies were NOT delivered and are not shown as sent. BARRY does not re-send them by itself.", he: "התשובות האלה לא נמסרו ולא מוצגות כנשלחו. BARRY לא שולח אותן שוב מעצמו." },
      ownerAction: { en: "Reply to those customers yourself from your own phone if it's urgent.", he: "אם זה דחוף, ענה ללקוחות האלה בעצמך מהטלפון שלך." },
      nextStep: { en: "The BARRY team fixes the WhatsApp connection; you can pause BARRY meanwhile (say “pause BARRY”).", he: "צוות BARRY מתקן את החיבור לוואטסאפ; בינתיים אפשר להשהות את BARRY (כתוב ״תעצור הכל״)." },
      evidence: sorted.slice(-3).map((x) => `${x.c.id} · delivery failed at ${x.last!.at}${x.last!.error ? ` · ${x.last!.error.slice(0, 80)}` : ""}`),
    });
  }

  // 5) Payment provider events BARRY could not verify against its records (last 48h).
  const pay = input.payments.filter((e) => t - Date.parse(e.at) <= 48 * H).sort((a, b) => a.at.localeCompare(b.at));
  if (pay.length) {
    out.push({
      key: `payment_verification:${pay[0].at.slice(0, 13)}`,
      kind: "payment_verification",
      severity: "high",
      since: pay[0].at,
      lastSeen: pay.at(-1)!.at,
      occurrences: pay.length,
      what: { en: "A payment notice from your payment provider couldn't be verified against BARRY's records.", he: "הודעת תשלום מספק התשלומים לא אומתה מול הרשומות של BARRY." },
      affected: { en: "That payment is NOT counted as paid, and BARRY didn't continue the sale based on it.", he: "התשלום הזה לא נספר כשולם, ו־BARRY לא המשיך את המכירה על סמך זה." },
      customerBlocked: "unknown",
      alreadyHappened: { en: "Nothing was marked paid and no order was created from it. Whether the customer was charged can only be confirmed in your payment provider.", he: "שום דבר לא סומן כשולם ולא נוצרה הזמנה. אם הלקוח חויב — אפשר לוודא רק אצל ספק התשלומים." },
      ownerAction: { en: "Check the payment in your payment provider's dashboard.", he: "בדוק את התשלום בלוח הבקרה של ספק התשלומים." },
      nextStep: { en: "The BARRY team checks the mismatch; if the customer paid, they confirm it with you before anything continues.", he: "צוות BARRY בודק את אי־ההתאמה; אם הלקוח שילם, מאשרים איתך לפני שממשיכים." },
      evidence: pay.slice(-3).map((e) => `payment ${e.paymentId ?? "unknown"} · ${e.provider} · ${e.reason} at ${e.at}`),
    });
  }
  return out.sort((a, b) => (a.severity === b.severity ? b.lastSeen.localeCompare(a.lastSeen) : a.severity === "high" ? -1 : 1));
}

/** The six answers, in the owner's language. */
export function problemText(p: BusinessProblem, lang: OwnerLang = "en"): string {
  const T = (w: Words) => (lang === "he" ? w.he : w.en);
  const blocked = p.customerBlocked === "unknown" ? L(lang, "Unknown from BARRY's records.", "לא ידוע מהרשומות של BARRY.") : p.customerBlocked ? L(lang, "Yes.", "כן.") : L(lang, "No.", "לא.");
  return [
    T(p.what),
    `${L(lang, "Affected", "מה מושפע")}: ${T(p.affected)}`,
    `${L(lang, "Customer blocked", "לקוח תקוע")}: ${blocked}`,
    `${L(lang, "Already happened", "מה כבר קרה")}: ${T(p.alreadyHappened)}`,
    `${L(lang, "You need to", "מה אתה צריך לעשות")}: ${p.ownerAction ? T(p.ownerAction) : L(lang, "Nothing right now.", "כלום כרגע.")}`,
    `${L(lang, "Next", "הצעד הבא")}: ${T(p.nextStep)}`,
  ].join("\n");
}

/** Load every input and derive the business's problems (owner workspace, launch gate, acceptance). */
export async function loadBusinessProblems(businessId: string, opts: { conversations?: ConversationState[]; connections?: ConnectionView[]; now?: Date } = {}): Promise<BusinessProblem[]> {
  const now = opts.now ?? new Date();
  const [{ getConversationStore }, { describeBusinessConnections }, { resolveCapabilityProfiles }, { resolveBusinessGraph }, { listJobRuns }, { listPaymentHealthEvents }] = await Promise.all([import("@/lib/state"), import("@/lib/connections/status"), import("@/lib/capabilities"), import("@/lib/business-graph-repository"), import("@/lib/background/runner"), import("@/lib/payments/health")]);
  const safe = async <T,>(f: () => Promise<T>, fallback: T): Promise<T> => f().catch(() => fallback);
  const connections = opts.connections ?? (await safe(async () => describeBusinessConnections(businessId, await resolveCapabilityProfiles(resolveBusinessGraph(businessId))), [] as ConnectionView[]));
  return businessProblems({
    connections,
    jobs: await safe(() => listJobRuns(businessId), [] as JobRecord[]),
    ownerDeliveries: await safe(() => listOwnerDeliveries(businessId), [] as OwnerDeliveryEvidence[]),
    conversations: opts.conversations ?? (await safe(() => getConversationStore().listByBusiness(businessId), [] as ConversationState[])),
    payments: await safe(() => listPaymentHealthEvents(businessId), [] as PaymentHealthEvent[]),
    now,
  });
}
