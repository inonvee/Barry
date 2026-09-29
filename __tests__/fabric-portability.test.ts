import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import "@/lib/fixtures";
import { executeCapability } from "@/lib/fabric/executor";
import { manifestConnection, resolveCapability } from "@/lib/fabric/registry";
import type { HttpManifest } from "@/lib/fabric/http-manifest";
import { setHttpTransportForTests, type HttpTransport } from "@/lib/fabric/connectors/http";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { getBackend } from "@/lib/store";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { registerPaymentAdapterFactoryForTests } from "@/lib/payments/registry";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import type { BusinessGraph } from "@/lib/business-graph";
import { createMockHttpSystem } from "./support/mock-http-system";
import { courierManifest, courierSystem, helpdeskManifest, helpdeskSystem, parcelManifest, parcelSystem } from "./support/test-domains";
import { ScriptedReasoner } from "./support/semantic-corpus";

/**
 * PROOF OF PORTABILITY. BARRY's runtime contract is the same whatever
 * system implements a capability, whatever the business domain — and which
 * system is used is tenant state, not code.
 *
 * Honest scope: the "unfamiliar systems" here are in-process mocks reached
 * through the real manifest connector and executor (real validation, real
 * request building, real gating); no external system is contacted.
 */

const ENV = ["PARCEL_CO_API_KEY", "COURIER_TOKEN", "HELPDESK_API_KEY", "SHOPFRONT_API_KEY", "BARRY_REQUIRE_BUSINESS_CONNECTIONS"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setHttpTransportForTests(undefined);
  setReasonerForTests(undefined);
  registerPaymentAdapterFactoryForTests("stripe", undefined);
  registerPaymentAdapterFactoryForTests("payplus", undefined);
});

let n = 0;
const biz = (label: string) => `port-${label}-${Date.now()}-${n++}`;
const allow = () => ({ status: "allowed" as const, reason: "test policy allows" });

function route(...transports: HttpTransport[]): HttpTransport {
  return async (req) => {
    for (const t of transports) {
      const res = await t(req);
      if (res.status !== 404) return res;
    }
    return { status: 404, body: "{}" };
  };
}

async function connect(businessId: string, systemKey: string, domain: string, name: string, manifest: HttpManifest, credentialsRef = `env:${systemKey}`) {
  const mappings = Object.fromEntries(manifest.operations.map((o) => [o.capability, { status: "active" as const }]));
  return getBackend().upsertBusinessConnection(manifestConnection({ businessId, systemKey, domain, name, manifest, mappings, credentialsRef }));
}

// A commerce system BARRY has no adapter for: someone's own store API, described by a manifest.
const SHOPFRONT = "https://api.shopfront.example";
const shopfrontManifest: HttpManifest = {
  manifestVersion: 1,
  baseUrl: SHOPFRONT,
  auth: { type: "bearer", credential: "API_KEY" },
  operations: [{ capability: "commerce.catalog.search", method: "GET", path: "/catalog", query: { q: "text", under: "maxPrice" }, response: { map: { products: "/items" } } }],
};
const shopfront = createMockHttpSystem(
  SHOPFRONT,
  {
    "GET /catalog": ({ query }) => ({
      json: {
        items: [{ id: "sku-9", title: `Result for ${query.get("q")}`, variants: [{ id: "v1", options: { size: "M" }, price: { amount: 120, currency: "EUR" }, available: 3 }] }],
      },
    }),
  },
  { requireAuth: { header: "authorization", value: "Bearer shop-secret" } }
);

