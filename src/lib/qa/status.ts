import { getReasoner } from "@/lib/reasoner";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { runtimeCommit, BARRY_RUNTIME_VERSION } from "@/lib/runtime/version";
import { ownerAccessConfigured, businessesWithOwnerAccess } from "@/lib/owner-auth";
import { whatsappConfig, whatsappNumbersFor } from "@/lib/channels/whatsapp";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { getConversationStore } from "@/lib/state";
import { graphOrNull } from "@/lib/learn-business/http";
import { aiHealth } from "@/lib/owner/service";
import { environmentLabel, qaEnabled } from "./mode";

/**
 * What a tester needs to know about this deployment at a glance — never a secret, never a claim that a
 * real provider is connected when it isn't. Per business when one is given (AI health, provider modes).
 */
export async function buildQaStatus(businessId?: string) {
  let reasoner: ReturnType<typeof getReasoner> | undefined;
  let reasonerError: string | undefined;
  try {
    reasoner = getReasoner();
  } catch (err) {
    reasonerError = err instanceof Error ? err.message.slice(0, 160) : "reasoner unavailable";
  }
  const wa = whatsappConfig();
  const graph = businessId ? graphOrNull(businessId) : null;
  let business: Record<string, unknown> | undefined;
  if (graph) {
    const profiles = await resolveCapabilityProfiles(graph).catch(() => undefined);
    const conversations = await getConversationStore().listByBusiness(graph.business.id).catch(() => []);
    const ai = aiHealth(conversations);
    const provider = (domain: "payments" | "commerce" | "scheduling") => {
      const p = profiles?.[domain];
      if (!p?.used) return "not used";
      if (p.status !== "connected") return "missing";
      return p.simulated ? `simulated (${p.provider ?? "mock"})` : `real (${p.provider})`;
    };
    business = {
      id: graph.business.id,
      name: graph.business.name,
      ai: { status: ai.status, summary: ai.summary, ...(ai.lastFailure ? { lastFailure: ai.lastFailure } : {}) },
      payments: provider("payments"),
      commerce: provider("commerce"),
      scheduling: provider("scheduling"),
      whatsapp: whatsappNumbersFor(graph.business.id).length ? (wa.sendMode === "live" ? "connected (sending live)" : "routed (dry run)") : wa.configured ? "not routed to this business" : "missing",
      ownerAccess: businessesWithOwnerAccess().includes(graph.business.id) ? "own token configured" : ownerAccessConfigured() ? "operator token only" : "missing",
    };
  }
  return {
    build: { commit: runtimeCommit(), runtime: BARRY_RUNTIME_VERSION },
    environment: environmentLabel(),
    qaMode: qaEnabled(),
    reasoner: reasoner
      ? { mode: reasoner.name === "llm" ? "live model" : "simulator (scripted)", model: reasoner.model ?? null, effort: reasoner.reasoningEffort ?? null, composer: reasoner.composerModel ?? null, ...(reasoner.configError ? { configError: reasoner.configError } : {}) }
      : { mode: "unavailable", error: reasonerError },
    storage: isSupabaseConfigured() ? "durable (Supabase)" : "memory (lost on restart)",
    ownerAccess: ownerAccessConfigured() ? { configured: true, businesses: businessesWithOwnerAccess() } : { configured: false, businesses: [] },
    whatsapp: wa.configured ? { state: wa.sendMode === "live" ? "live sending" : "configured, dry run", routedBusinesses: [...new Set(Object.values(wa.routes))] } : { state: "missing", missing: wa.missing, qaDryRunAvailable: qaEnabled() },
    ...(business ? { business } : {}),
  };
}
