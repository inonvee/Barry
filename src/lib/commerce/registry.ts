import { CapabilityUnavailableError, registerConnectorFactory, registerDefaultSystemProvider, resolveDomainConnector, simulationAllowed, type Connector } from "@/lib/fabric/registry";
import { normalizeDeclaredCapabilities, listCapabilities } from "@/lib/fabric/capability";
import "@/lib/fabric/builtin";
import type { CommerceAdapter, Product } from "./types";
import { MemoryCommerceAdapter } from "./adapters/memory";
import { CustomCommerceAdapter } from "./adapters/custom";

/**
 * Commerce connectors, registered in the universal connection registry
 * (src/lib/fabric/registry.ts). Everything vendor-specific about commerce
 * systems lives here, inside connector factories; resolution, gating and
 * failure semantics are the fabric's and identical for every domain.
 *
 * FAILS CLOSED:
 * - A business with a stored commerce connection gets exactly that system,
 *   or an error — never someone else's catalog.
 * - The in-memory adapter serves a FIXTURE catalog only for a connection
 *   that names that fixture (or a registered simulator business with no
 *   connection), and only where simulation is allowed (dev, tests,
 *   explicitly-allowed preview demos).
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

/** The simulator fixture catalog a business falls back to when it has no commerce connection, if any. */
export function fixtureCatalogForBusiness(businessId: string): string | undefined {
  return fixtureBusinesses.get(businessId);
}

/** Fixture data is for tests, local dev, and explicitly-allowed preview demos — never a real production business. */
export function fixtureCommerceAllowed(): boolean {
  return simulationAllowed();
}

function memoryAdapterFor(businessId: string, catalogName: string): CommerceAdapter {
  const catalog = fixtureCatalogs.get(catalogName);
  if (!catalog) throw new CommerceNotConfiguredError(`Unknown fixture catalog "${catalogName}"`);
  const key = `${businessId}:${catalogName}`;
  if (!memoryAdapters.has(key)) memoryAdapters.set(key, new MemoryCommerceAdapter(catalog()));
  return memoryAdapters.get(key)!;
}

const ALL_COMMERCE = () => listCapabilities("commerce").map((c) => c.id);

const variantOut = (v: Product["variants"][number]) => ({ id: v.id, options: v.options, price: v.price, available: v.inventory.available });

/**
 * Wraps a typed commerce adapter as a fabric connector; its declared
 * operations become capability ids. Read capabilities are also exposed
 * through the generic contract (`execute`); consequential commerce steps
 * keep running through the typed tools, which own their verification.
 */
function commerceConnector(adapter: CommerceAdapter): Connector {
  return {
    systemKey: adapter.name,
    adapter,
    async capabilities() {
      // Adapters without a declaration implement the base CommerceAdapter contract (no order-status lookup).
      const declared = adapter.describeCapabilities ? await adapter.describeCapabilities() : ["catalogSearch", "catalogSchema", "variants", "liveInventory", "cart", "checkout", "orders"];
      return normalizeDeclaredCapabilities("commerce", declared);
    },
    executes: (capability) => ["commerce.catalog.search", "commerce.variants.read", "commerce.inventory.read"].includes(capability),
    async execute(capability, input) {
      switch (capability) {
        case "commerce.catalog.search": {
          const { products } = await adapter.searchProducts({
            text: input.text as string | undefined,
            category: input.category as string | undefined,
            attributes: input.attributes as Record<string, string> | undefined,
          });
          const max = input.maxPrice as number | undefined;
          return {
            products: products
              .map((p) => ({ id: p.id, title: p.title, variants: p.variants.filter((v) => max === undefined || v.price.amount <= max).map(variantOut) }))
              .filter((p) => p.variants.length > 0),
          };
        }
        case "commerce.variants.read": {
          const product = await adapter.getProduct(String(input.productId));
          if (!product) throw new Error("Product not found");
          return { variants: product.variants.map(variantOut) };
        }
        case "commerce.inventory.read": {
          const product = await adapter.getProduct(String(input.productId));
          const variant = product?.variants.find((v) => v.id === input.variantId);
          if (!variant) throw new Error("Variant not found");
          return { available: variant.inventory.available };
        }
        default:
          throw new Error(`${adapter.name} exposes ${capability} only through its typed adapter`);
      }
    },
  };
}

registerConnectorFactory({
  key: "commerce/memory",
  name: "BARRY commerce simulator",
  kind: "first_party",
  domain: "commerce",
  simulated: true,
  displayConfigKeys: ["fixtureCatalog"],
  potentialCapabilities: ALL_COMMERCE,
  setupGaps: (config, missing) => (typeof config.fixtureCatalog === "string" ? missing : [...missing, "config.fixtureCatalog"]),
  create(descriptor) {
    return commerceConnector(memoryAdapterFor(descriptor.businessId, String(descriptor.config.fixtureCatalog)));
  },
});

registerConnectorFactory({
  key: "custom-commerce",
  name: "Custom commerce API",
  kind: "first_party",
  domain: "commerce",
  simulated: false,
  credentials: { envPrefix: "custom_commerce", keys: [{ key: "API_KEY", field: "apiKey", required: true }] },
  displayConfigKeys: [],
  potentialCapabilities: ALL_COMMERCE,
  setupGaps: (config, missing) => (typeof config.baseUrl === "string" ? missing : [...missing, "config.baseUrl"]),
  create(descriptor, credentials) {
    return commerceConnector(new CustomCommerceAdapter({ baseUrl: String(descriptor.config.baseUrl) }, { apiKey: credentials.apiKey! }));
  },
});

// Test-only override: a whole commerce system for one business, still resolved through the fabric.
registerConnectorFactory({
  key: "commerce/test-override",
  name: "Test commerce system",
  kind: "first_party",
  domain: "commerce",
  simulated: true,
  potentialCapabilities: ALL_COMMERCE,
  create(descriptor) {
    const factory = testFactories.get(descriptor.businessId);
    if (!factory) throw new CommerceNotConfiguredError("No test commerce system registered");
    return commerceConnector(factory(descriptor.businessId));
  },
});

registerDefaultSystemProvider("commerce", (businessId) => {
  const base = { businessId, capability: "commerce", status: "connected" as const, permissions: [] };
  if (testFactories.has(businessId)) {
    return { ...base, id: `test-${businessId}-commerce`, provider: "test-override", config: {}, credentialsRef: "env:test-override", provenance: "fixture" };
  }
  const fixture = fixtureBusinesses.get(businessId);
  if (fixture) return { ...base, id: `fixture-${businessId}-commerce`, provider: "memory", config: { fixtureCatalog: fixture }, credentialsRef: "env:memory", provenance: "fixture" };
  return undefined;
});

export async function resolveCommerceAdapterForBusiness(businessId: string): Promise<CommerceAdapter> {
  try {
    const { connector, descriptor } = await resolveDomainConnector(businessId, "commerce");
    // The conversation's commerce tools speak the typed adapter surface. A system that only
    // implements generic capabilities (e.g. a manifest-described API) is not silently half-used.
    if (!connector.adapter) throw new CommerceNotConfiguredError(`${descriptor.system.name} offers generic commerce capabilities only; the conversation planner needs a typed commerce adapter`);
    return connector.adapter as CommerceAdapter;
  } catch (err) {
    if (err instanceof CapabilityUnavailableError && err.code === "simulation_not_allowed") {
      throw new CommerceNotConfiguredError("Fixture commerce catalogs are disabled in production");
    }
    throw err instanceof CapabilityUnavailableError ? new CommerceNotConfiguredError(err.message) : err;
  }
}
