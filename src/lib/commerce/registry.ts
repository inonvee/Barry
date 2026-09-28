import { resolveConnection } from "@/lib/connections/registry";
import { resolveConnectionCredentials } from "@/lib/connections/credentials";
import type { CommerceAdapter } from "./types";
import { MemoryCommerceAdapter } from "./adapters/memory";
import { CustomCommerceAdapter } from "./adapters/custom";
import { fashionCatalog } from "@/lib/fixtures/fashion-retailer";

type CommerceProvider = "memory" | "custom-commerce";
type CommerceAdapterFactory = (businessId: string) => CommerceAdapter;

const testFactories = new Map<string, CommerceAdapterFactory>();
const memoryAdapters = new Map<string, CommerceAdapter>();

export function registerCommerceAdapterFactoryForTests(businessId: string, factory: CommerceAdapterFactory | undefined): void {
  if (factory) testFactories.set(businessId, factory);
  else testFactories.delete(businessId);
}

function provider(value: string): CommerceProvider {
  if (value === "memory" || value === "custom-commerce") return value;
  throw new Error(`Unsupported commerce provider ${value}`);
}

export async function resolveCommerceAdapterForBusiness(businessId: string): Promise<CommerceAdapter> {
  const testFactory = testFactories.get(businessId);
  if (testFactory) return testFactory(businessId);

  const connection = await resolveConnection(businessId, "commerce").catch(() => undefined);
  const selected = provider(connection?.provider ?? "memory");
  if (selected === "custom-commerce") {
    const baseUrl = typeof connection?.config.baseUrl === "string" ? connection.config.baseUrl : undefined;
    const apiKey = connection ? resolveConnectionCredentials(connection).apiKey : undefined;
    if (baseUrl && apiKey) return new CustomCommerceAdapter({ baseUrl }, { apiKey });
    // Development fallback for local proof when the owner has not connected
    // a client-owned commerce API yet.
    if (!memoryAdapters.has(businessId)) memoryAdapters.set(businessId, new MemoryCommerceAdapter(fashionCatalog()));
    return memoryAdapters.get(businessId)!;
  }
  if (!memoryAdapters.has(businessId)) memoryAdapters.set(businessId, new MemoryCommerceAdapter(fashionCatalog()));
  return memoryAdapters.get(businessId)!;
}
