import type { BusinessGraph } from "@/lib/business-graph";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { effectiveGraph } from "@/lib/policy/effective";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { describeBusinessConnections, type ConnectionView } from "@/lib/connections/status";
import { listBusinessSystems } from "@/lib/fabric/registry";
import { capabilityDomain, type CapabilityId } from "@/lib/fabric/capability";
import type { CapabilitySurfaceEntry } from "@/lib/reasoner/types";
import { getReasoner } from "@/lib/reasoner";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { businessesWithOwnerAccess } from "@/lib/owner-auth";
import { whatsappConfig, whatsappNumbersFor } from "@/lib/channels/whatsapp";
import { getCatalogSchema } from "@/lib/commerce/capability";
import { handoffPath } from "@/lib/runtime/handoff";
import { money } from "@/lib/reasoner/deterministic-compose";

/**
 * ONE CAPABILITY-READINESS MODEL — from what the business wants BARRY to do, to what BARRY can really
 * do for it right now, and what each missing piece would unlock.
 *
 *   business need (Genome: goals, enabled actions, offers, knowledge, playbook)
 *   → required capabilities
 *   → the system that provides them (fabric: connected / simulated / missing operations)
 *   → the owner's authority over them (Genome policies + authority rules)
 *   → platform (live AI, durable storage, owner access) and channel
 *   → READY / READY ON A SIMULATOR / NEEDS SETUP, with the setup steps and what they unlock.
 *
 * Train BARRY, the owner's Health tab, Owner Barry and HQ all read this. Providers appear only as data
 * (their names), never as branches; needs are derived from capabilities, never from an industry.
 */

export type NeedStatus = "ready" | "ready_simulated" | "needs_setup";
export type NeedAuthority = "automatic" | "within_limits" | "owner_approval" | "never" | "read";
export type NeedArea = "sell" | "money" | "book" | "support" | "knowledge" | "channel" | "platform";
export type SetupGate = "testing" | "supervised_pilot" | "customer_traffic";

export type BusinessNeed = {
  id: string;
  area: NeedArea;
  /** Owner words: what BARRY does for the business. */
  title: string;
  /** What that means right now (provider, mode, limits) — plain words. */
  detail: string;
  status: NeedStatus;
  authority: NeedAuthority;
  /** "on its own" / "up to ₪2,000 on its own; above that you approve" / "only with your approval" / "never". */
  authorityWords: string;
  provider: string | null;
  simulated: boolean;
  /** Setup step ids that stand between the business and this need. */
  blockedBy: string[];
};

export type SetupStep = {
  id: string;
  title: string;
  why: string;
  /** OWNER words: what happens and who does it — never a setting key, variable name or command. */
  how: string;
  /** BARRY TEAM technical detail (setting keys, values) — shown only in an explicit team section, never in owner copy. */
  technical?: string;
  who: "you" | "barry_team";
  gate: SetupGate;
  /** Titles of the needs this step unlocks (or makes real instead of simulated). */
  unlocks: string[];
};

export type CapabilityAssessment = {
  needs: BusinessNeed[];
  /** Ordered by what they unlock (most first), then by how early the pilot needs them. */
  steps: SetupStep[];
  /** Need titles BARRY can do for real right now. */
  now: string[];
  /** Need titles that work today only on a simulator. */
  nowSimulated: string[];
  /** Need titles that become possible once the steps are done. */
  afterSetup: string[];
};

export type CapabilityInput = {
  graph: BusinessGraph;
  profiles?: CapabilityProfiles;
  connections: ConnectionView[];
  surface: CapabilitySurfaceEntry[];
  /** The business's systems, for whether a generic capability runs on a simulator. */
  systems: { name: string; simulated: boolean; capabilities: string[] }[];
  ai: { live: boolean; model?: string | null; configError?: string };
  /** The business currency for limits stated as bare numbers (its offers', else its catalog's). */
  currency?: string;
  durable: boolean;
  ownerAccess: { scoped: boolean; global: boolean };
  whatsapp: { configured: boolean; routed: boolean; missing: string[]; sendMode: "live" | "dry_run" };
};

