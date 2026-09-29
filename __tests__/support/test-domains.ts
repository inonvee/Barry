import { z } from "zod";
import { registerCapability } from "@/lib/fabric/capability";
import type { HttpManifest } from "@/lib/fabric/http-manifest";
import { createMockHttpSystem } from "./mock-http-system";

/**
 * Capability contracts for business domains BARRY's core knows nothing
 * about — registered here exactly as a business manifest would register
 * them. Production code never names these domains or systems.
 */

const manifestProvenance = { source: "business_manifest" as const, ref: "test" };

registerCapability({
  id: "shipping.track",
  version: "1.0.0",
  purpose: "Where is a shipment?",
  input: z.object({ trackingNumber: z.string().min(3).max(64) }),
  output: z.object({ trackingNumber: z.string(), status: z.string(), eta: z.string().optional() }),
  effect: "read",
  verification: "none",
  idempotency: "none",
  authority: "none",
  provenance: manifestProvenance,
  examples: { valid: { trackingNumber: "TRK-1001" }, invalid: { trackingNumber: "x" } },
});

registerCapability({
  id: "shipping.create_shipment",
  version: "1.0.0",
  purpose: "Book a shipment for an order.",
  input: z.object({ orderRef: z.string().min(1), address: z.string().min(5), idempotencyKey: z.string().min(8) }),
  output: z.object({ shipmentId: z.string(), trackingNumber: z.string(), verified: z.literal(true) }),
  effect: "consequential",
  verification: "provider_confirmed",
  idempotency: "key_required",
  authority: "policy_gated",
  provenance: manifestProvenance,
  examples: { valid: { orderRef: "ORD-7", address: "1 Harbour Road, Haifa", idempotencyKey: "ship-key-0001" }, invalid: { orderRef: "", address: "x", idempotencyKey: "short" } },
});

registerCapability({
  id: "support.ticket.create",
  version: "1.0.0",
  purpose: "Open a support ticket in the business's helpdesk.",
  input: z.object({ subject: z.string().min(3).max(200), body: z.string().min(1).max(5000), customerRef: z.string().min(1), idempotencyKey: z.string().min(8) }),
  output: z.object({ ticketId: z.string(), verified: z.literal(true) }),
  effect: "consequential",
  verification: "provider_confirmed",
  idempotency: "key_required",
  authority: "policy_gated",
  provenance: manifestProvenance,
  examples: { valid: { subject: "Broken zipper", body: "Arrived damaged", customerRef: "cust-1", idempotencyKey: "ticket-key-01" }, invalid: { subject: "", body: "", customerRef: "", idempotencyKey: "x" } },
});

// ── Two different shipping systems implementing the same capabilities ────

export const PARCEL_ORIGIN = "https://api.parcel-co.example";
export const parcelManifest: HttpManifest = {
  manifestVersion: 1,
  baseUrl: `${PARCEL_ORIGIN}/v2`,
  auth: { type: "bearer", credential: "API_KEY" },
  operations: [
    { capability: "shipping.track", method: "GET", path: "/tracking/{trackingNumber}", response: { map: { trackingNumber: "/tracking/number", status: "/tracking/state", eta: "/tracking/eta" } } },
    {
      capability: "shipping.create_shipment",
      method: "POST",
      path: "/shipments",
      body: { order: "orderRef", destination: "address" },
      idempotencyHeader: "Idempotency-Key",
      response: { map: { shipmentId: "/id", trackingNumber: "/tracking" }, success: { pointer: "/state", equals: "booked" } },
    },
  ],
};

export function parcelSystem(options: { idempotent?: boolean } = {}) {
  let n = 0;
  return createMockHttpSystem(
    PARCEL_ORIGIN,
    {
      "GET /v2/tracking/{trackingNumber}": ({ params }) => ({ json: { tracking: { number: params.trackingNumber, state: "in_transit", eta: "2026-10-02" } } }),
      "POST /v2/shipments": ({ body }) => ({ status: 201, json: { id: `shp_${++n}`, tracking: `TRK-${String(body.order)}-${n}`, state: "booked" } }),
    },
    { ...options, requireAuth: { header: "authorization", value: "Bearer parcel-secret" } }
  );
}

export const COURIER_ORIGIN = "https://courier.example-logistics.test";
export const courierManifest: HttpManifest = {
  manifestVersion: 1,
  baseUrl: COURIER_ORIGIN,
  auth: { type: "header", header: "X-Api-Token", credential: "TOKEN" },
  operations: [
    { capability: "shipping.track", method: "GET", path: "/api/parcels", query: { ref: "trackingNumber" }, response: { map: { trackingNumber: "/parcel/ref", status: "/parcel/phase" } } },
  ],
};

export function courierSystem() {
  return createMockHttpSystem(
    COURIER_ORIGIN,
    { "GET /api/parcels": ({ query }) => ({ json: { parcel: { ref: query.get("ref"), phase: "out_for_delivery" } } }) },
    { requireAuth: { header: "x-api-token", value: "courier-token" } }
  );
}

// ── A helpdesk: a different domain entirely ─────────────────────────────

export const HELPDESK_ORIGIN = "https://desk.example-helpdesk.test";
export const helpdeskManifest: HttpManifest = {
  manifestVersion: 1,
  baseUrl: HELPDESK_ORIGIN,
  auth: { type: "bearer", credential: "API_KEY" },
  operations: [
    {
      capability: "support.ticket.create",
      method: "POST",
      path: "/tickets",
      body: { title: "subject", description: "body", requester: "customerRef" },
      idempotencyHeader: "Idempotency-Key",
      response: { map: { ticketId: "/ticket/id" }, success: { pointer: "/ticket/created", equals: true } },
    },
  ],
};

export function helpdeskSystem(options: { idempotent?: boolean; confirm?: boolean } = {}) {
  let n = 0;
  return createMockHttpSystem(
    HELPDESK_ORIGIN,
    { "POST /tickets": () => ({ status: 201, json: { ticket: { id: `T-${++n}`, created: options.confirm !== false } } }) },
    { idempotent: options.idempotent, requireAuth: { header: "authorization", value: "Bearer desk-secret" } }
  );
}
