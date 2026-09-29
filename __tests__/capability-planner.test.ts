import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import "@/lib/fabric";
import { registerCapability } from "@/lib/fabric/capability";
import { manifestConnection } from "@/lib/fabric/registry";
import type { HttpManifest } from "@/lib/fabric/http-manifest";
import { setHttpTransportForTests, type HttpTransport } from "@/lib/fabric/connectors/http";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { decideCapability } from "@/lib/policy/authority";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { callTool } from "@/lib/tools";
import { getBackend } from "@/lib/store";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { setReasonerForTests, type BarryIR, type ComposeResponseInput, type Reasoner, type ReasonerContext } from "@/lib/reasoner";
import type { CapabilitySurfaceEntry } from "@/lib/reasoner/types";
import { buildSpaGraph, buildFashionRetailerGraph } from "@/lib/fixtures";
import type { AuthorityRule, BusinessGraph } from "@/lib/business-graph";
import { createMockHttpSystem } from "./support/mock-http-system";
import { courierManifest, courierSystem, helpdeskManifest, helpdeskSystem, parcelManifest, PARCEL_ORIGIN } from "./support/test-domains";

/**
 * CAPABILITY-NATIVE PLANNING AND AUTHORITY — acceptance proofs.
 *
 * What is real here: the runtime (understand -> ground -> compile -> policy
 * -> generic action -> fabric -> manifest connector -> verification ->
 * state -> compose -> trace), the business's authority rules and the
 * approval flow. What is MOCKED: the external systems (in-process HTTP
 * stand-ins) and the model — a test reasoner that proposes capabilities
 * from exactly what BARRY shows it (the business's capability surface and
 * earlier results). No live model or live external system is involved.
 */

// A domain the core has never heard of, registered like any business manifest would.
registerCapability({
  id: "billing.credit.issue",
  version: "1.0.0",
  purpose: "Issue a store credit to a customer account.",
  input: z.object({ account: z.string().min(2).max(40), amount: z.number().positive(), idempotencyKey: z.string().min(8) }),
  output: z.object({ creditId: z.string(), verified: z.literal(true) }),
  effect: "consequential",
  verification: "provider_confirmed",
  idempotency: "key_required",
  authority: "policy_gated",
  provenance: { source: "business_manifest", ref: "test" },
});

const LEDGER_ORIGIN = "https://ledger.example-accounts.test";
const ledgerManifest: HttpManifest = {
  manifestVersion: 1,
  baseUrl: LEDGER_ORIGIN,
  auth: { type: "bearer", credential: "API_KEY" },
  operations: [
    {
      capability: "billing.credit.issue",
      method: "POST",
      path: "/credits",
      body: { account: "account", amount: "amount" },
      idempotencyHeader: "Idempotency-Key",
      response: { map: { creditId: "/credit/id" }, success: { pointer: "/credit/status", equals: "issued" } },
    },
  ],
};
function ledgerSystem() {
  let n = 0;
  return createMockHttpSystem(LEDGER_ORIGIN, { "POST /credits": () => ({ status: 201, json: { credit: { id: `CR-${++n}`, status: "issued" } } }) }, { requireAuth: { header: "authorization", value: "Bearer ledger-secret" } });
}
/** A carrier that reports every parcel as delayed (mock). */
function delayedParcelSystem() {
  return createMockHttpSystem(PARCEL_ORIGIN, { "GET /v2/tracking/{trackingNumber}": ({ params }) => ({ json: { tracking: { number: params.trackingNumber, state: "delayed" } } }) }, { requireAuth: { header: "authorization", value: "Bearer parcel-secret" } });
}

function route(...ts: HttpTransport[]): HttpTransport {
  return async (req) => {
    for (const t of ts) {
      const r = await t(req);
      if (r.status !== 404) return r;
    }
    return { status: 404, body: "{}" };
  };
}

// ── the MOCK model: proposes from what it is shown, nothing else ─────────

