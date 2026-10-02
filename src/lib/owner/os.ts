import type { Policy } from "@/lib/business-graph";
import type { TrainedRule } from "@/lib/policy/effective-rules";
import type { InitiativeView } from "@/lib/initiative/model";
import type { OperationState } from "./operation-model";
import type { PilotReadiness, ReadinessCheck } from "./readiness";
import type { OwnerChannels, OwnerOperator, OwnerWorkspace } from "./service";
import { PROACTIVE, activityFeed, type ActivityItem } from "./control-room";

/**
 * THE OWNER BUSINESS OS (pure, client-safe) — owner-language projections over the systems that already
 * exist. Nothing here decides or enforces anything: the policy engine, founder controls, the initiative
 * engine, the capability-readiness model and the connection registry stay authoritative. These functions
 * only say, in the owner's words, what those systems already hold:
 *
 *   initiatives → "BARRY noticed"        approvals/handoffs → "Needs you"     operations → "BARRY is working"
 *   policy      → "Rules BARRY follows"  genome → "What BARRY knows"          fabric → "Connected systems"
 *   audit       → "Activity"             readiness → "BARRY setup"            controls → "How autonomous BARRY is"
 *
 * Honesty rules: a simulator is never "real"; a rule's source is the provenance the runtime recorded; a
 * readiness level is the server's assessment (never computed here); a blocker always says who acts and where.
 */

// ── Work: one state vocabulary for everything BARRY is doing or noticed ──────────────────────────────

export type WorkState = "new" | "watching" | "working" | "waiting_on_you" | "waiting_on_customer" | "done" | "dismissed" | "snoozed";

export const WORK_STATE_WORDS: Record<WorkState, string> = {
  new: "New",
  watching: "Watching",
  working: "Working",
  waiting_on_you: "Waiting on you",
  waiting_on_customer: "Waiting on customer",
  done: "Done",
  dismissed: "Dismissed",
  snoozed: "Snoozed",
};

/** An initiative's lifecycle (the engine's) in the owner's work vocabulary. */
export function noticedState(i: Pick<InitiativeView, "state" | "alreadyHandled" | "ownerActionNeeded">): WorkState {
  switch (i.state) {
    case "verified":
    case "surfaced":
      return i.alreadyHandled ? "working" : "new";
    case "reviewed":
      return i.alreadyHandled ? "working" : "watching";
    case "accepted":
    case "acting":
      return "working";
    case "measured":
    case "resolved":
      return "done";
    case "snoozed":
      return "snoozed";
    case "dismissed":
    case "invalidated":
      return "dismissed";
  }
}

/** An owner operation's derived state in the same vocabulary. */
export function operationWorkState(s: OperationState): WorkState {
  switch (s) {
    case "proposed":
    case "blocked":
    case "failed":
      return "waiting_on_you";
    case "running":
      return "working";
    case "waiting_on_customers":
      return "waiting_on_customer";
    case "completed":
    case "stopped":
      return "done";
  }
}

const CONFIDENCE_WORDS = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;
const AUTHORITY_WORDS: Record<InitiativeView["authority"], string> = {
  owner_decides: "You decide — BARRY won't act on this by itself",
  within_owner_rules: "BARRY can do this within your rules once you say go",
  owner_only: "Only you can do this",
};

