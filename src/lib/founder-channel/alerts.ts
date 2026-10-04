import crypto from "node:crypto";
import { getBackend } from "@/lib/store";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import { withConversationLock, ConversationBusyError } from "@/lib/state/lock";
import { fleetTenant } from "@/lib/hq/fleet";
import { launchChecklist, type LaunchGate } from "@/lib/hq/launch";
import { getCommercialFleet } from "@/lib/commercial/service";
import { whatsappFounderConfig, whatsappFounderSender, whatsappRoleRouting } from "@/lib/channels/whatsapp";
import { deliverOwner, type OwnerOutbound, type OwnerSender } from "@/lib/owner-channel/transport";
import { loadFounderFleet, founderBrief, type FounderHealthState } from "@/lib/founder/read-model";
import { executeFounderCommand, listFounderCommands } from "@/lib/founder/command-service";
import { modelFounderComposer, type FounderComposer } from "@/lib/founder/voice";
import { founderLinkActive, founderRef, listFounderIdentities, maskedFounder, type FounderIdentity } from "./identity";
import { founderOutbound } from "./gateway";

/**
 * PROACTIVE FOUNDER WHATSAPP — BARRY tells the founder only what matters system-wide, from the same read models HQ
 * shows (incidents, founder health, the launch gate, the commercial guardrail):
 *
 *   critical incident · a business becomes blocked / degraded · a provider disconnects or needs re-auth · a business
 *   becomes READY for a supervised launch · its readiness regresses · repeated important failures · cost above the
 *   plan guardrail (only where cost records exist) · a business that needs the founder.
 *
 * Transitions (health, launch level) are detected against a durable per-business watch record, so a steady state
 * never re-alerts. Every item is announced to each founder identity at most once, ever; the items new in one run
 * are coalesced into ONE message. Outside WhatsApp's 24-hour window (no approved template configured) the notice is
 * recorded as blocked — never claimed as sent. Plus a concise daily founder brief, once per day, only when the
 * brief has something to say (a quiet fleet sends nothing).
 */

const KIND = "founder_state" as const;
const NOTICE = "founder_notice:";
const WATCH = "founder_watch:";
const JOB = "bg_job:founder:";
const WINDOW_MS = 24 * 3600_000;

export type FounderAlertCategory = "critical_incident" | "blocked" | "provider" | "launch_ready" | "launch_regressed" | "repeated_failures" | "cost" | "needs_founder";
export type FounderAlertItem = { key: string; category: FounderAlertCategory; businessId: string; businessName: string; text: string };
export type FounderNotice = { key: string; kind: "alert" | "daily"; ref: string; to: string; at: string; status: "sent" | "dry_run" | "failed" | "blocked"; reason?: string; text: string; items?: string[] };
type Watch = { businessId: string; health: FounderHealthState; launch: LaunchGate["level"] | null; at: string };

const h = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const PROVIDER_KINDS = new Set(["connection_unhealthy", "reverification_due"]);
const REPEAT_KINDS = new Set(["repeated_not_understood", "failed_write", "undelivered_reply", "unverified_effect", "blocked_write"]);

export async function listFounderNotices(): Promise<FounderNotice[]> {
  return (await getBackend().listOperatorRecords(FLEET_SCOPE, KIND)).filter((r) => r.key.startsWith(NOTICE)).map((r) => r.data as unknown as FounderNotice).sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * What the founder should hear about NOW, record-backed. `observe` updates the watch records (health / launch
 * transitions) — only the notification job observes; a read never consumes a transition.
 */
export async function founderAlertItems(opts: { now?: Date; observe?: boolean; launch?: boolean } = {}): Promise<FounderAlertItem[]> {
  const now = opts.now ?? new Date();
  const view = await loadFounderFleet({ now });
  const real = view.businesses.filter((b) => !b.demo);
  const watches = new Map((await getBackend().listOperatorRecords(FLEET_SCOPE, KIND)).filter((r) => r.key.startsWith(WATCH)).map((r) => [(r.data as unknown as Watch).businessId, r.data as unknown as Watch]));
  const items: FounderAlertItem[] = [];
  const add = (b: { id: string; name: string }, category: FounderAlertCategory, key: string, text: string) => items.push({ key, category, businessId: b.id, businessName: b.name, text });
  for (const b of real) {
    for (const i of b.incidents.open) {
      if (PROVIDER_KINDS.has(i.kind)) add(b, "provider", `provider:${b.id}:${i.key}:${i.firstSeen}`, `${b.name}: ${i.title} → ${i.nextAction}`);
      else if (i.severity === "high") add(b, "critical_incident", `incident:${b.id}:${i.key}:${i.firstSeen}`, `${b.name}: ${i.title} (high) → ${i.nextAction}`);
      else if (REPEAT_KINDS.has(i.kind) && i.occurrences >= 3) add(b, "repeated_failures", `repeat:${b.id}:${i.key}:${i.firstSeen}`, `${b.name}: ${i.title} — ${i.occurrences} times → ${i.nextAction}`);
    }
    const prev = watches.get(b.id);
    const state = b.founderHealth.state;
    if ((state === "blocked" || state === "degraded") && prev?.health !== state) add(b, "blocked", `health:${b.id}:${state}:${now.toISOString()}`, `${b.name} is ${state}: ${b.founderHealth.reasons.join(" ").slice(0, 200)}`);
    let level: LaunchGate["level"] | null = prev?.launch ?? null;
    if (opts.launch !== false) {
      const graph = fleetTenant(b.id);
      const gate = graph ? await launchChecklist(graph, { controls: b.controls }).catch(() => null) : null;
      if (gate) {
        level = gate.level;
        if (gate.level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" && prev?.launch !== gate.level) add(b, "launch_ready", `launch_ready:${b.id}:${now.toISOString()}`, `${b.name} is READY for a supervised design-partner launch (every required launch item has evidence).`);
        if (prev?.launch === "READY_FOR_SUPERVISED_DESIGN_PARTNER" && gate.level !== prev.launch) add(b, "launch_regressed", `launch_regressed:${b.id}:${now.toISOString()}`, `${b.name} is no longer launch-ready: ${gate.reason}`);
      }
    }
    if (opts.observe) await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: `${WATCH}${b.id}`, data: { businessId: b.id, health: state, launch: level, at: now.toISOString() } as unknown as Record<string, unknown> });
  }
  for (const n of view.fleet.summary.needFounder) if (real.some((b) => b.id === n.id)) add({ id: n.id, name: n.name }, "needs_founder", `needs_founder:${n.id}:${h(n.why)}`, `${n.name} needs you: ${n.why}`);
  const graphs = real.map((b) => fleetTenant(b.id)).filter((g): g is NonNullable<typeof g> => Boolean(g));
  const cf = await getCommercialFleet(graphs, { now }).catch(() => null);
  for (const r of cf?.rows ?? []) if (r.aboveGuardrail && r.costToServe !== null) add({ id: r.id, name: r.name }, "cost", `cost:${r.id}:${cf!.period.label}`, `${r.name}: cost to serve ${r.costToServe} USD this period (${r.costBasis}) is above the plan guardrail.`);
  return items;
}