describe("A. the SAME capability, two different implementations, one runtime contract", () => {
  it("commerce.catalog.search via BARRY's first-party adapter and via an unfamiliar store API", async () => {
    process.env.SHOPFRONT_API_KEY = "shop-secret";
    setHttpTransportForTests(shopfront.transport);
    const custom = biz("shopfront");
    await connect(custom, "shopfront", "commerce", "Shopfront", shopfrontManifest);

    const a = await executeCapability({ businessId: "fashion-retailer" }, "commerce.catalog.search", { text: "slip" }, { authorize: allow });
    const b = await executeCapability({ businessId: custom }, "commerce.catalog.search", { text: "slip", maxPrice: 200 }, { authorize: allow });
    expect(a).toMatchObject({ ok: true, provenance: { connector: "commerce/memory", simulated: true } });
    expect(b).toMatchObject({ ok: true, provenance: { connector: "http-manifest", system: "shopfront", simulated: false } });
    // Same normalized shape from both.
    for (const r of [a, b]) {
      if (!r.ok) throw new Error("expected success");
      const products = r.output.products as { id: string; variants: { price: { amount: number }; available: number }[] }[];
      expect(products.length).toBeGreaterThan(0);
      expect(products[0].variants[0]).toEqual(expect.objectContaining({ price: expect.objectContaining({ amount: expect.any(Number) }), available: expect.any(Number) }));
    }
    expect(shopfront.calls.at(-1)!.url.search).toBe("?q=slip&under=200");
  });

  it("shipping.track via two unrelated carriers with different URL shapes and auth schemes", async () => {
    process.env.PARCEL_CO_API_KEY = "parcel-secret";
    process.env.COURIER_TOKEN = "courier-token";
    const parcel = parcelSystem();
    const courier = courierSystem();
    setHttpTransportForTests(route(parcel.transport, courier.transport));
    const b1 = biz("parcel");
    const b2 = biz("courier");
    await connect(b1, "parcel-co", "shipping", "Parcel Co", parcelManifest);
    await connect(b2, "courier", "shipping", "Courier", courierManifest);
    const r1 = await executeCapability({ businessId: b1 }, "shipping.track", { trackingNumber: "TRK-1" }, { authorize: allow });
    const r2 = await executeCapability({ businessId: b2 }, "shipping.track", { trackingNumber: "TRK-1" }, { authorize: allow });
    expect(r1).toMatchObject({ ok: true, output: { trackingNumber: "TRK-1", status: "in_transit" }, provenance: { system: "parcel-co" } });
    expect(r2).toMatchObject({ ok: true, output: { trackingNumber: "TRK-1", status: "out_for_delivery" }, provenance: { system: "courier" } });
    expect(courier.calls[0].headers["x-api-token"]).toBe("courier-token");
    expect(parcel.calls[0].headers.authorization).toBe("Bearer parcel-secret");
  });
});

describe("B + C. unfamiliar systems in materially different domains, through the same contract", () => {
  it("a helpdesk (support) and a carrier (shipping) — writes are authorized, idempotent and confirmed", async () => {
    process.env.HELPDESK_API_KEY = "desk-secret";
    process.env.PARCEL_CO_API_KEY = "parcel-secret";
    const desk = helpdeskSystem();
    const parcel = parcelSystem();
    setHttpTransportForTests(route(desk.transport, parcel.transport));
    const id = biz("multi-domain");
    await connect(id, "helpdesk", "support", "Helpdesk", helpdeskManifest);
    await connect(id, "parcel-co", "shipping", "Parcel Co", parcelManifest);

    const ticketInput = { subject: "Damaged parcel", body: "Box arrived crushed", customerRef: "cust-7", idempotencyKey: "tkt-000001" };
    const ticket = await executeCapability({ businessId: id }, "support.ticket.create", ticketInput, { authorize: allow });
    const again = await executeCapability({ businessId: id }, "support.ticket.create", ticketInput, { authorize: allow });
    const shipment = await executeCapability({ businessId: id }, "shipping.create_shipment", { orderRef: "ORD-5", address: "1 Harbour Road, Haifa", idempotencyKey: "shp-000001" }, { authorize: allow });
    expect(ticket).toMatchObject({ ok: true, output: { ticketId: "T-1", verified: true }, provenance: { system: "helpdesk" } });
    expect(again).toMatchObject({ ok: true, output: { ticketId: "T-1" } }); // same key -> same ticket
    expect(shipment).toMatchObject({ ok: true, output: { shipmentId: "shp_1", verified: true }, provenance: { system: "parcel-co" } });
    expect(JSON.parse(desk.calls[0].body!)).toEqual({ title: "Damaged parcel", description: "Box arrived crushed", requester: "cust-7" });
  });
});

