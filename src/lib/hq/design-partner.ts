import type { CapabilityProfiles } from "@/lib/capabilities";
import type { PaymentRequestRecord } from "@/lib/store";

/**
 * What a design partner (a clothing retailer with its own site, WhatsApp
 * and Instagram, a catalog with sizes, stock, cart, checkout, their payment
 * provider and orders) needs from BARRY — surface by surface, stated honestly:
 *
 *   live_proven           a real (non-simulated) provider completed this in a
 *                         persisted transaction (e.g. a payment that
 *                         the provider verified as paid)
 *   ready                 a real provider is connected and declares the
 *                         operation; not yet proven by a real transaction
 *   simulated             works end to end on BARRY's simulator only
 *   needs_client_provider BARRY's side exists; the retailer must expose / connect
 *                         their system (e.g. their store API to the custom-commerce contract)
 *   not_built             BARRY has no adapter for this surface yet
 *
 * Nothing here is inferred from a vendor name or assumed about the
 * retailer's API; it is derived from the capability profiles the runtime
 * actually resolves and from persisted transactions.
 */

export type DesignPartnerStatus = "live_proven" | "ready" | "simulated" | "needs_client_provider" | "not_built";

export type DesignPartnerSurface = {
  surface: string;
  status: DesignPartnerStatus;
  provider: string | null;
  detail: string;
};

type Input = {
  profiles: CapabilityProfiles;
  payments: PaymentRequestRecord[] | null;
};

const COMMERCE_SURFACES: { surface: string; operation: string; what: string }[] = [
  { surface: "Catalog search", operation: "catalogSearch", what: "search the retailer's real catalog" },
  { surface: "Variants (size / color)", operation: "variants", what: "resolve exact variants" },
  { surface: "Live inventory", operation: "liveInventory", what: "check real stock per variant" },
  { surface: "Cart", operation: "cart", what: "build a cart in the retailer's system" },
  { surface: "Checkout", operation: "checkout", what: "open a checkout for the cart" },
  { surface: "Orders", operation: "orders", what: "create the order after verified payment" },
];

export function buildDesignPartnerReadiness(input: Input): DesignPartnerSurface[] {
  const { commerce, payments, messaging } = input.profiles;
  const rows: DesignPartnerSurface[] = [];

  // Channels. There is no messaging adapter in BARRY yet (the runtime says so itself).
  const channelStatus: DesignPartnerStatus = messaging.status === "connected" ? (messaging.simulated ? "simulated" : "ready") : "not_built";
  rows.push({
    surface: "Custom website chat",
    status: channelStatus,
    provider: messaging.provider,
    detail:
      channelStatus === "not_built"
        ? "No website chat channel adapter yet. Conversations run through the simulator and the runtime API only."
        : "Messaging channel connected.",
  });
  for (const surface of ["WhatsApp", "Instagram"]) {
    rows.push({
      surface,
      status: channelStatus === "not_built" ? "not_built" : channelStatus,
      provider: messaging.provider,
      detail: channelStatus === "not_built" ? `No ${surface} channel adapter yet.` : "Messaging channel connected.",
    });
  }

  const commerceConnected = commerce.status === "connected";
  for (const s of COMMERCE_SURFACES) {
    const supported = commerceConnected && commerce.operations.includes(s.operation);
    let status: DesignPartnerStatus;
    let detail: string;
    if (!commerceConnected) {
      status = "needs_client_provider";
      detail = `Connect the retailer's store API (custom-commerce contract) so BARRY can ${s.what}.`;
    } else if (!supported) {
      status = "needs_client_provider";
      detail = `The connected provider (${commerce.provider}) does not declare "${s.operation}".`;
    } else if (commerce.simulated) {
      status = "simulated";
      detail = `Works on the fixture catalog only; the retailer's API is not connected.`;
    } else {
      // Order records don't store which provider created them, so a real
      // order can't be told apart from an earlier simulated one: commerce is
      // never auto-marked live-proven — that needs a recorded live test.
      status = "ready";
      detail = `${commerce.provider} declares it; live proof is not tracked for commerce yet.`;
    }
    rows.push({ surface: s.surface, status, provider: commerce.provider, detail });
  }

  // Payments: whichever payment system the business itself connected — BARRY doesn't pick its vendor.
  const provenPaid = (input.payments ?? []).some((p) => p.provider === payments.provider && p.status === "paid" && !!p.verifiedAt);
  let payStatus: DesignPartnerStatus;
  let payDetail: string;
  if (payments.status !== "connected") {
    payStatus = "needs_client_provider";
    payDetail = "Connect the business's own payment system on the Connections page.";
  } else if (payments.simulated) {
    payStatus = "simulated";
    payDetail = "Payment links come from BARRY's simulator.";
  } else if (provenPaid) {
    payStatus = "live_proven";
    payDetail = `A ${payments.provider} payment was verified as paid by the provider.`;
  } else {
    payStatus = "ready";
    payDetail = input.payments === null ? `${payments.provider} connected; payment history unavailable.` : `${payments.provider} connected; no provider-verified paid transaction yet.`;
  }
  rows.push({ surface: "Payments", status: payStatus, provider: payments.provider, detail: payDetail });

  return rows;
}
