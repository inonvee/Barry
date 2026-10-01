import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { getBackend } from "@/lib/store";
import { manifestConnection, listBusinessSystems, describeCredentials } from "@/lib/fabric/registry";
import { getCapability, listCapabilities } from "@/lib/fabric/capability";
import { setHttpTransportForTests } from "@/lib/fabric/connectors/http";
import { validateTransport } from "@/lib/fabric/transports";
import { businessStack } from "@/lib/fabric/stack-model";
import { reverificationStatus, manifestHash } from "@/lib/fabric/reverify";
import { runCompositeWorkflow } from "@/lib/fabric/workflow";
import { proposeOnboarding, activateProven } from "@/lib/fabric/onboarding";
import { runConformance } from "@/lib/fabric/conformance";
import { resolveCapability } from "@/lib/fabric/registry";
import { deriveIncidents } from "@/lib/hq/incidents";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { parcelManifest, parcelSystem, helpdeskManifest, helpdeskSystem, PARCEL_ORIGIN } from "./support/test-domains";
import type { SystemDescriptor } from "@/lib/fabric/system";

/**
 * CHECKPOINT 7 — UNIVERSAL INTEGRATION FABRIC HARDENING: capability ontology across domains, arbitrary
 * system representation (stack model), generic transport boundaries (no SSRF, no SQL), unknown-system
 * onboarding (model may infer, never activate), composite workflows with one transaction state, and
 * connection re-verification feeding incidents.
 */

const ENV = ["PARCEL_CO_API_KEY", "HELPDESK_API_KEY"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setHttpTransportForTests(undefined);
});
let n = 0;
const biz = (label: string) => `hard-${label}-${Date.now()}-${n++}`;
const allow = () => ({ status: "allowed" as const, reason: "test policy allows" });
const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("capability ontology", () => {
  it("reusable domains exist as contracts (crm, inventory, shipping, accounting, documents, procurement, identity, analytics, support); writes stay policy-gated", () => {
    for (const id of ["crm.contact.lookup", "inventory.level.read", "shipping.rate.quote", "shipping.shipment.create", "accounting.invoice.read", "documents.file.read", "procurement.purchase_order.read", "identity.customer.verify", "analytics.metric.read", "support.ticket.status"]) {
      expect(getCapability(id), id).toBeDefined();
    }
    expect(getCapability("shipping.shipment.create")).toMatchObject({ effect: "consequential", authority: "policy_gated", verification: "provider_confirmed" });
    expect(new Set(listCapabilities().map((c) => c.id.split(".")[0])).size).toBeGreaterThanOrEqual(11);
  });
});

describe("generic transports: declared boundaries, validated, never arbitrary", () => {
  it("REST manifests execute; GraphQL / webhook / read-only DB / file / email validate but do not execute; private hosts and SQL are refused", () => {
    const rest = validateTransport({ type: "rest_openapi", manifest: parcelManifest });
    expect(rest).toMatchObject({ ok: true, executable: true, requiredCredentials: ["API_KEY"] });
    const gql = validateTransport({ type: "graphql", endpoint: "https://api.example-shop.test/graphql", auth: { kind: "api_key", credential: "SHOP_KEY" }, operations: [{ capability: "inventory.level.read", query: "query Level($sku: String!) { level(sku: $sku) }", variables: { sku: "sku" }, effect: "read" }] });
    expect(gql).toMatchObject({ ok: true, executable: false, requiredCredentials: ["SHOP_KEY"] });
    expect(validateTransport({ type: "graphql", endpoint: "https://10.0.0.5/graphql", auth: { kind: "none" }, operations: [{ capability: "x.y", query: "mutation M { m }", variables: {}, effect: "read" }] }).problems.join(" ")).toMatch(/refused|mutation cannot be declared as a read/);
    expect(validateTransport({ type: "graphql", endpoint: "http://api.example-shop.test/graphql", auth: { kind: "none" }, operations: [{ capability: "x.y", query: "query Q { q }", variables: {}, effect: "read" }] }).problems.join(" ")).toMatch(/https/);
    const db = validateTransport({ type: "db_readonly", dsnCredential: "WAREHOUSE_DSN", views: [{ name: "stock_levels", capability: "inventory.level.read", columns: ["sku", "available"] }] });
    expect(db).toMatchObject({ ok: true, executable: false });
    expect(validateTransport({ type: "db_readonly", dsnCredential: "WAREHOUSE_DSN", views: [{ name: "select * from users", capability: "x.y", columns: ["a"] }] }).ok).toBe(false);
    expect(validateTransport({ type: "webhook_event", events: [{ event: "order.shipped", capability: "shipping.track" }], signature: { header: "x-signature", credential: "WEBHOOK_SECRET" } })).toMatchObject({ ok: true, executable: false });
    expect(validateTransport({ type: "email_messaging", provider: "postmark", credential: "POSTMARK_TOKEN", direction: "outbound" }).executable).toBe(false);
    expect(validateTransport({ type: "teleport" }).ok).toBe(false);
  });
});

