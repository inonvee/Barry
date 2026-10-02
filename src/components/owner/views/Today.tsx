"use client";

import Link from "next/link";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OwnerReply } from "@/lib/owner/command-service";
import type { OwnerOs } from "@/lib/owner/os-service";
import type { Intervention } from "@/lib/owner/interventions";
import { activeWork, proactiveWords } from "@/lib/owner/control-room";
import { activityTimeline, noticedCard } from "@/lib/owner/os";
import { ownerPresence } from "@/lib/owner/presence-model";
import { hasMoney } from "@/lib/format/money";
import { money, type OwnerLang } from "@/lib/owner/lang";
import { Icon } from "../kit";
import { useOwnerLang } from "../lang";
import { Chip, Group, Lead, Notice, Row, SectionLabel } from "../os-ui";
import { ActivityRow } from "./Activity";
import { DecisionRow } from "./decision";
import { greeting, type Tab } from "./shared";

/**
 * TODAY — "I opened BARRY for 20 seconds and I understand my business." One sentence of state, then a
 * briefing a thumb can scan: what needs you, what BARRY is working on, the money that matters, what
 * BARRY noticed, and what's left before launch — each row opens the surface that holds it. Then the
 * top decisions, a direct line to ask BARRY, and the last few things that happened. Nothing is counted
 * here that the surface behind it doesn't show (active work is the same definition as Work).
 */

/** The command round trip: the SAME owner command service the WhatsApp channel uses. */
export type RunCommand = (body: { text?: string; actionId?: string }) => Promise<OwnerReply>;

/** The story counts, from the canonical definitions (Work shows the same numbers). */
export function todayStory(ws: OwnerWorkspace) {
  const things = activeWork(ws).length;
  const needs = ws.interventions.length;
  return { things, needs };
}

function headline(lang: OwnerLang, needs: number, working: number): string {
  if (lang === "he") return needs ? (needs === 1 ? "דבר אחד מחכה לך." : `${needs} דברים מחכים לך.`) : working ? (working === 1 ? "BARRY עובד על דבר אחד." : `BARRY עובד על ${working} דברים.`) : "הכול בשליטה. BARRY על המשמר.";
  return needs ? `${needs === 1 ? "One thing needs" : `${needs} things need`} you.` : working ? `BARRY is working on ${working === 1 ? "one thing" : `${working} things`}.` : "All clear. BARRY is watching.";
}

