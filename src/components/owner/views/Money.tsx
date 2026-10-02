"use client";

import { useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { Opportunity } from "@/lib/owner/opportunities";
import { isAtRisk } from "@/lib/owner/opportunity-risk";
import { financialImpact } from "@/lib/finance/impact";
import { hasMoney } from "@/lib/format/money";
import { ago, amount, money, type OwnerLang } from "@/lib/owner/lang";
import { useOwnerLang } from "../lang";
import { Chip, Empty, Group, Lead, PageHeader, Row, Segments, SectionLabel, Sheet, type Tone } from "../os-ui";

/**
 * MONEY — four states that never blur, scannable in seconds:
 *   MADE        paid and verified by your payment provider (the only revenue)
 *   IN MOTION   unpaid links and requests — not revenue yet
 *   AT RISK     likely lost unless someone acts (the same rule as the figure)
 *   SAVED       realised savings only, from connected cost records (never estimated)
 * Each amount stays in its own currency; test money is shown apart and never counted. Every figure opens
 * the records behind it.
 */

type Range = "today" | "7d" | "30d";
type Open = "made" | "motion" | "risk" | null;

const OPP: Record<Opportunity["kind"], Record<OwnerLang, string>> = {
  unpaid_link: { en: "Payment link not paid", he: "קישור תשלום שלא שולם" },
  approval_blocking_sale: { en: "Sale waiting on your approval", he: "מכירה שמחכה לאישורך" },
  held_blocking_sale: { en: "Sale held — re-check", he: "מכירה מוחזקת — לבדוק" },
  stalled_purchase: { en: "Purchase stalled", he: "רכישה נתקעה" },
  payment_failed: { en: "Payment failed", he: "תשלום נכשל" },
  unpaid_deposit: { en: "Deposit not paid", he: "מקדמה לא שולמה" },
  enquiry_open: { en: "Open enquiry", he: "פנייה פתוחה" },
  blocked_by_limit: { en: "Stopped by the customer's limits", he: "נעצר לפי מגבלות הלקוח" },
};
const WHO: Record<Opportunity["next"]["who"], { tone: Tone; label: Record<OwnerLang, string> }> = {
  you: { tone: "warn", label: { en: "Your move", he: "התור שלך" } },
  customer: { tone: "neutral", label: { en: "Customer's move", he: "התור של הלקוח" } },
  barry: { tone: "info", label: { en: "BARRY's move", he: "התור של BARRY" } },
};

export function MoneyView({ ws, range, setRange, onOpen }: { ws: OwnerWorkspace; range: Range; setRange: (r: Range) => void; onOpen: (conversationId: string) => void }) {
  const { lang, t } = useOwnerLang();
  const [open, setOpen] = useState<Open>(null);
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const real = ws.opportunities.items.filter((o) => !o.simulated);
  const margins = !ws.plan?.name || ws.plan.marginsIncluded;
  const impact = financialImpact(r, []);
  const testMoney = hasMoney(r.simulatedPaid) || r.potentialSimulatedItems > 0;
  const evidence = (cats: OwnerWorkspace["revenueEvidence"][number]["category"][]) => ws.revenueEvidence.filter((e) => cats.includes(e.category) && !e.simulated);
  const motion = { ...s.waitingOnCustomer };
  for (const [c, v] of Object.entries(s.stuckWithYou)) motion[c] = Math.round(((motion[c] ?? 0) + v) * 100) / 100;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("Money", "כסף")} sub={t("Only payments your provider verified count as made. Each currency stays on its own.", "רק תשלום שהספק אימת נחשב שנגבה. כל מטבע מוצג בנפרד.")} />
      <Segments<Range> ariaLabel={t("Period", "תקופה")} value={range} onChange={setRange} options={[{ id: "today", label: t("Today", "היום") }, { id: "7d", label: t("7 days", "7 ימים") }, { id: "30d", label: t("30 days", "30 ימים") }]} />

      <section className="flex flex-col gap-1 px-1" aria-label={t("Made", "נגבה")}>
        <p className="text-[13px] font-medium text-o-muted">{t(`Made ${ws.window.label}`, `נגבה ${ws.window.label}`)}</p>
        <p className="o-tabular text-[38px] font-semibold leading-none tracking-tight text-o-ink" data-testid="money-made"><bdi>{money(lang, r.direct)}</bdi></p>
        <p className="text-[13.5px] text-o-muted">{r.directPayments ? t(`${r.directPayments} payment${r.directPayments === 1 ? "" : "s"} verified by your provider`, r.directPayments === 1 ? "תשלום אחד אומת מול הספק" : `${r.directPayments} תשלומים אומתו מול הספק`) : t("No verified payments in this period yet.", "עוד אין תשלומים מאומתים בתקופה הזאת.")}</p>
      </section>

      <Group label={t("Money states", "מצבי הכסף")}>
        <Row testId="money-row-made" lead={<Lead icon="check" tone="ok" />} title={t("Made", "נגבה")} sub={t("Paid and verified by your provider", "שולם ואומת מול הספק")} end={<bdi>{money(lang, r.direct)}</bdi>} endSub={hasMoney(r.recovered) ? t(`${money(lang, r.recovered)} recovered`, `${money(lang, r.recovered)} הוחזרו`) : undefined} onClick={() => setOpen("made")} />
        <Row testId="money-row-motion" lead={<Lead icon="clock" tone="info" />} title={t("In motion", "בתנועה")} sub={t("Unpaid links and requests — not revenue yet", "קישורים ובקשות שלא שולמו — עוד לא הכנסה")} end={<bdi>{money(lang, motion)}</bdi>} endSub={hasMoney(s.stuckWithYou) ? t(`${money(lang, s.stuckWithYou)} waits on you`, `${money(lang, s.stuckWithYou)} מחכה לך`) : undefined} onClick={() => setOpen("motion")} />
        <Row testId="money-row-risk" lead={<Lead icon="alert" tone={hasMoney(s.atRisk) ? "bad" : "neutral"} />} title={t("At risk", "בסיכון")} sub={hasMoney(s.atRisk) ? t("Likely lost unless someone acts", "עלול ללכת לאיבוד אם אף אחד לא יפעל") : t("Nothing at risk", "אין כסף בסיכון")} end={<bdi>{money(lang, s.atRisk)}</bdi>} onClick={() => setOpen("risk")} />
        {margins ? (
          <Row testId="money-row-saved" lead={<Lead icon="spark" tone="violet" />} title={t("Saved", "נחסך")} sub={impact.evidenceCount === 0 ? t("Needs connected cost records — BARRY never estimates a saving", "צריך רשומות עלות מחוברות — BARRY לא מעריך חיסכון") : t("Realised savings only", "רק חיסכון שמומש בפועל")} end={<bdi>{money(lang, impact.saved.realized)}</bdi>} />
        ) : (
          <Row testId="money-row-saved" lead={<Lead icon="lock" tone="neutral" />} title={t("Saved", "נחסך")} sub={t(`Cost savings aren't in your ${ws.plan.name} plan`, `חיסכון בעלויות לא כלול בתוכנית ${ws.plan.name}`)} href="/owner/plan" />
        )}
      </Group>

      {testMoney && (
        <p className="px-1 text-[13px] leading-5 text-o-muted" data-testid="money-test">
          {t("Test money (simulator, never counted):", "כסף של בדיקות (סימולטור, לא נספר):")} <bdi>{money(lang, r.simulatedPaid, t("none paid", "לא שולם"))}</bdi>
          {r.potentialSimulatedItems ? t(` · ${money(lang, r.potentialSimulated)} pending`, ` · ${money(lang, r.potentialSimulated)} ממתין`) : ""}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <SectionLabel>{t("Where money is moving", "איפה הכסף זז")}</SectionLabel>
        {real.length ? (
          <Group>
            {real.slice(0, 6).map((o) => <OppRow key={o.id} o={o} onOpen={onOpen} lang={lang} />)}
          </Group>
        ) : (
          <Empty title={t("Nothing waiting", "שום דבר לא מחכה")}>{t("Unpaid links, stalled purchases and sales waiting on you show up here, with whose move it is.", "קישורים שלא שולמו, רכישות שנתקעו ומכירות שמחכות לך יופיעו כאן — עם מי שהתור שלו.")}</Empty>
        )}
      </section>

      <Sheet open={open === "made"} onClose={() => setOpen(null)} title={t("Made — verified payments", "נגבה — תשלומים מאומתים")}>
        <EvidenceList rows={evidence(["collected", "recovered"])} onOpen={onOpen} empty={t("No verified payments in this period.", "אין תשלומים מאומתים בתקופה הזאת.")} />
        <p className="mt-3 text-[13px] text-o-muted">{t("Recovered payments are already inside Made — never added twice.", "תשלומים שהוחזרו כבר כלולים בנגבה — אף פעם לא נספרים פעמיים.")}</p>
      </Sheet>
      <Sheet open={open === "motion"} onClose={() => setOpen(null)} title={t("In motion — not revenue yet", "בתנועה — עוד לא הכנסה")}>
        {real.length ? <div className="o-group">{real.map((o) => <OppRow key={o.id} o={o} onOpen={onOpen} lang={lang} />)}</div> : <p className="text-[14px] text-o-muted">{t("Nothing in motion.", "אין כסף בתנועה.")}</p>}
      </Sheet>
      <Sheet open={open === "risk"} onClose={() => setOpen(null)} title={t("At risk", "בסיכון")}>
        {real.filter(isAtRisk).length ? <div className="o-group">{real.filter(isAtRisk).map((o) => <OppRow key={o.id} o={o} onOpen={onOpen} lang={lang} />)}</div> : <p className="text-[14px] text-o-muted">{t("Nothing at risk right now.", "אין כרגע כסף בסיכון.")}</p>}
        <p className="mt-3 text-[13px] text-o-muted">{t("Failed payments, stalled purchases and unpaid links that can still be won back. Not lost yet — and never counted as revenue.", "תשלומים שנכשלו, רכישות שנתקעו וקישורים שלא שולמו ושעוד אפשר להחזיר. עוד לא אבודים — ואף פעם לא נספרים כהכנסה.")}</p>
      </Sheet>
    </div>
  );
}

function OppRow({ o, onOpen, lang }: { o: Opportunity; onOpen: (id: string) => void; lang: OwnerLang }) {
  const w = WHO[o.next.who];
  return <Row title={o.customer} sub={`${OPP[o.kind][lang]} · ${ago(lang, o.since)}`} end={o.amount !== undefined && o.currency ? <bdi>{amount(lang, o.amount, o.currency)}</bdi> : undefined} chip={<Chip tone={w.tone}>{w.label[lang]}</Chip>} onClick={() => onOpen(o.conversationId)} />;
}

function EvidenceList({ rows, onOpen, empty }: { rows: OwnerWorkspace["revenueEvidence"]; onOpen: (id: string) => void; empty: string }) {
  const { lang } = useOwnerLang();
  if (!rows.length) return <p className="text-[14px] text-o-muted">{empty}</p>;
  return (
    <div className="o-group">
      {rows.map((x, i) => <Row key={i} title={x.customer ?? "—"} sub={ago(lang, x.at)} end={<bdi>{amount(lang, x.amount, x.currency)}</bdi>} onClick={() => onOpen(x.conversationId)} />)}
    </div>
  );
}
