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
import { channelSystems, noticedCard, ownerRules, setupView, systemView, type OwnerSystem } from "./os";

/**
 * THE OWNER BUSINESS OS read model (server) — Rules BARRY follows, Connected systems, BARRY setup and the
 * customer questions BARRY couldn't answer, each read from the system that already owns it: the effective
 * authority resolution (the SAME one the policy engine enforces), founder controls, the plan, the
 * connection registry and capability profiles, the readiness assessment and persisted initiatives.
 * Read-only. Tenant-scoped: every read takes ONE business.
 */
export async function getOwnerOs(staticGraph: BusinessGraph) {
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
    currency: graph.offers[0]?.currency ?? "USD",
    authority: graph.authority.map((r) => ({ capability: `${surface.find((c) => c.id === r.capability)?.purpose ?? r.capability}${r.when.length ? " (in some situations)" : ""}`, effect: r.effect, ...(r.reason ? { reason: r.reason } : {}) })),
    trained: authority.trained,
    followUps,
    declaredFollowUps: (Object.entries(OBLIGATION_FOLLOW_UP) as [ObligationKind, string][]).filter(([, k]) => declared.includes(k)).map(([kind]) => kind),
    controls,
    hardMaxDiscountPct: HARD_MAX_AUTO_DISCOUNT_PCT,
  });

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
        reads: contracts.filter((k) => k.effect === "read").map((k) => k.purpose),
        writes: contracts.filter((k) => k.effect === "consequential").map((k) => k.purpose),
        used: p?.used ?? false,
      },
      controls.mode,
      launch.filter((x) => (x.area === "systems" || x.area === "payments") && x.label.toLowerCase().startsWith(c.capability)).map((x) => x.detail),
    );
  });
  const channels = ownerChannels(businessId, links.filter((l) => linkActive(l).ok).map(maskedIdentity));
  const channelRows = channelSystems(channels, aiHealth(conversations), controls.mode).map((s) => (s.id === "whatsapp_customers" ? { ...s, missingForLaunch: launch.filter((x) => x.area === "channel").map((x) => x.detail) } : s));

  // ── Customer questions BARRY couldn't answer (persisted initiatives only — never detected on read) ──
  const questions = initiatives.filter((i) => isOpenInitiative(i) && (i.detector === "unanswered_questions" || i.detector === "repeated_question")).map((i) => noticedCard(toView(i)));

  return {
    business: { id: businessId, name: graph.business.name },
    mode: controls.mode,
    rules,
    systems: [...channelRows, ...systems],
    setup: setupView({ readiness, mode: controls.mode, rulesActive: rules.rules.length, signedIn: true }),
    questions,
    unavailable,
  };
}

export type OwnerOs = Awaited<ReturnType<typeof getOwnerOs>>;
