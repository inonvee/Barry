import type { Obligation, ObligationKind } from "@/lib/operator/obligation-model";
import { isOpen } from "@/lib/operator/obligation-model";
import type { Opportunity } from "@/lib/owner/opportunities";
import { isAtRisk } from "@/lib/owner/opportunities";
import type { CostEvidence } from "@/lib/finance/impact";
import type { Money } from "@/lib/owner/revenue";
import { PROACTIVE } from "@/lib/owner/control-room";
import type { EvidenceKind, EvidenceRef, Initiative } from "./model";

/**
 * V1 DETECTORS (pure) — each reads ONE business's snapshot of trusted records and returns candidates
 * with the exact record references behind every number. They never read another tenant, never read a
 * model's prose as a fact (only runtime-grounded fields: knowledge topics validated against the
 * business's own knowledge, ask outcomes decided by the runtime, ledger effects, provider records), and
 * they return nothing when nothing clears the bar. Thresholds are deliberately conservative.
 */

export type SnapshotConversation = {
  id: string;
  simulated: boolean;
  turns: { id: string; at: string; asks: { kind: string; status: string; topic?: string }[] }[];
  /** Cart effects BARRY confirmed with the provider: product title (variant stripped), when. */
  cartAdds: { at: string; product: string; seq: number }[];
};

export type Snapshot = {
  businessId: string;
  timezone: string;
  now: Date;
  /** Business-local windows (ISO instants). */
  window: { d7: string; d14: string; d30: string; d60: string; localDate: string };
  knowledgeTopics: string[];
  plan: { proactive: boolean; margins: boolean; name: string | null };
  rules: { kind: ObligationKind; enabled: boolean }[];
  obligations: Obligation[];
  approvals: { id: string; action: string; lifecycle: string; createdAt: string; terms: Record<string, string | number> }[];
  conversations: SnapshotConversation[];
  orders: { id: string; conversationId: string; createdAt: string; simulated: boolean }[];
  opportunities: Opportunity[];
  /** Workflows with an owner operation already running. */
  activeWorkflows: ObligationKind[];
  costEvidence: CostEvidence[];
  /** Systems running on a simulator (e.g. "commerce", "payments"): their amounts are test values, never money. */
  simulatedSystems: string[];
};

export type Candidate = Pick<Initiative, "category" | "detector" | "subject" | "title" | "observation" | "basis" | "evidence" | "metric" | "confidence" | "importance" | "impact" | "recommendation" | "entitlement" | "authority" | "canAct" | "ownerActionNeeded"> &
  Partial<Pick<Initiative, "requiredFeature" | "alreadyHandled" | "testData" | "external">> & {
    window: { from: string; to: string; label: string };
    /** Which evidence kind `metric.count` counts (distinct ids) — re-checked by verification. */
    counts: EvidenceKind;
    /** Evidence kind whose records produce `metric.amount` — every one must be real (non-simulated). */
    amountFrom?: EvidenceKind;
  };

