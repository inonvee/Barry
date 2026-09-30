import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { getBusinessGraph } from "@/lib/fixtures";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { compile, SCRATCH_KEYS } from "@/lib/runtime/compiler";
import { getBackend } from "@/lib/store";
import { createInitialConversationState } from "@/lib/state";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { composeSummaryFor } from "@/lib/reasoner/openai-reasoner";
import { claimEvidence, findMisattributedReferences, findUnsupportedClaims, languageMismatch } from "@/lib/reasoner/claim-grounding";
import { buildQuote, quoteOffer } from "@/lib/runtime/pricing";
import { classifyExecution, readLedger, type LedgerEntry } from "@/lib/runtime/ledger";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { setReasonerForTests, type BarryIR, type ComposeResponseInput, type Reasoner, type ReasonerContext } from "@/lib/reasoner";
import type { BusinessGraph } from "@/lib/business-graph";

/**
 * Pass #2 (commit 94ab6a4, live attack) — domain truth and transaction-state invariants.
 *
 * The scripted composer below reproduces what the live composer wrote in that pass. Assertions are
 * on STATE, the effect LEDGER, approval payloads and lifecycle — and on the fact that the false
 * claims never reach the customer, whatever the composer writes.
 */

type Summary = ReturnType<typeof composeSummaryFor>;

class ScriptedModel implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "scripted";
  readonly summaries: Summary[] = [];
  readonly repairs: ComposeResponseInput["repair"][] = [];
  private readonly baseline = new Map<string, number>();
  constructor(
    public plan: (ctx: ReasonerContext, fresh: unknown[]) => Partial<BarryIR> | undefined,
    public write: (input: ComposeResponseInput) => string = composeDeterministic
  ) {}
  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const key = `${ctx.state.id}:${ctx.state.messages.length}`;
    if (!this.baseline.has(key)) this.baseline.set(key, ctx.grounded?.capabilityResults?.length ?? 0);
    const fresh = (ctx.grounded?.capabilityResults ?? []).slice(this.baseline.get(key));
    const planned = this.plan(ctx, fresh) ?? {};
    return { intent: "scripted", entities: {}, customerInfo: {}, ...planned, constraints: { ...(planned.constraints ?? {}) } } as BarryIR;
  }
  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    this.summaries.push(composeSummaryFor(ctx, input));
    if (input.repair) this.repairs.push(input.repair);
    return this.write(input);
  }
}

let n = 0;
const conv = (p: string) => `p2-${p}-${Date.now()}-${n++}`;
const approvalsOf = async (g: BusinessGraph, id: string) => (await getBackend().listApprovals(g.business.id)).filter((a) => a.conversationId === id);

afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
});

// ── 1. Transport success is not a business effect ──────────────────────

