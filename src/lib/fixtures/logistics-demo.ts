import { BusinessGraphSchema, type BusinessGraph } from "@/lib/business-graph";
import { registerConnectorFactory, registerDefaultSystemProvider, type Connector } from "@/lib/fabric/registry";
import "@/lib/fabric/vocabulary";

/**
 * ─── PREVIEW / DEMO FIXTURE — NOT A REAL BUSINESS ───────────────────────
 *
 * "Barry Logistics Demo" exists only so the generic capability planner can
 * be accepted interactively in the Simulator with the REAL configured
 * reasoner. Everything BARRY does here is the real runtime — understanding,
 * grounding, compilation, per-capability authority, approvals, the Fabric's
 * resolution and execution, verification, state, traces. Only the two
 * external systems are MOCKS, implemented in-process below:
 *
 *   DEMO MOCK carrier   -> shipping.track
 *   DEMO MOCK helpdesk  -> support.ticket.create
 *
 * Isolation:
 * - both mock systems are registered as SIMULATED connectors, so the Fabric
 *   refuses them wherever simulation isn't allowed (a production deployment
 *   that is not an explicitly-allowed preview);
 * - the business itself is hidden from the simulator/HQ listings and cannot
 *   be loaded in that case either (see fixtures/index.ts);
 * - nothing in the runtime, planner or compiler refers to this business,
 *   these systems, or these capabilities.
 */

export const LOGISTICS_DEMO_ID = "barry-logistics-demo";

export function buildLogisticsDemoGraph(): BusinessGraph {
  return BusinessGraphSchema.parse({
    business: {
      id: LOGISTICS_DEMO_ID,
      name: "Barry Logistics Demo — SIMULATED (preview only)",
      description:
        "Preview/demo fixture, not a real business. Its carrier and helpdesk are in-process MOCK systems used to accept BARRY's generic capability planner. Speaks English and Hebrew.",
      locale: "en-US",
      timezone: "Asia/Jerusalem",
      tone: { voice: "friendly", formality: "casual", emojiOk: false },
      operatingHours: [],
    },
    capabilities: { requiresApproval: true },
    offers: [],
    resources: [],
    availability: [],
    inventory: [],
    knowledge: [
      {
        id: "know-delivery-times",
        topic: "delivery times",
        content: "Standard deliveries arrive within 3–5 business days. Delayed shipments can be escalated to our support team.",
        kind: "faq",
      },
    ],
    policies: [],
    availableActions: [{ name: "requestApproval" }],
    goals: [],
    // Explicit authority — nothing is assumed. Tracking is a read the business allows; opening a
    // support case changes the helpdesk, so the owner approves each one.
    authority: [
      { id: "demo-track-allowed", capability: "shipping.track", effect: "allow", reason: "Customers may check their own shipment status." },
      { id: "demo-tickets-need-approval", capability: "support.ticket.create", effect: "require_approval", reason: "Every support case is approved by the owner in this demo." },
    ],
  });
}

// ── DEMO MOCK systems (in-process; simulated) ──────────────────────────

/** DEMO MOCK carrier data. Deterministic; unknown numbers are reported as not found, never invented. */
const MOCK_SHIPMENTS: Record<string, { status: string; eta?: string }> = {
  ABC123: { status: "delayed", eta: "2026-10-03" },
  XYZ789: { status: "in_transit", eta: "2026-10-01" },
  DEF456: { status: "delivered" },
};

type MockTicket = { ticketId: string; reference: string; reason: string; idempotencyKey: string; createdAt: string };
type MockHelpdesk = { next: number; byKey: Map<string, MockTicket>; tickets: MockTicket[] };

// On globalThis: in `next dev`, the message and approval routes are separate module graphs and must
// see the same mock helpdesk (as with the in-memory stores).
const holder = globalThis as { __barryDemoHelpdesk?: MockHelpdesk };
function helpdesk(): MockHelpdesk {
  if (!holder.__barryDemoHelpdesk) holder.__barryDemoHelpdesk = { next: 1001, byKey: new Map(), tickets: [] };
  return holder.__barryDemoHelpdesk;
}

/** Test/inspection only: every ticket the DEMO MOCK helpdesk has created. */
export function demoHelpdeskTickets(): readonly MockTicket[] {
  return [...helpdesk().tickets];
}

/** Test only. */
export function resetDemoHelpdeskForTests(): void {
  holder.__barryDemoHelpdesk = undefined;
}

registerConnectorFactory({
  key: "demo-mock-carrier",
  name: "DEMO MOCK carrier (simulated)",
  kind: "custom",
  simulated: true,
  potentialCapabilities: ["shipping.track"],
  create: (): Connector => ({
    systemKey: "demo-mock-carrier",
    capabilities: async () => ["shipping.track"],
    executes: (capability) => capability === "shipping.track",
    async execute(capability, input) {
      if (capability !== "shipping.track") throw new Error(`DEMO MOCK carrier does not implement ${capability}`);
      const trackingNumber = String(input.trackingNumber).trim().toUpperCase();
      const shipment = MOCK_SHIPMENTS[trackingNumber];
      return shipment ? { trackingNumber, ...shipment } : { trackingNumber, status: "not_found" };
    },
  }),
});

registerConnectorFactory({
  key: "demo-mock-helpdesk",
  name: "DEMO MOCK helpdesk (simulated)",
  kind: "custom",
  simulated: true,
  potentialCapabilities: ["support.ticket.create"],
  create: (): Connector => ({
    systemKey: "demo-mock-helpdesk",
    capabilities: async () => ["support.ticket.create"],
    executes: (capability) => capability === "support.ticket.create",
    async execute(capability, input) {
      if (capability !== "support.ticket.create") throw new Error(`DEMO MOCK helpdesk does not implement ${capability}`);
      const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
      if (!key) throw new Error("DEMO MOCK helpdesk requires an idempotency key");
      const desk = helpdesk();
      // Same key -> the same ticket, exactly like a well-behaved helpdesk API. One side effect per key.
      let ticket = desk.byKey.get(key);
      if (!ticket) {
        ticket = { ticketId: `T-${desk.next++}`, reference: String(input.reference), reason: String(input.reason), idempotencyKey: key, createdAt: new Date().toISOString() };
        desk.byKey.set(key, ticket);
        desk.tickets.push(ticket);
      }
      // Explicit confirmation: the helpdesk says the ticket exists.
      return { ticketId: ticket.ticketId, verified: true };
    },
  }),
});

// The demo business's connections — defaults for THIS business only, marked as fixtures.
const demoConnection = (domain: string, provider: string, capability: string) => ({
  id: `demo-${domain}`,
  businessId: LOGISTICS_DEMO_ID,
  capability: domain,
  provider,
  status: "connected" as const,
  config: {
    name: provider === "demo-mock-carrier" ? "DEMO MOCK carrier (simulated)" : "DEMO MOCK helpdesk (simulated)",
    mappings: { [capability]: { status: "active" as const, provenance: { source: "owner_manifest" as const, approvedBy: "demo fixture" } } },
  },
  credentialsRef: `env:${provider}`,
  permissions: [],
  provenance: "fixture" as const,
});

registerDefaultSystemProvider("shipping", (businessId) => (businessId === LOGISTICS_DEMO_ID ? demoConnection("shipping", "demo-mock-carrier", "shipping.track") : undefined));
registerDefaultSystemProvider("support", (businessId) => (businessId === LOGISTICS_DEMO_ID ? demoConnection("support", "demo-mock-helpdesk", "support.ticket.create") : undefined));
