import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";
import { FLEET_SCOPE, currentRelease } from "@/lib/release/manifest";
import { listBusinessSummaries } from "@/lib/fixtures";
import { fleetTenant, fleetTenantIds, getBusinessStatus } from "@/lib/hq/fleet";
import { applyControlChange, CONTROL_ACTIONS, isNoop, loadControls, type BusinessControls, type ControlChange } from "@/lib/hq/controls";
import { proposeChange, proposePlan, type ProposalPlan } from "@/lib/hq/proposals";
import { currentAssignment, trackAssignment } from "@/lib/hq/runtime-assignment";
import { getCommercialFleet } from "@/lib/commercial/service";
import { monthPeriod } from "@/lib/commercial/cost";
import { loadValueAccount } from "@/lib/commercial/value";
import { STAGE_WORDS } from "@/lib/commercial/account";
import { hasMoney, moneyWords } from "@/lib/format/money";
import type { Money } from "@/lib/owner/revenue";
import { intentFromModel, interpretFounder, resolveBusinesses, UNSUPPORTED_HELP, type BusinessResolution, type DirectoryEntry, type FounderActionKind, type FounderInterpreter, type FounderIntent } from "./command";
import { businessDrilldown, founderBrief, loadFounderFleet, HEALTH_PHRASE, HEALTH_WORDS, type BriefItem } from "./read-model";

/**
 * FOUNDER BARRY COMMAND SERVICE — one path for every founder command:
 *
 *   founder identity → interpretation (rules; a model may only help interpret) → scope (fleet / business)
 *   → deterministic grounding (businesses resolved against the fleet directory; facts from read models)
 *   → authority (only the existing founder controls; everything else → proposal or refusal)
 *   → answer | confirmation → execution through the existing audited control → verification (durable
 *   state re-read) → durable trace (operator record `founder_command`, fleet scope).
 *
 * "Understand freely, ground deterministically, act only with explicit authority." The service never runs
 * SQL, touches env or secrets, deploys code, decides an owner's approval or changes an owner's policy.
 * A repeated key returns the recorded result; a confirmation executes at most once.
 */

export type FounderActor = { kind: "founder"; via: "session" | "token" | "test" };

export type FounderStatus = "answered" | "clarify" | "needs_confirmation" | "executed" | "no_change" | "proposed" | "handled" | "refused" | "failed";

export type FounderTraceStep = { step: "identity" | "interpretation" | "scope" | "grounding" | "authority" | "confirmation" | "execution" | "verification" | "proposal" | "reply"; outcome: "ok" | "blocked" | "failed" | "info"; detail: string; at: string };

export type AnswerItem = { title: string; detail?: string; href?: string; severity?: "high" | "medium" | "low" | "ok" | "info" };

export type FounderCommandRecord = {
  key: string;
  founder: string;
  text: string;
  intent: FounderIntent;
  interpretedBy: "rules" | "model";
  scope: { kind: "fleet" | "business"; businessIds: string[] };
  resolution: { matched: DirectoryEntry[]; ambiguous: { word: string; candidates: string[] }[] };
  grounded: string[];
  authority: string;
  status: FounderStatus;
  answer: string;
  items: AnswerItem[];
  followUps: string[];
  action?: { kind: FounderActionKind; businessId: string; businessName: string; change: ControlChange; title: string; effect: string; before: Partial<BusinessControls>; confirmedAt?: string; auditId?: string; verified?: boolean };
  proposalIds: string[];
  handled?: { done: string[]; proposed: string[]; leftForYou: string[] };
  verification?: string;
  stopReason?: string;
  trace: FounderTraceStep[];
  createdAt: string;
  updatedAt: string;
};

export type FounderReply = Pick<FounderCommandRecord, "key" | "status" | "answer" | "items" | "followUps" | "proposalIds" | "verification" | "stopReason"> & { intent: FounderIntent["family"]; scope: FounderCommandRecord["scope"]; confirmation?: { key: string; title: string; effect: string }; duplicate: boolean };

const KIND = "founder_command";

// ── Persistence ────────────────────────────────────────────────────────────────────────────────

export async function getFounderCommand(key: string): Promise<FounderCommandRecord | undefined> {
  const records = await getBackend().listOperatorRecords(FLEET_SCOPE, KIND);
  return records.find((r) => r.key === key)?.data as unknown as FounderCommandRecord | undefined;
}

export async function listFounderCommands(limit = 50): Promise<FounderCommandRecord[]> {
  const records = await getBackend().listOperatorRecords(FLEET_SCOPE, KIND);
  return records
    .map((r: OperatorRecord) => r.data as unknown as FounderCommandRecord)
    .filter((r) => r && typeof r.key === "string")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

async function save(r: FounderCommandRecord): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: r.key, data: r });
}

/** Mask anything that looks like a credential or a phone number before it is stored or echoed. */
export function redact(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer ••••")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "••••")
    .replace(/\b(?:sk|pk|rk|whsec|xox[abp])[-_][A-Za-z0-9_-]{6,}/g, "••••")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "••••")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => `••••${m.replace(/\D/g, "").slice(-2)}`);
}

