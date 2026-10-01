"use client";

import { useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { InterventionQueue, type Act } from "../operating";
import { Empty } from "../ui";
import { Hero, Panel, PanelHeader, Segmented } from "../kit";
import { DecisionRow } from "./Money";
import { plural } from "./shared";

/**
 * ACTIONS & APPROVALS — everything BARRY wants to do that needs the owner, with what, why, the exact
 * terms, the evidence and what happens after; then every decision already made. The owner endpoints
 * re-check everything before any effect.
 */
export function ActionsView({ ws, act, busyId, onOpen }: { ws: OwnerWorkspace; act: Act; busyId: string | null; onOpen: (id: string) => void }) {
  const [view, setView] = useState<"open" | "decided">("open");
  const queue = ws.interventions;
  const decided = ws.approvals.filter((a) => !(a.actionable || a.lifecycle === "held"));
  return (
    <div className="flex flex-col gap-6">
      <Hero
        eyebrow={`Actions & approvals · ${ws.business.name}`}
        title={queue.length ? <><span className="o-hero-type">{plural(queue.length, "decision")}</span> waiting for you.</> : <>Nothing waits on <span className="o-hero-type">your decision.</span></>}
        lead="Each request shows what BARRY wants to do, why it stopped for you, the exact terms, the evidence, and what happens after you decide. Approving never skips a re-check."
      />
      <Segmented ariaLabel="Actions view" value={view} onChange={setView} options={[{ id: "open", label: "Waiting for you", count: queue.length }, { id: "decided", label: "Decided", count: decided.length }]} />
      {view === "open" ? (
        <InterventionQueue items={queue} busyId={busyId} onAct={act} />
      ) : (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="shield" title="Decisions you made" sub="What happened after each one, from BARRY's records." />
          {decided.length === 0 ? (
            <div className="mt-3">
              <Empty>No decisions yet.</Empty>
            </div>
          ) : (
            <ul className="mt-2 divide-y divide-o-line">
              {decided.map((a) => (
                <DecisionRow key={a.id} a={a} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
