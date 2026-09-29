import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { manifestConnection } from "@/lib/fabric/registry";
import { setHttpTransportForTests, type HttpTransport } from "@/lib/fabric/connectors/http";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { getBusinessGraph, TEST_BUSINESS_IDS, buildSpaGraph } from "@/lib/fixtures";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { buildUnderstandingContext, composeSummaryFor } from "@/lib/reasoner/openai-reasoner";
import { findInternalLeak, internalVocabulary } from "@/lib/reasoner/reply-hygiene";
import { listTools } from "@/lib/tools";
import { setReasonerForTests, type BarryIR, type ComposeResponseInput, type Reasoner, type ReasonerContext } from "@/lib/reasoner";
import type { BusinessGraph } from "@/lib/business-graph";
import { courierManifest, courierSystem, parcelManifest, PARCEL_ORIGIN } from "./support/test-domains";
import { createMockHttpSystem } from "./support/mock-http-system";

/**
 * HUMAN CONVERSATION — deterministic evals.
 *
 * These prove the STRUCTURE that makes BARRY sound like an employee rather than a workflow:
 * what the composer is given (identity, conversation, what the business can do, a customer-safe
 * approval state), what it is never given (rule text, rule ids, systems), the reply hygiene guard,
 * long-conversation continuity, provider independence and cross-business behavior — all while the
 * safety/state invariants hold. No assertion pins exact wording; the QUALITY of the model's words is
 * judged by the live suite (human-conversation-live.test.ts) with an explicit rubric.
 */

type Summary = ReturnType<typeof composeSummaryFor>;

/** A test model: plans from what it is shown; composes with a supplied writer; records what it saw. */
class ScriptedModel implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "scripted";
  readonly summaries: Summary[] = [];
  readonly understood: ReturnType<typeof buildUnderstandingContext>[] = [];
  private readonly baseline = new Map<string, number>();
  constructor(
    private readonly plan: (ctx: ReasonerContext, fresh: { capability: string; output?: Record<string, unknown> }[]) => Partial<BarryIR> | undefined,
    private readonly write: (input: ComposeResponseInput) => string = composeDeterministic
  ) {}
  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const key = `${ctx.state.id}:${ctx.state.messages.length}`;
    if (!this.baseline.has(key)) this.baseline.set(key, ctx.grounded?.capabilityResults?.length ?? 0);
    const fresh = (ctx.grounded?.capabilityResults ?? []).slice(this.baseline.get(key)) as { capability: string; output?: Record<string, unknown> }[];
    this.understood.push(buildUnderstandingContext(ctx));
    return { intent: "scripted", entities: {}, constraints: {}, customerInfo: {}, ...(this.plan(ctx, fresh) ?? {}) } as BarryIR;
  }
  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    this.summaries.push(composeSummaryFor(ctx, input));
    return this.write(input);
  }
}

const ask = (capability: string, input: Record<string, unknown>, purpose = "customer asked"): Partial<BarryIR> => ({ capabilityRequest: { capability, input, purpose } });
/** Plan: track the first tracking-number-looking token in the message, once per turn. */
const trackFromMessage = (ctx: ReasonerContext, fresh: unknown[]) => {
  const ref = ctx.customerMessage.match(/\b[A-Z]{3}\d{3}\b/)?.[0];
  return ref && fresh.length === 0 ? ask("shipping.track", { trackingNumber: ref }) : undefined;
};

let n = 0;
const conv = (p: string) => `hc-${p}-${Date.now()}-${n++}`;

afterEach(() => {
  setReasonerForTests(undefined);
  setHttpTransportForTests(undefined);
  resetDemoHelpdeskForTests();
});

const HEBREW = /\p{Script=Hebrew}/u;
const RULE_TEXT = /Every support case is approved|demo-tickets-need-approval|demo-track-allowed/;