describe("stack model + re-verification", () => {
  it("represents systems as objects / capabilities / authority / events / health / versions and says when re-verification is due", async () => {
    const id = biz("stack");
    process.env.PARCEL_CO_API_KEY = "parcel-secret";
    await getBackend().upsertBusinessConnection(manifestConnection({ businessId: id, systemKey: "parcel-co", domain: "shipping", name: "Parcel Co", manifest: parcelManifest, mappings: { "shipping.track": { status: "active" }, "shipping.create_shipment": { status: "active" } } }));
    const systems = await listBusinessSystems(id);
    const stack = businessStack(systems, NOW);
    const parcel = stack.systems.find((s) => s.key === "parcel-co")!;
    expect(parcel.objects.map((o) => o.name).sort()).toEqual(["create_shipment", "track"].sort());
    expect(parcel.authority).toMatchObject({ policyGated: 1, reads: 1, consequential: 1 });
    expect(parcel.versions.capabilities["shipping.track"]).toBe("1.0.0");
    expect(stack.domains.find((d) => d.domain === "shipping")).toMatchObject({ systems: 1, active: 1 });
    expect(parcel.reverification.due).toBe(true);
    expect(parcel.reverification.reasons).toContain("never verified");

    const d = systems[0];
    const verified: SystemDescriptor = { ...d, lastVerifiedAt: new Date(NOW.getTime() - 5 * 24 * 3600_000).toISOString(), config: { ...d.config, verifiedManifestHash: manifestHash(d) } };
    expect(reverificationStatus(verified, { now: NOW })).toMatchObject({ due: false, overdue: false, schemaDrift: false });
    const drifted: SystemDescriptor = { ...verified, transport: { type: "http", manifest: { ...parcelManifest, timeoutMs: 9000 } } };
    expect(reverificationStatus(drifted, { now: NOW })).toMatchObject({ due: true, overdue: true, schemaDrift: true });
    expect(reverificationStatus(verified, { now: NOW, authExpiresAt: new Date(NOW.getTime() - 1000).toISOString() }).reasons).toContain("the credential expired");
    expect(reverificationStatus({ ...verified, lastVerifiedAt: new Date(NOW.getTime() - 45 * 24 * 3600_000).toISOString() }, { now: NOW })).toMatchObject({ due: true, overdue: false });
    // A real, active, never-verified connection raises a low incident.
    const incidents = deriveIncidents({ graph: buildFashionRetailerGraph(), conversations: [], approvals: [], payments: [], connections: [{ capability: "shipping", provider: "parcel-co", status: "connected", origin: "business_connection", simulated: false, lastVerifiedAt: null, permissions: [], settings: {}, setup: [], missing: [], operations: [] }], ai: { mode: "simulated", model: null, status: "healthy", summary: "", understandingFailures: 0 } as never, now: NOW });
    expect(incidents.find((i) => i.kind === "reverification_due")).toMatchObject({ severity: "low", capability: "shipping" });
  });
});

describe("composite workflow: one transaction state across systems", () => {
  it("runs steps in order with per-step idempotency keys and verified handoff; stops at the first refusal and never runs later steps", async () => {
    const id = biz("workflow");
    process.env.PARCEL_CO_API_KEY = "parcel-secret";
    process.env.HELPDESK_API_KEY = "desk-secret";
    const parcel = parcelSystem();
    const desk = helpdeskSystem();
    setHttpTransportForTests(async (req) => (String(req.url).startsWith(PARCEL_ORIGIN) ? parcel.transport(req) : desk.transport(req)));
    await getBackend().upsertBusinessConnection(manifestConnection({ businessId: id, systemKey: "parcel-co", domain: "shipping", name: "Parcel Co", manifest: parcelManifest, mappings: { "shipping.track": { status: "active" }, "shipping.create_shipment": { status: "active" } } }));
    await getBackend().upsertBusinessConnection(manifestConnection({ businessId: id, systemKey: "helpdesk", domain: "support", name: "Helpdesk", manifest: helpdeskManifest, mappings: { "support.ticket.create": { status: "active" } } }));
    const run = await runCompositeWorkflow({
      ctx: { businessId: id, conversationId: "c1", customerId: "x" },
      key: "wf-order-1001",
      authorize: allow,
      steps: [
        { name: "track", capability: "shipping.track", input: () => ({ trackingNumber: "TRK-1001" }) },
        { name: "open case", capability: "support.ticket.create", input: (prev) => ({ reference: String((prev[0] as { trackingNumber: string }).trackingNumber), reason: "delivery_delay" }) },
      ],
    });
    expect(run.status).toBe("completed");
    expect(run.steps.map((s) => s.status)).toEqual(["completed", "completed"]);
    expect(run.steps[1].idempotencyKey).toBe("wf-order-1001:1");
    expect(run.steps[1].output).toMatchObject({ verified: true });
    const ticketCalls = desk.calls.filter((c) => c.method === "POST");
    expect(ticketCalls[0].headers["idempotency-key"] ?? ticketCalls[0].headers["Idempotency-Key"]).toBe("wf-order-1001:1");

    // Authority refusal on step 1 → step 2 never runs; the state says so.
    const callsBefore = desk.calls.length;
    const refused = await runCompositeWorkflow({ ctx: { businessId: id }, key: "wf-order-1002", authorize: ({ capability }) => (capability === "shipping.track" ? { status: "denied", reason: "no read authority" } : allow()), steps: [{ name: "track", capability: "shipping.track", input: () => ({ trackingNumber: "TRK-1" }) }, { name: "open case", capability: "support.ticket.create", input: () => ({ reference: "x", reason: "other" }) }] });
    expect(refused.status).toBe("refused");
    expect(refused.steps.map((s) => s.status)).toEqual(["refused", "not_run"]);
    expect(desk.calls.length).toBe(callsBefore);
  });
});