describe("F15 — domain effects, not call success, decide what can be claimed", () => {
  it("spa: a payment check that returns 'pending' is never described as paid or booked; a later 'cancelled' with no action is rejected", async () => {
    const book = { selectedOfferId: "offer-solo-massage", advancesTransaction: true, constraints: { schedulingWindow: { date: { kind: "relativeDay", days: 2 }, time: { kind: "explicitTime", hour: 10, minute: 0 } } }, customerInfo: { name: "Lee", phone: "0541234567" }, evidence: { "customerInfo.name": "Lee", "customerInfo.phone": "0541234567" } } as Partial<BarryIR>;
    const model = new ScriptedModel(() => book);
    setReasonerForTests(model);
    const g = getBusinessGraph("spa");
    const id = conv("spa");
    await handleCustomerMessage(g, id, "c", "Solo swedish the day after tomorrow at 10, I'm Lee 0541234567");
    model.plan = () => ({ advancesTransaction: true, constraints: { slotAccepted: true } });
    const linked = await handleCustomerMessage(g, id, "c", "yes that works");
    expect(linked.state.knownFields.__paymentRequestId).toBeTruthy();

    // The customer claims payment; the provider says pending. The live composer said "verified + confirmed".
    model.plan = () => ({ customerClaims: { paymentCompleted: true } });
    model.write = () => "The payment for your Solo Swedish Massage has been verified successfully. Your booking is now confirmed! Looking forward to seeing you, Lee!";
    const paid = await handleCustomerMessage(g, id, "c", "done paid the link now. confirm it please");
    const effects = paid.turn.trace?.effects ?? [];
    expect(effects.map((e) => e.effect)).toEqual(["payment.pending"]);
    expect(readLedger(paid.state).some((e) => e.effect === "booking.created" || e.effect === "payment.settled")).toBe(false);
    expect(paid.response).not.toMatch(/verified successfully|now confirmed/i);
    expect(paid.turn.trace?.reply?.fallback).toMatch(/claim grounding/);

    // Next turn: no action; the live composer invented a cancellation and a confirmed-then-cancelled history.
    model.plan = () => ({ advancesTransaction: false });
    model.write = () => "The booking for the Solo Swedish Massage has been canceled, and there will be no charge.";
    const undo = await handleCustomerMessage(g, id, "c", "havent actually paid. take it back, no booking no charge");
    expect(undo.response).not.toMatch(/has been canceled/i);
    model.write = () => "The appointment was initially confirmed based on the payment, but it was canceled after you stated you hadn't paid.";
    const history = await handleCustomerMessage(g, id, "c", "you told me confirmed then canceled. was either actually executed?");
    expect(history.response).not.toMatch(/initially confirmed|was canceled/i);
    expect(history.response).toMatch(/Nothing is booked/);
  });

  it("logistics: a ticket waiting on the owner is never 'opened'; furniture: no action is never 'created'", async () => {
    const model = new ScriptedModel((ctx, fresh) => (fresh.length ? undefined : { capabilityRequest: { capability: "support.ticket.create", input: { reference: "TEST-REG-4101", reason: "delivery_delay" }, purpose: "stuck" }, advancesTransaction: true }));
    model.write = () => "I've also opened a support case regarding this shipment, and I'm waiting for the owner to approve it.";
    setReasonerForTests(model);
    const t1 = await handleCustomerMessage(buildLogisticsDemoGraph(), conv("lg"), "c", "TEST-REG-4101 is a week late, open a support case if it's stuck");
    expect(t1.turn.trace?.effects?.map((e) => e.status)).toEqual(["awaiting_owner"]);
    expect(t1.response).not.toMatch(/opened/i);

    model.plan = () => ({ advancesTransaction: false });
    model.write = () => "I've created an enquiry for a custom small cabinet with a maximum width of 120 cm and a budget of $700.";
    const lead = await handleCustomerMessage(getBusinessGraph("furniture-store"), conv("lead"), "c", "I want an enquiry for a custom small cabinet, max width 120 cm budget 700. Create the enquiry only");
    expect(lead.turn.trace?.effects ?? []).toHaveLength(0);
    expect(lead.response).not.toMatch(/I've created/i);
  });

  it("unconfirmed writes and failed calls are uncertainty, never completion — classification is domain-level", () => {
    const unconfirmed = classifyExecution("invokeCapability", { capability: "support.ticket.create", input: { reference: "R-1234" } }, { ok: true, output: { capability: "support.ticket.create", ok: true, executed: true, verified: false, output: { ticketId: "T-9" } } });
    expect(unconfirmed).toMatchObject({ effect: "support.ticket.create", status: "effected_unconfirmed", reference: "T-9" });
    const failed = classifyExecution("createBooking", { offerId: "x" }, { ok: false, error: "Slot no longer available" });
    expect(failed.status).toBe("failed");
    const pending = classifyExecution("verifyPayment", { paymentRequestId: "p" }, { ok: true, output: { status: "pending", paymentRequestId: "p" } });
    expect(pending).toMatchObject({ effect: "payment.pending", status: "effected" });

    const g = buildLogisticsDemoGraph();
    const ctx: ReasonerContext = { graph: g, state: createInitialConversationState("x", g.business.id, "c"), customerMessage: "", grounded: {} };
    const ledger = [{ ...unconfirmed, seq: 1, at: "" }] as LedgerEntry[];
    const input: ComposeResponseInput = { outcome: { kind: "conversation", stage: "discovery" } };
    expect(findUnsupportedClaims("I've opened your support case.", claimEvidence(ctx, input, ledger))).not.toHaveLength(0);
    expect(findUnsupportedClaims("Your booking is confirmed.", claimEvidence(ctx, input, [{ ...failed, seq: 1, at: "" }] as LedgerEntry[]))).not.toHaveLength(0);
    expect(findUnsupportedClaims("Your payment has been verified.", claimEvidence(ctx, input, [{ ...pending, seq: 1, at: "" }] as LedgerEntry[]))).not.toHaveLength(0);
  });
});

// ── 2. Immutable receipt identity ──────────────────────────────────────

describe("F19 — a receipt belongs to its own request forever", () => {
  it("4102 opened (T-1001), 4200 declined, 4300 withdrawn — after 15+ unrelated turns, nothing re-attributes T-1001", async () => {
    const ticket = (reference: string) => ({ capabilityRequest: { capability: "support.ticket.create", input: { reference, reason: "delivery_delay" }, purpose: "case" }, advancesTransaction: true });
    const model = new ScriptedModel((ctx, fresh) => {
      if (fresh.length) return undefined;
      const ref = ctx.customerMessage.match(/TEST-REG-\d{4}/)?.[0];
      if (/open a case/.test(ctx.customerMessage) && ref) return ticket(ref);
      if (/scrap 4300/.test(ctx.customerMessage)) return { withdrawsRequest: true, advancesTransaction: false };
      return { advancesTransaction: false };
    });
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("f19");
    await handleCustomerMessage(g, id, "c", "open a case for TEST-REG-4102 please");
    const [a4102] = (await approvalsOf(g, id)).filter((a) => a.status === "pending");
    await resumeAfterApproval(g, a4102.id, "approved", "owner");
    await handleCustomerMessage(g, id, "c", "also open a case for TEST-REG-4200, damaged");
    const a4200 = (await approvalsOf(g, id)).find((a) => a.status === "pending")!;
    await resumeAfterApproval(g, a4200.id, "declined", "owner");
    await handleCustomerMessage(g, id, "c", "and open a case for TEST-REG-4300, missing");
    await handleCustomerMessage(g, id, "c", "actually scrap 4300");
    for (let i = 0; i < 15; i++) await handleCustomerMessage(g, id, "c", `unrelated question ${i}`);

    const ticketId = demoHelpdeskTickets()[0].ticketId;
    expect(demoHelpdeskTickets().map((t) => t.reference)).toEqual(["TEST-REG-4102"]);
    // The live composer's re-attribution:
    model.write = () => `The only existing case is for the damaged item, TEST-REG-4200, which has the reference number ${ticketId}.`;
    const status = await handleCustomerMessage(g, id, "c", "tell me which cases actually exist");
    expect(status.response).not.toMatch(new RegExp(`TEST-REG-4200[^\\n]*${ticketId}`));
    expect(status.turn.trace?.reply?.fallback).toMatch(/attributes/);
    // The deterministic rendering answers each reference from its own record.
    expect(status.response).toMatch(new RegExp(`TEST-REG-4102[^\\n]*done, reference ${ticketId}`));
    expect(status.response).toMatch(/TEST-REG-4200[^\n]*not approved by the owner, not carried out/);
    expect(status.response).toMatch(/TEST-REG-4300[^\n]*withdrawn at your request, not carried out/);

    const s = model.summaries.at(-1)!;
    const byRef = Object.fromEntries(s.ownerRequests.map((r) => [String(r.terms.reference), r]));
    expect(byRef["TEST-REG-4102"]).toMatchObject({ lifecycle: "executed", reference: ticketId });
    expect(byRef["TEST-REG-4200"]).toMatchObject({ lifecycle: "declined" });
    expect(byRef["TEST-REG-4200"].reference).toBeUndefined();
    expect(byRef["TEST-REG-4300"]).toMatchObject({ lifecycle: "withdrawn" });
    // The ledger entry that produced the ticket is frozen with its own terms.
    const executed = readLedger(status.state).filter((e) => e.reference === ticketId);
    expect(executed).toHaveLength(1);
    expect(executed[0].terms.reference).toBe("TEST-REG-4102");
  });

  it("the binding check is structural: a reference next to another request's identifier is rejected, next to its own it passes", () => {
    const records = [
      { reference: "T-1001", terms: { reference: "TEST-REG-4102" } },
      { terms: { reference: "TEST-REG-4200" } },
    ];
    expect(findMisattributedReferences("TEST-REG-4200 has case T-1001.", records)).toHaveLength(1);
    expect(findMisattributedReferences("TEST-REG-4102 has case T-1001; TEST-REG-4200 was declined.", records)).toHaveLength(0);
  });
});

// ── 3. One quantity-aware money object ─────────────────────────────────

describe("F16 — quantity is part of the money, the approval and the reply", () => {
  it("quotes: 2 × $129 at 10% = $232.20 shipping free; 2 × $189 at 12% = $332.64; 2 × $899 at 9% = $1,636.18 (shipping unknown)", () => {
    const bags = getBusinessGraph("ecommerce-bags");
    const backpack = bags.offers.find((o) => o.id === "offer-backpack")!;
    const duffel = bags.offers.find((o) => o.id === "offer-weekender")!;
    expect(quoteOffer(bags, backpack, 2, 10)).toMatchObject({ total: 232.2, shipping: { amount: 0 }, complete: true });
    expect(quoteOffer(bags, duffel, 2, 12)).toMatchObject({ total: 332.64 });
    const furniture = getBusinessGraph("furniture-store");
    const table = furniture.offers.find((o) => o.id === "offer-dining-table")!;
    expect(quoteOffer(furniture, table, 2, 9)).toMatchObject({ goodsTotal: 1636.18, shipping: { amount: null, basis: "unknown" }, complete: false });
  });

  it("shipping follows the business's own rule, including the equality boundary; an unknown fee is never invented", () => {
    const rina = getBusinessGraph("fashion-retailer");
    const line = (price: number) => [{ item: "dress", itemRef: "d", unitPrice: price, quantity: 1 }];
    expect(buildQuote(rina, line(420), "ILS")).toMatchObject({ shipping: { amount: 0 }, total: 420, complete: true });
    expect(buildQuote(rina, line(399), "ILS")).toMatchObject({ shipping: { amount: null, basis: "unknown" }, complete: false });
    expect(buildQuote(rina, line(390), "ILS").complete).toBe(false);
  });

  it("bags: two duffels at 12% -> the owner reviews $332.64 for quantity 2; a quantity correction supersedes the one-unit revision", async () => {
    const decide = (quantity: number): Partial<BarryIR> => ({ selectedOfferId: "offer-weekender", purchaseDecision: true, advancesTransaction: true, constraints: { discountPct: 12, quantity }, customerInfo: { email: "t@example.com" }, evidence: { "customerInfo.email": "t@example.com" } });
    const model = new ScriptedModel(() => decide(1));
    setReasonerForTests(model);
    const g = getBusinessGraph("ecommerce-bags");
    const id = conv("qty");
    await handleCustomerMessage(g, id, "c", "one weekender duffel at 12% off, t@example.com");
    let approvals = await approvalsOf(g, id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].requestedInput).toMatchObject({ amount: 166.32, quantity: 1 });

    model.plan = () => decide(2);
    const corrected = await handleCustomerMessage(g, id, "c", "actually two duffels, same 12%");
    approvals = await approvalsOf(g, id);
    const active = approvals.filter((a) => a.status === "pending");
    expect(active).toHaveLength(1);
    expect(active[0].requestedInput).toMatchObject({ amount: 332.64, quantity: 2, lines: [{ quantity: 2, unitPrice: 189 }] });
    const old = approvals.find((a) => a.id !== active[0].id)!;
    expect(old.resolution?.decidedBy).toBe("runtime:superseded");
    // The reply context carries the same total the owner sees.
    expect(model.summaries.at(-1)!.pricing).toMatchObject({ total: 332.64 });
    // The stale one-unit revision can never be executed.
    const stale = await resumeAfterApproval(g, old.id, "approved", "owner");
    expect(stale.response).toMatch(/already declined/);
    expect(corrected.state.knownFields.__paymentRequestId).toBeUndefined();
  });

  it("an arithmetic-only question gets the authoritative total without contact details or a request", async () => {
    const model = new ScriptedModel(() => ({ selectedOfferId: "offer-backpack", advancesTransaction: false, constraints: { quantity: 2, discountPct: 10 } }));
    model.write = (input) => (input.repair ? "Two backpacks at 10% off come to $232.20, and shipping is free." : "Two backpacks at 10% off come to $116.10.");
    setReasonerForTests(model);
    const out = await handleCustomerMessage(getBusinessGraph("ecommerce-bags"), conv("math"), "c", "שני תיקי גב עם 10 אחוז הנחה כמה כולל משלוח? רק חשבון בלי הזמנה");
    expect(model.summaries[0].pricing).toMatchObject({ total: 232.2, shipping: { amount: 0 } });
    expect(out.response).not.toMatch(/116\.10/);
    expect(out.state.missingFields).toEqual([]);
    expect(await approvalsOf(getBusinessGraph("ecommerce-bags"), out.state.id)).toHaveLength(0);
  });
});

