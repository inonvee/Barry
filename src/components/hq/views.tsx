import Link from "next/link";
import type { ReactNode } from "react";
import type { BusinessStatus, BusinessStatusDetail } from "@/lib/hq/fleet";
import type { Incident } from "@/lib/hq/incidents";
import type { GroupedLaunch } from "@/lib/hq/launch";
import type { ActivityEvent } from "@/lib/hq/activity";
import { actorWords } from "@/lib/hq/activity";
import { CONTROL_ACTIONS } from "@/lib/hq/controls";
import type { ReleaseState } from "@/lib/release/manifest";
import { formatLocal } from "@/lib/format/time";
import { moneyParts, hasMoney } from "@/lib/format/money";
import { ActivityRow, Confirmation, Disclosure, EmptyState, FocusItem, FocusList, StatusPill, Technical, Timeline, button, buttonQuiet, input, type Status } from "@/components/ds/primitives";

/**
 * HQ VIEW PIECES — server-safe building blocks the founder surfaces share: the fleet row (stacked on
 * phones, compact on desktop), incident items with acknowledge / resolve, the focused founder control
 * actions, the grouped launch checklist, activity lists, per-currency money lines and the release panel.
 */

export const bizHref = (id: string, view?: string) => `/hq/${encodeURIComponent(id)}${view ? `?view=${view}` : ""}`;

export function healthStatus(b: Pick<BusinessStatus, "health" | "controls" | "model">): Status {
  if (b.controls.pauseConsequentialWrites) return "blocked";
  if (b.model.status === "unavailable" || b.model.status === "degraded") return "degraded";
  return b.health === "healthy" ? "ok" : b.health === "attention" ? "attention" : "blocked";
}

export function stageStatus(b: Pick<BusinessStatus, "stage">): Status {
  return b.stage === "live_ready" ? "ok" : b.stage === "supervised" ? "info" : "simulator";
}

export const STAGE_WORDS: Record<BusinessStatus["stage"], string> = { simulator_only: "Simulator only", supervised: "Supervised", live_ready: "Live-ready" };

/** Money as separate per-currency figures. Never a sum. */
export function MoneyLine({ money, empty = "none", status }: { money: Record<string, number>; empty?: string; status?: Status }) {
  const parts = moneyParts(money);
  if (!parts.length) return <span className="text-[#98a2b3]">{empty}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {parts.map((p) => (
        <span key={p.currency} className={`font-semibold tabular-nums ${status === "blocked" ? "text-[#b42318]" : status === "ok" ? "text-[#067647]" : "text-[#101828]"}`}>
          {p.text}
        </span>
      ))}
      {parts.length > 1 && <span className="text-[11px] text-[#98a2b3]">separate currencies</span>}
    </span>
  );
}

/** One sentence that says where a business stands. */
export function businessSentence(b: BusinessStatus): string {
  if (b.controls.pauseConsequentialWrites) return `Consequential actions are paused${b.controls.reason ? ` — ${b.controls.reason}` : ""}.`;
  if (b.model.status === "unavailable") return "BARRY cannot understand customers right now.";
  if (b.incidents.high) return `${b.incidents.high} high incident${b.incidents.high === 1 ? "" : "s"} open; ${b.interventions} thing${b.interventions === 1 ? "" : "s"} wait on the owner.`;
  if (b.approvalsHeld) return `${b.approvalsHeld} held request${b.approvalsHeld === 1 ? "" : "s"} need a re-check by the owner.`;
  if (b.interventions) return `${b.interventions} thing${b.interventions === 1 ? "" : "s"} wait on the owner; ${b.conversations.last24h} conversation${b.conversations.last24h === 1 ? "" : "s"} in the last day.`;
  if (hasMoney(b.money.stuckWithOwner)) return "Money is waiting on the owner's decision.";
  return b.conversations.last24h ? `Running on its own — ${b.conversations.last24h} conversation${b.conversations.last24h === 1 ? "" : "s"} in the last day, nothing waits on a person.` : "Quiet — nothing open, nothing waits on a person.";
}

