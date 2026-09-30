import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { getBusinessGraph } from "@/lib/fixtures";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { compile, SCRATCH_KEYS } from "@/lib/runtime/compiler";
import { getBackend } from "@/lib/store";
import { createInitialConversationState } from "@/lib/state";
import { callTool } from "@/lib/tools";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { composeSummaryFor } from "@/lib/reasoner/openai-reasoner";
import { claimEvidence, findUnsupportedClaims } from "@/lib/reasoner/claim-grounding";
import { resolveSchedulingWindow, formatLocalDateTime } from "@/lib/scheduling/resolver";
import { readLedger, type LedgerEntry } from "@/lib/runtime/ledger";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { setReasonerForTests, type BarryIR, type ComposeResponseInput, type Reasoner, type ReasonerContext } from "@/lib/reasoner";
import type { BusinessGraph } from "@/lib/business-graph";

/**
 * PASS #3 (commit b51eced, live attack) — structural invariants that must hold even when the model's
 * signals are imperfect. The scripted model reproduces the live signals (including wrong ones) and
 * the live composer's false sentences; assertions are on executor arguments, approval payloads, the
 * immutable ledger subject/effect, lifecycle, and the final narration.
 */

type Summary = ReturnType<typeof composeSummaryFor>;
class ScriptedModel implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "scripted";
  readonly summaries: Summary[] = [];
  private readonly baseline = new Map<string, number>();
  constructor(
    public plan: (ctx: ReasonerContext, fresh: unknown[]) => Partial<BarryIR> | undefined,
    public write: (input: ComposeResponseInput) => string = composeDeterministic
  ) {}
  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const key = `${ctx.state.id}:${ctx.state.messages.length}`;
    if (!this.baseline.has(key)) this.baseline.set(key, ctx.grounded?.capabilityResults?.length ?? 0);
    const fresh = (ctx.grounded?.capabilityResults ?? []).slice(this.baseline.get(key));
    const p = this.plan(ctx, fresh) ?? {};
    return { intent: "scripted", entities: {}, customerInfo: {}, ...p, constraints: { ...(p.constraints ?? {}) } } as BarryIR;
  }
  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    this.summaries.push(composeSummaryFor(ctx, input));
    return this.write(input);
  }
}

let n = 0;
const conv = (p: string) => `p3-${p}-${Date.now()}-${n++}`;
const approvalsOf = async (g: BusinessGraph, id: string) => (await getBackend().listApprovals(g.business.id)).filter((a) => a.conversationId === id);

