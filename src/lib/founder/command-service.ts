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
import { intentFromModel, interpretFounder, resolveBusinesses, UNSUPPORTED_HELP, type BusinessResolution, type CapabilityFamily, type DirectoryEntry, type FounderActionKind, type FounderInterpreter, type FounderIntent, type FounderMode } from "./command";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { launchChecklist } from "@/lib/hq/launch";
import { globalApprovals } from "@/lib/hq/console";
import { costToServe, listCostRecords, listModelUsage, listSupportTime } from "@/lib/commercial/cost";
import { runInitiativeScan } from "@/lib/initiative/engine";
import { actionEffect, actionTitle, askedText, doneText, failedText, followUpFor, noChangeText, replayText, unverifiedText, verifiedText, type Lang } from "./i18n";
import { languageOf, voice, type FounderComposer, type FounderEnvelope } from "./voice";
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

/** The authenticated founder. `whatsapp` = a verified, active founder channel identity (see lib/founder-channel). */
export type FounderActor = { kind: "founder"; via: "session" | "token" | "test" | "whatsapp"; /** Masked channel identity ("···1234"), for the audit. */ identity?: string };
/** Who the audit names for a founder control: HQ's founder, or the founder on a verified channel identity. */
export const founderControlBy = (a: FounderActor) => (a.via === "whatsapp" ? `founder (Founder BARRY, WhatsApp ${a.identity ?? ""})`.replace(" )", ")") : "founder (Founder BARRY)");

/** "received" = the command is durably recorded and still being worked on (a lost response can be recovered by key). */
export type FounderStatus = "received" | "answered" | "clarify" | "needs_confirmation" | "executed" | "no_change" | "proposed" | "handled" | "refused" | "failed";

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
  action?: { kind: FounderActionKind; businessId: string; businessName: string; change: ControlChange; title: string; effect: string; before: Partial<BusinessControls>; /** The capability family / mode the control targets (titles and verification). */ detail?: string; /** True when the control LOOSENS authority (said explicitly in the confirmation). */ loosens?: boolean; confirmedAt?: string; auditId?: string; verified?: boolean };
  proposalIds: string[];
  /** initiative_scan: what the existing Initiative Engine reported (counts and reasons only — no evidence, no customer text). */
  scan?: { scanId: string; businessId: string; trigger: string; forced: boolean; skipped: string | null; candidates: number; verified: number; rejected: number; created: number; updated: number; surfaced: number; suppressed: number; resolved: number; open: number };
  handled?: { done: string[]; proposed: string[]; leftForYou: string[] };
  verification?: string;
  stopReason?: string;
  /** The deterministic grounded reply (the truth `answer` was voiced from; equal to `answer` when not composed). */
  groundedAnswer?: string;
  /** Who worded `answer`: the conversation composer (checked against the envelope) or the grounded text. */
  voice?: { source: "composer" | "grounded"; reason?: string };
  /** The language of the founder's ORIGINAL command: a confirmation (a later request) answers in the same language. */
  language?: Lang;
  /** A follow-up that leaned on the previous command (context only — every fact was re-grounded). */
  followUpOf?: string;
  trace: FounderTraceStep[];
  createdAt: string;
  updatedAt: string;
};

export type FounderReply = Pick<FounderCommandRecord, "key" | "status" | "answer" | "items" | "followUps" | "proposalIds" | "verification" | "stopReason"> & { intent: FounderIntent["family"]; scope: FounderCommandRecord["scope"]; confirmation?: { key: string; title: string; effect: string; /** The title in the founder's language (for the Confirm button). */ label: string }; duplicate: boolean; voice?: "composer" | "grounded"; /** The founder's language for this conversation turn (drives the few UI words around a confirmation). */ language: Lang; /** True when this reply answers a confirmation that was ALREADY used: nothing ran, the original result is unchanged. */ replay?: boolean };

const KIND = "founder_command";

// ── Persistence ────────────────────────────────────────────────────────────────────────────────

export async function getFounderCommand(key: string): Promise<FounderCommandRecord | undefined> {
  const records = await getBackend().listOperatorRecords(FLEET_SCOPE, KIND);
  return records.find((r) => r.key === key)?.data as unknown as FounderCommandRecord | undefined;
}

/**
 * Recover a command's reply by its key (the client generated the key before sending, so a response lost in
 * transit is recoverable without sending the command again). READ-ONLY: never runs, retries or confirms anything.
 * `settled` is false while the command is still being worked on — including a confirmed control whose change
 * has been claimed but not yet verified.
 */
export async function lookupFounderReply(key: string): Promise<{ found: false } | { found: true; settled: boolean; reply: FounderReply }> {
  const r = await getFounderCommand(key.slice(0, 120));
  if (!r) return { found: false };
  const settled = r.status !== "received" && !(r.status === "executed" && r.action && r.action.verified === undefined && !r.stopReason);
  return { found: true, settled, reply: reply(r, true) };
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
    ...(r.status === "needs_confirmation" && r.action ? { confirmation: { key: r.key, title: r.action.title, effect: r.action.effect, label: actionTitle(r.language ?? languageOf(r.text), r.action.kind, r.action.businessName, r.action.detail) } } : {}),
    duplicate,
    language: r.language ?? languageOf(r.text),
    ...(r.voice ? { voice: r.voice.source } : {}),
  };
}

/** The immutable truth of a turn, for the conversation layer. */
function envelopeOf(r: FounderCommandRecord, question: string): FounderEnvelope {
  return {
    question: question.slice(0, 500),
    language: languageOf(question),
    intent: r.intent.family,
    status: r.status,
    grounded: r.answer,
    items: r.items.slice(0, 10).map((i) => ({ title: i.title, ...(i.detail ? { detail: i.detail } : {}) })),
    done: r.status === "executed" ? [r.verification ?? r.answer].filter(Boolean) : [],
    notDone: [r.stopReason ?? "", r.status === "proposed" ? "the proposal is only prepared — nothing changes until the founder approves it" : "", r.status === "needs_confirmation" ? "nothing has changed yet" : ""].filter(Boolean),
    confirmationRequired: r.status === "needs_confirmation" && r.action ? r.action.title : null,
    nothingSent: true,
    proposals: r.proposalIds,
    businessesInScope: r.resolution.matched.map((b) => b.name),
    followUps: r.followUps,
  };
}

