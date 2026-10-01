import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { fleetConsole, type ConsoleFilter } from "@/lib/hq/console";
import { hqShellData } from "@/lib/hq/shell-data";
import { formatLocal } from "@/lib/format/time";
import { HqShell } from "@/components/hq/HqShell";
import { EmptyState, FocusItem, FocusList, HeroBrief, Page, Section, button, input } from "@/components/ds/primitives";

/** CROSS-BUSINESS CONVERSATION CONSOLE — founder-only, read-only; filter by business, status, needs owner, money, incident, time, channel. */
export default async function HqConsolePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireFounder();
  const sp = await searchParams;
  const now = new Date();
  const filter: ConsoleFilter = { businessId: sp.businessId || undefined, status: (sp.status as ConsoleFilter["status"]) || undefined, needsOwner: sp.needsOwner === "1" ? true : undefined, moneyInvolved: sp.money === "1" ? true : undefined, incidentLinked: sp.incident === "1" ? true : undefined, channel: (sp.channel as ConsoleFilter["channel"]) || undefined, sinceHours: sp.sinceHours ? Number(sp.sinceHours) : undefined, limit: 100 };
  const [fleet, rows] = await Promise.all([getFleet({ now }), fleetConsole(filter, now)]);
  const tz = new Map(fleet.businesses.map((b) => [b.id, b.timezone]));
  return (
    <HqShell active="activity" data={hqShellData(fleet)}>
      <Page width="wide">
        <HeroBrief eyebrow="Console" title={`${rows.length} conversation${rows.length === 1 ? "" : "s"}${sp.status || sp.needsOwner || sp.money || sp.incident || sp.channel || sp.businessId ? " match" : ""}`} lead="Every business, read-only. Filter, open the conversation trace; the owner keeps the authority." />
        <Section>
          <form method="get" className="mb-4 grid gap-2 sm:grid-cols-4">
            <select name="businessId" defaultValue={sp.businessId ?? ""} className={input} aria-label="Business"><option value="">Every business</option>{fleet.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <select name="status" defaultValue={sp.status ?? ""} className={input} aria-label="Status"><option value="">Any status</option><option value="needs_owner">Needs owner</option><option value="waiting_on_customer">Waiting on customer</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select>
            <select name="channel" defaultValue={sp.channel ?? ""} className={input} aria-label="Channel"><option value="">Any channel</option><option value="web">Web</option><option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option></select>
            <select name="sinceHours" defaultValue={sp.sinceHours ?? ""} className={input} aria-label="Time"><option value="">Any time</option><option value="24">Last day</option><option value="168">Last week</option></select>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="needsOwner" value="1" defaultChecked={sp.needsOwner === "1"} /> needs owner</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="money" value="1" defaultChecked={sp.money === "1"} /> money involved</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="incident" value="1" defaultChecked={sp.incident === "1"} /> incident-linked</label>
            <button className={button}>Filter</button>
          </form>
          {rows.length === 0 ? <EmptyState>No conversation matches.</EmptyState> : (
            <FocusList>
              {rows.map((r) => (
                <FocusItem key={`${r.businessId}:${r.conversationId}`} status={r.needsOwner ? "attention" : r.status === "completed" ? "ok" : "neutral"} title={`${r.customer} · ${r.businessName}`} why={`${r.status.replace(/_/g, " ")} · ${r.channel} · ${r.messages} messages${r.money ? ` · ${r.money.amount} ${r.money.currency} ${r.money.state}` : ""}${r.incidentLinked ? " · incident-linked" : ""}`} meta={formatLocal(r.lastActivityAt, tz.get(r.businessId) ?? "UTC", now)} href={`/hq/${encodeURIComponent(r.businessId)}/conversations/${encodeURIComponent(r.conversationId)}`} />
              ))}
            </FocusList>
          )}
        </Section>
        <p className="mt-4 text-[12px] text-[#98a2b3]"><Link href="/hq/transactions" className="hover:underline">Transactions ›</Link> · <Link href="/hq/approvals" className="hover:underline">Approvals ›</Link> · <Link href="/hq/connections" className="hover:underline">Connections ›</Link> · <Link href="/hq/proposals" className="hover:underline">Proposals ›</Link></p>
      </Page>
    </HqShell>
  );
}
