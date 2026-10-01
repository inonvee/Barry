import type { ConversationState } from "@/lib/state";
import { whatsappConfig, whatsappNumbersFor } from "./whatsapp";
import { readDeliveries, type DeliveryRecord } from "./gateway";
import type { ChannelKind } from "./types";

/**
 * CHANNEL HEALTH — observable, secret-free state per channel: connected / verified / degraded /
 * disabled / missing setup, with the last success and failure and the capability impact. Fed to Owner
 * readiness and HQ. "Verified" means a real message was answered end to end on that channel.
 */

export type ChannelHealthState = "verified" | "connected" | "degraded" | "disabled" | "missing_setup" | "not_configured";

export type ChannelHealth = {
  channel: ChannelKind;
  state: ChannelHealthState;
  mode: "live" | "dry_run" | "n/a";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError?: string;
  /** Delivery failures in the last 24h over total deliveries. */
  recentFailures: number;
  recentDeliveries: number;
  impact: string;
  /** Names of missing settings (never values). */
  missingSetup: string[];
};

const D = 24 * 3600_000;

export function channelHealth(input: { businessId: string; conversations: ConversationState[]; disabledChannels?: string[]; now: Date }): ChannelHealth[] {
  const { businessId, conversations, now } = input;
  const disabled = new Set((input.disabledChannels ?? []).map((c) => c.toLowerCase()));
  const deliveriesBy = (channel: ChannelKind): DeliveryRecord[] => conversations.flatMap((c) => readDeliveries(c.knownFields).filter((d) => d.channel === channel));
  const summarize = (channel: ChannelKind) => {
    const ds = deliveriesBy(channel).sort((a, b) => a.at.localeCompare(b.at));
    const ok = ds.filter((d) => d.status === "sent" || d.status === "dry_run");
    const failed = ds.filter((d) => d.status === "failed");
    const recent = ds.filter((d) => now.getTime() - Date.parse(d.at) <= D);
    return { lastSuccessAt: ok.at(-1)?.at ?? null, lastFailureAt: failed.at(-1)?.at ?? null, lastError: failed.at(-1)?.error, recentFailures: recent.filter((d) => d.status === "failed").length, recentDeliveries: recent.length, sentLive: ok.some((d) => d.status === "sent") };
  };
  const out: ChannelHealth[] = [];

  // Web: always available (the owner's simulator / web widget); never "verified" as a customer channel.
  const web = summarize("web");
  out.push({ channel: "web", state: disabled.has("web") ? "disabled" : web.recentFailures > 0 && web.recentFailures >= web.recentDeliveries / 2 ? "degraded" : "connected", mode: "n/a", lastSuccessAt: web.lastSuccessAt, lastFailureAt: web.lastFailureAt, ...(web.lastError ? { lastError: web.lastError } : {}), recentFailures: web.recentFailures, recentDeliveries: web.recentDeliveries, impact: disabled.has("web") ? "Web conversations are refused." : "Web conversations work.", missingSetup: [] });

  // WhatsApp: configuration + routing + deliveries.
  const wa = whatsappConfig();
  const routed = whatsappNumbersFor(businessId).length > 0;
  const s = summarize("whatsapp");
  let state: ChannelHealthState;
  if (disabled.has("whatsapp")) state = "disabled";
  else if (!wa.configured) state = "missing_setup";
  else if (!routed) state = "not_configured";
  else if (s.recentFailures > 0 && s.recentFailures >= Math.max(1, s.recentDeliveries / 2)) state = "degraded";
  else if (s.sentLive) state = "verified";
  else state = "connected";
  out.push({ channel: "whatsapp", state, mode: wa.configured ? wa.sendMode : "n/a", lastSuccessAt: s.lastSuccessAt, lastFailureAt: s.lastFailureAt, ...(s.lastError ? { lastError: s.lastError } : {}), recentFailures: s.recentFailures, recentDeliveries: s.recentDeliveries, impact: state === "disabled" ? "WhatsApp messages are refused by the founder's control." : state === "missing_setup" ? "Customers cannot reach BARRY on WhatsApp until the BARRY team connects it." : state === "not_configured" ? "WhatsApp is connected but no number is routed to this business." : state === "degraded" ? "Replies are failing to deliver on WhatsApp; customers may not get answers." : state === "verified" ? "A real WhatsApp message was answered end to end." : wa.sendMode === "live" ? "WhatsApp is routed; no live reply recorded yet." : "WhatsApp is routed in dry-run: replies are recorded, not sent.", missingSetup: wa.configured ? [] : wa.missing });

  // Instagram: the contract exists; no adapter is configured yet.
  out.push({ channel: "instagram", state: disabled.has("instagram") ? "disabled" : "not_configured", mode: "n/a", lastSuccessAt: null, lastFailureAt: null, recentFailures: 0, recentDeliveries: 0, impact: "Instagram shares the runtime contract; no account is connected.", missingSetup: ["INSTAGRAM_PAGE_ACCESS_TOKEN", "INSTAGRAM_APP_SECRET", "BARRY_INSTAGRAM_ROUTES"] });
  return out;
}

/** One status word for the fleet row / readiness: the best customer channel's state. */
export function customerChannelState(health: ChannelHealth[]): ChannelHealthState {
  const customer = health.filter((h) => h.channel !== "web");
  const order: ChannelHealthState[] = ["verified", "connected", "degraded", "disabled", "not_configured", "missing_setup"];
  return customer.map((h) => h.state).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "not_configured";
}