describe("the composer is given what an employee would know", () => {
  it("business identity, the conversation so far, and what the business can do — never ids, systems or rules", async () => {
    const model = new ScriptedModel(trackFromMessage);
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("ctx");
    await handleCustomerMessage(g, id, "c1", "hi there");
    await handleCustomerMessage(g, id, "c1", "where is ABC123?");
    const s = model.summaries.at(-1)!;
    expect(s.business?.name).toBe(g.business.name);
    expect(s.recentConversation.map((m) => m.from)).toEqual(["customer", "business"]);
    expect(s.recentConversation[0].text).toBe("hi there");
    expect(s.lastCustomerMessage).toBe("where is ABC123?");
    expect(s.whatTheBusinessCanDo?.canHelpWith.filter((c) => /shipment/i.test(c))).toHaveLength(1);
    expect(s.whatTheBusinessCanDo?.canHelpWith.some((c) => /support case/i.test(c))).toBe(false);
    expect(s.whatTheBusinessCanDo?.withOwnerSignOff.length).toBe(1);
    const json = JSON.stringify(s.whatTheBusinessCanDo) + JSON.stringify(s.business);
    expect(json).not.toMatch(/shipping\.track|support\.ticket|demo-mock|connector|credential/);
    expect(JSON.stringify(s)).not.toMatch(RULE_TEXT);
  });

  it("an owner approval reaches the composer as state, never as the rule that required it", async () => {
    const model = new ScriptedModel((ctx, fresh) =>
      fresh.length === 0 && /complaint|תלונה/.test(ctx.customerMessage) ? ask("support.ticket.create", { reference: "ABC123", reason: "delivery_delay" }) : trackFromMessage(ctx, fresh)
    );
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("appr");
    const out = await handleCustomerMessage(g, id, "c1", "ABC123 is late, please open a complaint");
    expect(out.turn.trace!.steps[0].generic?.authority.status).toBe("requires_approval");
    const s = model.summaries.at(-1)!;
    expect(s.ownerApproval).toEqual({ requestedNow: true, customerWillHearBackHere: true });
    expect(JSON.stringify(s)).not.toMatch(RULE_TEXT);
    expect(out.response).not.toMatch(RULE_TEXT);
    // The owner still sees exactly why (trace keeps the rule).
    expect(out.turn.trace!.steps[0].generic?.authority).toMatchObject({ ruleId: "demo-tickets-need-approval" });

    // Next turn: BARRY knows it is still waiting — understanding and composition both.
    await handleCustomerMessage(g, id, "c1", "any news?");
    expect(model.understood.at(-1)!.awaitingOwnerApproval).toBe(true);
    expect(model.summaries.at(-1)!.ownerApproval).toEqual({ requestedEarlier: true, stillWaiting: true });
    expect(demoHelpdeskTickets()).toHaveLength(0);
  });

  it("the owner's decision comes back in the conversation's language, and the waiting state clears", async () => {
    for (const decision of ["approved", "declined"] as const) {
      const model = new ScriptedModel((ctx, fresh) => (fresh.length === 0 && /תלונה/.test(ctx.customerMessage) ? ask("support.ticket.create", { reference: "ABC123", reason: "delivery_delay" }) : undefined));
      setReasonerForTests(model);
      const g = buildLogisticsDemoGraph();
      const id = conv(`dec-${decision}`);
      const out = await handleCustomerMessage(g, id, "c1", "החבילה ABC123 מתעכבת, תפתחו תלונה בבקשה");
      expect(HEBREW.test(out.response)).toBe(true);
      const approval = (await getBackend().listApprovals(g.business.id)).find((a) => a.conversationId === id)!;
      const resumed = await resumeAfterApproval(g, approval.id, decision, "owner");
      expect(HEBREW.test(resumed.response)).toBe(true);
      expect(resumed.response).not.toMatch(RULE_TEXT);
      const s = model.summaries.at(-1)!;
      expect(s.ownerDecision).toBe(decision);
      expect(s.ownerApproval).toBeNull();
      expect(resumed.state.pendingApprovalId).toBeNull();
      expect(demoHelpdeskTickets()).toHaveLength(decision === "approved" ? 1 : 0);
      // Idempotent: resolving again never acts twice.
      await resumeAfterApproval(g, approval.id, "approved", "owner");
      expect(demoHelpdeskTickets()).toHaveLength(decision === "approved" ? 1 : 0);
      resetDemoHelpdeskForTests();
    }
  });

  it("a refusal says what it means for the customer — the denying rule stays internal", async () => {
    const model = new ScriptedModel(trackFromMessage);
    setReasonerForTests(model);
    const base = buildLogisticsDemoGraph();
    const g: BusinessGraph = { ...base, authority: [{ id: "no-tracking-internal-7", capability: "shipping.track", effect: "deny", when: [], reason: "Tracking disabled while carrier contract is renegotiated" }] };
    const out = await handleCustomerMessage(g, conv("deny"), "c1", "where is ABC123?");
    const s = model.summaries.at(-1);
    // Denied capabilities aren't even on the surface as usable; either the step is refused or never planned.
    if (out.turn.trace?.steps[0]?.generic?.authority.status === "denied") expect(s?.notSomethingWeDo).toBe(true);
    expect(out.response).not.toMatch(/no-tracking-internal-7|renegotiated|carrier contract/);
    expect(JSON.stringify(s ?? {})).not.toMatch(/no-tracking-internal-7|renegotiated/);
  });
});