describe("D. which system is used is tenant STATE, not code", () => {
  it("replacing a business's shipping system changes resolution — no code involved", async () => {
    process.env.PARCEL_CO_API_KEY = "parcel-secret";
    process.env.COURIER_TOKEN = "courier-token";
    setHttpTransportForTests(route(parcelSystem().transport, courierSystem().transport));
    const id = biz("switch");
    await connect(id, "parcel-co", "shipping", "Parcel Co", parcelManifest);
    expect(await executeCapability({ businessId: id }, "shipping.track", { trackingNumber: "TRK-2" }, { authorize: allow })).toMatchObject({ ok: true, provenance: { system: "parcel-co" } });
    await connect(id, "courier", "shipping", "Courier", courierManifest);
    expect(await executeCapability({ businessId: id }, "shipping.track", { trackingNumber: "TRK-2" }, { authorize: allow })).toMatchObject({ ok: true, provenance: { system: "courier" }, output: { status: "out_for_delivery" } });
    // The new system doesn't implement shipment creation: that capability is now simply unavailable.
    expect(await executeCapability({ businessId: id }, "shipping.create_shipment", { orderRef: "O-1", address: "1 Harbour Road", idempotencyKey: "shp-000002" }, { authorize: allow })).toMatchObject({ ok: false, code: "no_system" });
  });

  it("in a live conversation, the checkout's payment system follows the business's connection", async () => {
    const SEARCH = "עד 400 שקל M אני מחפשת שמלה מידה";
    const TAKE = "אני אקח את הראשונה ב-M";
    const script: Record<string, Partial<BarryIR>> = {
      [SEARCH]: { intent: "commerce_search", commerce: { intent: "search", query: { text: SEARCH, category: "dress", budget: { amount: 400 } }, variant: { size: "M" } } },
      [TAKE]: { intent: "commerce_select", purchaseDecision: true, commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } } },
    };
    const named = (name: string) => () => Object.defineProperty(new MemoryPaymentAdapter(), "name", { value: name });
    registerPaymentAdapterFactoryForTests("stripe", named("stripe"));
    registerPaymentAdapterFactoryForTests("payplus", named("payplus"));

    const id = biz("pay-switch");
    const shop = new MemoryCommerceAdapter(fashionCatalog());
    registerCommerceAdapterFactoryForTests(id, () => shop);
    const base = buildFashionRetailerGraph();
    const graph: BusinessGraph = { ...base, business: { ...base.business, id }, playbook: { ...base.playbook, commerce: { ...base.playbook.commerce, checkoutRequires: [] } } };
    const payments = (provider: string) =>
      getBackend().upsertBusinessConnection({ businessId: id, capability: "payments", provider, status: "connected", config: {}, credentialsRef: `env:${provider}`, permissions: [] });

    const checkoutProvider = async (conv: string) => {
      setReasonerForTests(new ScriptedReasoner(script));
      await handleCustomerMessage(graph, conv, `c-${conv}`, SEARCH);
      const out = await handleCustomerMessage(graph, conv, `c-${conv}`, TAKE);
      const step = out.turn.trace!.steps.find((s) => s.action === "createCommerceCheckout")!;
      expect(step.result, JSON.stringify(out.turn.trace)).toMatchObject({ ok: true });
      return step.capabilities.find((c) => c.capability === "payments.create_request")?.provider;
    };
    try {
      await payments("stripe");
      expect(await checkoutProvider(`${id}-1`)).toBe("stripe");
      await payments("payplus");
      expect(await checkoutProvider(`${id}-2`)).toBe("payplus");
    } finally {
      registerCommerceAdapterFactoryForTests(id, undefined);
    }
  });
});

