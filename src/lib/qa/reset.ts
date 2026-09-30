import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { qaEnabled } from "./mode";
import { QA_PREFIX } from "./scenarios";

/**
 * QA DATA RESET (QA mode only): removes ONLY records the QA lane created for one business — conversations
 * whose id starts with `qa:` (with their messages and turns), the payments / approvals / bookings / carts /
 * orders / follow-ups of those conversations, scenario-run records, and obligations / incident states
 * keyed to them. Never any other business data.
 */
export type QaResetResult = { businessId: string; prefix: string; conversations: number; records: Record<string, number>; scenarioRuns: number; obligations: number; incidents: number };

export async function resetQaData(businessId: string): Promise<QaResetResult> {
  if (!qaEnabled()) throw new Error("QA reset is only available in QA mode");
  const backend = getBackend();
  const conversations = await getConversationStore().deleteConversationsByPrefix(businessId, QA_PREFIX);
  const records = await backend.purgeQaRecords(businessId, QA_PREFIX);
  const scenarioRuns = await backend.deleteOperatorRecords(businessId, "qa_scenario");
  const obligationKeys = (await backend.listOperatorRecords(businessId, "obligation")).filter((r) => String((r.data as { conversationId?: string }).conversationId ?? "").startsWith(QA_PREFIX)).map((r) => r.key);
  const obligations = obligationKeys.length ? await backend.deleteOperatorRecords(businessId, "obligation", obligationKeys) : 0;
  const incidentKeys = (await backend.listOperatorRecords(businessId, "incident")).filter((r) => r.key.includes(`:${QA_PREFIX}`)).map((r) => r.key);
  const incidents = incidentKeys.length ? await backend.deleteOperatorRecords(businessId, "incident", incidentKeys) : 0;
  return { businessId, prefix: QA_PREFIX, conversations, records, scenarioRuns, obligations, incidents };
}
