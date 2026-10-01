import { getBackend } from "@/lib/store";
import { qaEnabled } from "@/lib/qa/mode";
import { CATALOG_VERSION, FREE_PERIOD_DAYS, PLAN_CATALOG, type Feature, type PlanId } from "./plans";
import { setEntitlement, type Entitlement } from "./entitlements";
import { getCommercialBilling, type BillingResult } from "./billing";

/**
 * THE COMMERCIAL ACCOUNT — BARRY's own commercial state with ONE business (founder / server only; the
 * owner never sees cost or margin). One durable record per business plus an append-only audit of every
 * change (who, when, why, before → after). Every step goes through the vendor-neutral billing boundary.
 *
 * THE FREE MONTH starts only when the founder ACTIVATES the business — never at signature, never while
 * an integration is still being set up. Activation requires the setup fee paid or waived and the
 * design-partner commercial readiness gate READY (an override needs a reason and is audited). A pause
 * during the free period stops its clock: resuming extends the end by the paused time.
 */

export type SetupStatus = "not_quoted" | "quoted" | "invoiced" | "paid" | "waived";
export type SubscriptionState = "pre_activation" | "free_period" | "active" | "paused" | "cancelled";

export type CommercialAccount = {
  businessId: string;
  plan: PlanId;
  planVersion: string;
  /** The features bought — a snapshot taken with the plan. A later catalog change never silently removes them. */
  features: Feature[];
  monthlyPrice: number;
  currency: string;
  setupPrice: number | null;
  setupStatus: SetupStatus;
  foundingCustomer: boolean;
  priceLockUntil: string | null;
  lockedMonthlyPrice: number | null;
  subscriptionState: SubscriptionState;
  freePeriodStartsAt: string | null;
  freePeriodEndsAt: string | null;
  /** Planned start of paid recurring (= end of the free period). */
  recurringStartsAt: string | null;
  /** When the founder confirmed paid recurring started. */
  recurringConfirmedAt: string | null;
  cancellationEffectiveAt: string | null;
  pausedAt: string | null;
  activation: { at: string; by: string; gate: string; override?: string } | null;
  notes: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type CommercialEvent = {
  id: string;
  businessId: string;
  at: string;
  by: string;
  kind: "plan_selected" | "plan_changed" | "setup_quoted" | "setup_invoiced" | "setup_paid" | "setup_waived" | "free_period_started" | "recurring_confirmed" | "paused" | "resumed" | "cancelled" | "note" | "price_lock_set" | "qa_plan_emulated";
  reason: string;
  before: Partial<CommercialAccount> | null;
  after: Partial<CommercialAccount>;
  billing?: BillingResult;
  /** The account revision this event produced (orders events with the same timestamp). */
  revision?: number;
};

export class CommercialError extends Error {}

const KEY = "current";
const QA_KEY = "qa_emulation";
const DAY = 24 * 3600_000;
const iso = (d: Date) => d.toISOString();

export async function getCommercialAccount(businessId: string): Promise<CommercialAccount | null> {
  const r = (await getBackend().listOperatorRecords(businessId, "commercial_account")).find((x) => x.key === KEY);
  return r ? (r.data as unknown as CommercialAccount) : null;
}

export async function listCommercialAccounts(): Promise<CommercialAccount[]> {
  return (await getBackend().listOperatorRecordsAcrossBusinesses("commercial_account")).filter((r) => r.key === KEY).map((r) => r.data as unknown as CommercialAccount);
}

export async function listCommercialEvents(businessId: string): Promise<CommercialEvent[]> {
  return (await getBackend().listOperatorRecords(businessId, "commercial_event")).map((r) => r.data as unknown as CommercialEvent).sort((a, b) => b.at.localeCompare(a.at) || (b.revision ?? 0) - (a.revision ?? 0));
}

/** The monthly price in force at `now` (a founding price lock wins while it lasts). */
export function effectiveMonthlyPrice(a: CommercialAccount, now = new Date()): number {
  return a.foundingCustomer && a.lockedMonthlyPrice !== null && a.priceLockUntil && iso(now) < a.priceLockUntil ? a.lockedMonthlyPrice : a.monthlyPrice;
}

/** Load the entitlement the policy engine enforces this turn (QA emulation first, only where QA is on). */
export async function loadEntitlement(businessId: string): Promise<Entitlement> {
  let e: Entitlement = { plan: null, features: null, emulated: false };
  try {
    const records = await getBackend().listOperatorRecords(businessId, "commercial_account");
    const qa = qaEnabled() ? records.find((r) => r.key === QA_KEY) : undefined;
    const account = records.find((r) => r.key === KEY)?.data as unknown as CommercialAccount | undefined;
    const qaPlan = qa ? ((qa.data as { plan?: PlanId | null }).plan ?? null) : null;
    if (qaPlan && PLAN_CATALOG[qaPlan]) e = { plan: qaPlan, features: [...PLAN_CATALOG[qaPlan].features], emulated: true };
    else if (account) e = { plan: account.plan, features: account.features, emulated: false };
  } catch (err) {
    // Unreadable commercial state never GRANTS anything: authority still decides every action.
    console.error("[barry:commercial] entitlement unavailable — authority alone decides this turn", err instanceof Error ? err.message : err);
  }
  setEntitlement(businessId, e);
  return e;
}

async function save(a: CommercialAccount, event: Omit<CommercialEvent, "id" | "businessId" | "at" | "after"> & { after?: Partial<CommercialAccount> }, now: Date): Promise<{ account: CommercialAccount; event: CommercialEvent }> {
  const backend = getBackend();
  const at = iso(now);
  const account = { ...a, updatedAt: at };
  await backend.upsertOperatorRecord({ businessId: a.businessId, kind: "commercial_account", key: KEY, data: account as unknown as Record<string, unknown> });
  const e: CommercialEvent = { id: `cev_${Date.parse(at).toString(36)}_${Math.random().toString(36).slice(2, 8)}`, businessId: a.businessId, at, revision: account.revision, ...event, after: event.after ?? diff(event.before, account) };
  await backend.upsertOperatorRecord({ businessId: a.businessId, kind: "commercial_event", key: e.id, data: e as unknown as Record<string, unknown> });
  setEntitlement(a.businessId, { plan: account.plan, features: account.features, emulated: false });
  return { account, event: e };
}

function diff(before: Partial<CommercialAccount> | null, after: CommercialAccount): Partial<CommercialAccount> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (k === "updatedAt" || k === "revision") continue;
    if (!before || JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(v)) out[k] = v;
  }
  return out as Partial<CommercialAccount>;
}