// ── 4. Read intent / cart mutation / checkout consent ──────────────────

describe("reads run when asked; a cart change never starts checkout", () => {
  it("a requested calendar read runs without booking or contact collection", async () => {
    setReasonerForTests(new ScriptedModel(() => ({ selectedOfferId: "offer-free-consult", advancesTransaction: false, readRequested: true, constraints: { schedulingWindow: { date: { kind: "relativeDay", days: 2 }, time: { kind: "explicitTime", hour: 12, minute: 15 } } } })));
    const out = await handleCustomerMessage(getBusinessGraph("personal-trainer"), conv("read"), "c", "check the actual calendar, not book yet");
    expect(out.turn.trace?.steps.map((s) => s.action)).toEqual(["checkAvailability"]);
    expect(out.state.missingFields).toEqual([]);
    expect(out.turn.trace?.effects?.[0].effect).toMatch(/^availability\./);
  });

  it("a requested stock read runs and stops: no payment request", async () => {
    setReasonerForTests(new ScriptedModel(() => ({ selectedOfferId: "offer-dining-table", advancesTransaction: false, readRequested: true })));
    const out = await handleCustomerMessage(getBusinessGraph("furniture-store"), conv("stock"), "c", "do a real inventory lookup, just that read");
    expect(out.turn.trace?.steps.map((s) => s.action)).toEqual(["checkInventory"]);
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
  });

  it("an availability claim needs a lookup in THIS turn", async () => {
    const model = new ScriptedModel(() => ({ selectedOfferId: "offer-free-consult", advancesTransaction: false }));
    model.write = () => "I checked the calendar, and the free consultation is available on Wednesday at 12:15.";
    setReasonerForTests(model);
    const out = await handleCustomerMessage(getBusinessGraph("personal-trainer"), conv("fake-read"), "c", "is Wednesday 12:15 free?");
    expect(out.response).not.toMatch(/is available/);
  });

  it("'only change the size, don't check out' updates the line and never requests checkout", () => {
    const g = getBusinessGraph("fashion-retailer");
    const state = createInitialConversationState("c-var", g.business.id, "c");
    Object.assign(state.knownFields, { [SCRATCH_KEYS.commerceCartId]: "cart-1", [SCRATCH_KEYS.commerceCartLineId]: "line-1", [SCRATCH_KEYS.commerceCheckoutRequested]: "1" });
    const ir = { intent: "x", entities: {}, constraints: {}, customerInfo: {}, purchaseDecision: true, checkoutConsent: false, commerce: { intent: "change_variant", variant: { size: "L" }, reference: { type: "cart_line", index: 0 } } } as BarryIR;
    const out = compile(g, state, ir);
    expect(out).toMatchObject({ kind: "action", action: { name: "updateCartLine" } });
    expect(state.knownFields[SCRATCH_KEYS.commerceCheckoutRequested]).toBeUndefined();
    expect(state.knownFields[SCRATCH_KEYS.commerceCheckoutOnSuccess]).toBeUndefined();
  });
});