describe("reply hygiene — a customer never sees BARRY's machinery", () => {
  const leaky = [
    "I ran shipping.track and the status is in_transit.",
    "I used the invokeCapability tool for you.",
    "Rule demo-tickets-need-approval requires the owner to sign off.",
    "Every support case is approved by the owner in this demo, so I asked.",
  ];
  it.each(leaky)("a model reply that says %j is replaced and the swap is traced", async (text) => {
    const model = new ScriptedModel(
      (ctx, fresh) => (fresh.length === 0 ? (/complaint/.test(ctx.customerMessage) ? ask("support.ticket.create", { reference: "ABC123", reason: "delivery_delay" }) : trackFromMessage(ctx, fresh)) : undefined),
      () => text
    );
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const msg = /Every support|demo-tickets/.test(text) ? "ABC123 is late, open a complaint" : "where is XYZ789?";
    const out = await handleCustomerMessage(g, conv("leak"), "c1", msg);
    expect(out.response).not.toBe(text);
    expect(out.turn.trace?.reply?.fallback).toMatch(/^reply hygiene/);
    expect(findInternalLeak(out.response, internalVocabulary({ graph: g, grounded: { capabilities: await buildCapabilitySurface(g) } }, { outcome: out.turn.compiled as never }, listTools().map((t) => t.name)))).toBeUndefined();
  });

  it("a natural reply passes through untouched", async () => {
    const natural = "It's on its way — should reach you by October 1st.";
    setReasonerForTests(new ScriptedModel(trackFromMessage, () => natural));
    const out = await handleCustomerMessage(buildLogisticsDemoGraph(), conv("clean"), "c1", "where is XYZ789?");
    expect(out.response).toBe(natural);
    expect(out.turn.trace?.reply?.fallback).toBeUndefined();
  });

  it("the guard recognises identifiers, not words: ordinary language is never flagged", () => {
    const vocab = internalVocabulary({ graph: buildLogisticsDemoGraph() }, { outcome: { kind: "ask_general", offerNames: [], stage: "discovery" } as never, toolResult: { ok: true, output: { status: "in_transit" } } }, ["createBooking"]);
    for (const clean of ["Your parcel is in transit.", "I'll track it down for you.", "Support will reach out.", "החבילה בדרך ותגיע ביום שלישי."]) expect(findInternalLeak(clean, vocab)).toBeUndefined();
    for (const dirty of ["status: in_transit", "createBooking failed", "the shipping.track call"]) expect(findInternalLeak(dirty, vocab)).toBeDefined();
  });
});

