import type { ConversationState } from "@/lib/state";
import { getBackend } from "@/lib/store";
import type { CommerceCartRecord, CommerceOrderRecord, OperatorRecord, PaymentRequestRecord } from "@/lib/store/types";
import type { Cart, Order } from "./types";

/**
 * CUSTOMER COMMERCE MEMORY (CRM-lite) — what a customer really did (orders, carts, payments, options
 * they bought) kept APART from what BARRY infers (a preferred size after repeated purchases). Derived
 * from records; explicit preferences come only from what the customer stated and the runtime
 * recorded. Persisted per customer so continuity survives across conversations and channels.
 */

export type ObservedPurchase = { orderId: string; at: string; lines: { title: string; options: Record<string, string>; quantity: number }[]; total: { amount: number; currency: string }; verified: boolean };
export type InferredPreference = { option: string; value: string; observations: number; basis: "repeated_purchases" };

export type CustomerMemory = {
  businessId: string;
  customerId: string;
  observed: {
    purchases: ObservedPurchase[];
    activeCarts: { cartId: string; conversationId: string; lines: number; total: { amount: number; currency: string }; updatedAt: string }[];
    unpaidLinks: { paymentRequestId: string; amount: number; currency: string; createdAt: string }[];
    optionsUsed: Record<string, Record<string, number>>;
    lastSeenAt: string | null;
  };
  /** Only what the customer explicitly stated (recorded under verified customer facts). */
  explicit: Record<string, string>;
  inferred: InferredPreference[];
  updatedAt: string;
};

const EXPLICIT_PREFIX = "customer.pref.";

export function deriveCustomerMemory(input: { businessId: string; customerId: string; orders: CommerceOrderRecord[]; carts: CommerceCartRecord[]; payments: PaymentRequestRecord[]; conversations: ConversationState[]; now: Date }): CustomerMemory {
  const { businessId, customerId } = input;
  const mine = <T extends { customerId: string }>(xs: T[]) => xs.filter((x) => x.customerId === customerId);
  const optionsUsed: Record<string, Record<string, number>> = {};
  const purchases: ObservedPurchase[] = mine(input.orders).map((o) => {
    const order = o.data as Order | undefined;
    const lines = (order?.lines ?? []).map((l) => ({ title: l.title, options: l.options, quantity: l.quantity }));
    for (const l of lines) for (const [k, v] of Object.entries(l.options)) {
      optionsUsed[k] = optionsUsed[k] ?? {};
      optionsUsed[k][v] = (optionsUsed[k][v] ?? 0) + l.quantity;
    }
    return { orderId: o.orderId, at: o.createdAt, lines, total: { amount: o.totalAmount, currency: o.currency }, verified: Boolean(o.verifiedAt) };
  });
  const activeCarts = mine(input.carts).filter((c) => c.status !== "ordered").map((c) => {
    const cart = c.data as Cart | undefined;
    return { cartId: c.cartId, conversationId: c.conversationId, lines: cart?.lines.length ?? 0, total: cart?.total ?? { amount: 0, currency: "" }, updatedAt: c.updatedAt };
  }).filter((c) => c.lines > 0);
  const unpaidLinks = mine(input.payments).filter((p) => p.status === "pending").map((p) => ({ paymentRequestId: p.id, amount: p.amount, currency: p.currency, createdAt: p.createdAt }));
  const explicit: Record<string, string> = {};
  const convs = input.conversations.filter((c) => c.customerId === customerId);
  for (const c of convs) for (const [k, v] of Object.entries(c.knownFields)) if (k.startsWith(EXPLICIT_PREFIX) && v) explicit[k.slice(EXPLICIT_PREFIX.length)] = v;
  const inferred: InferredPreference[] = [];
  for (const [option, values] of Object.entries(optionsUsed)) {
    const top = Object.entries(values).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2 && !explicit[option]) inferred.push({ option, value: top[0], observations: top[1], basis: "repeated_purchases" });
  }
  const lastSeenAt = convs.map((c) => c.updatedAt).sort().at(-1) ?? null;
  return { businessId, customerId, observed: { purchases: purchases.sort((a, b) => b.at.localeCompare(a.at)), activeCarts, unpaidLinks, optionsUsed, lastSeenAt }, explicit, inferred, updatedAt: input.now.toISOString() };
}

export async function saveCustomerMemory(memory: CustomerMemory): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: memory.businessId, kind: "customer_memory", key: memory.customerId, data: memory });
}

export async function loadCustomerMemory(businessId: string, customerId: string): Promise<CustomerMemory | undefined> {
  const records = await getBackend().listOperatorRecords(businessId, "customer_memory");
  return records.map((r: OperatorRecord) => r.data as unknown as CustomerMemory).find((m) => m && m.customerId === customerId);
}

/** Refresh one customer's memory from the records (what callers use after an order or a payment). */
export async function refreshCustomerMemory(businessId: string, customerId: string, conversations: ConversationState[], now = new Date()): Promise<CustomerMemory> {
  const backend = getBackend();
  const [orders, carts, payments] = await Promise.all([backend.listCommerceOrders(businessId), backend.listCommerceCarts(businessId), backend.listPaymentRequests(businessId)]);
  const memory = deriveCustomerMemory({ businessId, customerId, orders, carts, payments, conversations, now });
  await saveCustomerMemory(memory);
  return memory;
}

/** Words for the model / owner: observed history first, inference labelled as such. */
export function memoryWords(m: CustomerMemory): string[] {
  const out: string[] = [];
  if (m.observed.purchases.length) out.push(`${m.observed.purchases.length} previous order${m.observed.purchases.length === 1 ? "" : "s"} (latest ${m.observed.purchases[0].lines.map((l) => `${l.title}${Object.keys(l.options).length ? ` ${Object.values(l.options).join("/")}` : ""}`).join(", ")})`);
  if (m.observed.activeCarts.length) out.push(`${m.observed.activeCarts.length} open cart${m.observed.activeCarts.length === 1 ? "" : "s"}`);
  if (m.observed.unpaidLinks.length) out.push(`${m.observed.unpaidLinks.length} unpaid payment link${m.observed.unpaidLinks.length === 1 ? "" : "s"}`);
  for (const [k, v] of Object.entries(m.explicit)) out.push(`stated ${k}: ${v}`);
  for (const i of m.inferred) out.push(`likely ${i.option} ${i.value} (inferred from ${i.observations} purchases; ask, don't assume)`);
  return out;
}