describe("E. missing, errored or disconnected systems fail closed — in the fabric and in the conversation", () => {
  it("each broken state is a refusal with a reason, never another system or a simulator", async () => {
    process.env.PARCEL_CO_API_KEY = "parcel-secret";
    setHttpTransportForTests(parcelSystem().transport);
    const id = biz("broken");
    await connect(id, "parcel-co", "shipping", "Parcel Co", parcelManifest);
    const record = (await getBackend().getBusinessConnection(id, "shipping"))!;

    await getBackend().upsertBusinessConnection({ ...record, status: "error" });
    expect(await resolveCapability(id, "shipping.track")).toMatchObject({ ok: false, code: "system_unhealthy" });
    await getBackend().upsertBusinessConnection({ ...record, status: "disconnected" });
    expect(await resolveCapability(id, "shipping.track")).toMatchObject({ ok: false, code: "system_inactive" });
    await getBackend().upsertBusinessConnection({ ...record, config: { ...record.config, mappings: { "shipping.track": { status: "disabled" } } } });
    expect(await resolveCapability(id, "shipping.track")).toMatchObject({ ok: false, code: "mapping_not_active" });
  });

  it("a business whose commerce system is disconnected gets no fixture catalog and no checkout", async () => {
    const id = biz("commerce-down");
    await getBackend().upsertBusinessConnection({ businessId: id, capability: "commerce", provider: "custom-commerce", status: "disconnected", config: { baseUrl: "https://shop.example" }, credentialsRef: "env:custom-commerce", permissions: [] });
    const base = buildFashionRetailerGraph();
    const profiles = await resolveCapabilityProfiles({ ...base, business: { ...base.business, id } });
    expect(profiles.commerce).toMatchObject({ status: "not_configured", capabilities: [] });
    expect(await executeCapability({ businessId: id }, "commerce.catalog.search", { text: "x" }, { authorize: allow })).toMatchObject({ ok: false, code: "system_inactive" });
  });

  it("a generic-only system in a planner domain is not half-used by the typed conversation tools", async () => {
    process.env.SHOPFRONT_API_KEY = "shop-secret";
    const id = biz("generic-only");
    await connect(id, "shopfront", "commerce", "Shopfront", shopfrontManifest);
    const base = buildFashionRetailerGraph();
    const profiles = await resolveCapabilityProfiles({ ...base, business: { ...base.business, id } });
    expect(profiles.commerce.status).not.toBe("connected");
    expect(profiles.commerce.capabilities).toEqual([]);
  });
});

describe("the core runtime reasons in capabilities, not vendors", () => {
  const SRC = path.join(__dirname, "..", "src", "lib");
  const CORE = [
    "runtime/engine.ts",
    "runtime/compiler.ts",
    "tools/definitions.ts",
    "tools/registry.ts",
    "policy/engine.ts",
    "capabilities/model.ts",
    "capabilities/resolve.ts",
    "connections/registry.ts",
    "connections/credentials.ts",
    "connections/status.ts",
    "fabric/capability.ts",
    "fabric/builtin.ts",
    "fabric/system.ts",
    "fabric/registry.ts",
    "fabric/executor.ts",
    "fabric/conformance.ts",
    "fabric/mapping.ts",
    "fabric/http-manifest.ts",
    "fabric/connectors/http.ts",
  ];
  it.each(CORE)("%s names no vendor, platform or design partner", (rel) => {
    const text = fs.readFileSync(path.join(SRC, rel), "utf8");
    expect(text).not.toMatch(/\b(stripe|pay-?plus|google[- ]?calendar|shopify|wix|woocommerce|custom-commerce|rina)\b/i);
  });
});
