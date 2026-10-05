import type { BusinessGraph } from "@/lib/business-graph";
import { getCapability } from "@/lib/fabric/capability";
import { getBackend } from "@/lib/store";
import { ApprovalAlreadyResolvedError, type ApprovalRecord } from "@/lib/store/types";
import type { ConversationState } from "@/lib/state";
import { getTool } from "@/lib/tools";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import { money } from "@/lib/reasoner/deterministic-compose";
import type { OwnerRequestView } from "@/lib/reasoner/types";
import { appendLedger, readLedger, requestEntry, termsOf, type LedgerEntry } from "./ledger";

/**
 * The lifecycle of requests BARRY sends to the owner, per conversation.
 *
 * - IDENTITY: a request is (conversation, operation, material terms). The purpose wording, an
 *   idempotency key or an approval id are not terms — the same operation on the same terms is the
 *   same request, whoever phrases it.
 * - One live request per identity: an identical request still waiting is REUSED, never re-created
 *   (status questions can't multiply approvals); one the owner already declined is not re-sent on
 *   the same terms.
 * - The customer's current intent wins: withdrawing, or changing the terms, withdraws what is still
 *   waiting, so the owner can never approve something the customer no longer wants or stale terms.
 * - Replies see a customer-safe view of every request and its real outcome — never the rule behind it.
 */

/** Recorded outcome of an approved request once BARRY executed it (approval id -> result). */
export const OWNER_REQUEST_RESULTS_KEY = "__ownerRequestResults";

const WITHDRAWN_BY = { withdrawn: "customer:withdrawn", changed: "customer:changed_terms", superseded: "runtime:superseded" } as const;

/** Operations that describe ONE transaction per conversation: a new revision supersedes the older one. */
const SINGLE_REVISION_ACTIONS = new Set(["createPaymentRequest", "createCommerceCheckout", "grantDiscount"]);

/** Which operation a request is (the capability for generic calls) — revisions of one operation share it. */
export function operationKey(action: string, input: unknown): string {
  const raw = (input ?? {}) as Record<string, unknown>;
  return action === INVOKE_CAPABILITY ? `${action}:${String(raw.capability)}` : action;
}

/**
 * A new revision of a single-transaction operation (e.g. the payment for this purchase at new terms)
 * supersedes any older revision still waiting — there is exactly one active revision, and the owner
 * can never approve the old terms.
 */
export async function supersedeOlderRevisions(graph: BusinessGraph, state: ConversationState, action: string, input: unknown): Promise<number> {
  if (!SINGLE_REVISION_ACTIONS.has(action)) return 0;
  const key = operationKey(action, input);
  const id = requestIdentity(action, input);
  const older = (await conversationApprovals(graph.business.id, state.id)).filter(
    (a) => a.status === "pending" && operationKey(a.requestedAction, a.requestedInput) === key && requestIdentity(a.requestedAction, a.requestedInput) !== id
  );
  for (const a of older) {
    if (!(await resolveIfPending(a.id, WITHDRAWN_BY.superseded))) continue;
    appendLedger(state, requestEntry(a.requestedAction, a.requestedInput, a.id, "superseded"));
  }
  if (older.some((a) => a.id === state.pendingApprovalId)) {
    state.pendingApprovalId = null;
    state.pendingAction = null;
  }
  return older.length;
}

export type ApprovalLifecycle = "active" | "held" | "superseded" | "withdrawn" | "declined" | "executed" | "executed_unconfirmed" | "failed" | "approved";

/** The authoritative lifecycle of one request (from its record, BARRY's recorded execution result, and any intent hold). */
export function approvalLifecycle(a: ApprovalRecord, result?: OwnerRequestResult, hold?: IntentHold): ApprovalLifecycle {
  if (a.status === "pending") return hold ? "held" : "active";
  if (a.status === "declined") {
    const by = a.resolution?.decidedBy ?? "";
    if (by === WITHDRAWN_BY.withdrawn) return "withdrawn";
    if (by === WITHDRAWN_BY.changed || by === WITHDRAWN_BY.superseded) return "superseded";
    return "declined";
  }
  if (!result) return "approved";
  return result.result === "done" ? "executed" : result.result === "done_unconfirmed" ? "executed_unconfirmed" : "failed";
}