type Meta = { by: string; reason: string; now?: Date };
const need = (m: Meta) => {
  if (!m.by.trim()) throw new CommercialError("Every commercial change records who made it");
  if (!m.reason.trim()) throw new CommercialError("Every commercial change needs a reason");
};

/**
 * Choose (or change) the plan. A change on an existing account is versioned and audited; for a
 * founding customer inside the price lock, a change that REMOVES purchased features needs explicit
 * founder review (`confirmFeatureRemoval`) — never a silent removal.
 */
export async function selectPlan(
  businessId: string,
  input: { plan: PlanId; monthlyPrice?: number; currency?: string; setupPrice?: number; foundingCustomer?: boolean; priceLockMonths?: number; confirmFeatureRemoval?: boolean; notes?: string; source?: string },
  meta: Meta
): Promise<{ account: CommercialAccount; event: CommercialEvent }> {
  need(meta);
  const now = meta.now ?? new Date();
  const def = PLAN_CATALOG[input.plan];
  if (!def) throw new CommercialError(`Unknown plan ${input.plan}`);
  const monthlyPrice = input.monthlyPrice ?? def.monthlyPrice;
  if (monthlyPrice === null || !(monthlyPrice > 0)) throw new CommercialError(`${def.name} needs an agreed monthly price`);
  const before = await getCommercialAccount(businessId);
  if (before && before.subscriptionState === "cancelled") throw new CommercialError("This account is cancelled; record a new agreement first");
  const features = [...def.features];
  if (before) {
    const removed = before.features.filter((f) => !features.includes(f));
    const locked = before.foundingCustomer && before.priceLockUntil !== null && iso(now) < before.priceLockUntil;
    if (removed.length && locked && !input.confirmFeatureRemoval) {
      throw new CommercialError(`Founding customer under price lock: this change removes ${removed.join(", ")}. Confirm the removal explicitly after founder review.`);
    }
  }
  const founding = input.foundingCustomer ?? before?.foundingCustomer ?? false;
  const lockUntil = founding ? (input.priceLockMonths ? iso(new Date(now.getTime() + input.priceLockMonths * 30 * DAY)) : (before?.priceLockUntil ?? null)) : null;
  const account: CommercialAccount = {
    ...(before ?? {
      setupPrice: null,
      setupStatus: "not_quoted" as SetupStatus,
      subscriptionState: "pre_activation" as SubscriptionState,
      freePeriodStartsAt: null,
      freePeriodEndsAt: null,
      recurringStartsAt: null,
      recurringConfirmedAt: null,
      cancellationEffectiveAt: null,
      pausedAt: null,
      activation: null,
      notes: "",
      source: input.source ?? "founder",
      createdAt: iso(now),
      updatedAt: iso(now),
      revision: 0,
    }),
    businessId,
    plan: input.plan,
    planVersion: CATALOG_VERSION,
    features,
    monthlyPrice,
    currency: input.currency ?? before?.currency ?? def.currency,
    ...(input.setupPrice !== undefined ? { setupPrice: input.setupPrice } : {}),
    foundingCustomer: founding,
    priceLockUntil: lockUntil,
    lockedMonthlyPrice: founding ? (input.priceLockMonths ? monthlyPrice : (before?.lockedMonthlyPrice ?? monthlyPrice)) : null,
    ...(input.notes ? { notes: input.notes.slice(0, 2000) } : {}),
    revision: (before?.revision ?? 0) + 1,
  } as CommercialAccount;
  const billing = await getCommercialBilling().createSubscription({ businessId, plan: def.name, monthlyPrice, currency: account.currency });
  return save(account, { by: meta.by, reason: meta.reason.trim(), kind: before ? "plan_changed" : "plan_selected", before, billing }, now);
}