let rinaId = "";
function rina(): { g: BusinessGraph; commerce: MemoryCommerceAdapter } {
  rinaId = `p3-rina-${Date.now()}-${n++}`;
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

const who = { customerInfo: { name: "עדי", phone: "0505550114" }, evidence: { "customerInfo.name": "עדי", "customerInfo.phone": "0505550114" } };
const SEARCH: Partial<BarryIR> = { commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true };
const addLine = (position: number, size: string, quantity: number): Partial<BarryIR> => ({
  commerce: { intent: "select", reference: { type: "previous_result", index: position - 1 }, variant: { size }, quantity },
  purchaseDecision: false,
  checkoutConsent: false,
  advancesTransaction: true,
});

async function twoLineCart(model: ScriptedModel, g: BusinessGraph, id: string) {
  model.plan = () => SEARCH;
  const search = await handleCustomerMessage(g, id, "c", "שמלות שחורות");
  const titles = search.rich?.products?.map((p) => p.title) ?? [];
  const pos = (t: string) => titles.indexOf(t) + 1;
  model.plan = () => addLine(pos("Midnight Wrap Dress"), "M", 2);
  await handleCustomerMessage(g, id, "c", "שתיים Midnight במידה M לסל, בלי קופה");
  model.plan = () => addLine(pos("Onyx Slip Dress"), "M", 1);
  const two = await handleCustomerMessage(g, id, "c", "וגם Onyx M אחת לסל, בלי קופה");
  return two;
}

// ── 1. Final-write consent ──────────────────────────────────────────────

describe("final-write consent: scope, reference and hard cap are checked at the write boundary", () => {
  it("F20 Rina: 'checkout ONLY the Onyx' never charges the rest of the cart — nothing is created and the extra items are named", async () => {
    const { g } = rina();
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("scope");
    const two = await twoLineCart(model, g, id);
    expect(two.state.knownFields.__paymentRequestId).toBeUndefined();
    // Live signals: checkout consent true, the Onyx line, quantity 1.
    model.plan = () => ({ commerce: { intent: "checkout", reference: { type: "cart_line", index: 1 }, quantity: 1 }, checkoutConsent: true, advancesTransaction: true, ...who });
    const out = await handleCustomerMessage(g, id, "c", "עכשיו כן קופה לOnyx M אחת בלבד. עדי 0505550114");
    expect(out.turn.trace?.steps.some((s) => s.action === "createCommerceCheckout" && s.result?.ok)).toBe(false);
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(out.turn.trace?.effects?.map((e) => e.effect)).toContain("write.blocked");
    expect(out.response).toMatch(/Midnight Wrap Dress/);
  });

  it("F20 Rina: a checkout reference that points at nothing real is no consent at all", async () => {
    const { g } = rina();
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("badref");
    await twoLineCart(model, g, id);
    model.plan = () => ({ commerce: { intent: "checkout", reference: { type: "cart_line", index: 6 } }, checkoutConsent: true, advancesTransaction: true, ...who });
    const out = await handleCustomerMessage(g, id, "c", "קופה לשורה 7");
    expect(out.turn.trace?.steps ?? []).toHaveLength(0);
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
  });

  it("F21 Rina: removing line 1 removes exactly that line; the receipt freezes subject and before/after, from the returned cart", async () => {
    const { g, commerce } = rina();
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("remove");
    const two = await twoLineCart(model, g, id);
    model.plan = () => ({ commerce: { intent: "remove", reference: { type: "cart_line", index: 0 } }, withdrawsRequest: true, advancesTransaction: true, checkoutConsent: false });
    model.write = () => "הסרתי את שלוש השמלות Midnight Wrap Dress מהסל שלך. הסל ריק עכשיו.";
    const out = await handleCustomerMessage(g, id, "c", "תסירי בפועל את השורה 1 של Midnight");
    const cart = (await commerce.getCart(two.state.knownFields.__commerceCartId))!;
    expect(cart.lines.map((l) => l.title)).toEqual(["Onyx Slip Dress"]);
    const receipt = readLedger(out.state).filter((e) => e.operation === "updateCartLine").at(-1)!;
    expect(receipt).toMatchObject({ effect: "cart.line_removed", status: "effected", terms: { item: "Midnight Wrap Dress (M / black)", quantityBefore: 2, quantityAfter: 0 }, outcome: { cartAfter: "1 × Onyx Slip Dress (M / black)" } });
    // "The cart is empty" contradicts the returned cart and never reaches the customer.
    expect(out.response).not.toMatch(/ריק/);
  });

  it("a hard cap that includes shipping blocks checkout when the shipping cost is unknown; a goods-only cap lets it through", async () => {
    const { g } = rina();
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("cap");
    const two = await twoLineCart(model, g, id);
    model.plan = () => ({ commerce: { intent: "remove", reference: { type: "cart_line", index: 0 } }, advancesTransaction: true, checkoutConsent: false });
    await handleCustomerMessage(g, id, "c", "תסירי את Midnight");
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, constraints: { budgetMax: 450, budgetIncludesShipping: true }, ...who });
    const capped = await handleCustomerMessage(g, id, "c", "קופה, עד 450 כולל הכל. עדי 0505550114");
    expect(capped.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(capped.turn.trace?.effects?.at(-1)).toMatchObject({ effect: "write.blocked" });
    expect(capped.response).toMatch(/משלוח/);
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, constraints: { budgetMax: 450, budgetIncludesShipping: false } });
    const ok = await handleCustomerMessage(g, id, "c", "450 זה על השמלה בלבד, תכיני לינק");
    expect(ok.state.knownFields.__paymentRequestId).toBeTruthy();
    expect(ok.turn.trace?.effects?.find((e) => e.effect === "payment.link_created")).toBeTruthy();
    expect(two.state.knownFields.__commerceCartId).toBe(ok.state.knownFields.__commerceCartId);
  });

  it("F20 Furniture: three tables above the $1,700 cap create NO approval, the two-table request is not left as a phantom, and the reply says so", async () => {
    const g = getBusinessGraph("furniture-store");
    const buy = (quantity: number): Partial<BarryIR> => ({ selectedOfferId: "offer-dining-table", purchaseDecision: true, advancesTransaction: true, checkoutConsent: true, constraints: { quantity, discountPct: 9, budgetMax: 1700 }, customerInfo: { name: "Maya", email: "m@example.com" }, evidence: { "customerInfo.name": "Maya", "customerInfo.email": "m@example.com" } });
    const model = new ScriptedModel(() => buy(2));
    setReasonerForTests(model);
    const id = conv("furn");
    await handleCustomerMessage(g, id, "c", "two Birchwood tables at 9%, max 1700, Maya m@example.com");
    let approvals = await approvalsOf(g, id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].requestedInput).toMatchObject({ amount: 1636.18, quantity: 2 });

    model.plan = () => ({ ...buy(3), changesPendingRequest: true });
    model.write = () => "I've requested the owner to approve a payment link for three tables at $2,454.27. I'm currently waiting for their decision.";
    const out = await handleCustomerMessage(g, id, "c", "correct to THREE tables at 9, max 1700 still hard. If too high refuse");
    approvals = await approvalsOf(g, id);
    expect(approvals).toHaveLength(1);
    expect(approvals.filter((a) => a.status === "pending")).toHaveLength(0);
    expect(approvals[0].resolution?.decidedBy).toBe("customer:changed_terms");
    expect(out.turn.trace?.effects?.map((e) => e.effect)).toEqual(expect.arrayContaining(["write.blocked", "request.superseded"]));
    expect(out.response).not.toMatch(/waiting for their decision/);
    expect(out.response).toMatch(/2,?454\.27|1,?700/);
  });

  it("an owner's approval is re-checked against the customer's CURRENT cap before anything executes", async () => {
    const g = getBusinessGraph("furniture-store");
    const model = new ScriptedModel(() => ({ selectedOfferId: "offer-dining-table", purchaseDecision: true, advancesTransaction: true, constraints: { quantity: 2, discountPct: 9 }, customerInfo: { name: "Maya", email: "m@example.com" }, evidence: { "customerInfo.name": "Maya", "customerInfo.email": "m@example.com" } }));
    setReasonerForTests(model);
    const id = conv("resume-cap");
    await handleCustomerMessage(g, id, "c", "two tables at 9%, Maya m@example.com");
    const [pending] = await approvalsOf(g, id);
    model.plan = () => ({ advancesTransaction: false, constraints: { budgetMax: 1500 } });
    await handleCustomerMessage(g, id, "c", "btw my hard max is 1500");
    const resumed = await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(resumed.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(readLedger(resumed.state).at(-1)).toMatchObject({ effect: "write.blocked", requestId: pending.id });
    const [view] = withLifecycle(await approvalsOf(g, id), new Map([[id, resumed.state]]));
    expect(view.lifecycle).toBe("failed");
  });
});