type Plan = (ctx: ReasonerContext) => Partial<BarryIR> | undefined;
/** How many results existed when the model first saw each customer message (per conversation). */
const baseline = new Map<string, number>();
class PlanningReasoner implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "test-planner";
  readonly seen: { surface: CapabilitySurfaceEntry[]; results: unknown[] }[] = [];
  constructor(private readonly plan: Plan) {}
  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const key = `${ctx.state.id}:${ctx.state.messages.length}`;
    if (!baseline.has(key)) baseline.set(key, ctx.grounded?.capabilityResults?.length ?? 0);
    this.seen.push({ surface: ctx.grounded?.capabilities ?? [], results: ctx.grounded?.capabilityResults ?? [] });
    return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...(this.plan(ctx) ?? {}) } as BarryIR;
  }
  async composeResponse(_ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    return composeDeterministic(input);
  }
}
const ask = (capability: string, input: Record<string, unknown>, purpose = "customer asked"): Partial<BarryIR> => ({ capabilityRequest: { capability, input, purpose } });
/** Results produced during THIS customer turn (the continuation step sees them; the next message starts fresh). */
const thisTurn = (ctx: ReasonerContext) =>
  (ctx.grounded?.capabilityResults ?? []).slice(baseline.get(`${ctx.state.id}:${ctx.state.messages.length}`) ?? 0) as { capability: string; output?: Record<string, unknown> }[];
const lastResult = (ctx: ReasonerContext) => thisTurn(ctx).at(-1);

// ── tenants ──────────────────────────────────────────────────────────────

const ENV = ["PARCEL_CO_API_KEY", "COURIER_TOKEN", "HELPDESK_API_KEY", "LEDGER_API_KEY"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setHttpTransportForTests(undefined);
  setReasonerForTests(undefined);
  vi.useRealTimers();
});
function credentials() {
  process.env.PARCEL_CO_API_KEY = "parcel-secret";
  process.env.COURIER_TOKEN = "courier-token";
  process.env.HELPDESK_API_KEY = "desk-secret";
  process.env.LEDGER_API_KEY = "ledger-secret";
}

let n = 0;
/** A business built from an existing Genome with a new id and its own authority rules. No typed domain is involved for these capabilities. */
function business(label: string, authority: AuthorityRule[]): BusinessGraph {
  const base = buildSpaGraph();
  return { ...base, business: { ...base.business, id: `plan-${label}-${Date.now()}-${n++}` }, authority };
}
async function connect(g: BusinessGraph, systemKey: string, domain: string, manifest: HttpManifest) {
  const mappings = Object.fromEntries(manifest.operations.map((o) => [o.capability, { status: "active" as const }]));
  await getBackend().upsertBusinessConnection(manifestConnection({ businessId: g.business.id, systemKey, domain, name: systemKey, manifest, mappings }));
}
const rule = (id: string, capability: string, effect: AuthorityRule["effect"], when: AuthorityRule["when"] = []): AuthorityRule => ({ id, capability, effect, when });
const say = (g: BusinessGraph, conv: string, text: string) => handleCustomerMessage(g, conv, `cust-${conv}`, text);

// ─────────────────────────────────────────────────────────────────────────

describe("authority is per capability, per business, deterministic — and never assumed", () => {
  const g = business("rules", [rule("credit-small", "billing.credit.issue", "allow", [{ field: "amount", op: "lte", value: 50 }]), rule("credit-large", "billing.credit.issue", "require_approval", [{ field: "amount", op: "gt", value: 50 }]), rule("no-shipments", "shipping.*", "deny", [{ field: "address", op: "exists" }])]);
  it.each([
    ["billing.credit.issue", { account: "C-7", amount: 30 }, "allowed", "credit-small"],
    ["billing.credit.issue", { account: "C-7", amount: 80 }, "requires_approval", "credit-large"],
    ["billing.credit.issue", { account: "C-7" }, "requires_approval", "credit-large"], // unevaluable -> restriction holds, allow doesn't
    ["shipping.create_shipment", { orderRef: "O", address: "1 Road St" }, "denied", "no-shipments"],
    ["shipping.track", { trackingNumber: "ABC" }, "denied", undefined], // a READ with no rule is denied too — never assumed from effect=read
    ["support.ticket.create", { reference: "ABC", reason: "other" }, "denied", undefined], // consequential, no rule -> fail closed
    ["no.such.capability", {}, "denied", undefined],
  ])("%s %j -> %s", (capability, input, status, ruleId) => {
    const d = decideCapability(g, capability, input);
    expect(d.status).toBe(status);
    expect(d.ruleId).toBe(ruleId);
  });

  it("a read is allowed only by an explicit rule, and a sensitive read can be conditioned or denied like a write", () => {
    const tracking = business("read-rules", [rule("track", "shipping.track", "allow"), rule("crm-own", "crm.customer.find", "allow", [{ field: "scope", op: "eq", value: "own" }])]);
    expect(decideCapability(tracking, "shipping.track", { trackingNumber: "ABC" })).toMatchObject({ status: "allowed", ruleId: "track" });
    expect(decideCapability(business("no-read-rule", []), "shipping.track", { trackingNumber: "ABC" }).status).toBe("denied");
  });
});