/**
 * CUSTOMER-INTENT REVALIDATION. An owner's approval is consent from the owner, not from the customer —
 * and the customer may have spoken since the request was made. A pending request is HELD (never
 * executed) while the customer's intent after it is unverified:
 *
 * - a later customer message could not be understood (or was understood only partly, with a decision
 *   field lost): whatever it said may have changed or withdrawn this request;
 * - a later customer message names an identifier that is a near-miss of one of this request's own
 *   identifiers (e.g. the request is for X-301 and the customer later wrote X-302): a correction the
 *   runtime can see structurally, whatever the model signalled.
 *
 * A hold lasts until a validly understood customer turn reaffirms the request (the model re-proposes
 * the same terms and the runtime reuses it). Nothing here reads meaning into words: it compares
 * records, timestamps and identifier shapes only.
 */
export type IntentHold = { reason: "understanding_unverified" | "conflicting_reference"; detail?: string };

const idTokens = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => /\p{N}/u.test(t) && t.length >= 3).map((t) => t.toLowerCase());

/** Same length, differs in at most a third of positions (≥1): a near-miss of the same identifier shape. */
function nearMiss(a: string, b: string): boolean {
  if (a === b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff >= 1 && diff <= Math.max(1, Math.floor(a.length / 3));
}

export function customerIntentHold(state: ConversationState, a: ApprovalRecord): IntentHold | undefined {
  if (a.status !== "pending") return undefined;
  const ledger = readLedger(state);
  // Ordering within the conversation's own ledger is by sequence, not clock: the request's latest
  // "asked" / "reconfirmed" entry is the point after which the customer's words must be checked.
  const anchor = ledger.filter((e) => e.requestId === a.id && (e.effect === "request.awaiting_owner" || e.effect === "request.reconfirmed")).at(-1);
  const anchorSeq = anchor?.seq ?? 0;
  // Messages said after the anchor: by position when recorded (clock-free), else by time.
  const reaffirmedAt = Math.max(Date.parse(a.createdAt), anchor ? Date.parse(anchor.at) : 0);
  const saidAfter = (m: ConversationState["messages"][number], i: number) => (anchor?.messageIndex !== undefined ? i >= anchor.messageIndex : Date.parse(m.at) > reaffirmedAt);
  const unverified = unresolvedUnderstanding(ledger).find((e) => e.seq > anchorSeq);
  if (unverified) return { reason: "understanding_unverified" };
  const own = [...new Set(Object.values(termsOf(a.requestedAction, a.requestedInput)).filter((v): v is string => typeof v === "string").flatMap(idTokens))];
  if (own.length === 0) return undefined;
  for (const [i, m] of state.messages.entries()) {
    if (m.role !== "customer" || !saidAfter(m, i)) continue;
    const said = idTokens(m.content);
    const conflict = said.find((t) => !own.includes(t) && own.some((o) => nearMiss(t, o)));
    if (conflict) return { reason: "conflicting_reference", detail: conflict.toUpperCase() };
  }
  return undefined;
}

/**
 * Customer messages BARRY could not (fully) understand and has not since re-interpreted. A successful
 * revalidation resolves one either way: if the message (now understood) withdrew or changed requests,
 * the runtime applied that through the normal lifecycle (the stale request is no longer pending).
 */
export function unresolvedUnderstanding(ledger: LedgerEntry[]): LedgerEntry[] {
  const revalidated = new Set(ledger.filter((e) => e.effect === "understanding.revalidated" && e.revalidation).map((e) => e.revalidation!.of));
  return ledger.filter((e) => (e.effect === "understanding.failed" || e.effect === "understanding.partial") && !revalidated.has(e.seq));
}

/**
 * A revalidated message withdrew or changed requests: apply it to exactly the requests that were
 * already pending when that message was sent (never to ones made later). Changed terms supersede
 * (no replacement is guessed — the customer is asked); a withdrawal honours its scope.
 */
export async function applyRevalidatedIntent(
  graph: BusinessGraph,
  state: ConversationState,
  failureSeq: number,
  intent: { withdraws: boolean; changes: boolean; scope?: string[] }
): Promise<number> {
  const ledger = readLedger(state);
  const askedBefore = (a: ApprovalRecord) => ledger.some((e) => e.requestId === a.id && e.effect === "request.awaiting_owner" && e.seq < failureSeq);
  const inScope = (a: ApprovalRecord) => {
    if (!intent.scope?.length) return true;
    const terms = Object.values(termsOf(a.requestedAction, a.requestedInput)).map((v) => String(v).toLowerCase());
    return intent.scope.some((id) => terms.some((t) => t.includes(id.toLowerCase().trim())));
  };
  const affected = (await conversationApprovals(graph.business.id, state.id)).filter((a) => a.status === "pending" && askedBefore(a) && (intent.changes || inScope(a)));
  let n = 0;
  for (const a of affected) {
    const why = intent.withdraws ? "withdrawn" : "changed";
    if (!(await resolveIfPending(a.id, WITHDRAWN_BY[why]))) continue;
    appendLedger(state, requestEntry(a.requestedAction, a.requestedInput, a.id, why === "withdrawn" ? "withdrawn" : "superseded"));
    if (state.pendingApprovalId === a.id) {
      state.pendingApprovalId = null;
      state.pendingAction = null;
    }
    n++;
  }
  return n;
}

/** A validly understood turn re-proposed exactly this pending request: the customer's intent is current again. */
export function recordReconfirmed(state: ConversationState, a: ApprovalRecord): void {
  appendLedger(state, { ...requestEntry(a.requestedAction, a.requestedInput, a.id, "awaiting_owner"), effect: "request.reconfirmed" });
}

/** Revision number of each request within its operation, oldest first (1 = first). */
export function revisions(approvals: ApprovalRecord[]): Map<string, number> {
  const byOp = new Map<string, ApprovalRecord[]>();
  for (const a of [...approvals].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    const key = `${a.conversationId}|${operationKey(a.requestedAction, a.requestedInput)}`;
    byOp.set(key, [...(byOp.get(key) ?? []), a]);
  }
  const out = new Map<string, number>();
  for (const list of byOp.values()) list.forEach((a, i) => out.set(a.id, i + 1));
  return out;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The material terms of a request: the operation and its input, without wording or keys. */
export function requestIdentity(action: string, input: unknown): string {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (action === INVOKE_CAPABILITY) {
    const inner = { ...((raw.input as Record<string, unknown>) ?? {}) };
    delete inner.idempotencyKey;
    return `${action}:${String(raw.capability)}:${canonical(inner)}`;
  }
  const { reason: _r, approvalId: _a, idempotencyKey: _k, revision: _v, ...terms } = raw;
  void _v;
  void _r;
  void _a;
  void _k;
  return `${action}:${canonical(terms)}`;
}

export async function conversationApprovals(businessId: string, conversationId: string): Promise<ApprovalRecord[]> {
  const all = await getBackend().listApprovals(businessId);
  return all.filter((a) => a.conversationId === conversationId);
}

export type ExistingRequest = { approval: ApprovalRecord; state: "still_pending" | "declined_earlier" };

/** An earlier request on the same terms that must not be re-created: still waiting, or declined by the owner. */
export function findSameRequest(approvals: ApprovalRecord[], action: string, input: unknown): ExistingRequest | undefined {
  const id = requestIdentity(action, input);
  const same = approvals.filter((a) => requestIdentity(a.requestedAction, a.requestedInput) === id);
  const pending = same.find((a) => a.status === "pending");
  if (pending) return { approval: pending, state: "still_pending" };
  const declinedByOwner = same.filter((a) => a.status === "declined" && !a.resolution?.decidedBy.startsWith("customer:")).at(-1);
  return declinedByOwner ? { approval: declinedByOwner, state: "declined_earlier" } : undefined;
}

/** Withdraw everything still waiting on the owner in this conversation (customer withdrew or changed terms). */
export async function withdrawPendingRequests(graph: BusinessGraph, state: ConversationState, why: keyof typeof WITHDRAWN_BY, scope?: string[]): Promise<number> {
  // A scoped withdrawal ("not A") only withdraws the requests whose own terms carry those identifiers.
  const inScope = (a: ApprovalRecord) => {
    if (!scope?.length) return true;
    const terms = Object.values(termsOf(a.requestedAction, a.requestedInput)).map((v) => String(v).toLowerCase());
    return scope.some((id) => terms.some((t) => t.includes(id.toLowerCase().trim())));
  };
  const pending = (await conversationApprovals(graph.business.id, state.id)).filter((a) => a.status === "pending" && inScope(a));
  let withdrawn = 0;
  for (const a of pending) {
    if (!(await resolveIfPending(a.id, WITHDRAWN_BY[why]))) continue;
    appendLedger(state, requestEntry(a.requestedAction, a.requestedInput, a.id, why === "withdrawn" ? "withdrawn" : "superseded"));
    if (state.pendingApprovalId === a.id) {
      state.pendingApprovalId = null;
      state.pendingAction = null;
    }
    withdrawn++;
  }
  return withdrawn;
}

/**
 * ATOMIC REVISION. After a turn in which the customer changed a pending request's terms: every request
 * that was pending BEFORE the turn and is still pending (i.e. not the one the new terms produced) is
 * superseded. Returns whether a replacement of the same operation now exists — when none does, the
 * reply must say nothing is pending (never "the owner is reviewing" an obsolete request).
 */
export async function settleChangedTerms(graph: BusinessGraph, state: ConversationState, pendingBefore: ApprovalRecord[]): Promise<{ superseded: number; replacement: boolean }> {
  const now = await conversationApprovals(graph.business.id, state.id);
  const beforeIds = new Set(pendingBefore.map((a) => a.id));
  const created = now.filter((a) => a.status === "pending" && !beforeIds.has(a.id));
  let superseded = 0;
  let replacement = false;
  for (const old of pendingBefore) {
    const current = now.find((a) => a.id === old.id);
    if (!current || current.status !== "pending") {
      replacement ||= created.some((c) => operationKey(c.requestedAction, c.requestedInput) === operationKey(old.requestedAction, old.requestedInput));
      continue;
    }
    const replaced = created.some((c) => operationKey(c.requestedAction, c.requestedInput) === operationKey(old.requestedAction, old.requestedInput));
    // A request whose terms are unchanged (the dedupe reused it) is still the current one.
    if (!replaced && state.pendingApprovalId === old.id && created.length === 0 && reusedThisTurn(state, old.id)) {
      replacement = true;
      continue;
    }
    if (await resolveIfPending(old.id, WITHDRAWN_BY.changed)) {
      appendLedger(state, requestEntry(old.requestedAction, old.requestedInput, old.id, "superseded"));
      superseded++;
      if (state.pendingApprovalId === old.id) {
        state.pendingApprovalId = created.at(-1)?.id ?? null;
        if (!created.length) state.pendingAction = null;
      }
    }
    replacement ||= replaced;
  }
  return { superseded, replacement };
}

/** Whether this turn's steps reused (deduped onto) this still-pending request. */
function reusedThisTurn(state: ConversationState, approvalId: string): boolean {
  return state.knownFields.__reusedApprovalThisTurn === approvalId;
}

async function resolveIfPending(id: string, by: string): Promise<boolean> {
  try {
    await getBackend().resolveApproval(id, "declined", by);
    return true;
  } catch (err) {
    if (err instanceof ApprovalAlreadyResolvedError) return false;
    throw err;
  }
}

const humanWords = (v: string) => (/^[a-z]+(?:_[a-z]+)+$/.test(v) ? v.replace(/_/g, " ") : v);

/** What a request is about, in customer-safe words: the operation's purpose and the customer's own terms. */
export function describeRequest(action: string, input: unknown): string {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (action === INVOKE_CAPABILITY) {
    const contract = getCapability(String(raw.capability));
    const terms = Object.entries((raw.input as Record<string, unknown>) ?? {})
      .filter(([k, v]) => k !== "idempotencyKey" && (typeof v === "string" || typeof v === "number"))
      .map(([, v]) => humanWords(String(v)));
    return `${contract?.purpose ?? "a request"}${terms.length ? ` (${terms.join(", ")})` : ""}`;
  }
  if (action === "grantDiscount") {
    const pct = Number(raw.discountPct);
    const on = raw.item === "the whole cart" ? "the whole cart" : String(raw.item ?? "the cart");
    const list = typeof raw.listAmount === "number" && typeof raw.currency === "string" ? ` (${money(raw.listAmount, raw.currency)} → ${money(Math.round(raw.listAmount * (100 - pct)) / 100, raw.currency)})` : "";
    return `a ${pct}% discount on ${on}${list}`;
  }
  if (typeof raw.amount === "number" && typeof raw.currency === "string") {
    const pct = typeof raw.discountPct === "number" && raw.discountPct > 0 ? ` with a ${raw.discountPct}% discount` : "";
    const lines = Array.isArray(raw.lines) ? (raw.lines as { item: string; quantity: number }[]).map((l) => `${l.quantity} × ${l.item}`).join(", ") : "";
    return `a payment link for ${lines ? `${lines}${pct}, ` : ""}${money(raw.amount, raw.currency)} in total${lines ? "" : pct}`;
  }
  // A cart checkout is priced by the store at the moment it runs: in plain words, never the tool's internal description.
  if (action === "createCommerceCheckout") return "a payment link for the cart in this conversation";
  return getTool(action)?.description ?? "a request";
}

export type OwnerRequestResult = { result: "done" | "done_unconfirmed" | "failed"; reference?: string };

export function recordOwnerRequestResult(state: ConversationState, approvalId: string, result: OwnerRequestResult): void {
  const all = readResults(state);
  all[approvalId] = result;
  state.knownFields[OWNER_REQUEST_RESULTS_KEY] = JSON.stringify(all);
}

function readResults(state: ConversationState): Record<string, OwnerRequestResult> {
  try {
    return JSON.parse(state.knownFields[OWNER_REQUEST_RESULTS_KEY] ?? "{}") as Record<string, OwnerRequestResult>;
  } catch {
    return {};
  }
}

/** The customer-facing reference a result carries (a ticket, booking or order number), if any. */
export function resultReference(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  const inner = o.output && typeof o.output === "object" ? (o.output as Record<string, unknown>) : o;
  const key = Object.keys(inner).find((k) => /(?:Id|Number|reference)$/.test(k) && typeof inner[k] === "string");
  return key ? String(inner[key]) : undefined;
}

/** Every owner request in this conversation, as the customer may hear about it. */
export function ownerRequestViews(approvals: ApprovalRecord[], state: ConversationState): OwnerRequestView[] {
  const results = readResults(state);
  const rev = revisions(approvals);
  return [...approvals]
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    .map((a) => {
      const r = results[a.id];
      const lifecycle = approvalLifecycle(a, r, customerIntentHold(state, a));
      const status: OwnerRequestView["status"] =
        lifecycle === "active" || lifecycle === "held" ? "waiting_on_owner" : lifecycle === "withdrawn" ? "withdrawn_by_customer" : lifecycle === "superseded" ? "superseded" : lifecycle === "declined" ? "declined_by_owner" : "approved";
      return {
        about: describeRequest(a.requestedAction, a.requestedInput),
        status,
        lifecycle,
        revision: rev.get(a.id) ?? 1,
        terms: termsOf(a.requestedAction, a.requestedInput),
        ...(r ? { result: r.result, ...(r.reference ? { reference: r.reference } : {}) } : {}),
      };
    });
}

export type ApprovalWithLifecycle = ApprovalRecord & {
  lifecycle: ApprovalLifecycle;
  revision: number;
  /** Customer-safe summary of exactly what this request would do (terms included: product, quantity, total, reference). */
  summary: string;
  result?: OwnerRequestResult;
  /** Why this pending request can't be executed until the customer reconfirms it. */
  hold?: IntentHold;
};

/** Approvals with their authoritative lifecycle, for the owner's UI (states: conversation id -> state, when known). */
export function withLifecycle(approvals: ApprovalRecord[], states: Map<string, ConversationState | undefined>): ApprovalWithLifecycle[] {
  const rev = revisions(approvals);
  return approvals.map((a) => {
    const st = states.get(a.conversationId);
    const r = st ? readResults(st)[a.id] : undefined;
    const hold = st ? customerIntentHold(st, a) : undefined;
    return { ...a, lifecycle: approvalLifecycle(a, r, hold), ...(hold ? { hold } : {}), revision: rev.get(a.id) ?? 1, summary: describeRequest(a.requestedAction, a.requestedInput), ...(r ? { result: r } : {}) };
  });
}
