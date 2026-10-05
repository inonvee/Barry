import { getBackend } from "@/lib/store";
import { setDurableCustomerRoutes, whatsappConfig, whatsappFounderConfig, whatsappOwnerConfig } from "./whatsapp";

/**
 * BUSINESS CUSTOMER NUMBERS — one customer-facing WhatsApp number per business, held as DURABLE configuration (no
 * source edit, no redeploy per business). Separate from BARRY's CONTROL number (founder / owner → BARRY), which stays
 * in the deployment's configuration.
 *
 *   pending_authorization ──(Meta onboarding completes)──► connected ──► disconnected / token_expired ──► connected
 *
 * Coexistence (the business keeps using the WhatsApp Business app on the same number) is tracked separately:
 *   not_requested · pending_verification · verified · unavailable
 * "verified" is set ONLY by evidence: a signed `smb_message_echoes` webhook actually received for this number.
 *
 * Tenant safety: a phone_number_id belongs to exactly ONE business. Binding it to another business is refused; a
 * conflict with the deployment's own routing makes the number unroutable (fail closed), never mis-routed.
 * No secret is stored: `credentialRef` names where the token lives (e.g. an environment variable), never its value.
 */

export type NumberStatus = "pending_authorization" | "connected" | "disconnected" | "token_expired";
export type CoexistenceState = "not_requested" | "pending_verification" | "verified" | "unavailable";
export type BusinessWhatsappNumber = {
  phoneNumberId: string;
  businessId: string;
  /** The WhatsApp Business Account id (an account identifier, not a secret). */
  wabaId: string;
  displayPhone?: string;
  status: NumberStatus;
  coexistence: CoexistenceState;
  /** The owner's own answer: does the team keep replying to customers from the WhatsApp Business app? null = not answered. */
  teamRepliesInApp: boolean | null;
  /** Where the access token lives (a name), never the token. */
  credentialRef?: string;
  connectedAt?: string;
  verifiedAt?: string;
  lastEchoAt?: string;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  history: { at: string; by: string; change: string }[];
};

/** Stored with the business's channel records (kind channel_identity), one record per phone_number_id. */
const KIND = "channel_identity" as const;
const PREFIX = "wa_number:";

export class BusinessNumberError extends Error {
  constructor(readonly code: "bound_to_other_business" | "control_number" | "conflicting_route" | "not_found" | "invalid", message: string) {
    super(message);
    this.name = "BusinessNumberError";
  }
}

export async function listBusinessNumbers(businessId: string): Promise<BusinessWhatsappNumber[]> {
  return (await getBackend().listOperatorRecords(businessId, KIND)).filter((r) => r.key.startsWith(PREFIX)).map((r) => r.data as unknown as BusinessWhatsappNumber);
}

export async function allBusinessNumbers(): Promise<BusinessWhatsappNumber[]> {
  return (await getBackend().listOperatorRecordsAcrossBusinesses(KIND)).filter((r) => r.key.startsWith(PREFIX)).map((r) => r.data as unknown as BusinessWhatsappNumber);
}

async function save(n: BusinessWhatsappNumber): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: n.businessId, kind: KIND, key: `${PREFIX}${n.phoneNumberId}`, data: n as unknown as Record<string, unknown> });
}

/** The BARRY control numbers (founder / owner lines, and the env-routed shared line of another business) — never a business's customer number elsewhere. */
function controlNumbers(): Set<string> {
  return new Set([...whatsappOwnerConfig().numbers, ...whatsappFounderConfig().numbers]);
}

/**
 * Register (or reconnect) a business's customer number after Meta onboarding. Reconnecting the SAME business keeps
 * its record (history, team answer); a number already bound to ANOTHER business is refused.
 */
