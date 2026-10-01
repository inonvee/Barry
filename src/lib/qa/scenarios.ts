import type { BarryIR } from "@/lib/reasoner/types";
import { withQaReasoner } from "@/lib/reasoner";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { graphOrNull } from "@/lib/learn-business/http";
import { processInbound } from "@/lib/channels/gateway";
import { LOGISTICS_DEMO_ID } from "@/lib/fixtures/logistics-demo";
import { readHandoffs } from "@/lib/runtime/handoff";
import { qaEnabled, QA_FORCE_UNDERSTANDING_FAILURE } from "./mode";
import { QaScriptedReasoner } from "./scripted";

/**
 * QA SCENARIO FACTORY (Preview / QA mode only): one click builds a common acceptance state through the
 * REAL runtime (grounding, authority, execution, ledger, provider simulators) with a scripted
 * understanding, so Work never reconstructs state by hand. Every record it creates is test data:
 * conversations are `qa:`-prefixed (payments, approvals, carts, orders and obligations hang off them),
 * the customer is `qa-customer`, providers are the business's simulators, no message is ever sent. A
 * scenario is business-scoped, repeatable (a fresh run id each time) and resettable (see reset.ts).
 */

export const QA_PREFIX = "qa:";
export const QA_CUSTOMER = "qa-customer";

export type QaScenarioId =
  | "rina_cart_midnight_onyx"
  | "rina_checkout_pending"
  | "rina_payment_unverified_claim"
  | "rina_discount_approval"
  | "rina_completed_order"
  | "logistics_c302_approval"
  | "logistics_f31_held"
  | "handoff_open"
  | "delivery_failed"
  | "ai_failure_armed";

export type QaScenario = {
  id: QaScenarioId;
  businessId: string;
  title: string;
  /** What Work sees afterwards (the acceptance state). */
  expect: string;
  creates: string[];
};

export type QaScenarioRun = {
  runId: string;
  scenario: QaScenarioId;
  businessId: string;
  conversationId: string;
  createdAt: string;
  created: string[];
  records: { approvalId?: string; paymentRequestId?: string; handoffId?: string; orderId?: string; cartId?: string };
  links: { label: string; href: string }[];
  replies: string[];
  note?: string;
  /** "created": the acceptance state exists. "expectedly_blocked": a founder control or policy refused the write — that refusal IS the expected result (PASS), not an error. */
  outcome: "created" | "expectedly_blocked";
  blocked?: { policyId: string; reason: string; step: string };
};

const RINA = "fashion-retailer";
const who = { customerInfo: { name: "QA Dana", phone: "0501234567" }, evidence: { "customerInfo.name": "QA Dana", "customerInfo.phone": "0501234567" } };

export const QA_SCENARIOS: QaScenario[] = [
  { id: "rina_cart_midnight_onyx", businessId: RINA, title: "Rina: cart with Midnight (M) + Onyx (M)", expect: "Two lines in a simulated provider cart, ₪810; no checkout requested.", creates: ["conversation", "cart"] },
  { id: "rina_checkout_pending", businessId: RINA, title: "Rina: checkout pending (payment link sent, unpaid)", expect: "A pending simulated payment link for ₪420; Money shows it as pending test money; an unpaid-link obligation is watching.", creates: ["conversation", "cart", "payment request (pending)"] },
  { id: "rina_payment_unverified_claim", businessId: RINA, title: "Rina: customer claims 'I paid' while the provider says pending", expect: "verifyPayment ran; nothing is marked paid; no order.", creates: ["conversation", "cart", "payment request (pending)"] },
  { id: "rina_discount_approval", businessId: RINA, title: "Rina: 10% discount request (above the 5% limit)", expect: "One owner request 'a 10% discount on Midnight Wrap Dress (₪420 → ₪378)' on Today; no handoff.", creates: ["conversation", "cart", "approval (pending)"] },
  { id: "rina_completed_order", businessId: RINA, title: "Rina: completed order (simulated payment verified)", expect: "Payment verified on the simulator, exactly one order; Money shows it as simulated (never collected).", creates: ["conversation", "cart", "payment request (paid, simulated)", "order"] },
  { id: "logistics_c302_approval", businessId: LOGISTICS_DEMO_ID, title: "Logistics: active support-case approval for Q4-C302", expect: "One pending owner request to open a support case for Q4-C302.", creates: ["conversation", "approval (pending)"] },
  { id: "logistics_f31_held", businessId: LOGISTICS_DEMO_ID, title: "Logistics: F31 — C302 request HELD after a correction BARRY couldn't read", expect: "The C302 request is HELD (no Approve); Re-check supersedes it with C303.", creates: ["conversation", "approval (held)", "one not-understood turn"] },
  { id: "handoff_open", businessId: LOGISTICS_DEMO_ID, title: "Open handoff (customer asked for a person)", expect: "An open handoff on Today with the summary; an unresolved-handoff obligation.", creates: ["conversation", "handoff (open)"] },
  { id: "delivery_failed", businessId: "spa", title: "Undelivered reply on WhatsApp (dry-run sender that fails)", expect: "A delivery record 'failed'; an undelivered-reply incident (high) and obligation.", creates: ["conversation", "delivery record (failed)"] },
  { id: "ai_failure_armed", businessId: RINA, title: "AI understanding failure armed on a fresh conversation", expect: "The next customer message in this conversation fails understanding (one shot).", creates: ["conversation (armed)"] },
];

