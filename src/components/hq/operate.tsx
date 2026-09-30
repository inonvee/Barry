import Link from "next/link";
import type { BusinessStatusDetail } from "@/lib/hq/fleet";
import type { LaunchGate } from "@/lib/hq/launch";
import type { Incident } from "@/lib/hq/incidents";
import { NEXT_MOVE_WORDS, isOpen } from "@/lib/operator/obligations";
import { describeChange } from "@/lib/hq/fleet";
import type { FinancialImpact, ProfitOpportunity } from "@/lib/finance/impact";
import { Badge, Card, Kv, type Tone } from "./ui";

/**
 * FOUNDER OPERATIONS for one business: status, incidents (acknowledge / resolve), founder controls
 * (bounded, confirmed, audited), the design-partner launch checklist + gate, the obligation queue and
 * the founder audit. Server-rendered; every action is a form to a founder-only API that redirects back.
 */

const when = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 16) : "—");
const money = (m: Record<string, number>) => Object.entries(m).filter(([, v]) => v > 0).map(([c, v]) => `${v.toFixed(0)} ${c}`).join(" + ") || "—";
const SEV: Record<Incident["severity"], Tone> = { high: "bad", medium: "warn", low: "neutral" };
const input = "w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm";
const button = "rounded-md bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-3 py-1 text-sm";
const small = "rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800";

export function OperationalStatus({ b }: { b: BusinessStatusDetail }) {
  return (
    <Card title="Operational status" right={<Badge tone={b.health === "healthy" ? "good" : b.health === "attention" ? "warn" : "bad"}>{b.health}</Badge>}>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <Kv k="Stage · mode" v={`${b.stage.replace(/_/g, " ")} · ${b.controls.mode.toUpperCase()}`} />
        <Kv k="Build" v={`${b.build.commit ? b.build.commit.slice(0, 7) : "local"} · ${b.build.runtime} · ${b.build.environment}`} />
        <Kv k="Model" v={`${b.model.mode.replace("_", " ")} · ${b.model.status.replace(/_/g, " ")}${b.model.model ? ` · ${b.model.model}` : ""}`} />
        <Kv k="Storage" v={b.storage} />
        <Kv k="WhatsApp" v={b.channel.whatsapp.replace(/_/g, " ")} />
        <Kv k="Providers" v={`commerce ${b.providers.commerce} · payments ${b.providers.payments} · scheduling ${b.providers.scheduling}`} />
        <Kv k="Readiness" v={b.readiness.label} />
        <Kv k="Interventions · active · held · handoffs" v={`${b.interventions} · ${b.approvalsActive} · ${b.approvalsHeld} · ${b.handoffsOpen}`} />
        <Kv k="Incidents" v={`${b.incidents.high} high · ${b.incidents.medium} medium · ${b.incidents.low} low`} />
        <Kv k="Money" v={`${money(b.money.stuckWithOwner)} with owner · ${money(b.money.waitingOnCustomer)} on customers · ${money(b.money.atRisk)} at risk${Object.keys(b.money.simulated).length ? ` · ${money(b.money.simulated)} test` : ""}`} />
        <Kv k="Conversations" v={`${b.conversations.total} total · ${b.conversations.last24h} active 24h · last ${when(b.conversations.latestActivityAt)}`} />
        <Kv k="Watching (obligations)" v={`${b.obligations.open} open · ${b.obligations.needsOwner} need owner · ${b.obligations.barryCanAct} BARRY can act · ${b.obligations.waitingOnCustomer} on customers · ${b.obligations.blocked} blocked`} />
      </div>
      {b.unavailable.length > 0 && <p className="mt-2 text-xs italic text-neutral-500">Unavailable: {b.unavailable.join(", ")}.</p>}
    </Card>
  );
}