const fmt = (m: Record<string, number> | undefined) =>
  Object.entries(m ?? {})
    .filter(([, v]) => v > 0)
    .map(([c, v]) => new Intl.NumberFormat("en", { style: "currency", currency: c, maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v))
    .join(" + ");

/**
 * One "BARRY noticed" item, every question the owner asks of it answered from the persisted initiative:
 * what, why it matters, the evidence, how sure, the money involved (never called revenue), the next step,
 * whether BARRY can act, whether it needs approval, whether it is already handled, and the result.
 */
export function noticedCard(i: InitiativeView) {
  const amount = fmt(i.impact.amount);
  const verified = fmt(i.result?.verifiedValue);
  return {
    id: i.id,
    state: noticedState(i),
    stateWords: WORK_STATE_WORDS[noticedState(i)],
    what: i.title,
    observation: i.observation,
    whyItMatters: i.impact.note ?? i.importanceWords,
    evidence: `${i.basis} · ${i.evidence.length} record${i.evidence.length === 1 ? "" : "s"}`,
    confidence: CONFIDENCE_WORDS[i.confidence],
    // Money an initiative points at is at stake / recoverable — never made. Only a measured result is verified.
    money: amount ? `${amount} ${i.impact.type === "revenue_at_risk" ? "at risk" : i.impact.type === "recoverable_demand" ? "could be recovered" : i.impact.type === "cost_increase" ? "in higher costs" : "involved"} (not revenue)` : null,
    next: i.recommendation.text,
    canAct: i.canAct && i.entitlement !== "not_included",
    canActWords: i.entitlement === "not_included" ? "Not on your current plan — a recommendation only." : i.canAct ? "BARRY can do this for you." : "BARRY can't do this itself — it's for you or your team.",
    approval: AUTHORITY_WORDS[i.authority],
    handling: i.alreadyHandled ? "Already being handled." : null,
    result: verified ? `${verified} verified by your provider` : i.result?.note ?? null,
    testData: Boolean(i.testData),
  };
}

// ── Rules BARRY follows ───────────────────────────────────────────────────────────────────────────

export type RuleSource = "built_in" | "profile" | "owner" | "founder";
export type RuleChange = "teach" | "team" | "fixed";
export type OwnerRule = {
  id: string;
  area: "Discounts" | "Money" | "Refunds" | "Bookings" | "Prices" | "Delivery" | "Actions" | "Follow-ups" | "Safety";
  words: string;
  source: RuleSource;
  sourceWords: string;
  change: RuleChange;
  changeWords: string;
  state: "active" | "needs_answer" | "replaced" | "blocked";
  question?: string;
};

export const RULE_SOURCE_WORDS: Record<RuleSource, string> = {
  built_in: "Built into BARRY",
  profile: "Default — your business profile",
  owner: "Taught by you",
  founder: "Restriction from the BARRY team",
};
const CHANGE_WORDS: Record<RuleChange, string> = {
  teach: "You can change this — teach BARRY a new limit below.",
  team: "View only here — the BARRY team changes it with you.",
  fixed: "Always on — it can't be switched off.",
};

export type RulesInput = {
  /** The EFFECTIVE graph's policies (static baseline + owner-trained overlay, with provenance). */
  policies: Policy[];
  /** The business's currency when its offers state one; null when unknown — then no currency is invented. */
  currency: string | null;
  /** Per-capability authority rules (already in owner words). */
  authority: { capability: string; effect: "allow" | "require_approval" | "deny"; reason?: string }[];
  /** Owner-taught rules that are NOT operational (needs review / clarification / blocked / replaced). */
  trained: Pick<TrainedRule, "factId" | "state" | "words" | "question" | "value">[];
  followUps: OwnerOperator;
  /** Follow-up kinds the business profile sets explicitly (the rest are BARRY's defaults). */
  declaredFollowUps: string[];
  controls: { mode: "simulator" | "supervised" | "live"; pauseConsequentialWrites: boolean; approvalRequiredForAll: boolean; pausedCapabilities: string[]; disabledChannels: string[]; pausedBusiness: boolean; safeMode: boolean; reason: string };
  hardMaxDiscountPct: number;
};

// Limits are compared in each order's own currency; without a known business currency none is invented.
const money = (v: number, c: string | null) => (c ? new Intl.NumberFormat("en", { style: "currency", currency: c, maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v) : `${new Intl.NumberFormat("en").format(v)} (in the order's currency)`);

/** The rules BARRY follows right now, each with where it came from and whether the owner can change it here. */
export function ownerRules(input: RulesInput): { rules: OwnerRule[]; pending: OwnerRule[]; notSupported: string[] } {
  const rules: OwnerRule[] = [];
  const add = (r: Omit<OwnerRule, "sourceWords" | "changeWords" | "state"> & Partial<Pick<OwnerRule, "state">>) => rules.push({ state: "active", ...r, sourceWords: RULE_SOURCE_WORDS[r.source], changeWords: CHANGE_WORDS[r.change] });

  // Founder restrictions first: they override everything below while they are on.
  const c = input.controls;
  if (c.pausedBusiness) add({ id: "founder.paused", area: "Safety", words: "BARRY is paused: it doesn't answer customers, nothing proactive runs and nothing is changed.", source: "founder", change: "team" });
  if (c.pauseConsequentialWrites) add({ id: "founder.writes", area: "Safety", words: "BARRY may only look things up and answer — every action that changes something is held.", source: "founder", change: "team" });
  if (c.approvalRequiredForAll) add({ id: "founder.approve_all", area: "Safety", words: "Every action that changes something needs your approval first, even where your rules would allow it.", source: "founder", change: "team" });
  if (c.safeMode) add({ id: "founder.safe", area: "Safety", words: "Safe mode: every consequential action needs your approval and BARRY sends no proactive messages.", source: "founder", change: "team" });
  if (c.pausedCapabilities.length) add({ id: "founder.capabilities", area: "Safety", words: `Paused for now: ${c.pausedCapabilities.length} kind${c.pausedCapabilities.length === 1 ? "" : "s"} of action — BARRY won't do ${c.pausedCapabilities.length === 1 ? "it" : "them"} until the BARRY team lifts the pause.`, source: "founder", change: "team" });
  if (c.disabledChannels.length) add({ id: "founder.channels", area: "Safety", words: `BARRY doesn't answer on: ${c.disabledChannels.join(", ")}.`, source: "founder", change: "team" });

  for (const p of input.policies) {
    const owner = p.provenance?.source === "owner_trained";
    const source: RuleSource = owner ? "owner" : "profile";
    const r = p.rule;
    switch (r.type) {
      case "max_auto_discount_pct":
        add({ id: `policy.${p.id}`, area: "Discounts", words: r.value === 0 ? "BARRY gives no discount on its own. Every discount needs your approval." : `BARRY may offer up to ${r.value}% without asking you. More than ${r.value}% needs your approval.`, source, change: "teach" });
        break;
      case "max_auto_payment_amount":
        add({ id: `policy.${p.id}`, area: "Money", words: `Payment requests up to ${money(r.value, input.currency)} go out on their own; above that, you approve.`, source, change: "team" });
        break;
      case "refund_requires_approval":
        add({ id: `policy.${p.id}`, area: "Refunds", words: r.value ? "Refunds always need your approval." : "Refunds don't need your approval.", source, change: "team" });
        break;
      case "bookings_auto_allowed":
        add({ id: `policy.${p.id}`, area: "Bookings", words: r.value ? "BARRY books appointments on its own." : "Every booking needs your approval.", source, change: "team" });
        break;
      case "custom_pricing_requires_approval":
        add({ id: `policy.${p.id}`, area: "Prices", words: r.value ? "Any price change needs your approval." : "BARRY may adjust prices within your rules.", source, change: "team" });
        break;
      case "free_shipping_over":
        add({ id: `policy.${p.id}`, area: "Delivery", words: `Free delivery above ${money(r.value, input.currency)}.`, source, change: "team" });
        break;
      case "flat_shipping_fee":
        add({ id: `policy.${p.id}`, area: "Delivery", words: `Delivery costs ${money(r.value, input.currency)}.`, source, change: "team" });
        break;
    }
  }
  if (!input.policies.some((p) => p.rule.type === "max_auto_discount_pct")) {
    add({ id: "policy.discount.none", area: "Discounts", words: "No discount limit is set, so BARRY offers no discount on its own — any discount comes to you.", source: "built_in", change: "teach" });
  }

  for (const [i, a] of input.authority.entries()) {
    add({ id: `authority.${i}`, area: "Actions", words: a.effect === "allow" ? `BARRY may: ${a.capability}.` : a.effect === "require_approval" ? `You approve first: ${a.capability}.` : `Never: ${a.capability}.`, source: "profile", change: "team" });
  }

  if (!input.followUps.included) {
    add({ id: "followups.plan", area: "Follow-ups", words: "Proactive follow-ups aren't part of your current plan — BARRY only follows up when you ask.", source: "profile", change: "team" });
  } else {
    for (const f of input.followUps.rules) {
      const title = PROACTIVE.find((p) => p.kind === f.kind)?.command ?? f.kind.replace(/_/g, " ");
      add({ id: `followups.${f.kind}`, area: "Follow-ups", words: f.enabled ? `${title}: after ${f.afterHours}h, up to ${f.maxAttempts} message${f.maxAttempts === 1 ? "" : "s"}, ${f.intervalHours}h apart — only to customers already talking to you.` : `${title}: off.`, source: input.declaredFollowUps.includes(f.kind) ? "profile" : "built_in", change: "team" });
    }
  }

  add({ id: "builtin.discount_ceiling", area: "Safety", words: `BARRY never gives more than ${input.hardMaxDiscountPct}% on its own, whatever it is taught.`, source: "built_in", change: "fixed" });
  add({ id: "builtin.no_broadcast", area: "Safety", words: "BARRY only messages customers who already wrote to you — no campaigns or broadcasts.", source: "built_in", change: "fixed" });
  add({ id: "builtin.verified_money", area: "Safety", words: "Nothing counts as paid until your payment provider verifies it.", source: "built_in", change: "fixed" });

  const pending: OwnerRule[] = input.trained
    .filter((t) => t.state !== "active")
    .map((t) => ({
      id: `trained.${t.factId}`,
      area: "Discounts",
      words: t.words,
      source: "owner",
      sourceWords: RULE_SOURCE_WORDS.owner,
      change: "teach",
      changeWords: t.state === "superseded" ? "Replaced — kept for the record." : "BARRY does not use this until it's answered.",
      state: t.state === "superseded" ? "replaced" : t.state === "blocked" ? "blocked" : "needs_answer",
      ...(t.question ? { question: t.question } : {}),
    }));

  return {
    rules,
    pending,
    notSupported: [
      "Rules that switch off by themselves (“only today”) — a rule stays until you change it.",
      "Different limits per customer or per product.",
      "Changing follow-up timing or payment limits yourself — the BARRY team changes those with you for now.",
    ],
  };
}

// ── Connected systems ───────────────────────────────────────────────────────────────────────────────

export type SystemLabel = "REAL" | "SIMULATED" | "READ-ONLY" | "SUPERVISED" | "TEST MODE" | "UNAVAILABLE" | "NOT CONNECTED";

export type SystemInput = {
  domain: string;
  provider: string | null;
  status: "connected" | "disconnected" | "error" | "not_configured";
  simulated: boolean;
  missing: string[];
  lastVerifiedAt: string | null;
  /** What this system lets BARRY do, in owner words, split by effect. */
  reads: string[];
  writes: string[];
  /** Whether this business's setup uses the domain at all. */
  used: boolean;
};

export type OwnerSystem = {
  id: string;
  name: string;
  provider: string | null;
  label: SystemLabel;
  /** One line: what the label means for the owner. */
  meaning: string;
  reads: string[];
  does: string[];
  health: "healthy" | "degraded" | "down" | "not_set_up";
  lastCheck: string | null;
  missingForLaunch: string[];
  used: boolean;
};

const DOMAIN_NAME: Record<string, string> = { commerce: "Store & catalog", payments: "Payments", scheduling: "Calendar & bookings", messaging: "Messaging", support: "Support desk", crm: "Customer records" };
const LABEL_MEANING: Record<SystemLabel, string> = {
  REAL: "Connected to your real system — what BARRY does here really happens.",
  SIMULATED: "Running on BARRY's simulator — nothing real reaches customers, stock or money.",
  "READ-ONLY": "BARRY can look things up here but can't change anything.",
  SUPERVISED: "Real system, supervised start — the BARRY team watches closely and actions follow your approvals.",
  "TEST MODE": "Connected, but in test mode — replies are recorded, not sent.",
  UNAVAILABLE: "Connected but not working right now — BARRY won't act through it.",
  "NOT CONNECTED": "Not connected yet.",
};

/** One system, labelled honestly: a simulator is SIMULATED whatever else is true. */
export function systemView(s: SystemInput, mode: "simulator" | "supervised" | "live", launchBlockers: string[] = []): OwnerSystem {
  const label: SystemLabel =
    s.status === "not_configured"
      ? "NOT CONNECTED"
      : s.status !== "connected" || s.missing.length > 0
        ? "UNAVAILABLE"
        : s.simulated
          ? "SIMULATED"
          : s.writes.length === 0
            ? "READ-ONLY"
            : mode === "live"
              ? "REAL"
              : "SUPERVISED";
  return {
    id: s.domain,
    name: DOMAIN_NAME[s.domain] ?? s.domain[0].toUpperCase() + s.domain.slice(1),
    provider: s.provider,
    label,
    meaning: LABEL_MEANING[label],
    reads: s.reads,
    does: s.writes,
    health: s.status === "not_configured" ? "not_set_up" : s.status !== "connected" ? "down" : s.missing.length ? "degraded" : "healthy",
    lastCheck: s.lastVerifiedAt,
    missingForLaunch: launchBlockers,
    used: s.used,
  };
}

/** The channels and BARRY's understanding as systems, with the same honest labels. */
export function channelSystems(ch: OwnerChannels, ai: { status: string; mode: string; summary: string }, mode: "simulator" | "supervised" | "live"): OwnerSystem[] {
  const customer: SystemLabel = ch.customerWhatsapp === "live" ? (mode === "live" ? "REAL" : "SUPERVISED") : ch.customerWhatsapp === "dry_run" ? "TEST MODE" : "NOT CONNECTED";
  const owner: SystemLabel = ch.ownerCommands === "connected" ? (ch.ownerSendMode === "dry_run" ? "TEST MODE" : "REAL") : "NOT CONNECTED";
  const aiLabel: SystemLabel = ai.mode !== "live_model" ? "SIMULATED" : ai.status === "unavailable" ? "UNAVAILABLE" : "REAL";
  return [
    { id: "whatsapp_customers", name: "WhatsApp — your customers", provider: ch.customerWhatsapp === "not_configured" || ch.customerWhatsapp === "not_routed" ? null : "WhatsApp Business", label: customer, meaning: ch.customerWhatsapp === "not_routed" ? "WhatsApp is set up, but no number is routed to this business yet." : LABEL_MEANING[customer], reads: ["Customer messages"], does: ch.customerWhatsapp === "live" ? ["Reply to customers"] : [], health: ch.customerWhatsapp === "live" || ch.customerWhatsapp === "dry_run" ? "healthy" : "not_set_up", lastCheck: null, missingForLaunch: [], used: true },
    { id: "whatsapp_owner", name: "WhatsApp — you and BARRY", provider: ch.ownerCommands === "not_connected" ? null : "WhatsApp Business", label: owner, meaning: ch.ownerCommands === "not_linked" ? "BARRY's owner line is ready — link your number in Settings." : owner === "REAL" ? "Message BARRY from your phone — same records and rules as this site." : LABEL_MEANING[owner], reads: ["Your messages to BARRY"], does: ch.ownerCommands === "connected" ? ["Brief you", "Ask for your decisions"] : [], health: ch.ownerCommands === "connected" ? "healthy" : "not_set_up", lastCheck: null, missingForLaunch: [], used: true },
    { id: "understanding", name: "BARRY's understanding (AI)", provider: ai.mode === "live_model" ? "Live AI model" : "Simulator", label: aiLabel, meaning: ai.summary, reads: ["What customers write"], does: [], health: ai.status === "unavailable" ? "down" : ai.status === "degraded" ? "degraded" : ai.mode === "live_model" ? "healthy" : "not_set_up", lastCheck: null, missingForLaunch: [], used: true },
  ];
}

// ── BARRY setup (readiness, owner words) ─────────────────────────────────────────────────────────────

export type SetupGroupId = "owner" | "connection" | "team" | "optional";
export type SetupItem = { id: string; label: string; detail: string; fix?: string; href?: string; linkLabel?: string };

const GROUP_TITLE: Record<SetupGroupId, string> = { owner: "Needs you", connection: "Needs a connection", team: "Needs the BARRY team", optional: "Optional — recommended" };

function groupOf(c: ReadinessCheck): SetupGroupId {
  if (c.status === "warn") return "optional";
  if (c.area === "knowledge" || c.area === "handoff" || c.area === "authority") return "owner";
  if (c.area === "systems" || c.area === "payments" || c.area === "channel") return "connection";
  return "team";
}

function linkOf(c: ReadinessCheck): Pick<SetupItem, "href" | "linkLabel"> {
  if (c.area === "knowledge" || c.area === "handoff") return { href: "/owner/knowledge#teach", linkLabel: "Teach BARRY" };
  if (c.area === "authority") return { href: "/owner/rules", linkLabel: "Rules BARRY follows" };
  if (c.area === "systems" || c.area === "payments") return { href: "/owner/systems", linkLabel: "Connected systems" };
  if (c.area === "channel") return { href: "/owner/systems#whatsapp_customers", linkLabel: "Connected systems" };
  return {};
}

const LEVEL_ORDER = ["NOT_READY", "READY_FOR_TESTING", "READY_FOR_SUPERVISED_PILOT", "READY_FOR_CUSTOMER_TRAFFIC"] as const;

export type SetupView = {
  headline: string;
  /** The server's assessed level — never recomputed here. */
  level: PilotReadiness["level"];
  supervisedReady: boolean;
  left: number;
  groups: { id: SetupGroupId; title: string; items: SetupItem[] }[];
  /** Release requirements before real customer traffic — the BARRY team's, shown apart so they don't read as the owner's to-do. */
  later: SetupItem[];
  journey: { id: string; title: string; state: "done" | "now" | "later"; detail: string; href?: string }[];
};

export function setupView(input: { readiness: PilotReadiness; mode: "simulator" | "supervised" | "live"; rulesActive: number; signedIn: boolean }): SetupView {
  const r = input.readiness;
  const atLeast = (l: (typeof LEVEL_ORDER)[number]) => LEVEL_ORDER.indexOf(r.level) >= LEVEL_ORDER.indexOf(l);
  const supervisedReady = atLeast("READY_FOR_SUPERVISED_PILOT");
  const now = r.checks.filter((c) => c.gate !== "READY_FOR_CUSTOMER_TRAFFIC" && c.status !== "pass");
  const groups = (["owner", "connection", "team", "optional"] as SetupGroupId[])
    .map((id) => ({ id, title: GROUP_TITLE[id], items: now.filter((c) => groupOf(c) === id).map((c): SetupItem => ({ id: c.id, label: c.label, detail: c.detail, ...(c.fix ? { fix: c.fix } : {}), ...linkOf(c) })) }))
    .filter((g) => g.items.length > 0);
  const left = now.filter((c) => c.status === "fail").length;
  const later = r.checks.filter((c) => c.gate === "READY_FOR_CUSTOMER_TRAFFIC" && c.status === "fail").map((c) => ({ id: c.id, label: c.label, detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) }));
  const has = (g: SetupGroupId, area?: ReadinessCheck["area"][]) => now.some((c) => c.status === "fail" && groupOf(c) === g && (!area || area.includes(c.area)));
  const headline = atLeast("READY_FOR_CUSTOMER_TRAFFIC") ? "Ready for real customers" : supervisedReady ? "Ready to start supervised" : `${left} thing${left === 1 ? "" : "s"} left before a supervised start`;
  const step = (done: boolean, before: boolean) => (done ? "done" : before ? "now" : "later") as "done" | "now" | "later";
  const connected = !has("connection");
  const taught = !has("owner", ["knowledge", "handoff"]);
  const decided = !has("owner", ["authority"]);
  return {
    headline,
    level: r.level,
    supervisedReady,
    left,
    groups,
    later,
    journey: [
      { id: "meet", title: "Meet BARRY", state: input.signedIn ? "done" : "now", detail: "Sign in — you see only your own business." },
      { id: "connect", title: "Connect your business", state: step(connected, true), detail: connected ? "Every system BARRY needs is connected." : "Some systems aren't connected yet (or run on a simulator).", href: "/owner/systems" },
      { id: "teach", title: "Teach BARRY", state: step(taught, true), detail: taught ? "BARRY has the answers it needs to start." : "A few answers only you can give.", href: "/owner/knowledge#teach" },
      { id: "decide", title: "Decide what BARRY can do", state: step(decided, true), detail: `${input.rulesActive} rule${input.rulesActive === 1 ? "" : "s"} in force. Above your limits, BARRY asks you first.`, href: "/owner/rules" },
      { id: "supervised", title: "Supervised start", state: input.mode !== "simulator" && supervisedReady ? "done" : supervisedReady ? "now" : "later", detail: supervisedReady ? "BARRY works with real customers while the BARRY team watches closely and you approve what matters." : "Unlocks once everything above is done." },
      { id: "autonomy", title: "Earn more autonomy", state: input.mode === "live" ? "done" : "later", detail: "Never automatic: after a supervised period, you and the BARRY team decide together what BARRY may do on its own." },
    ],
  };
}

// ── Activity ───────────────────────────────────────────────────────────────────────────────────────

export type TimelineItem = ActivityItem & { href?: string };

/** Everything that happened, in human words, newest first — each item drills down to its record. */
export function activityTimeline(ws: Pick<OwnerWorkspace, "outcomes" | "approvals" | "obligations" | "conversations" | "ownerCommands" | "ownerOperations" | "initiatives"> & Partial<Pick<OwnerWorkspace, "initiativeHistory">>, limit = 60): TimelineItem[] {
  const out: TimelineItem[] = activityFeed(ws, limit);
  const SOURCE = { web: "on the site", whatsapp: "on WhatsApp", voice: "by voice" } as const;
  for (const c of ws.ownerCommands) {
    if (!c.at) continue;
    out.push({ id: `cmd:${c.id}`, at: c.at, icon: "chat", tone: "violet", text: `You asked BARRY ${SOURCE[c.source] ?? ""}: “${c.text}”`, sub: c.reply || undefined, ...(c.operationId ? { href: `/owner?tab=work&operation=${encodeURIComponent(c.operationId)}` } : {}) });
  }
  for (const o of ws.ownerOperations) {
    if (o.stoppedAt) out.push({ id: `op-stop:${o.id}`, at: o.stoppedAt, icon: "shield", tone: "neutral", text: `You stopped: ${o.title}`, href: `/owner?tab=work&operation=${encodeURIComponent(o.id)}` });
  }
  for (const i of [...ws.initiatives, ...(ws.initiativeHistory ?? [])]) {
    const at = i.surfacedAt ?? i.firstSeenAt;
    out.push({ id: `ini:${i.id}`, at, icon: "flag", tone: "violet", text: `BARRY noticed: ${i.title}`, sub: i.basis, href: "/owner?tab=work#noticed" });
    if (i.decidedAt && (i.state === "dismissed" || i.state === "snoozed")) out.push({ id: `ini-d:${i.id}`, at: i.decidedAt, icon: "flag", tone: "neutral", text: `You ${i.state === "dismissed" ? "dismissed" : "snoozed"}: ${i.title}` });
  }
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, limit);
}