// ── 2. Atomic revision / scoped withdrawal / race / failed execution ────

describe("request revisions are atomic; withdrawal is scoped; stale races never execute twice", () => {
  const ticket = (reference: string) => ({ capabilityRequest: { capability: "support.ticket.create", input: { reference, reason: "delivery_delay" }, purpose: "case" }, advancesTransaction: true });

  it("a correction without a valid replacement leaves nothing pending and says so — never 'the owner is reviewing'", async () => {
    const model = new ScriptedModel((ctx, fresh) => (fresh.length ? undefined : /P3-A-610/.test(ctx.customerMessage) ? ticket("P3-A-610") : { changesPendingRequest: true, advancesTransaction: true }));
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("atomic");
    await handleCustomerMessage(g, id, "c", "open a case for P3-A-610");
    model.write = () => "The owner is currently reviewing the request to open a support case for P3-A-611.";
    const out = await handleCustomerMessage(g, id, "c", "sorry it's 611 not 610");
    expect((await approvalsOf(g, id)).filter((a) => a.status === "pending")).toHaveLength(0);
    expect(out.response).not.toMatch(/currently reviewing/);
    expect(out.response).toMatch(/nothing is waiting on the owner/i);
  });

  it("with a valid replacement, exactly one active revision remains and it carries the corrected reference", async () => {
    const model = new ScriptedModel((ctx, fresh) => (fresh.length ? undefined : /610/.test(ctx.customerMessage) && !/611/.test(ctx.customerMessage) ? ticket("P3-A-610") : { ...ticket("P3-A-611"), changesPendingRequest: true }));
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("atomic-ok");
    await handleCustomerMessage(g, id, "c", "open a case for P3-A-610");
    await handleCustomerMessage(g, id, "c", "sorry it's P3-A-611 not 610");
    const active = (await approvalsOf(g, id)).filter((a) => a.status === "pending");
    expect(active).toHaveLength(1);
    expect(JSON.stringify(active[0].requestedInput)).toContain("P3-A-611");
  });

  it("'don't reopen A' withdraws only A — never the other pending request", async () => {
    const model = new ScriptedModel((ctx, fresh) => (fresh.length ? undefined : /B-720/.test(ctx.customerMessage) ? ticket("P3-B-720") : { withdrawsRequest: true, withdrawScope: ["P3-A-610"], advancesTransaction: false }));
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("scoped");
    await handleCustomerMessage(g, id, "c", "open a case for P3-B-720");
    await handleCustomerMessage(g, id, "c", "and do NOT reopen 610");
    expect((await approvalsOf(g, id)).filter((a) => a.status === "pending")).toHaveLength(1);
  });

  it("two concurrent owner approvals of the same request execute it exactly once", async () => {
    setReasonerForTests(new ScriptedModel((_c, fresh) => (fresh.length ? undefined : ticket("P3-A-611"))));
    const g = buildLogisticsDemoGraph();
    const id = conv("race");
    await handleCustomerMessage(g, id, "c", "open a case for P3-A-611");
    const [pending] = await approvalsOf(g, id);
    const results = await Promise.all([resumeAfterApproval(g, pending.id, "approved", "owner"), resumeAfterApproval(g, pending.id, "approved", "owner-2")]);
    expect(demoHelpdeskTickets()).toHaveLength(1);
    expect(results.filter((r) => /already/.test(r.response))).toHaveLength(1);
  });

  it("an approved request whose execution fails is 'failed' — never executed or done", async () => {
    setReasonerForTests(new ScriptedModel((_c, fresh) => (fresh.length ? undefined : ticket("P3-C-831"))));
    const g = buildLogisticsDemoGraph();
    const id = conv("fail");
    await handleCustomerMessage(g, id, "c", "open a case for P3-C-831");
    const [pending] = await approvalsOf(g, id);
    // The business's rules changed before the owner clicked: the tool re-checks authority and refuses.
    const denied: BusinessGraph = { ...g, authority: [{ id: "no-tickets", capability: "support.ticket.create", effect: "deny", when: [] }] };
    const resumed = await resumeAfterApproval(denied, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(0);
    expect(readLedger(resumed.state).at(-1)).toMatchObject({ status: "failed", requestId: pending.id });
    const [view] = withLifecycle(await approvalsOf(g, id), new Map([[id, resumed.state]]));
    expect(view.lifecycle).toBe("failed");
  });
});

// ── 3. Temporal constraints ────────────────────────────────────────────

describe("temporal constraints survive every transformation", () => {
  it("an explicit end and 'strictly after' are part of the resolved window", () => {
    const tz = "Asia/Jerusalem";
    const w = resolveSchedulingWindow({ date: { kind: "explicitDate", isoDate: "2026-10-05" }, time: { kind: "explicitTime", hour: 15, minute: 15 }, end: { hour: 15, minute: 45 } }, tz)!;
    expect(formatLocalDateTime(w.earliest, tz).localTime24).toBe("15:15");
    expect(formatLocalDateTime(w.latest, tz).localTime24).toBe("15:45");
    const after = resolveSchedulingWindow({ date: { kind: "explicitDate", isoDate: "2026-10-05" }, time: { kind: "explicitTime", hour: 15, minute: 0 }, startExclusive: true }, tz)!;
    const at15 = resolveSchedulingWindow({ date: { kind: "explicitDate", isoDate: "2026-10-05" }, time: { kind: "explicitTime", hour: 15, minute: 0 } }, tz)!;
    expect(new Date(after.earliest).getTime()).toBeGreaterThan(new Date(at15.earliest).getTime());
  });

  it("availability never returns a slot starting at an excluded start or ending after a hard end, whatever the provider does", async () => {
    const g = getBusinessGraph("spa");
    const slot = g.availability.find((s) => s.resourceId && g.offers[1].requiredResourceTypes.length >= 0)!;
    const ctx = { graph: g, conversationId: "t", customerId: "c" };
    const exclusive = await callTool("checkAvailability", { offerId: "offer-solo-massage", earliest: new Date(new Date(slot.start).getTime() + 1).toISOString(), latest: new Date(new Date(slot.start).getTime() + 3 * 3600e3).toISOString() }, ctx);
    expect(exclusive.ok && (exclusive.output as { slots: { start: string }[] }).slots.some((s) => s.start === slot.start)).toBe(false);
    const bounded = await callTool("checkAvailability", { offerId: "offer-solo-massage", earliest: slot.start, latest: slot.start, endBy: new Date(new Date(slot.end).getTime() - 1).toISOString() }, ctx);
    expect(bounded.ok && (bounded.output as { slots: unknown[] }).slots.length).toBe(0);
  });

  it("a day-only later turn keeps the explicit end and exclusivity; switching from couples to solo clears the stale party size", () => {
    const g = getBusinessGraph("spa");
    const state = createInitialConversationState("c-t", g.business.id, "c");
    const base = { intent: "x", entities: {}, customerInfo: {} } as BarryIR;
    compile(g, state, { ...base, selectedOfferId: "offer-couples-massage", constraints: { partySize: 2, schedulingWindow: { date: { kind: "explicitDate", isoDate: "2026-10-05" }, time: { kind: "explicitTime", hour: 15, minute: 0 }, end: { hour: 17, minute: 0 }, startExclusive: true } } });
    const later = compile(g, state, { ...base, constraints: { schedulingWindow: { date: { kind: "explicitDate", isoDate: "2026-10-06" } } } });
    const tz = g.business.timezone;
    expect(formatLocalDateTime(later.debug!.resolvedSchedulingWindow!.latest, tz).localTime24).toBe("17:00");
    expect(state.knownFields[SCRATCH_KEYS.windowEndIsHard]).toBe("1");
    expect(state.knownFields[SCRATCH_KEYS.mentionedPartySize]).toBe("2");
    compile(g, state, { ...base, offerChangeRequested: "offer-solo-massage", constraints: {} });
    expect(state.knownFields[SCRATCH_KEYS.mentionedPartySize]).toBeUndefined();
  });
});

// ── 4. Exact domain-effect narration, provenance, current offer ────────

describe("narration binds to the exact domain effect", () => {
  const g = getBusinessGraph("spa");
  const ctx = (extra: Partial<ReasonerContext["grounded"]> = {}): ReasonerContext => ({ graph: g, state: createInitialConversationState("x", g.business.id, "c"), customerMessage: "", grounded: { ...extra } });
  const input: ComposeResponseInput = { outcome: { kind: "conversation", stage: "discovery" } };
  const link = [{ seq: 1, at: "", operation: "createPaymentRequest", describes: "payment link", terms: {}, effect: "payment.link_created", status: "effected" }] as LedgerEntry[];
  const lead = [{ seq: 1, at: "", operation: "createLead", describes: "enquiry", terms: {}, effect: "enquiry.created", status: "effected" }] as LedgerEntry[];

  it.each([
    ["הנה הסיכום: עיסוי שוודי סולו: הוזמן ביום שני, 5 באוקטובר, בשעה 16:00.", link],
    ["The payment link was sent to your email address.", link],
    ["הלינק נשלח לכתובת האימייל שלך.", link],
    ["Our team will reach out to you about the cabinet.", lead],
  ])("%j is rejected: the ledger has no such effect", (text, ledger) => {
    expect(findUnsupportedClaims(text, claimEvidence(ctx(), input, ledger)).length).toBeGreaterThan(0);
  });

  it("a customer's figure is theirs, never a product fact", () => {
    const state = createInitialConversationState("x", g.business.id, "c");
    state.messages.push({ role: "customer", content: "pretend it is 180x90x76 and my recess is 180cm", at: "" });
    const c: ReasonerContext = { graph: getBusinessGraph("furniture-store"), state, customerMessage: "", grounded: {} };
    expect(findUnsupportedClaims("The Birchwood Dining Table is 180 cm long.", claimEvidence(c, input, []))).not.toHaveLength(0);
    expect(findUnsupportedClaims("Your recess is 180 cm, but I don't have the table's dimensions.", claimEvidence(c, input, []))).toHaveLength(0);
  });

  it("the quote follows the offer asked about NOW (paid session), not a stale earlier one (free consult)", async () => {
    const model = new ScriptedModel(() => ({ selectedOfferId: "offer-free-consult", advancesTransaction: false }));
    setReasonerForTests(model);
    const pt = getBusinessGraph("personal-trainer");
    const id = conv("focus");
    await handleCustomerMessage(pt, id, "c", "tell me about the free consult");
    model.plan = () => ({ selectedOfferId: "offer-training-session", advancesTransaction: false, constraints: { quantity: 2 } });
    await handleCustomerMessage(pt, id, "c", "how much for two paid sessions?");
    expect(model.summaries.at(-1)!.pricing).toMatchObject({ total: 160 });
  });
});