export function IncidentsCard({ b }: { b: BusinessStatusDetail }) {
  const open = b.incidents.open;
  return (
    <Card title="Incidents" right={<Badge tone={b.incidents.high ? "bad" : b.incidents.medium ? "warn" : "good"}>{open.length} open</Badge>}>
      <div id="incidents" />
      {open.length === 0 ? <p className="text-sm text-neutral-500">Nothing is broken or stuck by the records.</p> : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {open.map((i) => (
            <li key={i.key} className="py-2 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={SEV[i.severity]}>{i.severity}</Badge>
                <span className="font-medium">{i.title}</span>
                <Badge tone={i.status === "acknowledged" ? "info" : "neutral"}>{i.status}</Badge>
                <span className="text-xs text-neutral-500">{i.kind.replace(/_/g, " ")} · first {when(i.firstSeen)} · last {when(i.lastSeen)} · ×{i.occurrences}</span>
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-300">Impact: {i.impact} Next: {i.nextAction}</p>
              <p className="text-xs text-neutral-500">Evidence: {i.evidence.join(" · ")}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                {i.links.conversationId && <Link className="hover:underline" href={`/hq/${encodeURIComponent(b.id)}/conversations/${encodeURIComponent(i.links.conversationId)}`}>conversation ›</Link>}
                {i.capability && <span className="font-mono text-neutral-500">{i.capability}</span>}
                {i.acknowledged && <span className="text-neutral-500">acknowledged {when(i.acknowledged.at)} by {i.acknowledged.by}{i.acknowledged.note ? ` — ${i.acknowledged.note}` : ""}</span>}
                <form action="/api/hq/incidents" method="post" className="flex items-center gap-1">
                  <input type="hidden" name="businessId" value={b.id} />
                  <input type="hidden" name="key" value={i.key} />
                  <input name="note" placeholder="note" className="w-32 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-1.5 py-0.5 text-xs" />
                  {i.status === "current" && <button name="action" value="acknowledge" className={small}>Acknowledge</button>}
                  <button name="action" value="resolve" className={small}>Resolve</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ControlsCard({ b }: { b: BusinessStatusDetail }) {
  const c = b.controls;
  return (
    <Card title="Founder controls" right={<span className="text-xs text-neutral-500">every change: reason + confirmation + audit · reversible</span>}>
      <div id="controls" />
      <div className="grid gap-x-6 sm:grid-cols-2">
        <Kv k="Mode" v={<Badge tone={c.mode === "live" ? "good" : c.mode === "supervised" ? "warn" : "info"}>{c.mode.toUpperCase()}</Badge>} />
        <Kv k="Consequential writes" v={c.pauseConsequentialWrites ? <Badge tone="bad">PAUSED</Badge> : "running"} />
        <Kv k="Human-only (approval for everything)" v={c.approvalRequiredForAll ? <Badge tone="warn">ON</Badge> : "off"} />
        <Kv k="Paused capabilities" v={c.pausedCapabilities.length ? c.pausedCapabilities.join(", ") : "none"} />
        <Kv k="Disabled channels" v={c.disabledChannels.length ? c.disabledChannels.join(", ") : "none"} />
        <Kv k="Last change" v={c.updatedAt ? `${when(c.updatedAt)} by ${c.updatedBy ?? "founder"} — ${c.reason}` : "never (defaults)"} />
      </div>
      <form action="/api/hq/controls" method="post" className="mt-3 grid gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 sm:grid-cols-2">
        <input type="hidden" name="businessId" value={b.id} />
        <label className="text-xs text-neutral-500">
          Mode
          <select name="mode" defaultValue={c.mode} className={input}>
            <option value="simulator">simulator</option>
            <option value="supervised">supervised</option>
            <option value="live">live</option>
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          Consequential writes
          <select name="pauseConsequentialWrites" defaultValue={String(c.pauseConsequentialWrites)} className={input}>
            <option value="false">running</option>
            <option value="true">paused (deny every consequential action)</option>
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          Human-only
          <select name="approvalRequiredForAll" defaultValue={String(c.approvalRequiredForAll)} className={input}>
            <option value="false">off (business rules decide)</option>
            <option value="true">on (owner approves every consequential action)</option>
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          Paused capabilities (ids or actions, comma-separated; &quot;support.*&quot; wildcards)
          <input name="pausedCapabilities" defaultValue={c.pausedCapabilities.join(", ")} className={input} />
        </label>
        <label className="text-xs text-neutral-500">
          Disabled channels (comma-separated, e.g. whatsapp)
          <input name="disabledChannels" defaultValue={c.disabledChannels.join(", ")} className={input} />
        </label>
        <label className="text-xs text-neutral-500">
          Reason (required, audited)
          <input name="reason" required minLength={3} placeholder="why" className={input} />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 sm:col-span-2">
          <input type="checkbox" name="confirm" value="yes" required /> I confirm this change applies to {b.name} only, takes effect on the next customer message, and is recorded in the audit.
        </label>
        <div className="sm:col-span-2">
          <button className={button}>Apply controls</button>
        </div>
      </form>
    </Card>
  );
}

export function LaunchCard({ gate }: { gate: LaunchGate }) {
  const tone: Tone = gate.level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" ? "good" : gate.level === "NOT_READY" ? "bad" : "warn";
  return (
    <Card title="Design-partner launch checklist" right={<Badge tone={tone}>{gate.level.replace(/_/g, " ")}</Badge>}>
      <div id="launch" />
      <p className="text-sm text-neutral-600 dark:text-neutral-300">{gate.reason}</p>
      <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
        {gate.items.map((i) => (
          <li key={i.id} className="py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={i.status === "ready" ? "good" : i.status === "blocked" ? "bad" : "neutral"}>{i.status === "unknown" ? "unknown / needs proof" : i.status}</Badge>
              <span className="font-medium">{i.title}</span>
              <span className="text-xs text-neutral-500">{i.responsibility.replace("_", " ")}{i.requiredForSupervised ? " · required" : " · for live"}</span>
            </div>
            <p className="text-xs text-neutral-500">Evidence: {i.evidence}</p>
            {i.blocker && <p className="text-xs text-amber-700 dark:text-amber-400">Blocker: {i.blocker}{i.nextAction ? ` → ${i.nextAction}` : ""}</p>}
            {!i.blocker && i.nextAction && <p className="text-xs text-neutral-500">Next: {i.nextAction}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ObligationsCard({ b }: { b: BusinessStatusDetail }) {
  const open = b.obligationList.filter(isOpen);
  const closed = b.obligationList.filter((o) => !isOpen(o));
  return (
    <Card title="What BARRY is watching (obligations)" right={<Badge>{open.length} open</Badge>}>
      {open.length === 0 ? <p className="text-sm text-neutral-500">Nothing outstanding by the records.</p> : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
          {open.map((o) => (
            <li key={o.key} className="py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={o.nextMove === "needs_owner" ? "warn" : o.nextMove === "blocked_by_capability" ? "bad" : o.nextMove === "barry_can_act" ? "good" : "neutral"}>{NEXT_MOVE_WORDS[o.nextMove]}</Badge>
                <span className="font-medium">{o.customer}: {o.subject}</span>
                <span className="text-xs text-neutral-500">{o.kind.replace(/_/g, " ")} · {o.status.replace(/_/g, " ")}{o.dueAt ? ` · due ${when(o.dueAt)}` : ""}{o.simulated ? " · test" : ""}</span>
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-300">{o.reason} Next: {o.nextAction}</p>
              <p className="text-xs text-neutral-500">
                Evidence: {o.evidence.join(" · ")} · <Link className="hover:underline" href={`/hq/${encodeURIComponent(b.id)}/conversations/${encodeURIComponent(o.conversationId)}`}>conversation ›</Link>
              </p>
            </li>
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-neutral-500">{closed.length} closed in the last 7 days</summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {closed.map((o) => (
              <li key={o.key}>
                <Badge tone={o.status === "completed" ? "good" : "neutral"}>{o.status}</Badge> {o.customer}: {o.subject} — {o.completion?.evidence ?? o.cancellation?.reason ?? (o.supersededBy ? `superseded by ${o.supersededBy}` : "")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

export function AuditCard({ b }: { b: BusinessStatusDetail }) {
  return (
    <Card title="Founder audit" right={<Badge>{b.audit.length}</Badge>}>
      {b.audit.length === 0 ? <p className="text-sm text-neutral-500">No founder changes yet.</p> : (
        <ul className="space-y-1 text-xs">
          {b.audit.slice(0, 20).map((a) => (
            <li key={a.id}>
              <span className="text-neutral-500">{when(a.at)} · {a.by}</span> — {describeChange(a)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ProfitCard({ impact, opportunities }: { impact: FinancialImpact; opportunities: ProfitOpportunity[] }) {
  return (
    <Card title="Profit / margin (foundation)" right={<Badge>{opportunities.length} evidence-backed</Badge>}>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <Kv k="GENERATED (verified revenue)" v={money(impact.generated)} />
        <Kv k="RECOVERED (inside generated)" v={money(impact.recovered)} />
        <Kv k="SAVED · realized" v={money(impact.saved.realized)} />
        <Kv k="Savings · potential / proposed / negotiated" v={`${money(impact.saved.potential)} / ${money(impact.saved.proposed)} / ${money(impact.saved.negotiated)}`} />
        <Kv k="Test money (apart)" v={money(impact.simulated)} />
        <Kv k="Cost evidence records" v={String(impact.evidenceCount)} />
      </div>
      {opportunities.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-500">No cost evidence is connected yet, so there are zero real profit opportunities. Estimated savings are never shown as realised.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {opportunities.map((o) => (
            <li key={o.id}>
              <Badge tone={o.state === "REALIZED" ? "good" : "info"}>{o.state}</Badge> {o.problem} <span className="text-xs text-neutral-500">→ {o.recommendedAction} · {o.confidence} confidence · {o.assumptions.join("; ")}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
