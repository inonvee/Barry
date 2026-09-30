import type { BusinessGraph } from "@/lib/business-graph";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { describeBusinessConnections } from "@/lib/connections/status";
import { money } from "@/lib/reasoner/deterministic-compose";
import { handoffPath } from "@/lib/runtime/handoff";
import { whatsappConfig, whatsappNumbersFor } from "@/lib/channels/whatsapp";
import { assessPilotReadiness, type PilotReadiness } from "./readiness";
import { assessCapabilities, type CapabilityAssessment } from "./capabilities";

/**
 * "TRAIN BARRY" — the assisted onboarding view for the first design partners.
 *
 * Eight sections the founder walks through WITH the owner, each derived from what BARRY actually runs on
 * (the Business Genome, its playbook and authority rules, connected systems, the capability surface) —
 * never a separate form that could disagree with the runtime. Every section says what is missing.
 * Editing happens in the Genome with the founder (assisted), not in a self-serve form yet.
 */

export type TrainingSection<T> = { title: string; data: T; missing: string[] };

const GOAL_WORDS: Record<string, string> = {
  completePurchase: "Sell (take orders and payment)",
  bookAppointment: "Book appointments",
  collectDeposit: "Collect deposits",
  qualifyLead: "Collect and qualify leads",
  requestQuote: "Handle quote requests",
};

const DAY: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function policyWords(graph: BusinessGraph): string[] {
  const cur = graph.offers[0]?.currency ?? "USD";
  return graph.policies.map((p) => {
    switch (p.rule.type) {
      case "max_auto_discount_pct":
        return `Discounts up to ${p.rule.value}% without asking you; above that, you approve.`;
      case "max_auto_payment_amount":
        return `Payment requests up to ${money(p.rule.value, cur)} go out automatically; above that, you approve.`;
      case "refund_requires_approval":
        return p.rule.value ? "Refunds always need your approval." : "Refunds don't need your approval.";
      case "bookings_auto_allowed":
        return p.rule.value ? "BARRY books appointments on its own." : "Every booking needs your approval.";
      case "custom_pricing_requires_approval":
        return p.rule.value ? "Any price change needs your approval." : "BARRY may adjust prices within your rules.";
      case "free_shipping_over":
        return `Free shipping above ${money(p.rule.value, cur)}.`;
      case "flat_shipping_fee":
        return `Shipping costs ${money(p.rule.value, cur)}.`;
    }
  });
}