export function TodayView({ ws, os, onDecision, onOpen, onTab, onAsk }: { ws: OwnerWorkspace; os?: OwnerOs | null; onDecision: (item: Intervention) => void; onOpen: (conversationId: string) => void; onTab: (t: Tab) => void; onAsk: (q?: string) => void }) {
  const { lang, t } = useOwnerLang();
  const { things, needs } = todayStory(ws);
  const work = activeWork(ws);
  const presence = ownerPresence(ws, new Date(), lang);
  const r = ws.revenue;
  const atRisk = ws.opportunities.summary.atRisk;
  const made = hasMoney(r.direct);
  const noticed = ws.initiatives.length;
  const feed = activityTimeline(ws, 4, lang);
  const ai = ws.health.ai;
  const setup = os?.setup;
  const prompts = [needs ? t("Who needs me?", "מי צריך אותי?") : t("What are you working on?", "על מה אתה עובד?"), t("How much did we make today?", "כמה הרווחנו היום?"), t("What did you notice?", "על מה שמת לב?")];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-1 pt-1" aria-label={t("Your business now", "העסק שלך עכשיו")}>
        <p className="text-[14px] text-o-muted">{greeting(lang)} · <bdi>{ws.business.name}</bdi></p>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-o-ink md:text-[30px]" data-testid="today-headline">{headline(lang, needs, things)}</h1>
        <p className="text-[14.5px] leading-snug text-o-muted">
          {needs
            ? things
              ? t(`Meanwhile BARRY is working on ${things === 1 ? "one thing" : `${things} things`}.`, things === 1 ? "בינתיים BARRY עובד על דבר אחד." : `בינתיים BARRY עובד על ${things} דברים.`)
              : t("Everything else is handled.", "כל השאר בטיפול.")
            : presence.text}
        </p>
      </section>

      {(ai.status === "unavailable" || ai.status === "degraded") && (
        <Notice tone={ai.status === "unavailable" ? "bad" : "warn"}>{ai.status === "unavailable" ? t("BARRY can't understand customers right now — they get a safe reply and nothing is done.", "BARRY לא מצליח להבין לקוחות כרגע — הם מקבלים תשובה בטוחה ושום דבר לא מתבצע.") : t("BARRY had trouble understanding some messages; those weren't acted on.", "BARRY התקשה להבין חלק מההודעות; לא נעשה בהן שימוש.")}</Notice>
      )}

      {/* The briefing: every row opens the surface that holds it. */}
      <Group label={t("Briefing", "תמונת מצב")}>
        <Row testId="brief-needs" lead={<Lead icon="shield" tone={needs ? "warn" : "ok"} />} title={t("Needs you", "צריך אותך")} sub={needs ? ws.interventions[0].title : t("Nothing waits on your decision", "שום דבר לא מחכה להחלטה שלך")} end={needs ? String(needs) : undefined} chip={needs ? undefined : <Chip tone="ok">{t("Clear", "פנוי")}</Chip>} href="/owner?tab=work#needs-you" emphasis={needs > 0} />
        <Row testId="brief-working" lead={<Lead icon="pulse" tone={things ? "info" : "neutral"} />} title={t("In progress", "בעבודה")} sub={things ? work.map((w) => proactiveWords(w.workflow, lang).title).slice(0, 2).join(" · ") : t("Nothing running right now", "שום דבר לא רץ כרגע")} end={things ? String(things) : undefined} href="/owner?tab=work#working" />
        <Row
          testId="brief-money"
          lead={<Lead icon="money" tone={made ? "ok" : hasMoney(atRisk) ? "bad" : "neutral"} />}
          title={t("Money", "כסף")}
          sub={made ? t(`Made ${ws.window.label} — verified by your provider`, `נגבה ${ws.window.label} — אומת מול הספק`) : hasMoney(r.potential) ? t(`Nothing collected yet · ${money(lang, r.potential)} waiting to be paid`, `עוד לא נגבה כלום · ${money(lang, r.potential)} מחכים לתשלום`) : t("Nothing collected yet", "עוד לא נגבה כלום")}
          end={made ? <bdi>{money(lang, r.direct)}</bdi> : undefined}
          chip={hasMoney(atRisk) ? <Chip tone="bad">{t(`${money(lang, atRisk)} at risk`, `${money(lang, atRisk)} בסיכון`)}</Chip> : undefined}
          href="/owner?tab=money"
        />
        {noticed > 0 && <Row testId="brief-noticed" lead={<Lead icon="spark" tone="violet" />} title={t("BARRY noticed", "BARRY שם לב")} sub={ws.initiatives[0] ? noticedCard(ws.initiatives[0], lang).what : undefined} end={String(noticed)} href="/owner?tab=work#noticed" />}
        {setup && !setup.supervisedReady && <Row testId="brief-setup" lead={<Lead icon="check" tone="warn" />} title={t("BARRY setup", "הגדרת BARRY")} sub={setup.headline} href="/owner/setup" />}
      </Group>

      {needs > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel action={needs > 3 ? { label: t(`All ${needs}`, `כל ה־${needs}`), href: "/owner?tab=work#needs-you" } : undefined}>{t("Needs you", "צריך אותך")}</SectionLabel>
          <Group>
            {ws.interventions.slice(0, 3).map((i) => <DecisionRow key={i.id} item={i} onOpen={() => onDecision(i)} />)}
          </Group>
        </section>
      )}

      {/* Ask BARRY — the same command service as WhatsApp */}
      <section className="flex flex-col gap-2" aria-label={t("Ask BARRY", "שאל את BARRY")}>
        <button type="button" onClick={() => onAsk()} className="flex min-h-12 w-full items-center gap-3 rounded-2xl bg-o-surface px-4 text-start text-[15px] text-o-faint ring-1 ring-inset ring-o-line-strong transition hover:ring-o-accent/50" data-testid="ask-entry">
          <Icon name="barry" size={18} className="text-o-accent" />
          {t("Ask BARRY anything…", "לשאול את BARRY…")}
        </button>
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          {prompts.map((p) => (
            <button key={p} type="button" onClick={() => onAsk(p)} className="min-h-9 shrink-0 rounded-full bg-o-sunken px-3.5 text-[13px] text-o-ink-2 ring-1 ring-inset ring-o-line hover:text-o-ink">{p}</button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel action={{ label: t("All activity", "כל הפעילות"), href: "/owner?tab=activity" }}>{t("Just happened", "קרה עכשיו")}</SectionLabel>
        {feed.length ? (
          <Group>{feed.map((f) => <ActivityRow key={f.id} item={f} onOpen={onOpen} lang={lang} />)}</Group>
        ) : (
          <p className="px-1 text-[13.5px] text-o-muted">{t("Payments, follow-ups and decisions appear here as BARRY records them.", "תשלומים, מעקבים והחלטות יופיעו כאן ברגע ש־BARRY רושם אותם.")}</p>
        )}
      </section>
      <p className="px-1 text-[12px] text-o-faint">
        <Link href="/owner?tab=work" onClick={(e) => { e.preventDefault(); onTab("work"); }} className="underline-offset-2 hover:underline">{t("Everything BARRY is doing is in Work.", "כל מה ש־BARRY עושה נמצא ב״עבודה״.")}</Link>
      </p>
    </div>
  );
}
