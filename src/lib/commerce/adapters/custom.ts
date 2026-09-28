import { z } from "zod";
import type { Cart, Checkout, CommerceAdapter, Order, Product, ProductSearchQuery } from "../types";
import { normalizeCurrency, type CatalogSchema } from "../catalog";

const FacetSchema = z.object({ key: z.string().min(1).max(64), values: z.array(z.string().max(200)).max(500) });
/** The provider's self-description, validated: BARRY never trusts an unshaped schema. */
const CatalogSchemaSchema = z.object({
  categories: z.array(z.string().max(200)).max(500),
  attributes: z.array(FacetSchema).max(100),
  variantOptions: z.array(FacetSchema).max(50),
  currency: z.string(),
  priceRange: z.object({ min: z.number(), max: z.number() }).optional(),
});

type Fetcher = typeof fetch;

export type CustomCommerceCredentials = {
  apiKey: string;
};

export type CustomCommerceConfig = {
  baseUrl: string;
  timeoutMs?: number;
};

function endpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Unsupported commerce endpoint protocol");
  return new URL(path, base);
}

export class CustomCommerceAdapter implements CommerceAdapter {
  readonly name = "custom-commerce" as const;

  constructor(
    private readonly config: CustomCommerceConfig,
    private readonly credentials: CustomCommerceCredentials,
    private readonly fetcher: Fetcher = fetch
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);
    try {
      const response = await this.fetcher(endpoint(this.config.baseUrl, path), {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.credentials.apiKey}`,
          ...init.headers,
        },
      });
      if (!response.ok) throw new Error(`Commerce provider returned ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * GET /capabilities — optional. A provider that implements only part of
   * the contract (e.g. catalog + inventory + orders, no carts) says so
   * here, and BARRY plans around it. Absent: the full base contract.
   */
  async describeCapabilities(): Promise<readonly string[]> {
    let raw: unknown;
    try {
      raw = await this.request<unknown>("/capabilities");
    } catch (err) {
      if (err instanceof Error && /returned 404/.test(err.message)) {
        return ["catalogSearch", "catalogSchema", "variants", "liveInventory", "cart", "checkout", "orders", "orderStatus"];
      }
      throw err;
    }
    const parsed = z.object({ operations: z.array(z.string().max(64)).max(50) }).safeParse(raw);
    if (!parsed.success) throw new Error("Commerce provider returned invalid capabilities");
    return parsed.data.operations;
  }

  /** GET /catalog/schema — required by the custom-commerce contract. */
  async describeCatalog(): Promise<CatalogSchema> {
    const parsed = CatalogSchemaSchema.safeParse(await this.request<unknown>("/catalog/schema"));
    if (!parsed.success) throw new Error("Commerce provider returned an invalid catalog schema");
    const currency = normalizeCurrency(parsed.data.currency);
    if (!currency) throw new Error("Commerce provider catalog currency is not an ISO 4217 code");
    return { ...parsed.data, currency };
  }

  searchProducts(query: ProductSearchQuery): Promise<{ products: Product[] }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    return this.request(`/products/search?${params.toString()}`);
  }

  getProduct(productId: string): Promise<Product | undefined> {
    return this.request(`/products/${encodeURIComponent(productId)}`);
  }

  createCart(input: { businessId: string; customerId: string; conversationId: string }): Promise<Cart> {
    return this.request("/carts", { method: "POST", body: JSON.stringify(input) });
  }

  getCart(cartId: string): Promise<Cart | undefined> {
    return this.request(`/carts/${encodeURIComponent(cartId)}`);
  }

  addToCart(input: { cartId: string; productId: string; variantId: string; quantity: number }): Promise<Cart> {
    return this.request(`/carts/${encodeURIComponent(input.cartId)}/lines`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  updateQuantity(input: { cartId: string; lineId: string; quantity: number }): Promise<Cart> {
    return this.request(`/carts/${encodeURIComponent(input.cartId)}/lines/${encodeURIComponent(input.lineId)}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: input.quantity }),
    });
  }

  createCheckout(input: { cartId: string }): Promise<Checkout> {
    return this.request(`/carts/${encodeURIComponent(input.cartId)}/checkout`, { method: "POST" });
  }

  createOrder(input: { cartId: string; idempotencyKey: string }): Promise<Order> {
    return this.request("/orders", { method: "POST", body: JSON.stringify(input) });
  }

  getOrder(orderId: string): Promise<Order | undefined> {
    return this.request(`/orders/${encodeURIComponent(orderId)}`);
  }
}