export async function registerBusinessNumber(input: { businessId: string; phoneNumberId: string; wabaId: string; displayPhone?: string; coexistence?: CoexistenceState; credentialRef?: string; status?: NumberStatus; by: string; now?: Date }): Promise<BusinessWhatsappNumber> {
  const at = (input.now ?? new Date()).toISOString();
  const pnid = input.phoneNumberId.trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(pnid) || !input.wabaId.trim()) throw new BusinessNumberError("invalid", "A phone_number_id and a WABA id are required.");
  if (controlNumbers().has(pnid)) throw new BusinessNumberError("control_number", "That number is BARRY's control number, not a business customer number.");
  const envOwner = whatsappConfig().routes[pnid];
  if (envOwner && envOwner !== input.businessId) throw new BusinessNumberError("conflicting_route", "That number is already routed to another business by the deployment.");
  const existing = (await allBusinessNumbers()).find((n) => n.phoneNumberId === pnid);
  if (existing && existing.businessId !== input.businessId) throw new BusinessNumberError("bound_to_other_business", "That number is connected to another business — it can't be connected here.");
  const status = input.status ?? "connected";
  const next: BusinessWhatsappNumber = {
    phoneNumberId: pnid,
    businessId: input.businessId,
    wabaId: input.wabaId.trim(),
    ...(input.displayPhone ?? existing?.displayPhone ? { displayPhone: (input.displayPhone ?? existing?.displayPhone)!.replace(/[^\d]/g, "") } : {}),
    status,
    coexistence: input.coexistence ?? existing?.coexistence ?? "not_requested",
    teamRepliesInApp: existing?.teamRepliesInApp ?? null,
    ...(input.credentialRef ?? existing?.credentialRef ? { credentialRef: input.credentialRef ?? existing?.credentialRef } : {}),
    ...(status === "connected" ? { connectedAt: existing?.status === "connected" && existing.connectedAt ? existing.connectedAt : at } : existing?.connectedAt ? { connectedAt: existing.connectedAt } : {}),
    ...(existing?.verifiedAt && (input.coexistence ?? existing.coexistence) === "verified" ? { verifiedAt: existing.verifiedAt } : {}),
    ...(existing?.lastEchoAt ? { lastEchoAt: existing.lastEchoAt } : {}),
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    history: [...(existing?.history ?? []), { at, by: input.by, change: existing ? `reconnected: ${existing.status} → ${status}` : `registered (${status})` }].slice(-50),
  };
  await save(next);
  return next;
}

/** A status change (disconnected, token expired, reconnected). Recorded with who and why. */
export async function setNumberStatus(businessId: string, phoneNumberId: string, status: NumberStatus, by: string, reason: string, now = new Date()): Promise<BusinessWhatsappNumber> {
  const n = (await listBusinessNumbers(businessId)).find((x) => x.phoneNumberId === phoneNumberId);
  if (!n) throw new BusinessNumberError("not_found", "No such number for this business.");
  if (n.status === status) return n;
  const at = now.toISOString();
  const next = { ...n, status, statusReason: reason.slice(0, 200), updatedAt: at, ...(status === "connected" ? { connectedAt: at } : {}), history: [...n.history, { at, by, change: `${n.status} → ${status}: ${reason.slice(0, 120)}` }].slice(-50) };
  await save(next);
  return next;
}

/** The owner's answer to "does your team keep replying from the WhatsApp Business app?". */
export async function setTeamRepliesInApp(businessId: string, phoneNumberId: string, value: boolean, by: string, now = new Date()): Promise<BusinessWhatsappNumber> {
  const n = (await listBusinessNumbers(businessId)).find((x) => x.phoneNumberId === phoneNumberId);
  if (!n) throw new BusinessNumberError("not_found", "No such number for this business.");
  const at = now.toISOString();
  const next = { ...n, teamRepliesInApp: value, updatedAt: at, history: [...n.history, { at, by, change: `team replies from the WhatsApp Business app: ${value ? "yes" : "no"}` }].slice(-50) };
  await save(next);
  return next;
}

/** Evidence that the echo subscription works for this number: a signed `smb_message_echoes` webhook arrived. */
export async function noteEchoReceived(businessId: string, phoneNumberId: string, at: string): Promise<void> {
  const n = (await listBusinessNumbers(businessId)).find((x) => x.phoneNumberId === phoneNumberId);
  if (!n) return;
  const verify = n.coexistence === "pending_verification" || n.coexistence === "verified";
  const next = { ...n, lastEchoAt: at, ...(verify && n.coexistence !== "verified" ? { coexistence: "verified" as const, verifiedAt: at, history: [...n.history, { at, by: "whatsapp", change: "coexistence verified: a message sent from the WhatsApp Business app was received" }].slice(-50) } : {}), updatedAt: at };
  await save(next);
}

