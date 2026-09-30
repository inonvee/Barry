import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { getBusinessGraph, TEST_BUSINESS_IDS } from "@/lib/fixtures";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { createInitialConversationState } from "@/lib/state";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { buildUnderstandingContext, classifyProviderError, OpenAIReasoner, parseIRResponse, sanitizeProviderMessage } from "@/lib/reasoner/openai-reasoner";
import { irJsonSchema } from "@/lib/reasoner/schemas";
import { readLedger } from "@/lib/runtime/ledger";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { setReasonerForTests, type BarryIR, type ComposeResponseInput, type ModelCallFailure, type Reasoner, type ReasonerContext, type UnderstandingResult } from "@/lib/reasoner";
import type { BusinessGraph } from "@/lib/business-graph";

/**
 * PASS #4 (commit 6afff0b, live attack). F32 first: understanding that failed was compiled as an
 * empty IR (-> ask_general + offer list) with the reason discarded; that same silent failure left a
 * stale approval active (F31). Assertions are on the trace, the ledger, approval state and the
 * provider — the model's words are scripted to reproduce the live ones.
 */

const RATE_LIMITED: ModelCallFailure = { kind: "provider_rate_limited", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached for requests", transient: true };

type Plan = Partial<BarryIR> | "FAIL" | undefined;
class ScriptedModel implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "scripted";
  constructor(
    public plan: (ctx: ReasonerContext) => Plan,
    public write: (input: ComposeResponseInput) => string = composeDeterministic,
    public composerFails = false
  ) {}
  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    return (await this.understandDetailed(ctx)).ir;
  }
  async understandDetailed(ctx: ReasonerContext): Promise<UnderstandingResult> {
    const p = this.plan(ctx);
    const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
    if (p === "FAIL") return { ir: { intent: "understanding_failed", entities: {}, constraints: {}, customerInfo: {} }, valid: false, attempts: 1, failure: RATE_LIMITED, latencyMs: 3, usage, model: this.model };
    const q = p ?? {};
    return { ir: { intent: "scripted", entities: {}, customerInfo: {}, ...q, constraints: { ...(q.constraints ?? {}) } } as BarryIR, valid: true, attempts: 1, latencyMs: 3, usage, model: this.model };
  }
  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    if (this.composerFails) {
      ctx.diagnostics?.composerFailures.push(RATE_LIMITED);
      return composeDeterministic(input);
    }
    return this.write(input);
  }
}

let n = 0;
const conv = (p: string) => `p4-${p}-${Date.now()}-${n++}`;
const approvalsOf = async (g: BusinessGraph, id: string) => (await getBackend().listApprovals(g.business.id)).filter((a) => a.conversationId === id);

let rinaId = "";
function rina(): { g: BusinessGraph; commerce: MemoryCommerceAdapter } {
  rinaId = `p4-rina-${Date.now()}-${n++}`;
  const commerce = new MemoryCommerceAdapter(fashionCatalog());
  registerCommerceAdapterFactoryForTests(rinaId, () => commerce);
  setPaymentAdapterForTests(new MemoryPaymentAdapter());
  const base = buildFashionRetailerGraph();
  return { g: { ...base, business: { ...base.business, id: rinaId } }, commerce };
}

afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
  if (rinaId) registerCommerceAdapterFactoryForTests(rinaId, undefined);
  setPaymentAdapterForTests(undefined);
});

const ticket = (reference: string, reason = "delivery_delay") => ({ capabilityRequest: { capability: "support.ticket.create", input: { reference, reason }, purpose: "case" }, advancesTransaction: true });

// ── 1-3. F32: the understanding contract ──────────────────────────────