/** FLEET ROW — stacked and thumb-friendly on phones, one compact line on desktop. Tap → business focus. Never a wide table. */
export function BusinessRow({ b, now, pinned }: { b: BusinessStatus; now: Date; pinned?: boolean }) {
  const blocked = hasMoney(b.money.stuckWithOwner) || hasMoney(b.money.atRisk);
  return (
    <Link href={bizHref(b.id)} className="-mx-2 flex flex-col gap-2 rounded-xl px-2 py-3.5 hover:bg-[#f9fafb] md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] md:items-center md:gap-4" data-fleet-row={b.id}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusPill status={healthStatus(b)} />
        <span className="truncate text-[15px] font-semibold text-[#101828]">{b.name}</span>
        {pinned && <span aria-label="pinned" className="text-[11px] text-[#98a2b3]">pinned</span>}
      </div>
      <p className="min-w-0 text-[13px] leading-snug text-[#475467] md:truncate">{businessSentence(b)}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#667085] md:justify-end">
        <span>{STAGE_WORDS[b.stage]}</span>
        {b.incidents.high + b.incidents.medium > 0 && <span className="text-[#b54708]">{b.incidents.high + b.incidents.medium} incident{b.incidents.high + b.incidents.medium === 1 ? "" : "s"}</span>}
        {blocked && <span className="text-[#b42318]">money blocked</span>}
        <span className="tabular-nums">{b.conversations.latestActivityAt ? formatLocal(b.conversations.latestActivityAt, b.timezone, now) : "no conversations yet"}</span>
      </div>
    </Link>
  );
}

// ── Incidents ─────────────────────────────────────────────────────────────────────────────────────

export const SEVERITY: Record<Incident["severity"], Status> = { high: "blocked", medium: "attention", low: "neutral" };

export function IncidentItem({ i, businessId, businessName, timezone, now, back }: { i: Incident; businessId: string; businessName?: string; timezone: string; now: Date; back: string }) {
  const convo = i.links.conversationId ? `/hq/${encodeURIComponent(businessId)}/conversations/${encodeURIComponent(i.links.conversationId)}` : null;
  return (
    <div id={i.key} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={SEVERITY[i.severity]}>{i.severity}</StatusPill>
        {i.status === "acknowledged" && <StatusPill status="info">acknowledged</StatusPill>}
        {i.occurrences > 1 && <StatusPill status="neutral">recurring ×{i.occurrences}</StatusPill>}
        <span className="text-[15px] font-semibold text-[#101828]">{i.title}</span>
        {businessName && <span className="text-[12px] text-[#667085]">· {businessName}</span>}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[7rem_1fr]">
        <dt className="text-[#667085]">Impact</dt>
        <dd className="text-[#344054]">{i.impact}</dd>
        <dt className="text-[#667085]">Technical cause</dt>
        <dd className="text-[#344054]">{i.kind.replace(/_/g, " ")}{i.capability ? ` · ${i.capability}` : ""}{i.links.provider ? ` · ${i.links.provider}` : ""}</dd>
        <dt className="text-[#667085]">Next</dt>
        <dd className="font-medium text-[#101828]">{i.nextAction}</dd>
      </dl>
      <p className="text-[12px] text-[#98a2b3]">
        First {formatLocal(i.firstSeen, timezone, now)} · last {formatLocal(i.lastSeen, timezone, now)}
        {i.acknowledged ? ` · acknowledged ${formatLocal(i.acknowledged.at, timezone, now)} by ${i.acknowledged.by}${i.acknowledged.note ? ` — ${i.acknowledged.note}` : ""}` : ""}
      </p>
      <Disclosure summary="Evidence" muted>
        <ul className="space-y-0.5 text-[12px] text-[#475467]">
          {i.evidence.map((e, n) => (
            <li key={n}>{e}</li>
          ))}
          {convo && (
            <li>
              <Link href={convo} className="underline">Open the conversation ›</Link>
            </li>
          )}
        </ul>
      </Disclosure>
      <form action="/api/hq/incidents" method="post" className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="key" value={i.key} />
        <input type="hidden" name="back" value={back} />
        <input name="note" placeholder="Note (optional)" className={`${input} sm:max-w-xs`} />
        <div className="flex gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
          {i.status === "current" && <button name="action" value="acknowledge" className={button}>Acknowledge</button>}
          <button name="action" value="resolve" className={button}>Resolve</button>
        </div>
      </form>
    </div>
  );
}

