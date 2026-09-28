import { resolveEnvCredentials } from "@/lib/connections/credentials";
import { resolveConnection } from "@/lib/connections/registry";
import { getBackend } from "@/lib/store";
import type { ConnectionRecord } from "@/lib/store";
import { GoogleCalendarAdapter } from "./adapters/google-calendar";
import { MemorySchedulingAdapter } from "./adapters/memory";
import type { SchedulingAdapter } from "./adapters/types";

type SchedulingProvider = "memory" | "google-calendar";
type SchedulingAdapterFactory = (connection: ConnectionRecord) => SchedulingAdapter;

const factories = new Map<SchedulingProvider, SchedulingAdapterFactory>([
  ["memory", () => new MemorySchedulingAdapter(getBackend())],
  ["google-calendar", (connection) => {
    const credentials = resolveEnvCredentials(connection);
    const calendarId = String(connection.config.calendarId ?? credentials.calendarId ?? "");
    if (!calendarId) throw new Error("Google Calendar auth invalid");
    return new GoogleCalendarAdapter({ calendarId, backend: getBackend() });
  }],
]);

function schedulingProvider(value: string): SchedulingProvider {
  if (value === "memory" || value === "google-calendar") return value;
  throw new Error(`Unsupported scheduling provider ${value}`);
}

export async function resolveSchedulingAdapterForBusiness(businessId: string): Promise<SchedulingAdapter> {
  const connection = await resolveConnection(businessId, "scheduling");
  const provider = schedulingProvider(connection.provider);
  const factory = factories.get(provider);
  if (!factory) throw new Error(`No scheduling adapter registered for provider ${provider}`);
  return factory(connection);
}
