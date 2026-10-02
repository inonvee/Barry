"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell } from "@/components/owner/OwnerShell";
import { useOwnerLang } from "@/components/owner/lang";
import { Button, Chip, Disclosure, ErrorState, Field, Group, Lead, LoadingRows, Notice, PageHeader, Row, SectionLabel } from "@/components/owner/os-ui";
import { amount, money } from "@/lib/owner/lang";
import type { OwnerPlanView } from "@/lib/commercial/service";

/**
 * PLAN & BILLING — what the owner pays for, what BARRY did for them this month (verified records only), and
 * what an upgrade would unlock. Owner words; never BARRY's internal cost, margin or provider economics.
 * Asking about an upgrade is a request to the BARRY team — the plan and billing change only when the owner
 * agrees it with them. Nothing on this page moves money.
 */
function PlanPage() {
  const api = useOwnerApi();
  const { lang, t } = useOwnerLang();
  const { businessId, call, authorized } = api;
  const [view, setView] = useState<OwnerPlanView | null>(null);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const load = useCallback(() => {
    if (!businessId || !authorized) return;
    call<OwnerPlanView>(`/api/owner/plan?businessId=${encodeURIComponent(businessId)}&lang=${lang}`)
      .then((v) => {
        setView(v);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [businessId, call, authorized, lang]);
  useEffect(() => load(), [load]);
  const ask = async (plan?: string) => {
    try {
      const r = await call<{ note: string }>(`/api/owner/plan?lang=${lang}`, { body: { businessId, ...(plan ? { plan } : {}), message: plan ? `Interested in ${plan}` : "Please contact me about my plan" } });
      setSent(r.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };
  const v = view?.value;
  const p = view?.plan;
  return (
    <OwnerShell api={api} active="plan">
      <div className="flex flex-col gap-6">
        <PageHeader back={{ href: "/owner?tab=more", label: t("More", "עוד") }} title={t("Plan & billing", "תוכנית וחיוב")} sub={t("A fixed monthly price — no share of your revenue or savings.", "מחיר חודשי קבוע — בלי אחוז מההכנסות או מהחיסכון שלך.")} />
        {authorized && error && <ErrorState title={t("Couldn't load your plan", "לא הצלחנו לטעון את התוכנית")} detail={error} onRetry={load} />}
        {authorized && !view && !error && <LoadingRows rows={4} />}
        {view && (
          <>
            <section className="flex flex-col gap-2">
              <SectionLabel>{t("Your plan", "התוכנית שלך")}</SectionLabel>
              {p ? (
                <div className="o-card flex flex-col gap-3 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[18px] font-semibold text-o-ink">{p.name}</p>
                      <p className="text-[14px] text-o-ink-2">{p.promise}</p>
                    </div>
                    <p className="o-tabular shrink-0 text-end text-[18px] font-semibold text-o-ink"><bdi>{amount(lang, p.monthlyPrice, p.currency)}</bdi><span className="block text-[12px] font-normal text-o-muted">{t("per month", "לחודש")}</span></p>
                  </div>
                  <dl className="flex flex-col gap-2">
                    <Field label={t("Subscription", "מנוי")}>
                      {view.subscription.state}
                      {view.subscription.freeMonth ? t(` · free month, day ${view.subscription.freeMonth.day} of 30`, ` · חודש חינם, יום ${view.subscription.freeMonth.day} מתוך 30`) : ""}
                    </Field>
                    {p.priceLockedUntil && <Field label={t("Founding price", "מחיר מייסדים")}>{t(`Locked until ${p.priceLockedUntil.slice(0, 10)}`, `נעול עד ${p.priceLockedUntil.slice(0, 10)}`)}</Field>}
                  </dl>
                </div>
              ) : (
                <Notice tone="neutral" action={<Button kind="quiet" onClick={() => void ask()}>{t("Talk to us", "לדבר איתנו")}</Button>}>{t("No plan is set up yet — the BARRY team sets it up with you.", "עוד לא הוגדרה תוכנית — צוות BARRY מגדיר אותה איתך.")}</Notice>
              )}
            </section>

            {v && (
              <section className="flex flex-col gap-2">
                <SectionLabel>{t(`This month · ${v.period}`, `החודש · ${v.period}`)}</SectionLabel>
                <Group>
                  <Row lead={<Lead icon="barry" tone="info" />} title={t("Conversations handled", "שיחות שטופלו")} sub={v.outcomes ? t(`${v.outcomes} with a verified outcome`, `${v.outcomes} עם תוצאה מאומתת`) : undefined} end={String(v.handled)} />
                  <Row lead={<Lead icon="money" tone="ok" />} title={t("Generated", "נוצר")} sub={t(`Recovered: ${money(lang, v.recovered, "—")}`, `הוחזר: ${money(lang, v.recovered, "—")}`)} end={<bdi>{money(lang, v.generated)}</bdi>} />
                  <Row lead={<Lead icon="spark" tone="violet" />} title={t("Saved (realised)", "נחסך (בפועל)")} sub={v.savedNote ?? t("Only evidence-backed savings", "רק חיסכון עם ראיות")} end={<bdi>{money(lang, v.savedRealized)}</bdi>} />
                  <Row lead={<Lead icon="shield" tone={v.needsYou ? "warn" : "neutral"} />} title={t("Needed you", "היה צריך אותך")} end={String(v.needsYou)} />
                </Group>
                <p className="px-1 text-[12.5px] text-o-muted">{t("Counted only from verified records — test money, pending payments and estimates never count.", "נספר רק מרשומות מאומתות — כסף של בדיקות, תשלומים ממתינים והערכות אף פעם לא נספרים.")}</p>
              </section>
            )}

            {view.canDo.length > 0 && (
              <div className="o-group px-4">
                <Disclosure summary={t(`What your plan includes (${view.canDo.length})`, `מה כלול בתוכנית (${view.canDo.length})`)}>
                  <ul className="flex flex-col gap-1.5 pb-2 text-[14px] text-o-ink-2">{view.canDo.map((c) => <li key={c}>{c}</li>)}</ul>
                </Disclosure>
                {view.planLocked.length > 0 && (
                  <Disclosure summary={t(`Not in your plan (${view.planLocked.length})`, `לא כלול בתוכנית (${view.planLocked.length})`)}>
                    <ul className="flex flex-col gap-1.5 pb-2 text-[14px] text-o-muted">{view.planLocked.map((x) => <li key={x.feature}>{x.feature} — {t("with", "עם")} {x.unlockedBy}</li>)}</ul>
                  </Disclosure>
                )}
              </div>
            )}

            {view.upgrades.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionLabel>{t("More BARRY can do", "עוד מה ש־BARRY יכול")}</SectionLabel>
                <Group>
                  {view.upgrades.map((u) => <Row key={u.id} lead={<Lead icon="spark" />} title={u.name} sub={u.unlocks.slice(0, 3).join(" · ")} end={<bdi>{amount(lang, u.monthlyPrice, u.currency)}</bdi>} chip={<Chip>{t("Ask", "לשאול")}</Chip>} onClick={() => void ask(u.id)} />)}
                </Group>
                <p className="px-1 text-[12.5px] text-o-muted">{t("Tapping a plan only asks the BARRY team to contact you — nothing changes until you agree it with them.", "לחיצה על תוכנית רק מבקשת מצוות BARRY ליצור קשר — שום דבר לא משתנה עד שתסכים איתם.")}</p>
              </section>
            )}
            {sent && <Notice tone="ok">{sent}</Notice>}
          </>
        )}
      </div>
    </OwnerShell>
  );
}

export default function OwnerPlanPage() {
  return (
    <Suspense fallback={<div className="barry-owner min-h-screen" />}>
      <PlanPage />
    </Suspense>
  );
}