/** Priority: new (unacknowledged) first, then high, then recurring, then active (recent). Pure. */
export function prioritizeIncidents<T extends { incident: Incident }>(rows: T[]): T[] {
  const sev = { high: 0, medium: 1, low: 2 } as const;
  return [...rows].sort((a, b) => {
    const ua = a.incident.status === "current" ? 0 : 1;
    const ub = b.incident.status === "current" ? 0 : 1;
    return ua - ub || sev[a.incident.severity] - sev[b.incident.severity] || b.incident.occurrences - a.incident.occurrences || b.incident.lastSeen.localeCompare(a.incident.lastSeen);
  });
}

// ── Founder controls: focused actions ─────────────────────────────────────────────────────────────

export function ControlActions({ b }: { b: BusinessStatusDetail }) {
  const c = b.controls;
  const api = "/api/hq/controls";
  const scope = `${b.name} only. Takes effect on the next customer message.`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#475467]">
        <StatusPill status={c.mode === "live" ? "ok" : c.mode === "supervised" ? "info" : "simulator"}>{c.mode.toUpperCase()}</StatusPill>
        {c.pauseConsequentialWrites ? <StatusPill status="blocked">Consequential actions paused</StatusPill> : <span>Consequential actions running</span>}
        {c.approvalRequiredForAll && <StatusPill status="attention">Approval for everything</StatusPill>}
        {c.pausedCapabilities.length > 0 && <span>Paused: {c.pausedCapabilities.join(", ")}</span>}
        {c.disabledChannels.length > 0 && <span>Channels off: {c.disabledChannels.join(", ")}</span>}
      </div>
      {c.updatedAt && <p className="text-[12px] text-[#98a2b3]">Last change {formatLocal(c.updatedAt, b.timezone, new Date(Date.parse(c.updatedAt)))} by {c.updatedBy ?? "founder"} — {c.reason}</p>}

      <Disclosure summary={c.pauseConsequentialWrites ? "Resume consequential actions" : CONTROL_ACTIONS.pause_writes.title}>
        <Confirmation action={api} hidden={{ businessId: b.id, pauseConsequentialWrites: c.pauseConsequentialWrites ? "false" : "true" }} title={c.pauseConsequentialWrites ? "Resume consequential actions" : CONTROL_ACTIONS.pause_writes.title} scope={scope} effect={c.pauseConsequentialWrites ? "Carts, checkouts, bookings, tickets and approval requests run again under the business's own rules." : CONTROL_ACTIONS.pause_writes.effect} reversibility={CONTROL_ACTIONS.pause_writes.reversibility} submit={c.pauseConsequentialWrites ? "Resume" : "Pause consequential actions"} danger={!c.pauseConsequentialWrites} />
      </Disclosure>
      <Disclosure summary={c.approvalRequiredForAll ? "Lift approval-for-everything" : CONTROL_ACTIONS.require_approval.title}>
        <Confirmation action={api} hidden={{ businessId: b.id, approvalRequiredForAll: c.approvalRequiredForAll ? "false" : "true" }} title={c.approvalRequiredForAll ? "Lift approval-for-everything" : CONTROL_ACTIONS.require_approval.title} scope={scope} effect={c.approvalRequiredForAll ? "The business's own rules decide again which actions need approval." : CONTROL_ACTIONS.require_approval.effect} reversibility={CONTROL_ACTIONS.require_approval.reversibility} submit={c.approvalRequiredForAll ? "Lift" : "Require approval for everything"} />
      </Disclosure>
      <Disclosure summary={CONTROL_ACTIONS.pause_capability.title}>
        <Confirmation action={api} hidden={{ businessId: b.id }} title={CONTROL_ACTIONS.pause_capability.title} scope={scope} effect={CONTROL_ACTIONS.pause_capability.effect} reversibility={CONTROL_ACTIONS.pause_capability.reversibility} submit="Apply paused capabilities">
          <label className="text-[12px] text-[#667085]">
            Paused capabilities (ids or actions, comma-separated; “support.*” pauses a family; empty = none)
            <input name="pausedCapabilities" defaultValue={c.pausedCapabilities.join(", ")} className={`${input} mt-1`} />
          </label>
        </Confirmation>
      </Disclosure>
      <Disclosure summary={CONTROL_ACTIONS.disable_channel.title}>
        <Confirmation action={api} hidden={{ businessId: b.id }} title={CONTROL_ACTIONS.disable_channel.title} scope={scope} effect={CONTROL_ACTIONS.disable_channel.effect} reversibility={CONTROL_ACTIONS.disable_channel.reversibility} submit="Apply channels">
          <label className="text-[12px] text-[#667085]">
            Disabled channels (comma-separated, e.g. whatsapp; empty = all enabled)
            <input name="disabledChannels" defaultValue={c.disabledChannels.join(", ")} className={`${input} mt-1`} />
          </label>
        </Confirmation>
      </Disclosure>
      <Disclosure summary={CONTROL_ACTIONS.change_mode.title}>
        <Confirmation action={api} hidden={{ businessId: b.id }} title={CONTROL_ACTIONS.change_mode.title} scope={scope} effect={CONTROL_ACTIONS.change_mode.effect} reversibility={CONTROL_ACTIONS.change_mode.reversibility} submit="Change mode">
          <label className="text-[12px] text-[#667085]">
            Mode
            <select name="mode" defaultValue={c.mode} className={`${input} mt-1`}>
              <option value="simulator">simulator — mock systems only</option>
              <option value="supervised">supervised — real systems may be connected; every incident reaches you</option>
              <option value="live">live</option>
            </select>
          </label>
        </Confirmation>
      </Disclosure>
    </div>
  );
}

