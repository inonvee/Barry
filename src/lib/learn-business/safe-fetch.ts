import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Bounded, SSRF-safe fetch for OWNER-APPROVED business sources.
 *
 * - http/https only, default ports only, no credentials in the URL.
 * - Every hostname is resolved and EVERY resolved address must be public
 *   (no loopback, private, link-local, CGNAT, multicast, documentation,
 *   IPv4-mapped/NAT64/6to4 tunnelling of those). The same check runs again
 *   inside the socket's own DNS lookup, so a DNS answer that changes
 *   between the check and the connect (rebinding) is still refused.
 * - Redirects are followed manually (at most `maxRedirects`), and each hop
 *   is re-validated from scratch.
 * - Overall timeout, response-size cap, and a content-type allow-list.
 * - Nothing fetched is ever executed or interpreted as instructions: the
 *   body is returned as inert text for parsing.
 */

export class UnsafeSourceError extends Error {}
export class SourceFetchError extends Error {}

export type SafeFetchLimits = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
};

export const DEFAULT_FETCH_LIMITS: SafeFetchLimits = { timeoutMs: 10_000, maxBytes: 1_000_000, maxRedirects: 3 };

export type ResolvedAddress = { address: string; family: number };
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type TransportResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  truncated: boolean;
};
/** Performs ONE request (no redirect following). Injectable for tests. */
export type SourceTransport = (url: URL, limits: { deadline: number; maxBytes: number }) => Promise<TransportResponse>;

export type FetchedSource = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  redirects: string[];
};

const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96], // IPv4-compatible (deprecated)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(prefix, bits, "ipv6");
}

/** True when an IP literal must never be contacted. Non-IPs are blocked too. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family === 6) return BLOCKED.check(address, "ipv6"); // BlockList maps ::ffff:a.b.c.d onto the IPv4 rules
  return true;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];

function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Static checks that need no network. Throws UnsafeSourceError. */
export function validateSourceUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new UnsafeSourceError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeSourceError("Unsupported source protocol");
  if (url.username || url.password) throw new UnsafeSourceError("Credentials in source URLs are not allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeSourceError("Only default web ports are allowed");
  const host = bareHostname(url);
  if (!host) throw new UnsafeSourceError("Missing host");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UnsafeSourceError("Private/internal source URLs are not allowed");
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeSourceError("Private/internal source URLs are not allowed");
  } else if (!host.includes(".")) {
    throw new UnsafeSourceError("Private/internal source URLs are not allowed");
  }
  url.hash = "";
  return url;
}

export const systemResolver: HostResolver = async (hostname) => {
  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return addresses.map((a) => ({ address: a.address, family: a.family }));
};

async function assertPublicHost(url: URL, resolve: HostResolver): Promise<void> {
  const host = bareHostname(url);
  if (net.isIP(host)) return; // literal already checked in validateSourceUrl
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new SourceFetchError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new SourceFetchError(`Could not resolve ${host}`);
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new UnsafeSourceError("Source resolves to a private/internal address");
  }
}

/** DNS lookup used by the socket itself — re-validates at connect time (anti-rebinding). */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return callback(Object.assign(new Error("Blocked private/internal address"), { code: "EBLOCKED" }), "", 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export const nodeTransport: SourceTransport = (url, limits) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const remaining = Math.max(1, limits.deadline - Date.now());
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as unknown as typeof dns.lookup,
        headers: {
          "user-agent": "BARRY-LearnBusiness/1.0 (owner-approved source fetch)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
          "accept-encoding": "identity",
        },
        timeout: remaining,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => {
          clearTimeout(timer);
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
        };
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > limits.maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - limits.maxBytes)));
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!truncated) finish();
        });
        res.on("error", (err) => {
          if (!truncated) reject(new SourceFetchError(err.message));
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new SourceFetchError("Source fetch timed out")), remaining);
    req.on("timeout", () => req.destroy(new SourceFetchError("Source fetch timed out")));
    req.on("error", (err) => {
      clearTimeout(timer);
      const blocked = (err as NodeJS.ErrnoException).code === "EBLOCKED";
      reject(blocked ? new UnsafeSourceError("Source resolves to a private/internal address") : new SourceFetchError(err.message));
    });
    req.end();
  });

const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/^"|"$/g, "") || "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

export async function safeFetchSource(
  rawUrl: string,
  options: { resolve?: HostResolver; transport?: SourceTransport; limits?: Partial<SafeFetchLimits> } = {}
): Promise<FetchedSource> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...options.limits };
  const resolve = options.resolve ?? systemResolver;
  const transport = options.transport ?? nodeTransport;
  const deadline = Date.now() + limits.timeoutMs;
  const redirects: string[] = [];

  let url = validateSourceUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    await assertPublicHost(url, resolve);
    if (Date.now() > deadline) throw new SourceFetchError("Source fetch timed out");
    const response = await transport(url, { deadline, maxBytes: limits.maxBytes });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (hop >= limits.maxRedirects) throw new SourceFetchError("Too many redirects");
      const next = validateSourceUrl(new URL(response.headers.location, url));
      redirects.push(next.toString());
      url = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new SourceFetchError(`Source returned HTTP ${response.status}`);

    const contentType = (response.headers["content-type"] ?? "").toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.some((type) => contentType.startsWith(type))) {
      throw new SourceFetchError(`Unsupported content type ${contentType || "(none)"}`);
    }
    return {
      requestedUrl: rawUrl,
      finalUrl: url.toString(),
      status: response.status,
      contentType,
      body: decodeBody(response.body, contentType),
      truncated: response.truncated,
      redirects,
    };
  }
}
