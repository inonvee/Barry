import http from "node:http";
import https from "node:https";
import type dns from "node:dns";
import { guardedLookup, validateSourceUrl } from "@/lib/learn-business/safe-fetch";
import { isProductionRuntime } from "@/lib/env";
import { getCapability } from "../capability";
import { HttpManifestSchema, readPointer, validateHttpManifest, type HttpManifest } from "../http-manifest";
import { registerConnectorFactory, type Connector } from "../registry";
import type { SystemDescriptor } from "../system";

/**
 * GENERIC HTTP/JSON CONNECTOR, driven entirely by a validated manifest
 * (see ../http-manifest.ts). This is how a system BARRY has never seen is
 * executed — no vendor code, no model in the loop:
 *
 * - the manifest is re-validated before every connector start;
 * - requests go only to the manifest's public https base URL; DNS is
 *   re-checked at connect time (no private networks, no rebinding);
 *   redirects are refused; responses are size- and time-bounded;
 * - input fields reach the request only through the declared mapping
 *   (URL-encoded in paths/queries, JSON in bodies);
 * - a consequential call carries BARRY's idempotency key and counts as done
 *   only if the response passes the manifest's success check;
 * - HTTP errors stay the system's errors; nothing is retried elsewhere.
 */

export type HttpRequest = { url: URL; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number };
export type HttpResponse = { status: number; body: string };
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

const MAX_RESPONSE_BYTES = 1_000_000;

export const safeHttpTransport: HttpTransport = (req) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const client = req.url.protocol === "https:" ? https : http;
    const r = client.request(
      req.url,
      { method: req.method, headers: req.headers, timeout: req.timeoutMs, lookup: guardedLookup as unknown as typeof dns.lookup },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            r.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    r.on("timeout", () => r.destroy(new Error("Request timed out")));
    r.on("error", reject);
    if (req.body) r.write(req.body);
    r.end();
  });

let transport: HttpTransport = safeHttpTransport;

/** Test-only: replace the network. */
export function setHttpTransportForTests(next: HttpTransport | undefined): void {
  transport = next ?? safeHttpTransport;
}

export class SystemError extends Error {}

function manifestOf(descriptor: SystemDescriptor): HttpManifest | undefined {
  if (descriptor.transport.type === "http") return descriptor.transport.manifest;
  const parsed = HttpManifestSchema.safeParse(descriptor.config.manifest);
  return parsed.success ? parsed.data : undefined;
}

function allowInsecure(descriptor: SystemDescriptor): boolean {
  return !isProductionRuntime() && descriptor.config.allowInsecureHttp === true;
}

function httpConnector(descriptor: SystemDescriptor, manifest: HttpManifest, secret: string | undefined): Connector {
  const name = descriptor.system.name;
  return {
    systemKey: descriptor.system.key,
    async capabilities() {
      return manifest.operations.map((o) => o.capability);
    },
    async execute(capability, input) {
      const op = manifest.operations.find((o) => o.capability === capability);
      if (!op) throw new SystemError(`${name} has no operation for ${capability}`);
      const contract = getCapability(capability);
      if (!contract) throw new SystemError(`Unknown capability ${capability}`);

      const path = op.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, field: string) => {
        const value = input[field];
        if (value === undefined || value === null || value === "") throw new SystemError(`Missing value for {${field}}`);
        return encodeURIComponent(String(value));
      });
      const base = validateSourceUrl(manifest.baseUrl);
      const url = new URL(base.pathname.replace(/\/$/, "") + path, base.origin);
      if (url.origin !== base.origin) throw new SystemError("Operation path escaped the system's base URL");
      for (const [param, field] of Object.entries(op.query ?? {})) {
        if (input[field] !== undefined) url.searchParams.set(param, String(input[field]));
      }

      const headers: Record<string, string> = { accept: "application/json", "user-agent": "BARRY-Connector/1.0" };
      if (manifest.auth.type !== "none") {
        if (!secret) throw new SystemError(`${name} credentials are not configured`);
        if (manifest.auth.type === "bearer") headers.authorization = `Bearer ${secret}`;
        else headers[manifest.auth.header.toLowerCase()] = secret;
      }
      if (op.idempotencyHeader && typeof input.idempotencyKey === "string") headers[op.idempotencyHeader.toLowerCase()] = input.idempotencyKey;
      let body: string | undefined;
      if (op.body) {
        const payload: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(op.body)) if (input[field] !== undefined) payload[key] = input[field];
        body = JSON.stringify(payload);
        headers["content-type"] = "application/json";
      }

      const res = await transport({ url, method: op.method, headers, body, timeoutMs: manifest.timeoutMs ?? 10_000, maxBytes: MAX_RESPONSE_BYTES });
      if (res.status >= 300 && res.status < 400) throw new SystemError(`${name} redirected (${res.status}); redirects are not followed`);
      if (res.status === 401 || res.status === 403) throw new SystemError(`${name} rejected BARRY's authorization (${res.status})`);
      if (res.status >= 400) throw new SystemError(`${name} returned ${res.status}`);
      let doc: unknown;
      try {
        doc = res.body ? JSON.parse(res.body) : {};
      } catch {
        throw new SystemError(`${name} did not return JSON`);
      }

      const output: Record<string, unknown> = {};
      for (const [field, pointer] of Object.entries(op.response.map)) {
        const value = readPointer(doc, pointer);
        if (value !== undefined) output[field] = value;
      }
      if (contract.effect === "consequential" && op.response.success) {
        // Only the system's own confirmation makes this a success.
        if (readPointer(doc, op.response.success.pointer) === op.response.success.equals) output.verified = true;
      }
      return output;
    },
  };
}

registerConnectorFactory({
  key: "http-manifest",
  name: "HTTP/JSON system",
  kind: "custom",
  simulated: false,
  credentials: (descriptor) => {
    const manifest = manifestOf(descriptor);
    if (!manifest || manifest.auth.type === "none") return undefined;
    return { envPrefix: descriptor.system.key, keys: [{ key: manifest.auth.credential, field: "secret", required: true }] };
  },
  potentialCapabilities: (descriptor) => manifestOf(descriptor)?.operations.map((o) => o.capability) ?? [],
  setupGaps(config, missing) {
    const { problems } = validateHttpManifest(config.manifest, { allowInsecureHttp: !isProductionRuntime() && config.allowInsecureHttp === true });
    return [...missing, ...problems.map((p) => `manifest: ${p.operation ? `${p.operation}: ` : ""}${p.problem}`)];
  },
  create(descriptor, credentials) {
    const { manifest, problems } = validateHttpManifest(descriptor.config.manifest, { allowInsecureHttp: allowInsecure(descriptor) });
    if (!manifest || problems.length) throw new SystemError(`${descriptor.system.name} manifest is not valid`);
    return httpConnector(descriptor, manifest, credentials.secret);
  },
});
