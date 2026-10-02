import type { BusinessGraph } from "@/lib/business-graph";
import "@/lib/fabric";
import { getCapability } from "@/lib/fabric/capability";
import { loadEffectiveAuthority } from "@/lib/policy/effective";
import { HARD_MAX_AUTO_DISCOUNT_PCT } from "@/lib/policy/effective-rules";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { describeBusinessConnections } from "@/lib/connections/status";
import { loadControls } from "@/lib/hq/controls";
import { loadEntitlement } from "@/lib/commercial/account";
import { hasFeature } from "@/lib/commercial/entitlements";
import { followUpPolicyFor, OBLIGATION_FOLLOW_UP } from "@/lib/operator/policy";
import type { ObligationKind } from "@/lib/operator/obligation-model";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { listInitiatives } from "@/lib/initiative/store";
import { isOpenInitiative, toView } from "@/lib/initiative/model";
import { linkActive, listOwnerIdentities, maskedIdentity } from "@/lib/owner-channel/identity";
import { assessPilotReadiness } from "./readiness";
import { aiHealth, ownerChannels } from "./service";
import { getBackend } from "@/lib/store";
import { trainBarryView } from "@/lib/learn-business/train";
import { handoffPath } from "@/lib/runtime/handoff";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import type { BusinessGraph as Graph } from "@/lib/business-graph";
import { channelSystems, checkWords, noticedCard, ownerKnowledge, ownerRules, setupView, systemView, type Availability, type CapabilityTruth, type OwnerSystem } from "./os";
import type { OwnerLang } from "./lang";

/**
 * THE OWNER BUSINESS OS read model (server) — Rules BARRY follows, Connected systems, BARRY setup and the
 * customer questions BARRY couldn't answer, each read from the system that already owns it: the effective
 * authority resolution (the SAME one the policy engine enforces), founder controls, the plan, the
 * connection registry and capability profiles, the readiness assessment and persisted initiatives.
 * Read-only. Tenant-scoped: every read takes ONE business.
 */
/**
 * What the connected systems can ACTUALLY do for the business — kept apart from what a rule allows. A
 * booking rule can allow booking while no booking system exists; both are true and both are shown.
 */
export function capabilityTruth(graph: Pick<Graph, "availableActions">, profiles: CapabilityProfiles | undefined): CapabilityTruth {
  const enabled = (name: string) => graph.availableActions.some((a) => a.enabled && a.name === name);
  const of = (domain: keyof CapabilityProfiles, capability: string, actions: string[]): Availability => {
    const p = profiles?.[domain];
    const wanted = Boolean(p?.used) || actions.some(enabled);
    if (!wanted) return "not_used";
    if (!p || p.status !== "connected" || !p.capabilities.includes(capability)) return "not_connected";
    return p.simulated ? "simulated" : "real";
  };
  return {
    bookings: of("scheduling", "scheduling.booking.create", ["createBooking"]),
    payments: of("payments", "payments.create_request", ["createPaymentRequest"]),
    refunds: of("payments", "payments.refund", ["refund"]),
    checkout: of("commerce", "commerce.checkout.create", ["createCommerceCheckout"]),
  };
}

