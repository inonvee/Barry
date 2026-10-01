import { z } from "zod";
import { validateSourceUrl } from "@/lib/learn-business/safe-fetch";
import { validateHttpManifest, type HttpManifest } from "./http-manifest";

/**
 * GENERIC TRANSPORT BOUNDARIES — the ways BARRY may reach a system, each a declared, validated shape:
 * REST/OpenAPI (the executable HTTP manifest), GraphQL (declared operations only), OAuth / API-key
 * auth references (names, never values), webhook / event subscriptions, explicitly configured
 * READ-ONLY database views, owner-approved files / documents, and email / messaging providers.
 * Only the HTTP manifest executes today; the others validate and declare what would be needed.
 * No arbitrary URLs (private hosts are refused), no arbitrary SQL (named views only).
 */

const CREDENTIAL = /^[A-Z][A-Z0-9_]{1,63}$/;

export const TransportSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rest_openapi"), manifest: z.unknown() }),
  z.object({ type: z.literal("graphql"), endpoint: z.string().max(500), auth: z.object({ kind: z.enum(["api_key", "oauth_bearer", "none"]), credential: z.string().regex(CREDENTIAL).optional() }), operations: z.array(z.object({ capability: z.string().min(3).max(120), query: z.string().min(5).max(4000), variables: z.record(z.string().max(64), z.string().max(64)).default({}), effect: z.enum(["read", "consequential"]) })).min(1).max(50) }),
  z.object({ type: z.literal("webhook_event"), events: z.array(z.object({ event: z.string().min(1).max(120), capability: z.string().min(3).max(120) })).min(1).max(50), signature: z.object({ header: z.string().min(1).max(64), credential: z.string().regex(CREDENTIAL) }) }),
  z.object({ type: z.literal("db_readonly"), dsnCredential: z.string().regex(CREDENTIAL), views: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), capability: z.string().min(3).max(120), columns: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).min(1).max(100) })).min(1).max(50) }),
  z.object({ type: z.literal("file_document"), sourceId: z.string().min(1).max(200), format: z.enum(["csv", "json", "pdf", "text"]), capability: z.string().min(3).max(120) }),
  z.object({ type: z.literal("email_messaging"), provider: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), credential: z.string().regex(CREDENTIAL), direction: z.enum(["inbound", "outbound", "both"]) }),
]);
export type TransportSpec = z.infer<typeof TransportSpecSchema>;

export type TransportValidation = { ok: boolean; problems: string[]; executable: boolean; requiredCredentials: string[]; manifest?: HttpManifest };

function safeEndpoint(url: string, problems: string[]): void {
  try {
    const u = validateSourceUrl(url);
    if (u.protocol !== "https:") problems.push("endpoint must use https");
  } catch (err) {
    problems.push(`endpoint refused: ${(err as Error).message}`);
  }
}

/** Deterministic validation; says whether BARRY can EXECUTE through it today (only the HTTP manifest). */
export function validateTransport(raw: unknown): TransportValidation {
  const parsed = TransportSpecSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "transport"}: ${i.message}`), executable: false, requiredCredentials: [] };
  const spec = parsed.data;
  const problems: string[] = [];
  const creds = new Set<string>();
  switch (spec.type) {
    case "rest_openapi": {
      const v = validateHttpManifest(spec.manifest);
      for (const p of v.problems) problems.push(`${p.operation ? `${p.operation}: ` : ""}${p.problem}`);
      if (v.manifest?.auth.type !== "none" && v.manifest?.auth) creds.add(v.manifest.auth.credential);
      return { ok: problems.length === 0, problems, executable: problems.length === 0, requiredCredentials: [...creds], ...(v.manifest ? { manifest: v.manifest } : {}) };
    }
    case "graphql":
      safeEndpoint(spec.endpoint, problems);
      if (spec.auth.kind !== "none" && !spec.auth.credential) problems.push("auth needs a credential name");
      if (spec.auth.credential) creds.add(spec.auth.credential);
      for (const op of spec.operations) {
        if (/\bmutation\b/i.test(op.query) && op.effect === "read") problems.push(`${op.capability}: a mutation cannot be declared as a read`);
        if (!/\b(query|mutation)\b/i.test(op.query)) problems.push(`${op.capability}: not a GraphQL operation`);
      }
      return { ok: problems.length === 0, problems, executable: false, requiredCredentials: [...creds] };
    case "webhook_event":
      creds.add(spec.signature.credential);
      return { ok: true, problems, executable: false, requiredCredentials: [...creds] };
    case "db_readonly":
      creds.add(spec.dsnCredential);
      for (const v of spec.views) if (/\b(select|insert|update|delete|drop|;)\b/i.test(v.name)) problems.push(`${v.name}: not a view name`);
      return { ok: problems.length === 0, problems, executable: false, requiredCredentials: [...creds] };
    case "file_document":
      return { ok: true, problems, executable: false, requiredCredentials: [] };
    case "email_messaging":
      creds.add(spec.credential);
      return { ok: true, problems, executable: false, requiredCredentials: [...creds] };
  }
}