/** A value for every field the wire schema allows — random nullability, enum choice, string length. */
function sampleFromSchema(schema: Record<string, unknown>, rnd: () => number): unknown {
  const types = ([] as unknown[]).concat(schema.type ?? []) as string[];
  const enumValues = schema.enum as unknown[] | undefined;
  const nonNull = types.filter((t) => t !== "null");
  if (types.includes("null") && rnd() < 0.35) return null;
  if (enumValues) {
    const options = enumValues.filter((v) => v !== null);
    return options[Math.floor(rnd() * options.length)];
  }
  switch (nonNull[0]) {
    case "object": {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sampleFromSchema(v, rnd)]));
    }
    case "array":
      return Array.from({ length: Math.floor(rnd() * 3) }, () => sampleFromSchema(schema.items as Record<string, unknown>, rnd));
    case "number":
      return Math.round(rnd() * 1000) / 10;
    case "boolean":
      return rnd() < 0.5;
    default:
      return "x".repeat(1 + Math.floor(rnd() * 700));
  }
}

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe("F32 — every response the wire schema allows is a valid understanding", () => {
  it("200 random schema-valid responses parse WITHOUT salvage, on every fixture (no hidden stricter-than-the-wire rule)", () => {
    const schema = irJsonSchema().schema as Record<string, unknown>;
    for (const id of TEST_BUSINESS_IDS) {
      const graph = getBusinessGraph(id);
      const rnd = seeded(id.length * 7919);
      for (let i = 0; i < 200; i++) {
        const raw = sampleFromSchema(schema, rnd);
        const r = parseIRResponse(graph, JSON.stringify(raw));
        expect(r.ok, `${id} #${i}`).toBe(true);
        if (r.ok) expect(r.salvagedFields, `${id} #${i}`).toBeUndefined();
      }
    }
  });

  it("a long capability purpose (legal on the wire) keeps the capability request — bounded, not discarded", () => {
    const graph = buildLogisticsDemoGraph();
    const schema = irJsonSchema().schema as Record<string, unknown>;
    const raw = sampleFromSchema(schema, seeded(1)) as Record<string, unknown>;
    raw.capabilityRequest = { capability: "support.ticket.create", inputJson: '{"reference":"Q4-C301"}', purpose: "p".repeat(900) };
    const r = parseIRResponse(graph, JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ir.capabilityRequest?.capability).toBe("support.ticket.create");
      expect(r.ir.capabilityRequest?.purpose.length).toBe(300);
    }
  });
});

describe("F32 — one malformed field never destroys the whole understanding", () => {
  const base = () => sampleFromSchema(irJsonSchema().schema as Record<string, unknown>, seeded(42)) as Record<string, unknown>;

  it("a malformed informational field is dropped and recorded; everything else survives", () => {
    const raw = { ...base(), intent: "shipping_policy_question", knowledgeTopic: 42, readRequested: true };
    const r = parseIRResponse(buildLogisticsDemoGraph(), JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ir.intent).toBe("shipping_policy_question");
      expect(r.ir.readRequested).toBe(true);
      expect(r.salvagedFields).toEqual(["knowledgeTopic"]);
      expect(r.failClosed).toBeUndefined();
    }
  });

  it("a malformed DECISION field (quantity) is dropped and the turn fails closed: it can't advance or consent", () => {
    const raw = { ...base(), intent: "buy", advancesTransaction: true, checkoutConsent: true, constraints: { ...(base().constraints as object), quantity: "two" } };
    const r = parseIRResponse(buildFashionRetailerGraph(), JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.salvagedFields).toEqual(["constraints.quantity"]);
      expect(r.failClosed).toBe(true);
      expect(r.ir.advancesTransaction).toBe(false);
      expect(r.ir.checkoutConsent).toBe(false);
      expect(r.ir.intent).toBe("buy");
    }
  });

  it("an invalid list item is removed, the rest of the list kept", () => {
    const raw = { ...base(), entities: [{ key: "reference", value: "Q4-A101" }, { key: 7 }, { key: "reason", value: "missing" }] };
    const r = parseIRResponse(buildLogisticsDemoGraph(), JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ir.entities).toEqual({ reference: "Q4-A101", reason: "missing" });
  });

  it("what can't be salvaged (no intent, not an object) still fails — never a silently invented understanding", () => {
    const noIntent = base();
    delete noIntent.intent;
    expect(parseIRResponse(buildLogisticsDemoGraph(), JSON.stringify(noIntent)).ok).toBe(false);
    expect(parseIRResponse(buildLogisticsDemoGraph(), "[1,2]").ok).toBe(false);
  });
});

