import type { Cart, CartLine, Checkout, CommerceAdapter, Money, Order, Product, ProductSearchQuery } from "../types";

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function money(amount: number, currency: string): Money {
  return { amount: Math.round(amount * 100) / 100, currency };
}

function cartTotal(lines: CartLine[]): Money {
  const currency = lines[0]?.unitPrice.currency ?? "ILS";
  return money(lines.reduce((sum, line) => sum + line.unitPrice.amount * line.quantity, 0), currency);
}

function textIncludes(value: unknown, needle: string): boolean {
  if (!needle) return true;
  if (Array.isArray(value)) return value.some((v) => String(v).toLowerCase().includes(needle));
  return String(value ?? "").toLowerCase().includes(needle);
}

export class MemoryCommerceAdapter implements CommerceAdapter {
  readonly name = "memory" as const;
  private readonly carts = new Map<string, Cart>();
  private readonly orders = new Map<string, Order>();

  constructor(private readonly products: Product[]) {}

  async searchProducts(query: ProductSearchQuery): Promise<{ products: Product[] }> {
    const words = [query.text, query.category, query.occasion, query.color].filter(Boolean).join(" ").toLowerCase();
    const tokens = new Set(words.split(/\W+/).filter((w) => w.length > 2));
    const products = this.products
      .filter((product) => {
        if (query.category && product.category !== query.category) return false;
        if (query.color && !textIncludes(product.attributes.color, query.color.toLowerCase())) return false;
        if (query.occasion && !textIncludes(product.attributes.occasion, query.occasion.toLowerCase())) return false;
        if (query.budget && !product.variants.some((v) => v.price.currency === query.budget!.currency && v.price.amount <= query.budget!.amount)) return false;
        if (query.size && !product.variants.some((v) => v.options.size?.toLowerCase() === query.size!.toLowerCase())) return false;
        if (tokens.size === 0) return true;
        const haystack = [product.title, product.description, product.category, Object.values(product.attributes).flat().join(" ")].join(" ").toLowerCase();
        return [...tokens].some((token) => haystack.includes(token));
      })
      .sort((a, b) => {
        const aAvailable = a.variants.some((v) => v.inventory.available > 0 && (!query.size || v.options.size?.toLowerCase() === query.size.toLowerCase()));
        const bAvailable = b.variants.some((v) => v.inventory.available > 0 && (!query.size || v.options.size?.toLowerCase() === query.size.toLowerCase()));
        return Number(bAvailable) - Number(aAvailable);
      })
      .slice(0, 5);
    return { products };
  }

  async getProduct(productId: string): Promise<Product | undefined> {
    return this.products.find((p) => p.id === productId);
  }

  async createCart(input: { businessId: string; customerId: string; conversationId: string }): Promise<Cart> {
    const existing = [...this.carts.values()].find((c) => c.businessId === input.businessId && c.conversationId === input.conversationId && c.status !== "ordered");
    if (existing) return existing;
    const cart: Cart = { id: id("cart"), ...input, lines: [], total: money(0, "ILS"), status: "open" };
    this.carts.set(cart.id, cart);
    return cart;
  }

  async getCart(cartId: string): Promise<Cart | undefined> {
    return this.carts.get(cartId);
  }

  async addToCart(input: { cartId: string; productId: string; variantId: string; quantity: number }): Promise<Cart> {
    const cart = this.carts.get(input.cartId);
    if (!cart) throw new Error("Cart not found");
    const product = await this.getProduct(input.productId);
    const variant = product?.variants.find((v) => v.id === input.variantId);
    if (!product || !variant) throw new Error("Product variant not found");
    if (variant.inventory.available < input.quantity) throw new Error("Requested variant not available");
    const existing = cart.lines.find((l) => l.variantId === input.variantId);
    if (existing) existing.quantity += input.quantity;
    else {
      cart.lines.push({
        id: id("line"),
        productId: product.id,
        variantId: variant.id,
        title: product.title,
        quantity: input.quantity,
        unitPrice: variant.price,
        options: variant.options,
      });
    }
    cart.total = cartTotal(cart.lines);
    this.carts.set(cart.id, cart);
    return cart;
  }

  async updateQuantity(input: { cartId: string; lineId: string; quantity: number }): Promise<Cart> {
    const cart = this.carts.get(input.cartId);
    if (!cart) throw new Error("Cart not found");
    cart.lines = input.quantity <= 0 ? cart.lines.filter((l) => l.id !== input.lineId) : cart.lines.map((l) => l.id === input.lineId ? { ...l, quantity: input.quantity } : l);
    cart.total = cartTotal(cart.lines);
    this.carts.set(cart.id, cart);
    return cart;
  }

  async createCheckout(input: { cartId: string }): Promise<Checkout> {
    const cart = this.carts.get(input.cartId);
    if (!cart || cart.lines.length === 0) throw new Error("Cart is empty");
    cart.status = "checkout";
    this.carts.set(cart.id, cart);
    return { id: id("checkout"), cartId: cart.id, amount: cart.total, status: "pending" };
  }

  async createOrder(input: { cartId: string; idempotencyKey: string }): Promise<Order> {
    const existing = [...this.orders.values()].find((order) => order.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const cart = this.carts.get(input.cartId);
    if (!cart) throw new Error("Cart not found");
    for (const line of cart.lines) {
      const product = await this.getProduct(line.productId);
      const variant = product?.variants.find((v) => v.id === line.variantId);
      if (!variant || variant.inventory.available < line.quantity) throw new Error("Item sold out before this order could be fulfilled");
      variant.inventory.available -= line.quantity;
    }
    cart.status = "ordered";
    const order: Order = {
      id: id("order"),
      businessId: cart.businessId,
      customerId: cart.customerId,
      conversationId: cart.conversationId,
      cartId: cart.id,
      lines: cart.lines,
      total: cart.total,
      status: "paid",
      idempotencyKey: input.idempotencyKey,
      verifiedAt: new Date().toISOString(),
    };
    this.orders.set(order.id, order);
    return order;
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    return this.orders.get(orderId);
  }
}