async function deliverOnce(link: FounderIdentity, key: string, kind: FounderNotice["kind"], message: OwnerOutbound, sender: OwnerSender | undefined, now: Date, items?: string[]): Promise<FounderNotice | undefined> {
  const ref = founderRef(link.id);
  if ((await listFounderNotices()).some((n) => n.key === key)) return undefined;
  const base = { key, kind, ref, to: maskedFounder(link), at: now.toISOString(), text: message.text.slice(0, 800), ...(items ? { items } : {}) };
  let rec: FounderNotice;
  if (!sender) rec = { ...base, status: "blocked", reason: "BARRY's founder WhatsApp line isn't configured" };
  else if (!link.lastInboundAt || now.getTime() - Date.parse(link.lastInboundAt) > WINDOW_MS) rec = { ...base, status: "blocked", reason: "outside WhatsApp's 24-hour window — needs an approved message template (not configured)" };
  else {
    const d = await deliverOwner(sender, link.channelUserId, message, now);
    rec = { ...base, status: d.status === "blocked" ? "blocked" : d.status, ...(d.error ? { reason: d.error } : {}) };
  }
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: `${NOTICE}${key}`, data: rec as unknown as Record<string, unknown> });
  return rec;
}

/** The founder's sender: the founder line, or (identity role routing) the shared line this founder last wrote to. */
const founderSenderOrUndefined = (link?: FounderIdentity) => (whatsappFounderConfig().configured ? whatsappFounderSender() : whatsappRoleRouting() === "identity" && link?.lineId ? whatsappFounderSender(fetch, link.lineId) : undefined);
const activeFounders = async () => (await listFounderIdentities()).filter((l) => founderLinkActive(l).ok);

/** The language the founder last used with Founder BARRY on this identity (default English). */
async function founderLang(link: FounderIdentity): Promise<"en" | "he"> {
  const label = `founder (whatsapp ${maskedFounder(link)})`;
  const last = (await listFounderCommands(50).catch(() => [])).find((c) => c.founder === label);
  return last?.language ?? "en";
}

/** New system-level items → ONE coalesced message per founder identity; each item at most once, ever. */
export async function notifyFounderAlerts(opts: { sender?: OwnerSender; now?: Date; items?: FounderAlertItem[]; /** Limit to these identities (QA: synthetic founders only — never a real founder's notices). */ only?: (link: FounderIdentity) => boolean } = {}): Promise<FounderNotice[]> {
  const now = opts.now ?? new Date();
  const to = (await activeFounders()).filter((l) => !opts.only || opts.only(l));
  if (!to.length) return [];
  const items = opts.items ?? (await founderAlertItems({ now, observe: true }));
  if (!items.length) return [];
  const notices = await listFounderNotices();
  const out: FounderNotice[] = [];
  for (const link of to) {
    const ref = founderRef(link.id);
    const told = new Set(notices.filter((n) => n.ref === ref && n.kind === "alert").flatMap((n) => n.items ?? []));
    const fresh = items.filter((i) => !told.has(i.key));
    if (!fresh.length) continue;
    const he = (await founderLang(link)) === "he";
    const head = fresh.length === 1 ? (he ? "לתשומת לבך:" : "Heads up:") : he ? `${fresh.length} דברים ברמת המערכת:` : `${fresh.length} system-level things:`;
    const text = `${head}\n${fresh.slice(0, 6).map((i) => `• ${i.text}`).join("\n")}${fresh.length > 6 ? (he ? `\n…ועוד ${fresh.length - 6}.` : `\n…and ${fresh.length - 6} more.`) : ""}`;
    const keys = fresh.map((i) => i.key);
    const rec = await deliverOnce(link, `alert:${h(keys.join("|"))}:${ref}`, "alert", { text }, opts.sender ?? founderSenderOrUndefined(link), now, keys);
    if (rec) out.push(rec);
  }
  return out;
}