describe("F32 — provider failures are classified, sanitized, and not blindly retried", () => {
  it("classifies rate limit / quota / 5xx / timeout / rejected request, and strips secrets", () => {
    expect(classifyProviderError(Object.assign(new Error("Rate limit reached"), { status: 429, code: "rate_limit_exceeded" }))).toMatchObject({ kind: "provider_rate_limited", status: 429, transient: true });
    expect(classifyProviderError(Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" }))).toMatchObject({ kind: "provider_quota_exhausted", transient: false });
    expect(classifyProviderError(Object.assign(new Error("upstream"), { status: 503 }))).toMatchObject({ kind: "provider_unavailable", transient: true });
    expect(classifyProviderError(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }))).toMatchObject({ kind: "provider_timeout" });
    expect(classifyProviderError(Object.assign(new Error("Invalid schema for response_format"), { status: 400, code: "invalid_request_error" }))).toMatchObject({ kind: "provider_rejected_request", transient: false });
    expect(sanitizeProviderMessage("Incorrect API key provided: sk-proj-abcdef123456 for org-AbCdEf123456")).not.toMatch(/abcdef123456|AbCdEf123456/);
  });

  const withClient = (create: (params: unknown) => Promise<unknown>) => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    const r = new OpenAIReasoner({ model: "gpt-4o-mini", composerModel: "gpt-4o-mini" });
    process.env.OPENAI_API_KEY = prev;
    (r as unknown as { client: unknown }).client = { chat: { completions: { create } } };
    return r;
  };
  const ctx = (): ReasonerContext => {
    const graph = buildLogisticsDemoGraph();
    return { graph, state: createInitialConversationState("c", graph.business.id, "cust"), customerMessage: "How long does normal delivery take?" };
  };
  const completion = (content: string) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

  it("a provider error is reported with its classification and is not re-asked (the SDK already backed off)", async () => {
    let calls = 0;
    const r = withClient(async () => {
      calls++;
      throw Object.assign(new Error("Rate limit reached for gpt-x"), { status: 429, code: "rate_limit_exceeded" });
    });
    const u = await r.understandDetailed(ctx());
    expect(calls).toBe(1);
    expect(u).toMatchObject({ valid: false, attempts: 1, failure: { kind: "provider_rate_limited", status: 429, code: "rate_limit_exceeded" } });
  });

  it("malformed output gets ONE corrective re-ask carrying the validation issue", async () => {
    const good = JSON.stringify({ ...(sampleFromSchema(irJsonSchema().schema as Record<string, unknown>, seeded(9)) as object), intent: "delivery_time_question" });
    const seen: string[] = [];
    let calls = 0;
    const r = withClient(async (params) => {
      calls++;
      seen.push(JSON.stringify(params));
      return completion(calls === 1 ? "{not json" : good);
    });
    const u = await r.understandDetailed(ctx());
    expect(u).toMatchObject({ valid: true, attempts: 2, failure: { kind: "json_parse_error" } });
    expect(u.ir.intent).toBe("delivery_time_question");
    expect(seen[1]).toMatch(/previous response was invalid/);
  });
});