describe("PROOF A — a read capability chosen from conversation, no domain planner code", () => {
  it("'Where is order ABC?' -> shipping.track on this tenant's system -> the tracking state is the answer", async () => {
    credentials();
    const g = business("track", [rule("track", "shipping.track", "allow")]);
    await connect(g, "parcel-co", "shipping", parcelManifest);
    const sys = createMockHttpSystem(PARCEL_ORIGIN, { "GET /v2/tracking/{trackingNumber}": ({ params }) => ({ json: { tracking: { number: params.trackingNumber, state: "out_for_delivery", eta: "2026-10-02" } } }) }, { requireAuth: { header: "authorization", value: "Bearer parcel-secret" } });
    setHttpTransportForTests(sys.transport);
    const reasoner = new PlanningReasoner((ctx) => (thisTurn(ctx).length ? undefined : ask("shipping.track", { trackingNumber: "ABC" }, "customer asks where their order is")));
    setReasonerForTests(reasoner);

    const out = await say(g, `a-${n}`, "Where is order ABC?");
    const step = out.turn.trace!.steps[0];
    expect(step).toMatchObject({ action: "invokeCapability", generic: { capability: "shipping.track", inputFields: ["trackingNumber"], authority: { status: "allowed" }, executed: true, system: "parcel-co", connector: "http-manifest" } });
    expect(out.response).toMatch(/out_for_delivery/);
    expect(out.response).toMatch(/2026-10-02/);
    expect(sys.calls).toHaveLength(1);

    // The model saw a business-specific, secret-free surface.
    const surface = reasoner.seen[0].surface;
    expect(surface.map((c) => [c.id, c.available, c.authority])).toEqual(expect.arrayContaining([["shipping.track", true, "automatic"], ["shipping.create_shipment", true, "not_permitted"]]));
    const seen = JSON.stringify(surface);
    for (const secret of ["parcel-secret", "api.parcel-co", "/tracking/", "http-manifest", "parcel-co"]) expect(seen).not.toContain(secret);
    // Result is kept for the next reasoning step, with provenance-free facts only.
    expect(out.state.knownFields.__capabilityResults).toMatch(/out_for_delivery/);
  });

  it("a hallucinated input or an invented capability is never executed", async () => {
    credentials();
    const g = business("halluc", []);
    await connect(g, "parcel-co", "shipping", parcelManifest);
    const sys = createMockHttpSystem(PARCEL_ORIGIN, {});
    setHttpTransportForTests(sys.transport);
    setReasonerForTests(new PlanningReasoner(() => ask("shipping.track", { trackingNumber: "ZZ-9981" })));
    const invented = await say(g, `a2-${n}`, "Where is my order?");
    expect(invented.turn.trace!.steps).toEqual([]);
    expect(invented.turn.verification?.rejected).toContainEqual(expect.objectContaining({ claim: "capabilityRequest.input.trackingNumber" }));

    setReasonerForTests(new PlanningReasoner(() => ask("shipping.teleport", { trackingNumber: "ABC" })));
    const unknown = await say(g, `a3-${n}`, "Teleport order ABC to me");
    expect(unknown.turn.trace!.steps).toEqual([]);
    expect(unknown.turn.verification?.rejected).toContainEqual(expect.objectContaining({ claim: "capabilityRequest.capability", reason: "not a capability of this business" }));
    expect(sys.calls).toHaveLength(0);
  });

  it("a missing required input is asked for, not guessed", async () => {
    credentials();
    const g = business("needs", []);
    await connect(g, "parcel-co", "shipping", parcelManifest);
    setReasonerForTests(new PlanningReasoner(() => ask("shipping.track", {})));
    const out = await say(g, `a4-${n}`, "Where is my package?");
    expect(out.turn.trace!.steps).toEqual([]);
    expect(out.state.missingFields).toEqual(["trackingNumber"]);
    expect(out.response).toMatch(/tracking number/);
  });
});

