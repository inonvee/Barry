import { resolveConnection } from "@/lib/connections/registry";
import { resolveConnectionCredentials } from "@/lib/connections/credentials";
import { isProductionRuntime } from "@/lib/env";
import type { CommerceAdapter, Product } from "./types";
import { MemoryCommerceAdapter } from "./adapters/memory";
import { CustomCommerceAdapter } from "./adapters/custom";

/**
 * Per-business commerce adapter resolution. FAILS CLOSED:
 *
 * - A business with a configured commerce connection gets exactly that
 *   provider, or an error. A broken/misconfigured connection is an error,
 *   never a silent fallback to someone else's catalog.
 * - The in-memory adapter serves a FIXTURE catalog only for a business
 *   whose connection explicitly names that fixture (or a registered
 *   simulator fixture business with no connection), and never in a
 *   production deployment unless explicitly allowed for preview/demo.
 * - Everything else: "commerce is not connected" — BARRY must not invent
 *   products.
 */

type CommerceAdapterFactory = (businessId: string) => CommerceAdapter;

export class CommerceNotConfiguredError extends Error {}

const testFactories = new Map<string, CommerceAdapterFactory>();
const fixtureCatalogs = new Map<string, () => Product[]>();
const fixtureBusinesses = new Map<string, string>(); // businessId -> catalog name
const memoryAdapters = new Map<string, CommerceAdapter>();

export function registerCommerceAdapterFactoryForTests(businessId: string, factory: CommerceAdapterFactory | undefined): void {
  if (factory) testFactories.set(businessId, factory);
  else testFactories.delete(businessId);
  memoryAdapters.delete(businessId);
}

/** Registers a named fixture catalog and the simulator business allowed to use it by default. */
export function registerFixtureCommerceCatalog(name: string, catalog: () => Product[], businessId?: string): void {
  fixtureCatalogs.set(name, catalog);
  if (businessId) fixtureBusinesses.set(businessId, name);
}

/** Fixture data is for tests, local dev, and explicitly-allowed preview demos — never a real production business. */
export function fixtureCommerceAllowed(): boolean {
  if (!isProductionRuntime()) return true;
  return process.env.VERCEL_ENV === "preview" || process.env.BARRY_ALLOW_FIXTURE_COMMERCE === "1";
}

function memoryAdapterFor(businessId: string, catalogName: string): CommerceAdapter {
  const catalog = fixtureCatalogs.get(catalogName);
  if (!catalog) throw new CommerceNotConfiguredError(`Unknown fixture catalog "${catalogName}"`);
  if (!fixtureCommerceAllowed()) throw new CommerceNotConfiguredError("Fixture commerce catalogs are disabled in production");
  const key = `${businessId}:${catalogName}`;
  if (!memoryAdapters.has(key)) memoryAdapters.set(key, new MemoryCommerceAdapter(catalog()));
  return memoryAdapters.get(key)!;
}

export async function resolveCommerceAdapterForBusiness(businessId: string): Promise<CommerceAdapter> {
  const testFactory = testFactories.get(businessId);
  if (testFactory) return testFactory(businessId);

  let connection;
  try {
    connection = await resolveConnection(businessId, "commerce");
  } catch (err) {
    const fixture = fixtureBusinesses.get(businessId);
    const noConnection = err instanceof Error && /^No commerce connection configured/.test(err.message);
    if (fixture && noConnection) return memoryAdapterFor(businessId, fixture);
    throw err instanceof Error ? err : new CommerceNotConfiguredError(String(err));
  }

  switch (connection.provider) {
    case "custom-commerce": {
      const baseUrl = typeof connection.config.baseUrl === "string" ? connection.config.baseUrl : undefined;
      const apiKey = resolveConnectionCredentials(connection).apiKey;
      if (!baseUrl || !apiKey) {
        throw new CommerceNotConfiguredError(`Commerce connection for ${businessId} is missing ${!baseUrl ? "baseUrl" : "credentials"}`);
      }
      return new CustomCommerceAdapter({ baseUrl }, { apiKey });
    }
    case "memory": {
      const catalogName = typeof connection.config.fixtureCatalog === "string" ? connection.config.fixtureCatalog : undefined;
      if (!catalogName) throw new CommerceNotConfiguredError(`Memory commerce connection for ${businessId} names no fixture catalog`);
      return memoryAdapterFor(businessId, catalogName);
    }
    default:
      throw new CommerceNotConfiguredError(`Unsupported commerce provider ${connection.provider}`);
  }
}
