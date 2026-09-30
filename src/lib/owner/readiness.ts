import type { BusinessGraph } from "@/lib/business-graph";
import { getReasoner } from "@/lib/reasoner";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { getLearningWorkspace } from "@/lib/learn-business/service";
import { buildCapabilitySurface } from "@/lib/capabilities/surface";
import { whatsappConfig, whatsappNumbersFor } from "@/lib/channels/whatsapp";
import { readDeliveries } from "@/lib/channels/gateway";
import { handoffPath } from "@/lib/runtime/handoff";
import { aiHealth } from "./service";
import { isSimulatedPayment, isVerifiedPaid } from "./revenue";
import { ownerAccessFor } from "./capabilities";

/**
 * PAID-PILOT READINESS — one honest assessment per business, derived from real requirements.
 *
 *   NOT READY                    → the basics BARRY needs to be tried at all are missing
 *   READY FOR TESTING            → BARRY knows the business and can be tried in the simulator
 *   READY FOR SUPERVISED PILOT   → live AI, durable storage, owner access, real systems (no simulated
 *                                  providers for what BARRY does), a customer channel, a handoff path
 *   READY FOR CUSTOMER TRAFFIC   → the channel is live and proven, payments proven end to end (when the
 *                                  business takes payments), AI healthy under real traffic
 *
 * A level is reached only when EVERY check gating it and every lower level passes. No score, no
 * weighting: each failing check says what is missing and how to fix it. Warnings never block.
 */

export type PilotLevel = "NOT_READY" | "READY_FOR_TESTING" | "READY_FOR_SUPERVISED_PILOT" | "READY_FOR_CUSTOMER_TRAFFIC";
type Gate = Exclude<PilotLevel, "NOT_READY">;
const GATES: Gate[] = ["READY_FOR_TESTING", "READY_FOR_SUPERVISED_PILOT", "READY_FOR_CUSTOMER_TRAFFIC"];

export const LEVEL_LABEL: Record<PilotLevel, string> = {
  NOT_READY: "Not ready",
  READY_FOR_TESTING: "Ready for testing",
  READY_FOR_SUPERVISED_PILOT: "Ready for a supervised pilot",
  READY_FOR_CUSTOMER_TRAFFIC: "Ready for customer traffic",
};

export type ReadinessCheck = {
  id: string;
  area: "knowledge" | "ai" | "platform" | "systems" | "authority" | "channel" | "handoff" | "payments";
  label: string;
  status: "pass" | "fail" | "warn";
  /** OWNER words — never a setting key or command. */
  detail: string;
  /** OWNER words for what fixes it. */
  fix?: string;
  /** BARRY TEAM technical detail (setting keys) — for the team's screens only. */
  technical?: string;
  /** Why it matters for a pilot (plain words). */
  why?: string;
  gate: Gate;
};

const WHY: [RegExp, string][] = [
  [/^knowledge\.offers/, "BARRY can only sell or book what it knows exists."],
  [/^knowledge\.goals/, "Goals decide what BARRY moves each conversation toward."],
  [/^knowledge\.(policies|hours)/, "Customers ask; without the real answer BARRY must say it doesn't know."],
  [/^knowledge\./, "Customers ask about this before buying; BARRY must quote your rule, not guess."],
  [/^ai\./, "Without working AI understanding BARRY can't understand customers — it replies safely but does nothing."],
  [/^platform\.persistence/, "Without durable storage, conversations, approvals and payments disappear on the next restart."],
  [/^platform\.owner_access/, "Someone must be able to approve requests and see what BARRY did — and only for their own business."],
  [/^systems\./, "BARRY acts through your real systems; a simulator means nothing real happens."],
  [/^payments\./, "Money must be verified by your real payment provider before anyone counts it as paid."],
  [/^authority\./, "Consequential actions (money, cancellations, cases) must follow your limits."],
  [/^handoff\./, "When a customer needs a person, BARRY must say honestly what will happen next."],
  [/^channel\./, "Customers can only reach BARRY through a connected channel."],
];

export type PilotReadiness = {
  level: PilotLevel;
  label: string;
  /** The next level and exactly what stands between the business and it. */
  next?: { level: Gate; label: string; blockers: ReadinessCheck[] };
  checks: ReadinessCheck[];
};

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}


