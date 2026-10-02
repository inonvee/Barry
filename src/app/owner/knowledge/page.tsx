"use client";

import Link from "next/link";
import { OsPage } from "@/components/owner/OsPage";
import { TrainBarry } from "@/components/owner/TrainBarry";
import { Panel, PanelHeader } from "@/components/owner/kit";

/**
 * WHAT BARRY KNOWS — what BARRY knows about the business and where it came from, what it is unsure about,
 * what customers asked that it couldn't answer (persisted "BARRY noticed" items only), what to teach next,
 * and the sources the owner approved. Everything reads the same records the runtime answers from; nothing
 * learned is used until the owner confirms it.
 */
export default function KnowledgePage() {
  return (
    <OsPage section="knowledge" eyebrow="What BARRY knows" title="What BARRY knows about your business." lead="What BARRY answers customers from, where each fact came from, what it's unsure about — and what only you can tell it. BARRY never guesses: if it doesn't know, it says so.">
      {(os, api) => (
        <>
          {os.questions.length > 0 && (
            <Panel className="p-4 md:p-5">
              <PanelHeader icon="chat" tone="warn" title="Customers asked — BARRY didn't know" sub="From your conversations. Teaching BARRY the answer closes the gap." />
              <ul className="mt-2 divide-y divide-o-line">
                {os.questions.map((q) => (
                  <li key={q.id} className="flex flex-col gap-1 py-3 text-[13.5px]">
                    <span className="font-medium text-o-ink">{q.what}</span>
                    <span className="text-o-ink-2">{q.observation}</span>
                    <span className="text-[12px] text-o-muted">{q.evidence}</span>
                  </li>
                ))}
              </ul>
              <Link href="#teach" className="mt-2 inline-block text-[13px] font-medium text-o-accent hover:underline">Teach BARRY the answers ›</Link>
            </Panel>
          )}
          <TrainBarry api={api} part="knowledge" />
        </>
      )}
    </OsPage>
  );
}
