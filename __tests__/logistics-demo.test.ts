import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, LOGISTICS_DEMO_ID, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { getBusinessGraph, listBusinessSummaries } from "@/lib/fixtures";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { decideCapability } from "@/lib/policy/authority";
import { resolveCapability } from "@/lib/fabric/registry";
import { executeCapability } from "@/lib/fabric/executor";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { callTool } from "@/lib/tools";
import { getBackend } from "@/lib/store";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { setReasonerForTests, type BarryIR, type ComposeResponseInput, type Reasoner, type ReasonerContext } from "@/lib/reasoner";

/**
 * WIRING of the Barry Logistics Demo (preview/demo fixture). Deterministic:
 * the external systems are the fixture's in-process DEMO MOCKS and the model
 * is a test stand-in that proposes only from what BARRY shows it. This proves
 * the fixture exercises the real runtime, authority, Fabric and approvals —
 * NOT that the real OpenAI reasoner behaves; that is the manual Preview
 * acceptance (and `npm run eval:capabilities`).
 */

const baseline = new Map<string, number>();
class MockModel implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "mock-model";
  constructor(private readonly plan: (ctx: ReasonerContext, fresh: { capability: string; output?: Record<string, unknown> }[]) => Partial<BarryIR> | undefined) {}
  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const key = `${ctx.state.id}:${ctx.state.messages.length}`;
    if (!baseline.has(key)) baseline.set(key, ctx.grounded?.capabilityResults?.length ?? 0);
    const fresh = (ctx.grounded?.capabilityResults ?? []).slice(baseline.get(key)) as { capability: string; output?: Record<string, unknown> }[];
    return { intent: "mock", entities: {}, constraints: {}, customerInfo: {}, ...(this.plan(ctx, fresh) ?? {}) } as BarryIR;
  }
  async composeResponse(_ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    return composeDeterministic(input);
  }
}
const ask = (capability: string, input: Record<string, unknown>, purpose = "customer request"): Partial<BarryIR> => ({ capabilityRequest: { capability, input, purpose } });

afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
});

let n = 0;
const graph = () => getBusinessGraph(LOGISTICS_DEMO_ID);
const conv = () => `demo-${Date.now()}-${n++}`;

describe("Barry Logistics Demo — surface and authority", () => {
  it("is clearly marked as a simulated preview fixture", () => {
    const g = graph();
    expect(g.business.name).toMatch(/SIMULATED/);
    expect(g.business.description).toMatch(/not a real business/);
  });

  it("exposes exactly shipping.track (automatic) and support.ticket.create (owner approval) — both executable", async () => {
    const surface = await buildCapabilitySurface(graph());
    expect(surface.map((c) => [c.id, c.effect, c.available, c.authority])).toEqual([
      ["shipping.track", "read", true, "automatic"],
      ["support.ticket.create", "consequential", true, "owner_approval"],
    ]);
    expect(surface.find((c) => c.id === "support.ticket.create")?.inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "reason", options: expect.arrayContaining(["delivery_delay"]) })])
    );
    expect(JSON.stringify(surface)).not.toMatch(/demo-mock|connector|credential/);
  });

  it("authority is explicit rules only — nothing implied by effect=read", () => {
    const g = graph();
    expect(g.authority.map((r) => [r.id, r.capability, r.effect])).toEqual([
      ["demo-track-allowed", "shipping.track", "allow"],
      ["demo-tickets-need-approval", "support.ticket.create", "require_approval"],
    ]);
    expect(decideCapability(g, "shipping.track", { trackingNumber: "ABC123" })).toMatchObject({ status: "allowed", ruleId: "demo-track-allowed" });
    expect(decideCapability(g, "support.ticket.create", { reference: "ABC123", reason: "delivery_delay" })).toMatchObject({ status: "requires_approval", ruleId: "demo-tickets-need-approval" });
    expect(decideCapability({ ...g, authority: [] }, "shipping.track", { trackingNumber: "ABC123" }).status).toBe("denied");
  });

  it("the DEMO MOCK carrier is reached through the Fabric, as a simulated system", async () => {
    const r = await resolveCapability(LOGISTICS_DEMO_ID, "shipping.track");
    expect(r).toMatchObject({ ok: true, descriptor: { connector: "demo-mock-carrier", simulated: true, provenance: { source: "fixture" } } });
    const out = await executeCapability({ businessId: LOGISTICS_DEMO_ID }, "shipping.track", { trackingNumber: "ABC123" }, { authorize: () => decideCapability(graph(), "shipping.track", { trackingNumber: "ABC123" }) });
    expect(out).toMatchObject({ ok: true, output: { trackingNumber: "ABC123", status: "delayed", eta: "2026-10-03" }, provenance: { connector: "demo-mock-carrier", simulated: true } });
    expect(await executeCapability({ businessId: LOGISTICS_DEMO_ID }, "shipping.track", { trackingNumber: "NOPE99" }, { authorize: () => ({ status: "allowed", reason: "t" }) })).toMatchObject({ ok: true, output: { status: "not_found" } });
  });
});