const pl = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const label = (topic: string) => topic.replace(/[_-]+/g, " ").trim();
const add = (m: Money, c: string | undefined, v: number | undefined) => {
  if (!c || v === undefined) return;
  m[c] = Math.round(((m[c] ?? 0) + v) * 100) / 100;
};
const fmt = (m: Money) => Object.entries(m).map(([c, v]) => new Intl.NumberFormat("en", { style: "currency", currency: c, maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v)).join(" + ");
const realConversation = (s: Snapshot, id: string) => !s.conversations.find((c) => c.id === id)?.simulated;
const purchased = (s: Snapshot, conversationId: string, after?: string) => s.orders.some((o) => o.conversationId === conversationId && (!after || o.createdAt >= after));

const now7 = (s: Snapshot) => ({ from: s.window.d7, to: s.now.toISOString(), label: "the last 7 days" });

// ── A + D: what customers keep asking (and whether it comes before people drop) ─────────────────

export const MIN_TOPIC_CONVERSATIONS = 5;

export function repeatedQuestions(s: Snapshot): Candidate[] {
  const topics = new Set(s.knowledgeTopics);
  const byTopic = new Map<string, { conversations: Set<string>; turns: EvidenceRef[]; firstAt: Map<string, string> }>();
  for (const c of s.conversations) {
    for (const t of c.turns) {
      if (t.at < s.window.d7) continue;
      for (const a of t.asks) {
        // Only topics the runtime grounded in the business's own knowledge (never free model text).
        if (a.kind !== "question" || !a.topic || !topics.has(a.topic)) continue;
        const g = byTopic.get(a.topic) ?? { conversations: new Set<string>(), turns: [] as EvidenceRef[], firstAt: new Map<string, string>() };
        g.conversations.add(c.id);
        g.turns.push({ kind: "turn", id: t.id, at: t.at });
        if (!g.firstAt.has(c.id) || t.at < g.firstAt.get(c.id)!) g.firstAt.set(c.id, t.at);
        byTopic.set(a.topic, g);
      }
    }
  }
  const out: Candidate[] = [];
  for (const [topic, g] of byTopic) {
    const n = g.conversations.size;
    if (n < MIN_TOPIC_CONVERSATIONS) continue;
    // Of those, who went on to a cart and still hasn't bought (verified order) since asking.
    const reachedCart = [...g.conversations].filter((id) => s.conversations.find((c) => c.id === id)?.cartAdds.some((a) => a.at >= g.firstAt.get(id)!));
    const dropped = reachedCart.filter((id) => !purchased(s, id, g.firstAt.get(id)));
    const friction = dropped.length >= 3 && dropped.length / n >= 0.4;
    const evidence: EvidenceRef[] = [...[...g.conversations].map((id) => ({ kind: "conversation" as const, id })), ...g.turns];
    out.push({
      category: friction ? "sales_friction" : "customer_experience",
      detector: "repeated_question",
      subject: topic,
      title: friction ? `Customers ask about ${label(topic)} — then many don't buy` : `${label(topic)} is a recurring question`,
      observation: friction
        ? `${pl(n, "customer")} asked about ${label(topic)} in the last 7 days. ${dropped.length} of them added something to their cart afterwards and still haven't completed a purchase.`
        : `${pl(n, "customer")} asked about ${label(topic)} in the last 7 days.`,
      basis: `Counted from ${pl(n, "conversation")} (${pl(g.turns.length, "question")}) where BARRY answered from your ${label(topic)} information.`,
      evidence,
      metric: { count: n, total: dropped.length, rate: Math.round((dropped.length / n) * 100) / 100 },
      confidence: n >= 10 ? "high" : "medium",
      importance: friction ? "medium" : "low",
      impact: friction ? { type: "conversion", note: "Purchases not completed after this question — not a revenue figure." } : { type: "customer_experience" },
      recommendation: {
        text: friction
          ? `Make your ${label(topic)} answer visible earlier (product page, first reply or checkout) so people don't have to ask. BARRY already answers it from your business information.`
          : `If the answer to ${label(topic)} isn't on your product pages yet, adding it there would save customers a question.`,
        action: { kind: "link", href: "/owner/train", label: "Check what BARRY says" },
      },
      entitlement: "not_needed",
      authority: "owner_only",
      canAct: false,
      ownerActionNeeded: true,
      testData: [...g.conversations].every((id) => !realConversation(s, id)),
      window: now7(s),
      counts: "conversation",
    });
  }
  return out;
}

export const MIN_UNANSWERED_CONVERSATIONS = 3;

/** Questions BARRY couldn't answer from the business's information (the runtime said so, not a guess). */
export function unansweredQuestions(s: Snapshot): Candidate[] {
  const convs = new Set<string>();
  const turns: EvidenceRef[] = [];
  for (const c of s.conversations) {
    for (const t of c.turns) {
      if (t.at < s.window.d7) continue;
      const missed = t.asks.filter((a) => a.kind === "question" && !a.topic && (a.status === "not_done" || a.status === "handoff"));
      if (!missed.length) continue;
      convs.add(c.id);
      turns.push({ kind: "turn", id: t.id, at: t.at });
    }
  }
  if (convs.size < MIN_UNANSWERED_CONVERSATIONS) return [];
  return [
    {
      category: "customer_experience",
      detector: "unanswered_questions",
      subject: "missing_business_information",
      title: "Customers ask things BARRY can't answer yet",
      observation: `In ${pl(convs.size, "conversation")} this week, customers asked ${pl(turns.length, "question")} your business information doesn't cover, so BARRY couldn't answer.`,
      basis: `Counted from ${pl(turns.length, "turn")} where BARRY recorded the question as unanswered.`,
      evidence: [...[...convs].map((id) => ({ kind: "conversation" as const, id })), ...turns],
      metric: { count: convs.size, total: turns.length },
      confidence: "high",
      importance: convs.size >= 6 ? "medium" : "low",
      impact: { type: "customer_experience" },
      recommendation: { text: "Read those conversations and teach BARRY the missing answers — each one saves the next customer a wait.", action: { kind: "link", href: "/owner/train", label: "Teach BARRY" } },
      entitlement: "not_needed",
      authority: "owner_only",
      canAct: false,
      ownerActionNeeded: true,
      testData: [...convs].every((id) => !realConversation(s, id)),
      window: now7(s),
      counts: "conversation",
    },
  ];
}

// ── B: abandoned demand (reuses the grounded obligations — no second recovery model) ─────────────

export const MIN_DEMAND_ITEMS = 2;
const DEMAND: { kind: ObligationKind; noun: [string, string]; feature: string; system: string; where: string }[] = [
  { kind: "abandoned_checkout_recovery", noun: ["abandoned checkout", "abandoned checkouts"], feature: "proactive_followups", system: "commerce", where: "left in carts" },
  { kind: "unpaid_payment_followup", noun: ["unpaid payment link", "unpaid payment links"], feature: "proactive_followups", system: "payments", where: "in open payment links" },
];

export function abandonedDemand(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const d of DEMAND) {
    const open = s.obligations.filter((o) => o.kind === d.kind && isOpen(o) && o.nextMove !== "needs_owner" && o.nextMove !== "blocked_by_capability");
    const untouched = open.filter((o) => !(o.attempts ?? 0));
    if (untouched.length < MIN_DEMAND_ITEMS) continue;
    const testSystem = s.simulatedSystems.includes(d.system);
    const isTest = (o: Obligation) => Boolean(o.simulated) || testSystem;
    const amount: Money = {};
    for (const o of untouched) if (!isTest(o)) add(amount, o.currency, o.amount);
    const rule = s.rules.find((r) => r.kind === d.kind);
    const runs = s.plan.proactive && rule?.enabled !== false;
    const handled = s.activeWorkflows.includes(d.kind);
    const command = PROACTIVE.find((p) => p.kind === d.kind)!.command;
    const n = untouched.length;
    out.push({
      category: "abandoned_demand",
      detector: "abandoned_demand",
      subject: d.kind,
      title: `${pl(n, d.noun[0], d.noun[1])} with no follow-up yet`,
      observation: `${pl(open.length, d.noun[0], d.noun[1])} ${open.length === 1 ? "is" : "are"} still open. ${n} ${n === 1 ? "hasn't" : "haven't"} been followed up yet${Object.keys(amount).length ? ` (${fmt(amount)} ${d.where} — not revenue)` : ""}.`,
      basis: `From ${pl(n, "open record")} BARRY is tracking${untouched.some(isTest) ? "; test-mode items are counted but never as money" : ""}.`,
      evidence: untouched.map((o) => ({ kind: "obligation" as const, id: o.key, at: o.createdAt })),
      metric: { count: n, total: open.length, ...(Object.keys(amount).length ? { amount } : {}) },
      confidence: "high",
      importance: Object.keys(amount).length ? "high" : "medium",
      impact: Object.keys(amount).length ? { type: "recoverable_demand", amount, note: "Open, not revenue — only a verified payment counts." } : { type: "recoverable_demand" },
      recommendation: runs
        ? { text: `I can follow up with them now — one reminder each, within your rules, and I'll show you exactly who first.`, action: { kind: "command", command, label: "Do this" } }
        : !s.plan.proactive
          ? { text: `Following up yourself would give these customers a nudge. Automatic follow-ups are part of the Operator plan.`, action: { kind: "link", href: "/owner/settings#plan", label: "See plans" } }
          : { text: `Your follow-up rules turn this off. You can follow up yourself, or change the rule in Train BARRY.`, action: { kind: "link", href: "/owner/train", label: "Train BARRY" } },
      requiredFeature: d.feature,
      entitlement: s.plan.proactive ? "included" : "not_included",
      authority: "within_owner_rules",
      canAct: runs && !handled,
      ownerActionNeeded: !runs,
      alreadyHandled: handled,
      testData: untouched.every(isTest),
      window: { from: untouched.map((o) => o.createdAt).sort()[0], to: s.now.toISOString(), label: "still open" },
      counts: "obligation",
      ...(Object.keys(amount).length ? { amountFrom: "obligation" as const } : {}),
    });
  }
  return out;
}