describe("F32 — a failed understanding is an explicit, truthful turn: never ask_general, never an action", () => {
  it("the Inspector trace carries the classified reason; the reply says nothing was processed; nothing is compiled or executed", async () => {
    const g = getBusinessGraph("ecommerce-bags");
    setReasonerForTests(new ScriptedModel(() => "FAIL", composeDeterministic, true));
    const id = conv("bags");
    const out = await handleCustomerMessage(g, id, "c", "How much is the Weekender, and is it under 130?");
    expect(out.turn.trace?.understanding).toMatchObject({ valid: false, failure: { kind: "provider_rate_limited", status: 429, code: "rate_limit_exceeded" } });
    expect(out.turn.trace?.stop).toMatchObject({ reason: "understanding_unavailable", outcome: "provider_rate_limited" });
    expect(out.turn.trace?.steps).toHaveLength(0);
    expect(out.response).not.toMatch(/What can I help you with|We offer/);
    expect(out.response).toMatch(/couldn't process your last message/);
    expect(out.response).toMatch(/haven't changed or sent anything/);
    expect(readLedger(out.state).map((e) => e.effect)).toEqual(["understanding.failed"]);
  });

  it("a composer call that fails is visible in the trace (not only a silently plainer reply)", async () => {
    const g = getBusinessGraph("ecommerce-bags");
    setReasonerForTests(new ScriptedModel(() => ({ advancesTransaction: false }), composeDeterministic, true));
    const out = await handleCustomerMessage(g, conv("composer"), "c", "hi");
    expect(out.turn.trace?.understanding).toMatchObject({ valid: true });
    expect(out.turn.trace?.reply?.composerFailures?.[0]).toMatchObject({ kind: "provider_rate_limited", status: 429 });
  });

  it("long conversations: history sent to the model is bounded, and a failure at turn 40 neither poisons nor hides turn 41", async () => {
    const g = buildLogisticsDemoGraph();
    const id = conv("long");
    let turn = 0;
    const model = new ScriptedModel(() => (++turn === 40 ? "FAIL" : { advancesTransaction: false, readRequested: false }));
    setReasonerForTests(model);
    let last;
    for (let i = 1; i <= 41; i++) last = await handleCustomerMessage(g, id, "c", `question number ${i} about delivery times for my parcel`);
    const t40 = last!.state.turns[39];
    expect(t40.trace?.understanding?.valid).toBe(false);
    expect(last!.turn.trace?.understanding?.valid).toBe(true);
    expect(last!.turn.understood.signals).toMatchObject({ advancesTransaction: false, readRequested: false });
    const small = JSON.stringify(buildUnderstandingContext({ graph: g, state: { ...last!.state, messages: last!.state.messages.slice(-4) }, customerMessage: "x" })).length;
    const full = JSON.stringify(buildUnderstandingContext({ graph: g, state: last!.state, customerMessage: "x" })).length;
    expect(full - small).toBeLessThan(4000);
  });
});

// ── 4. F31: a stale approval never executes after a newer correction ──

describe("F31 — a pending approval is revalidated against what the customer said after it", () => {
  const setup = async (plan: (ctx: ReasonerContext) => Plan) => {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel(plan);
    setReasonerForTests(model);
    const id = conv("stale");
    return { g, id, model };
  };

  it("live F31: C301 requested -> 'Wait C302, not 301…' fails to parse -> owner approves -> NOTHING executes, the request is held, the customer is asked", async () => {
    const { g, id } = await setup((ctx) => (/C302/.test(ctx.customerMessage) ? "FAIL" : ticket("Q4-C301")));
    await handleCustomerMessage(g, id, "c", "Different parcel Q4-C301 now, delayed. Create one owner approval for a delay case only.");
    const [pending] = await approvalsOf(g, id);
    const t10 = await handleCustomerMessage(g, id, "c", "Wait C302, not301. Correct reference and change reason to damaged instead of delayed; replace the pending one now.");
    expect(t10.response).toMatch(/on hold until you confirm/);
    const held = await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(0);
    expect((await approvalsOf(g, id))[0].status).toBe("pending");
    expect(held.turn.trace?.stop.reason).toBe("approval_held_customer_intent_unverified");
    expect(held.response).toMatch(/Before I go ahead/);
    const [view] = withLifecycle(await approvalsOf(g, id), new Map([[id, held.state]]));
    expect(view).toMatchObject({ lifecycle: "held", hold: { reason: "understanding_unverified" } });
  });

  it("even when the correction IS understood but the model's signals miss it, a near-miss reference holds the stale request", async () => {
    const { g, id } = await setup((ctx) => (/C302/.test(ctx.customerMessage) ? { advancesTransaction: null as unknown as undefined } : ticket("Q4-C301")));
    await handleCustomerMessage(g, id, "c", "Different parcel Q4-C301 now, delayed.");
    const [pending] = await approvalsOf(g, id);
    await handleCustomerMessage(g, id, "c", "Wait C302, not301.");
    const held = await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(0);
    expect(held.turn.trace?.hold?.reason).toMatch(/C302/);
    expect(held.response).toMatch(/C302/);
  });

  it("a hold ends when a validly understood turn reaffirms the same request — then it executes exactly once", async () => {
    const { g, id, model } = await setup((ctx) => (/C302/.test(ctx.customerMessage) ? "FAIL" : ticket("Q4-C301")));
    await handleCustomerMessage(g, id, "c", "Parcel Q4-C301 delayed, open a delay case.");
    const [pending] = await approvalsOf(g, id);
    await handleCustomerMessage(g, id, "c", "Wait C302?");
    model.plan = () => ticket("Q4-C301");
    await handleCustomerMessage(g, id, "c", "Sorry, ignore that — it really is Q4-C301, delay case as requested.");
    expect(await approvalsOf(g, id)).toHaveLength(1);
    await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(1);
  });

  it("unrelated references (a different parcel) and the request's own reference never hold it", async () => {
    const { g, id } = await setup((ctx) => (/B201|same/i.test(ctx.customerMessage) ? { advancesTransaction: false } : ticket("Q4-A102", "missing_item")));
    await handleCustomerMessage(g, id, "c", "Q4-A102 is missing, please open a case");
    const [pending] = await approvalsOf(g, id);
    await handleCustomerMessage(g, id, "c", "Any movement on the same A102 request? Also Q4-B201 is fine.");
    await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(1);
  });

  it("the owner can still DECLINE a held request", async () => {
    const { g, id } = await setup((ctx) => (/C302/.test(ctx.customerMessage) ? "FAIL" : ticket("Q4-C301")));
    await handleCustomerMessage(g, id, "c", "Q4-C301 delayed");
    const [pending] = await approvalsOf(g, id);
    await handleCustomerMessage(g, id, "c", "C302!");
    await resumeAfterApproval(g, pending.id, "declined", "owner");
    expect((await approvalsOf(g, id))[0].status).toBe("declined");
    expect(demoHelpdeskTickets()).toHaveLength(0);
  });

  it("F28: changed terms with no replacement in the first understanding -> one continuation proposes it; exactly one active revision with the new reference", async () => {
    const { g, id } = await setup((ctx) =>
      ctx.grounded?.replacingRequests?.length ? ticket("Q4-A102", "missing_item") : /A102/.test(ctx.customerMessage) ? { changesPendingRequest: true, advancesTransaction: true } : ticket("Q4-A101", "missing_item")
    );
    await handleCustomerMessage(g, id, "c", "Parcel Q4-A101 never arrived, request ONE support ticket");
    const out = await handleCustomerMessage(g, id, "c", "Tiny typo: replace pending A101 with Q4-A102, same missing parcel.");
    const active = (await approvalsOf(g, id)).filter((a) => a.status === "pending");
    expect(active).toHaveLength(1);
    expect(JSON.stringify(active[0].requestedInput)).toContain("Q4-A102");
    expect(out.response).not.toMatch(/nothing is waiting on the owner/i);
  });
});

// ── 5. F24: variant replacement with a new provider line id ───────────

describe("F24 — the provider's returned cart is authoritative for a variant change", () => {
  it("Midnight M -> L ×2 (new line id) is recorded as an effected change with before/after, not change_not_verified", async () => {
    const { g, commerce } = rina();
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("variant");
    model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
    const search = await handleCustomerMessage(g, id, "c", "שמלות שחורות");
    const titles = search.rich?.products?.map((p) => p.title) ?? [];
    const pos = (t: string) => titles.indexOf(t);
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: pos("Midnight Wrap Dress") }, variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "Midnight M אחת לסל");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: pos("Onyx Slip Dress") }, variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
    const before = await handleCustomerMessage(g, id, "c", "וגם Onyx M אחת");
    const cartId = before.state.knownFields.__commerceCartId;
    const oldLineId = (await commerce.getCart(cartId))!.lines.find((l) => l.title === "Midnight Wrap Dress")!.id;

    model.plan = () => ({ commerce: { intent: "change_variant", reference: { type: "cart_line", index: 0 }, variant: { size: "L" }, quantity: 2 }, checkoutConsent: false, advancesTransaction: true });
    model.write = () => "עדכנתי: Midnight Wrap Dress (L / black), שתי יחידות.";
    const out = await handleCustomerMessage(g, id, "c", "תשני רק את Midnight לL וכמות 2. לא קופה.");
    const cart = (await commerce.getCart(cartId))!;
    const midnight = cart.lines.find((l) => l.title === "Midnight Wrap Dress")!;
    expect(midnight.id).not.toBe(oldLineId);
    expect(midnight).toMatchObject({ quantity: 2, options: { size: "L" } });
    const receipt = readLedger(out.state).filter((e) => e.operation === "updateCartLine").at(-1)!;
    expect(receipt).toMatchObject({ effect: "cart.line_updated", status: "effected", terms: { item: "Midnight Wrap Dress (M / black)", itemAfter: "Midnight Wrap Dress (L / black)", quantityBefore: 1, quantityAfter: 2 } });
    expect(out.response).toMatch(/עדכנתי/);
  });
});