export async function getTrainingProfile(graph: BusinessGraph) {
  const b = graph.business;
  const surface = await buildCapabilitySurface(graph).catch(() => []);
  const profiles = await resolveCapabilityProfiles(graph).catch(() => undefined);
  const connections = await describeBusinessConnections(b.id, profiles).catch(() => []);
  const readiness: PilotReadiness = await assessPilotReadiness(graph);
  // What BARRY can do for this business right now, what only works on a simulator, and what each setup step unlocks.
  const assessment: CapabilityAssessment = await assessCapabilities(graph, { profiles, connections });
  const wa = whatsappConfig();
  const activeOffers = graph.offers.filter((o) => o.active);

  const identity: TrainingSection<Record<string, string>> = {
    title: "Business identity",
    data: { name: b.name, description: b.description, language: b.locale, timezone: b.timezone, hours: b.operatingHours.map((h) => `${DAY[h.day]} ${h.open}–${h.close}`).join(", ") || "—" },
    missing: [!b.description.trim() && "A short description of the business", b.operatingHours.length === 0 && activeOffers.some((o) => o.requiresScheduling) && "Opening hours"].filter(Boolean) as string[],
  };
  const goals: TrainingSection<string[]> = { title: "Goals", data: graph.goals.map((g) => GOAL_WORDS[g] ?? g), missing: graph.goals.length ? [] : ["What BARRY should achieve"] };
  const offers: TrainingSection<{ offers: { name: string; price: string; bookable: boolean; payment: boolean }[]; knowledge: { topic: string; kind: string }[]; policies: string[] }> = {
    title: "Products, services & knowledge",
    data: {
      offers: activeOffers.map((o) => ({ name: o.name, price: o.price === null ? "Quote on request" : money(o.price, o.currency), bookable: o.requiresScheduling, payment: o.requiresPayment })),
      knowledge: graph.knowledge.map((k) => ({ topic: k.topic, kind: k.kind })),
      policies: policyWords(graph),
    },
    missing: [activeOffers.length === 0 && "Products or services", graph.knowledge.length === 0 && "Policies and FAQs (returns, delivery, …)"].filter(Boolean) as string[],
  };
  const stack: TrainingSection<{ domain: string; provider: string | null; state: string; missing: string[] }[]> = {
    title: "Systems (your stack)",
    data: [
      ...connections.map((c) => ({ domain: c.capability, provider: c.provider, state: c.status === "connected" ? (c.simulated ? "simulated" : "connected") : c.status, missing: c.missing })),
      { domain: "whatsapp", provider: wa.configured ? "WhatsApp Cloud API" : null, state: wa.configured && whatsappNumbersFor(b.id).length ? (wa.sendMode === "live" ? "connected" : "dry run") : "not_configured", missing: wa.missing },
    ],
    missing: connections.filter((c) => c.status === "connected" && c.simulated).map((c) => `A real ${c.capability} system (running on a simulator today)`),
  };
  const buckets = { read: [] as string[], automatic: [] as string[], approval: [] as string[], conditional: [] as string[], never: [] as string[] };
  for (const c of surface) {
    if (c.authority === "not_permitted") buckets.never.push(c.purpose);
    else if (c.effect === "read") buckets.read.push(c.purpose);
    else if (c.authority === "owner_approval") buckets.approval.push(c.purpose);
    else if (c.authority === "conditional") buckets.conditional.push(c.purpose);
    else buckets.automatic.push(c.purpose);
  }
  for (const a of graph.availableActions.filter((x) => x.enabled)) {
    const words: Record<string, [keyof typeof buckets, string]> = {
      checkAvailability: ["read", "Look up open appointment times"],
      searchProducts: ["read", "Search the catalog"],
      checkInventory: ["read", "Check stock"],
      verifyPayment: ["read", "Check whether a payment was made"],
      createBooking: ["automatic", "Book appointments"],
      addToCart: ["automatic", "Add items to the customer's cart"],
      createPaymentRequest: ["conditional", "Send payment links (within your limits)"],
      createCommerceCheckout: ["conditional", "Send checkout links (within your limits)"],
      createLead: ["automatic", "Record enquiries for your team"],
    };
    const w = words[a.name];
    if (w && !buckets[w[0]].includes(w[1])) buckets[w[0]].push(w[1]);
  }
  const capabilities: TrainingSection<typeof buckets> = { title: "What BARRY can do", data: buckets, missing: [] };
  const authority: TrainingSection<{ policies: string[]; rules: { capability: string; effect: string; reason?: string }[] }> = {
    title: "Your authority",
    data: { policies: policyWords(graph).filter((p) => !/shipping/i.test(p)), rules: graph.authority.map((r) => ({ capability: surface.find((c) => c.id === r.capability)?.purpose ?? r.capability, effect: r.effect === "allow" ? "BARRY may do it" : r.effect === "require_approval" ? "You approve first" : "Never", ...(r.reason ? { reason: r.reason } : {}) })) },
    missing: readiness.checks.filter((c) => c.area === "authority" && c.status !== "pass").map((c) => c.detail),
  };
  const personality: TrainingSection<Record<string, string>> = {
    title: "Personality & playbook",
    data: {
      tone: `${b.tone.voice}, ${b.tone.formality}${b.tone.emojiOk ? ", emoji ok" : ""}`,
      salesStyle: graph.playbook.salesStyle ?? "—",
      suggestions: graph.playbook.suggestions === "one_relevant" ? "May suggest one relevant addition" : "Never suggests extras",
      checkout: graph.playbook.commerce.advanceToCheckout === "on_purchase_decision" ? "Moves to checkout once the customer decides" : "Waits until the customer asks to pay",
      checkoutDetails: graph.playbook.commerce.checkoutRequires.join(", ") || "—",
      handoff: handoffPath(graph) ?? "—",
    },
    missing: [!graph.playbook.salesStyle && "How you want BARRY to sell (your own words)", !handoffPath(graph) && "How your team takes over when a customer needs a person"].filter(Boolean) as string[],
  };
  return { business: { id: b.id, name: b.name }, sections: { identity, goals, offers, stack, capabilities, authority, personality }, readiness, assessment };
}