// ── C: owner friction (the same decision, again and again) ───────────────────────────────────────

export const MIN_REPEAT_APPROVALS = 3;
const ACTION_WORDS: Record<string, [string, string]> = { grantDiscount: ["discount request", "discount requests"] };

export function ownerFriction(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  // Owner decisions: approved (incl. executed / failed after approval) vs declined; pending ones count as "asked".
  const APPROVED = ["approved", "executed", "executed_unconfirmed", "failed"];
  const recent = s.approvals.filter((a) => a.createdAt >= s.window.d14 && (APPROVED.includes(a.lifecycle) || a.lifecycle === "declined" || a.lifecycle === "active"));
  const byAction = new Map<string, typeof recent>();
  for (const a of recent) byAction.set(a.action, [...(byAction.get(a.action) ?? []), a]);
  for (const [action, list] of byAction) {
    const approved = list.filter((a) => APPROVED.includes(a.lifecycle));
    if (approved.length < MIN_REPEAT_APPROVALS || approved.length / list.length < 0.75) continue;
    const words = ACTION_WORDS[action] ?? ["request", "requests"];
    const pcts = approved.map((a) => Number(a.terms.discountPct)).filter((x) => Number.isFinite(x) && x > 0);
    const range = pcts.length ? (Math.min(...pcts) === Math.max(...pcts) ? `${Math.max(...pcts)}%` : `${Math.min(...pcts)}–${Math.max(...pcts)}%`) : "";
    const rule = pcts.length ? `Approve discounts up to ${Math.max(...pcts)}% without asking me` : undefined;
    out.push({
      category: "owner_friction",
      detector: "repeat_approvals",
      subject: action,
      title: `You keep approving the same kind of ${words[0]}`,
      observation: `In the last 14 days you approved ${approved.length} of ${pl(list.length, words[0], words[1])}${range ? ` (${range})` : ""} that BARRY had to stop and ask you about.`,
      basis: `From ${pl(list.length, "request")} on record and your decision on each.`,
      evidence: list.map((a) => ({ kind: "approval" as const, id: a.id, at: a.createdAt })),
      metric: { count: list.length, total: approved.length, rate: Math.round((approved.length / list.length) * 100) / 100 },
      confidence: list.length >= 5 ? "high" : "medium",
      importance: "low",
      impact: { type: "owner_time", note: `${approved.length} times BARRY waited for you` },
      recommendation: {
        text: `You could teach BARRY a standing rule${range ? ` (for example, up to ${Math.max(...pcts)}%)` : ""} so customers don't wait for you. BARRY won't change your limits on its own — you review the rule first.`,
        action: { kind: "link", href: `/owner/train${rule ? `?rule=${encodeURIComponent(rule)}#teach-rule` : ""}`, label: "Teach a rule" },
      },
      entitlement: "not_needed",
      authority: "owner_decides",
      canAct: false,
      ownerActionNeeded: true,
      window: { from: s.window.d14, to: s.now.toISOString(), label: "the last 14 days" },
      counts: "approval",
    });
  }
  return out;
}

// ── A: a product with interest but few purchases ─────────────────────────────────────────────────

export const MIN_PRODUCT_INTEREST = 5;

export function productInterest(s: Snapshot): Candidate[] {
  const byProduct = new Map<string, Map<string, string>>();
  for (const c of s.conversations) {
    for (const a of c.cartAdds) {
      if (a.at < s.window.d7) continue;
      const m = byProduct.get(a.product) ?? new Map<string, string>();
      if (!m.has(c.id) || a.at < m.get(c.id)!) m.set(c.id, a.at);
      byProduct.set(a.product, m);
    }
  }
  const out: Candidate[] = [];
  for (const [product, convs] of byProduct) {
    const n = convs.size;
    if (n < MIN_PRODUCT_INTEREST) continue;
    const bought = [...convs].filter(([id, at]) => purchased(s, id, at));
    if (bought.length / n > 0.25) continue;
    out.push({
      category: "sales_friction",
      detector: "product_interest",
      subject: product,
      title: `${product}: interest, few purchases`,
      observation: `${pl(n, "customer")} added ${product} to their cart in the last 7 days; ${bought.length} completed a purchase.`,
      basis: `From cart changes BARRY confirmed with your store in ${pl(n, "conversation")}, and the orders that followed.`,
      evidence: [...convs.keys()].map((id) => ({ kind: "conversation" as const, id })),
      metric: { count: n, total: bought.length, rate: Math.round((bought.length / n) * 100) / 100 },
      confidence: n >= 10 ? "high" : "medium",
      importance: "medium",
      impact: { type: "conversion", note: "Carts not completed — not a revenue figure." },
      recommendation: { text: `People want ${product} but stop after the cart. Its price, sizes / availability or delivery details are the usual places to look — open a few of these conversations to see where they stopped.`, action: { kind: "link", href: "/owner?tab=inbox", label: "Open conversations" } },
      entitlement: "not_needed",
      authority: "owner_only",
      canAct: false,
      ownerActionNeeded: true,
      testData: [...convs.keys()].every((id) => !realConversation(s, id)),
      window: now7(s),
      counts: "conversation",
    });
  }
  return out;
}

// ── E: money at risk (real money only; test money never) ─────────────────────────────────────────

export function moneyAtRisk(s: Snapshot): Candidate[] {
  const items = s.opportunities.filter((o) => !o.simulated && o.amount !== undefined && o.currency && isAtRisk(o));
  if (!items.length) return [];
  const amount: Money = {};
  for (const o of items) add(amount, o.currency, o.amount);
  return [
    {
      category: "money_leakage",
      detector: "money_at_risk",
      subject: "at_risk",
      title: `${fmt(amount)} is at risk`,
      observation: `${fmt(amount)} across ${pl(items.length, "sale")} is likely to be lost unless someone acts — failed payments, stalled purchases or old unpaid links.`,
      basis: `From ${pl(items.length, "open record")} on your real payment provider. Not revenue; test money is never included.`,
      evidence: items.map((o) => ({ kind: "payment" as const, id: o.id, at: o.since })),
      metric: { count: items.length, amount },
      confidence: "high",
      importance: "high",
      impact: { type: "revenue_at_risk", amount, note: "At risk, not lost yet — and never counted as revenue." },
      recommendation: { text: "Each one says whose move it is. Starting with the largest is usually worth it.", action: { kind: "link", href: "/owner?tab=money", label: "See them" } },
      entitlement: "not_needed",
      authority: "owner_decides",
      canAct: false,
      ownerActionNeeded: true,
      window: { from: items.map((o) => o.since).sort()[0], to: s.now.toISOString(), label: "open now" },
      counts: "payment",
      amountFrom: "payment",
    },
  ];
}

// ── F: cost signals (verified cost evidence only; a saving is never claimed without proof) ──────

export const COST_INCREASE = 0.15;

export function costSignals(s: Snapshot): Candidate[] {
  const verified = s.costEvidence.filter((e) => e.businessId === s.businessId && e.verified && !e.exposure && e.amount > 0);
  const out: Candidate[] = [];
  if (!verified.length) {
    // Only a business actually ON a plan with cost analysis hears this (no account = no promise was made).
    if (!s.plan.margins || !s.plan.name) return [];
    // Intelligence includes cost analysis but there is nothing to analyse — say so once, plainly.
    return [
      {
        category: "cost_margin",
        detector: "cost_evidence_missing",
        subject: "cost_evidence",
        title: "BARRY can't look for savings yet",
        observation: "Your plan includes cost and margin analysis, but no verified cost records are connected, so there is nothing to compare.",
        basis: "No verified cost records on file.",
        evidence: [],
        metric: { count: 0 },
        confidence: "high",
        importance: "low",
        impact: { type: "evidence_needed", note: "No saving is claimed." },
        recommendation: { text: "Connect the system that holds your supplier, shipping or fee costs, and BARRY will compare periods — only from those records.", action: { kind: "link", href: "/connections", label: "Connections" } },
        requiredFeature: "margins",
        entitlement: "included",
        authority: "owner_only",
        canAct: false,
        ownerActionNeeded: true,
        window: { from: s.window.d30, to: s.now.toISOString(), label: "the last 30 days" },
        counts: "cost_record",
      },
    ];
  }
  const groups = new Map<string, CostEvidence[]>();
  for (const e of verified) groups.set(`${e.category ?? e.kind}|${e.currency}`, [...(groups.get(`${e.category ?? e.kind}|${e.currency}`) ?? []), e]);
  for (const [key, list] of groups) {
    const [what, currency] = key.split("|");
    const cur = list.filter((e) => e.at >= s.window.d30);
    const prev = list.filter((e) => e.at >= s.window.d60 && e.at < s.window.d30);
    if (cur.length < 2 || prev.length < 2) continue;
    const a = cur.reduce((x, e) => x + e.amount, 0);
    const b = prev.reduce((x, e) => x + e.amount, 0);
    if (b <= 0 || (a - b) / b < COST_INCREASE) continue;
    const pct = Math.round(((a - b) / b) * 100);
    const m = (v: number) => fmt({ [currency]: Math.round(v * 100) / 100 });
    out.push({
      category: "cost_margin",
      detector: "cost_increase",
      subject: what,
      title: `${label(what)} costs rose ${pct}%`,
      observation: `${label(what)} costs were ${m(a)} in the last 30 days, up ${pct}% from ${m(b)} in the 30 days before.`,
      basis: `From ${pl(cur.length + prev.length, "verified cost record")} (${cur.length} recent, ${prev.length} before). I don't have enough evidence to claim a saving.`,
      evidence: [...cur, ...prev].map((e) => ({ kind: "cost_record" as const, id: e.id, at: e.at })),
      metric: { count: cur.length + prev.length, amount: { [currency]: Math.round((a - b) * 100) / 100 }, rate: Math.round(((a - b) / b) * 100) / 100 },
      confidence: cur.length + prev.length >= 6 ? "high" : "medium",
      importance: pct >= 30 ? "medium" : "low",
      impact: { type: "cost_increase", amount: { [currency]: Math.round((a - b) * 100) / 100 }, note: "An increase in what you paid — not a saving opportunity until a cheaper option is proven." },
      recommendation: s.plan.margins
        ? { text: "Worth checking whether volume, prices or a supplier changed. BARRY Margins can prepare a comparison from these records.", action: { kind: "link", href: "/owner?tab=money", label: "Open Money" } }
        : { text: "Worth checking whether volume, prices or a supplier changed.", action: { kind: "link", href: "/owner?tab=money", label: "Open Money" } },
      requiredFeature: "margins",
      entitlement: s.plan.margins ? "included" : "not_included",
      authority: "owner_only",
      canAct: false,
      ownerActionNeeded: true,
      window: { from: s.window.d60, to: s.now.toISOString(), label: "the last 60 days" },
      counts: "cost_record",
      amountFrom: "cost_record",
    });
  }
  return out;
}

export const DETECTORS: { id: string; run: (s: Snapshot) => Candidate[] }[] = [
  { id: "repeated_question", run: repeatedQuestions },
  { id: "unanswered_questions", run: unansweredQuestions },
  { id: "abandoned_demand", run: abandonedDemand },
  { id: "repeat_approvals", run: ownerFriction },
  { id: "product_interest", run: productInterest },
  { id: "money_at_risk", run: moneyAtRisk },
  { id: "cost_signals", run: costSignals },
];
