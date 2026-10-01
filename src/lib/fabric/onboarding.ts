import { importOpenApi, proposeMappings, draftManifest, advanceMapping, storedMapping, type CapabilityMapper, heuristicMapper } from "./mapping";
import { validateHttpManifest, manifestCredentialNames, type HttpManifest } from "./http-manifest";
import { describeCredentials } from "./registry";
import type { CapabilityMapping } from "./system";
import type { ConformanceReport } from "./conformance";

/**
 * UNKNOWN-SYSTEM ONBOARDING — approved docs/schema → proposed capability map → auth / config gaps →
 * deterministic validation → (conformance) → owner / founder approval → activation of PROVEN
 * capabilities only. The model (mapper) may infer; it can never activate.
 */

export type OnboardingProposal = {
  systemKey: string;
  name: string;
  domain: string;
  manifest: HttpManifest | null;
  problems: string[];
  mappings: CapabilityMapping[];
  gaps: { credentials: string[]; unmappedInputs: Record<string, string[]>; recommendations: string[] };
  status: "proposed" | "validated" | "blocked";
};

export async function proposeOnboarding(input: { systemKey: string; name: string; domain: string; domains?: string[]; openapi: unknown; auth: HttpManifest["auth"]; mapper?: CapabilityMapper; now?: Date }): Promise<OnboardingProposal> {
  const api = importOpenApi(input.openapi);
  const { proposals, recommendations } = await proposeMappings(api, input.domains ?? [input.domain], input.mapper ?? heuristicMapper);
  const { manifest, missing } = draftManifest(api, proposals, input.auth);
  const validation = validateHttpManifest(manifest);
  const at = (input.now ?? new Date()).toISOString();
  const mappings: CapabilityMapping[] = proposals.map((p) => ({ id: p.capability, version: "1.0.0", status: "proposed", provenance: p.classification === "fact" ? { source: "owner_manifest" } : { source: "learned", evidence: p.evidence, confidence: p.confidence, proposedAt: at }, ownerVerificationRequired: true }));
  const credentials = validation.manifest ? manifestCredentialNames(validation.manifest) : [];
  const credentialGaps = describeCredentials(`env:${input.systemKey}`, undefined).filter((c) => c.required && !c.present).map((c) => c.envVar);
  const problems = [...api.problems, ...validation.problems.map((p) => `${p.operation ? `${p.operation}: ` : ""}${p.problem}`)];
  return {
    systemKey: input.systemKey,
    name: input.name,
    domain: input.domain,
    manifest: validation.manifest ?? null,
    problems,
    mappings: validation.manifest ? mappings.map((m) => ((missing[m.id] ?? []).length ? m : advanceMapping(m, { to: "validated", manifest: validation.manifest }, at))) : mappings,
    gaps: { credentials: [...new Set([...credentials, ...credentialGaps])], unmappedInputs: missing, recommendations: recommendations.map((r) => r.text) },
    status: problems.length ? "blocked" : proposals.length ? "validated" : "proposed",
  };
}

/** Activate ONLY capabilities whose conformance passed AND that an owner/founder approved by id. Everything else stays as it is. */
export function activateProven(proposal: OnboardingProposal, reports: ConformanceReport[], approvedBy: string, approvedCapabilities: string[], now = new Date()): { activated: CapabilityMapping[]; refused: { id: string; reason: string }[]; stored: Record<string, ReturnType<typeof storedMapping>> } {
  const at = now.toISOString();
  const activated: CapabilityMapping[] = [];
  const refused: { id: string; reason: string }[] = [];
  const stored: Record<string, ReturnType<typeof storedMapping>> = {};
  for (const m of proposal.mappings) {
    const report = reports.find((r) => r.capability === m.id);
    if (!approvedCapabilities.includes(m.id)) {
      refused.push({ id: m.id, reason: "not approved" });
      stored[m.id] = storedMapping(m);
      continue;
    }
    if (!report?.passed) {
      refused.push({ id: m.id, reason: report ? "conformance failed" : "no conformance report" });
      stored[m.id] = storedMapping(m);
      continue;
    }
    if (m.status !== "validated") {
      refused.push({ id: m.id, reason: `mapping is ${m.status}, not validated` });
      stored[m.id] = storedMapping(m);
      continue;
    }
    const passed = advanceMapping(m, { to: "conformance_passed", report }, at);
    const active = advanceMapping(passed, { to: "active", approvedBy }, at);
    activated.push({ ...active, provenance: active.provenance.source === "learned" ? active.provenance : { source: "owner_manifest", approvedBy, approvedAt: at } });
    stored[m.id] = storedMapping(active);
  }
  return { activated, refused, stored };
}
