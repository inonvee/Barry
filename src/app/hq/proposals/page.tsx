import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { listProposals } from "@/lib/hq/proposals";
import { hqShellData } from "@/lib/hq/shell-data";
import { formatLocal } from "@/lib/format/time";
import { HqShell } from "@/components/hq/HqShell";
import { Disclosure, EmptyState, HeroBrief, Page, Section, StatusPill, Technical, button, buttonPrimary, input } from "@/components/ds/primitives";

/** ASK HQ V2 — structured change proposals: instruction → proposal → scope → affected businesses → conflicts → risk → diff → approval → versioned activation. */
export default async function HqProposalsPage() {
  await requireFounder();
  const now = new Date();
  const [fleet, proposals] = await Promise.all([getFleet({ now }), listProposals()]);
  const open = proposals.filter((p) => p.status === "proposed" || p.status === "approved");
  return (
    <HqShell active="settings" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief eyebrow="Proposals" title={open.length ? `${open.length} proposal${open.length === 1 ? "" : "s"} open.` : "No open proposal."} lead="Free text never mutates anything. A proposal shows its scope, the businesses it touches, conflicts, risk and the exact diff; activation runs through the audited control path, and GLOBAL / CAPABILITY scopes stay gated." />
        <div className="flex flex-col gap-5">
          <Section title="Propose a change">
            <form action="/api/hq/proposals" method="post" className="grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="action" value="propose" />
              <label className="text-[12px] text-[#667085] sm:col-span-2">Instruction (your words)<input name="instruction" required minLength={3} className={`${input} mt-1`} placeholder="e.g. Put Rina in safe mode until the payment provider is back" /></label>
              <label className="text-[12px] text-[#667085]">Scope<select name="scope" className={`${input} mt-1`}><option value="BUSINESS">BUSINESS</option><option value="TEMPORARY">TEMPORARY</option><option value="CAPABILITY">CAPABILITY (gated)</option><option value="GLOBAL">GLOBAL (gated)</option></select></label>
              <label className="text-[12px] text-[#667085]">Businesses (ids, comma-separated; GLOBAL/CAPABILITY = all)<input name="businessIds" className={`${input} mt-1`} defaultValue={fleet.businesses[0]?.id ?? ""} /></label>
              <label className="text-[12px] text-[#667085]">Safe mode<select name="safeMode" className={`${input} mt-1`}><option value="">unchanged</option><option value="true">on</option><option value="false">off</option></select></label>
              <label className="text-[12px] text-[#667085]">Pause consequential actions<select name="pauseConsequentialWrites" className={`${input} mt-1`}><option value="">unchanged</option><option value="true">pause</option><option value="false">resume</option></select></label>
              <label className="text-[12px] text-[#667085]">Require approval for everything<select name="approvalRequiredForAll" className={`${input} mt-1`}><option value="">unchanged</option><option value="true">on</option><option value="false">off</option></select></label>
              <label className="text-[12px] text-[#667085]">Pause business<select name="pausedBusiness" className={`${input} mt-1`}><option value="">unchanged</option><option value="true">pause</option><option value="false">resume</option></select></label>
              <label className="text-[12px] text-[#667085]">Mode<select name="mode" className={`${input} mt-1`}><option value="">unchanged</option><option value="simulator">simulator</option><option value="supervised">supervised</option><option value="live">live</option></select></label>
              <label className="text-[12px] text-[#667085]">Capability to pause (CAPABILITY scope)<input name="capability" className={`${input} mt-1`} placeholder="support.*" /></label>
              <div className="sm:col-span-2"><button className={`${buttonPrimary} w-full sm:w-auto`}>Create proposal (nothing changes yet)</button></div>
            </form>
          </Section>
          <Section title="Proposals" subtitle="Newest first. Each carries its history.">
            {proposals.length === 0 ? <EmptyState>None yet.</EmptyState> : (
              <div className="divide-y divide-[#f2f4f7]">
                {proposals.map((p) => (
                  <div key={p.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={p.status === "activated" ? "ok" : p.status === "rejected" || p.status === "rolled_back" ? "neutral" : p.status === "approved" ? "info" : "attention"}>{p.status.replace("_", " ")}</StatusPill>
                      <StatusPill status={p.risk === "high" ? "blocked" : p.risk === "medium" ? "attention" : "neutral"}>{p.risk} risk</StatusPill>
                      <span className="text-[14px] font-semibold text-[#101828]">{p.instruction}</span>
                      <span className="text-[12px] text-[#667085]">{p.scope} · v{p.version} · {p.affectedBusinesses.length} business{p.affectedBusinesses.length === 1 ? "" : "es"} · {formatLocal(p.proposedAt, "UTC", now)} UTC</span>
                    </div>
                    {p.conflicts.length > 0 && <p className="text-[13px] text-[#b54708]">Conflicts: {p.conflicts.join("; ")}</p>}
                    <Disclosure summary="Diff" muted>
                      <ul className="space-y-1 text-[12px]">
                        {p.diff.map((d) => (
                          <li key={d.businessId}><Technical>{d.businessId}</Technical> <Technical>{JSON.stringify(d.before)}</Technical> → <Technical>{JSON.stringify(d.after)}</Technical></li>
                        ))}
                      </ul>
                    </Disclosure>
                    <div className="flex flex-wrap gap-2">
                      {p.status === "proposed" && (<><form action="/api/hq/proposals" method="post"><input type="hidden" name="action" value="approve" /><input type="hidden" name="id" value={p.id} /><button className={button}>Approve</button></form><form action="/api/hq/proposals" method="post"><input type="hidden" name="action" value="reject" /><input type="hidden" name="id" value={p.id} /><button className={button}>Reject</button></form></>)}
                      {p.status === "approved" && (p.activation === "available" ? <form action="/api/hq/proposals" method="post"><input type="hidden" name="action" value="activate" /><input type="hidden" name="id" value={p.id} /><input type="hidden" name="confirm" value="yes" /><button className={buttonPrimary}>Activate (audited)</button></form> : <span className="text-[13px] text-[#667085]">Approved; {p.scope} activation is gated until a fleet-wide activation model exists.</span>)}
                      {p.status === "activated" && <form action="/api/hq/proposals" method="post"><input type="hidden" name="action" value="rollback" /><input type="hidden" name="id" value={p.id} /><input type="hidden" name="confirm" value="yes" /><button className={button}>Roll back</button></form>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </Page>
    </HqShell>
  );
}
