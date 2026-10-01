import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { readLedger } from "@/lib/runtime/ledger";
import { readHandoffs } from "@/lib/runtime/handoff";
import { SCRATCH_KEYS } from "@/lib/runtime/compiler";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { authorityForModel } from "@/lib/reasoner/openai-reasoner";
import { decide } from "@/lib/policy";
import { effectiveGraph } from "@/lib/policy/effective";
import { compileDiscountAuthority, discountPolicyOf, resolveEffectiveAuthority } from "@/lib/policy/effective-rules";
import { answerOwnerQuestion, LearnBusinessInputError, reviewLearnedFact } from "@/lib/learn-business/service";
import { trainBarryView } from "@/lib/learn-business/train";
import { actionWords, whyApproval } from "@/lib/owner/interventions";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { productGrantTotal } from "@/lib/commerce/capability";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { getBackend } from "@/lib/store";
import type { BusinessGraph } from "@/lib/business-graph";
import type { LearnedFactRecord } from "@/lib/store/types";
import { ScriptedModel, approvalsOf, conv } from "./support/scripted-model";

/**
 * TRAIN BARRY → EFFECTIVE RUNTIME AUTHORITY (live High on e946291): the owner taught Rina "Up to 5%
 * without approval. Anything above 5% requires owner approval." — Train BARRY showed it as known, yet
 * the runtime read only the static profile, and "10% off the Midnight Wrap Dress?" (no cart) got a
 * refusal and no owner request. These tests pin the contract: ONE effective resolution feeds policy,
 * reasoner context, Train BARRY and the Inspector; a pre-cart discount on a named product becomes ONE
 * owner approval with exact terms and never a checkout or cart change. Scripted model (the IR a model
 * would produce); grounding, compile, policy, approvals, tools and ledger are the real runtime.
 */

const RULE = "Up to 5% without approval. Anything above 5% requires owner approval.";
const ASK = "Can you give me 10% off the Midnight Wrap Dress?";
const MIDNIGHT = "Midnight Wrap Dress";
const discountAsk = (pct: number, subject = MIDNIGHT): Partial<BarryIR> => ({
  intent: "negotiate_product_discount",
  commerce: { intent: "negotiate_price", subject },
  constraints: { discountPct: pct },
  advancesTransaction: true,
});

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  dispose?.();
  dispose = undefined;
});