describe("long conversations (24 turns) keep continuity without re-asking or losing state", () => {
  it("history windows, references and approval state survive a long chat", async () => {
    const model = new ScriptedModel((ctx, fresh) =>
      fresh.length === 0 && /open a complaint/.test(ctx.customerMessage) ? ask("support.ticket.create", { reference: "ABC123", reason: "delivery_delay" }) : trackFromMessage(ctx, fresh)
    );
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("long");
    const script = [
      "hi", "where is ABC123?", "ok thanks", "and XYZ789?", "cool", "what about DEF456?", "great",
      "how long do deliveries take?", "ok", "ABC123 again pls", "still late huh", "ABC123 is late, open a complaint",
      "thanks", "any news?", "XYZ789?", "ok", "hmm", "DEF456 one more time", "nice", "what did I ask first?",
      "and the complaint?", "ok", "XYZ789 last time", "bye",
    ];
    let last;
    for (const m of script) last = await handleCustomerMessage(g, id, "c1", m);
    expect(last!.state.messages.filter((m) => m.role === "customer")).toHaveLength(24);
    const u = model.understood.at(-1)!;
    expect(u.recentMessages).toHaveLength(16);
    expect(u.awaitingOwnerApproval).toBe(true);
    const s = model.summaries.at(-1)!;
    expect(s.recentConversation.length).toBeGreaterThanOrEqual(9);
    expect(s.recentConversation.at(-1)!.from).toBe("business");
    expect(s.ownerApproval).toEqual({ requestedEarlier: true, stillWaiting: true });
    // Exactly one approval for the one complaint, nothing executed without the owner.
    const approvals = (await getBackend().listApprovals(g.business.id)).filter((a) => a.conversationId === id);
    expect(approvals).toHaveLength(1);
    expect(demoHelpdeskTickets()).toHaveLength(0);
    // Every reply BARRY sent in 24 turns is free of internal machinery.
    const vocab = internalVocabulary({ graph: g, grounded: { capabilities: await buildCapabilitySurface(g) } }, { outcome: { kind: "ask_general" } as never }, listTools().map((t) => t.name));
    for (const m of last!.state.messages.filter((m) => m.role === "barry")) {
      expect(findInternalLeak(m.content, vocab)).toBeUndefined();
      expect(m.content).not.toMatch(/\b(in_transit|not_found|delivery_delay)\b/);
    }
  });
});

describe("provider independence — the same conversation over different systems", () => {
  function tenant(id: string): BusinessGraph {
    const base = buildSpaGraph();
    return { ...base, business: { ...base.business, id: `${id}-${Date.now()}-${n++}` }, authority: [{ id: "track", capability: "shipping.track", effect: "allow", when: [] }] };
  }
  async function connect(g: BusinessGraph, systemKey: string, manifest: typeof parcelManifest) {
    const mappings = Object.fromEntries(manifest.operations.map((o) => [o.capability, { status: "active" as const }]));
    await getBackend().upsertBusinessConnection(manifestConnection({ businessId: g.business.id, systemKey, domain: "shipping", name: systemKey, manifest, mappings }));
  }
  const route = (...ts: HttpTransport[]): HttpTransport => async (req) => {
    for (const t of ts) {
      const r = await t(req);
      if (r.status !== 404) return r;
    }
    return { status: 404, body: "{}" };
  };

  it("the composer sees the same kind of facts and no system names, whichever system answered", async () => {
    process.env.PARCEL_CO_API_KEY = "parcel-secret";
    process.env.COURIER_TOKEN = "courier-token";
    const a = tenant("pa");
    const b = tenant("pb");
    await connect(a, "parcel-co", parcelManifest);
    await connect(b, "courier", courierManifest);
    const parcel = createMockHttpSystem(PARCEL_ORIGIN, { "GET /v2/tracking/{trackingNumber}": ({ params }) => ({ json: { tracking: { number: params.trackingNumber, state: "out_for_delivery" } } }) }, { requireAuth: { header: "authorization", value: "Bearer parcel-secret" } });
    setHttpTransportForTests(route(parcel.transport, courierSystem().transport));
    const model = new ScriptedModel(trackFromMessage);
    setReasonerForTests(model);
    const one = await handleCustomerMessage(a, conv("pa"), "c1", "where is ABC123?");
    const sa = model.summaries.at(-1)!;
    const two = await handleCustomerMessage(b, conv("pb"), "c1", "where is ABC123?");
    const sb = model.summaries.at(-1)!;
    expect(one.turn.trace!.steps[0].generic?.system).toBe("parcel-co");
    expect(two.turn.trace!.steps[0].generic?.system).toBe("courier");
    for (const s of [sa, sb]) expect(JSON.stringify(s)).not.toMatch(/parcel-co|courier|http-manifest|example-logistics|api\.parcel/);
    const facts = (s: Summary) => (s.toolOutput as { output?: Record<string, unknown> } | undefined)?.output;
    expect(facts(sa)).toMatchObject({ status: "out_for_delivery" });
    expect(facts(sb)).toMatchObject({ status: "out_for_delivery" });
    expect(sa.whatTheBusinessCanDo).toEqual(sb.whatTheBusinessCanDo);
    expect(one.response).toBe(two.response);
    delete process.env.PARCEL_CO_API_KEY;
    delete process.env.COURIER_TOKEN;
  });
});

