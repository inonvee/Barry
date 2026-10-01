"use client";

import { useCallback, useEffect, useState } from "react";
import type { useOwnerApi } from "./useOwnerApi";
import { Section, Skeleton, StateNotice, btn } from "./ui";
import { Pill } from "./ui";
import { BigMetric } from "./kit";
import { moneyWords } from "@/lib/format/money";
import type { OwnerPlanView } from "@/lib/commercial/service";

type Api = ReturnType<typeof useOwnerApi>;

/**
 * THE OWNER'S PLAN + VALUE — what you pay for, what BARRY did for you this month, and what an upgrade
 * would unlock. Owner words; no BARRY internal cost, margin or provider economics. Upgrading is a
 * request to the BARRY team — the plan changes only when you agree it with them.
 */
export function PlanAndValue({ api }: { api: Api }) {
  const { businessId, call, authorized } = api;
  const [view, setView] = useState<OwnerPlanView | null>(null);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const load = useCallback(() => {
    if (!businessId || !authorized) return;
    call<OwnerPlanView>(`/api/owner/plan?businessId=${encodeURIComponent(businessId)}`)
      .then((v) => {
        setView(v);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [businessId, call, authorized]);
  useEffect(() => load(), [load]);
  const ask = async (plan?: string) => {
    try {
      const r = await call<{ note: string }>("/api/owner/plan", { body: { businessId, ...(plan ? { plan } : {}), message: plan ? `Interested in ${plan}` : "Please contact me about my plan" } });
      setSent(r.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };
  if (!authorized) return null;
  if (error) return <StateNotice tone="bad" title="Couldn't load your plan">{error}</StateNotice>;
  if (!view) return <Section title="Your plan"><Skeleton lines={3} /></Section>;
  const v = view.value;
  return (
    <>
      <Section title={v ? `This month BARRY · ${v.period}` : "This month"} subtitle="Counted only from verified records — test money, pending payments and estimates never count.">
        {v ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <BigMetric label="Handled" icon="barry" iconTone="accent" value={v.handled} sub={v.outcomes ? `${v.outcomes} verified outcome${v.outcomes === 1 ? "" : "s"}` : "conversations on its own"} />
              <BigMetric label="Generated" icon="money" iconTone="ok" tone={Object.keys(v.generated).length ? "ok" : "ink"} value={moneyWords(v.generated, { empty: "—" })} sub={`Recovered ${moneyWords(v.recovered, { empty: "nothing yet" })}`} />
              <BigMetric label="Saved (realised)" icon="spark" iconTone="violet" value={moneyWords(v.savedRealized, { empty: "—" })} sub={v.savedNote ?? "Only evidence-backed savings"} />
              <BigMetric label="Needed you" icon="shield" iconTone={v.needsYou ? "warn" : "neutral"} value={v.needsYou} sub={v.needsYou === 1 ? "time" : "times"} />
            </div>
            <ul className="flex flex-col gap-1.5 text-[13.5px]">
              {v.workingOn.length > 0 && <li className="text-o-ink-2"><span className="text-o-muted">Working on:</span> {v.workingOn.join(" · ")}</li>}
              {v.blocked.length > 0 && <li className="text-o-bad"><span className="text-o-muted">Blocked:</span> {v.blocked.join(" · ")}</li>}
              {v.unlockNext.length > 0 && <li className="text-o-ink-2"><span className="text-o-muted">Unlock next:</span> {v.unlockNext.join(" · ")}</li>}
            </ul>
          </div>
        ) : (
          <p className="text-[13px] text-o-muted">Not available right now.</p>
        )}
      </Section>
      <Section title="Your plan" subtitle="A fixed monthly price — no share of your revenue or savings.">
        {view.plan ? (
          <div className="flex flex-col gap-3 text-[14px]">
            <p className="flex flex-wrap items-center gap-2">
              <Pill tone="info">{view.plan.name}</Pill>
              <span className="font-medium">{view.plan.promise}</span>
              <span className="text-o-muted">{moneyWords({ [view.plan.currency]: view.plan.monthlyPrice })}/month{view.plan.priceLockedUntil ? ` · founding price until ${view.plan.priceLockedUntil.slice(0, 10)}` : ""}</span>
            </p>
            <p className="text-[13px] text-o-muted">
              Subscription: {view.subscription.state}
              {view.subscription.freeMonth ? ` · free month day ${view.subscription.freeMonth.day} of 30 (ends ${view.subscription.freeMonth.endsAt.slice(0, 10)})` : ""}
              {view.subscription.recurringStartsAt && !view.subscription.freeMonth ? ` · monthly since ${view.subscription.recurringStartsAt.slice(0, 10)}` : ""}
            </p>
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-wide text-o-muted">BARRY can do</p>
              <ul className="mt-1 grid gap-1 text-[13px] sm:grid-cols-2">{view.canDo.map((c) => <li key={c}>✓ {c}</li>)}</ul>
            </div>
            {view.planLocked.length > 0 && (
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-wide text-o-muted">Not in your plan</p>
                <ul className="mt-1 grid gap-1 text-[13px] text-o-muted sm:grid-cols-2">{view.planLocked.map((p) => <li key={p.feature}>{p.feature} — with {p.unlockedBy}</li>)}</ul>
              </div>
            )}
            {view.upgrades.length > 0 && (
              <div className="flex flex-col gap-2">
                {view.upgrades.map((u) => (
                  <div key={u.id} className="flex flex-col gap-1 rounded-xl bg-o-raised p-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-[13px]"><b>{u.name}</b> — {u.promise} {moneyWords({ [u.currency]: u.monthlyPrice })}/month · unlocks {u.unlocks.join(", ")}</span>
                    <button className={btn} onClick={() => void ask(u.id)}>Ask about {u.name}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-[13px] text-o-muted">
            <p>No plan is set up for this business yet. The BARRY team sets it up with you.</p>
            <button className={btn} onClick={() => void ask()}>Talk to the BARRY team</button>
          </div>
        )}
        {sent && <p className="mt-3 text-[13px] text-o-ok">{sent}</p>}
      </Section>
    </>
  );
}
