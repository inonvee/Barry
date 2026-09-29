import { z } from "zod";
import { CAPABILITY_ID, getCapability, type CapabilityId } from "./capability";
import { UnsafeSourceError, validateSourceUrl } from "@/lib/learn-business/safe-fetch";

/**
 * DECLARATIVE HTTP CONNECTOR MANIFEST.
 *
 * How a system BARRY has never seen — the business's own API, a regional
 * tool — is mapped onto BARRY capabilities without writing an adapter:
 * each operation says which capability it implements, which method and
 * path, where input fields go, where output fields come from, and (for a
 * consequential operation) which idempotency header to send and which
 * response value proves success.
 *
 * A manifest is DATA and is treated as untrusted until validated here:
 * https base URL on a public host (no credentials, no private networks),
 * relative paths with named placeholders only, no header injection, every
 * contract output mapped, and every consequential operation idempotent and
 * provider-confirmed. The model never sees credentials and never issues
 * HTTP requests: it can at most PROPOSE a manifest (see ./mapping.ts).
 */

const POINTER = /^(\/[A-Za-z0-9_\-.~]*)*$/;
const INPUT_REF = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const CREDENTIAL = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_HEADERS = new Set(["authorization", "host", "cookie", "content-length", "transfer-encoding", "connection", "proxy-authorization"]);

export const HttpOperationSchema = z.object({
  capability: z.string().regex(CAPABILITY_ID),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Relative path; `{field}` placeholders are filled from input fields (URL-encoded). */
  path: z.string().min(1).max(300),
  /** query parameter -> input field */
  query: z.record(z.string().regex(/^[A-Za-z0-9_\-.]{1,64}$/), z.string().regex(INPUT_REF)).optional(),
  /** JSON body field -> input field */
  body: z.record(z.string().regex(/^[A-Za-z0-9_\-.]{1,64}$/), z.string().regex(INPUT_REF)).optional(),
  response: z.object({
    /** contract output field -> JSON pointer into the response body */
    map: z.record(z.string().regex(INPUT_REF), z.string().regex(POINTER)),
    /** For consequential operations: the response value that proves the system did it. */
    success: z.object({ pointer: z.string().regex(POINTER), equals: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
  }),
  /** Header that carries BARRY's idempotency key (required when the contract needs one). */
  idempotencyHeader: z.string().regex(HEADER).optional(),
});

export const HttpManifestSchema = z.object({
  manifestVersion: z.literal(1),
  baseUrl: z.string().max(500),
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("bearer"), credential: z.string().regex(CREDENTIAL) }),
    z.object({ type: z.literal("header"), header: z.string().regex(HEADER), credential: z.string().regex(CREDENTIAL) }),
  ]),
  operations: z.array(HttpOperationSchema).min(1).max(100),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
});

export type HttpOperation = z.infer<typeof HttpOperationSchema>;
export type HttpManifest = z.infer<typeof HttpManifestSchema>;

export type ManifestProblem = { operation?: string; problem: string };

function objectShape(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const s = schema as unknown as { shape?: Record<string, z.ZodType> };
  return s.shape && typeof s.shape === "object" ? s.shape : undefined;
}

function isOptional(schema: z.ZodType): boolean {
  return schema.safeParse(undefined).success;
}

/**
 * Deterministic validation. Returns every problem found — an empty list is
 * the ONLY way a manifest can become executable.
 */
export function validateHttpManifest(raw: unknown, options: { allowInsecureHttp?: boolean } = {}): { manifest?: HttpManifest; problems: ManifestProblem[] } {
  const parsed = HttpManifestSchema.safeParse(raw);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => ({ problem: `${i.path.join(".") || "manifest"}: ${i.message}` })) };
  const manifest = parsed.data;
  const problems: ManifestProblem[] = [];

  try {
    const url = validateSourceUrl(manifest.baseUrl);
    if (url.protocol !== "https:" && !options.allowInsecureHttp) problems.push({ problem: "baseUrl must use https" });
    if (url.search) problems.push({ problem: "baseUrl must not carry a query string" });
  } catch (err) {
    problems.push({ problem: `baseUrl rejected: ${err instanceof UnsafeSourceError ? err.message : "invalid"}` });
  }
  if (manifest.auth.type === "header" && FORBIDDEN_HEADERS.has(manifest.auth.header.toLowerCase())) {
    problems.push({ problem: `auth header "${manifest.auth.header}" is not allowed` });
  }

  const seen = new Set<string>();
  for (const op of manifest.operations) {
    const where = `${op.method} ${op.path} (${op.capability})`;
    if (seen.has(op.capability)) problems.push({ operation: where, problem: "capability mapped twice in one manifest" });
    seen.add(op.capability);

    const contract = getCapability(op.capability);
    if (!contract) {
      problems.push({ operation: where, problem: `unknown capability "${op.capability}" — register its contract first` });
      continue;
    }
    if (!op.path.startsWith("/") || op.path.includes("..") || op.path.includes("//") || /[?#\\\s]|:\/\//.test(op.path)) {
      problems.push({ operation: where, problem: "path must be a clean relative path (no '..', '//', query, fragment, scheme)" });
    }
    const inputShape = objectShape(contract.input) ?? {};
    const placeholders = [...op.path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
    for (const p of placeholders) {
      if (!INPUT_REF.test(p) || !(p in inputShape)) problems.push({ operation: where, problem: `path placeholder {${p}} is not an input field of ${op.capability}` });
    }
    for (const ref of [...Object.values(op.query ?? {}), ...Object.values(op.body ?? {})]) {
      if (!(ref in inputShape)) problems.push({ operation: where, problem: `"${ref}" is not an input field of ${op.capability}` });
    }

    const outputShape = objectShape(contract.output) ?? {};
    for (const [field, schema] of Object.entries(outputShape)) {
      if (field === "verified") continue; // set by the connector from the success check, never mapped
      if (!(field in op.response.map) && !isOptional(schema)) problems.push({ operation: where, problem: `output field "${field}" is not mapped` });
    }
    for (const field of Object.keys(op.response.map)) {
      if (!(field in outputShape)) problems.push({ operation: where, problem: `"${field}" is not an output field of ${op.capability}` });
      if (field === "verified") problems.push({ operation: where, problem: `"verified" cannot be mapped — it comes from the success check` });
    }

    if (contract.effect === "consequential") {
      if (op.method === "GET") problems.push({ operation: where, problem: "a consequential capability cannot be a GET" });
      if (contract.idempotency === "key_required" && !op.idempotencyHeader) problems.push({ operation: where, problem: "consequential operation needs an idempotency header" });
      if (contract.verification === "provider_confirmed" && !op.response.success) problems.push({ operation: where, problem: "consequential operation needs a success check proving the system did it" });
    }
    if (op.idempotencyHeader && FORBIDDEN_HEADERS.has(op.idempotencyHeader.toLowerCase())) {
      problems.push({ operation: where, problem: `header "${op.idempotencyHeader}" is not allowed` });
    }
  }
  return problems.length ? { manifest, problems } : { manifest, problems: [] };
}

/** The credential NAMES a manifest needs (for setup/readiness). */
export function manifestCredentialNames(manifest: HttpManifest): string[] {
  return manifest.auth.type === "none" ? [] : [manifest.auth.credential];
}

export function manifestCapabilities(manifest: HttpManifest): CapabilityId[] {
  return manifest.operations.map((o) => o.capability);
}

/** RFC 6901 JSON pointer read. */
export function readPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return doc;
  let cur: unknown = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
