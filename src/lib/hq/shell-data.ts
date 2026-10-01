import type { Fleet } from "./fleet";
import { listBusinessSummaries } from "@/lib/fixtures";
import { runtimeCommit, BARRY_RUNTIME_VERSION } from "@/lib/runtime/version";
import { environmentLabel } from "@/lib/qa/mode";
import { fleetPresence } from "./presence";
import type { HqShellData } from "@/components/hq/HqShell";

/** Shell data from the fleet read model (server side). */
export function hqShellData(fleet: Fleet, overrides: Partial<HqShellData> = {}): HqShellData {
  const incidents = fleet.businesses.reduce((n, b) => n + b.incidents.high + b.incidents.medium, 0);
  return {
    presence: fleetPresence(fleet),
    businesses: fleet.businesses.map((b) => ({ id: b.id, name: b.name, status: b.health === "healthy" ? "ok" : b.health === "attention" ? "attention" : "blocked" })),
    badges: { focus: fleet.summary.needFounder.length || undefined, incidents: incidents || undefined },
    build: `${fleet.build.commit ? `Build ${fleet.build.commit.slice(0, 7)}` : "Local build"} · ${fleet.build.environment} · ${fleet.build.runtime}`,
    ...overrides,
  };
}

/** Shell data without loading the fleet (for deep technical pages such as a conversation trace). */
export function hqShellLight(): HqShellData {
  return {
    presence: { state: "working", text: "Fleet status on Focus" , href: "/hq" },
    businesses: listBusinessSummaries().map((b) => ({ id: b.id, name: b.name, status: "ok" as const })),
    build: `${runtimeCommit() ? `Build ${runtimeCommit()!.slice(0, 7)}` : "Local build"} · ${environmentLabel()} · ${BARRY_RUNTIME_VERSION}`,
  };
}
