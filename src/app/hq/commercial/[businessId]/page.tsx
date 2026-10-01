import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFounder } from "@/lib/hq/guard";
import { fleetTenant, getFleet } from "@/lib/hq/fleet";
import { hqShellData } from "@/lib/hq/shell-data";
import { getCommercialBusiness, listPlanRequests } from "@/lib/commercial/service";
import { COST_CATEGORIES, CATEGORY_WORDS, supportHourlyCostUsd } from "@/lib/commercial/cost";
import { FREE_PERIOD_DAYS, GROSS_MARGIN_TARGET_PCT, PLAN_CATALOG, STANDARD_PLANS } from "@/lib/commercial/plans";
import { COMMERCIAL_QA_SCENARIOS } from "@/lib/qa/commercial-scenarios";
import { qaEnabled } from "@/lib/qa/mode";
import { formatAmount } from "@/lib/format/money";
import { HqShell } from "@/components/hq/HqShell";
import { MoneyLine } from "@/components/hq/views";
import { Confirmation, Disclosure, EmptyState, FocusItem, FocusList, HeroBrief, Kv, MetricLine, Notice, Page, Section, StatusPill, buttonPrimary, input } from "@/components/ds/primitives";

const ACTION = "/api/hq/commercial";
const small = "rounded-lg border border-[#d0d5dd] bg-white px-3 py-2 text-sm font-medium text-[#344054] hover:bg-[#f9fafb]";

function Hidden({ businessId, action }: { businessId: string; action: string }) {
  return (
    <>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="action" value={action} />
    </>
  );
}

/**
 * COMMERCIAL · ONE BUSINESS — the design-partner founder flow: choose plan → record setup → quoted →
 * setup paid → readiness → activate the free month → monitor value + cost → free-month end → confirm
 * recurring → pause / cancel / plan change. Every step audited; nothing is charged by BARRY.
 */
