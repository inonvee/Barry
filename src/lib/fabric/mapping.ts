import { getCapability, listCapabilities, type CapabilityId } from "./capability";
import { validateHttpManifest, type HttpManifest, type HttpOperation } from "./http-manifest";
import type { ConformanceReport } from "./conformance";
import type { CapabilityMapping, MappingStatus } from "./system";
import { UnsafeSourceError, validateSourceUrl } from "@/lib/learn-business/safe-fetch";

/**
 * MODEL-ASSISTED CAPABILITY MAPPING — proposals, never authority.
 *
 * From owner-approved evidence (an API description, docs, connection
 * metadata, owner answers) BARRY PROPOSES how a system's operations map to
 * capabilities. Four kinds of statement are kept apart:
 *
 *   FACT            the evidence itself declares it (e.g. the API document
 *                   tags an operation with a BARRY capability id)
 *   INFERENCE       BARRY (heuristics or a model) thinks it matches
 *   RECOMMENDATION  what BARRY suggests the owner connect or provide
 *   EXECUTABLE      a mapping whose manifest validated, whose conformance
 *                   suite passed and which the owner activated — the only
 *                   thing the runtime executes
 *
 * Proposals are data. `advanceMapping` is the only way up the lifecycle
 * (proposed -> validated -> conformance_passed -> active) and each step
 * checks its own deterministic evidence; confidence never skips a step.
 */

// ── Untrusted API description import ─────────────────────────────────────

export type ApiOperation = {
  ref: string; // "POST /shipments"
  method: HttpOperation["method"];
  path: string;
  operationId?: string;
  summary?: string;
  /** A capability id the document itself declares via `x-barry-capability`. */
  declaredCapability?: string;
  pathParams: string[];
  queryParams: string[];
  bodyFields: string[];
  responseFields: string[];
  /** `x-barry-success` declared by the document: the response value proving a write happened. */
  declaredSuccess?: { pointer: string; equals: string | number | boolean };
};

export type ApiImport = { baseUrl?: string; title?: string; operations: ApiOperation[]; problems: string[] };

const MAX_DOC_BYTES = 512_000;
const MAX_OPERATIONS = 300;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const propNames = (schema: unknown): string[] => Object.keys(obj(obj(schema)?.properties) ?? {}).filter((k) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)).slice(0, 100);

/**
 * Reads an OpenAPI 3.x document as UNTRUSTED DATA: bounded size and count,
 * only the structural facts BARRY needs, no $ref resolution, no fetching,
 * nothing interpreted as instructions.
 */
export function importOpenApi(raw: unknown): ApiImport {
  const problems: string[] = [];
  let doc: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_DOC_BYTES) return { operations: [], problems: ["document too large"] };
    try {
      doc = JSON.parse(raw);
    } catch {
      return { operations: [], problems: ["document is not JSON"] };
    }
  } else if (JSON.stringify(raw ?? null).length > MAX_DOC_BYTES) {
    return { operations: [], problems: ["document too large"] };
  }
  const root = obj(doc);
  if (!root || !/^3\./.test(str(root.openapi) ?? "")) return { operations: [], problems: ["not an OpenAPI 3.x document"] };

  let baseUrl: string | undefined;
  const server = str(obj((root.servers as unknown[] | undefined)?.[0])?.url, 500);
  if (server) {
    try {
      validateSourceUrl(server);
      baseUrl = server;
    } catch (err) {
      problems.push(`server URL rejected: ${err instanceof UnsafeSourceError ? err.message : "invalid"}`);
    }
  } else problems.push("no server URL");

  const operations: ApiOperation[] = [];
  for (const [path, item] of Object.entries(obj(root.paths) ?? {})) {
    if (!path.startsWith("/") || path.length > 300) continue;
    for (const m of METHODS) {
      const op = obj(obj(item)?.[m]);
      if (!op) continue;
      if (operations.length >= MAX_OPERATIONS) {
        problems.push("too many operations; the rest were ignored");
        break;
      }
      const params = Array.isArray(op.parameters) ? op.parameters.map(obj).filter(Boolean) as Record<string, unknown>[] : [];
      const body = obj(obj(obj(obj(op.requestBody)?.content)?.["application/json"])?.schema);
      const responses = obj(op.responses) ?? {};
      const okResponse = obj(responses["200"]) ?? obj(responses["201"]);
      const responseSchema = obj(obj(obj(okResponse?.content)?.["application/json"])?.schema);
      const declared = str(op["x-barry-capability"], 100);
      const success = obj(op["x-barry-success"]);
      operations.push({
        ref: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase() as ApiOperation["method"],
        path,
        operationId: str(op.operationId, 100),
        summary: str(op.summary, 300),
        ...(declared ? { declaredCapability: declared } : {}),
        pathParams: [...path.matchAll(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g)].map((x) => x[1]),
        queryParams: params.filter((p) => p.in === "query").map((p) => str(p.name, 64)).filter((n): n is string => !!n),
        bodyFields: propNames(body),
        responseFields: propNames(responseSchema),
        ...(success && typeof success.pointer === "string" && ["string", "number", "boolean"].includes(typeof success.equals)
          ? { declaredSuccess: { pointer: success.pointer, equals: success.equals as string | number | boolean } }
          : {}),
      });
    }
  }
  return { baseUrl, title: str(obj(root.info)?.title, 200), operations, problems };
}

