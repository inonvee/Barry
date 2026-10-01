import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { fleetTransactions, type TransactionRow } from "@/lib/hq/console";
import { hqShellData } from "@/lib/hq/shell-data";
import { formatLocal } from "@/lib/format/time";
import { formatAmount } from "@/lib/format/money";
import { HqShell } from "@/components/hq/HqShell";
import { EmptyState, FocusItem, FocusList, HeroBrief, Page, Section, button, input } from "@/components/ds/primitives";

/** CROSS-BUSINESS TRANSACTIONS — carts, payments, orders, bookings with verified state and failures. */
export default async function HqTransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireFounder();
  const sp = await searchParams;
  const now = new Date();
  const [fleet, rows] = await Promise.all([getFleet({ now }), fleetTransactions({ businessId: sp.businessId || undefined, kind: (sp.kind as TransactionRow["kind"]) || undefined, failedOnly: sp.failed === "1", limit: 150 })]);
  const tz = new Map(fleet.businesses.map((b) => [b.id, b.timezone]));
  const failed = rows.filter((r) => r.failed).length;
  return (
    <HqShell active="money" data={hqShellData(fleet)}>
      <Page width="wide">
        <HeroBrief eyebrow="Transactions" title={`${rows.length} transaction${rows.length === 1 ? "" : "s"} · ${failed} failed`} lead="Verified means the provider confirmed it. Test money (simulators) is labelled and never counted." />
        <Section>
          <form method="get" className="mb-4 grid gap-2 sm:grid-cols-4">
            <select name="businessId" defaultValue={sp.businessId ?? ""} className={input} aria-label="Business"><option value="">Every business</option>{fleet.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <select name="kind" defaultValue={sp.kind ?? ""} className={input} aria-label="Kind"><option value="">Carts, payments, orders, bookings</option><option value="cart">Carts</option><option value="payment">Payments</option><option value="order">Orders</option><option value="booking">Bookings</option></select>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="failed" value="1" defaultChecked={sp.failed === "1"} /> failed only</label>
            <button className={button}>Filter</button>
          </form>
          {rows.length === 0 ? <EmptyState>Nothing matches.</EmptyState> : (
            <FocusList>
              {rows.map((r) => (
                <FocusItem key={`${r.kind}:${r.businessId}:${r.id}`} status={r.failed ? "blocked" : r.verified ? "ok" : r.simulated ? "simulator" : "neutral"} title={`${r.kind} · ${r.state}${r.amount !== undefined && r.currency ? ` · ${formatAmount(r.amount, r.currency)}` : ""}`} why={`${r.businessName} · ${r.verified ? "provider-verified" : "not verified"}${r.simulated ? " · test" : ""}`} meta={`${formatLocal(r.at, tz.get(r.businessId) ?? "UTC", now)} · ${r.id}`} href={`/hq/${encodeURIComponent(r.businessId)}/conversations/${encodeURIComponent(r.conversationId)}`} />
              ))}
            </FocusList>
          )}
        </Section>
      </Page>
    </HqShell>
  );
}