export default async function HqCommercialBusinessPage({ params, searchParams }: { params: Promise<{ businessId: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireFounder();
  const { businessId } = await params;
  const sp = await searchParams;
  const graph = fleetTenant(businessId);
  if (!graph) notFound();
  const now = new Date();
  const [fleet, c, requests] = await Promise.all([getFleet({ now }), getCommercialBusiness(graph, { now }), listPlanRequests(graph.business.id).catch(() => [])]);
  const a = c.account;
  const id = graph.business.id;
  const e = c.economics;
  const qa = qaEnabled();
  const iso = (s: string | null | undefined) => (s ? s.slice(0, 10) : "—");
  return (
    <HqShell active="commercial" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief
          eyebrow={
            <span className="flex flex-wrap items-center gap-2">
              <Link href="/hq/commercial" className="underline-offset-2 hover:underline">Commercial</Link> · {graph.business.name}
            </span>
          }
          title={a ? `${PLAN_CATALOG[a.plan].name} · ${c.stageWords}` : "No plan selected"}
          lead={
            a
              ? `${formatAmount(c.effectivePrice ?? a.monthlyPrice, a.currency)}/month${a.foundingCustomer && a.priceLockUntil ? ` (founding price, locked until ${iso(a.priceLockUntil)})` : ""} · setup ${a.setupPrice !== null ? formatAmount(a.setupPrice, a.currency) : "not quoted"} ${a.setupStatus.replace(/_/g, " ")}${c.freePeriod ? ` · free month day ${c.freePeriod.day} of ${FREE_PERIOD_DAYS}, ends ${iso(c.freePeriod.endsAt)}` : ""}${a.recurringStartsAt ? ` · recurring ${a.recurringConfirmedAt ? "since" : "planned"} ${iso(a.recurringStartsAt)}` : ""}`
              : "Choose CORE, OPERATOR or INTELLIGENCE. The free month starts only when you activate it."
          }
        />
        <div className="flex flex-col gap-5">
          {sp.ok && <Notice status="ok" title={sp.ok} />}
          {sp.error && <Notice status="blocked" title="Not recorded">{sp.error}</Notice>}
          {c.alerts.length > 0 && (
            <Section title="Founder alerts" subtitle="Signals only — no billing action and no change for the customer happens automatically.">
              <FocusList>
                {c.alerts.map((al, i) => (
                  <FocusItem key={`${al.kind}:${i}`} status={al.severity === "high" ? "blocked" : "attention"} title={al.title} why={al.why} move={al.nextAction} />
                ))}
              </FocusList>
            </Section>
          )}

          <Section title="Next step" subtitle={`Billing: ${c.billing.provider}${c.billing.chargesAutomatically ? "" : " — nothing is charged automatically; you invoice and confirm by hand."}`}>
            {(!a || a.subscriptionState === "cancelled") && (
              <Confirmation action={ACTION} hidden={{ businessId: id, action: "select_plan" }} title="1 · Choose the plan" scope={graph.business.name} effect="Records the plan, its feature snapshot and price; the runtime enforces the plan from the next turn (it can only remove availability)." reversibility="Change the plan later (audited)." submit="Record plan">
                <PlanFields />
              </Confirmation>
            )}
            {a && a.subscriptionState === "pre_activation" && (a.setupStatus === "not_quoted" || a.setupStatus === "quoted") && (
              <form action={ACTION} method="post" className="flex flex-col gap-2 rounded-xl bg-[#f9fafb] p-4 sm:flex-row sm:items-end">
                <Hidden businessId={id} action="quote_setup" />
                <label className="flex-1 text-[12px] text-[#667085]">2–3 · Setup price ({a.currency}) — from {formatAmount(PLAN_CATALOG[a.plan].setupFrom ?? 0, "USD")}
                  <input name="setupPrice" required inputMode="decimal" defaultValue={a.setupPrice ?? PLAN_CATALOG[a.plan].setupFrom ?? ""} className={`${input} mt-1`} />
                </label>
                <input type="hidden" name="reason" value="setup quoted" />
                <button className={buttonPrimary}>{a.setupStatus === "quoted" ? "Update quote" : "Mark setup quoted"}</button>
              </form>
            )}
            {a && a.setupStatus === "quoted" && (
              <form action={ACTION} method="post" className="mt-2">
                <Hidden businessId={id} action="invoice_setup" />
                <input type="hidden" name="reason" value="setup invoice sent manually" />
                <button className={small}>Record: setup invoice sent (manual)</button>
              </form>
            )}
            {a && (a.setupStatus === "quoted" || a.setupStatus === "invoiced") && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Confirmation action={ACTION} hidden={{ businessId: id, action: "mark_setup_paid" }} title="4 · Setup paid" scope={`${formatAmount(a.setupPrice ?? 0, a.currency)} setup`} effect="Records the payment you received (manual). Setup revenue is reported apart from recurring." reversibility="Correct with a note; the audit keeps both." submit="Record setup paid">
                  <label className="text-[12px] text-[#667085]">Payment reference (optional)<input name="reference" className={`${input} mt-1`} /></label>
                </Confirmation>
                <Confirmation action={ACTION} hidden={{ businessId: id, action: "waive_setup" }} title="Waive setup" scope="Setup fee" effect="No setup fee is due; the free month may start once ready." reversibility="Record a new quote if needed." submit="Waive setup" />
              </div>
            )}
            {a && a.subscriptionState === "pre_activation" && (a.setupStatus === "paid" || a.setupStatus === "waived") && (
              <Confirmation
                action={ACTION}
                hidden={{ businessId: id, action: "activate_free_period" }}
                title={`6 · Start the ${FREE_PERIOD_DAYS}-day free month`}
                scope={graph.business.name}
                effect={c.readiness.level === "READY_TO_START_FREE_MONTH" ? `Free month ${iso(now.toISOString())} → ${iso(new Date(now.getTime() + FREE_PERIOD_DAYS * 864e5).toISOString())}; recurring planned at its end.` : `NOT READY — ${c.readiness.blocker}. Starting anyway needs an override reason (audited).`}
                reversibility="Pause (the free month's clock stops) or cancel; the start itself is not undone."
                submit={c.readiness.level === "READY_TO_START_FREE_MONTH" ? "Start free month" : "Start with override"}
                danger={c.readiness.level !== "READY_TO_START_FREE_MONTH"}
              >
                {c.readiness.level !== "READY_TO_START_FREE_MONTH" && <label className="text-[12px] text-[#667085]">Override reason (required when not ready)<input name="override" required className={`${input} mt-1`} /></label>}
              </Confirmation>
            )}
            {a && a.subscriptionState === "free_period" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Confirmation action={ACTION} hidden={{ businessId: id, action: "confirm_recurring" }} title="9 · Confirm recurring start" scope={`${formatAmount(c.effectivePrice ?? a.monthlyPrice, a.currency)}/month from ${iso(a.freePeriodEndsAt)}`} effect={c.stage === "awaiting_recurring" ? "Marks the subscription paid-active. You invoice manually; nothing auto-charges." : `Only after the free month ends (${iso(a.freePeriodEndsAt)}).`} reversibility="Pause or cancel later." submit="Confirm recurring" />
                <Confirmation action={ACTION} hidden={{ businessId: id, action: "pause" }} title="Pause" scope="Subscription" effect="Stops the free month's clock (it is extended on resume)." reversibility="Resume." submit="Pause" />
              </div>
            )}
            {a && a.subscriptionState === "paused" && <Confirmation action={ACTION} hidden={{ businessId: id, action: "resume" }} title="Resume" scope="Subscription" effect="Resumes; a free month is extended by the paused time." reversibility="Pause again." submit="Resume" />}
            {a && a.subscriptionState === "active" && <Confirmation action={ACTION} hidden={{ businessId: id, action: "pause" }} title="Pause" scope="Subscription" effect="Records a pause; recurring revenue stops counting." reversibility="Resume." submit="Pause" />}
            {a && a.subscriptionState !== "cancelled" && (
              <Disclosure summary="10 · Change plan or cancel" muted>
                <div className="flex flex-col gap-3">
                  <Confirmation action={ACTION} hidden={{ businessId: id, action: "select_plan" }} title="Change plan" scope={`From ${PLAN_CATALOG[a.plan].name}`} effect="New feature snapshot and price, versioned. A founding customer's purchased features are never removed without the explicit review box." reversibility="Change again (audited)." submit="Change plan">
                    <PlanFields current={a.plan} />
                    {a.foundingCustomer && <label className="flex items-start gap-2 text-[13px] text-[#344054]"><input type="checkbox" name="confirmFeatureRemoval" value="true" className="mt-1" /> I reviewed removing purchased features from this founding customer.</label>}
                  </Confirmation>
                  <Confirmation action={ACTION} hidden={{ businessId: id, action: "cancel" }} title="Record cancellation" scope="Subscription" effect="Records the cancellation date. BARRY keeps working until you pause the business in Controls — nothing shuts down automatically." reversibility="Record a new agreement." submit="Record cancellation" danger>
                    <label className="text-[12px] text-[#667085]">Effective date (optional)<input type="date" name="effectiveAt" className={`${input} mt-1`} /></label>
                  </Confirmation>
                </div>
              </Disclosure>
            )}
          </Section>

          <Section title={`5 · Design-partner readiness: ${c.readiness.level.replace(/_/g, " ")}`} subtitle={c.readiness.blocker ?? "Every item has evidence."}>
            <FocusList>
              {c.readiness.items.map((i) => (
                <FocusItem key={i.id} status={i.ready ? "ok" : "attention"} title={i.title} why={i.evidence} move={i.ready ? undefined : i.nextAction} />
              ))}
            </FocusList>
            <p className="mt-2 text-[12px] text-[#667085]">Technical gate: {c.launchLevel.replace(/_/g, " ")} — <Link className="underline" href={`/hq/${encodeURIComponent(id)}?view=launch`}>open the launch checklist</Link>.</p>
          </Section>

          <Section title={`7 · Unit economics · ${c.period.label}`} subtitle={`Recurring and setup never mix. Target gross margin ≥${GROSS_MARGIN_TARGET_PCT}%. Guardrail ${e.guardrail !== null ? formatAmount(e.guardrail, "USD") + "/month" : "—"}.`}>
            <MetricLine
              items={[
                { label: "Recurring revenue (contracted)", value: formatAmount(e.recurringRevenue, e.currency) },
                { label: "Setup revenue (apart)", value: formatAmount(e.setupRevenue, e.currency) },
                { label: `Cost to serve · ${e.costBasis.toUpperCase()}`, value: e.costToServe === null ? `UNAVAILABLE in ${e.currency}` : `${formatAmount(e.costToServe, e.currency)}${e.costComplete ? "" : " (lower bound)"}`, status: e.aboveGuardrail ? "blocked" : undefined },
                // A lower-bound cost makes contribution an UPPER bound — say so, never present it as final.
                { label: e.costComplete ? "Gross contribution" : "Gross contribution (at most)", value: e.grossContribution === null ? "— (cost unavailable)" : formatAmount(e.grossContribution, e.currency), status: e.grossContribution !== null && e.grossContribution < 0 ? "attention" : undefined },
                { label: "Gross margin", value: e.grossMarginPct === null ? "— (no recurring revenue)" : `${e.grossMarginPct}%`, status: e.belowMarginTarget ? "attention" : e.grossMarginPct !== null ? "ok" : undefined },
              ]}
            />
            <div className="mt-3">
              {c.cost.lines.map((l) => (
                <Kv key={`${l.category}:${l.currency}`} k={<span className="flex items-center gap-2">{l.label} <StatusPill status={l.basis === "measured" ? "ok" : l.basis === "estimated" ? "info" : "neutral"}>{l.basis.toUpperCase()}</StatusPill></span>} v={<span>{l.amount === null ? "—" : formatAmount(l.amount, l.currency)} <span className="text-[12px] text-[#667085]">· {l.detail}</span></span>} />
              ))}
              <Kv k="AI usage this month" v={`${c.cost.model.calls} calls · ${c.cost.model.inputTokens.toLocaleString()} in / ${c.cost.model.outputTokens.toLocaleString()} out tokens (provider-reported) · ≈ ${formatAmount(c.cost.model.estimatedUsd, "USD")} ESTIMATED (${c.cost.model.rateCardVersion})${c.cost.model.unpricedCalls ? ` · ${c.cost.model.unpricedCalls} call${c.cost.model.unpricedCalls === 1 ? "" : "s"} UNPRICED (no rate when recorded) — not included, so this is a lower bound` : ""}`} />
              {e.freePeriodCoverage !== null && <Kv k="Setup covers the free month" v={`${formatAmount(e.freePeriodCoverage, e.currency)} left after the free days' cost`} />}
              {e.notes.map((n) => <p key={n} className="mt-1 text-[12px] text-[#667085]">{n}</p>)}
            </div>
          </Section>

          <Section title="Value delivered" subtitle="Evidence only: simulated, pending and unverified never count; savings only when realised.">
            {c.value ? (
              <MetricLine
                items={[
                  { label: "BARRY HANDLED", value: `${c.value.handled.conversations} conv. · ${c.value.handled.outcomes} outcomes` },
                  { label: "BARRY MADE · generated", value: <MoneyLine money={c.value.made.generated} empty="none verified" /> },
                  { label: "· recovered", value: <MoneyLine money={c.value.made.recovered} empty="none verified" /> },
                  { label: "BARRY SAVED (realised)", value: <MoneyLine money={c.value.saved.realized} empty={c.value.saved.marginsAvailable ? "none realised" : "not in plan"} /> },
                  { label: "BARRY NEEDS YOU", value: c.value.needsYou.conversations },
                ]}
              />
            ) : <EmptyState>Value unavailable: {c.unavailable.join("; ")}</EmptyState>}
            {c.value?.saved.marginsNote && <p className="mt-2 text-[12px] text-[#667085]">{c.value.saved.marginsNote}</p>}
          </Section>

          {c.trial && (
            <Section title={`13 · Free-month summary${c.trial.complete ? "" : " (so far)"}`} subtitle={`${iso(c.trial.window.start)} → ${iso(c.trial.window.end)} · ${c.trial.billingNote}`}>
              <Kv k="What BARRY did" v={c.trial.didWhat.join(" · ")} />
              <Kv k="Measured value" v={<span className="flex flex-wrap gap-x-3"><span>generated <MoneyLine money={c.trial.measuredValue.generated} empty="none" /></span><span>recovered <MoneyLine money={c.trial.measuredValue.recovered} empty="none" /></span><span>saved <MoneyLine money={c.trial.measuredValue.savedRealized} empty="none" /></span><span>needed you {c.trial.measuredValue.needsYou}×</span></span>} />
              <Kv k="Remaining gaps" v={c.trial.remainingGaps.length ? c.trial.remainingGaps.join("; ") : "none"} />
              <Kv k="What it cost us" v={`${Object.entries(c.trial.costToServe.total).map(([cur, v]) => formatAmount(v, cur)).join(" and ") || "nothing recorded"} (${c.trial.costToServe.basis}${c.trial.costToServe.missing.length ? `; unavailable: ${c.trial.costToServe.missing.length} categories` : ""}) · AI ≈ ${formatAmount(c.trial.costToServe.modelUsd, "USD")} · support ${c.trial.costToServe.supportMinutes} min`} />
              <Kv k="Operational health" v={`AI ${c.trial.health.aiStatus} · ${c.trial.health.incidentsOpen} open incident(s), ${c.trial.health.incidentsHigh} high · readiness ${c.trial.health.readiness}`} />
            </Section>
          )}

          <Section title="Record cost-to-serve" subtitle="Measured (invoice share), estimated (with confidence) or unavailable — never a fake exact bill.">
            <form action={ACTION} method="post" className="grid gap-2 sm:grid-cols-3">
              <Hidden businessId={id} action="record_cost" />
              <input type="hidden" name="reason" value="cost recorded" />
              <select name="costCategory" className={input} defaultValue="hosting_compute">{COST_CATEGORIES.map((k) => <option key={k} value={k}>{CATEGORY_WORDS[k]}</option>)}</select>
              <select name="costBasis" className={input} defaultValue="estimated"><option value="measured">MEASURED</option><option value="estimated">ESTIMATED</option><option value="unavailable">UNAVAILABLE</option></select>
              <select name="costConfidence" className={input} defaultValue="medium"><option value="">confidence (estimates)</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>
              <input name="costProvider" required placeholder="Provider (e.g. Vercel)" className={input} />
              <input name="costAmount" inputMode="decimal" placeholder="Amount" className={input} />
              <input name="costCurrency" defaultValue="USD" className={input} />
              <input name="costSource" required placeholder="Source (invoice, allocation rule)" className={`${input} sm:col-span-3`} />
              <label className="text-[12px] text-[#667085]">From<input type="date" name="costPeriodStart" required defaultValue={c.period.start.slice(0, 10)} className={`${input} mt-1`} /></label>
              <label className="text-[12px] text-[#667085]">To<input type="date" name="costPeriodEnd" required defaultValue={new Date(Date.parse(c.period.end) - 864e5).toISOString().slice(0, 10)} className={`${input} mt-1`} /></label>
              <div className="flex items-end"><button className={buttonPrimary}>Record cost</button></div>
            </form>
            <form action={ACTION} method="post" className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <Hidden businessId={id} action="record_support" />
              <label className="text-[12px] text-[#667085]">Support minutes<input name="minutes" required inputMode="numeric" className={`${input} mt-1`} /></label>
              <label className="flex-1 text-[12px] text-[#667085]">What for<input name="note" className={`${input} mt-1`} /></label>
              <button className={small}>Log time (ESTIMATED at {supportHourlyCostUsd()} USD/h)</button>
            </form>
          </Section>

          {requests.length > 0 && (
            <Section title="Owner plan requests" subtitle="Requests only — plans change here, by you.">
              <FocusList>{requests.map((r) => <FocusItem key={r.id} status="attention" title={r.plan ? `Upgrade to ${PLAN_CATALOG[r.plan].name}` : "Talk to BARRY"} why={`${r.message || "—"} · ${iso(r.at)} by ${r.by}`} />)}</FocusList>
            </Section>
          )}

          <Section title="Commercial history" subtitle="Who, when, why, before → after.">
            {c.events.length === 0 ? <EmptyState>No commercial change yet.</EmptyState> : (
              <FocusList>
                {c.events.slice(0, 30).map((ev) => (
                  <FocusItem key={ev.id} status="neutral" title={`${ev.kind.replace(/_/g, " ")} · ${ev.at.replace("T", " ").slice(0, 16)}`} why={`${ev.by}: ${ev.reason}${ev.billing ? ` · ${ev.billing.note}` : ""}`} />
                ))}
              </FocusList>
            )}
            <form action={ACTION} method="post" className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Hidden businessId={id} action="note" />
              <input name="note" required placeholder="Add a commercial note" className={input} />
              <button className={small}>Add note</button>
            </form>
          </Section>

          {qa && (
            <Section title="QA (Preview only)" subtitle="Emulate a plan on this business, or run a self-checking commercial scenario on an isolated sandbox id.">
              <form action={ACTION} method="post" className="flex flex-col gap-2 sm:flex-row">
                <Hidden businessId={id} action="qa_emulate_plan" />
                <select name="plan" className={input} defaultValue="NONE"><option value="NONE">No emulation</option>{STANDARD_PLANS.map((p) => <option key={p} value={p}>{PLAN_CATALOG[p].name}</option>)}</select>
                <button className={small}>Emulate plan</button>
              </form>
              <div className="mt-3 flex flex-wrap gap-2">
                {COMMERCIAL_QA_SCENARIOS.map((s) => (
                  <form key={s.id} action={ACTION} method="post">
                    <Hidden businessId={id} action="qa_scenario" />
                    <input type="hidden" name="scenario" value={s.id} />
                    <button className={small} title={s.expect}>{s.title}</button>
                  </form>
                ))}
              </div>
            </Section>
          )}
        </div>
      </Page>
    </HqShell>
  );
}