// ── Proposals ────────────────────────────────────────────────────────────

export type Classification = "fact" | "inference" | "recommendation";

export type CapabilityMappingProposal = {
  capability: CapabilityId;
  operationRef: string;
  classification: Exclude<Classification, "recommendation">;
  confidence: "low" | "medium" | "high";
  evidence: string;
  /** What is still unknown before this can even validate (unmapped fields, missing success check). */
  missing: string[];
};

export type Recommendation = { classification: "recommendation"; text: string };

export type MapperInput = {
  operations: ApiOperation[];
  capabilities: { id: CapabilityId; purpose: string; effect: string }[];
};

/** Proposes (capability, operation) pairs. Implementations may use a model; their output is re-validated. */
export interface CapabilityMapper {
  readonly name: string;
  propose(input: MapperInput): Promise<{ capability: string; operationRef: string; confidence: "low" | "medium" | "high"; rationale: string }[]>;
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Deterministic mapper: document-declared capabilities, else token overlap between capability id and operation. */
export const heuristicMapper: CapabilityMapper = {
  name: "heuristic",
  async propose({ operations, capabilities }) {
    const out: Awaited<ReturnType<CapabilityMapper["propose"]>> = [];
    for (const c of capabilities) {
      const want = tokens(c.id.split(".").slice(1).join(" "));
      let best: { op: ApiOperation; score: number } | undefined;
      for (const op of operations) {
        if (c.effect === "consequential" && op.method === "GET") continue;
        if (c.effect === "read" && op.method !== "GET") continue;
        const have = new Set(tokens(`${op.operationId ?? ""} ${op.path} ${op.summary ?? ""}`).map((t) => t.replace(/s$/, "")));
        const score = want.filter((t) => have.has(t.replace(/s$/, ""))).length / Math.max(1, want.length);
        if (score > 0 && (!best || score > best.score)) best = { op, score };
      }
      if (best && best.score >= 0.5) out.push({ capability: c.id, operationRef: best.op.ref, confidence: best.score === 1 ? "medium" : "low", rationale: `name overlap ${Math.round(best.score * 100)}%` });
    }
    return out;
  },
};

/**
 * Turns an import into proposals. Document-declared mappings are FACTS;
 * everything a mapper suggests is INFERENCE — re-validated here so a mapper
 * (or a model behind it) can only choose among capabilities that exist and
 * operations the document really has.
 */
export async function proposeMappings(api: ApiImport, domains: string[], mapper: CapabilityMapper = heuristicMapper): Promise<{ proposals: CapabilityMappingProposal[]; recommendations: Recommendation[] }> {
  const capabilities = domains.flatMap((d) => listCapabilities(d)).map((c) => ({ id: c.id, purpose: c.purpose, effect: c.effect }));
  const byRef = new Map(api.operations.map((o) => [o.ref, o]));
  const proposals: CapabilityMappingProposal[] = [];
  const taken = new Set<string>();

  for (const op of api.operations) {
    if (op.declaredCapability && getCapability(op.declaredCapability) && capabilities.some((c) => c.id === op.declaredCapability)) {
      proposals.push({ capability: op.declaredCapability, operationRef: op.ref, classification: "fact", confidence: "high", evidence: `The API document tags ${op.ref} with x-barry-capability "${op.declaredCapability}".`, missing: [] });
      taken.add(op.declaredCapability);
    }
  }
  const suggested = await mapper.propose({ operations: api.operations, capabilities: capabilities.filter((c) => !taken.has(c.id)) }).catch(() => []);
  for (const s of suggested) {
    if (taken.has(s.capability) || !capabilities.some((c) => c.id === s.capability) || !byRef.has(s.operationRef)) continue;
    taken.add(s.capability);
    proposals.push({
      capability: s.capability,
      operationRef: s.operationRef,
      classification: "inference",
      confidence: s.confidence === "high" ? "medium" : s.confidence, // an inference is never high-confidence
      evidence: `${mapper.name}: ${String(s.rationale).slice(0, 300)}`,
      missing: [],
    });
  }

  const recommendations: Recommendation[] = [];
  if (!api.baseUrl) recommendations.push({ classification: "recommendation", text: "Provide the system's public https API address." });
  for (const c of capabilities) {
    if (!taken.has(c.id)) recommendations.push({ classification: "recommendation", text: `No operation found for ${c.id}; ask the owner whether the system can do this.` });
  }
  return { proposals, recommendations };
}

/**
 * Drafts a manifest from proposals: fields are wired only where names match
 * exactly; anything else is listed as missing for the owner to supply.
 * A draft is never executable by itself — it must validate, pass
 * conformance and be activated.
 */
export function draftManifest(api: ApiImport, proposals: CapabilityMappingProposal[], auth: HttpManifest["auth"]): { manifest: HttpManifest; missing: Record<string, string[]> } {
  const missing: Record<string, string[]> = {};
  const operations: HttpOperation[] = [];
  for (const p of proposals) {
    const op = api.operations.find((o) => o.ref === p.operationRef);
    const contract = getCapability(p.capability);
    if (!op || !contract) continue;
    const gaps: string[] = [];
    const inShape = Object.keys((contract.input as unknown as { shape?: Record<string, unknown> }).shape ?? {});
    const outShape = Object.keys((contract.output as unknown as { shape?: Record<string, unknown> }).shape ?? {});
    for (const param of op.pathParams) if (!inShape.includes(param)) gaps.push(`path parameter {${param}} has no matching input field`);
    const query: Record<string, string> = {};
    for (const q of op.queryParams) if (inShape.includes(q)) query[q] = q;
    const body: Record<string, string> = {};
    for (const f of op.bodyFields) if (inShape.includes(f)) body[f] = f;
    const map: Record<string, string> = {};
    for (const f of outShape) {
      if (f === "verified") continue;
      if (op.responseFields.includes(f)) map[f] = `/${f}`;
    }
    const consequential = contract.effect === "consequential";
    if (consequential && !op.declaredSuccess) gaps.push("no success check: which response value proves the system did it?");
    operations.push({
      capability: p.capability,
      method: op.method,
      path: op.path,
      ...(Object.keys(query).length ? { query } : {}),
      ...(Object.keys(body).length ? { body } : {}),
      response: { map, ...(consequential && op.declaredSuccess ? { success: op.declaredSuccess } : {}) },
      ...(consequential ? { idempotencyHeader: "Idempotency-Key" } : {}),
    });
    missing[p.capability] = gaps;
  }
  const manifest: HttpManifest = { manifestVersion: 1, baseUrl: api.baseUrl ?? "", auth, operations };
  const { problems } = validateHttpManifest(manifest);
  for (const pr of problems) {
    const cap = operations.find((o) => pr.operation?.includes(`(${o.capability})`))?.capability ?? "_manifest";
    (missing[cap] ??= []).push(pr.problem);
  }
  return { manifest, missing };
}

// ── Lifecycle: the only way a mapping becomes executable ─────────────────

export type MappingTransition =
  | { to: "validated"; manifest: unknown }
  | { to: "conformance_passed"; report: ConformanceReport }
  | { to: "active"; approvedBy: string }
  | { to: "disabled"; reason: string };

const ORDER: MappingStatus[] = ["proposed", "validated", "conformance_passed", "active"];

export class MappingTransitionError extends Error {}

/**
 * Advances ONE capability mapping by exactly one deterministic step:
 *   proposed -> validated           the manifest operation validates with no problems
 *   validated -> conformance_passed a passing conformance report for this capability
 *   conformance_passed -> active    an owner activation (who, when)
 * Any mapping can be disabled at any time. Nothing else is accepted.
 */
export function advanceMapping(mapping: CapabilityMapping, transition: MappingTransition, now = new Date().toISOString()): CapabilityMapping {
  if (transition.to === "disabled") return { ...mapping, status: "disabled" };
  const from = ORDER.indexOf(mapping.status);
  const to = ORDER.indexOf(transition.to);
  if (from < 0 || to !== from + 1) throw new MappingTransitionError(`${mapping.id}: cannot go from ${mapping.status} to ${transition.to}`);

  if (transition.to === "validated") {
    const { manifest, problems } = validateHttpManifest(transition.manifest);
    const own = problems.filter((p) => !p.operation || p.operation.includes(`(${mapping.id})`));
    if (!manifest || own.length) throw new MappingTransitionError(`${mapping.id}: manifest does not validate — ${own.map((p) => p.problem).join("; ")}`);
    if (!manifest.operations.some((o) => o.capability === mapping.id)) throw new MappingTransitionError(`${mapping.id}: manifest has no operation for it`);
    return { ...mapping, status: "validated" };
  }
  if (transition.to === "conformance_passed") {
    if (transition.report.capability !== mapping.id || !transition.report.passed) throw new MappingTransitionError(`${mapping.id}: conformance has not passed`);
    return { ...mapping, status: "conformance_passed", conformance: { passedAt: transition.report.ranAt, suite: transition.report.suite } };
  }
  if (!transition.approvedBy.trim()) throw new MappingTransitionError(`${mapping.id}: activation needs the approving owner`);
  return {
    ...mapping,
    status: "active",
    verifiedAt: now,
    provenance: mapping.provenance.source === "learned" ? mapping.provenance : { source: "owner_manifest", approvedBy: transition.approvedBy, approvedAt: now },
  };
}

/** Stored-state shape of a mapping (what goes into a connection's config.mappings). */
export function storedMapping(m: CapabilityMapping) {
  return { status: m.status, provenance: m.provenance, version: m.version, ...(m.verifiedAt ? { verifiedAt: m.verifiedAt } : {}), ...(m.conformance ? { conformance: m.conformance } : {}) };
}