// ── 6-7. Reply truth after partial work and blocked writes ───────────

describe("F23 / F25 — the reply never narrates an action no effect shows this turn", () => {
  const cartWithMidnight = async () => {
    const { g } = rina();
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("partial");
    model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
    const search = await handleCustomerMessage(g, id, "c", "שמלות שחורות");
    const titles = search.rich?.products?.map((p) => p.title) ?? [];
    return { g, model, id, pos: (t: string) => titles.indexOf(t) };
  };

  it("F23 live: two items asked, only Midnight added — 'now I'm adding Onyx' never reaches the customer; the reply says what was done", async () => {
    const { g, model, id, pos } = await cartWithMidnight();
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: pos("Midnight Wrap Dress") }, variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
    model.write = () => "הוספתי לסל את השמלה Midnight Wrap Dress במידה M בצבע שחור. עכשיו אני מוסיף את השמלה Onyx Slip Dress במידה M בצבע שחור.";
    const out = await handleCustomerMessage(g, id, "c", "הראשונה Midnight שחור M אחת לסל, ואז Onyx שחור M אחת גם. שתי שורות נפרדות. בלי קופה ובלי תשלום");
    expect(readLedger(out.state).filter((e) => e.effect === "cart.line_added")).toHaveLength(1);
    expect(out.response).not.toMatch(/מוסיף את השמלה Onyx/);
    expect(out.response).toMatch(/Midnight/);
    expect(out.turn.trace?.reply?.fallback).toMatch(/narrates adding Onyx Slip Dress/);
  });

  it("F25 live: the gate blocks an out-of-scope checkout — the reply is the block, never 'I added the Onyx'", async () => {
    const { g, model, id, pos } = await cartWithMidnight();
    const add = (t: string): Partial<BarryIR> => ({ commerce: { intent: "select", reference: { type: "previous_result", index: pos(t) }, variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
    model.plan = () => add("Midnight Wrap Dress");
    await handleCustomerMessage(g, id, "c", "Midnight M לסל");
    model.plan = () => add("Onyx Slip Dress");
    await handleCustomerMessage(g, id, "c", "Onyx M לסל");
    model.plan = () => ({ commerce: { intent: "checkout", reference: { type: "cart_line", index: 1 }, quantity: 1 }, checkoutConsent: true, advancesTransaction: true, customerInfo: { name: "נועה", phone: "0505550124" }, evidence: { "customerInfo.name": "נועה", "customerInfo.phone": "050-555-0124" } });
    model.write = () => "הוספתי לסל את השמלה Onyx Slip Dress במידה M אחת, אבל לא יכולתי להמשיך לתשלום כי הסכום הכולל גבוה מהתקציב שלך.";
    const out = await handleCustomerMessage(g, id, "c", "יש שתי שורות, אבל הסכמה לקופה רק Onyx M אחת, לא הMidnight. נועה 050-555-0124");
    expect(out.turn.trace?.effects?.map((e) => e.effect)).toContain("write.blocked");
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(out.response).not.toMatch(/הוספתי/);
    expect(out.response).toMatch(/Midnight/);
    expect(out.turn.trace?.reply?.fallback).toBe("write blocked -> deterministic");
  });

  it("F30 live: 'I'll ask the owner… I'll update you once I hear back' with NO request waiting never reaches the customer", async () => {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel(() => ({ advancesTransaction: false }));
    model.write = () => "I've noted that the new parcel Q4-B201 arrived damaged. I'll ask the owner to open a separate case for this damaged item. I'll update you once I hear back about the damaged item case.";
    setReasonerForTests(model);
    const out = await handleCustomerMessage(g, conv("promise"), "c", "New parcel Q4-B201 arrived crushed. Ask owner for a separate damaged-item case.");
    expect(await approvalsOf(g, out.state.id)).toHaveLength(0);
    expect(out.response).not.toMatch(/I'll ask the owner|once I hear back/);
  });
});

// ── 8. Status / recall questions read state only ──────────────────────

describe("status and recall questions read existing state — they never create a transaction", () => {
  it("'opened, declined or still queued? which reference owns T-1001?' — no new approval, no new effect, the answer is from records", async () => {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel((ctx) => (/status|opened|declined|reference/i.test(ctx.customerMessage) ? { advancesTransaction: false } : /A102/.test(ctx.customerMessage) ? ticket("Q4-A102", "missing_item") : ticket("Q4-B201", "damaged_item")));
    setReasonerForTests(model);
    const id = conv("status");
    await handleCustomerMessage(g, id, "c", "Q4-A102 missing, open a case");
    const [a102] = await approvalsOf(g, id);
    await resumeAfterApproval(g, a102.id, "approved", "owner");
    await handleCustomerMessage(g, id, "c", "Q4-B201 arrived damaged, open a case");
    const approvalsBefore = (await approvalsOf(g, id)).length;
    const ledgerBefore = readLedger((await handleCustomerMessage(g, id, "c", "status please")).state).length;
    const out = await handleCustomerMessage(g, id, "c", "Tell me whether B201 was opened, declined or still in some queue. And which reference owns T-1001?");
    expect((await approvalsOf(g, id)).length).toBe(approvalsBefore);
    expect(readLedger(out.state).length).toBe(ledgerBefore);
    expect(out.turn.trace?.steps).toHaveLength(0);
    expect(out.response).toMatch(/T-1001/);
    expect(out.response).toMatch(/Q4-A102/);
    expect(out.response).toMatch(/Q4-B201[^.]*waiting/);
  });

  it("even when understanding fails, the reply states where things stand from records (not a greeting)", async () => {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel((ctx) => (/queue/.test(ctx.customerMessage) ? "FAIL" : ticket("Q4-A102", "missing_item")));
    setReasonerForTests(model);
    const id = conv("status-fail");
    await handleCustomerMessage(g, id, "c", "Q4-A102 missing, open a case");
    const [a102] = await approvalsOf(g, id);
    await resumeAfterApproval(g, a102.id, "approved", "owner");
    const out = await handleCustomerMessage(g, id, "c", "was it opened or still in some queue?");
    expect(out.response).toMatch(/T-1001/);
    expect(out.response).not.toMatch(/What can I help you with/);
  });
});

// ── 9. Business-fact provenance ───────────────────────────────────────

describe("F26 — unsupported business facts stay unknown", () => {
  it("Rina has no hours in its Genome: 'open Friday 09:00–12:00' never reaches the customer", async () => {
    const { g } = rina();
    const model = new ScriptedModel(() => ({ advancesTransaction: false }));
    model.write = () => "כן, אנחנו פתוחים ביום שישי בין 09:00 ל-12:00. אם את מתלבטת, את מוזמנת לבוא!";
    setReasonerForTests(model);
    const out = await handleCustomerMessage(g, conv("hours"), "c", "אתם פתוחים שישי? מתלבטת אם לבוא, אל תקבעי לי שום דבר");
    expect(out.response).not.toMatch(/09:00|12:00/);
    expect(out.turn.trace?.reply?.fallback).toMatch(/states a time/);
  });

  it("the Spa's own hours may be stated exactly as its Genome has them", async () => {
    const g = getBusinessGraph("spa");
    const model = new ScriptedModel(() => ({ advancesTransaction: false }));
    model.write = () => "Yes — on Fridays we're open 09:00 to 20:00.";
    setReasonerForTests(model);
    const out = await handleCustomerMessage(g, conv("spa-hours"), "c", "are you open friday?");
    expect(out.response).toBe("Yes — on Fridays we're open 09:00 to 20:00.");
  });
});
