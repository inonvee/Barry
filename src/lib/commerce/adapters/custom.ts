import type { Cart, Checkout, CommerceAdapter, Order, Product, ProductSearchQuery } from "../types";

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
