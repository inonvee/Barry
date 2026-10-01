import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { globalApprovals } from "@/lib/hq/console";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { EmptyState, FocusItem, FocusList, HeroBrief, Page, Section } from "@/components/ds/primitives";

/** GLOBAL APPROVALS — the founder sees business, policy, action and age. The founder cannot decide them: that is the owner's authority. */
export default async function HqApprovalsPage() {
  await requireFounder();
  const now = new Date();
  const [fleet, approvals] = await Promise.all([getFleet({ now }), globalApprovals({ now })]);
  return (
    <HqShell active="focus" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief eyebrow="Approvals" title={approvals.length === 0 ? "No request waits on an owner." : `${approvals.length} request${approvals.length === 1 ? "" : "s"} wait on owners.`} lead="Visibility only. Seeing a request does not let the founder approve it; the owner's authority stays the owner's. Nudge the owner, or pause the business if something is wrong." />
        <Section>
          {approvals.length === 0 ? <EmptyState>Nothing pending across the fleet.</EmptyState> : (
            <FocusList>
              {approvals.map((a) => (
                <FocusItem key={a.approvalId} status={a.lifecycle === "held" ? "blocked" : "attention"} title={`${a.summary}`} why={`${a.businessName} · ${a.customer} · policy ${a.policyId} · authority ${String(a.authority).replace(/_/g, " ")}`} move={`Waiting on the owner for ${a.ageHours}h${a.lifecycle === "held" ? " (held: needs a re-check)" : ""}.`} href={`/hq/${encodeURIComponent(a.businessId)}/conversations/${encodeURIComponent(a.conversationId)}`} />
              ))}
            </FocusList>
          )}
        </Section>
      </Page>
    </HqShell>
  );
}