const MIN = 60_000;
/** A short yes to a pending control ("yes", "do it", "כן") — only ever against the exact pending command. */
const CONFIRM_WORDS = /^(?:yes|yep|yeah|ok(?:ay)?|sure|do (?:it|that)|go ahead|confirm(?:ed)?|please do|כן|תעשה(?: את זה)?|סבבה|אשר|תאשר|יאללה)[\s.!]*$/i;
/** "and Rina?" / "what about Midtown?" / "ומה עם רינה?" — the previous question, about another business. */
const ELLIPSIS = /^(?:and|what about|how about|same for|also)\s+(.+?)[?.!]*$|^(?:ו?מה עם|וגם)\s+(.+?)[?.!]*$/i;
const OTHER_ONE = /\b(?:the other one|the other)\b|השני(?:ה)?\b/i;
const REAL_MONEY = /\b(?:is (?:that|this|it) (?:actually |really )?real(?: money)?|are (?:these|those) real|real money|is that verified)\b|כסף אמיתי|זה אמיתי/i;
const BUSINESS_SCOPED = new Set(["business_inspect", "initiative_scan", "founder_action", "proposal", "initiative_read"]);

/** What a figure in the previous answer is made of — so "is that real money?" gets a grounded answer. */
function basisOf(prev: FounderCommandRecord): string {
  switch (prev.intent.family) {
    case "commercial_read":
      return "No — those are costs, not money in. They're ESTIMATED from provider-reported token usage priced on the versioned rate card (MEASURED only where an invoice was recorded), and categories with no record are left out, so they're a lower bound.";
    case "value_read":
      return "Only provider-verified payments count as money BARRY made; simulated / test money is excluded and shown apart, and savings count only once realized.";
    case "initiative_scan":
    case "initiative_read":
      return "The amounts in those findings are what the business's own records hold (open payment links, carts, orders) — money at stake, not money collected. Nothing counts as recovered until the payment provider verifies it.";
    case "fleet_read":
    case "business_inspect":
      return "Money in that answer is either waiting on an owner decision or at risk on open records — it isn't revenue. Revenue counts only provider-verified payments; simulated money never counts.";
    default:
      return `That answer came only from these records: ${prev.grounded.slice(0, 4).join(" · ") || "none"}.`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : w.endsWith("s") ? "es" : "s"}`;
const bizHref = (id: string, view?: string) => `/hq/${encodeURIComponent(id)}${view ? `?view=${view}` : ""}`;

export function fleetDirectory(): DirectoryEntry[] {
  return listBusinessSummaries().map((b) => {
    let aliases: string[] = [];
    try {
      aliases = resolveBusinessGraph(b.id).business.aliases ?? [];
    } catch {
      /* the name alone */
    }
    return { id: b.id, name: b.name, ...(aliases.length ? { aliases } : {}) };
  });
}

type ActionSpec = { change: ControlChange; title: (n: string) => string; effect: string; key: keyof BusinessControls; detail?: string; loosens?: boolean };
const CAP_WORDS: Record<CapabilityFamily, string> = { payments: "payments", commerce: "carts and orders", scheduling: "bookings", support: "support tickets", messaging: "outbound messages", shipping: "shipping" };

/**
 * The exact founder-control change for a requested action, given the business's CURRENT controls (a capability
 * pause adds / removes one family from the list). Every one is an existing HQ control applied through
 * applyControlChange; nothing here invents a lever. undefined + reason = the request can't be made precise.
 */
function actionSpec(kind: FounderActionKind, before: BusinessControls, target: { capability?: CapabilityFamily; mode?: FounderMode }): ActionSpec | { refused: string } {
  switch (kind) {
    case "pause_business":
      return { change: { pausedBusiness: true }, title: (n) => `Pause BARRY for ${n}`, effect: CONTROL_ACTIONS.pause_business.effect, key: "pausedBusiness" };
    case "resume_business":
      return { change: { pausedBusiness: false }, title: (n) => `Resume ${n}`, effect: "BARRY answers on its channels and acts again under the business's own rules. Nothing else changes.", key: "pausedBusiness", loosens: true };
    case "safe_mode_on":
      return { change: { safeMode: true }, title: (n) => `Put ${n} in safe mode`, effect: CONTROL_ACTIONS.safe_mode.effect, key: "safeMode" };
    case "safe_mode_off":
      return { change: { safeMode: false }, title: (n) => `Take ${n} out of safe mode`, effect: "Consequential actions follow the business's own rules again and proactive messages resume.", key: "safeMode", loosens: true };
    case "require_approval_on":
      return { change: { approvalRequiredForAll: true }, title: (n) => `Require approval for every consequential action at ${n}`, effect: CONTROL_ACTIONS.require_approval.effect, key: "approvalRequiredForAll" };
    case "require_approval_off":
      return { change: { approvalRequiredForAll: false }, title: (n) => `Lift approval-for-everything at ${n}`, effect: "This LOOSENS control: consequential actions follow the business's own rules again (pending requests stay pending).", key: "approvalRequiredForAll", loosens: true };
    case "pause_capability":
    case "resume_capability": {
      if (!target.capability) return { refused: "Which capability? Say payments, carts / orders, bookings, support, outbound messages or shipping. Nothing was changed." };
      const fam = `${target.capability}.*`;
      const list = kind === "pause_capability" ? [...new Set([...before.pausedCapabilities, fam])] : before.pausedCapabilities.filter((c) => c !== fam);
      const words = CAP_WORDS[target.capability];
      return kind === "pause_capability"
        ? { change: { pausedCapabilities: list }, title: (n) => `Pause ${words} at ${n}`, effect: `${CONTROL_ACTIONS.pause_capability.effect} (${fam})`, key: "pausedCapabilities", detail: target.capability }
        : { change: { pausedCapabilities: list }, title: (n) => `Resume ${words} at ${n}`, effect: `This LOOSENS control: ${words} (${fam}) run again under the business's own rules.`, key: "pausedCapabilities", detail: target.capability, loosens: true };
    }
    case "set_mode": {
      if (!target.mode) return { refused: "Which mode — simulator or supervised? Nothing was changed." };
      // LIVE removes the supervision step; it is switched in HQ controls after the launch review, never from a chat.
      if (target.mode === "live") return { refused: "Switching a business to LIVE is done in HQ → Controls after the launch review, not from a conversation. Nothing was changed." };
      const order = { simulator: 0, supervised: 1, live: 2 } as const;
      return { change: { mode: target.mode }, title: (n) => `Switch ${n} to ${target.mode!.toUpperCase()} mode`, effect: CONTROL_ACTIONS.change_mode.effect, key: "mode", detail: target.mode, loosens: order[target.mode] > order[before.mode] };
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────

export type FounderCommandInput = {
  actor: FounderActor;
  key: string;
  text?: string;
  /** Confirm the pending action recorded under this key. */
  confirmKey?: string;
  /** The business the conversation is about (follow-ups like "Why?"). Only a hint: grounded like any other. */
  context?: { businessId?: string };
  /** The previous command in this conversation: context for follow-ups, never truth or authority. */
  previousKey?: string;
  now?: Date;
  interpreter?: FounderInterpreter;
  /** Optional conversation composer (wording only; checked against the envelope, falls back to the grounded text). */
  composer?: FounderComposer;
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
  // Conversation context: the previous command, only while it is fresh. It shapes interpretation; every fact
  // is still re-grounded and every action still needs its own authority.
  const prevRecord = input.previousKey ? await getFounderCommand(input.previousKey).catch(() => undefined) : undefined;
  const prevAge = prevRecord ? now.getTime() - Date.parse(prevRecord.updatedAt) : Infinity;
  const previous = prevRecord && prevAge < 30 * MIN ? prevRecord : undefined;
  // "yes" / "do it" → confirm EXACTLY the pending control of the previous turn (fresh, still pending), nothing else.
  if (CONFIRM_WORDS.test(text) && previous?.status === "needs_confirmation" && prevAge < 10 * MIN) {
    return confirmFounderAction({ actor: input.actor, key: previous.key, now });
  }
  const record: FounderCommandRecord = {
    key,
    founder: input.actor.via === "whatsapp" ? `founder (whatsapp ${input.actor.identity ?? ""})`.replace(" )", ")") : `founder (${input.actor.via})`,
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
    language: languageOf(text),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const step = (s: FounderTraceStep["step"], outcome: FounderTraceStep["outcome"], detail: string) => record.trace.push({ step: s, outcome, detail, at: at() });
  step("identity", "ok", input.actor.via === "whatsapp" ? `${record.founder} — verified founder channel identity (active link, current founder credential)` : `${record.founder} — authenticated by HQ`);
  // Durable BEFORE any work: if the phone loses the response, the client recovers this key (and a repeated key
  // finds it) instead of the command ever running a second time.
  await save({ ...record, status: "received" });

  // 1. Interpretation + business resolution (grounded against the fleet directory).
  let resolution: BusinessResolution = resolveBusinesses(text, directory);
  if (!resolution.matched.length && !resolution.ambiguous.length && input.context?.businessId) {
    const ctx = directory.find((d) => d.id === input.context!.businessId);
    if (ctx) resolution = { matched: [ctx], ambiguous: [] };
  }
  let intent = interpretFounder(text, { hasBusiness: resolution.matched.length > 0 });
  let followUpBasis: string | undefined;
  let usedContext = false;
  if (CONFIRM_WORDS.test(text)) {
    intent = { family: "unsupported", reason: "There's nothing waiting for your confirmation right now — say exactly what you want done." };
  } else if (previous) {
    const ellipsis = text.match(ELLIPSIS);
    if (REAL_MONEY.test(text)) {
      followUpBasis = basisOf(previous);
      intent = previous.intent;
      usedContext = true;
    } else if (OTHER_ONE.test(text)) {
      // "the other one": the previous turn named exactly two businesses; the one not currently in focus.
      const named = [...previous.resolution.matched.map((b) => b.id), ...previous.resolution.ambiguous.flatMap((a) => a.candidates.map((n) => directory.find((d) => d.name === n)?.id ?? ""))].filter(Boolean);
      const two = [...new Set(named)];
      const focus = input.context?.businessId ?? previous.scope.businessIds[0];
      const other = two.length === 2 ? directory.find((d) => d.id === two.find((id) => id !== focus)) : undefined;
      if (other) {
        resolution = { matched: [other], ambiguous: [] };
        intent = BUSINESS_SCOPED.has(previous.intent.family) ? previous.intent : { family: "business_inspect", followUp: "overview" };
        usedContext = true;
      }
    } else if (ellipsis && resolveBusinesses(ellipsis[1] ?? ellipsis[2] ?? "", directory).matched.length && resolution.matched.length && (intent.family === "business_inspect" || intent.family === "unsupported")) {
      // "and Rina?": the previous question, now about the named business (an action still needs its own confirmation).
      intent = BUSINESS_SCOPED.has(previous.intent.family) ? previous.intent : { family: "business_inspect", followUp: "overview" };
      usedContext = true;
    }
    if (usedContext) record.followUpOf = previous.key;
  }

  // A read-only follow-up may refer to the one business BARRY just surfaced in a fleet answer.
  // Only structured HQ item links are trusted, and implicit focus is never carried into controls or proposals.
  if (!resolution.matched.length && !resolution.ambiguous.length && previous?.scope.kind === "fleet" && intent.family === "unsupported") {
    const ids = [...new Set(previous.items.map((item) => item.href?.split("?")[0]?.split("/").filter(Boolean).at(-1)).filter((id): id is string => Boolean(id) && directory.some((d) => d.id === id)))];
    if (ids.length === 1) {
      const ctx = directory.find((d) => d.id === ids[0]);
      const contextual = interpretFounder(text, { hasBusiness: true });
      if (ctx && contextual.family === "business_inspect") {
        resolution = { matched: [ctx], ambiguous: [] };
        intent = contextual;
        usedContext = true;
        record.followUpOf = previous.key;
      }
    }
  }

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
  const businessScoped = intent.family === "business_inspect" || intent.family === "initiative_scan" || intent.family === "founder_action" || intent.family === "proposal" || (intent.family === "initiative_read" && resolution.matched.length > 0);
  record.scope = businessScoped ? { kind: "business", businessIds: resolution.matched.map((b) => b.id) } : { kind: "fleet", businessIds: [] };
  step("scope", "ok", record.scope.kind === "fleet" ? "fleet" : `business: ${resolution.matched.map((b) => b.name).join(", ") || "none named"}`);

  try {
    if (followUpBasis !== undefined && previous) {
      // "Is that real money?" — answered from what the previous answer was made of; nothing is re-run.
      record.status = "answered";
      record.answer = followUpBasis;
      record.grounded.push(`follow-up on ${previous.key}`, ...previous.grounded.slice(0, 4));
      record.scope = previous.scope;
      step("grounding", "ok", `basis of ${previous.key}`);
    } else {
      await dispatch(record, intent, resolution, { now, step });
    }
  } catch (err) {
    record.status = "failed";
    record.answer = intent.family === "initiative_scan" ? "The initiative scan failed — no scan was recorded and nothing was changed. Try again; this is not the same as a scan that found nothing." : "I couldn't complete that — nothing was changed.";
    record.stopReason = err instanceof Error ? redact(err.message).slice(0, 300) : "unknown error";
    step("reply", "failed", record.stopReason);
  }
  // The conversation layer: the grounded answer is kept as the record of truth; the shown wording may be the
  // composer's only if it passes every check against the envelope.
  record.groundedAnswer = record.answer;
  if (record.status !== "failed") {
    const v = await voice(envelopeOf(record, text), input.composer, directory.map((d) => d.name));
    record.answer = v.text;
    record.voice = { source: v.source, ...(v.reason ? { reason: v.reason } : {}) };
    if (v.reason) step("reply", "info", v.reason);
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
    case "initiative_scan": {
      const b = needOne("scanned");
      if (!b) return;
      return initiativeScan(r, b, intent.force, ctx);
    }
    case "release_read":
      return releaseRead(r, ctx);
    case "founder_action": {
      const b = needOne("changed");
      if (!b) return;
      return prepareAction(r, intent.action, b, ctx, { capability: intent.capability, mode: intent.mode });
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

async function fleetRead(r: FounderCommandRecord, topic: "brief" | "attention" | "changed" | "approvals" | "launch", ctx: Ctx): Promise<void> {
  if (topic === "approvals") return approvalsRead(r, undefined, ctx);
  if (topic === "launch") return launchRank(r, ctx);
  const view = await loadFounderFleet({ now: ctx.now });
  r.grounded.push(`fleet status at ${view.at} (${view.businesses.length} businesses)`, `${view.proposals.length} proposals`, view.release ? `release ${view.release.state}` : "release unavailable");
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  if (topic === "brief") {
    const brief = founderBrief(view);
    // Spoken like a chief of staff: one short paragraph per business (most important first), then fleet-level
    // notes. The separate records stay in r.items (Details) — nothing here is added, only grouped.
    r.answer = brief.quiet
      ? brief.headline
      : [...brief.stories.map((s) => s.text), ...brief.fleetNotes].join("\n\n");
    r.items = brief.items.map(briefItem);
    if (brief.unavailable.length) r.answer += `\n\nI couldn't read everything: ${brief.unavailable.slice(0, 4).join("; ")}.`;
    if (brief.excludedDemo.length) r.grounded.push(`demo tenants left out of the brief: ${brief.excludedDemo.join(", ")}`);
    r.followUps = brief.stories.slice(0, 2).map((s) => `What's going on with ${s.businessName}?`).concat(["Handle what you safely can and leave me what needs approval."]);
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

async function inspect(r: FounderCommandRecord, b: DirectoryEntry, followUp: "overview" | "why" | "incidents" | "changed" | "options" | "readiness" | "money" | "approvals", ctx: Ctx): Promise<void> {
  const graph = fleetTenant(b.id);
  if (!graph) throw new Error("business not in the fleet");
  if (followUp === "readiness") return readinessRead(r, b, ctx);
  if (followUp === "approvals") return approvalsRead(r, b, ctx);
  if (followUp === "money") return moneyRead(r, b, ctx);
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
    d.waitingOn.length ? `Waiting on: ${d.waitingOn.join("; ")}.` : "Nothing needs the owner's decision there right now.",
    d.incidents.length ? `Incidents: ${d.incidents.slice(0, 3).map((i) => `${i.title} (${i.severity})`).join("; ")}.` : "No open incidents.",
    d.initiatives.length ? `BARRY noticed: ${d.initiatives.slice(0, 2).map((i) => i.title).join("; ")}.` : "",
    d.commercial ? `Plan: ${d.commercial.plan ?? "none"} · ${d.commercial.stage}${d.commercial.price ? ` · ${d.commercial.price}` : ""}${d.commercial.alerts.length ? ` · ${d.commercial.alerts.slice(0, 2).join("; ")}` : ""}.` : "Commercial record unavailable.",
    d.value ? (d.value.made === "none verified" && d.value.savedRealized === "none realized" && /^0 conversations handled with no human, 0 verified outcomes$/.test(d.value.handled) ? "No verified value yet this period — no provider-verified money, no realized savings, nothing handled end to end." : `Verified value: made ${d.value.made}; saved ${d.value.savedRealized}; ${d.value.handled}.`) : "I couldn't read its value this period.",
    `Controls: ${d.controls.mode}${d.controls.paused ? " · PAUSED" : ""}${d.controls.safeMode ? " · safe mode" : ""}. Capabilities: ${d.capabilities.slice(0, 4).join("; ")}.`,
    d.runtime ? `Runtime ${d.runtime.version}${d.runtime.commit ? ` @ ${d.runtime.commit.slice(0, 7)}` : ""}; reasoner ${d.runtime.reasoner}.` : "",
    d.unavailable.length ? `Couldn't read: ${d.unavailable.slice(0, 3).join("; ")}.` : "",
  ].filter(Boolean);
  r.answer = lines.join("\n");
  r.items = [{ title: `Open ${d.name} in HQ`, href }];
}

async function commercialRead(r: FounderCommandRecord, topic: "cost_to_serve" | "plans" | "models", ctx: Ctx): Promise<void> {
  if (topic === "models") return modelsRead(r, ctx);
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

// ── Readiness, approvals, money, model usage (the same read models HQ shows) ─────────────────────────

const LEVEL_WORDS = { READY_FOR_SUPERVISED_DESIGN_PARTNER: "ready for a supervised design-partner launch", NOT_READY: "not ready", UNKNOWN_NEEDS_PROOF: "unknown — some required items still need proof" } as const;

/** "Why isn't X ready?" — the deterministic launch gate (HQ → Launch). Unknown stays unknown. */
async function readinessRead(r: FounderCommandRecord, b: DirectoryEntry, ctx: Ctx): Promise<void> {
  const graph = fleetTenant(b.id)!;
  const gate = await launchChecklist(graph, { controls: await loadControls(b.id) });
  r.grounded.push(`launch gate ${b.id}: ${gate.level}`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  const required = gate.items.filter((i) => i.requiredForSupervised);
  const blocked = required.filter((i) => i.status === "blocked");
  const unknown = required.filter((i) => i.status === "unknown");
  r.items = [...blocked, ...unknown].map((i) => ({ title: `${i.title}: ${i.status}`, detail: `${i.evidence}${i.nextAction ? ` → ${i.nextAction} (${i.responsibility.replace("_", " ")})` : ""}`, href: bizHref(b.id, "launch"), severity: i.status === "blocked" ? ("high" as const) : ("info" as const) }));
  r.answer = [
    `${b.name}: ${gate.verdict === "READY_FOR_SUPERVISED" ? "READY FOR SUPERVISED" : "BLOCKED"} — ${LEVEL_WORDS[gate.level]} (launch gate: ${required.length - blocked.length - unknown.length} of ${required.length} required items ready).`,
    ...blocked.slice(0, 6).map((i) => `• Blocked — ${i.title}: ${i.blocker ?? i.evidence}${i.nextAction ? ` → ${i.nextAction}` : ""}`),
    ...unknown.slice(0, 4).map((i) => `• Unknown (needs proof) — ${i.title}: ${i.evidence}`),
  ].join("\n");
  r.followUps = [`What's going on with ${b.name}?`];
}

/** "Who is closest to going live?" — every real business ranked by its launch gate (fewest blocked, then unknown). */
async function launchRank(r: FounderCommandRecord, ctx: Ctx): Promise<void> {
  const view = await loadFounderFleet({ now: ctx.now });
  const real = view.businesses.filter((x) => !x.demo);
  const rows = await Promise.all(real.map(async (x) => ({ x, gate: await launchChecklist(fleetTenant(x.id)!, { controls: x.controls }).catch(() => null) })));
  r.grounded.push(`launch gates (${rows.length} businesses)`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  const ranked = rows.filter((y) => y.gate).sort((p, q) => p.gate!.requiredRemaining.length - q.gate!.requiredRemaining.length || p.gate!.unknown.length - q.gate!.unknown.length);
  const failed = rows.filter((y) => !y.gate).map((y) => y.x.name);
  r.items = ranked.map(({ x, gate }) => ({ title: `${x.name}: ${LEVEL_WORDS[gate!.level]}`, detail: `${gate!.requiredRemaining.length} blocked, ${gate!.unknown.length} unknown${gate!.requiredRemaining.length ? ` — ${gate!.requiredRemaining.slice(0, 3).join("; ")}` : ""}`, href: bizHref(x.id, "launch"), severity: gate!.level === "READY_FOR_SUPERVISED_DESIGN_PARTNER" ? ("ok" as const) : ("info" as const) }));
  r.answer = ranked.length
    ? [`Closest to a supervised launch first (by the launch gate):`, ...ranked.slice(0, 5).map(({ x, gate }, i) => `${i + 1}. ${x.name} — ${LEVEL_WORDS[gate!.level]}: ${gate!.requiredRemaining.length} blocked, ${gate!.unknown.length} unknown${gate!.requiredRemaining[0] ? ` (first blocker: ${gate!.requiredRemaining[0]})` : ""}`), failed.length ? `Couldn't read the gate for: ${failed.join(", ")}.` : ""].filter(Boolean).join("\n")
    : "I couldn't read any business's launch gate.";
  r.followUps = ranked.slice(0, 1).map(({ x }) => `Why isn't ${x.name} ready?`);
}

/** Approvals waiting on owners (fleet or one business) — the HQ approvals console. The founder never decides them. */
async function approvalsRead(r: FounderCommandRecord, b: DirectoryEntry | undefined, ctx: Ctx): Promise<void> {
  const rows = await globalApprovals({ ...(b ? { businessId: b.id } : {}), openOnly: true, now: ctx.now });
  r.grounded.push(`approvals console${b ? ` ${b.id}` : " (fleet)"}: ${rows.length} open`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  r.items = rows.slice(0, 12).map((a) => ({ title: `${a.businessName}: ${a.summary}`, detail: `${a.lifecycle} · ${a.ageHours}h · ${a.customer}`, href: bizHref(a.businessId, "attention"), severity: a.ageHours >= 24 ? ("medium" as const) : ("info" as const) }));
  const where = b ? ` at ${b.name}` : "";
  r.answer = rows.length
    ? [`${plural(rows.length, "approval")} waiting on owners${where} (the owner decides each — I can't decide for them):`, ...rows.slice(0, 6).map((a) => `• ${b ? "" : `${a.businessName}: `}${a.summary} — ${a.lifecycle}, ${a.ageHours}h old`)].join("\n")
    : `No approvals are waiting${where}.`;
}

/** "And her money?" — only the business's own records: verified payments, money waiting / at risk, value this period. */
async function moneyRead(r: FounderCommandRecord, b: DirectoryEntry, ctx: Ctx): Promise<void> {
  const graph = fleetTenant(b.id)!;
  const [s, v] = await Promise.all([getBusinessStatus(graph, { now: ctx.now }), loadValueAccount(graph, monthPeriod(ctx.now), ctx.now).catch(() => null)]);
  r.grounded.push(`status ${b.id} money`, v ? `value account ${v.period.label}` : "value account unavailable");
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  const made: Money = { ...(v?.made.generated ?? {}) };
  for (const [c, n] of Object.entries(v?.made.recovered ?? {})) made[c] = Math.round(((made[c] ?? 0) + n) * 100) / 100;
  r.answer = [
    `${b.name} — money from the records (nothing estimated):`,
    v ? `• Made this period (${v.period.label}), provider-verified: ${hasMoney(made) ? moneyWords(made) : "nothing verified"}${hasMoney(v.made.recovered) ? ` (recovered ${moneyWords(v.made.recovered)})` : ""}.` : "• I couldn't read its verified money this period.",
    `• Provider-verified payments: ${s.money.verifiedPayments}.`,
    hasMoney(s.money.stuckWithOwner) ? `• Waiting on an owner decision: ${moneyWords(s.money.stuckWithOwner)} (not revenue).` : "• Nothing waiting on an owner decision.",
    hasMoney(s.money.waitingOnCustomer) ? `• Waiting on customers to pay: ${moneyWords(s.money.waitingOnCustomer)} (not revenue).` : "",
    hasMoney(s.money.atRisk) ? `• At risk: ${moneyWords(s.money.atRisk)}.` : "",
    hasMoney(s.money.simulated) ? `• Test money on a simulator: ${moneyWords(s.money.simulated)} — never counted.` : "",
  ].filter(Boolean).join("\n");
  r.items = [{ title: `${b.name} money`, href: bizHref(b.id) }];
  r.followUps = [`What's going on with ${b.name}?`];
}

/** "How much are we spending on models?" — metered model usage priced on the rate card (estimated) or invoices (measured). */
async function modelsRead(r: FounderCommandRecord, ctx: Ctx): Promise<void> {
  const period = monthPeriod(ctx.now);
  const rows = await Promise.all(
    fleetTenantIds().map(async (id) => {
      const g = fleetTenant(id)!;
      const [records, usage, support] = await Promise.all([listCostRecords(id).catch(() => null), listModelUsage(id).catch(() => null), listSupportTime(id).catch(() => [])]);
      if (!records || !usage) return { id, name: g.business.name, unavailable: true as const };
      const c = costToServe({ period, records, usage, support });
      const line = c.lines.find((l) => l.category === "ai_model");
      return { id, name: g.business.name, unavailable: false as const, calls: c.model.calls, unpriced: c.model.unpricedCalls, estimated: c.model.estimatedUsd, line, rateCard: c.model.rateCardVersion };
    })
  );
  r.grounded.push(`model usage + cost records ${period.label} (${rows.length} businesses)`);
  ctx.step("grounding", "ok", r.grounded.join(" · "));
  const used = rows.filter((x): x is Extract<typeof x, { unavailable: false }> => !x.unavailable && (x.calls > 0 || (x.line?.amount ?? 0) > 0)).sort((a, b) => (b.line?.amount ?? b.estimated) - (a.line?.amount ?? a.estimated));
  const unavailable = rows.filter((x) => x.unavailable).map((x) => x.name);
  const basis = (x: (typeof used)[number]) => (x.line?.basis === "measured" ? "measured (invoice)" : `estimated from ${plural(x.calls, "metered call")} on rate card ${x.rateCard}${x.unpriced ? `; ${x.unpriced} call(s) unpriced — lower bound` : ""}`);
  const total = Math.round(used.reduce((n, x) => n + (x.line?.amount ?? x.estimated), 0) * 100) / 100;
  r.items = used.map((x) => ({ title: `${x.name}: ${x.line?.amount ?? x.estimated} USD`, detail: basis(x), href: "/hq/commercial", severity: "info" as const }));
  r.answer = used.length
    ? [`Model spend this period (${period.label}): ${total} USD across ${plural(used.length, "business")} — ${used.every((x) => x.line?.basis === "measured") ? "measured" : "mostly ESTIMATED from metered usage, not an invoice"}:`, ...used.slice(0, 6).map((x, i) => `${i + 1}. ${x.name}: ${x.line?.amount ?? x.estimated} USD (${basis(x)})`), unavailable.length ? `Couldn't read usage for: ${unavailable.join(", ")}.` : "", "Businesses with no metered calls have no model cost on record (not zero by assumption)."].filter(Boolean).join("\n")
    : `No metered model usage or model invoices are recorded for ${period.label}, so I can't say what models cost — nothing is estimated without a record.${unavailable.length ? ` (Couldn't read: ${unavailable.join(", ")}.)` : ""}`;
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

const INTEGRATION_KINDS = new Set(["connection_unhealthy", "reverification_due", "undelivered_reply", "owner_channel_failing", "customer_delivery_failing", "payment_unverified"]);

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

/**
 * Run ONE scan of ONE resolved business through the existing Initiative Engine (runInitiativeScan) — the same
 * path as POST /api/owner/initiatives/scan. Detection, verification, dedupe, fatigue, ranking and the daily
 * scan limit all stay inside the engine; this only passes the founder's explicit "force" wording (the
 * engine's existing founder-only QA bypass of the daily limit). A scan reads records and sends nothing.
 */
async function initiativeScan(r: FounderCommandRecord, b: DirectoryEntry, force: boolean, ctx: Ctx): Promise<void> {
  const graph = fleetTenant(b.id);
  if (!graph) throw new Error("business not in the fleet");
  r.authority = force ? "founder initiative scan, FORCED (explicit QA wording; bypasses only the daily scan limit)" : "founder initiative scan (bounded: daily scan limit applies)";
  ctx.step("authority", "ok", r.authority);
  const { scan, initiatives } = await runInitiativeScan(graph, { now: ctx.now, trigger: "manual", force });
  const open = initiatives.filter((i) => ["verified", "surfaced", "reviewed", "accepted", "acting"].includes(i.state));
  r.scan = { scanId: scan.id, businessId: b.id, trigger: scan.trigger, forced: force, skipped: scan.skipped ?? null, candidates: scan.candidates, verified: scan.verified, rejected: scan.rejected.length, created: scan.created, updated: scan.updated, surfaced: scan.surfaced, suppressed: scan.suppressed, resolved: scan.resolved, open: open.length };
  r.grounded.push(`initiative scan ${scan.id} (${b.id}, ${scan.localDate})`);
  ctx.step("grounding", "ok", r.grounded[r.grounded.length - 1]);
  const href = bizHref(b.id);
  if (scan.skipped) {
    r.status = "no_change";
    r.stopReason = "daily scan limit";
    r.answer = `Scan skipped for ${b.name}: ${scan.skipped}. Nothing was detected or changed. The limit resets with the business's next local day; say "Force an initiative scan for ${b.name} for QA" to bypass it for diagnosis.`;
    r.items = [{ title: `${b.name}: scan skipped`, detail: scan.skipped, href, severity: "low" }];
    ctx.step("execution", "info", `skipped: ${scan.skipped}`);
    return;
  }
  ctx.step("execution", "ok", `scan ${scan.id}: ${scan.candidates} detected, ${scan.verified} verified, ${scan.rejected.length} rejected, ${scan.created} new, ${scan.updated} updated, ${scan.surfaced} surfaced`);
  r.verification = `Scan ${scan.id} recorded for ${b.name} (${scan.localDate}); ${plural(open.length, "initiative")} open now.`;
  ctx.step("verification", "ok", r.verification);
  r.status = "executed";
  // Spoken like an operator, not a log line. Every count stays exact in r.scan / the trace / the items.
  const lead = force ? "Forced QA scan done. " : "";
  const IMPORTANCE = { high: 0, medium: 1, low: 2 } as const;
  const ranked = [...open].sort((x, y) => IMPORTANCE[x.importance] - IMPORTANCE[y.importance]);
  const things = (n: number) => (n === 1 ? "one thing" : `${n} things`);
  if (scan.verified === 0 && open.length === 0) {
    r.answer = `${lead}Nothing new at ${b.name} — ${scan.candidates ? `I checked ${plural(scan.candidates, "signal")} against the records and none held up` : "nothing in the records is worth raising right now"}. That's a normal result, not a failure. I haven't contacted anyone.`;
  } else {
    const [top, ...rest] = ranked;
    const others = rest.slice(0, 3).map((i) => i.title);
    r.answer = [
      `${lead}I found ${things(open.length)} worth attention at ${b.name}.${top ? ` The biggest: ${top.title}.` : ""}${others.length ? ` Also: ${others.join("; ")}${rest.length > 3 ? ` (+${rest.length - 3} more)` : ""}.` : ""}`,
      [scan.created === 0 ? "Nothing new since the last scan — these were already open." : scan.created < open.length ? `${scan.created} of these ${scan.created === 1 ? "is" : "are"} new since the last scan.` : "", scan.surfaced ? `${scan.surfaced === 1 ? "One is" : `${scan.surfaced} are`} now in front of the owner.` : "", scan.suppressed ? `I held ${scan.suppressed} back for now (daily limit / quiet period).` : ""].filter(Boolean).join(" "),
      "I haven't contacted anyone — the owner decides each one.",
    ].filter(Boolean).join("\n");
    r.items = ranked.slice(0, 8).map((i) => ({ title: `${b.name}: ${i.title}`, detail: `${i.category.replace(/_/g, " ")} · ${i.importance} · ${i.state}`, href, severity: i.importance === "high" ? ("medium" as const) : ("info" as const) }));
  }
  if (scan.rejected.length) r.items.push({ title: `${plural(scan.rejected.length, "candidate")} rejected on verification`, detail: [...new Set(scan.rejected.map((x) => x.detector))].join(", "), severity: "low" });
  r.followUps = [`What's going on with ${b.name}?`, `What did BARRY notice at ${b.name}?`];
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

async function prepareAction(r: FounderCommandRecord, kind: FounderActionKind, b: DirectoryEntry, ctx: Ctx, target: { capability?: CapabilityFamily; mode?: FounderMode } = {}): Promise<void> {
  const before = await loadControls(b.id);
  const lang: Lang = r.language ?? "en";
  const a = actionSpec(kind, before, target);
  if ("refused" in a) {
    r.status = "clarify";
    r.stopReason = a.refused;
    r.answer = lang === "he" ? (kind === "set_mode" && target.mode === "live" ? "העברה למצב LIVE נעשית ב-HQ ← בקרות אחרי בדיקת ההשקה, לא משיחה. שום דבר לא השתנה." : kind === "set_mode" ? "לאיזה מצב — סימולטור או מפוקח? שום דבר לא השתנה." : "איזו יכולת? תשלומים, הזמנות, תורים, תמיכה, הודעות יוצאות או משלוחים. שום דבר לא השתנה.") : a.refused;
    ctx.step("authority", "blocked", a.refused);
    return;
  }
  r.grounded.push(`controls ${b.id} (updated ${before.updatedAt ?? "never"})`);
  r.authority = `founder control (existing, audited; confirmation required${a.loosens ? "; LOOSENS control" : ""})`;
  ctx.step("authority", "ok", r.authority);
  const snapshot: Partial<BusinessControls> = { pausedBusiness: before.pausedBusiness, safeMode: before.safeMode, mode: before.mode, approvalRequiredForAll: before.approvalRequiredForAll, pausedCapabilities: [...before.pausedCapabilities] };
  r.action = { kind, businessId: b.id, businessName: b.name, change: a.change, title: a.title(b.name), effect: a.effect, before: snapshot, ...(a.detail ? { detail: a.detail } : {}), ...(a.loosens ? { loosens: true } : {}) };
  if (isNoop(before, a.change)) {
    r.status = "no_change";
    r.verification = verifiedText(lang, b.name, String(a.key), JSON.stringify(before[a.key]), before.updatedAt, before.updatedBy);
    r.answer = lang === "he" ? noChangeText(lang, b.name) : `${b.name} is already ${({ pause_business: "paused", resume_business: "running (not paused)", safe_mode_on: "in safe mode", safe_mode_off: "out of safe mode", require_approval_on: "requiring approval for everything", require_approval_off: "following its own rules (no approval-for-everything)", pause_capability: `paused for ${a.detail}`, resume_capability: `running ${a.detail}`, set_mode: `in ${a.detail} mode` } as Record<FounderActionKind, string>)[kind]}. Nothing to change.`;
    ctx.step("verification", "ok", r.verification);
    return;
  }
  r.status = "needs_confirmation";
  r.answer = askedText(lang, actionTitle(lang, kind, b.name, a.detail), actionEffect(lang, kind, a.effect));
  r.followUps = ["Confirm"];
  ctx.step("confirmation", "info", "waiting for the founder to confirm");
}

/** Execute a confirmed pending action exactly once, then verify the durable state. */
export async function confirmFounderAction(input: { actor: FounderActor; key: string; now?: Date }): Promise<FounderReply> {
  if (!input.actor || input.actor.kind !== "founder") throw new Error("Founder BARRY needs an authenticated founder");
  const r = await getFounderCommand(input.key);
  if (!r) return { key: input.key, status: "refused", answer: "There is nothing waiting for confirmation under that key.", items: [], followUps: [], proposalIds: [], intent: "founder_action", scope: { kind: "business", businessIds: [] }, stopReason: "unknown key", duplicate: false, language: "en" };
  if (r.status !== "needs_confirmation" || !r.action) {
    // Already used (or not a pending control): the recorded result is returned UNCHANGED — nothing runs, no audit,
    // no new verification. A used control confirmation is flagged as a replay so it can't read as a second execution.
    const base = reply(r, true);
    if (r.action && (r.status === "executed" || r.status === "no_change")) {
      const lang = r.language ?? languageOf(r.text);
      return { ...base, replay: true, answer: replayText(lang, r.action.kind, r.action.businessName, r.action.confirmedAt ?? r.updatedAt), followUps: [], items: [] };
    }
    return base;
  }
  const lang: Lang = r.language ?? languageOf(r.text);
  const at = () => new Date().toISOString();
  const step = (s: FounderTraceStep["step"], outcome: FounderTraceStep["outcome"], detail: string) => r.trace.push({ step: s, outcome, detail, at: at() });
  const a = r.action;
  step("confirmation", "ok", `confirmed by founder (${input.actor.via}${input.actor.identity ? ` ${input.actor.identity}` : ""})`);
  // Claim the command before executing so a concurrent confirm sees it as taken.
  r.status = "executed";
  r.action.confirmedAt = (input.now ?? new Date()).toISOString();
  await save(r);
  try {
    // The change recorded at prepare time is re-derived against the controls NOW (a capability list may have
    // moved since), so the confirmation applies exactly what it said — on top of the current state.
    const current = await loadControls(a.businessId);
    const spec = actionSpec(a.kind, current, { capability: a.detail as CapabilityFamily | undefined, mode: a.detail as FounderMode | undefined });
    const change = "refused" in spec ? a.change : spec.change;
    const result = await applyControlChange(a.businessId, change, { by: founderControlBy(input.actor), reason: `Founder BARRY: "${r.text}"`.slice(0, 500), now: input.now });
    r.action.auditId = result.audit?.id;
    r.action.change = change;
    step("execution", "ok", result.changed ? `applied via founder control; audit ${result.audit?.id}` : "no change needed");
    const after = await loadControls(a.businessId);
    const field = Object.keys(change)[0] as keyof ControlChange;
    const expected = change[field];
    const ok = JSON.stringify(Array.isArray(expected) ? [...expected].sort() : expected) === JSON.stringify(Array.isArray(after[field]) ? [...(after[field] as string[])].sort() : after[field]);
    r.action.verified = ok;
    const shown = (v: unknown) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
    r.verification = ok ? verifiedText(lang, a.businessName, String(field), shown(after[field]), after.updatedAt, after.updatedBy) : `${a.businessName}: expected ${String(field)} = ${shown(expected)}, durable state says ${shown(after[field])}.`;
    step("verification", ok ? "ok" : "failed", r.verification);
    r.status = ok ? (result.changed ? "executed" : "no_change") : "failed";
    r.answer = ok ? doneText(lang, lang === "he" ? actionTitle(lang, a.kind, a.businessName, a.detail) : a.title) : unverifiedText(lang, r.verification);
    if (ok && result.audit) r.answer += lang === "he" ? `\nלפני → אחרי: ${shown(result.audit.before[field as keyof typeof result.audit.before])} → ${shown(result.audit.after[field as keyof typeof result.audit.after])}.` : `\nBefore → after: ${shown(result.audit.before[field as keyof typeof result.audit.before])} → ${shown(result.audit.after[field as keyof typeof result.audit.after])}.`;
    r.followUps = followUpFor(lang, a.kind, a.businessName);
  } catch (err) {
    r.status = "failed";
    r.stopReason = err instanceof Error ? redact(err.message).slice(0, 300) : "unknown error";
    r.answer = failedText(lang);
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