const SCRIPT: Record<string, Partial<BarryIR>> = {
  "black dresses": { commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true },
  "the midnight dress": { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true },
  "add the Midnight in M": { commerce: { intent: "select", subject: "Midnight", variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, advancesTransaction: true },
  "add the Onyx in M too": { commerce: { intent: "select", subject: "Onyx", variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, advancesTransaction: true },
  "checkout please, QA Dana 0501234567": { commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who },
  "I paid": { customerClaims: { paymentCompleted: true }, advancesTransaction: true },
  "could you ask the owner to approve 10% off this dress?": { constraints: { discountPct: 10 }, advancesTransaction: true, handoff: { reason: "asked the owner for a discount", urgency: "normal" }, asks: [{ ask: "10% off this dress", kind: "change", coveredByThisIR: true }] },
  "Parcel Q4-C302 is delayed, open a delay case": { capabilityRequest: { capability: "support.ticket.create", input: { reference: "Q4-C302", reason: "delivery_delay" }, purpose: "case" }, advancesTransaction: true },
  "I want to talk to a human": { handoff: { reason: "the customer asked for a person", urgency: "normal" }, advancesTransaction: false },
  hello: { advancesTransaction: false },
};

function links(businessId: string, conversationId: string, extra: { label: string; href: string }[] = []): QaScenarioRun["links"] {
  const b = encodeURIComponent(businessId);
  const c = encodeURIComponent(conversationId);
  return [
    { label: "Owner · Today", href: `/owner?tab=today` },
    { label: "Owner · this conversation", href: `/owner?tab=inbox&conversation=${c}` },
    { label: "Owner · Money", href: `/owner?tab=money` },
    { label: "Train BARRY", href: `/owner/train` },
    { label: "HQ · conversation (Inspector)", href: `/hq/${b}/conversations/${c}` },
    { label: "HQ · business", href: `/hq/${b}` },
    { label: "QA tools", href: `/qa` },
    ...extra,
  ];
}

export function qaScenario(id: string): QaScenario | undefined {
  return QA_SCENARIOS.find((s) => s.id === id);
}

/** Run one scenario. QA mode only; never on Production. */
export async function runQaScenario(id: QaScenarioId, opts: { runId?: string; now?: Date } = {}): Promise<QaScenarioRun> {
  if (!qaEnabled()) throw new Error("QA scenarios are only available in QA mode");
  const scenario = qaScenario(id);
  if (!scenario) throw new Error(`Unknown QA scenario: ${id}`);
  const graph = graphOrNull(scenario.businessId);
  if (!graph) throw new Error(`QA scenario business is not available here: ${scenario.businessId}`);
  const runId = opts.runId ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const conversationId = `${QA_PREFIX}${id}:${runId}`;
  const say = (m: string) => handleCustomerMessage(graph, conversationId, QA_CUSTOMER, m);
  const replies: string[] = [];
  const records: QaScenarioRun["records"] = {};
  const created: string[] = [...scenario.creates];
  let note: string | undefined;
  let blocked: QaScenarioRun["blocked"];

  await withQaReasoner(new QaScriptedReasoner(SCRIPT), async () => {
    const step = async (m: string) => {
      const out = await say(m);
      replies.push(out.response);
      return out;
    };
    switch (id) {
      case "rina_cart_midnight_onyx": {
        await step("black dresses");
        await step("add the Midnight in M");
        const out = await step("add the Onyx in M too");
        records.cartId = out.state.knownFields.__commerceCartId;
        break;
      }
      case "rina_checkout_pending":
      case "rina_payment_unverified_claim":
      case "rina_completed_order": {
        await step("the midnight dress");
        await step("add the Midnight in M");
        const out = await step("checkout please, QA Dana 0501234567");
        records.cartId = out.state.knownFields.__commerceCartId;
        records.paymentRequestId = out.state.knownFields.__paymentRequestId;
        if (!records.paymentRequestId) {
          const refusal = expectedRefusal(out.turn.trace?.steps ?? []);
          if (!refusal) throw new Error("The checkout did not produce a payment request (see the replies)");
          blocked = { ...refusal, step: "checkout" };
          note = `Expectedly blocked: ${refusal.reason}`;
          break;
        }
        if (id === "rina_payment_unverified_claim") await step("I paid");
        if (id === "rina_completed_order") {
          await getBackend().simulatePaymentOutcome(records.paymentRequestId, "paid");
          const paid = await handlePaymentOutcome(graph, conversationId, records.paymentRequestId, "paid");
          replies.push(paid.response);
          records.orderId = paid.state.knownFields.__commerceOrderId;
        }
        break;
      }
      case "rina_discount_approval": {
        await step("the midnight dress");
        await step("add the Midnight in M");
        await step("could you ask the owner to approve 10% off this dress?");
        break;
      }
      case "logistics_c302_approval": {
        await step("Parcel Q4-C302 is delayed, open a delay case");
        break;
      }
      case "logistics_f31_held": {
        await step("Parcel Q4-C302 is delayed, open a delay case");
        const store = getConversationStore();
        const state = (await store.get(conversationId))!;
        state.knownFields[QA_FORCE_UNDERSTANDING_FAILURE] = "1";
        await store.save(state);
        await step("Sorry, I meant Q4-C303, not C302");
        note = "Owner → Today: the C302 request is HELD. Press Re-check: the correction (C303) supersedes it.";
        created.push("forced understanding failure (consumed)");
        break;
      }
      case "handoff_open": {
        const out = await step("I want to talk to a human");
        records.handoffId = readHandoffs(out.state).find((h) => h.status !== "resolved")?.id;
        break;
      }
      case "delivery_failed": {
        const failing = { channel: "whatsapp" as const, mode: "live" as const, send: async () => { throw new Error("QA: simulated WhatsApp send failure (nothing was sent)"); } };
        const result = await processInbound({ businessId: graph.business.id, conversationId, customerId: QA_CUSTOMER, identity: { channel: "whatsapp", channelUserId: "972500000099" }, text: "hello", receivedAt: new Date().toISOString(), inboundId: `qa-${runId}` }, failing);
        if (result.status === "processed") replies.push(result.reply);
        note = "The sender is a QA stub that fails locally: no message reached any provider.";
        break;
      }
      case "ai_failure_armed": {
        await step("hello");
        const store = getConversationStore();
        const state = (await store.get(conversationId))!;
        state.knownFields[QA_FORCE_UNDERSTANDING_FAILURE] = "1";
        await store.save(state);
        note = "Send the next message to this conversation from the simulator: it fails understanding once.";
        break;
      }
    }
  });

  if (!records.approvalId) {
    const approvals = (await getBackend().listApprovals(graph.business.id)).filter((a) => a.conversationId === conversationId);
    if (approvals.length) records.approvalId = approvals[approvals.length - 1].id;
  }
  const run: QaScenarioRun = {
    runId,
    scenario: id,
    businessId: graph.business.id,
    conversationId,
    createdAt: (opts.now ?? new Date()).toISOString(),
    created,
    records,
    links: links(graph.business.id, conversationId, [{ label: "Simulator (this business)", href: `/simulator?businessId=${encodeURIComponent(graph.business.id)}` }]),
    replies,
    ...(note ? { note } : {}),
    outcome: blocked ? "expectedly_blocked" : "created",
    ...(blocked ? { blocked } : {}),
  };
  await getBackend().upsertOperatorRecord({ businessId: graph.business.id, kind: "qa_scenario", key: runId, data: run });
  return run;
}

/** A write refused by a founder control or a policy rule is an EXPECTED result when the founder set that control. */
function expectedRefusal(steps: { policy: { status: string; reason: string; policyId?: string } }[]): { policyId: string; reason: string } | undefined {
  const refused = steps.find((s) => s.policy.status === "denied" && s.policy.policyId?.startsWith("founder_control:"));
  return refused ? { policyId: refused.policy.policyId!, reason: refused.policy.reason } : undefined;
}

export async function listQaScenarioRuns(businessId: string): Promise<QaScenarioRun[]> {
  const records = await getBackend().listOperatorRecords(businessId, "qa_scenario");
  return records.map((r) => r.data as unknown as QaScenarioRun).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