function reply(r: FounderCommandRecord, duplicate: boolean): FounderReply {
  return {
    key: r.key,
    status: r.status,
    answer: r.answer,
    items: r.items,
    followUps: r.followUps,
    proposalIds: r.proposalIds,
    ...(r.verification ? { verification: r.verification } : {}),
    ...(r.stopReason ? { stopReason: r.stopReason } : {}),
    intent: r.intent.family,
    scope: r.scope,
    ...(r.status === "needs_confirmation" && r.action ? { confirmation: { key: r.key, title: r.action.title, effect: r.action.effect } } : {}),
    duplicate,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : w.endsWith("s") ? "es" : "s"}`;
const bizHref = (id: string, view?: string) => `/hq/${encodeURIComponent(id)}${view ? `?view=${view}` : ""}`;

export function fleetDirectory(): DirectoryEntry[] {
  return listBusinessSummaries().map((b) => ({ id: b.id, name: b.name }));
}

const ACTIONS: Record<FounderActionKind, { change: ControlChange; title: (n: string) => string; effect: string; key: keyof BusinessControls }> = {
  pause_business: { change: { pausedBusiness: true }, title: (n) => `Pause BARRY for ${n}`, effect: CONTROL_ACTIONS.pause_business.effect, key: "pausedBusiness" },
  resume_business: { change: { pausedBusiness: false }, title: (n) => `Resume ${n}`, effect: "BARRY answers on its channels and acts again under the business's own rules. Nothing else changes.", key: "pausedBusiness" },
  safe_mode_on: { change: { safeMode: true }, title: (n) => `Put ${n} in safe mode`, effect: CONTROL_ACTIONS.safe_mode.effect, key: "safeMode" },
  safe_mode_off: { change: { safeMode: false }, title: (n) => `Take ${n} out of safe mode`, effect: "Consequential actions follow the business's own rules again and proactive messages resume.", key: "safeMode" },
};

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────

export type FounderCommandInput = {
  actor: FounderActor;
  key: string;
  text?: string;
  /** Confirm the pending action recorded under this key. */
  confirmKey?: string;
  /** The business the conversation is about (follow-ups like "Why?"). Only a hint: grounded like any other. */
  context?: { businessId?: string };
  now?: Date;
  interpreter?: FounderInterpreter;
};

export async function executeFounderCommand(input: FounderCommandInput): Promise<FounderReply> {
  const now = input.now ?? new Date();
  const at = () => new Date().toISOString();
  if (!input.actor || input.actor.kind !== "founder") throw new Error("Founder BARRY needs an authenticated founder");
  if (input.confirmKey) return confirmFounderAction({ actor: input.actor, key: input.confirmKey, now });
  const key = input.key.slice(0, 120);
  const existing = await getFounderCommand(key);
  if (existing) return reply(existing, true);

  const text = redact((input.text ?? "").trim().replace(/\s+/g, " ").slice(0, 1000));
  const directory = fleetDirectory();
  const record: FounderCommandRecord = {
    key,
    founder: `founder (${input.actor.via})`,
    text,
    intent: { family: "unsupported", reason: UNSUPPORTED_HELP },
    interpretedBy: "rules",
    scope: { kind: "fleet", businessIds: [] },
    resolution: { matched: [], ambiguous: [] },
    grounded: [],
    authority: "read",
    status: "answered",
    answer: "",
    items: [],
    followUps: [],
    proposalIds: [],
    trace: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const step = (s: FounderTraceStep["step"], outcome: FounderTraceStep["outcome"], detail: string) => record.trace.push({ step: s, outcome, detail, at: at() });
  step("identity", "ok", `${record.founder} — authenticated by HQ`);

  // 1. Interpretation + business resolution (grounded against the fleet directory).
  let resolution: BusinessResolution = resolveBusinesses(text, directory);
  if (!resolution.matched.length && !resolution.ambiguous.length && input.context?.businessId) {
    const ctx = directory.find((d) => d.id === input.context!.businessId);
    if (ctx) resolution = { matched: [ctx], ambiguous: [] };
  }
  let intent = interpretFounder(text, { hasBusiness: resolution.matched.length > 0 });
  if (intent.family === "unsupported" && intent.reason === UNSUPPORTED_HELP && input.interpreter) {
    const raw = await input.interpreter(text).catch(() => undefined);
    const fromModel = intentFromModel(raw);
    if (fromModel) {
      intent = fromModel.intent;
      record.interpretedBy = "model";
      if (fromModel.businessHints.length) {
        const hinted = resolveBusinesses(fromModel.businessHints.join(" "), directory);
        resolution = { matched: [...new Map([...resolution.matched, ...hinted.matched].map((b) => [b.id, b])).values()], ambiguous: [...resolution.ambiguous, ...hinted.ambiguous] };
      }
    }
  }
  record.intent = intent;
  record.resolution = { matched: resolution.matched, ambiguous: resolution.ambiguous.map((a) => ({ word: a.word, candidates: a.candidates.map((c) => c.name) })) };
  step("interpretation", intent.family === "unsupported" ? "blocked" : "ok", `${intent.family}${"topic" in intent ? `:${intent.topic}` : ""}${"action" in intent ? `:${intent.action}` : ""}${"kind" in intent ? `:${intent.kind}` : ""}${"followUp" in intent ? `:${intent.followUp}` : ""} (${record.interpretedBy})`);
  const businessScoped = intent.family === "business_inspect" || intent.family === "founder_action" || intent.family === "proposal" || (intent.family === "initiative_read" && resolution.matched.length > 0);
  record.scope = businessScoped ? { kind: "business", businessIds: resolution.matched.map((b) => b.id) } : { kind: "fleet", businessIds: [] };
  step("scope", "ok", record.scope.kind === "fleet" ? "fleet" : `business: ${resolution.matched.map((b) => b.name).join(", ") || "none named"}`);

  try {
    await dispatch(record, intent, resolution, { now, step });
  } catch (err) {
    record.status = "failed";
    record.answer = "I couldn't complete that — nothing was changed.";
    record.stopReason = err instanceof Error ? redact(err.message).slice(0, 300) : "unknown error";
    step("reply", "failed", record.stopReason);
  }
  record.updatedAt = at();
  step("reply", record.status === "failed" || record.status === "refused" ? "blocked" : "ok", record.status);
  await save(record);
  return reply(record, false);
}

type Ctx = { now: Date; step: (s: FounderTraceStep["step"], outcome: FounderTraceStep["outcome"], detail: string) => void };

async function dispatch(r: FounderCommandRecord, intent: FounderIntent, res: BusinessResolution, ctx: Ctx): Promise<void> {
  const { step } = ctx;
  const needOne = (verb: string): DirectoryEntry | undefined => {
    if (res.ambiguous.length) {
      r.status = "clarify";
      r.stopReason = "ambiguous business";
      r.answer = `Which business do you mean? "${res.ambiguous[0].word}" fits ${res.ambiguous[0].candidates.map((c) => c.name).join(" and ")}. Nothing was ${verb}.`;
      r.followUps = res.ambiguous[0].candidates.map((c) => c.name);
      step("grounding", "blocked", r.stopReason);
      return undefined;
    }
    if (res.matched.length !== 1) {
      r.status = "clarify";
      r.stopReason = res.matched.length ? "more than one business" : "no business named";
      r.answer = res.matched.length ? `That names ${res.matched.map((b) => b.name).join(" and ")} — I do this one business at a time. Nothing was ${verb}.` : `Which business? I couldn't match one in the fleet. Nothing was ${verb}.`;
      r.followUps = res.matched.map((b) => b.name);
      step("grounding", "blocked", r.stopReason);
      return undefined;
    }
    step("grounding", "ok", `${res.matched[0].name} (${res.matched[0].id})`);
    return res.matched[0];
  };

  switch (intent.family) {
    case "unsupported": {
      r.status = "refused";
      r.authority = "none";
      r.answer = intent.reason;
      r.stopReason = intent.reason === UNSUPPORTED_HELP ? "not understood" : "outside founder authority";
      r.followUps = ["What do I need to know today?", "Which businesses need attention?"];
      step("authority", "blocked", r.stopReason);
      return;
    }
    case "fleet_read":
      return fleetRead(r, intent.topic, ctx);
    case "business_inspect": {
      const b = needOne("looked up");
      if (!b) return;
      return inspect(r, b, intent.followUp, ctx);
    }
    case "commercial_read":
      return commercialRead(r, intent.topic, ctx);
    case "value_read":
      return valueRead(r, ctx);
    case "incident_read":
      return incidentRead(r, intent.topic, ctx);
    case "initiative_read":
      return initiativeRead(r, res, ctx);
    case "release_read":
      return releaseRead(r, ctx);
    case "founder_action": {
      const b = needOne("changed");
      if (!b) return;
      return prepareAction(r, intent.action, b, ctx);
    }
    case "proposal": {
      if (res.ambiguous.length) {
        needOne("proposed");
        return;
      }
      if (!res.matched.length) {
        r.status = "clarify";
        r.stopReason = "no business named";
        r.answer = "Which businesses should the proposal cover? Name them — I don't prepare fleet-wide changes from a guess.";
        step("grounding", "blocked", r.stopReason);
        return;
      }
      return prepareProposal(r, intent.kind, res.matched, ctx);
    }
    case "handle_safe":
      return handleSafe(r, ctx);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

const briefItem = (i: BriefItem): AnswerItem => ({ title: i.title, detail: `${i.why}${i.why ? " " : ""}→ ${i.move}`, href: i.href, severity: i.severity });

async function fleetRead(r: FounderCommandRecord, topic: "brief" | "attention" | "changed", ctx: Ctx): Promise<void> {
  const view = await loadFounderFleet({ now: ctx.now });
  r.grounded.push(`fleet status at ${view.at} (${view.businesses.length} businesses)`, `${view.proposals.length} proposals`, view.release ? `release ${view.release.state}` : "release unavailable");
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  if (topic === "brief") {
    const brief = founderBrief(view);
    r.answer = brief.quiet ? brief.headline : [brief.headline, ...brief.items.map((i, n) => `${n + 1}. ${i.title} — ${i.why}`)].join("\n");
    r.items = brief.items.map(briefItem);
    if (brief.unavailable.length) r.answer += `\nCouldn't read: ${brief.unavailable.slice(0, 4).join("; ")}.`;
    r.followUps = brief.items.filter((i) => i.businessName).slice(0, 2).map((i) => `What's going on with ${i.businessName}?`).concat(["Handle what you safely can and leave me what needs approval."]);
    return;
  }
  if (topic === "attention") {
    const flagged = view.businesses.filter((b) => !["healthy", "not_enough_evidence"].includes(b.founderHealth.state));
    const thin = view.businesses.filter((b) => b.founderHealth.state === "not_enough_evidence");
    r.items = flagged.map((b) => ({ title: `${b.name} — ${b.founderHealth.words}`, detail: b.founderHealth.reasons.join(" "), href: bizHref(b.id, "attention"), severity: b.founderHealth.state === "degraded" || b.founderHealth.state === "blocked" ? "high" : b.founderHealth.state === "needs_attention" ? "medium" : "info" }));
    r.answer = [flagged.length ? `${plural(flagged.length, "business")} ${flagged.length === 1 ? "is" : "are"} not simply healthy:` : "No business needs attention by the records.", ...flagged.map((b) => `• ${b.name}: ${b.founderHealth.words} — ${b.founderHealth.reasons.join(" ")}`), thin.length ? `Not enough evidence to judge: ${thin.map((b) => b.name).join(", ")}.` : "", `Healthy: ${view.businesses.filter((b) => b.founderHealth.state === "healthy").map((b) => b.name).join(", ") || "none"}.`.replace(/\.\.$/, ".")].filter(Boolean).join("\n");
    r.followUps = flagged.slice(0, 2).map((b) => `What's going on with ${b.name}?`);
    return;
  }
  // changed: founder changes + activity in 24h, proposal decisions, Founder BARRY actions.
  const since = ctx.now.getTime() - 24 * 3600_000;
  const changes = view.fleet.summary.changed.filter((c) => c.at && Date.parse(c.at) >= since).map((c) => ({ at: c.at, what: `${c.name}: ${c.what}`, href: bizHref(c.id) }));
  const proposalChanges = view.proposals.flatMap((p) => p.history.filter((h) => Date.parse(h.at) >= since).map((h) => ({ at: h.at, what: `Proposal "${p.instruction.slice(0, 80)}" ${h.status}`, href: "/hq/proposals" })));
  const all = [...changes, ...proposalChanges].sort((a, b) => b.at.localeCompare(a.at));
  r.items = all.slice(0, 12).map((c) => ({ title: c.what, detail: c.at.slice(0, 16).replace("T", " ") + " UTC", href: c.href, severity: "info" }));
  r.answer = all.length ? [`${plural(all.length, "change")} in the last 24 hours:`, ...all.slice(0, 8).map((c) => `• ${c.what}`)].join("\n") : "Nothing changed in the last 24 hours by the records.";
}

async function inspect(r: FounderCommandRecord, b: DirectoryEntry, followUp: "overview" | "why" | "incidents" | "changed" | "options", ctx: Ctx): Promise<void> {
  const graph = fleetTenant(b.id);
  if (!graph) throw new Error("business not in the fleet");
  const d = await businessDrilldown(graph, { now: ctx.now });
  r.grounded.push(`status ${d.id}`, `controls ${d.id}`, `${d.incidents.length} open incidents`, d.commercial ? "commercial record" : "commercial unavailable", d.runtime ? `runtime ${d.runtime.version}` : "runtime unavailable");
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  r.followUps = ["Why?", "Show incident", "What changed?", "What can I do?"];
  const href = bizHref(d.id);
  if (followUp === "why") {
    r.answer = `${d.name} ${HEALTH_PHRASE[d.health.state]} because: ${d.health.reasons.join(" ") || "nothing on record says otherwise."}`;
    r.items = d.health.reasons.map((x) => ({ title: x, href }));
    return;
  }
  if (followUp === "incidents") {
    r.items = d.incidents.map((i) => ({ title: `${i.title} (${i.severity}, ${i.status})`, detail: `Since ${i.since.slice(0, 16).replace("T", " ")} → ${i.nextAction}`, href: `${href}#incidents`, severity: i.severity === "high" ? "high" : i.severity === "medium" ? "medium" : "low" }));
    r.answer = d.incidents.length ? [`${plural(d.incidents.length, "open incident")} at ${d.name}:`, ...d.incidents.map((i) => `• ${i.title} (${i.severity}, ${i.status}) → ${i.nextAction}`)].join("\n") : `${d.name} has no open incidents.`;
    return;
  }
  if (followUp === "changed") {
    r.answer = d.changed.length ? [`Recent at ${d.name}:`, ...d.changed.map((c) => `• ${c}`)].join("\n") : `Nothing recorded recently at ${d.name}.`;
    r.items = d.changed.map((c) => ({ title: c, href }));
    return;
  }
  if (followUp === "options") {
    r.items = d.options.map((o) => ({ title: o.title, detail: o.available ? o.effect : o.why, severity: o.available ? "info" : "low" }));
    r.answer = [`What you can do for ${d.name}:`, ...d.options.map((o) => `• ${o.title}${o.available ? ` — ${o.effect}` : ` (not now: ${o.why})`}`), "Each control asks you to confirm, runs through the audited founder control and is verified afterwards."].join("\n");
    r.followUps = d.options.filter((o) => o.available && o.action !== "proposal").map((o) => o.title);
    return;
  }
  const lines = [
    `${d.name} ${HEALTH_PHRASE[d.health.state]}${d.health.reasons.length ? ` — ${d.health.reasons[0]}` : ""}`,
    `Doing: ${d.doing.join("; ")}.`,
    d.waitingOn.length ? `Waiting on: ${d.waitingOn.join("; ")}.` : "Waiting on nobody.",
    d.incidents.length ? `Incidents: ${d.incidents.slice(0, 3).map((i) => `${i.title} (${i.severity})`).join("; ")}.` : "No open incidents.",
    d.initiatives.length ? `BARRY noticed: ${d.initiatives.slice(0, 2).map((i) => i.title).join("; ")}.` : "",
    d.commercial ? `Plan: ${d.commercial.plan ?? "none"} · ${d.commercial.stage}${d.commercial.price ? ` · ${d.commercial.price}` : ""}${d.commercial.alerts.length ? ` · ${d.commercial.alerts.slice(0, 2).join("; ")}` : ""}.` : "Commercial record unavailable.",
    d.value ? `Verified value: made ${d.value.made}; saved ${d.value.savedRealized}; ${d.value.handled}.` : "Value unavailable.",
    `Controls: ${d.controls.mode}${d.controls.paused ? " · PAUSED" : ""}${d.controls.safeMode ? " · safe mode" : ""}. Capabilities: ${d.capabilities.slice(0, 4).join("; ")}.`,
    d.runtime ? `Runtime ${d.runtime.version}${d.runtime.commit ? ` @ ${d.runtime.commit.slice(0, 7)}` : ""}; reasoner ${d.runtime.reasoner}.` : "",
    d.unavailable.length ? `Couldn't read: ${d.unavailable.slice(0, 3).join("; ")}.` : "",
  ].filter(Boolean);
  r.answer = lines.join("\n");
  r.items = [{ title: `Open ${d.name} in HQ`, href }];
}

async function commercialRead(r: FounderCommandRecord, topic: "cost_to_serve" | "plans", ctx: Ctx): Promise<void> {
  const graphs = fleetTenantIds().map((id) => fleetTenant(id)!).filter(Boolean);
  const cf = await getCommercialFleet(graphs, { now: ctx.now });
  r.grounded.push(`commercial fleet ${cf.period.label} (${cf.rows.length} businesses)`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  if (topic === "plans") {
    const mrr = Object.entries(cf.mrr).map(([c, v]) => `${v} ${c}`).join(" + ") || "none";
    r.items = cf.rows.map((x) => ({ title: `${x.name}: ${x.plan ?? "no plan"} · ${x.stageWords}`, detail: x.monthlyPrice !== null ? `${x.monthlyPrice} ${x.currency}/month` : undefined, href: "/hq/commercial" }));
    r.answer = [`Contracted MRR: ${mrr} (manual billing — contracted, not collected).`, `${cf.active} paid-active · ${cf.freeMonth} in the free month · ${cf.cancelled} cancelled.`, ...cf.rows.map((x) => `• ${x.name}: ${x.plan ?? "no plan"} — ${x.stageWords}`)].join("\n");
    return;
  }
  const known = cf.rows.filter((x) => x.costToServe !== null).sort((a, b) => (b.costToServe ?? 0) - (a.costToServe ?? 0));
  const unknown = cf.rows.filter((x) => x.costToServe === null);
  const basisWords = (b: string, complete: boolean) => `${b}${complete ? "" : ", lower bound — some categories have no record"}`;
  r.items = [...known.map((x) => ({ title: `${x.name}: ${x.costToServe} USD`, detail: `Cost to serve, ${cf.period.label} (${basisWords(x.costBasis, x.costComplete)})`, href: "/hq/commercial", severity: x.aboveGuardrail ? ("high" as const) : ("info" as const) })), ...unknown.map((x) => ({ title: `${x.name}: unavailable`, detail: "No cost record, model usage or support time this period.", href: "/hq/commercial", severity: "low" as const }))];
  r.answer = known.length
    ? [`Cost to serve this period (${cf.period.label}), highest first — measured where invoiced, estimated from model usage / support time otherwise:`, ...known.slice(0, 6).map((x, i) => `${i + 1}. ${x.name}: ${x.costToServe} USD (${basisWords(x.costBasis, x.costComplete)})${x.aboveGuardrail ? " — above the plan guardrail" : ""}`), unknown.length ? `Unavailable (no cost records): ${unknown.map((x) => x.name).join(", ")}.` : ""].filter(Boolean).join("\n")
    : `No cost-to-serve records exist for ${cf.period.label} — no measured invoices, no metered model usage, no support time — so I can't rank who costs the most. Nothing is estimated without a record.`;
}

async function valueRead(r: FounderCommandRecord, ctx: Ctx): Promise<void> {
  const period = monthPeriod(ctx.now);
  const ids = fleetTenantIds();
  const rows = await Promise.all(
    ids.map(async (id) => {
      const g = fleetTenant(id)!;
      const v = await loadValueAccount(g, period, ctx.now).catch(() => null);
      return { id, name: g.business.name, v };
    })
  );
  r.grounded.push(`value accounts ${period.label} (${rows.length})`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  const made = (v: NonNullable<(typeof rows)[number]["v"]>): Money => {
    const m: Money = { ...v.made.generated };
    for (const [c, n] of Object.entries(v.made.recovered)) m[c] = Math.round(((m[c] ?? 0) + n) * 100) / 100;
    return m;
  };
  const unavailable = rows.filter((x) => !x.v).map((x) => x.name);
  const judged = rows.filter((x) => x.v).map((x) => {
    const v = x.v!;
    const m = made(v);
    const verified = hasMoney(m) || hasMoney(v.saved.realized) || v.handled.outcomes > 0;
    return { ...x, m, verified, activityOnly: !verified && v.handled.conversations > 0 };
  });
  const weak = judged.filter((x) => !x.verified);
  r.items = weak.map((x) => ({ title: `${x.name}: ${x.activityOnly ? "activity, no verified outcome" : "no verified value yet"}`, detail: x.activityOnly ? `${plural(x.v!.handled.conversations, "conversation")} handled with no human; no provider-verified money, realized saving or completed outcome this period.` : "No handled conversations, verified money or realized savings this period.", href: bizHref(x.id), severity: x.activityOnly ? "low" : "medium" }));
  r.answer = [
    weak.length ? `By verified value this period (${period.label}) — provider-verified MADE, realized SAVED, completed outcomes; test money never counts:` : `Every business shows verified value this period (${period.label}).`,
    ...weak.map((x) => `• ${x.name}: ${x.activityOnly ? `${plural(x.v!.handled.conversations, "conversation")} handled, but no verified outcome or money` : "nothing verified yet"}${hasMoney(x.v!.made.excludedSimulated) ? ` (${moneyWords(x.v!.made.excludedSimulated)} simulated, not counted)` : ""}`),
    judged.filter((x) => x.verified).length ? `With verified value: ${judged.filter((x) => x.verified).map((x) => `${x.name}${hasMoney(x.m) ? ` (made ${moneyWords(x.m)})` : ""}`).join(", ")}.` : "",
    unavailable.length ? `Couldn't read value for: ${unavailable.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

const INTEGRATION_KINDS = new Set(["connection_unhealthy", "reverification_due", "undelivered_reply"]);

async function incidentRead(r: FounderCommandRecord, topic: "integrations" | "incidents", ctx: Ctx): Promise<void> {
  const view = await loadFounderFleet({ now: ctx.now });
  r.grounded.push(`fleet incidents at ${view.at}`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  const rows = view.businesses.flatMap((b) => b.incidents.open.filter((i) => topic === "incidents" || INTEGRATION_KINDS.has(i.kind)).map((i) => ({ b, i })));
  const channelDown = topic === "integrations" ? view.businesses.filter((b) => b.customerChannel === "degraded") : [];
  r.items = [...rows.map(({ b, i }) => ({ title: `${b.name}: ${i.title}`, detail: `${i.severity} · ${i.status} → ${i.nextAction}`, href: `${bizHref(b.id)}#incidents`, severity: i.severity })), ...channelDown.map((b) => ({ title: `${b.name}: customer channel degraded`, href: bizHref(b.id), severity: "medium" as const }))];
  if (!r.items.length) {
    r.answer = topic === "integrations" ? "No business has a broken integration by the records (connections, re-verification, reply delivery, channel health)." : "No open incidents across the fleet.";
    return;
  }
  const names = [...new Set([...rows.map((x) => x.b.name), ...channelDown.map((b) => b.name)])];
  r.answer = [`${topic === "integrations" ? "Broken integrations" : "Open incidents"} at ${names.join(", ")}:`, ...r.items.slice(0, 8).map((i) => `• ${i.title} (${i.detail ?? ""})`)].join("\n");
  r.followUps = names.slice(0, 2).map((n) => `What's going on with ${n}?`);
}

async function initiativeRead(r: FounderCommandRecord, res: BusinessResolution, ctx: Ctx): Promise<void> {
  const view = await loadFounderFleet({ now: ctx.now });
  const scoped = res.matched.length ? view.businesses.filter((b) => res.matched.some((m) => m.id === b.id)) : view.businesses;
  r.grounded.push(`persisted initiatives (${scoped.length} businesses)`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  // Titles and categories only — never evidence ids, customer names or message text.
  const rows = scoped.flatMap((b) => b.openInitiatives.map((i) => ({ b, i })));
  r.items = rows.map(({ b, i }) => ({ title: `${b.name}: ${i.title}`, detail: `${i.category.replace(/_/g, " ")} · ${i.importance} · ${i.state}`, href: bizHref(b.id), severity: i.importance === "high" ? "medium" : "info" }));
  r.answer = rows.length ? [`BARRY has ${plural(rows.length, "open initiative")} ${res.matched.length ? `at ${scoped.map((b) => b.name).join(", ")}` : `across ${plural(new Set(rows.map((x) => x.b.id)).size, "business")}`} (from persisted initiatives; the owner decides each):`, ...rows.slice(0, 8).map(({ b, i }) => `• ${b.name}: ${i.title} (${i.importance})`)].join("\n") : `BARRY hasn't noticed anything open ${res.matched.length ? `at ${scoped.map((b) => b.name).join(", ")}` : "across the fleet"} — no persisted initiative is open.`;
}

async function releaseRead(r: FounderCommandRecord, ctx: Ctx): Promise<void> {
  const rel = await currentRelease();
  r.grounded.push(`release manifest: ${rel.manifest.candidate}`, rel.verdict ? `work verdict ${rel.verdict.sha.slice(0, 7)}` : "no work verdict");
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  const failing = rel.gates.filter((g) => g.status !== "pass");
  r.items = rel.gates.map((g) => ({ title: `${g.label}: ${g.status}`, detail: g.detail, href: "/hq/releases", severity: g.status === "fail" ? "high" : g.status === "pass" ? "ok" : "info" }));
  r.answer = [
    `Release candidate: ${rel.state.replace(/_/g, " ").toLowerCase()} · ${rel.sha ? rel.sha.slice(0, 7) : "local build (no commit)"} · ${rel.environment}.`,
    rel.manifest.knownBlockers.length ? `Known blockers: ${rel.manifest.knownBlockers.join("; ")}.` : "No known blockers.",
    rel.nextProofRequired.length ? `Still needs live proof: ${rel.nextProofRequired.slice(0, 4).join("; ")}${rel.nextProofRequired.length > 4 ? ` (+${rel.nextProofRequired.length - 4})` : ""}.` : "",
    failing.length ? `Gates not passed: ${failing.map((g) => `${g.label} (${g.status})`).join(", ")}.` : "Every gate passes.",
    `Last Work verdict: ${rel.verdict ? `${rel.verdict.verdict} on ${rel.verdict.sha.slice(0, 7)}` : "none recorded"}.`,
  ].filter(Boolean).join("\n");
}

// ── Founder actions (existing controls only) ───────────────────────────────────────────────────

async function prepareAction(r: FounderCommandRecord, kind: FounderActionKind, b: DirectoryEntry, ctx: Ctx): Promise<void> {
  const a = ACTIONS[kind];
  const before = await loadControls(b.id);
  r.grounded.push(`controls ${b.id} (updated ${before.updatedAt ?? "never"})`);
  r.authority = "founder control (existing, audited; confirmation required)";
  ctx.step("authority", "ok", r.authority);
  const snapshot: Partial<BusinessControls> = { pausedBusiness: before.pausedBusiness, safeMode: before.safeMode };
  r.action = { kind, businessId: b.id, businessName: b.name, change: a.change, title: a.title(b.name), effect: a.effect, before: snapshot };
  if (isNoop(before, a.change)) {
    r.status = "no_change";
    r.verification = `${b.name}: ${String(a.key)} is already ${String(before[a.key])} (read from the durable controls).`;
    r.answer = `${b.name} is already ${kind === "pause_business" ? "paused" : kind === "resume_business" ? "running (not paused)" : kind === "safe_mode_on" ? "in safe mode" : "out of safe mode"}. Nothing to change.`;
    ctx.step("verification", "ok", r.verification);
    return;
  }
  r.status = "needs_confirmation";
  r.answer = `${a.title(b.name)}?\n${a.effect}\nConfirm to apply it through the audited founder control.`;
  r.followUps = ["Confirm"];
  ctx.step("confirmation", "info", "waiting for the founder to confirm");
}

/** Execute a confirmed pending action exactly once, then verify the durable state. */
export async function confirmFounderAction(input: { actor: FounderActor; key: string; now?: Date }): Promise<FounderReply> {
  if (!input.actor || input.actor.kind !== "founder") throw new Error("Founder BARRY needs an authenticated founder");
  const r = await getFounderCommand(input.key);
  if (!r) return { key: input.key, status: "refused", answer: "There is nothing waiting for confirmation under that key.", items: [], followUps: [], proposalIds: [], intent: "founder_action", scope: { kind: "business", businessIds: [] }, stopReason: "unknown key", duplicate: false };
  if (r.status !== "needs_confirmation" || !r.action) return reply(r, true);
  const at = () => new Date().toISOString();
  const step = (s: FounderTraceStep["step"], outcome: FounderTraceStep["outcome"], detail: string) => r.trace.push({ step: s, outcome, detail, at: at() });
  const a = r.action;
  step("confirmation", "ok", `confirmed by founder (${input.actor.via})`);
  // Claim the command before executing so a concurrent confirm sees it as taken.
  r.status = "executed";
  r.action.confirmedAt = (input.now ?? new Date()).toISOString();
  await save(r);
  try {
    const result = await applyControlChange(a.businessId, a.change, { by: "founder (Founder BARRY)", reason: `Founder BARRY: "${r.text}"`.slice(0, 500), now: input.now });
    r.action.auditId = result.audit?.id;
    step("execution", "ok", result.changed ? `applied via founder control; audit ${result.audit?.id}` : "no change needed");
    const after = await loadControls(a.businessId);
    const field = ACTIONS[a.kind].key;
    const expected = a.change[field as keyof ControlChange];
    const ok = after[field] === expected;
    r.action.verified = ok;
    r.verification = ok ? `${a.businessName}: ${String(field)} = ${String(after[field])} in the durable controls (updated ${after.updatedAt} by ${after.updatedBy}).` : `${a.businessName}: expected ${String(field)} = ${String(expected)}, durable state says ${String(after[field])}.`;
    step("verification", ok ? "ok" : "failed", r.verification);
    r.status = ok ? (result.changed ? "executed" : "no_change") : "failed";
    r.answer = ok ? `Done — ${a.title.replace(/^\w/, (c) => c.toLowerCase())}${a.title.endsWith(".") ? "" : "."} Verified in the durable controls; the audit records you, the time and the reason.` : `I applied the change but couldn't verify it: ${r.verification}`;
    r.followUps = a.kind === "pause_business" ? [`Resume ${a.businessName}`] : a.kind === "safe_mode_on" ? [`Take ${a.businessName} out of safe mode`] : [];
  } catch (err) {
    r.status = "failed";
    r.stopReason = err instanceof Error ? redact(err.message).slice(0, 300) : "unknown error";
    r.answer = "The control change failed; nothing was verified as changed.";
    step("execution", "failed", r.stopReason);
  }
  r.updatedAt = at();
  await save(r);
  return reply(r, false);
}

// ── Proposals (the existing HQ proposal architecture) ──────────────────────────────────────────

async function prepareProposal(r: FounderCommandRecord, kind: "rollout" | "runtime" | "capability" | "configuration", businesses: DirectoryEntry[], ctx: Ctx): Promise<void> {
  const rel = await currentRelease().catch(() => null);
  const currentState: string[] = [];
  const blockers: string[] = [];
  const evidence: string[] = [];
  for (const b of businesses) {
    const graph = fleetTenant(b.id)!;
    const s = await getBusinessStatus(graph, { now: ctx.now });
    const a = await currentAssignment(graph, ctx.now).catch(() => null);
    currentState.push(`${b.name}: ${s.controls.mode}${s.controls.pausedBusiness ? ", paused" : ""}${s.controls.safeMode ? ", safe mode" : ""}; runtime ${a?.runtime.version ?? "unknown"}${a?.runtime.commit ? ` @ ${a.runtime.commit.slice(0, 7)}` : ""}; readiness ${s.readiness.label}; ${plural(s.incidents.open.length, "open incident")}`);
    if (s.controls.pausedBusiness) blockers.push(`${b.name} is paused`);
    if (s.incidents.high) blockers.push(`${b.name} has ${plural(s.incidents.high, "high incident")}`);
    if (s.model.status === "unavailable") blockers.push(`${b.name}: AI unavailable`);
    evidence.push(`status:${b.id}@${ctx.now.toISOString()}`, ...(a ? [`runtime_assignment:${b.id}:${a.fingerprint}`] : []));
  }
  if (rel) {
    evidence.push(`release:${rel.state}:${rel.sha ?? "local"}`);
    if (kind === "rollout" && rel.manifest.knownBlockers.length) blockers.push(...rel.manifest.knownBlockers.map((k) => `release blocker: ${k}`));
    if (kind === "rollout" && rel.state !== "LIVE_PASSED") blockers.push(`release candidate is ${rel.state.replace(/_/g, " ").toLowerCase()} (not live-passed)`);
  }
  const names = businesses.map((b) => b.name).join(" and ");
  const target = rel?.sha ? rel.sha.slice(0, 7) : "the current candidate build";
  const plan: ProposalPlan = {
    goal: kind === "rollout" ? `Roll out ${target} to ${names}` : `${kind.replace(/^\w/, (c) => c.toUpperCase())} change for ${names}: "${r.text.slice(0, 200)}"`,
    currentState,
    proposedChange: kind === "rollout" ? `Move ${names} onto ${target}${rel ? ` (release state ${rel.state.replace(/_/g, " ").toLowerCase()})` : ""}.` : `As described: "${r.text.slice(0, 200)}" — to be specified before approval.`,
    expectedEffect: kind === "rollout" ? "The named businesses run the candidate's runtime; the others are unchanged." : "Only the named businesses are affected.",
    risks: [kind === "rollout" ? "A regression in the candidate would reach these businesses' customers." : "The change is not yet specified precisely.", ...(businesses.length > 1 ? ["More than one business at once."] : [])],
    blockers,
    requiredApproval: "Founder approval in HQ → Proposals. Activation stays gated: no per-business rollout / configuration mechanism exists in HQ yet, so approving it changes nothing by itself.",
    rollback: "Nothing is applied by this proposal; reject it to close it. A real rollout rolls back through the release lane.",
    evidence,
  };
  const ids = businesses.map((b) => b.id).sort();
  const dedupeKey = `founder:${kind}:${ids.join(",")}:${rel?.sha ?? "local"}`;
  r.authority = "proposal only (gated; needs founder approval)";
  ctx.step("authority", "ok", r.authority);
  const { proposal, created } = await proposePlan({ instruction: plan.goal, kind, businessIds: ids, plan, by: "founder (Founder BARRY)", dedupeKey, now: ctx.now });
  r.proposalIds = [proposal.id];
  r.grounded.push(...evidence);
  r.status = "proposed";
  r.items = [{ title: proposal.instruction, detail: `${proposal.status} · ${proposal.risk} risk${blockers.length ? ` · blockers: ${blockers.join("; ")}` : ""}`, href: "/hq/proposals", severity: blockers.length ? "medium" : "info" }];
  r.answer = [`${created ? "Prepared" : "Already prepared"}: ${plan.goal}. Proposal ${proposal.id} (${proposal.status}).`, `Now: ${currentState.join(" | ")}`, blockers.length ? `Blockers: ${blockers.join("; ")}.` : "No blockers on record.", "Nothing changes until you approve it — and activation is gated."].join("\n");
  ctx.step("proposal", "ok", `${created ? "created" : "existing"} ${proposal.id}`);
}

// ── Handle what you safely can ───────────────────────────────────────────────────────────────────

async function handleSafe(r: FounderCommandRecord, ctx: Ctx): Promise<void> {
  const view = await loadFounderFleet({ now: ctx.now });
  r.grounded.push(`fleet status at ${view.at}`);
  r.authority = "safe, no-approval bookkeeping only; every change of behaviour becomes a proposal";
  ctx.step("authority", "ok", r.authority);
  const done: string[] = [];
  const proposed: string[] = [];
  const left: string[] = [];
  let refreshed = 0;
  for (const b of view.businesses) {
    const graph = fleetTenant(b.id);
    if (!graph) continue;
    // Safe, observational: record the runtime assignment if it changed (never changes behaviour).
    const t = await trackAssignment(graph, ctx.now).catch(() => null);
    if (t?.changed) refreshed++;
    const h = b.founderHealth;
    if ((h.state === "degraded" || h.state === "blocked") && !b.controls.safeMode) {
      const p = await proposeChange({ instruction: `Safe mode for ${b.name} while it is ${h.words}: ${h.reasons.join(" ").slice(0, 300)}`, scope: "BUSINESS", change: { safeMode: true }, businessIds: [b.id], by: "founder (Founder BARRY)", now: ctx.now, dedupeKey: `founder:safe_mode:${b.id}`, source: "founder_barry" });
      r.proposalIds.push(p.id);
      proposed.push(`Safe mode for ${b.name} (${h.words}) — proposal ${p.id}`);
    }
    if (b.approvalsHeld) left.push(`${b.name}: ${plural(b.approvalsHeld, "held request")} — the owner decides`);
    if (b.commercialStage === "awaiting_recurring") left.push(`${b.name}: confirm the recurring start (${STAGE_WORDS[b.commercialStage]})`);
  }
  done.push(refreshed ? `Recorded the runtime assignment for ${plural(refreshed, "business")} that changed.` : "Checked runtime assignments — nothing changed.");
  const pending = view.proposals.filter((p) => p.status === "proposed" && !r.proposalIds.includes(p.id));
  for (const p of pending.slice(0, 5)) left.push(`Proposal: ${p.instruction.slice(0, 120)}`);
  r.handled = { done, proposed, leftForYou: left };
  r.status = "handled";
  r.items = [...done.map((d) => ({ title: d, severity: "ok" as const })), ...proposed.map((p) => ({ title: p, href: "/hq/proposals", severity: "medium" as const })), ...left.map((l) => ({ title: l, severity: "info" as const }))];
  r.answer = [`Handled: ${done.join(" ")}`, proposed.length ? `Prepared for your approval: ${proposed.join("; ")}.` : "Nothing needed a new proposal.", left.length ? `Left for you: ${left.join("; ")}.` : "Nothing else waits on you.", "I changed no business's behaviour, no owner rule and no customer policy."].join("\n");
  ctx.step("proposal", "ok", `${proposed.length} proposal(s); ${left.length} left for the founder`);
}

// ── Home (default view) ─────────────────────────────────────────────────────────────────────────

/** What needs you / what Founder BARRY handled / what changed — the default Founder BARRY view. */
export async function founderHome(now = new Date()) {
  const view = await loadFounderFleet({ now });
  const brief = founderBrief(view);
  const since = now.getTime() - 24 * 3600_000;
  const commands = await listFounderCommands(100).catch(() => [] as FounderCommandRecord[]);
  const handled = commands.filter((c) => Date.parse(c.updatedAt) >= since && ["executed", "proposed", "handled"].includes(c.status)).map((c) => ({ at: c.updatedAt, what: c.status === "executed" && c.action ? `${c.action.title} — ${c.action.verified ? "verified" : "unverified"}` : c.status === "proposed" ? `Prepared proposal: ${c.items[0]?.title ?? c.text}` : `Handled what was safe (${c.handled?.proposed.length ?? 0} proposal(s))` }));
  const changed = view.fleet.summary.changed.filter((c) => c.at && Date.parse(c.at) >= since).slice(0, 6).map((c) => ({ at: c.at, what: `${c.name}: ${c.what}`, href: bizHref(c.id) }));
  return { brief, handled, changed, health: view.businesses.map((b) => ({ id: b.id, name: b.name, state: b.founderHealth.state, words: HEALTH_WORDS[b.founderHealth.state] })) };
}
