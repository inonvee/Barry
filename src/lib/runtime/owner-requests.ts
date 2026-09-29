import type { BusinessGraph } from "@/lib/business-graph";
import { getCapability } from "@/lib/fabric/capability";
import { getBackend } from "@/lib/store";
import type { ApprovalRecord } from "@/lib/store/types";
import type { ConversationState } from "@/lib/state";
import { getTool } from "@/lib/tools";
import { INVOKE_CAPABILITY } from "@/lib/tools/capability-tool";
import { money } from "@/lib/reasoner/deterministic-compose";
import type { OwnerRequestView } from "@/lib/reasoner/types";

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

const WITHDRAWN_BY = { withdrawn: "customer:withdrawn", changed: "customer:changed_terms" } as const;

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
  const { reason: _r, approvalId: _a, idempotencyKey: _k, ...terms } = raw;
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
export async function withdrawPendingRequests(graph: BusinessGraph, state: ConversationState, why: keyof typeof WITHDRAWN_BY): Promise<number> {
  const pending = (await conversationApprovals(graph.business.id, state.id)).filter((a) => a.status === "pending");
  for (const a of pending) await getBackend().resolveApproval(a.id, "declined", WITHDRAWN_BY[why]);
  if (pending.length > 0) {
    state.pendingApprovalId = null;
    state.pendingAction = null;
  }
  return pending.length;
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
  if (typeof raw.amount === "number" && typeof raw.currency === "string") {
    const pct = typeof raw.discountPct === "number" && raw.discountPct > 0 ? ` with a ${raw.discountPct}% discount` : "";
    return `a payment link for ${money(raw.amount, raw.currency)}${pct}`;
  }
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
  return approvals.map((a) => {
    const status: OwnerRequestView["status"] =
      a.status === "pending" ? "waiting_on_owner" : a.status === "approved" ? "approved" : a.resolution?.decidedBy.startsWith("customer:") ? "withdrawn_by_customer" : "declined_by_owner";
    const r = results[a.id];
    return { about: describeRequest(a.requestedAction, a.requestedInput), status, ...(r ? { result: r.result, ...(r.reference ? { reference: r.reference } : {}) } : {}) };
  });
}