export async function getOwnerOs(staticGraph: BusinessGraph, lang: OwnerLang = "en") {
  const authority = await loadEffectiveAuthority(staticGraph);
  const graph = authority.graph;
  const businessId = graph.business.id;
  const unavailable: string[] = [];
  const safe = async <T,>(name: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (err) {
      console.error(`[barry:owner-os] ${name} unavailable`, err instanceof Error ? err.message : err);
      unavailable.push(name);
      return fallback;
    }
  };
  const [controls, entitlement, profiles, conversations, initiatives, links, surface] = await Promise.all([
    loadControls(businessId),
    safe("plan", () => loadEntitlement(businessId), undefined),
    safe("capability profiles", () => resolveCapabilityProfiles(graph), undefined),
    safe("conversations", () => getConversationStore().listByBusiness(businessId), [] as ConversationState[]),
    safe("initiatives", () => listInitiatives(businessId), []),
    safe("owner links", () => listOwnerIdentities(businessId), []),
    safe("capability surface", () => buildCapabilitySurface(graph), []),
  ]);
  const connections = await safe("connections", () => describeBusinessConnections(businessId, profiles), []);
  const [facts, train] = await Promise.all([safe("learned facts", () => getBackend().listLearnedFacts(businessId), []), safe("business knowledge", () => trainBarryView(graph), undefined)]);
  const truth = capabilityTruth(graph, profiles);
  const currencies = [...new Set(graph.offers.filter((o) => o.active).map((o) => o.currency))];
  const currency = currencies.length === 1 ? currencies[0] : null;
  const readiness = await assessPilotReadiness(graph, { conversations });

  // ── Rules: the effective rules + founder restrictions + follow-up rules, with provenance ──
  const policy = followUpPolicyFor(graph);
  const declared = Object.keys(graph.playbook.followUp ?? {});
  const followUps = {
    // Unreadable plan → shown as not included (the executor fails closed the same way).
    included: entitlement ? hasFeature(entitlement, "proactive_followups") : false,
    rules: (Object.entries(OBLIGATION_FOLLOW_UP) as [ObligationKind, keyof typeof policy][]).map(([kind, k]) => ({ kind, enabled: policy[k].enabled, afterHours: policy[k].afterHours, maxAttempts: policy[k].maxAttempts, intervalHours: policy[k].intervalHours })),
  };
  const rules = ownerRules({
    policies: graph.policies,
    currency,
    authority: graph.authority.map((r) => ({ capability: `${surface.find((c) => c.id === r.capability)?.purpose ?? r.capability}${r.when.length ? " (in some situations)" : ""}`, effect: r.effect, ...(r.reason ? { reason: r.reason } : {}) })),
    trained: authority.trained,
    followUps,
    declaredFollowUps: (Object.entries(OBLIGATION_FOLLOW_UP) as [ObligationKind, string][]).filter(([, k]) => declared.includes(k)).map(([kind]) => kind),
    controls,
    hardMaxDiscountPct: HARD_MAX_AUTO_DISCOUNT_PCT,
    capabilities: truth,
  }, lang);

  // ── Connected systems: what BARRY can read / do through each, labelled honestly ──
  const launch = readiness.checks.filter((c) => c.status === "fail" && c.gate !== "READY_FOR_CUSTOMER_TRAFFIC");
  const systems: OwnerSystem[] = connections.map((c) => {
    const p = profiles?.[c.capability as keyof typeof profiles];
    const contracts = (p?.capabilities ?? []).map((id) => getCapability(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    return systemView(
      {
        domain: c.capability,
        provider: c.provider,
        status: c.status,
        simulated: c.simulated,
        missing: c.missing,
        lastVerifiedAt: c.lastVerifiedAt,
        reads: contracts.filter((k) => k.effect === "read").map((k) => k.id),
        writes: contracts.filter((k) => k.effect === "consequential").map((k) => k.id),
        used: p?.used ?? false,
      },
      controls.mode,
      launch.filter((x) => (x.area === "systems" || x.area === "payments") && x.id.split(".")[1] === c.capability).map((x) => checkWords(x, lang).detail),
      lang,
      (id) => contracts.find((k) => k.id === id)?.purpose ?? id,
    );
  });
  const channels = ownerChannels(businessId, links.filter((l) => linkActive(l).ok).map(maskedIdentity));
  const channelRows = channelSystems(channels, aiHealth(conversations), controls.mode, lang).map((s) => (s.id === "whatsapp_customers" ? { ...s, missingForLaunch: launch.filter((x) => x.area === "channel").map((x) => checkWords(x, lang).detail) } : s));

  // ── Customer questions BARRY couldn't answer (persisted initiatives only — never detected on read) ──
  const questions = initiatives.filter((i) => isOpenInitiative(i) && (i.detector === "unanswered_questions" || i.detector === "repeated_question")).map((i) => noticedCard(toView(i), lang));

  // ── What BARRY knows, by owner concept (never internal keys) ──
  const approvedFact = (f: (typeof facts)[number]) => f.ownerVerified && (f.status === "verified" || f.status === "corrected");
  const latest = new Map<string, (typeof facts)[number]>();
  for (const f of facts) if (approvedFact(f) && (!latest.has(f.key) || (latest.get(f.key)!.reviewedAt ?? "") < (f.reviewedAt ?? ""))) latest.set(f.key, f);
  const commerce = profiles?.commerce;
  const knowledge = ownerKnowledge(
    {
      graph,
      currency,
      capabilities: truth,
      ...(commerce?.used && commerce.status === "connected" && commerce.capabilities.includes("commerce.catalog.search") ? { catalog: { provider: commerce.provider, simulated: commerce.simulated } } : {}),
      known: [...latest.values()].map((f) => ({ key: f.key, value: f.value, owner: f.source.kind === "owner", from: f.source.kind === "owner" ? "owner" : f.source.kind, checked: f.reviewedAt ?? f.refreshedAt })),
      unsure: train?.unsure.map((u) => ({ factId: u.factId, key: u.key, value: u.value, from: u.from })) ?? [],
      missing: train?.teachNext.map((t) => ({ key: t.key, question: t.question })) ?? [],
      questions: (train?.needsConfirmation ?? [])
        .filter((q) => !q.id.startsWith("rule:") && !train?.unsure.some((u) => u.factId === q.refs.factId))
        .map((q) => {
          const change = q.refs.changeId ? train?.changed.find((c) => c.changeId === q.refs.changeId) : undefined;
          const fact = q.refs.factId ? facts.find((f) => f.id === q.refs.factId) : undefined;
          return { id: q.id, kind: q.kind, question: q.question, refs: q.refs, ...(change ? { previous: change.previous, proposed: change.proposed } : {}), ...(fact ? { value: fact.value } : {}) };
        }),
      ...(handoffPath(graph) ? { handoff: handoffPath(graph)! } : {}),
    },
    lang,
  );

  return {
    business: { id: businessId, name: graph.business.name, locale: graph.business.locale },
    mode: controls.mode,
    rules,
    systems: [...channelRows, ...systems],
    setup: setupView({ readiness, mode: controls.mode, rulesActive: rules.rules.length, signedIn: true }, lang),
    questions,
    knowledge,
    capabilities: truth,
    sources: train?.sources ?? [],
    lang,
    unavailable,
  };
}

export type OwnerOs = Awaited<ReturnType<typeof getOwnerOs>>;
