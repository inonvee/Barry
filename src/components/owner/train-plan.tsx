import { Empty } from "@/components/owner/ui";
import type { SetupStep } from "@/lib/owner/capabilities";

/**
 * The setup plan, rendered for the OWNER: what each step is, why it matters, how it happens and what it
 * unlocks — in the owner's words only. A step the BARRY team does may carry a technical note (setting
 * keys); it is shown only in the explicit team section, folded, labelled as the team's technical step.
 */

const GATE_WORDS: Record<SetupStep["gate"], string> = { testing: "to test BARRY", supervised_pilot: "for the supervised pilot", customer_traffic: "for customer traffic" };

export function SetupPlan({ steps }: { steps: SetupStep[] }) {
  if (steps.length === 0) return <Empty title="Nothing left to set up">BARRY can do everything your business asks of it, for real.</Empty>;
  const yours = steps.filter((s) => s.who === "you");
  const team = steps.filter((s) => s.who !== "you");
  const Step = ({ s, i }: { s: SetupStep; i: number }) => (
    <li id={`step-${s.id}`} className="rounded-2xl bg-white p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#1d2939] text-[12px] font-semibold text-white">{i + 1}</span>
        <p className="text-[15px] font-semibold text-[#101828]">{s.title}</p>
        <span className="text-[12px] text-[#98a2b3]">{GATE_WORDS[s.gate]}</span>
      </div>
      <dl className="mt-3 space-y-2">
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">Why it matters</dt>
          <dd className="text-[14px] text-[#344054]">{s.why}</dd>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">How</dt>
          <dd className="text-[14px] text-[#344054]">{s.how}</dd>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">Then BARRY can</dt>
          <dd className="text-[14px] font-medium text-[#067647]">{s.unlocks.join(" · ")}</dd>
        </div>
        {s.technical && s.who === "barry_team" && (
          <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">BARRY team · technical</dt>
            <dd>
              <details className="text-[13px] text-[#667085]">
                <summary className="cursor-pointer">For the BARRY team (technical step — nothing for you to do)</summary>
                <p className="mt-1 break-words font-mono text-[12px] text-[#475467]">{s.technical}</p>
              </details>
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
  return (
    <div className="flex flex-col gap-5">
      {yours.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085]">What BARRY needs from you</p>
          <ol className="flex flex-col gap-3">
            {yours.map((s, i) => (
              <Step key={s.id} s={s} i={i} />
            ))}
          </ol>
        </div>
      )}
      {team.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085]">With the BARRY team</p>
          <ol className="flex flex-col gap-3">
            {team.map((s, i) => (
              <Step key={s.id} s={s} i={yours.length + i} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