function PlanFields({ current }: { current?: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-[12px] text-[#667085]">Plan
        <select name="plan" defaultValue={current ?? "CORE"} className={`${input} mt-1`}>
          {(["CORE", "OPERATOR", "INTELLIGENCE", "CUSTOM"] as const).map((p) => <option key={p} value={p}>{PLAN_CATALOG[p].name}{PLAN_CATALOG[p].monthlyPrice ? ` — $${PLAN_CATALOG[p].monthlyPrice}/mo` : " — custom"}</option>)}
        </select>
      </label>
      <label className="text-[12px] text-[#667085]">Monthly price (blank = catalog; required for Custom)<input name="monthlyPrice" inputMode="decimal" className={`${input} mt-1`} /></label>
      <label className="text-[12px] text-[#667085]">Setup price (optional now)<input name="setupPrice" inputMode="decimal" className={`${input} mt-1`} /></label>
      <label className="text-[12px] text-[#667085]">Founding price lock (months, optional)<input name="priceLockMonths" inputMode="numeric" placeholder="12" className={`${input} mt-1`} /></label>
      <label className="flex items-start gap-2 text-[13px] text-[#344054]"><input type="checkbox" name="foundingCustomer" value="true" className="mt-1" /> Founding customer</label>
    </div>
  );
}