/** Meta refused the access token for this business's connected number: it stops being used until reconnected. */
export async function markTokenExpired(businessId: string, reason: string): Promise<void> {
  const n = (await listBusinessNumbers(businessId)).find((x) => x.status === "connected");
  if (n) await setNumberStatus(businessId, n.phoneNumberId, "token_expired", "whatsapp", `Meta refused the access token: ${reason.slice(0, 120)}`);
}

export async function removeBusinessNumber(businessId: string, phoneNumberId: string): Promise<number> {
  return getBackend().deleteOperatorRecords(businessId, KIND, [`${PREFIX}${phoneNumberId}`]);
}

// ── Routing ──────────────────────────────────────────────────────────────────────────────────────────

let routeCache: Record<string, string> = {};
/** Durable customer numbers that route inbound (any registered status: messages are always kept; sending is gated). */
export async function loadDurableRoutes(): Promise<Record<string, string>> {
  const env = whatsappConfig().routes;
  const control = controlNumbers();
  const out: Record<string, string> = {};
  for (const n of await allBusinessNumbers().catch(() => [] as BusinessWhatsappNumber[])) {
    if (n.status === "pending_authorization" || control.has(n.phoneNumberId)) continue;
    // A conflict with the deployment's own routing is never resolved by guessing: the number is not routed at all.
    if (env[n.phoneNumberId] && env[n.phoneNumberId] !== n.businessId) continue;
    out[n.phoneNumberId] = n.businessId;
  }
  routeCache = out;
  setDurableCustomerRoutes(out);
  return out;
}
/** Every routed customer number: the deployment's routes plus the durable business numbers (env wins on equality; conflicts dropped). */
export async function customerRoutes(): Promise<Record<string, string>> {
  return { ...(await loadDurableRoutes()), ...whatsappConfig().routes };
}
/** The last loaded durable routes (sync) — the sender uses it to pick the business's customer number. */
export function durableRouteCache(): Record<string, string> {
  return routeCache;
}

export type CustomerWhatsappState = "CONNECTED_WITH_HUMAN_COEXISTENCE" | "CONNECTED_API_ONLY" | "CONNECTED" | "BLOCKED_DISCONNECTED";

/** The business's customer-number state for readiness (the durable number wins over the deployment's routing). */
export async function customerWhatsappState(businessId: string): Promise<{ state: CustomerWhatsappState; number?: BusinessWhatsappNumber; envRouted: boolean }> {
  const envRouted = Object.values(whatsappConfig().routes).includes(businessId);
  const numbers = await listBusinessNumbers(businessId).catch(() => [] as BusinessWhatsappNumber[]);
  const number = numbers.find((n) => n.status === "connected") ?? numbers[0];
  if (number) {
    if (number.status !== "connected") return { state: "BLOCKED_DISCONNECTED", number, envRouted };
    return { state: number.coexistence === "verified" ? "CONNECTED_WITH_HUMAN_COEXISTENCE" : "CONNECTED_API_ONLY", number, envRouted };
  }
  return { state: envRouted ? "CONNECTED" : "BLOCKED_DISCONNECTED", envRouted };
}

/**
 * May BARRY send to a customer of this business on its own right now (channel-level)? Fail safe:
 *  - a registered number that isn't connected (disconnected, token expired) → no;
 *  - the team keeps replying from the WhatsApp Business app but BARRY can't SEE those replies (coexistence not
 *    verified) → no: BARRY can't know who owns the conversation, so it stays quiet;
 *  - the owner hasn't said whether the team replies from the app → no (never assumed).
 * A business with no registered customer number (deployment-routed) keeps the existing behavior.
 */
export async function customerSendGate(businessId: string): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const numbers = await listBusinessNumbers(businessId).catch(() => null);
  if (numbers === null) return { allowed: false, reason: "the business's WhatsApp number state couldn't be read" };
  if (!numbers.length) return { allowed: true };
  const n = numbers.find((x) => x.status === "connected");
  if (!n) return { allowed: false, reason: `the business's WhatsApp number is ${numbers[0].status.replace(/_/g, " ")}` };
  if (n.teamRepliesInApp === null) return { allowed: false, reason: "the owner hasn't said whether the team also replies from the WhatsApp Business app" };
  if (n.teamRepliesInApp && n.coexistence !== "verified") return { allowed: false, reason: "the team replies from the WhatsApp Business app, but BARRY can't see those replies yet (coexistence not verified)" };
  return { allowed: true };
}
