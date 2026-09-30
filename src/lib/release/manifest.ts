import { getBackend } from "@/lib/store";
import { runtimeCommit } from "@/lib/runtime/version";
import { environmentLabel } from "@/lib/qa/mode";
import { ACCEPTANCE_MANIFEST } from "./current";

/**
 * RELEASE FAST LANE — the acceptance manifest for the current candidate build and the release state
 * machine. The manifest is authored per build (src/lib/release/current.ts) from what was changed and
 * how it was proven; the state is computed from it and from the Work verdict recorded for THIS sha.
 * Deterministic tests never promote a build to LIVE PASSED: only a recorded Work verdict does.
 */

export type ReleaseStateName = "IMPLEMENTED" | "DETERMINISTICALLY_PROVEN" | "LOCALLY_PROVEN" | "LIVE_PROOF_REQUIRED" | "LIVE_PASSED" | "BLOCKED";

export type LiveCheck = {
  id: string;
  title: string;
  /** Why this needs a live pass (what deterministic proof cannot show). */
  why: string;
  /** Where Work runs it (route or surface). */
  where: string;
  risk: "high" | "medium";
};

export type AcceptanceManifest = {
  /** Human label of the candidate (the pass name). */
  candidate: string;
  domainsChanged: string[];
  riskAreas: string[];
  implemented: string[];
  deterministicallyProven: string[];
  locallyProven: string[];
  liveProofRequired: LiveCheck[];
  knownUnverified: string[];
  doNotRetest: string[];
  knownBlockers: string[];
};

export type WorkVerdict = { sha: string; verdict: "passed" | "blocked" | "partial"; at: string; by: string; note?: string; failedChecks?: string[] };

export type ReleaseGate = { id: string; label: string; status: "pass" | "fail" | "unknown"; detail: string };

export type ReleaseState = {
  state: ReleaseStateName;
  sha: string | null;
  preview: string | null;
  environment: string;
  manifest: AcceptanceManifest;
  verdict: WorkVerdict | null;
  gates: ReleaseGate[];
  nextProofRequired: string[];
};

export const FLEET_SCOPE = "fleet";

export function releaseState(manifest: AcceptanceManifest, verdict: WorkVerdict | null, sha: string | null): ReleaseStateName {
  if (manifest.knownBlockers.length > 0) return "BLOCKED";
  if (verdict && sha && verdict.sha === sha) {
    if (verdict.verdict === "blocked") return "BLOCKED";
    if (verdict.verdict === "passed") return "LIVE_PASSED";
  }
  if (manifest.liveProofRequired.length > 0) return "LIVE_PROOF_REQUIRED";
  if (manifest.locallyProven.length > 0) return "LOCALLY_PROVEN";
  if (manifest.deterministicallyProven.length > 0) return "DETERMINISTICALLY_PROVEN";
  return "IMPLEMENTED";
}

export function releaseGates(manifest: AcceptanceManifest, verdict: WorkVerdict | null, sha: string | null): ReleaseGate[] {
  const proven = (area: string): ReleaseGate["status"] => (manifest.deterministicallyProven.some((p) => p.toLowerCase().includes(area)) ? "pass" : "unknown");
  const live = (id: string): ReleaseGate["status"] => (verdict && sha && verdict.sha === sha ? (verdict.failedChecks?.includes(id) ? "fail" : verdict.verdict === "passed" ? "pass" : "unknown") : "unknown");
  return [
    { id: "deterministic", label: "Deterministic suite", status: manifest.deterministicallyProven.length ? "pass" : "unknown", detail: `${manifest.deterministicallyProven.length} proven areas` },
    { id: "local_ux", label: "Local UX smoke", status: manifest.locallyProven.length ? "pass" : "unknown", detail: manifest.locallyProven.join("; ") || "not run" },
    { id: "live_model", label: "Live model", status: live("live_model"), detail: "Only a recorded Work verdict passes this." },
    { id: "commerce", label: "Commerce gate", status: proven("commerce") === "pass" && live("commerce") === "pass" ? "pass" : proven("commerce"), detail: "Deterministic proof + live proof required" },
    { id: "tenant", label: "Tenant gate", status: proven("tenant"), detail: "Isolation proofs" },
    { id: "owner", label: "Owner gate", status: proven("owner"), detail: "Owner product proofs" },
    { id: "blockers", label: "Unresolved High / P0", status: manifest.knownBlockers.length ? "fail" : "pass", detail: manifest.knownBlockers.join("; ") || "none" },
  ];
}

export async function loadWorkVerdicts(): Promise<WorkVerdict[]> {
  const records = await getBackend().listOperatorRecords(FLEET_SCOPE, "release");
  return records.map((r) => r.data as unknown as WorkVerdict).filter((v) => v && typeof v.sha === "string").sort((a, b) => b.at.localeCompare(a.at));
}

export async function recordWorkVerdict(v: Omit<WorkVerdict, "at"> & { at?: string }): Promise<WorkVerdict> {
  const verdict: WorkVerdict = { ...v, at: v.at ?? new Date().toISOString() };
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "release", key: verdict.sha, data: verdict });
  return verdict;
}

export async function currentRelease(): Promise<ReleaseState> {
  const sha = runtimeCommit();
  const manifest = ACCEPTANCE_MANIFEST;
  const verdicts = await loadWorkVerdicts().catch(() => [] as WorkVerdict[]);
  const verdict = (sha ? verdicts.find((v) => v.sha === sha) : undefined) ?? verdicts[0] ?? null;
  const preview = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const state = releaseState(manifest, verdict, sha);
  return {
    state,
    sha,
    preview,
    environment: environmentLabel(),
    manifest,
    verdict,
    gates: releaseGates(manifest, verdict, sha),
    nextProofRequired: state === "LIVE_PASSED" ? [] : manifest.liveProofRequired.map((c) => c.title),
  };
}