const GATE_ORDER: Record<SetupGate, number> = { testing: 0, supervised_pilot: 1, customer_traffic: 2 };
const DOMAIN_WORDS: Record<string, string> = { commerce: "store", payments: "payment provider", scheduling: "calendar", messaging: "messaging channel" };

type StepDraft = Omit<SetupStep, "unlocks"> & { unlocks: Set<string> };

export function deriveCapabilities(input: CapabilityInput): CapabilityAssessment {
  const { graph } = input;
  const enabled = new Set(graph.availableActions.filter((a) => a.enabled).map((a) => a.name));
  const has = (...actions: string[]) => actions.some((a) => enabled.has(a));
  const currency = input.currency ?? graph.offers[0]?.currency;
  const needs: BusinessNeed[] = [];
  const steps = new Map<string, StepDraft>();

  const step = (draft: Omit<SetupStep, "unlocks">, unlocks: string) => {
    const existing = steps.get(draft.id) ?? { ...draft, unlocks: new Set<string>() };
    existing.unlocks.add(unlocks);
    steps.set(draft.id, existing);
    return draft.id;
  };
  const connectionOf = (domain: string) => input.connections.find((c) => c.capability === domain);
  const providerName = (domain: string, fallback: string | null) => {
    const view = connectionOf(domain);
    return (view?.system as { system?: { name?: string } } | undefined)?.system?.name ?? view?.provider ?? fallback;
  };
  const missingSettings = (domain: string) => connectionOf(domain)?.missing ?? [];

  /** A need served by one of the typed capability domains (commerce / payments / scheduling). */
  const domainNeed = (n: Omit<BusinessNeed, "status" | "provider" | "simulated" | "blockedBy" | "detail"> & { domain: string; requires: CapabilityId[]; detail?: string }) => {
    const profile = input.profiles?.[n.domain as keyof CapabilityProfiles];
    const words = DOMAIN_WORDS[n.domain] ?? `${n.domain} system`;
    const blockedBy: string[] = [];
    let status: NeedStatus = "ready";
    let provider = providerName(n.domain, profile?.provider ?? null);
    let simulated = Boolean(profile?.simulated);
    let detail = n.detail ?? "";
    if (!profile || profile.status !== "connected") {
      status = "needs_setup";
      provider = null;
      simulated = false;
      const missing = missingSettings(n.domain);
      detail = missing.length ? `Your ${words} connection isn't complete yet (${missing.length} setting${missing.length === 1 ? "" : "s"} for the BARRY team to add).` : `No ${words} is connected.`;
      blockedBy.push(
        step(
          {
            id: `connect.${n.domain}`,
            title: `Connect your ${words}`,
            why: n.domain === "commerce" ? "BARRY can only sell what your store really has: stock, prices, the cart and checkout all come from it." : n.domain === "payments" ? "Money is only real when your provider reports it paid; BARRY never counts anything else." : "BARRY offers only times your calendar really has, and books through it.",
            how: missing.length ? `The BARRY team completes the connection (${missing.length} setting${missing.length === 1 ? "" : "s"} still missing), then runs a connection test.` : `Connect it on the Connections page with the BARRY team (name the platform you use, or give API access).`,
            ...(missing.length ? { technical: `Missing settings: ${missing.join(", ")}.` } : {}),
            who: "barry_team",
            gate: "supervised_pilot",
          },
          n.title
        )
      );
    } else {
      const missingOps = n.requires.filter((id) => !profile.capabilities.includes(id));
      if (missingOps.length) {
        status = "needs_setup";
        detail = `${provider ?? "Your " + words} is connected but can't ${n.title.toLowerCase()} yet.`;
        blockedBy.push(
          step(
            {
              id: `support.${n.domain}`,
              title: `Extend your ${words} connection`,
              why: `Your connected ${words} doesn't provide everything BARRY needs for this.`,
              how: `Ask the BARRY team to extend the ${provider ?? words} connection (${missingOps.map((id) => id.split(".").slice(1).join(" ")).join(", ")}).`,
              who: "barry_team",
              gate: "supervised_pilot",
            },
            n.title
          )
        );
      } else if (profile.simulated) {
        status = "ready_simulated";
        detail = `Works end to end on BARRY's ${words} simulator (${provider}) — nothing real happens yet.`;
        blockedBy.push(
          step(
            {
              id: `real.${n.domain}`,
              title: `Replace the simulated ${words} with your real one`,
              why: "On the simulator nothing reaches your real customers, stock or money.",
              how: `Connect your real ${words} on the Connections page with the BARRY team.`,
              who: "barry_team",
              gate: "supervised_pilot",
            },
            n.title
          )
        );
      } else {
        detail = detail || `Through ${provider}.`;
      }
    }
    needs.push({ id: n.id, area: n.area, title: n.title, detail, status, authority: n.authority, authorityWords: n.authorityWords, provider, simulated, blockedBy });
  };

  const rule = <T extends BusinessGraph["policies"][number]["rule"]["type"]>(type: T) => graph.policies.map((p) => p.rule).find((r): r is Extract<BusinessGraph["policies"][number]["rule"], { type: T }> => r.type === type);
  const paymentLimit = rule("max_auto_payment_amount");
  const discountLimit = rule("max_auto_discount_pct");
  const customPricing = rule("custom_pricing_requires_approval");
  const moneyAuthority = (): Pick<BusinessNeed, "authority" | "authorityWords"> => {
    const parts: string[] = [];
    if (paymentLimit) parts.push(`up to ${money(paymentLimit.value, currency)} on its own; above that you approve`);
    if (discountLimit) parts.push(`discounts up to ${discountLimit.value}% on its own`);
    if (customPricing?.value) parts.push("custom prices only with your approval");
    return parts.length ? { authority: "within_limits", authorityWords: parts.join("; ") } : { authority: "automatic", authorityWords: "on its own — no limit is set" };
  };

  // ── Selling (commerce) ────────────────────────────────────────────────
  if (has("searchProducts", "checkInventory")) domainNeed({ id: "sell.find", area: "sell", title: "Find products and check real stock", domain: "commerce", requires: ["commerce.catalog.search", "commerce.inventory.read"], authority: "read", authorityWords: "on its own (reads only)" });
  if (has("addToCart", "updateCartLine")) domainNeed({ id: "sell.cart", area: "sell", title: "Build and change the customer's cart", domain: "commerce", requires: ["commerce.cart.create", "commerce.cart.update"], authority: "automatic", authorityWords: "on its own" });
  if (has("createCommerceCheckout")) domainNeed({ id: "sell.checkout", area: "money", title: "Send a checkout link for the cart", domain: "commerce", requires: ["commerce.checkout.create"], ...moneyAuthority() });
  if (has("createCommerceOrder")) domainNeed({ id: "sell.order", area: "sell", title: "Create the order once payment is verified", domain: "commerce", requires: ["commerce.order.create"], authority: "automatic", authorityWords: "on its own, only after your provider verifies the payment" });

  // ── Money (payments) ──────────────────────────────────────────────────
  if (has("createPaymentRequest", "createCommerceCheckout")) domainNeed({ id: "money.links", area: "money", title: "Send payment links for exact amounts", domain: "payments", requires: ["payments.create_request"], ...moneyAuthority() });
  if (has("createPaymentRequest", "createCommerceCheckout", "verifyPayment")) domainNeed({ id: "money.verify", area: "money", title: "Count a payment only when your provider confirms it", domain: "payments", requires: ["payments.verify"], authority: "read", authorityWords: "on its own (a customer saying “I paid” is never enough)" });

  // ── Booking (scheduling) ──────────────────────────────────────────────
  if (has("checkAvailability")) domainNeed({ id: "book.times", area: "book", title: "Offer only real open times", domain: "scheduling", requires: ["scheduling.availability.read"], authority: "read", authorityWords: "on its own (reads only)" });
  if (has("createBooking")) {
    const auto = rule("bookings_auto_allowed");
    const needsApproval = auto ? !auto.value : false;
    domainNeed({ id: "book.create", area: "book", title: "Book appointments", domain: "scheduling", requires: ["scheduling.booking.create"], authority: needsApproval ? "owner_approval" : "automatic", authorityWords: needsApproval ? "only with your approval" : "on its own" });
  }

  // ── Leads / follow-ups (no provider needed) ───────────────────────────
  if (has("createLead")) needs.push({ id: "leads.record", area: "support", title: "Record enquiries for your team", detail: "Kept in BARRY's records for you to follow up.", status: "ready", authority: "automatic", authorityWords: "on its own", provider: null, simulated: false, blockedBy: [] });
  if (has("createFollowUp")) needs.push({ id: "leads.followup", area: "support", title: "Schedule follow-ups", detail: "Recorded for your team; BARRY doesn't message customers on its own.", status: "ready", authority: "automatic", authorityWords: "on its own", provider: null, simulated: false, blockedBy: [] });

  // ── The business's own systems (generic capabilities) ─────────────────
  for (const entry of input.surface) {
    const system = input.systems.find((s) => s.capabilities.includes(entry.id));
    const authority: NeedAuthority = entry.authority === "owner_approval" ? "owner_approval" : entry.authority === "not_permitted" ? "never" : entry.authority === "conditional" ? "within_limits" : entry.effect === "read" ? "read" : "automatic";
    const words = authority === "owner_approval" ? "only with your approval" : authority === "never" ? "never (no rule allows it)" : authority === "within_limits" ? "within your rules — some calls need your approval" : authority === "read" ? "on its own (reads only)" : "on its own";
    const simulated = Boolean(system?.simulated);
    const blockedBy: string[] = [];
    if (simulated) {
      blockedBy.push(step({ id: `real.${capabilityDomain(entry.id)}`, title: `Replace the simulated ${capabilityDomain(entry.id)} system with your real one`, why: "On a simulated system nothing real happens for the customer.", how: "Connect the real system on the Connections page with the BARRY team.", who: "barry_team", gate: "supervised_pilot" }, entry.purpose.replace(/\.$/, "")));
    }
    needs.push({ id: `capability:${entry.id}`, area: "support", title: entry.purpose.replace(/\.$/, ""), detail: simulated ? `Through ${system?.name ?? "a simulated system"} — simulated, nothing real happens yet.` : `Through ${system?.name ?? "your connected system"}.`, status: entry.available ? (simulated ? "ready_simulated" : "ready") : "needs_setup", authority, authorityWords: words, provider: system?.name ?? null, simulated, blockedBy });
  }

  // ── Knowledge ─────────────────────────────────────────────────────────
  const activeOffers = graph.offers.filter((o) => o.active);
  needs.push({
    id: "knowledge.offers",
    area: "knowledge",
    title: "Answer questions about what you offer",
    detail: activeOffers.length ? `${activeOffers.length} product${activeOffers.length === 1 ? "" : "s"}/service${activeOffers.length === 1 ? "" : "s"} with prices or quote rules.` : "No products or services are defined yet.",
    status: activeOffers.length || has("searchProducts") ? "ready" : "needs_setup",
    authority: "read",
    authorityWords: "on its own",
    provider: null,
    simulated: false,
    blockedBy: activeOffers.length || has("searchProducts") ? [] : [step({ id: "genome.offers", title: "Add your products or services", why: "BARRY can only sell, book or quote what it knows exists.", how: "List them with prices (or 'quote on request') with the BARRY team.", who: "you", gate: "testing" }, "Answer questions about what you offer")],
  });
  needs.push({
    id: "knowledge.policies",
    area: "knowledge",
    title: "Quote your policies (returns, shipping, cancellations…)",
    detail: graph.knowledge.length ? `${graph.knowledge.length} item${graph.knowledge.length === 1 ? "" : "s"} BARRY quotes word for word: ${graph.knowledge.map((k) => k.topic).join(", ")}.` : "No policies or FAQs yet: BARRY says it doesn't know rather than guess.",
    status: graph.knowledge.length ? "ready" : "needs_setup",
    authority: "read",
    authorityWords: "on its own — never paraphrased into something stricter or looser",
    provider: null,
    simulated: false,
    blockedBy: graph.knowledge.length ? [] : [step({ id: "genome.knowledge", title: "Add your policies and FAQs", why: "Customers ask about returns, delivery and cancellations before they buy; without your words BARRY must say it doesn't know.", how: "Write them in your own words with the BARRY team (or approve what Learn business found).", who: "you", gate: "testing" }, "Quote your policies (returns, shipping, cancellations…)")],
  });
  if (activeOffers.some((o) => o.requiresScheduling)) {
    const hours = graph.business.operatingHours.length > 0;
    needs.push({ id: "knowledge.hours", area: "knowledge", title: "State your opening hours", detail: hours ? "Opening hours are set." : "No opening hours: BARRY won't state any.", status: hours ? "ready" : "needs_setup", authority: "read", authorityWords: "on its own", provider: null, simulated: false, blockedBy: hours ? [] : [step({ id: "genome.hours", title: "Add your opening hours", why: "Customers ask when you're open, and bookings must fall inside real hours.", how: "Give your weekly hours to the BARRY team.", who: "you", gate: "testing" }, "State your opening hours")] });
  }

  // ── Handoff ───────────────────────────────────────────────────────────
  const path = handoffPath(graph);
  needs.push({
    id: "handoff.team",
    area: "support",
    title: "Hand a customer to your team with a real promise",
    detail: path ? `When a customer needs a person BARRY says: “${path}”.` : "Handoffs are recorded in your inbox, but BARRY can't promise the customer a reply because you haven't said how your team follows up.",
    status: path ? "ready" : "needs_setup",
    authority: "automatic",
    authorityWords: "on its own (it never pretends a person already replied)",
    provider: null,
    simulated: false,
    blockedBy: path ? [] : [step({ id: "playbook.handoff", title: "Tell BARRY how your team takes over", why: "Without it BARRY can only say the team can see the conversation — it can't promise when or how you'll reply.", how: "One sentence for the BARRY team: who follows up, how and how fast (e.g. “Dana calls back within 2 hours on WhatsApp”).", who: "you", gate: "supervised_pilot" }, "Hand a customer to your team with a real promise")],
  });

  // ── Channel ───────────────────────────────────────────────────────────
  const wa = input.whatsapp;
  const channelReady = wa.configured && wa.routed;
  needs.push({
    id: "channel.whatsapp",
    area: "channel",
    title: "Talk to customers on WhatsApp",
    detail: channelReady ? (wa.sendMode === "live" ? "Your number is routed to BARRY and replies are sent live." : "Your number is routed to BARRY; replies are recorded but not sent (dry run).") : wa.missing.length ? `WhatsApp isn't connected yet (${wa.missing.length} setting${wa.missing.length === 1 ? "" : "s"} for the BARRY team to add).` : "No WhatsApp number is routed to this business.",
    status: channelReady ? "ready" : "needs_setup",
    authority: "automatic",
    authorityWords: "on its own",
    provider: channelReady ? "WhatsApp Cloud API" : null,
    simulated: false,
    blockedBy: [
      ...(channelReady ? [] : [step({ id: "channel.whatsapp", title: "Connect your WhatsApp number", why: "Customers can only reach BARRY through a connected channel.", how: wa.missing.length ? `The BARRY team completes the WhatsApp connection (${wa.missing.length} setting${wa.missing.length === 1 ? "" : "s"} still missing) and routes your number to this business.` : "Route your WhatsApp Business number to this business with the BARRY team.", ...(wa.missing.length ? { technical: `Missing WhatsApp settings: ${wa.missing.join(", ")}.` } : {}), who: "barry_team", gate: "supervised_pilot" }, "Talk to customers on WhatsApp")]),
      ...(channelReady && wa.sendMode !== "live" ? [step({ id: "channel.live", title: "Switch WhatsApp replies to live", why: "In dry run BARRY records what it would send; customers receive nothing.", how: "After the supervised pilot, the BARRY team switches sending to live.", who: "barry_team", gate: "customer_traffic" }, "Talk to customers on WhatsApp")] : []),
    ],
  });

  // ── Platform ──────────────────────────────────────────────────────────
  needs.push({
    id: "platform.ai",
    area: "platform",
    title: "Understand customers with the live AI model",
    detail: input.ai.live ? `Understanding runs on ${input.ai.model ?? "the configured model"}.` : input.ai.configError ? `AI configuration error: ${input.ai.configError}` : "Running on BARRY's scripted simulator, not the live AI model.",
    status: input.ai.live ? "ready" : "needs_setup",
    authority: "automatic",
    authorityWords: "on its own",
    provider: input.ai.live ? (input.ai.model ?? "live model") : null,
    simulated: !input.ai.live,
    blockedBy: input.ai.live ? [] : [step({ id: "platform.ai", title: "Turn on the live AI model", why: "Without it BARRY can't understand real customers; it only replays scripted understanding.", how: "The BARRY team turns on the live AI model for your business.", technical: "Set OPENAI_API_KEY and BARRY_REASONER=openai.", who: "barry_team", gate: "supervised_pilot" }, "Understand customers with the live AI model")],
  });
  needs.push({
    id: "platform.memory",
    area: "platform",
    title: "Remember conversations, requests and payments durably",
    detail: input.durable ? "Stored durably." : "Kept in memory only: lost on the next restart.",
    status: input.durable ? "ready" : "needs_setup",
    authority: "automatic",
    authorityWords: "on its own",
    provider: input.durable ? "database" : null,
    simulated: false,
    blockedBy: input.durable ? [] : [step({ id: "platform.memory", title: "Turn on durable storage", why: "Otherwise conversations, approvals and payments disappear on the next restart.", how: "The BARRY team connects the database that keeps your conversations, requests and payments.", technical: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", who: "barry_team", gate: "supervised_pilot" }, "Remember conversations, requests and payments durably")],
  });
  needs.push({
    id: "platform.owner",
    area: "platform",
    title: "Ask you before consequential actions",
    detail: input.ownerAccess.scoped ? "You have your own owner access, limited to this business." : input.ownerAccess.global ? "Owner access uses the shared operator token (it opens every business)." : "No owner access is configured: nobody can approve requests.",
    status: input.ownerAccess.scoped || input.ownerAccess.global ? "ready" : "needs_setup",
    authority: "automatic",
    authorityWords: "always — approvals happen before the effect",
    provider: null,
    simulated: false,
    blockedBy: input.ownerAccess.scoped || input.ownerAccess.global ? [] : [step({ id: "platform.owner", title: "Give yourself owner access", why: "Someone must be able to approve requests and see what BARRY did — and only for their own business.", how: "The BARRY team issues your own owner sign-in, limited to your business.", technical: "Add this business to BARRY_OWNER_TOKENS (businessId:token).", who: "barry_team", gate: "supervised_pilot" }, "Ask you before consequential actions")],
  });

  // Consequential capabilities with no owner limit at all: worth a step, even though nothing is blocked.
  const unruled = input.surface.filter((c) => c.available && c.effect === "consequential" && c.authority === "automatic").map((c) => c.purpose.replace(/\.$/, ""));
  const moneyUnlimited = has("createPaymentRequest", "createCommerceCheckout") && !paymentLimit;
  if (unruled.length || moneyUnlimited) {
    step({ id: "authority.limits", title: "Set limits for actions that change something", why: unruled.length ? `BARRY may do these without asking: ${unruled.join("; ")}.` : "Payment links have no amount above which you must approve.", how: "Tell the BARRY team the limits and the approvals you want (amounts, discounts, which actions always need you).", who: "you", gate: "supervised_pilot" }, "Your control over consequential actions");
  }

  const ordered = [...steps.values()].sort((a, b) => b.unlocks.size - a.unlocks.size || GATE_ORDER[a.gate] - GATE_ORDER[b.gate] || a.title.localeCompare(b.title)).map((s) => ({ ...s, unlocks: [...s.unlocks] }));
  return {
    needs,
    steps: ordered,
    now: needs.filter((n) => n.status === "ready").map((n) => n.title),
    nowSimulated: needs.filter((n) => n.status === "ready_simulated").map((n) => n.title),
    afterSetup: [...new Set(needs.filter((n) => n.status !== "ready").map((n) => n.title))],
  };
}

function safeReasoner() {
  try {
    return getReasoner();
  } catch {
    return undefined;
  }
}

/** Owner access as configured for this business (scoped token, or the shared operator token). */
export function ownerAccessFor(businessId: string): { scoped: boolean; global: boolean } {
  return { scoped: businessesWithOwnerAccess().includes(businessId), global: Boolean(process.env.BARRY_OWNER_TOKEN) };
}

/** Gather the inputs from the running system and derive the assessment. */
export async function assessCapabilities(staticGraph: BusinessGraph, opts: { profiles?: CapabilityProfiles; connections?: ConnectionView[] } = {}): Promise<CapabilityAssessment> {
  const graph = await effectiveGraph(staticGraph);
  const businessId = graph.business.id;
  const profiles = opts.profiles ?? (await resolveCapabilityProfiles(graph).catch(() => undefined));
  const [surface, systems, connections] = await Promise.all([
    buildCapabilitySurface(graph).catch(() => []),
    listBusinessSystems(businessId).catch(() => []),
    opts.connections ? Promise.resolve(opts.connections) : describeBusinessConnections(businessId, profiles).catch(() => [] as ConnectionView[]),
  ]);
  const reasoner = safeReasoner();
  const wa = whatsappConfig();
  // Limits are stated in the business currency: its offers', else the currency its connected catalog prices in.
  const currency = graph.offers[0]?.currency ?? (profiles?.commerce.status === "connected" ? (await getCatalogSchema(graph).catch(() => undefined))?.currency : undefined);
  return deriveCapabilities({
    graph,
    profiles,
    connections,
    surface,
    systems: systems.map((s) => ({ name: s.system.name, simulated: s.simulated, capabilities: s.capabilities.map((c) => c.id) })),
    ai: { live: reasoner?.name === "llm" && !reasoner.configError, model: reasoner?.model ?? null, ...(reasoner?.configError ? { configError: reasoner.configError } : {}) },
    ...(currency ? { currency } : {}),
    durable: isSupabaseConfigured(),
    ownerAccess: ownerAccessFor(businessId),
    whatsapp: { configured: wa.configured, routed: whatsappNumbersFor(businessId).length > 0, missing: wa.missing, sendMode: wa.sendMode },
  });
}

/** Compact form for the owner workspace, Owner Barry and HQ. */
export function capabilitySummary(a: CapabilityAssessment) {
  return {
    now: a.now,
    nowSimulated: a.nowSimulated,
    afterSetup: a.afterSetup,
    steps: a.steps.slice(0, 6).map((s) => ({ id: s.id, title: s.title, who: s.who, unlocks: s.unlocks, gate: s.gate })),
  };
}
