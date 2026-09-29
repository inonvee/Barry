import type { HttpRequest, HttpResponse, HttpTransport } from "@/lib/fabric/connectors/http";
import type { FaultKind } from "@/lib/fabric/conformance";

/**
 * An in-process stand-in for an external business system reached over
 * HTTP/JSON. Test-only: routes are "METHOD /path/{param}" patterns; writes
 * are idempotent per Idempotency-Key like a well-behaved API (unless told
 * not to be); faults can be injected for conformance checks.
 */

export type Route = (req: { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown>; headers: Record<string, string> }) => { status?: number; json: unknown };

export type MockSystem = {
  transport: HttpTransport;
  calls: HttpRequest[];
  fault: FaultKind | undefined;
  injectFault(kind: FaultKind): () => void;
};

export function createMockHttpSystem(origin: string, routes: Record<string, Route>, options: { idempotent?: boolean; requireAuth?: { header: string; value: string } } = {}): MockSystem {
  const byKey = new Map<string, HttpResponse>();
  const system: MockSystem = {
    calls: [],
    fault: undefined,
    injectFault(kind) {
      system.fault = kind;
      return () => {
        system.fault = undefined;
      };
    },
    transport: async (req) => {
      system.calls.push(req);
      if (req.url.origin !== origin) return { status: 404, body: "{}" };
      if (system.fault === "server_error") return { status: 500, body: '{"error":"boom"}' };
      if (system.fault === "unauthorized") return { status: 401, body: '{"error":"no"}' };
      if (options.requireAuth && req.headers[options.requireAuth.header] !== options.requireAuth.value) return { status: 401, body: '{"error":"bad credentials"}' };
      if (system.fault === "unconfirmed") return { status: 202, body: "{}" };

      const key = req.headers["idempotency-key"];
      if (key && options.idempotent !== false && byKey.has(`${req.method} ${key}`)) return byKey.get(`${req.method} ${key}`)!;

      for (const [pattern, route] of Object.entries(routes)) {
        const [method, path] = pattern.split(" ");
        if (method !== req.method) continue;
        const names: string[] = [];
        const re = new RegExp(`^${path.replace(/\{([^}]+)\}/g, (_m, n: string) => (names.push(n), "([^/]+)"))}$`);
        const m = req.url.pathname.match(re);
        if (!m) continue;
        const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const out = route({ params, query: req.url.searchParams, body: req.body ? JSON.parse(req.body) : {}, headers: req.headers });
        const res = { status: out.status ?? 200, body: JSON.stringify(out.json) };
        if (key) byKey.set(`${req.method} ${key}`, res);
        return res;
      }
      return { status: 404, body: '{"error":"not found"}' };
    },
  };
  return system;
}