function tenant(staticPct?: number) {
  const id = `t-train-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const catalog = fashionCatalog();
  const commerce = new MemoryCommerceAdapter(catalog);
  registerCommerceAdapterFactoryForTests(id, () => commerce);
  const payments = new MemoryPaymentAdapter();
  setPaymentAdapterForTests(payments);
  const base = buildFashionRetailerGraph();
  const policies = staticPct === undefined ? base.policies : base.policies.map((p) => (p.rule.type === "max_auto_discount_pct" ? { ...p, rule: { type: "max_auto_discount_pct" as const, value: staticPct } } : p));
  const g: BusinessGraph = { ...base, business: { ...base.business, id }, policies };
  dispose = () => {
    registerCommerceAdapterFactoryForTests(id, undefined);
    setPaymentAdapterForTests(undefined);
  };
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { g, catalog, commerce, model };
}

const teach = (g: BusinessGraph, value: string, key = "authority.discounts") => answerOwnerQuestion({ businessId: g.business.id, key, value, answeredBy: "owner-rina" });
const grantDecision = async (g: BusinessGraph, pct: number) => decide(await effectiveGraph(g), { action: "grantDiscount", params: { discountPct: pct, item: MIDNIGHT } });
const facts = (g: BusinessGraph) => getBackend().listLearnedFacts(g.business.id);

describe("discount authority compiles from the owner's words — bounded, never guessed", () => {
  it("the exact live teaching compiles to a 5% automatic limit", () => {
    expect(compileDiscountAuthority(RULE)).toEqual({ ok: true, pct: 5, basis: "percentage" });
    expect(compileDiscountAuthority("8%")).toMatchObject({ ok: true, pct: 8 });
    expect(compileDiscountAuthority("עד 7 אחוז בלי אישור")).toMatchObject({ ok: true, pct: 7 });
    expect(compileDiscountAuthority("none")).toMatchObject({ ok: true, pct: 0 });
  });
  it("two different limits, no number, or a value above the hard limit never compile", () => {
    expect(compileDiscountAuthority("5% normally, up to 15% for VIPs")).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(compileDiscountAuthority("small discounts are fine")).toMatchObject({ ok: false, reason: "no_percentage" });
    expect(compileDiscountAuthority("50%")).toMatchObject({ ok: false, reason: "above_hard_limit" });
  });
});

describe("A–E: correction, rejection, supersession — one deterministic effective rule", () => {
  it("A. teach 5% → 4% allowed, 10% requires approval — governed by the owner-trained rule", async () => {
    const { g } = tenant(3); // the static profile says 3%: the taught 5% must be what decides
    const fact = await teach(g, RULE);
    const four = await grantDecision(g, 4);
    expect(four.status).toBe("allowed");
    expect(four.authority).toMatchObject({ effectiveMax: 5, source: "owner_trained", factId: fact.id, reviewer: "owner-rina", requested: 4, result: "allowed" });
    const ten = await grantDecision(g, 10);
    expect(ten.status).toBe("requires_approval");
    expect(ten.authority).toMatchObject({ effectiveMax: 5, source: "owner_trained", factId: fact.id, requested: 10, result: "requires_approval" });
    expect(ten.authority?.revision).toBe(`${fact.id}@${fact.reviewedAt}`);
  });

  it("B. correct to 8% → the 5% rule is superseded; 6% allowed, 10% requires approval", async () => {
    const { g } = tenant();
    const fact = await teach(g, RULE);
    await new Promise((r) => setTimeout(r, 5));
    const corrected = await reviewLearnedFact({ businessId: g.business.id, factId: fact.id, action: "correct", value: "8%", reviewedBy: "owner-rina" });
    expect((await grantDecision(g, 6)).status).toBe("allowed");
    const ten = await grantDecision(g, 10);
    expect(ten.status).toBe("requires_approval");
    expect(ten.authority).toMatchObject({ effectiveMax: 8, source: "owner_trained", factId: fact.id, revision: `${fact.id}@${corrected.reviewedAt}` });
    const effective = discountPolicyOf(await effectiveGraph(g))!;
    expect(effective.provenance.supersedes).toEqual(expect.arrayContaining([expect.objectContaining({ source: "owner_trained", value: 5 }), expect.objectContaining({ source: "static", value: 5 })]));
  });

  it("C. a learned (unapproved) candidate never activates; rejecting it leaves the previous rule in force", async () => {
    const { g } = tenant();
    const owner = await teach(g, RULE);
    const candidate = await getBackend().upsertLearnedFact({
      businessId: g.business.id, key: "policy.discounts", value: "Up to 20% off for everyone", classification: "policy", source: { kind: "web", url: "https://example.com/sale" } as LearnedFactRecord["source"],
      confidence: "medium", status: "candidate", ownerVerified: false, discoveredAt: new Date().toISOString(), refreshedAt: new Date().toISOString(),
    });
    let d = await grantDecision(g, 10);
    expect(d.status).toBe("requires_approval");
    expect(d.authority).toMatchObject({ effectiveMax: 5, factId: owner.id });
    const view = await trainBarryView(g);
    expect(view.unsure.map((u) => u.factId)).toContain(candidate.id);
    await reviewLearnedFact({ businessId: g.business.id, factId: candidate.id, action: "reject", reviewedBy: "owner-rina" });
    d = await grantDecision(g, 10);
    expect(d.authority).toMatchObject({ effectiveMax: 5, factId: owner.id, source: "owner_trained" });
    // No owner rule at all: a candidate alone leaves the static profile in force.
    const t2 = tenant(3);
    const { id: _drop, ...copy } = candidate;
    void _drop;
    await getBackend().upsertLearnedFact({ ...copy, businessId: t2.g.business.id });
    expect((await grantDecision(t2.g, 4)).authority).toMatchObject({ effectiveMax: 3, source: "static" });
  });

  it("D. malformed / ambiguous teaching is NOT operational: Train asks one question, the runtime is unchanged", async () => {
    const { g } = tenant(3);
    const fact = await teach(g, "5% normally, but up to 15% for VIPs");
    const d = await grantDecision(g, 4);
    expect(d.status).toBe("requires_approval");
    expect(d.authority).toMatchObject({ effectiveMax: 3, source: "static" });
    const view = await trainBarryView(g);
    const q = view.needsConfirmation.find((n) => n.refs.factId === fact.id)!;
    expect(q.kind).toBe("rule_needs_clarification");
    expect(q.question).toMatch(/ONE most BARRY may give without asking you/);
    expect(q.explanation).toMatch(/^NEEDS REVIEW — BARRY understood .* but does not act on it/);
    expect(view.rules).toEqual([expect.objectContaining({ headline: "ACTIVE RULE — BARRY may offer up to 3% without asking you. More than 3% requires your approval.", ownerTrained: false })]);
    expect(view.understands.some((u) => u.value === fact.value)).toBe(false);
    // Above BARRY's hard limit: blocked, never active.
    const blocked = await teach(g, "40%", "policy.discount_limit");
    expect((await grantDecision(g, 4)).authority).toMatchObject({ effectiveMax: 3, source: "static" });
    expect((await trainBarryView(g)).needsConfirmation.find((n) => n.refs.factId === blocked.id)?.kind).toBe("blocked_rule");
    // Replacing an OPERATIONAL rule with words that don't compile is refused: the rule stays in force.
    const { g: g2 } = tenant(3);
    const ok = await teach(g2, RULE);
    await expect(teach(g2, "whatever feels right")).rejects.toThrow(LearnBusinessInputError);
    await expect(reviewLearnedFact({ businessId: g2.business.id, factId: ok.id, action: "correct", value: "5% or 10%", reviewedBy: "owner-rina" })).rejects.toThrow(/keeps your current rule \(5%\)/);
    expect((await grantDecision(g2, 4)).authority).toMatchObject({ effectiveMax: 5, source: "owner_trained", factId: ok.id });
  });

  it("E. several records for the same rule resolve to ONE current version — deterministically", async () => {
    const { g } = tenant();
    const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, s)).toISOString();
    const mk = (key: string, value: string, reviewedAt: string) =>
      getBackend().upsertLearnedFact({ businessId: g.business.id, key, value, classification: "policy", source: { kind: "owner" }, confidence: "high", status: "verified", ownerVerified: true, reviewedBy: "owner-rina", reviewedAt, discoveredAt: reviewedAt, refreshedAt: reviewedAt });
    const older = await mk("authority.discounts", "4%", at(1));
    const newest = await mk("policy.discount_limit", "7%", at(3));
    const middle = await mk("authority.discount_limit", "6%", at(2));
    const all = await facts(g);
    const once = resolveEffectiveAuthority(g, all);
    const reversed = resolveEffectiveAuthority(g, [...all].reverse());
    expect(once.rules).toHaveLength(1);
    expect(once.rules[0]).toMatchObject({ value: 7, provenance: { factId: newest.id } });
    expect(reversed.rules[0].provenance).toEqual(once.rules[0].provenance);
    expect(once.trained.filter((t) => t.state === "active").map((t) => t.factId)).toEqual([newest.id]);
    expect(once.trained.filter((t) => t.state === "superseded").map((t) => t.factId).sort()).toEqual([older.id, middle.id].sort());
    expect(once.graph.policies.filter((p) => p.rule.type === "max_auto_discount_pct")).toHaveLength(1);
    expect((await grantDecision(g, 7)).status).toBe("allowed");
    expect((await grantDecision(g, 8)).status).toBe("requires_approval");
    // Re-resolving an already-effective graph never stacks overlays or trusts the old one.
    const twice = resolveEffectiveAuthority(once.graph, all);
    expect(twice.graph.policies.filter((p) => p.rule.type === "max_auto_discount_pct")).toEqual(once.graph.policies.filter((p) => p.rule.type === "max_auto_discount_pct"));
  });
});

describe("ONE source: Train BARRY, reasoner context and owner cards read the same effective rule", () => {
  it("Train shows the ACTIVE RULE in owner words; the reasoner context carries it; the owner card names its source", async () => {
    const { g } = tenant(3);
    await teach(g, RULE);
    const view = await trainBarryView(g);
    expect(view.rules).toEqual([expect.objectContaining({ headline: "ACTIVE RULE — BARRY may offer up to 5% without asking you. More than 5% requires your approval.", source: "Source: You taught BARRY.", ownerTrained: true })]);
    const row = view.understands.find((u) => u.value === RULE)!;
    expect(row).toMatchObject({ label: "Discount rule", status: "active", statusWords: "ACTIVE" });
    expect(row.why).toBe("ACTIVE RULE — BARRY may offer up to 5% without asking you. More than 5% requires your approval. Source: You taught BARRY.");
    // The profile's 3% is shown as replaced — never as a second active rule.
    expect(view.understands.find((u) => u.label === "Discount rule (business profile)")).toMatchObject({ status: "replaced" });
    expect(view.understands.filter((u) => u.status === "active" && /^Discount rule$/.test(u.label))).toHaveLength(1);
    const eg = await effectiveGraph(g);
    expect(authorityForModel(eg)).toMatchObject({ maxAutomaticDiscountPct: 5, discountRule: { words: "BARRY may offer up to 5% without asking you. More than 5% requires your approval.", source: "taught by the owner" } });
    expect(whyApproval(eg, { policyId: "max_auto_discount_pct", requestedAction: "grantDiscount", requestedInput: {} } as never)).toBe("Above the 5% you taught BARRY it may give on its own.");
  });

  it("an approved fact no runtime rule reads is UNDERSTOOD ONLY — never presented as acted on", async () => {
    const { g } = tenant();
    await teach(g, "Sun–Thu 10:00–19:00", "hours.opening");
    const row = (await trainBarryView(g)).understands.find((u) => u.key === "hours.opening")!;
    expect(row).toMatchObject({ status: "understood_only", statusWords: "UNDERSTOOD ONLY" });
    expect(row.why).toMatch(/doesn't change what BARRY does/);
  });
});

describe("MOVE 8 — exact live regression: taught 5% rule, fresh conversation, 10% off the Midnight Wrap Dress with no cart", () => {
  async function liveCase() {
    const t = tenant();
    const fact = await teach(t.g, RULE);
    const id = conv("train-discount");
    t.model.plan = () => discountAsk(10);
    const res = await handleCustomerMessage(t.g, id, "c-rina", ASK);
    return { ...t, fact, id, res };
  }

  it("grounds the product, asks the owner ONCE with exact terms, refuses nothing, hands off nothing, touches no cart or checkout", async () => {
    const { g, fact, id, res } = await liveCase();
    const steps = res.turn.trace?.steps ?? [];
    expect(steps.map((s) => s.action)).toEqual(["grantDiscount"]);
    expect(steps[0].policy.status).toBe("requires_approval");
    expect(steps[0].ownerRequest).toBe("requested");
    // The Inspector points at the owner-trained effective rule.
    expect(steps[0].policy.authority).toMatchObject({ effectiveMax: 5, source: "owner_trained", factId: fact.id, revision: `${fact.id}@${fact.reviewedAt}`, reviewer: "owner-rina", requested: 10, result: "requires_approval" });
    const approvals = await approvalsOf(g, id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "pending", requestedAction: "grantDiscount" });
    expect(approvals[0].requestedInput).toMatchObject({ productId: "prod-midnight-wrap-dress", discountPct: 10, item: MIDNIGHT, listAmount: 420, currency: "ILS" });
    expect(`Approve ${actionWords(g, approvals[0] as never)}`).toBe("Approve 10% off Midnight Wrap Dress (₪420 → ₪378)");
    // No false refusal: the customer hears the owner is being asked.
    expect(res.response).toBe("I'm checking that with the owner — I'll update you here as soon as I hear back.");
    expect(res.response).not.toMatch(/can't|cannot|unable|not able/i);
    // No discount granted yet, no handoff, no cart, no checkout, no payment.
    const k = res.state.knownFields;
    expect(k[SCRATCH_KEYS.discountGranted]).toBeUndefined();
    expect(readHandoffs(res.state)).toHaveLength(0);
    expect(k[SCRATCH_KEYS.commerceCartId]).toBeUndefined();
    expect(k[SCRATCH_KEYS.commerceCheckoutId]).toBeUndefined();
    expect(k[SCRATCH_KEYS.paymentRequestId]).toBeUndefined();
    expect(readLedger(res.state).map((e) => e.effect)).not.toEqual(expect.arrayContaining(["discount.granted", "cart.line_added"]));
  });

  it("approve → the scoped grant is recorded ONCE; a duplicate approval does nothing; still no cart or checkout", async () => {
    const { g, id } = await liveCase();
    const [approval] = await approvalsOf(g, id);
    const done = await resumeAfterApproval(g, approval.id, "approved", "owner-rina");
    expect(done.turn.toolResult?.ok).toBe(true);
    expect(done.response).toBe("Good news — the owner approved it. You've got 10% off the Midnight Wrap Dress — ₪378 instead of ₪420. It applies when you order it. Want me to add it to your cart?");
    const grant = JSON.parse(done.state.knownFields[SCRATCH_KEYS.discountGranted]);
    expect(grant).toEqual({ pct: 10, item: MIDNIGHT, productId: "prod-midnight-wrap-dress", unitAmount: 420, currency: "ILS" });
    const granted = () => readLedger(done.state).filter((e) => e.effect === "discount.granted");
    expect(granted()).toHaveLength(1);
    const again = await resumeAfterApproval(g, approval.id, "approved", "owner-rina");
    expect(again.response).toMatch(/already approved — nothing more to do/);
    const after = (await getBackend().listApprovals(g.business.id)).filter((a) => a.conversationId === id);
    expect(after).toHaveLength(1);
    expect(readLedger(again.state).filter((e) => e.effect === "discount.granted")).toHaveLength(1);
    expect(again.state.knownFields[SCRATCH_KEYS.commerceCartId]).toBeUndefined();
    expect(again.state.knownFields[SCRATCH_KEYS.paymentRequestId]).toBeUndefined();
  });

  it("decline → no grant", async () => {
    const { g, id } = await liveCase();
    const [approval] = await approvalsOf(g, id);
    const r = await resumeAfterApproval(g, approval.id, "declined", "owner-rina");
    expect(r.state.knownFields[SCRATCH_KEYS.discountGranted]).toBeUndefined();
    expect(readLedger(r.state).some((e) => e.effect === "discount.granted")).toBe(false);
  });

  it("within the taught limit (≤5%) the discount is granted on the product at once — no owner request", async () => {
    const t = tenant(3);
    await teach(t.g, RULE);
    const id = conv("train-4pct");
    t.model.plan = () => discountAsk(4);
    const res = await handleCustomerMessage(t.g, id, "c", "Could I get 4% off the Midnight Wrap Dress?");
    expect(res.turn.trace?.steps[0]).toMatchObject({ action: "grantDiscount", policy: { status: "allowed", authority: { effectiveMax: 5, source: "owner_trained", requested: 4 } } });
    expect(await approvalsOf(t.g, id)).toHaveLength(0);
    expect(JSON.parse(res.state.knownFields[SCRATCH_KEYS.discountGranted])).toMatchObject({ pct: 4, productId: "prod-midnight-wrap-dress", unitAmount: 420 });
    expect(res.state.knownFields[SCRATCH_KEYS.commerceCartId]).toBeUndefined();
  });

  it("an unknown product is clarified, never invented; nothing is asked of the owner", async () => {
    const t = tenant();
    await teach(t.g, RULE);
    const id = conv("train-unknown");
    t.model.plan = () => discountAsk(10, "Aurora Ball Gown");
    const res = await handleCustomerMessage(t.g, id, "c", "10% off the Aurora Ball Gown?");
    expect(res.turn.trace?.steps ?? []).toHaveLength(0);
    expect(await approvalsOf(t.g, id)).toHaveLength(0);
  });

  it("variants that differ in price: only the option is asked; once named, the terms carry that price", async () => {
    const t = tenant();
    const midnight = t.catalog.find((p) => p.title === MIDNIGHT)!;
    midnight.variants[2].price = { amount: 460, currency: "ILS" }; // L costs more
    await teach(t.g, RULE);
    const id = conv("train-variant");
    t.model.plan = () => discountAsk(10);
    const ask = await handleCustomerMessage(t.g, id, "c", ASK);
    expect(ask.turn.trace?.steps ?? []).toHaveLength(0);
    expect(await approvalsOf(t.g, id)).toHaveLength(0);
    t.model.plan = () => ({ ...discountAsk(10), commerce: { intent: "negotiate_price", subject: MIDNIGHT, variant: { size: "L" } } });
    await handleCustomerMessage(t.g, id, "c", "10% off the Midnight Wrap Dress in L?");
    const [approval] = await approvalsOf(t.g, id);
    expect(approval.requestedInput).toMatchObject({ productId: "prod-midnight-wrap-dress", listAmount: 460, variant: { size: "L" } });
    expect(actionWords(t.g, approval as never)).toBe("10% off Midnight Wrap Dress (₪460 → ₪414)");
  });

  it("the grant applies later ONLY to that product at that price: the checkout charges ₪378 for the Midnight, full price otherwise", async () => {
    const { g, id, model, catalog } = await liveCase();
    const [approval] = await approvalsOf(g, id);
    await resumeAfterApproval(g, approval.id, "approved", "owner-rina");
    const who = { customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } };
    model.plan = () => ({ commerce: { intent: "select", subject: MIDNIGHT, variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
    const added = await handleCustomerMessage(g, id, "c-rina", "Add the Midnight Wrap Dress in M");
    expect(added.state.knownFields[SCRATCH_KEYS.commerceCartId]).toBeDefined();
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const paid = await handleCustomerMessage(g, id, "c-rina", "Checkout please, Adi 0505550114");
    const checkout = paid.turn.trace?.steps.find((s) => s.action === "createCommerceCheckout");
    expect(checkout?.result?.ok).toBe(true);
    expect(JSON.parse(paid.state.knownFields[SCRATCH_KEYS.commerceCartTotal])).toEqual({ amount: 378, currency: "ILS" });
    // A different product in another conversation's cart gets nothing from this grant.
    const other = conv("train-other");
    model.plan = () => ({ commerce: { intent: "select", subject: "Onyx Slip Dress", variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
    await handleCustomerMessage(g, other, "c-2", "Add the Onyx Slip Dress in M");
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const full = await handleCustomerMessage(g, other, "c-2", "Checkout please, Adi 0505550114");
    const onyx = catalog.find((p) => p.title === "Onyx Slip Dress")!.variants.find((v) => v.options.size === "M")!.price.amount;
    expect(JSON.parse(full.state.knownFields[SCRATCH_KEYS.commerceCartTotal])).toEqual({ amount: onyx, currency: "ILS" });
  });

  it("the approved grant is revalidated: a price change before approval grants nothing", async () => {
    const { g, id, catalog } = await liveCase();
    const [approval] = await approvalsOf(g, id);
    catalog.find((p) => p.title === MIDNIGHT)!.variants.forEach((v) => (v.price = { amount: 450, currency: "ILS" }));
    const r = await resumeAfterApproval(g, approval.id, "approved", "owner-rina");
    expect(r.turn.toolResult?.ok).toBe(false);
    expect(r.state.knownFields[SCRATCH_KEYS.discountGranted]).toBeUndefined();
  });
});

describe("a product grant at checkout fails closed when the price moved", () => {
  const line = (productId: string, amount: number, quantity = 1) => ({ id: `l-${productId}`, productId, variantId: "v", title: productId, quantity, unitPrice: { amount, currency: "ILS" }, options: { size: "M" } });
  it("applies only to the granted product's lines, and refuses a changed unit price", () => {
    const cart = { lines: [line("prod-midnight-wrap-dress", 420), line("prod-onyx", 390)], total: { amount: 810, currency: "ILS" } };
    expect(productGrantTotal(cart, { pct: 10, productId: "prod-midnight-wrap-dress", unitAmount: 420 })).toEqual({ amount: 768, currency: "ILS" });
    expect(productGrantTotal(cart, { pct: 10, productId: "prod-other", unitAmount: 420 })).toEqual({ amount: 810, currency: "ILS" });
    expect(() => productGrantTotal({ lines: [line("prod-midnight-wrap-dress", 450)], total: { amount: 450, currency: "ILS" } }, { pct: 10, productId: "prod-midnight-wrap-dress", unitAmount: 420 })).toThrow(/price changed/);
  });
});

describe("the effective rule fails closed when the owner's teaching can't be read", () => {
  it("no automatic discount while learned facts are unavailable — the owner decides", async () => {
    const { g } = tenant();
    const backend = getBackend();
    const original = backend.listLearnedFacts.bind(backend);
    backend.listLearnedFacts = async () => {
      throw new Error("store unavailable");
    };
    try {
      const d = await grantDecision(g, 2);
      expect(d.status).toBe("requires_approval");
      expect(d.authority).toMatchObject({ effectiveMax: 0, revision: "fail-closed:learned-facts-unavailable" });
    } finally {
      backend.listLearnedFacts = original;
    }
  });
});
