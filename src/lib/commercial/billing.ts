/**
 * BARRY COMMERCIAL BILLING BOUNDARY — vendor-neutral. Product code (the commercial workflow) depends on
 * this interface only, never on a billing vendor. V1 is MANUAL: every call records what the founder did
 * (an invoice sent by hand, a payment received by bank transfer) and moves no money. No vendor is chosen
 * here; a real provider is a new implementation behind the same interface, enabled only by explicit
 * configuration.
 *
 * This is BARRY's own subscription billing. It is entirely separate from the tenant business's customer
 * payments / orders and never reads or writes payment_requests or commerce records.
 */

export type BillingResult = { provider: string; reference: string; at: string; automatic: boolean; note: string };

export interface CommercialBilling {
  readonly provider: string;
  /** True only when a real billing provider charges automatically. Manual billing never auto-charges. */
  readonly chargesAutomatically: boolean;
  createSetupInvoice(input: { businessId: string; amount: number; currency: string }): Promise<BillingResult>;
  markSetupPaid(input: { businessId: string; amount: number; currency: string; reference?: string }): Promise<BillingResult>;
  createSubscription(input: { businessId: string; plan: string; monthlyPrice: number; currency: string }): Promise<BillingResult>;
  startFreePeriod(input: { businessId: string; startsAt: string; endsAt: string }): Promise<BillingResult>;
  activateRecurring(input: { businessId: string; startsAt: string; monthlyPrice: number; currency: string }): Promise<BillingResult>;
  pauseSubscription(input: { businessId: string; at: string }): Promise<BillingResult>;
  cancelSubscription(input: { businessId: string; effectiveAt: string }): Promise<BillingResult>;
}

const ref = (kind: string, businessId: string, at: string) => `manual:${kind}:${businessId}:${Date.parse(at).toString(36)}`;

/** V1: records the founder's manual commercial steps. Nothing is charged, sent or collected by BARRY. */
export class ManualCommercialBilling implements CommercialBilling {
  readonly provider = "manual";
  readonly chargesAutomatically = false;
  private result(kind: string, businessId: string, note: string): BillingResult {
    const at = new Date().toISOString();
    return { provider: this.provider, reference: ref(kind, businessId, at), at, automatic: false, note };
  }
  async createSetupInvoice(i: { businessId: string; amount: number; currency: string }) {
    return this.result("setup_invoice", i.businessId, `Setup invoice for ${i.amount} ${i.currency} — sent manually by the founder; nothing is charged by BARRY.`);
  }
  async markSetupPaid(i: { businessId: string; amount: number; currency: string; reference?: string }) {
    return this.result("setup_paid", i.businessId, `Setup payment of ${i.amount} ${i.currency} recorded as received${i.reference ? ` (${i.reference})` : ""}.`);
  }
  async createSubscription(i: { businessId: string; plan: string; monthlyPrice: number; currency: string }) {
    return this.result("subscription", i.businessId, `${i.plan} at ${i.monthlyPrice} ${i.currency}/month recorded; no recurring charge exists.`);
  }
  async startFreePeriod(i: { businessId: string; startsAt: string; endsAt: string }) {
    return this.result("free_period", i.businessId, `Free period ${i.startsAt.slice(0, 10)} → ${i.endsAt.slice(0, 10)} recorded.`);
  }
  async activateRecurring(i: { businessId: string; startsAt: string; monthlyPrice: number; currency: string }) {
    return this.result("recurring", i.businessId, `Recurring ${i.monthlyPrice} ${i.currency}/month from ${i.startsAt.slice(0, 10)} recorded — the founder invoices manually; nothing is auto-charged.`);
  }
  async pauseSubscription(i: { businessId: string; at: string }) {
    return this.result("pause", i.businessId, `Subscription paused at ${i.at.slice(0, 10)}.`);
  }
  async cancelSubscription(i: { businessId: string; effectiveAt: string }) {
    return this.result("cancel", i.businessId, `Cancellation effective ${i.effectiveAt.slice(0, 10)} recorded.`);
  }
}

let billing: CommercialBilling | undefined;

/** The configured boundary: manual unless a real provider is explicitly wired (none in V1). */
export function getCommercialBilling(): CommercialBilling {
  return billing ?? (billing = new ManualCommercialBilling());
}

export function setCommercialBillingForTests(b: CommercialBilling | undefined): void {
  billing = b;
}
