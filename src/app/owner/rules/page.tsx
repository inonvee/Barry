"use client";

import { useEffect, useState } from "react";
import { OsPage } from "@/components/owner/OsPage";
import { useOwnerLang } from "@/components/owner/lang";
import { Button, Chip, Disclosure, Field, Group, Lead, Notice, Row, SectionLabel, Sheet, type Tone } from "@/components/owner/os-ui";
import type { useOwnerApi } from "@/components/owner/useOwnerApi";
import type { IconName } from "@/components/owner/kit";
import type { Availability, OwnerRule, RuleArea } from "@/lib/owner/os";

/**
 * RULES BARRY FOLLOWS — exactly what BARRY's decisions run on right now: one compact row per rule (what it
 * covers · the rule at a glance), and a sheet with the full sentence, where it came from, and how to change
 * it. Four things are never blurred:
 *   PERMISSION   what the rule allows BARRY to do
 *   CAPABILITY   what your connected systems can actually do (a rule can allow what no system can do yet)
 *   RESTRICTION  limits from the BARRY team, which only ever make BARRY more careful
 *   UNAVAILABLE  a system that isn't connected or isn't working
 * Nothing here loosens anything by itself: a taught rule goes through the reviewed Learn Business path and
 * is used only once BARRY has read it and it's clear.
 */

type Api = ReturnType<typeof useOwnerApi>;

const AREA_ICON: Record<RuleArea, IconName> = { discounts: "spark", payments: "card", refunds: "receipt", bookings: "clock", prices: "money", delivery: "cart", actions: "bolt", followups: "chat", safety: "shield" };
const AVAIL_TONE: Record<Availability, Tone> = { real: "ok", simulated: "warn", not_connected: "neutral", not_used: "neutral" };
const AVAIL_CHIP: Record<Availability, { en: string; he: string }> = { real: { en: "Connected", he: "מחובר" }, simulated: { en: "Simulator", he: "סימולטור" }, not_connected: { en: "No system yet", he: "אין מערכת עדיין" }, not_used: { en: "Not used", he: "לא בשימוש" } };

export default function RulesPage() {
  return (
    <OsPage section="rules" title={{ en: "Rules BARRY follows", he: "הכללים של BARRY" }} sub={{ en: "What BARRY may do on its own, and what comes to you first. Above a limit, BARRY asks you.", he: "מה BARRY רשאי לעשות לבד, ומה מגיע אליך קודם. מעבר לגבול — BARRY שואל אותך." }}>
      {(os, api, reload) => <Rules os={os} api={api} reload={reload} />}
    </OsPage>
  );
}