async function mustGet(businessId: string): Promise<CommercialAccount> {
  const a = await getCommercialAccount(businessId);
  if (!a) throw new CommercialError("Choose a plan first");
  return a;
}

export async function quoteSetup(businessId: string, input: { setupPrice: number }, meta: Meta) {
  need(meta);
  const a = await mustGet(businessId);
  if (!(input.setupPrice >= 0)) throw new CommercialError("A setup price is required");
  if (a.setupStatus === "paid" || a.setupStatus === "waived") throw new CommercialError(`Setup is already ${a.setupStatus}`);
  return save({ ...a, setupPrice: input.setupPrice, setupStatus: "quoted", revision: a.revision + 1 }, { by: meta.by, reason: meta.reason, kind: "setup_quoted", before: a }, meta.now ?? new Date());
}

export async function invoiceSetup(businessId: string, meta: Meta) {
  need(meta);
  const a = await mustGet(businessId);
  if (a.setupPrice === null || a.setupStatus !== "quoted") throw new CommercialError("Quote the setup first");
  const billing = await getCommercialBilling().createSetupInvoice({ businessId, amount: a.setupPrice, currency: a.currency });
  return save({ ...a, setupStatus: "invoiced", revision: a.revision + 1 }, { by: meta.by, reason: meta.reason, kind: "setup_invoiced", before: a, billing }, meta.now ?? new Date());
}

export async function markSetupPaid(businessId: string, input: { reference?: string }, meta: Meta) {
  need(meta);
  const a = await mustGet(businessId);
  if (a.setupPrice === null || (a.setupStatus !== "quoted" && a.setupStatus !== "invoiced")) throw new CommercialError("Quote the setup before recording its payment");
  const billing = await getCommercialBilling().markSetupPaid({ businessId, amount: a.setupPrice, currency: a.currency, ...(input.reference ? { reference: input.reference } : {}) });
  return save({ ...a, setupStatus: "paid", revision: a.revision + 1 }, { by: meta.by, reason: meta.reason, kind: "setup_paid", before: a, billing }, meta.now ?? new Date());
}

export async function waiveSetup(businessId: string, meta: Meta) {
  need(meta);
  const a = await mustGet(businessId);
  if (a.setupStatus === "paid") throw new CommercialError("Setup is already paid");
  return save({ ...a, setupStatus: "waived", revision: a.revision + 1 }, { by: meta.by, reason: meta.reason, kind: "setup_waived", before: a }, meta.now ?? new Date());
}

/**
 * Start the 30-day free period. Deterministic activation condition:
 *   1. a plan is selected and the subscription has not started (pre_activation);
 *   2. setup is PAID or WAIVED — never overridable (waive explicitly instead);
 *   3. the commercial readiness gate is READY — or the founder overrides with a reason (audited).
 */