describe("cross-business — the Genome, not the code, decides what BARRY talks about", () => {
  it("each business's composer context describes that business only", async () => {
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const seen: Record<string, Summary> = {};
    for (const id of TEST_BUSINESS_IDS) {
      await handleCustomerMessage(getBusinessGraph(id), conv(id), "c1", "hi, what do you do?");
      seen[id] = model.summaries.at(-1)!;
    }
    for (const id of TEST_BUSINESS_IDS) {
      const g = getBusinessGraph(id);
      expect(seen[id].business?.name).toBe(g.business.name);
      expect(seen[id].whatTheBusinessCanDo?.offers).toEqual(g.offers.filter((o) => o.active).map((o) => o.name));
      for (const other of TEST_BUSINESS_IDS.filter((o) => o !== id)) {
        const otherName = getBusinessGraph(other).business.name;
        expect(JSON.stringify(seen[id])).not.toContain(otherName);
      }
    }
  });
});

describe("deterministic replies are clean in every business, in English and Hebrew", () => {
  const MESSAGES = [
    "hi", "how much is it?", "can I book tomorrow at 10?", "I want a discount of 50%", "my name is Dana and my phone is 0541234567",
    "היי", "כמה זה עולה?", "אפשר לקבוע למחר ב-10?", "אני רוצה הנחה של 50%", "אני מחפשת משהו יפה",
  ];
  it.each(TEST_BUSINESS_IDS)("%s", async (id) => {
    const g = getBusinessGraph(id);
    const vocab = internalVocabulary({ graph: g, grounded: { capabilities: await buildCapabilitySurface(g) } }, { outcome: { kind: "ask_general" } as never }, listTools().map((t) => t.name));
    for (const lang of ["en", "he"]) {
      const out = { last: undefined as Awaited<ReturnType<typeof handleCustomerMessage>> | undefined };
      const cid = conv(`${id}-${lang}`);
      for (const m of MESSAGES.filter((m) => HEBREW.test(m) === (lang === "he"))) {
        out.last = await handleCustomerMessage(g, cid, "c1", m);
        const r = out.last.response;
        expect(findInternalLeak(r, vocab), `${id}/${lang}: ${m} -> ${r}`).toBeUndefined();
        expect(r, `${id}: currency codes`).not.toMatch(/\d\s?(ILS|USD|EUR)\b/);
        expect(r, `${id}: slash-gender forms`).not.toMatch(/\/ה|\/ת\b|את\/ה/);
        for (const policy of g.policies) expect(r).not.toContain(policy.id);
        // A Hebrew conversation never drops into English templates (Genome knowledge text is quoted as written).
        if (lang === "he" && out.last.turn.trace?.stop.outcome !== "knowledge_answer") expect(HEBREW.test(r), `${id}: Hebrew reply for ${m} -> ${r}`).toBe(true);
      }
    }
  });
});