function Rules({ os, api, reload }: { os: Parameters<Parameters<typeof OsPage>[0]["children"]>[0]; api: Api; reload: () => void }) {
  const { lang, t } = useOwnerLang();
  const [open, setOpen] = useState<OwnerRule | null>(null);
  const [teach, setTeach] = useState<string | null>(null);
  // A rule typed on WhatsApp or in Ask ("Don't offer more than 5% today") arrives as ?rule=… and is taught
  // through the same reviewed path — the owner sees it before BARRY reads it.
  useEffect(() => {
    const rule = new URLSearchParams(window.location.search).get("rule")?.trim();
    if (!rule) return;
    const t0 = setTimeout(() => setTeach(rule.slice(0, 1000)), 0);
    return () => clearTimeout(t0);
  }, []);
  const founder = os.rules.rules.filter((r) => r.source === "founder");
  const yours = os.rules.rules.filter((r) => r.source === "owner" || r.source === "profile");
  const builtIn = os.rules.rules.filter((r) => r.source === "built_in");
  const row = (r: OwnerRule) => (
    <Row
      key={r.id}
      testId="rule-row"
      id={r.id}
      lead={<Lead icon={r.source === "founder" ? "lock" : AREA_ICON[r.area]} tone={r.source === "founder" ? "warn" : r.state !== "active" ? "warn" : "neutral"} />}
      title={r.title}
      sub={r.summary}
      chip={r.availability && r.availability.state !== "real" ? <Chip tone={AVAIL_TONE[r.availability.state]}>{AVAIL_CHIP[r.availability.state][lang]}</Chip> : r.state !== "active" ? <Chip tone="warn">{r.state === "replaced" ? t("Replaced", "הוחלף") : t("Needs you", "צריך אותך")}</Chip> : undefined}
      onClick={() => setOpen(r)}
    />
  );
  return (
    <>
      {founder.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>{t("From the BARRY team", "מצוות BARRY")}</SectionLabel>
          <Group>{founder.map(row)}</Group>
          <p className="px-1 text-[12.5px] text-o-muted">{t("These only ever make BARRY more careful, never less.", "אלה רק הופכים את BARRY לזהיר יותר, אף פעם לא פחות.")}</p>
        </section>
      )}
      {os.rules.pending.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>{t("Taught — not in use yet", "לימדת — עוד לא בשימוש")}</SectionLabel>
          <Group>{os.rules.pending.map(row)}</Group>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <SectionLabel action={{ label: t("Teach a rule", "ללמד כלל"), onClick: () => setTeach("") }}>{t("Your rules", "הכללים שלך")}</SectionLabel>
        <Group>{yours.map(row)}</Group>
      </section>
      <section className="flex flex-col gap-2">
        <SectionLabel>{t("Built into BARRY", "מובנה ב־BARRY")}</SectionLabel>
        <Group>{builtIn.map(row)}</Group>
      </section>
      <div className="o-group px-4">
        <Disclosure summary={t("Not supported yet", "עוד לא נתמך")}>
          <ul className="flex flex-col gap-1.5 text-[13.5px] leading-5 text-o-ink-2">
            {os.rules.notSupported.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </Disclosure>
      </div>

      {open && <RuleSheet r={open} onClose={() => setOpen(null)} onTeach={(seed) => { setOpen(null); setTeach(seed); }} />}
      {teach !== null && <TeachRuleSheet api={api} seed={teach} onClose={() => setTeach(null)} onDone={reload} />}
    </>
  );
}

function RuleSheet({ r, onClose, onTeach }: { r: OwnerRule; onClose: () => void; onTeach: (seed: string) => void }) {
  const { lang, t } = useOwnerLang();
  return (
    <Sheet
      open
      onClose={onClose}
      title={r.title}
      testId="rule-sheet"
      footer={r.change === "teach" ? <Button kind="primary" full onClick={() => onTeach(lang === "he" ? `${r.title}: ` : `${r.title}: `)} testId="rule-change">{t("Change this rule", "לשנות את הכלל")}</Button> : undefined}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[16px] leading-7 text-o-ink"><bdi>{r.words}</bdi></p>
        {r.question && <Notice tone="warn">{r.question}</Notice>}
        <dl className="flex flex-col gap-3">
          <Field label={t("What the rule allows", "מה הכלל מתיר")}>{r.summary}</Field>
          {r.availability && <Field label={t("What your systems can do", "מה המערכות שלך יכולות")}><span className="flex flex-wrap items-center gap-2"><Chip tone={AVAIL_TONE[r.availability.state]}>{AVAIL_CHIP[r.availability.state][lang]}</Chip><span>{r.availability.words}</span></span></Field>}
          <Field label={t("Where it came from", "מאיפה זה הגיע")}>{r.sourceWords}</Field>
          <Field label={t("Changing it", "שינוי")}>{r.changeWords}</Field>
        </dl>
      </div>
    </Sheet>
  );
}

/** Teach a rule in the owner's own words — BARRY reads it through the reviewed path; nothing changes until it's clear. */
function TeachRuleSheet({ api, seed, onClose, onDone }: { api: Api; seed: string; onClose: () => void; onDone: () => void }) {
  const { t } = useOwnerLang();
  const [text, setText] = useState(seed);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    setBusy(true);
    try {
      await api.call("/api/learnbusiness/sources", { body: { businessId: api.businessId, type: "document", name: t("Rule from the owner", "כלל מבעל העסק"), text: text.trim(), approved: true } });
      setResult({ ok: true, text: t("BARRY read it. If it's clear it's in force now — otherwise it waits under “Taught — not in use yet” with one question for you.", "BARRY קרא את זה. אם זה ברור — זה בתוקף עכשיו; אחרת זה מחכה תחת ״לימדת — עוד לא בשימוש״ עם שאלה אחת אליך.") });
      onDone();
    } catch (e) {
      setResult({ ok: false, text: t(`BARRY didn't save that — nothing changed. (${e instanceof Error ? e.message : "error"})`, `BARRY לא שמר את זה — שום דבר לא השתנה. (${e instanceof Error ? e.message : "error"})`) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={t("Teach BARRY a rule", "ללמד את BARRY כלל")} testId="teach-rule" footer={result?.ok ? <Button full onClick={onClose}>{t("Done", "סיום")}</Button> : <Button kind="primary" full disabled={busy || !text.trim()} onClick={() => void send()} testId="teach-rule-send">{t("Let BARRY read it", "ש־BARRY יקרא")}</Button>}>
      <div className="flex flex-col gap-3">
        <p className="text-[14px] leading-6 text-o-muted">{t("Write it like you'd tell a new employee — “Up to 5% discount without asking me”. BARRY shows how it applies it, and never goes above its own built-in ceiling.", "כתוב את זה כמו שהיית אומר לעובד חדש — ״עד 5% הנחה בלי לשאול אותי״. BARRY יראה איך הוא מיישם את זה, ולעולם לא יעבור את התקרה המובנית שלו.")}</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} dir="auto" aria-label={t("The rule, in your words", "הכלל, במילים שלך")} placeholder={t("The rule, in your words", "הכלל, במילים שלך")} className="min-h-28 w-full rounded-xl bg-o-surface px-4 py-3 text-[16px] leading-6 text-o-ink ring-1 ring-inset ring-o-line-strong placeholder:text-o-faint focus:outline-none focus:ring-2 focus:ring-o-accent" />
        {result && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
      </div>
    </Sheet>
  );
}