// ── 5. Regeneration, language ──────────────────────────────────────────

describe("a failing draft is regenerated whole — dependent conclusions don't survive", () => {
  it("invented dimensions + 'fits perfectly' -> the composer is asked to rewrite with the problems; the rewrite is used", async () => {
    const model = new ScriptedModel(() => ({ selectedOfferId: "offer-dining-table", advancesTransaction: false }));
    model.write = (input) =>
      input.repair ? "I don't have the table's exact dimensions, so I can't tell whether it fits a 180 cm recess." : "The table is 160 cm wide, so it will fit perfectly in your 180 cm recess.";
    setReasonerForTests(model);
    const out = await handleCustomerMessage(getBusinessGraph("furniture-store"), conv("fit"), "c", "recess is 180cm. will the Birchwood fit?");
    expect(model.repairs).toHaveLength(1);
    expect(model.repairs[0]!.problems.join(" ")).toMatch(/measurement/);
    expect(out.response).not.toMatch(/fit perfectly|160/);
    expect(out.turn.trace?.reply?.fallback).toMatch(/regenerated/);
  });

  it("an English conversation never gets a Hebrew reply (checked by script, then regenerated or rendered)", async () => {
    const model = new ScriptedModel(() => ({ advancesTransaction: false }));
    model.write = () => "אנחנו לא מציעים שירותי גרירה או איסוף רכבים מהבית.";
    setReasonerForTests(model);
    const out = await handleCustomerMessage(getBusinessGraph("garage"), conv("lang"), "c", "nah dont schedule me. can you tow it in?");
    expect(languageMismatch(out.response, "en")).toBeUndefined();
    expect(out.turn.trace?.reply?.fallback).toMatch(/language/);
  });
});

