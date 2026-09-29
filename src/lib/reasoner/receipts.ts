import { getCapability } from "@/lib/fabric/capability";
import type { ComposeResponseInput, ComposeStep } from "./types";

/**
 * Receipts — the exact operations BARRY carried out for a reply, and what really happened.
 *
 * A reply may only describe what a receipt shows: a created support ticket is evidence of a created
 * ticket, never of a changed delivery or a refund; an approval request is not an execution; an
 * executed write is not a confirmed one unless the system confirmed it. Receipts are customer-safe
 * (plain operation words, never ids of capabilities, systems or rules).
 */

export type ReceiptResult =
  | "done"
  | "done_unconfirmed"
  | "not_done"
  | "failed"
  | "sent_to_owner"
  | "still_with_owner"
  | "owner_declined_earlier"
  | "not_allowed";

export type Receipt = { operation: string; result: ReceiptResult; reference?: string };

/** BARRY's own typed operations, in plain words (the same for every business). */
const OPERATION_WORDS: Record<string, string> = {
  checkAvailability: "looked up open times",
  createBooking: "booked the appointment",
  checkInventory: "checked stock",
  createPaymentRequest: "created a payment link",
  searchProducts: "searched the catalog",
  addToCart: "added an item to the cart",
  updateCartLine: "changed an existing cart line's option or quantity (nothing new was added; quantity 0 removes it)",
  createCommerceCheckout: "created the checkout payment link",
  createCommerceOrder: "placed the order",
  verifyPayment: "checked the payment status with the payment provider",
  createFollowUp: "scheduled a follow-up message",
  fulfillOrder: "confirmed the order",
  createLead: "recorded a new enquiry for the team",
  sendMedia: "sent media",
};

/** What kind of change an operation is — used to bind completion claims to real operations. */
export type OperationKind = "create" | "update" | "cancel" | "refund" | "send" | "read";

type GenericCall = { capability?: string; ok?: boolean; executed?: boolean; verified?: boolean; about?: string | null; output?: unknown };

function genericCall(toolResult: ComposeStep["toolResult"]): GenericCall | undefined {
  if (!toolResult) return undefined;
  return (toolResult.ok ? toolResult.output : (toolResult as { capability?: unknown }).capability) as GenericCall | undefined;
}

function reference(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  const inner = o.output && typeof o.output === "object" ? (o.output as Record<string, unknown>) : o;
  const key = Object.keys(inner).find((k) => /(?:Id|Number|reference)$/.test(k) && typeof inner[k] === "string" && !/^(cartId|lineId|paymentRequestId|checkoutId)$/.test(k));
  return key ? String(inner[key]) : undefined;
}

function actionOf(step: ComposeStep): { name: string; capability?: string } | undefined {
  if (step.outcome.kind !== "action") return undefined;
  const name = step.outcome.action.name;
  const capability = name === "invokeCapability" ? (String((step.outcome.action.input as Record<string, unknown>).capability ?? "") || genericCall(step.toolResult)?.capability) : undefined;
  return { name, capability };
}

function one(step: ComposeStep & { existingOwnerRequest?: ComposeResponseInput["existingOwnerRequest"] }): (Receipt & { kinds: OperationKind[] }) | undefined {
  const act = actionOf(step);
  if (!act) return undefined;
  const contract = act.capability ? getCapability(act.capability) : undefined;
  const operation = act.name === "invokeCapability" ? (contract?.purpose ?? genericCall(step.toolResult)?.about ?? "a request to the business's system") : (OPERATION_WORDS[act.name] ?? "an operation");
  const kinds = operationKinds(act.name, act.capability, contract?.effect);
  const base = { operation, kinds };
  if (step.refused) return { ...base, result: "not_allowed" };
  if (step.existingOwnerRequest === "still_pending") return { ...base, result: "still_with_owner" };
  if (step.existingOwnerRequest === "declined_earlier") return { ...base, result: "owner_declined_earlier" };
  if (step.policyReason) return { ...base, result: "sent_to_owner" };
  const tr = step.toolResult;
  if (!tr) return undefined;
  if (!tr.ok) return { ...base, result: "failed" };
  if (act.name === "invokeCapability") {
    const call = genericCall(tr);
    if (call?.ok === false || call?.executed === false) return { ...base, result: "failed" };
    const unconfirmed = contract?.effect !== "read" && call?.verified === false;
    return { ...base, result: unconfirmed ? "done_unconfirmed" : "done", ...(reference(call?.output) ? { reference: reference(call?.output) } : {}) };
  }
  const out = tr.output as Record<string, unknown> | undefined;
  if ((act.name === "addToCart" || act.name === "updateCartLine") && out && out.added === false) return { ...base, result: "not_done" };
  return { ...base, result: "done", ...(reference(out) ? { reference: reference(out) } : {}) };
}

/** Operation kinds from BARRY's own action names / capability ids (runtime vocabulary, not customer words). */
export function operationKinds(action: string, capability?: string, effect?: string): OperationKind[] {
  const id = `${action} ${capability ?? ""}`.toLowerCase();
  const kinds = new Set<OperationKind>();
  if (effect === "read" || /^(check|search|verify)/.test(action) || /\.(track|get|list|search|lookup|status)\b/.test(id)) kinds.add("read");
  if (/refund|credit/.test(id)) kinds.add("refund");
  if (/cancel|remove|delete|void/.test(id)) kinds.add("cancel");
  if (/update|change|reschedul|modify|edit|updatecartline/.test(id)) kinds.add("update");
  if (/create|book|add|order|lead|ticket|open|submit|fulfill/.test(id) && !kinds.has("read")) kinds.add("create");
  if (/payment|checkout|send|media|email|message|followup|link/.test(id) && !/verify/.test(id)) kinds.add("send");
  if (action === "updateCartLine") kinds.add("cancel"); // quantity 0 removes a line
  return [...kinds];
}

/** Receipts for everything a reply covers (single step, several steps, or an owner-approval resume). */
export function buildReceipts(input: ComposeResponseInput): (Receipt & { kinds: OperationKind[] })[] {
  const steps: (ComposeStep & { existingOwnerRequest?: ComposeResponseInput["existingOwnerRequest"] })[] = input.steps?.length
    ? input.steps
    : [{ outcome: input.outcome, toolResult: input.toolResult, policyReason: input.policyReason, refused: input.refused, existingOwnerRequest: input.existingOwnerRequest }];
  return steps.map(one).filter((r): r is Receipt & { kinds: OperationKind[] } => r !== undefined);
}

/** The customer-safe receipts the composer sees. */
export function customerReceipts(input: ComposeResponseInput): Receipt[] {
  return buildReceipts(input).map(({ kinds: _k, ...r }) => {
    void _k;
    return r;
  });
}