describe("PROOF A' — a READ with no authority rule is refused end to end", () => {
  it("the tenant's system is never contacted and nothing is answered from it", async () => {
    credentials();
    const g = business("read-denied", []);
    await connect(g, "parcel-co", "shipping", parcelManifest);
    const sys = createMockHttpSystem(PARCEL_ORIGIN, { "GET /v2/tracking/{trackingNumber}": () => ({ json: { tracking: { number: "ABC", state: "in_transit" } } }) });
    setHttpTransportForTests(sys.transport);
    setReasonerForTests(new PlanningReasoner(() => ask("shipping.track", { trackingNumber: "ABC" })));
    const out = await say(g, `a5-${n}`, "Where is order ABC?");
    expect(out.turn.trace!.steps[0]).toMatchObject({ generic: { capability: "shipping.track", authority: { status: "denied" }, executed: false } });
    expect(out.turn.trace!.stop.reason).toBe("policy_denied");
    expect(out.response).not.toMatch(/in_transit/);
    expect(sys.calls).toHaveLength(0);
    // The model is told it is not permitted, rather than being offered it as available authority.
    expect((await buildCapabilitySurface(g)).find((c) => c.id === "shipping.track")?.authority).toBe("not_permitted");
  });
});

describe("PROOF B — consequential capability, automatically allowed by a bounded rule", () => {
  it("authority allowed -> one idempotent, provider-confirmed side effect -> natural confirmation", async () => {
    credentials();
    const g = business("credit-auto", [rule("credit-small", "billing.credit.issue", "allow", [{ field: "amount", op: "lte", value: 50 }])]);
    await connect(g, "ledger", "billing", ledgerManifest);
    const sys = ledgerSystem();
    setHttpTransportForTests(sys.transport);
    setReasonerForTests(new PlanningReasoner((ctx) => (thisTurn(ctx).length ? undefined : ask("billing.credit.issue", { account: "C-77", amount: 30 }, "goodwill credit"))));

    const conv = `b-${n}`;
    const out = await say(g, conv, "Please credit 30 to account C-77");
    expect(out.turn.trace!.steps[0]).toMatchObject({ generic: { capability: "billing.credit.issue", authority: { status: "allowed", ruleId: "credit-small" }, executed: true, verified: true } });
    expect(out.response).toMatch(/Done — credit id: CR-1/);
    expect(sys.calls).toHaveLength(1);
    expect(sys.calls[0].headers["idempotency-key"]).toMatch(/^bk_/);
    // The same request again in the same conversation is the same call: the system sees the same key.
    await say(g, conv, "Please credit 30 to account C-77");
    expect(sys.calls[1].headers["idempotency-key"]).toBe(sys.calls[0].headers["idempotency-key"]);
  });
});