/** The concise daily founder brief — the SAME brief Founder BARRY gives in HQ; nothing when the fleet is quiet. */
export async function sendFounderDailyBrief(opts: { sender?: OwnerSender; now?: Date; composer?: FounderComposer | null; only?: (link: FounderIdentity) => boolean } = {}): Promise<FounderNotice[]> {
  const now = opts.now ?? new Date();
  const to = (await activeFounders()).filter((l) => !opts.only || opts.only(l));
  if (!to.length) return [];
  const brief = founderBrief(await loadFounderFleet({ now }));
  if (brief.quiet) return [];
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.BARRY_FOUNDER_TIMEZONE || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const out: FounderNotice[] = [];
  for (const link of to) {
    const ref = founderRef(link.id);
    const key = `daily:${day}:${ref}`;
    if ((await listFounderNotices()).some((n) => n.key === key)) continue;
    const he = (await founderLang(link)) === "he";
    const composer = opts.composer === null ? undefined : (opts.composer ?? modelFounderComposer());
    const reply = await executeFounderCommand({ actor: { kind: "founder", via: "whatsapp", identity: maskedFounder(link) }, key: `founder-daily:${day}:${ref}`, text: he ? "מה אני צריך לדעת היום?" : "What do I need to know today?", now, ...(composer ? { composer } : {}) });
    const rec = await deliverOnce(link, key, "daily", founderOutbound(reply), opts.sender ?? founderSenderOrUndefined(link), now);
    if (rec) out.push(rec);
  }
  return out;
}

export const FOUNDER_BRIEF_HOURS = { start: 8, end: 11 } as const;
export type FounderJobOutcome = { job: "founder_alerts" | "founder_brief"; slot: string | null; decision: "ran" | "skipped" | "failed"; reason: string; notices?: { sent: number; dryRun: number; blocked: number; failed: number } };

/** Fleet-level founder jobs for a background tick: alerts hourly, the brief once a day (founder's timezone, 08–11). */
export async function runFounderJobs(opts: { now?: Date } = {}): Promise<FounderJobOutcome[]> {
  const now = opts.now ?? new Date();
  const tz = process.env.BARRY_FOUNDER_TIMEZONE || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  const jobs: { job: FounderJobOutcome["job"]; slot: string | null; run: () => Promise<FounderNotice[]> }[] = [
    { job: "founder_alerts", slot: `${date}T${parts.hour}`, run: () => notifyFounderAlerts({ now }) },
    { job: "founder_brief", slot: hour >= FOUNDER_BRIEF_HOURS.start && hour < FOUNDER_BRIEF_HOURS.end ? date : null, run: () => sendFounderDailyBrief({ now }) },
  ];
  const out: FounderJobOutcome[] = [];
  for (const j of jobs) {
    if (!j.slot) {
      out.push({ job: j.job, slot: null, decision: "skipped", reason: `outside the window (${FOUNDER_BRIEF_HOURS.start}:00–${FOUNDER_BRIEF_HOURS.end}:00 ${tz})` });
      continue;
    }
    const slotKey = `${JOB}${j.job}:${j.slot}`;
    try {
      out.push(
        await withConversationLock(`bg:fleet:${j.job}`, async () => {
          if ((await getBackend().listOperatorRecords(FLEET_SCOPE, KIND)).some((r) => r.key === slotKey)) return { job: j.job, slot: j.slot, decision: "skipped" as const, reason: `slot ${j.slot} already ran` };
          await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: slotKey, data: { at: now.toISOString(), status: "claimed" } });
          const recs = await j.run();
          const n = (s: string) => recs.filter((r) => r.status === s).length;
          await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: slotKey, data: { at: now.toISOString(), status: "ran", notices: recs.length } });
          return { job: j.job, slot: j.slot, decision: "ran" as const, reason: recs.length ? `${recs.length} notice(s)` : "nothing to tell", notices: { sent: n("sent"), dryRun: n("dry_run"), blocked: n("blocked"), failed: n("failed") } };
        }, { waitMs: 0, ttlMs: 120_000 })
      );
    } catch (err) {
      out.push({ job: j.job, slot: j.slot, decision: err instanceof ConversationBusyError ? "skipped" : "failed", reason: err instanceof ConversationBusyError ? "another run holds this job" : (err instanceof Error ? err.message : "failed").slice(0, 200) });
    }
  }
  return out;
}
