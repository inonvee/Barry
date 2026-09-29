import { getBackend } from "@/lib/store";
import { CapabilityUnavailableError, registerConnectorFactory, registerDefaultSystemProvider, resolveDomainConnector, type Connector } from "@/lib/fabric/registry";
import { listCapabilities, normalizeDeclaredCapabilities } from "@/lib/fabric/capability";
import "@/lib/fabric/builtin";
import { GoogleCalendarAdapter } from "./adapters/google-calendar";
import { MemorySchedulingAdapter } from "./adapters/memory";
import type { SchedulingAdapter } from "./adapters/types";

/** Scheduling connectors, registered in the universal connection registry. */

const ALL_SCHEDULING = () => listCapabilities("scheduling").map((c) => c.id);

function schedulingConnector(adapter: SchedulingAdapter): Connector {
  return {
    systemKey: adapter.name,
    adapter,
    async capabilities() {
      const declared = adapter.describeCapabilities ? await adapter.describeCapabilities() : ["availability", "booking", "bookingLookup"];
      return normalizeDeclaredCapabilities("scheduling", declared);
    },
  };
}

registerConnectorFactory({
  key: "scheduling/memory",
  name: "BARRY scheduling simulator",
  kind: "first_party",
  domain: "scheduling",
  simulated: true,
  potentialCapabilities: ALL_SCHEDULING,
  create: () => schedulingConnector(new MemorySchedulingAdapter(getBackend())),
});

registerConnectorFactory({
  key: "google-calendar",
  name: "Google Calendar",
  kind: "first_party",
  domain: "scheduling",
  simulated: false,
  credentials: { envPrefix: "google_calendar", keys: [{ key: "CALENDAR_ID", field: "calendarId", required: true }], unscoped: { CALENDAR_ID: "GOOGLE_CALENDAR_ID" } },
  potentialCapabilities: ALL_SCHEDULING,
  // A calendar id set on the connection itself satisfies the credential.
  setupGaps: (config, missing) => (typeof config.calendarId === "string" && config.calendarId ? missing.filter((m) => !m.endsWith("CALENDAR_ID")) : missing),
  create(descriptor, credentials) {
    const calendarId = String(descriptor.config.calendarId ?? credentials.calendarId ?? "");
    if (!calendarId) throw new Error("Google Calendar auth invalid");
    return schedulingConnector(new GoogleCalendarAdapter({ calendarId, backend: getBackend() }));
  },
});

// Legacy single-tenant configuration: BARRY_SCHEDULING_PROVIDER, else the simulator.
registerDefaultSystemProvider("scheduling", (businessId) => {
  if (process.env.BARRY_REQUIRE_BUSINESS_CONNECTIONS === "1") return undefined;
  const provider = process.env.BARRY_SCHEDULING_PROVIDER === "google-calendar" ? "google-calendar" : "memory";
  return {
    id: `legacy-${businessId}-scheduling`,
    businessId,
    capability: "scheduling",
    provider,
    status: "connected",
    config: {},
    credentialsRef: `env:${provider}`,
    permissions: ["checkAvailability", "createBooking"],
    provenance: "environment_default",
  };
});

export async function resolveSchedulingAdapterForBusiness(businessId: string): Promise<SchedulingAdapter> {
  try {
    const { connector, descriptor } = await resolveDomainConnector(businessId, "scheduling");
    if (!connector.adapter) throw new Error(`${descriptor.system.name} offers generic scheduling capabilities only; the conversation planner needs a typed scheduling adapter`);
    return connector.adapter as SchedulingAdapter;
  } catch (err) {
    if (err instanceof CapabilityUnavailableError && err.code === "no_connector") throw new Error(err.message.replace(/^No connector registered for "(.*)"$/, "Unsupported scheduling provider $1"));
    // Missing calendar credentials keep their historical message.
    if (err instanceof CapabilityUnavailableError && err.code === "not_configured" && /Google Calendar/.test(err.message)) throw new Error("Google Calendar auth invalid");
    throw err;
  }
}
