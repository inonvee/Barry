"use client";

import type { BusinessGraph } from "@/lib/business-graph";

export function GraphPanel({ graph }: { graph: BusinessGraph | null }) {
  if (!graph) return <p className="text-sm text-neutral-500 p-3">Loading business graph…</p>;

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full text-sm">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Offers</h3>
        <ul className="space-y-1">
          {graph.offers.map((o) => (
            <li key={o.id} className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-2">
              <div className="flex justify-between">
                <span className="font-medium">{o.name}</span>
                <span className="text-neutral-500">{o.price === null ? "quote" : `$${o.price}`}</span>
              </div>
              <p className="text-xs text-neutral-500">{o.description}</p>
              <p className="text-xs text-neutral-400 mt-1">
                {[
                  o.requiresScheduling && "scheduling",
                  o.requiresInventory && "inventory",
                  o.requiresPayment && "payment",
                ]
                  .filter(Boolean)
                  .join(" · ") || "no special requirements"}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Policies</h3>
        <ul className="space-y-1">
          {graph.policies.map((p) => (
            <li key={p.id} className="text-xs text-neutral-600 dark:text-neutral-400">
              {p.description}: <span className="font-medium">{String(p.rule.value)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Knowledge</h3>
        <ul className="space-y-1">
          {graph.knowledge.map((k) => (
            <li key={k.id} className="text-xs text-neutral-600 dark:text-neutral-400">
              <span className="font-medium">{k.topic}:</span> {k.content}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Available actions</h3>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {graph.availableActions.map((a) => a.name).join(", ")}
        </p>
      </div>
    </div>
  );
}
