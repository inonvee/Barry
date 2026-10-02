import {
  CalendarClockIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ClockIcon,
  EyeIcon,
  MessageCircleQuestionIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SendIcon,
  ShoppingCartIcon,
  UserRoundIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import type { OwnerWorkspace, OwnerApproval } from "@/lib/owner/service";
import type { Intervention } from "@/lib/owner/interventions";
import type { InitiativeView } from "@/lib/initiative/model";
import type { Money } from "@/lib/owner/revenue";
import { activeWork, proactiveWords, workflows, type ActiveWork } from "@/lib/owner/control-room";
import { noticedCard } from "@/lib/owner/os";
import { LIFECYCLE } from "@/components/owner/views/shared";
import { INTERVENTION_KIND } from "@/components/owner/views/shared";
import type { OwnerLang } from "@/lib/owner/lang";
import type { Tone } from "@/components/app-shell/kit";

/**
 * The next owner UI's view model: one row shape for everything Work shows, derived only from the workspace
 * (the same read model the current UI and Owner WhatsApp use). No numbers are made up here.
 */

export type T = (en: string, he: string) => string;
export type Stand = "you" | "running" | "customer" | "noticed" | "done";

export const STAND: Record<Stand, { tone: Tone; label: [string, string] }> = {
  you: { tone: "hot", label: ["Needs you", "מחכה לך"] },
  running: { tone: "live", label: ["Running", "רץ"] },
  customer: { tone: "info", label: ["Waiting on customer", "מחכה ללקוח"] },
  noticed: { tone: "plum", label: ["Noticed", "שם לב"] },
  done: { tone: "muted", label: ["Completed", "הסתיים"] },
};

export const KIND_ICON: Record<Intervention["kind"], LucideIcon> = {
  approval: ShieldCheckIcon,
  held_approval: ClockIcon,
  handoff: UserRoundIcon,
  failed_action: CircleAlertIcon,
  blocked_write: ShoppingCartIcon,
  not_understood: MessageCircleQuestionIcon,
  delivery_failed: SendIcon,
};
export const WORK_ICON: Record<string, LucideIcon> = {
  unpaid_payment_followup: ReceiptIcon,
  abandoned_checkout_recovery: ShoppingCartIcon,
  booking_deposit_missing: WalletIcon,
  appointment_reminder: CalendarClockIcon,
  failed_action_recovery: RotateCcwIcon,
};

export type Opened =
  | { kind: "decision"; item: Intervention }
  | { kind: "work"; item: ActiveWork }
  | { kind: "noticed"; item: InitiativeView }
  | { kind: "approval"; item: OwnerApproval }
  | { kind: "finished"; item: OwnerWorkspace["ownerOperations"][number] };

export type Row = {
  key: string;
  stand: Stand;
  /** Status word shown on the pill (defaults to the stand's). */
  status?: string;
  title: string;
  /** Who / what — customer and context, one line. */
  context?: string;
  amount?: string;
  at?: string;
  icon: LucideIcon;
  /** A real image for the row when the record carries one (none today: product images aren't in the read model). */
  image?: string | null;
  person?: string;
  progress?: { value: number; max: number };
  open: Opened;
};

/** Live progress of one piece of BARRY's work, from its real counts. */
export function workProgress(ws: OwnerWorkspace, w: ActiveWork, lang: OwnerLang, t: T) {
  const op = w.operationId ? ws.ownerOperations.find((o) => o.id === w.operationId) : undefined;
  const flow = workflows(ws, lang).find((f) => f.kind === w.workflow);
  const items = ws.obligations.filter((o) => o.kind === w.workflow);
  const lastAttempt = items.map((o) => o.lastAttemptAt).filter((x): x is string => Boolean(x)).sort().at(-1);
  const since = op ? op.createdAt : items.map((o) => o.createdAt).sort()[0];
  const found = op ? op.progress.cohort : (flow?.open ?? w.customers) + (flow?.closed ?? 0);
  const reached = op ? op.progress.contacted : flow?.contacted ?? 0;
  const steps = op
    ? [
        { label: t("In scope", "בטווח"), n: op.progress.cohort },
        { label: t("Reached", "קיבלו פנייה"), n: op.progress.contacted },
        { label: t("Replied", "ענו"), n: op.progress.replied },
        { label: t("Bought", "קנו"), n: op.progress.purchased },
      ]
    : [
        { label: t("Found", "נמצאו"), n: flow?.open ?? w.customers },
        { label: t("Reached", "קיבלו פנייה"), n: flow?.contacted ?? 0 },
        { label: t("Waiting on the customer", "מחכים ללקוח"), n: flow?.waiting ?? 0 },
        { label: flow?.closedLabel ?? t("Done", "הושלם"), n: flow?.closed ?? 0 },
      ];
  const line = reached ? t(`${reached} of ${found} reached`, `${reached} מתוך ${found} קיבלו פנייה`) : t(`${found} found · nothing sent yet`, `${found} נמצאו · עוד לא נשלח כלום`);
  return { op, flow, found, reached, steps, line, since, lastAttempt, title: proactiveWords(w.workflow, lang).title, command: proactiveWords(w.workflow, lang).command };
}

export function buildRows(ws: OwnerWorkspace, lang: OwnerLang, t: T) {
  const needs: Row[] = ws.interventions.map((i) => ({
    key: i.id,
    stand: "you",
    status: INTERVENTION_KIND[i.kind].label[lang],
    title: i.title,
    context: i.title.includes(i.customer) ? i.decision : `${i.customer} · ${i.decision}`,
    amount: i.amount,
    at: i.since,
    icon: KIND_ICON[i.kind],
    person: i.kind === "handoff" ? i.customer : undefined,
    open: { kind: "decision", item: i },
  }));
  const progress: Row[] = activeWork(ws).map((w) => {
    const p = workProgress(ws, w, lang, t);
    const running = w.state === "working";
    return {
      key: w.id,
      stand: running ? "running" : "customer",
      title: p.title,
      context: `${w.kind === "operation" ? t("You asked", "ביקשת") : t("Your follow-up rule", "כלל המעקב שלך")} · ${p.line}`,
      at: p.lastAttempt ?? p.since,
      icon: WORK_ICON[w.workflow] ?? RotateCcwIcon,
      progress: { value: p.reached, max: p.found },
      open: { kind: "work", item: w },
    } satisfies Row;
  });
  const noticed: Row[] = ws.initiatives.map((i) => {
    const c = noticedCard(i, lang);
    return { key: i.id, stand: "noticed", status: c.stateWords, title: c.what, context: c.importance, amount: c.money || undefined, at: i.provenance.detectedAt, icon: EyeIcon, open: { kind: "noticed", item: i } };
  });
  const done: Row[] = [
    ...ws.approvals
      .filter((a) => !(a.actionable || a.lifecycle === "held"))
      .slice(0, 12)
      .map((a): Row => ({ key: `ap:${a.id}`, stand: "done", status: (LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved).label[lang], title: a.what, context: a.customer, amount: a.amount, at: a.createdAt, icon: CheckCircle2Icon, person: a.customer, open: { kind: "approval", item: a } })),
    ...ws.ownerOperations
      .filter((o) => o.derivedState === "completed" || o.derivedState === "stopped" || o.derivedState === "blocked" || o.derivedState === "failed")
      .slice(0, 6)
      .map((o): Row => ({
        key: `op:${o.id}`,
        stand: "done",
        status: o.derivedState === "stopped" ? t("Stopped", "נעצר") : o.derivedState === "completed" ? t("Completed", "הושלם") : t("Didn't finish", "לא הסתיים"),
        title: proactiveWords(o.workflow, lang).title,
        context: t(`${o.progress.contacted} reached · ${o.progress.purchased} bought`, `${o.progress.contacted} קיבלו פנייה · ${o.progress.purchased} קנו`),
        at: o.stoppedAt ?? o.updatedAt,
        icon: WORK_ICON[o.workflow] ?? CheckCircle2Icon,
        open: { kind: "finished", item: o },
      })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return { needs, progress, noticed, done };
}

export function ageOf(lang: OwnerLang, iso: string | undefined, now: number) {
  if (!iso) return "";
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (m < 1) return lang === "he" ? "עכשיו" : "now";
  if (m < 60) return lang === "he" ? `${m} דק׳` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return lang === "he" ? `${h} שע׳` : `${h}h`;
  return lang === "he" ? `${Math.floor(h / 24)} ימ׳` : `${Math.floor(h / 24)}d`;
}

export function clockOf(lang: OwnerLang, tz: string, iso: string, now: number) {
  const d = new Date(iso);
  const loc = lang === "he" ? "he-IL" : "en-GB";
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(x);
  const time = new Intl.DateTimeFormat(loc, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  if (day(d) === day(new Date(now))) return time;
  if (day(d) === day(new Date(now - 864e5))) return `${lang === "he" ? "אתמול" : "Yesterday"} ${time}`;
  return `${new Intl.DateTimeFormat(loc, { timeZone: tz, day: "numeric", month: "short" }).format(d)} ${time}`;
}

export const sumMoney = (a: Money, b: Money): Money => {
  const out: Money = { ...a };
  for (const [c, v] of Object.entries(b)) out[c] = Math.round(((out[c] ?? 0) + v) * 100) / 100;
  return out;
};

/** The currency the business mostly deals in (from its own money records) — never invented. */
export function mainCurrency(maps: Money[], fallback?: string | null): string {
  if (fallback) return fallback;
  const n: Record<string, number> = {};
  for (const m of maps) for (const k of Object.keys(m ?? {})) n[k] = (n[k] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ILS";
}

/** Greeting by the business's local hour. */
export function greeting(tz: string, now: number, t: T) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));
  return h < 5 ? t("Good evening", "ערב טוב") : h < 12 ? t("Good morning", "בוקר טוב") : h < 18 ? t("Good afternoon", "צהריים טובים") : t("Good evening", "ערב טוב");
}