describe("PROOF C — outside automatic authority: approval, then exactly once", () => {
  async function setup(label: string) {
    credentials();
    const g = business(label, [rule("credit-small", "billing.credit.issue", "allow", [{ field: "amount", op: "lte", value: 50 }]), rule("credit-large", "billing.credit.issue", "require_approval", [{ field: "amount", op: "gt", value: 50 }])]);
    await connect(g, "ledger", "billing", ledgerManifest);
    const sys = ledgerSystem();
    setHttpTransportForTests(sys.transport);
    setReasonerForTests(new PlanningReasoner((ctx) => (thisTurn(ctx).length ? undefined : ask("billing.credit.issue", { account: "C-77", amount: 80 }, "goodwill credit"))));
    const conv = `c-${label}-${n++}`;
    const out = await say(g, conv, "Please credit 80 to account C-77");
    return { g, sys, conv, out };
  }

  it("requires_approval: nothing is executed, the approval is persisted; approval executes once, verified", async () => {
    const { g, sys, out } = await setup("approve");
    expect(out.turn.trace!.steps[0]).toMatchObject({ generic: { authority: { status: "requires_approval", ruleId: "credit-large" }, executed: false } });
    expect(out.turn.trace!.stop.reason).toBe("owner_approval_required");
    expect(out.state.stage).toBe("escalated");
    expect(sys.calls).toHaveLength(0);
    const approvalId = out.state.pendingApprovalId!;
    const approval = await getBackend().getApproval(approvalId);
    expect(approval).toMatchObject({ status: "pending", requestedAction: "invokeCapability", requestedInput: { capability: "billing.credit.issue", input: { account: "C-77", amount: 80 } } });

    const resumed = await resumeAfterApproval(g, approvalId, "approved", "owner@business");
    expect(sys.calls).toHaveLength(1);
    expect(resumed.turn.trace!.steps[0]).toMatchObject({ trigger: "approval", generic: { capability: "billing.credit.issue", executed: true, verified: true } });
    expect(resumed.response).toMatch(/Done — credit id: CR-1/);

    const again = await resumeAfterApproval(g, approvalId, "approved", "owner@business");
    expect(again.response).toMatch(/already approved/);
    expect(sys.calls).toHaveLength(1);
  });

  it("declined never executes; a different call can't ride on the approval; an expired approval doesn't run", async () => {
    const declined = await setup("decline");
    await resumeAfterApproval(declined.g, declined.out.state.pendingApprovalId!, "declined", "owner@business");
    expect(declined.sys.calls).toHaveLength(0);

    const other = await setup("tamper");
    const approvalId = other.out.state.pendingApprovalId!;
    await getBackend().resolveApproval(approvalId, "approved", "owner@business");
    const ctx = { graph: other.g, conversationId: other.conv, customerId: `cust-${other.conv}` };
    const tampered = await callTool("invokeCapability", { capability: "billing.credit.issue", input: { account: "C-77", amount: 800 }, purpose: "x", approvalId }, ctx);
    expect(tampered).toMatchObject({ ok: true, output: { executed: false, code: "not_authorized", reason: "The approved call differs from this one" } });
    const otherConversation = await callTool("invokeCapability", { capability: "billing.credit.issue", input: { account: "C-77", amount: 80 }, purpose: "x", approvalId }, { ...ctx, conversationId: "someone-else" });
    expect(otherConversation).toMatchObject({ ok: true, output: { executed: false, code: "not_authorized" } });
    expect(other.sys.calls).toHaveLength(0);

    const stale = await setup("stale");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await resumeAfterApproval(stale.g, stale.out.state.pendingApprovalId!, "approved", "owner@business");
    expect(stale.sys.calls).toHaveLength(0);
  });
});

describe("PROOF D — an active system and mapping, but no authority: fail closed", () => {
  it("the call is denied before any system is contacted", async () => {
    credentials();
    const g = business("no-authority", []);
    await connect(g, "ledger", "billing", ledgerManifest);
    const sys = ledgerSystem();
    setHttpTransportForTests(sys.transport);
    setReasonerForTests(new PlanningReasoner(() => ask("billing.credit.issue", { account: "C-77", amount: 5 })));
    const out = await say(g, `d-${n}`, "Please credit 5 to account C-77");
    expect(out.turn.trace!.steps[0]).toMatchObject({ generic: { authority: { status: "denied" }, executed: false } });
    expect(out.turn.trace!.stop.reason).toBe("policy_denied");
    expect(out.response).not.toMatch(/Done/);
    expect(sys.calls).toHaveLength(0);
  });
});

