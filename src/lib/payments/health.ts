import { getBackend } from "@/lib/store";

/**
 * PAYMENT HEALTH EVENTS — a provider event BARRY could not verify against its own records (amount / currency /
 * business / conversation mismatch, or the verified event could not complete the sale). Stored per business so the
 * owner and the founder see it (BARRY never counts such a payment as paid). No secret, no raw payload.
 */
export type PaymentHealthEvent = { at: string; provider: string; paymentId?: string; reason: string };

const PREFIX = "health_event:payment:";

export async function recordPaymentHealthEvent(businessId: string, e: PaymentHealthEvent): Promise<void> {
  const key = `${PREFIX}${e.provider}:${e.paymentId ?? "unknown"}:${e.at}`.slice(0, 200);
  await getBackend().upsertOperatorRecord({ businessId, kind: "founder_state", key, data: { ...e, reason: e.reason.slice(0, 200) } as unknown as Record<string, unknown> });
}

export async function listPaymentHealthEvents(businessId: string): Promise<PaymentHealthEvent[]> {
  return (await getBackend().listOperatorRecords(businessId, "founder_state")).filter((r) => r.key.startsWith(PREFIX)).map((r) => r.data as unknown as PaymentHealthEvent);
}