describe("Barry Logistics Demo — acceptance flows with a MOCK model", () => {
  it("FLOW A/B shape: a grounded tracking request executes with explicit authority and answers from the result", async () => {
    setReasonerForTests(new MockModel((_ctx, fresh) => (fresh.length ? undefined : ask("shipping.track", { trackingNumber: "ABC123" }))));
    const out = await handleCustomerMessage(graph(), conv(), "c", "איפה החבילה ABC123 שלי?");
    expect(out.turn.verification?.capabilityRequest).toMatchObject({ status: "accepted", proposed: { capability: "shipping.track" } });
    expect(out.turn.trace!.steps[0]).toMatchObject({ generic: { capability: "shipping.track", authority: { status: "allowed", ruleId: "demo-track-allowed" }, executed: true, system: "demo-mock-carrier", simulated: true } });
    expect(out.response).toMatch(/delayed/);
  });

  it("FLOW C: a missing tracking number is asked for — nothing invented, nothing called", async () => {
    setReasonerForTests(new MockModel(() => ask("shipping.track", {})));
    const out = await handleCustomerMessage(graph(), conv(), "c", "Where is my package?");
    expect(out.turn.trace!.steps).toEqual([]);
    expect(out.state.missingFields).toEqual(["trackingNumber"]);
    // A model that DID invent one is rejected by grounding, not trusted.
    setReasonerForTests(new MockModel(() => ask("shipping.track", { trackingNumber: "QQQ999" })));
    const invented = await handleCustomerMessage(graph(), conv(), "c", "Where is my package?");
    expect(invented.turn.verification?.capabilityRequest).toMatchObject({ status: "rejected" });
    expect(invented.turn.trace!.steps).toEqual([]);
  });

  it("FLOW D: an invented capability is rejected by grounding; nothing is called", async () => {
    setReasonerForTests(new MockModel(() => ask("payments.refund", { paymentId: "ABC123", amount: 10 })));
    const out = await handleCustomerMessage(graph(), conv(), "c", "Refund my payment ABC123 please");
    expect(out.turn.verification?.capabilityRequest).toMatchObject({ status: "rejected", reason: expect.stringMatching(/not a capability of this business/) });
    expect(out.turn.trace!.steps).toEqual([]);
  });

  it("FLOW E: track -> delayed -> ticket proposed -> approval (no side effect) -> approved -> exactly one verified ticket", async () => {
    setReasonerForTests(
      new MockModel((_ctx, fresh) => {
        const last = fresh.at(-1);
        if (!last) return ask("shipping.track", { trackingNumber: "ABC123" }, "package hasn't arrived");
        if (last.capability === "shipping.track" && last.output?.status === "delayed") return ask("support.ticket.create", { reference: "ABC123", reason: "delivery_delay" }, "delayed shipment — open a case");
        return undefined;
      })
    );
    const c = conv();
    const out = await handleCustomerMessage(graph(), c, "c", "My package ABC123 still hasn't arrived");
    expect(out.turn.trace!.steps.map((s) => [s.trigger, s.generic?.capability, s.generic?.authority.status, s.generic?.executed])).toEqual([
      ["customer", "shipping.track", "allowed", true],
      ["continuation", "support.ticket.create", "requires_approval", false],
    ]);
    expect(out.turn.trace!.stop.reason).toBe("owner_approval_required");
    expect(out.state.stage).toBe("escalated");
    expect(demoHelpdeskTickets()).toHaveLength(0); // no side effect before approval

    const approvalId = out.state.pendingApprovalId!;
    expect(await getBackend().getApproval(approvalId)).toMatchObject({ status: "pending", requestedAction: "invokeCapability", requestedInput: { capability: "support.ticket.create", input: { reference: "ABC123", reason: "delivery_delay" } } });

    const resumed = await resumeAfterApproval(graph(), approvalId, "approved", "owner");
    expect(resumed.turn.trace!.steps[0]).toMatchObject({ trigger: "approval", generic: { capability: "support.ticket.create", executed: true, verified: true, system: "demo-mock-helpdesk" } });
    expect(resumed.response).toMatch(/T-1001/);
    expect(demoHelpdeskTickets().map((t) => [t.ticketId, t.reference, t.reason])).toEqual([["T-1001", "ABC123", "delivery_delay"]]);

    // Exactly once: a second resolution is a no-op; replaying the approved call hits the same idempotency key.
    await resumeAfterApproval(graph(), approvalId, "approved", "owner");
    const replay = await callTool("invokeCapability", { capability: "support.ticket.create", input: { reference: "ABC123", reason: "delivery_delay" }, purpose: "x", approvalId }, { graph: graph(), conversationId: c, customerId: "c" });
    expect(replay).toMatchObject({ ok: true, output: { ok: true, output: { ticketId: "T-1001" } } });
    expect(demoHelpdeskTickets()).toHaveLength(1);
  });

  it("grounding: a reason outside the contract's options, or an option used as an identifier, is rejected", async () => {
    setReasonerForTests(new MockModel(() => ask("support.ticket.create", { reference: "ABC123", reason: "angry_customer" })));
    const badReason = await handleCustomerMessage(graph(), conv(), "c", "Open a case about ABC123");
    expect(badReason.turn.verification?.capabilityRequest).toMatchObject({ status: "rejected", reason: expect.stringMatching(/input.reason/) });
    setReasonerForTests(new MockModel(() => ask("support.ticket.create", { reference: "delivery_delay", reason: "delivery_delay" })));
    const optionAsId = await handleCustomerMessage(graph(), conv(), "c", "Open a case please");
    expect(optionAsId.turn.verification?.capabilityRequest).toMatchObject({ status: "rejected", reason: expect.stringMatching(/input.reference/) });
    expect(demoHelpdeskTickets()).toHaveLength(0);
  });
});

