import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { fleetConnectionHealth } from "@/lib/hq/console";
import { hqShellData } from "@/lib/hq/shell-data";
import { formatLocal } from "@/lib/format/time";
import { HqShell } from "@/components/hq/HqShell";
import { EmptyState, FocusItem, FocusList, HeroBrief, Page, Section } from "@/components/ds/primitives";

/** CONNECTION HEALTH across businesses — provider, capability, status, last verification, expiry, drift, last failure, setup blocker. */
export default async function HqConnectionsPage() {
  await requireFounder();
  const now = new Date();
  const [fleet, rows] = await Promise.all([getFleet({ now }), fleetConnectionHealth(now)]);
  const due = rows.filter((r) => r.reverificationDue && !r.simulated).length;
  return (
    <HqShell active="barry" data={hqShellData(fleet)}>
      <Page width="wide">
        <HeroBrief eyebrow="Connections" title={`${rows.length} connected system${rows.length === 1 ? "" : "s"} · ${due} need re-verification`} lead="What each business runs on, from the fabric's own records: status, last verification, credential expiry, schema drift and the setup blocker. No secrets." />
        <Section>
          {rows.length === 0 ? <EmptyState>No systems registered.</EmptyState> : (
            <FocusList>
              {rows.map((r) => (
                <FocusItem key={`${r.businessId}:${r.systemId}`} status={r.health === "down" ? "blocked" : r.reverificationDue && !r.simulated ? "attention" : r.simulated ? "simulator" : r.status === "active" ? "ok" : "not_ready"} title={`${r.provider} · ${r.domain} · ${r.businessName}`} why={`${r.capabilities.length} capabilit${r.capabilities.length === 1 ? "y" : "ies"} (${r.capabilities.filter((c) => c.status === "active").length} active) · ${r.status} · health ${r.health}${r.schemaDrift ? " · schema drift" : ""}${r.authExpiresAt ? ` · credential expires ${formatLocal(r.authExpiresAt, "UTC", now)}` : ""}`} move={r.setupBlocker ? `Blocker: ${r.setupBlocker}` : r.reasons.length ? `Re-verify: ${r.reasons.join("; ")}` : undefined} meta={`last verified ${r.lastVerifiedAt ? formatLocal(r.lastVerifiedAt, "UTC", now) : "never"}${r.lastFailure ? ` · last failure: ${r.lastFailure}` : ""}`} href={`/hq/${encodeURIComponent(r.businessId)}?view=capabilities`} />
              ))}
            </FocusList>
          )}
        </Section>
      </Page>
    </HqShell>
  );
}