describe("PROOF E — one conversation, two domains, the next step chosen from the first result", () => {
  it("shipping.track says delayed -> support.ticket.create -> verified ticket, in one bounded turn", async () => {
    credentials();
    const g = business("cross", [rule("track", "shipping.track", "allow"), rule("tickets", "support.ticket.create", "allow")]);
    await connect(g, "parcel-co", "shipping", parcelManifest);
    await connect(g, "helpdesk", "support", helpdeskManifest);
    const parcel = delayedParcelSystem();
    const desk = helpdeskSystem();
    setHttpTransportForTests(route(parcel.transport, desk.transport));
    setReasonerForTests(
      new PlanningReasoner((ctx) => {
        const last = lastResult(ctx);
        if (!last) return ask("shipping.track", { trackingNumber: "ABC" }, "customer's package hasn't arrived");
        if (last.capability === "shipping.track" && last.output?.status === "delayed") {
          return ask("support.ticket.create", { reference: "ABC", reason: "delivery_delay" }, "delayed shipment: open a case");
        }
        return undefined;
      })
    );
    const out = await say(g, `e-${n}`, "my package ABC still hasn't arrived");
    expect(out.turn.trace!.steps.map((s) => [s.trigger, s.generic?.capability, s.generic?.executed, s.generic?.verified])).toEqual([
      ["customer", "shipping.track", true, false],
      ["continuation", "support.ticket.create", true, true],
    ]);
    expect(out.response).toMatch(/delayed/);
    expect(out.response).toMatch(/T-1/);
    expect(desk.calls).toHaveLength(1);
  });

  it("the continuation is bounded: the same call is never repeated and the step budget holds", async () => {
    credentials();
    const g = business("loop", [rule("track", "shipping.track", "allow")]);
    await connect(g, "parcel-co", "shipping", parcelManifest);
    const parcel = delayedParcelSystem();
    setHttpTransportForTests(parcel.transport);
    setReasonerForTests(new PlanningReasoner(() => ask("shipping.track", { trackingNumber: "ABC" })));
    const out = await say(g, `e2-${n}`, "where is ABC");
    expect(out.turn.trace!.steps).toHaveLength(1);
    expect(out.turn.trace!.stop.reason).toBe("no_safe_next_step");
    expect(parcel.calls).toHaveLength(1);
  });
});

describe("PROOF F — same runtime, same words, different tenants -> different systems and authority", () => {
  it("each business's own system and rules decide", async () => {
    credentials();
    const allowShip = business("tenant-1", [rule("track", "shipping.track", "allow"), rule("ship-ok", "shipping.create_shipment", "allow")]);
    const approveShip = business("tenant-2", [rule("track", "shipping.track", "allow"), rule("ship-approve", "shipping.create_shipment", "require_approval")]);
    await connect(allowShip, "parcel-co", "shipping", parcelManifest);
    await connect(approveShip, "courier", "shipping", { ...courierManifest, operations: [...courierManifest.operations, { ...parcelManifest.operations[1], path: "/api/shipments" }] });
    const parcel = createMockHttpSystem(PARCEL_ORIGIN, { "GET /v2/tracking/{trackingNumber}": ({ params }) => ({ json: { tracking: { number: params.trackingNumber, state: "in_transit" } } }) }, { requireAuth: { header: "authorization", value: "Bearer parcel-secret" } });
    setHttpTransportForTests(route(parcel.transport, courierSystem().transport));
    setReasonerForTests(new PlanningReasoner((ctx) => (thisTurn(ctx).length ? undefined : ask("shipping.track", { trackingNumber: "ABC" }))));
    const one = await say(allowShip, `f1-${n}`, "Where is order ABC?");
    const two = await say(approveShip, `f2-${n}`, "Where is order ABC?");
    expect(one.turn.trace!.steps[0].generic).toMatchObject({ system: "parcel-co" });
    expect(two.turn.trace!.steps[0].generic).toMatchObject({ system: "courier" });
    expect(one.response).toMatch(/in_transit/);
    expect(two.response).toMatch(/out_for_delivery/);

    const s1 = await buildCapabilitySurface(allowShip);
    const s2 = await buildCapabilitySurface(approveShip);
    expect(s1.find((c) => c.id === "shipping.create_shipment")?.authority).toBe("automatic");
    expect(s2.find((c) => c.id === "shipping.create_shipment")?.authority).toBe("owner_approval");
  });
});