describe("Barry Logistics Demo — never in Production", () => {
  function inProduction<T>(vercelEnv: string, fn: () => T): T {
    const saved = { NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.VERCEL_ENV = vercelEnv;
    try {
      return fn();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved.NODE_ENV;
      if (saved.VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved.VERCEL_ENV;
    }
  }

  it("a production deployment neither lists nor loads it, and the Fabric refuses its mock systems", async () => {
    graph(); // cached in dev — must not leak into production
    inProduction("production", () => {
      expect(listBusinessSummaries().map((b) => b.id)).not.toContain(LOGISTICS_DEMO_ID);
      expect(() => getBusinessGraph(LOGISTICS_DEMO_ID)).toThrow(/Unknown business/);
    });
    const saved = { NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    try {
      expect(await resolveCapability(LOGISTICS_DEMO_ID, "shipping.track")).toMatchObject({ ok: false, code: "simulation_not_allowed" });
      expect(await buildCapabilitySurface(buildLogisticsDemoGraph())).toEqual([]);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved.NODE_ENV;
      if (saved.VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved.VERCEL_ENV;
    }
  });

  it("an explicitly-allowed Preview has it", () => {
    inProduction("preview", () => {
      expect(listBusinessSummaries().map((b) => b.id)).toContain(LOGISTICS_DEMO_ID);
      expect(getBusinessGraph(LOGISTICS_DEMO_ID).business.id).toBe(LOGISTICS_DEMO_ID);
    });
  });
});
