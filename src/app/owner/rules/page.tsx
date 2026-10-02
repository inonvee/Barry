"use client";

import { OsPage } from "@/components/owner/OsPage";
import { TrainBarry } from "@/components/owner/TrainBarry";
import { Pill, type Tone } from "@/components/owner/ui";
import { Panel, PanelHeader } from "@/components/owner/kit";
import type { OwnerRule, RuleSource } from "@/lib/owner/os";

/**
 * RULES BARRY FOLLOWS — the rules the runtime enforces right now (the same effective-authority resolution
 * the policy engine uses, founder restrictions and follow-up rules included), each with where it came from
 * and whether the owner can change it here. Nothing on this page loosens anything by itself: a taught rule
 * goes through the reviewed Learn Business path and is used only once the owner confirms it.
 */
const SOURCE_TONE: Record<RuleSource, Tone> = { built_in: "neutral", profile: "info", owner: "good", founder: "warn" };

function RuleRow({ r }: { r: OwnerRule }) {
  return (
    <li className="flex flex-col gap-1.5 py-3" data-rule={r.id} data-source={r.source}>
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-o-faint">{r.area}</span>
        <Pill tone={SOURCE_TONE[r.source]} icon={false}>{r.sourceWords}</Pill>
        {r.state !== "active" && <Pill tone={r.state === "replaced" ? "neutral" : "warn"}>{r.state === "replaced" ? "Replaced" : r.state === "blocked" ? "Not used — above BARRY's limit" : "Not used yet — needs your answer"}</Pill>}
      </span>
      <span className="text-[14.5px] leading-6 text-o-ink">{r.words}</span>
      {r.question && <span className="text-[13px] text-o-warn">{r.question}</span>}
      <span className="text-[12px] text-o-muted">{r.changeWords}</span>
    </li>
  );
}

export default function RulesPage() {
  return (
    <OsPage section="rules" eyebrow="Rules BARRY follows" title="The rules BARRY follows." lead="Exactly what BARRY's decisions run on right now — where each rule came from and whether you can change it here. Above a limit, BARRY asks you first.">
      {(os, api) => {
        const founder = os.rules.rules.filter((r) => r.source === "founder");
        const yours = os.rules.rules.filter((r) => r.source === "owner" || r.source === "profile");
        const builtIn = os.rules.rules.filter((r) => r.source === "built_in");
        return (
          <>
            {founder.length > 0 && (
              <Panel className="p-4 md:p-5">
                <PanelHeader icon="lock" tone="warn" title="Restrictions from the BARRY team" sub="These hold while they're on — they only ever make BARRY more careful, never less." />
                <ul className="mt-1 divide-y divide-o-line">{founder.map((r) => <RuleRow key={r.id} r={r} />)}</ul>
              </Panel>
            )}
            <Panel className="p-4 md:p-5">
              <PanelHeader icon="shield" title="Your rules" sub="From your business profile and what you taught BARRY." />
              <ul className="mt-1 divide-y divide-o-line">{yours.map((r) => <RuleRow key={r.id} r={r} />)}</ul>
            </Panel>
            {os.rules.pending.length > 0 && (
              <Panel className="p-4 md:p-5">
                <PanelHeader icon="flag" tone="warn" title="Taught but not in use" sub="BARRY doesn't act on these until they're clear." />
                <ul className="mt-1 divide-y divide-o-line">{os.rules.pending.map((r) => <RuleRow key={r.id} r={r} />)}</ul>
              </Panel>
            )}
            <TrainBarry api={api} part="rules" />
            <Panel className="p-4 md:p-5">
              <PanelHeader icon="check" title="Always on" sub="Built into BARRY for every business." />
              <ul className="mt-1 divide-y divide-o-line">{builtIn.map((r) => <RuleRow key={r.id} r={r} />)}</ul>
            </Panel>
            <Panel className="p-4 md:p-5">
              <PanelHeader icon="lock" title="Not supported yet" sub="So you know what not to expect." />
              <ul className="mt-2 flex flex-col gap-1.5 text-[13.5px] text-o-ink-2">
                {os.rules.notSupported.map((n) => <li key={n}>· {n}</li>)}
              </ul>
            </Panel>
          </>
        );
      }}
    </OsPage>
  );
}