// ── 6. Authoritative approval lifecycle ────────────────────────────────

describe("approval lifecycle is authoritative for the owner UI", () => {
  it("active / superseded / withdrawn / declined / executed are distinguishable, with revisions", async () => {
    const ticket = (reference: string) => ({ capabilityRequest: { capability: "support.ticket.create", input: { reference, reason: "delivery_delay" }, purpose: "case" }, advancesTransaction: true });
    const model = new ScriptedModel((ctx, fresh) => {
      if (fresh.length) return undefined;
      const ref = ctx.customerMessage.match(/R-\d{4}/)?.[0];
      if (/correct/.test(ctx.customerMessage) && ref) return { ...ticket(ref), changesPendingRequest: true };
      if (/cancel/.test(ctx.customerMessage)) return { withdrawsRequest: true };
      return ref ? ticket(ref) : { advancesTransaction: false };
    });
    setReasonerForTests(model);
    const g = buildLogisticsDemoGraph();
    const id = conv("life");
    await handleCustomerMessage(g, id, "c", "case for R-1001");
    await handleCustomerMessage(g, id, "c", "correct: R-1002");
    const pending = (await approvalsOf(g, id)).find((a) => a.status === "pending")!;
    await resumeAfterApproval(g, pending.id, "approved", "owner");
    await handleCustomerMessage(g, id, "c", "case for R-2001");
    const p2 = (await approvalsOf(g, id)).find((a) => a.status === "pending")!;
    await resumeAfterApproval(g, p2.id, "declined", "owner");
    await handleCustomerMessage(g, id, "c", "case for R-3001");
    const withdrawn = await handleCustomerMessage(g, id, "c", "cancel that last one");
    const all = await approvalsOf(g, id);
    const view = withLifecycle(all, new Map([[id, withdrawn.state]]));
    const byRef = Object.fromEntries(view.map((a) => [String((a.requestedInput as { input: { reference: string } }).input.reference), a]));
    expect(byRef["R-1001"].lifecycle).toBe("superseded");
    expect(byRef["R-1002"]).toMatchObject({ lifecycle: "executed", revision: 2 });
    expect(byRef["R-2001"].lifecycle).toBe("declined");
    expect(byRef["R-3001"].lifecycle).toBe("withdrawn");
    expect(view.filter((a) => a.lifecycle === "active")).toHaveLength(0);
    expect(demoHelpdeskTickets()).toHaveLength(1);
  });
});
