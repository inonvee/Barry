import { requireFounder } from "@/lib/hq/guard";
import { fleetTenant, fleetTenantIds, getFleet } from "@/lib/hq/fleet";
import { hqShellData } from "@/lib/hq/shell-data";
import { getCommercialFleet } from "@/lib/commercial/service";
import { CATEGORY_WORDS, type CostCategory } from "@/lib/commercial/cost";
import { GROSS_MARGIN_TARGET_PCT, PLAN_CATALOG } from "@/lib/commercial/plans";
import { formatAmount, hasMoney } from "@/lib/format/money";
import { HqShell } from "@/components/hq/HqShell";
import { MoneyLine } from "@/components/hq/views";
import { EmptyState, FocusItem, FocusList, HeroBrief, MetricLine, Page, Section, StatusPill } from "@/components/ds/primitives";
import type { BusinessGraph } from "@/lib/business-graph";

/**
 * COMMERCIAL — the founder's economics across the fleet: contracted MRR per currency, free months,
 * setup paid / unpaid, gross contribution by plan, who is above the cost guardrail, where the cost goes,
 * and value delivered vs cost-to-serve. Every cost figure carries MEASURED / ESTIMATED; nothing is
 * summed across currencies. Owners never see this.
 */
export default async function HqCommercialPage() {
  await requireFounder();
  const now = new Date();
  const graphs = fleetTenantIds().map((id) => fleetTenant(id)).filter((g): g is BusinessGraph => !!g);
  const [fleet, c] = await Promise.all([getFleet({ now }), getCommercialFleet(graphs, { now })]);
  const withPlan = c.rows.filter((r) => r.plan);
  const categories = Object.entries(c.costByCategory).sort((a, b) => b[1] - a[1]);
  return (
    <HqShell active="commercial" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief
          eyebrow={`Commercial · ${c.period.label}`}
          title={withPlan.length === 0 ? "No business has a plan yet." : `${withPlan.length} business${withPlan.length === 1 ? "" : "es"} on a plan · MRR ${hasMoney(c.mrr) ? Object.entries(c.mrr).map(([cur, v]) => formatAmount(v, cur)).join(" and ") : "none yet"}`}
          lead={`Contracted, fixed monthly pricing (manual billing — nothing auto-charges). Gross-margin target ≥${GROSS_MARGIN_TARGET_PCT}%. Costs are labelled MEASURED or ESTIMATED; a missing cost is UNAVAILABLE, never zero.`}
        />
        <div className="flex flex-col gap-5">
          <Section title="Fleet">
            <MetricLine
              items={[
                { label: "Free month", value: c.freeMonth },
                { label: "Paid active", value: c.active, status: c.active ? "ok" : undefined },
                { label: "Cancelled", value: c.cancelled },
                { label: "Setup paid", value: c.setup.paid, status: "ok" },
                { label: "Setup waived", value: c.setup.waived },
                { label: "Setup unpaid", value: c.setup.unpaid, status: c.setup.unpaid ? "attention" : undefined },
                { label: "Above cost guardrail", value: c.aboveGuardrail.length, status: c.aboveGuardrail.length ? "blocked" : undefined },
              ]}
            />
          </Section>

          <Section title="Businesses" subtitle="Plan, stage, cost-to-serve and contribution this month.">
            <FocusList>
              {c.rows.map((r) => (
                <FocusItem
                  key={r.id}
                  status={r.aboveGuardrail ? "blocked" : r.alerts ? "attention" : r.plan ? "ok" : "neutral"}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {r.name}
                      <StatusPill status={r.plan ? "info" : "neutral"}>{r.plan ? PLAN_CATALOG[r.plan].name : "No plan"}</StatusPill>
                    </span>
                  }
                  why={
                    <span className="flex flex-col gap-0.5">
                      <span>
                        {r.stageWords}
                        {r.freeDay ? ` · day ${r.freeDay} of 30` : ""}
                        {r.monthlyPrice !== null ? ` · ${formatAmount(r.monthlyPrice, r.currency)}/month` : ""} · setup {r.setupStatus.replace(/_/g, " ")}
                      </span>
                      <span>
                        Cost to serve {r.costToServe === null ? "UNAVAILABLE" : `${formatAmount(r.costToServe, "USD")} ${r.costBasis.toUpperCase()}${r.costComplete ? "" : " (lower bound)"}`}
                        {r.grossContribution !== null && r.plan ? ` · contribution ${formatAmount(r.grossContribution, r.currency)}` : ""}
                        {r.grossMarginPct !== null ? ` · margin ${r.grossMarginPct}%` : ""}
                      </span>
                    </span>
                  }
                  href={`/hq/commercial/${encodeURIComponent(r.id)}`}
                />
              ))}
            </FocusList>
          </Section>

          <Section title="Gross contribution by plan" subtitle="Recurring only (setup apart), per currency, this month.">
            {c.contribution.length === 0 ? <EmptyState>No plan has recurring revenue or cost yet.</EmptyState> : (
              <FocusList>
                {c.contribution.map((g) => (
                  <FocusItem key={`${g.plan}:${g.currency}`} status={g.contribution < 0 ? "attention" : "ok"} title={`${PLAN_CATALOG[g.plan].name} · ${g.currency}`} why={`Recurring ${formatAmount(g.recurring, g.currency)} − cost ${formatAmount(g.cost, g.currency)} = ${formatAmount(g.contribution, g.currency)}`} />
                ))}
              </FocusList>
            )}
          </Section>

          <Section title="Where the cost goes" subtitle="USD costs this month across the fleet (measured and estimated together; see each business for labels).">
            {categories.length === 0 ? <EmptyState>No cost recorded or metered yet.</EmptyState> : (
              <FocusList>
                {categories.map(([cat, v]) => (
                  <FocusItem key={cat} status="neutral" title={CATEGORY_WORDS[cat as CostCategory]} why={formatAmount(v, "USD")} />
                ))}
              </FocusList>
            )}
          </Section>

          <Section title="Value delivered vs cost to serve" subtitle="Verified money BARRY generated or recovered (owner's currency) next to what serving them cost BARRY.">
            {c.valueVsCost.length === 0 ? <EmptyState>No business on a plan yet.</EmptyState> : (
              <FocusList>
                {c.valueVsCost.map((v) => (
                  <FocusItem key={v.id} status="neutral" title={v.name} why={<span className="flex flex-wrap gap-x-4"><span>Made: <MoneyLine money={v.made} empty="nothing verified yet" /></span><span>Cost: {v.cost === null ? "UNAVAILABLE" : formatAmount(v.cost, "USD")}</span></span>} href={`/hq/commercial/${encodeURIComponent(v.id)}`} />
                ))}
              </FocusList>
            )}
          </Section>
        </div>
      </Page>
    </HqShell>
  );
}