describe("unknown-system onboarding: infer, validate, prove, approve — only then active", () => {
  it("an OpenAPI document becomes a proposal with gaps; activation needs a passing conformance report AND approval per capability", async () => {
    const openapi = JSON.parse(`{
      "openapi": "3.0.0",
      "servers": [{ "url": "https://desk.example-helpdesk.test/api" }],
      "paths": {
        "/tickets": { "post": { "operationId": "createTicket", "summary": "Create a support ticket",
          "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "reference": { "type": "string" }, "reason": { "type": "string" } } } } } },
          "responses": { "201": { "content": { "application/json": { "schema": { "type": "object", "properties": { "id": { "type": "string" }, "status": { "type": "string" } } } } } } } } },
        "/tickets/{id}": { "get": { "operationId": "getTicket", "summary": "Read a ticket's status", "parameters": [{ "name": "id", "in": "path" }],
          "responses": { "200": { "content": { "application/json": { "schema": { "type": "object", "properties": { "status": { "type": "string" } } } } } } } } }
      }
    }`) as unknown;
    const proposal = await proposeOnboarding({ systemKey: "acme-desk", name: "Acme Desk", domain: "support", openapi, auth: { type: "bearer", credential: "ACME_DESK_KEY" } });
    expect(["proposed", "validated", "blocked"]).toContain(proposal.status);
    expect(proposal.gaps.credentials).toContain("ACME_DESK_KEY");
    for (const m of proposal.mappings) expect(m.status).not.toBe("active");
    const noApproval = activateProven(proposal, [], "founder", []);
    expect(noApproval.activated).toEqual([]);
    expect(noApproval.refused.every((r) => r.reason === "not approved")).toBe(true);
    const approvedNoReport = activateProven(proposal, [], "founder", proposal.mappings.map((m) => m.id));
    expect(approvedNoReport.activated).toEqual([]);
    expect(describeCredentials("env:acme-desk", undefined)).toEqual([]);

    // A real system that passes conformance can be activated — through every gate.
    const id = biz("onboard");
    process.env.HELPDESK_API_KEY = "desk-secret";
    const desk = helpdeskSystem();
    setHttpTransportForTests(desk.transport);
    await getBackend().upsertBusinessConnection(manifestConnection({ businessId: id, systemKey: "helpdesk", domain: "support", name: "Helpdesk", manifest: helpdeskManifest, mappings: { "support.ticket.create": { status: "validated" } } }));
    const systems = await listBusinessSystems(id);
    const resolution = await resolveCapability(id, "support.ticket.create");
    expect(resolution.ok).toBe(false);
    const { getConnectorFactory, resolveCredentialValues, credentialSpecFor } = await import("@/lib/fabric/registry");
    const factory = getConnectorFactory(systems[0].connector)!;
    const connector = await factory.create(systems[0], resolveCredentialValues(systems[0].auth.credentialsRef, systems[0].system.key, credentialSpecFor(systems[0])));
    const report = await runConformance({ capability: "support.ticket.create", descriptor: systems[0], connector, harness: desk });
    expect(report.passed).toBe(true);
    const validatedProposal = { ...proposal, mappings: [{ id: "support.ticket.create", version: "1.0.0", status: "validated" as const, provenance: { source: "owner_manifest" as const }, ownerVerificationRequired: true }] };
    const activation = activateProven(validatedProposal, [report], "founder", ["support.ticket.create"]);
    expect(activation.activated.map((m) => m.status)).toEqual(["active"]);
    expect(activation.stored["support.ticket.create"].status).toBe("active");
  });
});
