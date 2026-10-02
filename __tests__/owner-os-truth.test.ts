import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { activeWork } from "@/lib/owner/control-room";
import { todayStory } from "@/components/owner/views/Today";
import { getOwnerOs, capabilityTruth } from "@/lib/owner/os-service";
import { ownerKnowledge, ownerRules } from "@/lib/owner/os";
import { policyWords } from "@/lib/policy/words";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { Obligation } from "@/lib/operator/obligation-model";
import type { OwnerOperationView } from "@/lib/owner/operation-model";
import type { InitiativeView } from "@/lib/initiative/model";
import type { Intervention } from "@/lib/owner/interventions";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import { isolatedRetailer } from "./support/scripted-model";

/**
 * LIVE-REVIEW TRUTH REPAIRS:
 *  1. Today said "working on 15 things" while Work showed 2: Today summed obligation counts + live
 *     conversations; Work counted work streams. Both now read ONE definition (activeWork).
 *  2. Knowledge leaked internal keys ("policy rule bookings auto allowed", "Business Genome", raw time
 *     zones). It is now organised by owner concepts.
 *  3. Rules said "BARRY books on its own" while Knowledge said "No bookings": Knowledge printed a stale
 *     policy DESCRIPTION, Rules the rule VALUE. Both now use the rule value (policyWords), and what a
 *     rule allows is kept apart from what a connected system can do.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

const ob = (o: Partial<Obligation>): Obligation =>
  ({ key: `k:${Math.random()}`, businessId: "b", kind: "unpaid_payment_followup", source: "s", evidence: [], conversationId: `c:${Math.random()}`, customer: "Dana", subject: "₪420 payment link", reason: "r", desiredOutcome: "d", nextAction: "n", nextMove: "waiting_on_customer", owner: "customer", eligibleAt: "2026-10-01T00:00:00.000Z", status: "waiting_on_customer", authority: "none", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", amount: 420, currency: "ILS", attempts: 1, ...o }) as Obligation;

const op = (state: OwnerOperationView["derivedState"]): OwnerOperationView =>
  ({ id: `op_${Math.random().toString(16).slice(2, 14)}`, workflow: "abandoned_checkout_recovery", derivedState: state, state, title: "Recovering abandoned checkouts", targets: [], progress: { cohort: 5, contacted: 3, replied: 1, purchased: 0, stillTalking: 1, waiting: 2, excluded: 1, alreadyDone: 0, failed: 0, test: 0, recovered: {} }, requestedBy: { source: "whatsapp" }, scope: { kind: "open", label: "open" } }) as unknown as OwnerOperationView;

function workspace(over: Partial<OwnerWorkspace>): OwnerWorkspace {
  return {
    window: { since: "", label: "today" },
    today: { conversations: 0, handledAutonomously: 0, needYou: 0, interventions: 0, approvalsWaiting: 0, handoffsOpen: 0, completedOutcomes: 0, blockedOrFailed: 0 },
    revenue: { direct: {}, directPayments: 0 } as OwnerWorkspace["revenue"],
    interventions: [],
    obligations: [],
    ownerOperations: [],
    operator: { included: true, rules: [{ kind: "unpaid_payment_followup", enabled: true, afterHours: 24, maxAttempts: 2, intervalHours: 24 }] },
    conversations: [],
    initiatives: [],
    ...over,
  } as OwnerWorkspace;
}

describe("1. one canonical definition of active work (Today = Work)", () => {
  it("Today's count is the active-work count — not obligation counts, not live conversations", () => {
    // 12 open unpaid links (one follow-up stream), one running operation, 3 live conversations, 4 decisions, 2 noticed.
    const ws = workspace({
      obligations: Array.from({ length: 12 }, () => ob({})),
      ownerOperations: [op("running"), op("completed"), op("proposed")],
      conversations: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, status: "in_progress" })) as OwnerWorkspace["conversations"],
      interventions: Array.from({ length: 4 }, (_, i) => ({ id: `i${i}` })) as Intervention[],
      initiatives: [{ id: "n1", state: "surfaced" }, { id: "n2", state: "acting", alreadyHandled: true }] as InitiativeView[],
    });
    const work = activeWork(ws);
    expect(work.map((w) => w.kind).sort()).toEqual(["followup", "operation"]);
    expect(todayStory(ws).things).toBe(work.length); // 2 — the live review saw 15 here
    expect(todayStory(ws).needs).toBe(4);
  });

  it("waiting decisions are not active work", () => {
    const ws = workspace({ interventions: Array.from({ length: 4 }, (_, i) => ({ id: `i${i}` })) as Intervention[], ownerOperations: [op("proposed")] });
    expect(activeWork(ws)).toEqual([]);
    expect(todayStory(ws).things).toBe(0);
  });

  it("noticed items never add active work, even when already handled (the handling operation is counted once)", () => {
    const ws = workspace({ initiatives: [{ id: "n1", state: "acting", alreadyHandled: true }, { id: "n2", state: "surfaced" }] as InitiativeView[] });
    expect(activeWork(ws)).toEqual([]);
  });

  it("a follow-up rule that is off, or not in the plan, is not active work", () => {
    const obligations = Array.from({ length: 3 }, () => ob({}));
    expect(activeWork(workspace({ obligations, operator: { included: false, rules: [] } }))).toEqual([]);
    expect(activeWork(workspace({ obligations, operator: { included: true, rules: [{ kind: "unpaid_payment_followup", enabled: false, afterHours: 24, maxAttempts: 2, intervalHours: 24 }] } }))).toEqual([]);
  });
});

describe("2 & 3. Knowledge speaks owner concepts; Rules and Knowledge never contradict", () => {
  const INTERNAL = /Genome|policy engine|policy\.rule|\bpolicy\.|auto allowed|bookings_auto|max_auto|Asia\/|authority\.|_/;

  for (const lang of ["en", "he"] as const) {
    it(`Knowledge (${lang}) has no internal keys, engine names or raw time zones in its primary text`, async () => {
      const r = isolatedRetailer();
      dispose = r.dispose;
      const os = await getOwnerOs(r.g, lang);
      for (const g of os.knowledge) {
        expect(g.title).not.toMatch(INTERNAL);
        for (const i of g.items) {
          expect(i.title, i.id).not.toMatch(INTERNAL);
          expect(i.belief, i.id).not.toMatch(/Genome|policy engine|policy\.rule|auto allowed|Asia\//);
          if (i.sourceWords) expect(i.sourceWords).not.toMatch(INTERNAL);
        }
      }
      // The concepts an owner thinks in.
      expect(os.knowledge.map((g) => g.concept)).toEqual(expect.arrayContaining(["products", "delivery", "returns", "discounts", "bookings", "hours"]));
    });
  }

  it("booking: Rules and Knowledge state the same permission AND the same availability (no 'No bookings' contradiction)", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const os = await getOwnerOs(r.g);
    const rule = os.rules.rules.find((x) => x.area === "bookings")!;
    const know = os.knowledge.find((g) => g.concept === "bookings")!.items.find((i) => i.id.startsWith("rule."))!;
    const permission = policyWords({ type: "bookings_auto_allowed", value: true }, null).words;
    expect(rule.words).toBe(permission);
    expect(know.belief).toContain(permission);
    // Rina has no booking system: the permission is real, the capability is not — both say so.
    expect(os.capabilities.bookings).toBe("not_used");
    expect(rule.availability?.words).toMatch(/no booking system is connected/);
    expect(know.belief).toContain(rule.availability!.words);
    expect(JSON.stringify([os.rules, os.knowledge])).not.toMatch(/No bookings/);
  });

  it("permission and provider availability are computed separately", () => {
    const profile = (o: Partial<CapabilityProfiles["scheduling"]>) => ({ scheduling: { capability: "scheduling", used: true, provider: "memory", status: "connected", simulated: true, operations: [], missingOperations: [], capabilities: ["scheduling.booking.create"], ...o } }) as unknown as CapabilityProfiles;
    const graph = { availableActions: [{ name: "createBooking", enabled: true }] };
    expect(capabilityTruth(graph, profile({})).bookings).toBe("simulated");
    expect(capabilityTruth(graph, profile({ simulated: false })).bookings).toBe("real");
    expect(capabilityTruth(graph, profile({ status: "not_configured" })).bookings).toBe("not_connected");
    expect(capabilityTruth({ availableActions: [] }, undefined).bookings).toBe("not_used");
    // The same permission rule reads the same, whatever the availability; only the availability note differs.
    const base = { policies: [{ id: "p", description: "anything at all", rule: { type: "bookings_auto_allowed" as const, value: true } }], currency: null, authority: [], trained: [], followUps: { included: false, rules: [] }, declaredFollowUps: [], controls: { mode: "simulator" as const, pauseConsequentialWrites: false, approvalRequiredForAll: false, pausedCapabilities: [], disabledChannels: [], pausedBusiness: false, safeMode: false, reason: "" }, hardMaxDiscountPct: 30 };
    const real = ownerRules({ ...base, capabilities: { bookings: "real", payments: "real", refunds: "real", checkout: "real" } }).rules.find((x) => x.area === "bookings")!;
    const none = ownerRules({ ...base, capabilities: { bookings: "not_connected", payments: "real", refunds: "real", checkout: "real" } }).rules.find((x) => x.area === "bookings")!;
    expect(real.words).toBe(none.words);
    expect(real.availability).toBeUndefined();
    expect(none.availability?.words).toMatch(/No booking system is connected/);
    // The stale free-text description is never shown.
    expect(JSON.stringify(ownerKnowledge({ graph: { business: { timezone: "UTC", operatingHours: [] }, offers: [], knowledge: [], policies: base.policies, playbook: {} } as never, currency: null, capabilities: { bookings: "not_connected", payments: "not_used", refunds: "not_used", checkout: "not_used" }, known: [], unsure: [], missing: [], questions: [] }))).not.toMatch(/anything at all/);
  });
});