// ── Launch ────────────────────────────────────────────────────────────────────────────────────────

export function LaunchGrouped({ grouped, level, reason }: { grouped: GroupedLaunch; level: string; reason: string }) {
  const status: Status = level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" ? "ok" : level === "NOT_READY" ? "not_ready" : "unknown";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl bg-[#f9fafb] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status} size="md">{level.replace(/_/g, " ").toLowerCase()}</StatusPill>
          <span className="text-[13px] text-[#475467]">{grouped.ready} ready · {grouped.blocked} blocked · {grouped.unknown} unknown</span>
        </div>
        {grouped.primary ? (
          <div>
            <p className="text-[15px] font-semibold text-[#101828]">{grouped.primary.item.status === "blocked" ? "Blocker" : "Needs proof"}: {grouped.primary.item.title}</p>
            <p className="text-[13px] text-[#475467]">{grouped.primary.item.blocker ?? grouped.primary.item.evidence}</p>
            {grouped.primary.item.nextAction && <p className="text-[13px] font-medium text-[#101828]">Next: {grouped.primary.item.nextAction} <span className="font-normal text-[#667085]">· {grouped.primary.item.responsibility.replace("_", " ")}</span></p>}
          </div>
        ) : (
          <p className="text-[13px] text-[#475467]">{reason}</p>
        )}
      </div>
      <div className="divide-y divide-[#f2f4f7]">
        {grouped.groups.map((g) => (
          <div key={g.id} className="py-3 first:pt-0 last:pb-0">
            <Disclosure
              open={g.blocked > 0 || g.unknown > 0}
              summary={
                <span className="flex flex-1 flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-[#101828]">{g.title}</span>
                  <span className="text-[12px] text-[#667085]">{g.ready} ready{g.blocked ? ` · ${g.blocked} blocked` : ""}{g.unknown ? ` · ${g.unknown} unknown` : ""}</span>
                  <StatusPill status={g.blocked ? "blocked" : g.unknown ? "unknown" : "ok"} />
                </span>
              }
            >
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <li key={i.id} className="text-[13px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusPill status={i.status === "ready" ? "ok" : i.status === "blocked" ? "blocked" : "unknown"}>{i.status === "unknown" ? "needs proof" : i.status}</StatusPill>
                      <span className="font-medium text-[#101828]">{i.title}</span>
                      <span className="text-[12px] text-[#98a2b3]">{i.responsibility.replace("_", " ")}{i.requiredForSupervised ? " · required" : " · for live"}</span>
                    </div>
                    <p className="text-[12px] text-[#667085]">{i.evidence}</p>
                    {i.blocker && <p className="text-[12px] text-[#b54708]">{i.blocker}{i.nextAction ? ` → ${i.nextAction}` : ""}</p>}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Activity ──────────────────────────────────────────────────────────────────────────────────────

const KIND_STATUS: Partial<Record<ActivityEvent["kind"], Status>> = { incident: "attention", founder_control: "info", delivery: "blocked" };

export function ActivityList({ events, timezone, now, showBusiness, empty }: { events: ActivityEvent[]; timezone: (e: ActivityEvent) => string; now: Date; showBusiness?: boolean; empty?: ReactNode }) {
  if (!events.length) return <EmptyState>{empty ?? "Nothing recorded yet. Effects, approvals, payments, handoffs and founder changes will show here with their evidence."}</EmptyState>;
  return (
    <Timeline>
      {events.map((e) => (
        <ActivityRow
          key={e.id}
          when={formatLocal(e.at, timezone(e), now)}
          what={
            <>
              {e.what}
              {e.simulated && <span className="ml-1 text-[11px] text-[#175cd3]">test</span>}
              {showBusiness && <span className="ml-1 text-[12px] text-[#98a2b3]">· {e.businessName}</span>}
            </>
          }
          who={e.forWhom}
          by={actorWords(e.by)}
          verified={e.verified}
          stillNeeded={e.stillNeeded}
          status={e.verified === "unverified" ? "attention" : KIND_STATUS[e.kind]}
          statusWord={e.verified === "unverified" ? "Not verified" : e.kind === "founder_control" ? "Founder" : e.kind === "incident" ? "Incident" : e.kind === "delivery" ? "Undelivered" : undefined}
          href={e.conversationId ? `/hq/${encodeURIComponent(e.businessId)}/conversations/${encodeURIComponent(e.conversationId)}` : undefined}
        />
      ))}
    </Timeline>
  );
}

// ── Release ───────────────────────────────────────────────────────────────────────────────────────

const RELEASE_STATUS: Record<ReleaseState["state"], Status> = { LIVE_PASSED: "ok", BLOCKED: "blocked", LIVE_PROOF_REQUIRED: "attention", LOCALLY_PROVEN: "info", DETERMINISTICALLY_PROVEN: "info", IMPLEMENTED: "neutral" };

export function ReleasePanel({ release, now }: { release: ReleaseState; now: Date }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={RELEASE_STATUS[release.state]} size="md">{release.state.replace(/_/g, " ").toLowerCase()}</StatusPill>
        <span className="text-[13px] text-[#475467]">{release.manifest.candidate}</span>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[7rem_1fr]">
        <dt className="text-[#667085]">SHA</dt>
        <dd><Technical>{release.sha ?? "local build"}</Technical></dd>
        <dt className="text-[#667085]">Preview</dt>
        <dd>{release.preview ? <a href={`https://${release.preview}`} className="underline">{release.preview}</a> : <span className="text-[#98a2b3]">none in this environment</span>}</dd>
        <dt className="text-[#667085]">Environment</dt>
        <dd>{release.environment}</dd>
        <dt className="text-[#667085]">Last verdict</dt>
        <dd>{release.verdict ? `${release.verdict.verdict} · ${release.verdict.sha.slice(0, 7)} · ${formatLocal(release.verdict.at, "UTC", now)} UTC${release.verdict.note ? ` — ${release.verdict.note}` : ""}` : "none recorded"}</dd>
      </dl>
      <ul className="space-y-1 text-[13px]">
        {release.gates.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-1.5">
            <StatusPill status={g.status === "pass" ? "ok" : g.status === "fail" ? "blocked" : "unknown"}>{g.status}</StatusPill>
            <span className="font-medium text-[#101828]">{g.label}</span>
            <span className="text-[12px] text-[#667085]">{g.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PinButton({ businessId, pinned, back }: { businessId: string; pinned: boolean; back: string }) {
  return (
    <form action="/api/hq/pins" method="post">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="back" value={back} />
      <button className={buttonQuiet}>{pinned ? "Unpin" : "Pin to Focus"}</button>
    </form>
  );
}

/** A small FocusItem list from fleet exceptions. */
export function ExceptionList({ items }: { items: { key: string; status: Status; title: string; why?: string; move?: string; href: string; rank?: number }[] }) {
  return (
    <FocusList>
      {items.map((x) => (
        <FocusItem key={x.key} rank={x.rank} status={x.status} title={x.title} why={x.why} move={x.move} href={x.href} />
      ))}
    </FocusList>
  );
}