export async function assessPilotReadiness(graph: BusinessGraph, opts: { conversations?: ConversationState[] } = {}): Promise<PilotReadiness> {
  const businessId = graph.business.id;
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push({ ...c, why: c.why ?? WHY.find(([re]) => re.test(c.id))?.[1] });
  const activeOffers = graph.offers.filter((o) => o.active);

  // ── Testing: BARRY knows the business ────────────────────────────────
  add({ id: "knowledge.offers", area: "knowledge", gate: "READY_FOR_TESTING", label: "What the business offers", status: activeOffers.length > 0 ? "pass" : "fail", detail: activeOffers.length > 0 ? `${activeOffers.length} offer${activeOffers.length === 1 ? "" : "s"} with prices or quote rules.` : "No products or services are defined.", fix: "Add the products/services and their prices." });
  add({ id: "knowledge.goals", area: "knowledge", gate: "READY_FOR_TESTING", label: "Business goals", status: graph.goals.length > 0 ? "pass" : "fail", detail: graph.goals.length > 0 ? `BARRY works toward: ${graph.goals.join(", ")}.` : "No goals are set.", fix: "Choose what BARRY should achieve (sell, book, collect leads…)." });
  add({ id: "knowledge.policies", area: "knowledge", gate: "READY_FOR_TESTING", label: "Policies & FAQs", status: graph.knowledge.length > 0 ? "pass" : "warn", detail: graph.knowledge.length > 0 ? `${graph.knowledge.length} knowledge item${graph.knowledge.length === 1 ? "" : "s"} BARRY may quote.` : "No policies or FAQs: BARRY will say it doesn't know.", fix: "Add returns, delivery and other policies customers ask about." });
  if (activeOffers.some((o) => o.requiresScheduling)) {
    add({ id: "knowledge.hours", area: "knowledge", gate: "READY_FOR_TESTING", label: "Opening hours", status: graph.business.operatingHours.length > 0 ? "pass" : "warn", detail: graph.business.operatingHours.length > 0 ? "Opening hours are set." : "No opening hours: BARRY won't state any.", fix: "Add opening hours." });
  }

  // ── Supervised pilot: real, durable, owned, reachable ────────────────
  const reasoner = safe(() => getReasoner());
  const live = reasoner?.name === "llm" && !reasoner.configError;
  add({ id: "ai.model", area: "ai", gate: "READY_FOR_SUPERVISED_PILOT", label: "Live AI model", status: live ? "pass" : "fail", detail: live ? `Understanding runs on ${reasoner?.model ?? "the configured model"}.` : reasoner?.configError ? `AI configuration error: ${reasoner.configError}` : "BARRY is running on the simulator's scripted understanding.", fix: "The BARRY team turns on the live AI model.", technical: "Set OPENAI_API_KEY and BARRY_REASONER=openai." });
  const conversations = opts.conversations ?? (await getConversationStore().listByBusiness(businessId).catch(() => [] as ConversationState[]));
  const ai = aiHealth(conversations);
  if (live) add({ id: "ai.health", area: "ai", gate: "READY_FOR_SUPERVISED_PILOT", label: "AI availability", status: ai.status === "unavailable" ? "fail" : ai.status === "degraded" ? "warn" : "pass", detail: ai.summary, fix: ai.lastFailure?.kind === "provider_quota_exhausted" ? "Add credit to the AI provider account." : "Check the AI provider status and account." });
  add({ id: "platform.persistence", area: "platform", gate: "READY_FOR_SUPERVISED_PILOT", label: "Durable storage", status: isSupabaseConfigured() ? "pass" : "fail", detail: isSupabaseConfigured() ? "Conversations, approvals and payments are stored durably." : "Conversations and approvals live in process memory and are lost on restart.", fix: "The BARRY team connects the database.", technical: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
  const access = ownerAccessFor(businessId);
  add({ id: "platform.owner_access", area: "platform", gate: "READY_FOR_SUPERVISED_PILOT", label: "Owner access to approvals", status: access.scoped ? "pass" : access.global ? "warn" : "fail", detail: access.scoped ? "The owner has their own access, limited to this business." : access.global ? "Owner access uses the shared operator token (it opens every business)." : "No owner access is configured: nobody can approve requests.", fix: "The BARRY team issues this owner their own sign-in.", technical: "Add the business to BARRY_OWNER_TOKENS (businessId:token)." });

  const workspace = await getLearningWorkspace(graph).catch(() => undefined);
  if (!workspace) add({ id: "systems.unavailable", area: "systems", gate: "READY_FOR_SUPERVISED_PILOT", label: "Connected systems", status: "fail", detail: "Connection status could not be read.", fix: "Check the database connection." });
  // Learn Business requirements, except what the Business Genome already states (a learned fact is one
  // source of business knowledge; the Genome the runtime acts on is another). The handoff path is its own check.
  const covered = (key: string) =>
    (key === "business.name" && Boolean(graph.business.name.trim())) ||
    (key === "hours.opening" && graph.business.operatingHours.length > 0) ||
    (key === "authority.discounts" && graph.policies.some((p) => p.rule.type === "max_auto_discount_pct")) ||
    (key === "policy.refunds" && graph.policies.some((p) => p.rule.type === "refund_requires_approval")) ||
    (key === "policy.shipping" && graph.policies.some((p) => p.rule.type === "free_shipping_over" || p.rule.type === "flat_shipping_fee")) ||
    key === "authority.escalation";
  const AREA_LABEL: Record<string, string> = { core: "Business knowledge", commerce: "Store knowledge", scheduling: "Booking knowledge", payments: "Payments", leads: "Enquiries" };
  const gaps = (workspace?.questions ?? []).filter((q) => !covered(q.key));
  for (const q of gaps) add({ id: `knowledge.${q.key}`, area: "knowledge", gate: "READY_FOR_SUPERVISED_PILOT", label: AREA_LABEL[q.capability] ?? "Business knowledge", status: "fail", detail: q.question, fix: "Answer it with the BARRY team (or in Learn business)." });
  for (const r of workspace?.needsReview ?? []) add({ id: `knowledge.review.${r.key}`, area: "knowledge", gate: "READY_FOR_SUPERVISED_PILOT", label: AREA_LABEL[r.capability] ?? "Business knowledge", status: "fail", detail: `A learned fact (${r.key}) hasn't been confirmed by you yet.`, fix: "Verify, correct or reject it in Learn business." });
  const systemBlockers = (workspace?.readiness.operational.blockers ?? []).filter((b) => b.capability !== "channel" && !/^Owner answer needed|^Learned fact/.test(b.reason));
  for (const [i, b] of systemBlockers.entries()) {
    add({ id: `systems.${b.capability}.${i}`, area: b.capability === "payments" ? "payments" : "systems", gate: "READY_FOR_SUPERVISED_PILOT", label: `${b.capability[0].toUpperCase()}${b.capability.slice(1)} system`, status: "fail", detail: b.reason, fix: b.fix });
  }
  if (workspace && systemBlockers.length === 0) {
    add({ id: "systems.connected", area: "systems", gate: "READY_FOR_SUPERVISED_PILOT", label: "Business systems", status: "pass", detail: "Every system BARRY works through is connected with a real provider." });
  }

  const surface = await buildCapabilitySurface(graph).catch(() => []);
  const unruled = surface.filter((c) => c.available && c.effect === "consequential" && c.authority === "automatic");
  const moneyActions = graph.availableActions.some((a) => a.enabled && /Payment|Checkout/.test(a.name));
  const moneyLimited = graph.policies.some((p) => p.rule.type === "max_auto_payment_amount") || graph.authority.some((r) => r.effect !== "allow" && /^payments\./.test(r.capability));
  add({ id: "authority.consequential", area: "authority", gate: "READY_FOR_SUPERVISED_PILOT", label: "Owner control over consequential actions", status: unruled.length === 0 && (!moneyActions || moneyLimited) ? "pass" : "warn", detail: [unruled.length ? `BARRY may do these without asking: ${unruled.map((c) => c.purpose).join("; ")}.` : "", moneyActions && !moneyLimited ? "Payment links have no amount above which you must approve." : ""].filter(Boolean).join(" ") || "Every consequential action is governed by your rules.", fix: "Set approval rules and limits for actions that change something." });
  add({ id: "handoff.path", area: "handoff", gate: "READY_FOR_SUPERVISED_PILOT", label: "Human handoff", status: handoffPath(graph) ? "pass" : "fail", detail: handoffPath(graph) ? `When a customer needs a person: ${handoffPath(graph)}` : "BARRY records handoffs in your inbox, but you haven't said how your team replies — BARRY can't promise customers a reply.", fix: "Describe how your team takes over (who, how, how fast)." });
  const wa = whatsappConfig();
  const numbers = whatsappNumbersFor(businessId);
  add({ id: "channel.configured", area: "channel", gate: "READY_FOR_SUPERVISED_PILOT", label: "Customer channel (WhatsApp)", status: wa.configured && numbers.length > 0 ? "pass" : "fail", detail: wa.configured && numbers.length > 0 ? `WhatsApp number routed to this business (${wa.sendMode === "live" ? "sending live" : "dry run: replies recorded, not sent"}).` : wa.missing.length ? `WhatsApp isn't connected yet (${wa.missing.length} setting${wa.missing.length === 1 ? "" : "s"} for the BARRY team to add).` : "No WhatsApp number is routed to this business.", fix: "The BARRY team connects the WhatsApp Business number (Meta app + webhook) and routes it to this business.", ...(wa.missing.length ? { technical: `Missing WhatsApp settings: ${wa.missing.join(", ")}.` } : {}) });

  // ── Customer traffic: proven live ────────────────────────────────────
  add({ id: "channel.live", area: "channel", gate: "READY_FOR_CUSTOMER_TRAFFIC", label: "Replies are sent for real", status: wa.sendMode === "live" ? "pass" : "fail", detail: wa.sendMode === "live" ? "WhatsApp replies are sent." : "WhatsApp replies are in dry-run mode.", fix: "After the supervised pilot, the BARRY team switches sending to live.", technical: "Set BARRY_WHATSAPP_SEND=live." });
  const channelConvos = conversations.filter((c) => /^wa:/.test(c.id));
  const delivered = channelConvos.some((c) => readDeliveries(c.knownFields).some((d) => d.status === "sent"));
  add({ id: "channel.proven", area: "channel", gate: "READY_FOR_CUSTOMER_TRAFFIC", label: "A real message answered end to end", status: delivered ? "pass" : "fail", detail: delivered ? "A real WhatsApp message was received and answered." : "No real WhatsApp message has been received and answered yet.", fix: "Send a test message from a real phone and confirm the reply arrives." });
  const takesPayments = activeOffers.some((o) => o.requiresPayment) || graph.availableActions.some((a) => a.enabled && /Payment|Checkout/.test(a.name));
  if (takesPayments) {
    const payments = await getBackend().listPaymentRequests(businessId).catch(() => []);
    const proven = payments.some((p) => isVerifiedPaid(p) && !isSimulatedPayment(p));
    add({ id: "payments.proven", area: "payments", gate: "READY_FOR_CUSTOMER_TRAFFIC", label: "A real payment verified end to end", status: proven ? "pass" : "fail", detail: proven ? "A real payment was created by BARRY and verified by the payment provider." : "No real payment has been verified by the provider yet.", fix: "Run one small real payment through BARRY and confirm the provider verifies it." });
  }
  if (live) add({ id: "ai.traffic", area: "ai", gate: "READY_FOR_CUSTOMER_TRAFFIC", label: "AI healthy under real traffic", status: ai.status === "healthy" ? "pass" : "fail", detail: ai.summary, fix: "Run the supervised pilot until AI understanding is healthy." });

  let level: PilotLevel = "NOT_READY";
  for (const gate of GATES) {
    const upTo = GATES.slice(0, GATES.indexOf(gate) + 1);
    if (checks.filter((c) => upTo.includes(c.gate)).every((c) => c.status !== "fail")) level = gate;
    else break;
  }
  const nextGate = GATES[level === "NOT_READY" ? 0 : GATES.indexOf(level as Gate) + 1];
  return {
    level,
    label: LEVEL_LABEL[level],
    ...(nextGate ? { next: { level: nextGate, label: LEVEL_LABEL[nextGate], blockers: checks.filter((c) => c.status === "fail" && GATES.indexOf(c.gate) <= GATES.indexOf(nextGate)) } } : {}),
    checks,
  };
}