export async function activateFreePeriod(businessId: string, input: { gateLevel: string; gateBlocker?: string; override?: string }, meta: Meta) {
  need(meta);
  const now = meta.now ?? new Date();
  const a = await mustGet(businessId);
  if (a.subscriptionState !== "pre_activation") throw new CommercialError(`The free period can't start from ${a.subscriptionState.replace(/_/g, " ")}`);
  if (a.setupStatus !== "paid" && a.setupStatus !== "waived") throw new CommercialError("Setup is not paid or waived — the free month can't start");
  const ready = input.gateLevel === "READY_TO_START_FREE_MONTH";
  const override = input.override?.trim();
  if (!ready && !override) throw new CommercialError(`Not ready to start the free month: ${input.gateBlocker ?? input.gateLevel}. Override only with a reason.`);
  const startsAt = iso(now);
  const endsAt = iso(new Date(now.getTime() + FREE_PERIOD_DAYS * DAY));
  const billing = await getCommercialBilling().startFreePeriod({ businessId, startsAt, endsAt });
  return save(
    { ...a, subscriptionState: "free_period", freePeriodStartsAt: startsAt, freePeriodEndsAt: endsAt, recurringStartsAt: endsAt, activation: { at: startsAt, by: meta.by, gate: input.gateLevel, ...(override && !ready ? { override } : {}) }, revision: a.revision + 1 },
    { by: meta.by, reason: override && !ready ? `OVERRIDE: ${override} — ${meta.reason}` : meta.reason, kind: "free_period_started", before: a, billing },
    now
  );
}

/** Paid recurring starts only when the founder confirms it, and never before the free period ends. */
export async function confirmRecurringStart(businessId: string, meta: Meta) {
  need(meta);
  const now = meta.now ?? new Date();
  const a = await mustGet(businessId);
  if (a.subscriptionState !== "free_period" || !a.freePeriodEndsAt) throw new CommercialError("Recurring starts after an active free period");
  if (iso(now) < a.freePeriodEndsAt) throw new CommercialError(`The free period runs until ${a.freePeriodEndsAt.slice(0, 10)}`);
  const price = effectiveMonthlyPrice(a, now);
  const billing = await getCommercialBilling().activateRecurring({ businessId, startsAt: a.freePeriodEndsAt, monthlyPrice: price, currency: a.currency });
  return save({ ...a, subscriptionState: "active", recurringStartsAt: a.freePeriodEndsAt, recurringConfirmedAt: iso(now), revision: a.revision + 1 }, { by: meta.by, reason: meta.reason, kind: "recurring_confirmed", before: a, billing }, now);
}

export async function pauseSubscription(businessId: string, meta: Meta) {
  need(meta);
  const now = meta.now ?? new Date();
  const a = await mustGet(businessId);
  if (a.subscriptionState !== "free_period" && a.subscriptionState !== "active") throw new CommercialError(`Can't pause from ${a.subscriptionState.replace(/_/g, " ")}`);
  const billing = await getCommercialBilling().pauseSubscription({ businessId, at: iso(now) });
  return save({ ...a, subscriptionState: "paused", pausedAt: iso(now), revision: a.revision + 1, notes: a.notes }, { by: meta.by, reason: meta.reason, kind: "paused", before: a, billing }, now);
}

/** Resume: a pause inside the free period extends it by the paused time (the free month is never burnt). */
export async function resumeSubscription(businessId: string, meta: Meta) {
  need(meta);
  const now = meta.now ?? new Date();
  const a = await mustGet(businessId);
  if (a.subscriptionState !== "paused" || !a.pausedAt) throw new CommercialError("Not paused");
  const wasFree = !a.recurringConfirmedAt;
  const pausedMs = now.getTime() - Date.parse(a.pausedAt);
  const ends = wasFree && a.freePeriodEndsAt ? iso(new Date(Date.parse(a.freePeriodEndsAt) + pausedMs)) : a.freePeriodEndsAt;
  return save(
    { ...a, subscriptionState: wasFree ? "free_period" : "active", pausedAt: null, freePeriodEndsAt: ends, recurringStartsAt: wasFree ? ends : a.recurringStartsAt, revision: a.revision + 1 },
    { by: meta.by, reason: meta.reason, kind: "resumed", before: a },
    now
  );
}