describe("PROOF G — the typed flows are not bypassed", () => {
  it("a business running commerce/payments through typed flows is offered no generic commerce or payment capability", async () => {
    const surface = await buildCapabilitySurface(buildFashionRetailerGraph());
    expect(surface.filter((c) => /^(commerce|payments|scheduling)\./.test(c.id))).toEqual([]);
  });
  // The Rina end-to-end flow (rina-e2e.test.ts), the operator loop, payment-claim verification and
  // the Google Calendar adapter suites run unchanged in the full suite.
});

describe("PROOF H — core universality: no vendors, partners or domain branches in the planner path", () => {
  const SRC = path.join(__dirname, "..", "src", "lib");
  const CORE = [
    "runtime/engine.ts",
    "runtime/compiler.ts",
    "runtime/capability-state.ts",
    "reasoner/verify.ts",
    "reasoner/ir.ts",
    "reasoner/schemas.ts",
    "tools/capability-tool.ts",
    "tools/registry.ts",
    "policy/engine.ts",
    "policy/authority.ts",
    "capabilities/surface.ts",
    "capabilities/model.ts",
  ];
  it.each(CORE)("%s names no vendor, partner or new business domain", (rel) => {
    const text = fs.readFileSync(path.join(SRC, rel), "utf8");
    expect(text).not.toMatch(/\b(stripe|pay-?plus|google[- ]?calendar|shopify|wix|woocommerce|custom-commerce|rina)\b/i);
    // New domains arrive as capabilities, never as planner branches.
    expect(text).not.toMatch(/["'`](shipping|support|crm|procurement|inventory|billing|refund|logistics)\.[a-z_]/);
  });
});

describe("HQ shows effective capabilities, authority and generic executions", () => {
  it("surface, rules, and a recent generic call with its authority and system — no input values", async () => {
    credentials();
    const { getBusinessGraph } = await import("@/lib/fixtures");
    const { getHqBusiness } = await import("@/lib/hq/service");
    const { setBusinessGraphResolverForTests } = await import("@/lib/business-graph-repository");
    const g: BusinessGraph = { ...getBusinessGraph("spa"), authority: [rule("track", "shipping.track", "allow")] };
    setBusinessGraphResolverForTests((id) => (id === "spa" ? g : getBusinessGraph(id)));
    await connect(g, "parcel-co", "shipping", parcelManifest);
    setHttpTransportForTests(createMockHttpSystem(PARCEL_ORIGIN, { "GET /v2/tracking/{trackingNumber}": ({ params }) => ({ json: { tracking: { number: params.trackingNumber, state: "in_transit" } } }) }, { requireAuth: { header: "authorization", value: "Bearer parcel-secret" } }).transport);
    setReasonerForTests(new PlanningReasoner((ctx) => (thisTurn(ctx).length ? undefined : ask("shipping.track", { trackingNumber: "ABC123" }))));
    await say(g, `hq-${n}`, "Where is order ABC123?");

    const hq = await getHqBusiness("spa");
    expect(hq!.capabilitySurface).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ id: "shipping.track", authority: "automatic" })]) });
    expect(hq!.authorityRules).toEqual([expect.objectContaining({ id: "track", capability: "shipping.track", effect: "allow" })]);
    setBusinessGraphResolverForTests(undefined);
    const turns = hq!.recentTurns.ok ? hq!.recentTurns.value : [];
    expect(turns.flatMap((t) => t.capabilities)).toContainEqual(expect.objectContaining({ capability: "shipping.track", authority: "allowed", system: "parcel-co", executed: true }));
    expect(hq!.health).toMatchObject({ ok: true, value: expect.objectContaining({ capabilityCalls: 1, capabilityRefused: 0 }) });
    expect(JSON.stringify(turns)).not.toContain("ABC123");
  });
});