export async function cancelSubscription(businessId: string, input: { effectiveAt?: string }, meta: Meta) {
  need(meta);
  const now = meta.now ?? new Date();
  const a = await mustGet(businessId);
  if (a.subscriptionState === "cancelled") throw new CommercialError("Already cancelled");
  const effectiveAt = input.effectiveAt ?? iso(now);
  const billing = await getCommercialBilling().cancelSubscription({ businessId, effectiveAt });
  return save({ ...a, subscriptionState: "cancelled", cancellationEffectiveAt: effectiveAt, revision: a.revision + 1 }, { by: meta.by, reason: meta.reason, kind: "cancelled", before: a, billing }, now);
}

export async function addCommercialNote(businessId: string, note: string, meta: Omit<Meta, "reason">) {
  const a = await mustGet(businessId);
  const text = note.trim().slice(0, 2000);
  if (!text) throw new CommercialError("A note is required");
  return save({ ...a, notes: a.notes ? `${a.notes}\n${text}` : text, revision: a.revision + 1 }, { by: meta.by, reason: text, kind: "note", before: a }, meta.now ?? new Date());
}

/** QA ONLY: emulate a plan for this business (never in production; audited; `null` clears it). */
export async function emulatePlanForQa(businessId: string, plan: PlanId | null, by: string): Promise<void> {
  if (!qaEnabled()) throw new CommercialError("Plan emulation is a QA tool and is off here");
  const backend = getBackend();
  await backend.upsertOperatorRecord({ businessId, kind: "commercial_account", key: QA_KEY, data: { plan, by, at: iso(new Date()) } });
  const at = iso(new Date());
  const e: CommercialEvent = { id: `cev_${Date.parse(at).toString(36)}_${Math.random().toString(36).slice(2, 8)}`, businessId, at, by, kind: "qa_plan_emulated", reason: plan ? `QA emulates ${plan}` : "QA emulation cleared", before: null, after: {} };
  await backend.upsertOperatorRecord({ businessId, kind: "commercial_event", key: e.id, data: e as unknown as Record<string, unknown> });
  await loadEntitlement(businessId);
}

// ── Lifecycle (one derived stage the founder reads) ──────────────────────────────────────────────

export type CommercialStage = "no_plan" | "plan_selected" | "setup_quoted" | "setup_settled" | "free_month" | "free_month_ending" | "awaiting_recurring" | "paid_active" | "paused" | "cancelled";

export function commercialStage(a: CommercialAccount | null, now = new Date()): CommercialStage {
  if (!a) return "no_plan";
  if (a.subscriptionState === "cancelled") return "cancelled";
  if (a.subscriptionState === "paused") return "paused";
  if (a.subscriptionState === "active") return "paid_active";
  if (a.subscriptionState === "free_period") {
    if (a.freePeriodEndsAt && iso(now) >= a.freePeriodEndsAt) return "awaiting_recurring";
    if (a.freePeriodEndsAt && Date.parse(a.freePeriodEndsAt) - now.getTime() <= 7 * DAY) return "free_month_ending";
    return "free_month";
  }
  if (a.setupStatus === "paid" || a.setupStatus === "waived") return "setup_settled";
  if (a.setupStatus === "quoted" || a.setupStatus === "invoiced") return "setup_quoted";
  return "plan_selected";
}

export const STAGE_WORDS: Record<CommercialStage, string> = {
  no_plan: "No plan selected",
  plan_selected: "Plan selected — setup not quoted",
  setup_quoted: "Setup quoted / invoiced — not paid",
  setup_settled: "Setup settled — onboarding until ready to activate",
  free_month: "Free month",
  free_month_ending: "Free month ending soon",
  awaiting_recurring: "Free month over — confirm recurring start",
  paid_active: "Paid, active",
  paused: "Paused",
  cancelled: "Cancelled",
};

/** Day N of the free period (1-based) and days left, when it is running. */
export function freePeriodProgress(a: CommercialAccount | null, now = new Date()): { day: number; daysLeft: number; endsAt: string } | null {
  if (!a?.freePeriodStartsAt || !a.freePeriodEndsAt || a.subscriptionState !== "free_period") return null;
  const day = Math.min(FREE_PERIOD_DAYS, Math.max(1, Math.floor((now.getTime() - Date.parse(a.freePeriodStartsAt)) / DAY) + 1));
  const daysLeft = Math.max(0, Math.ceil((Date.parse(a.freePeriodEndsAt) - now.getTime()) / DAY));
  return { day, daysLeft, endsAt: a.freePeriodEndsAt };
}
