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

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Unicode-aware tokens; a single glued Hebrew prefix letter (ב/ה/ו/כ/ל/מ/ש) is language morphology, so the bare stem is indexed too. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length <= 1) continue;
    out.add(t);
    if (/^[בהוכלמש][\u0590-\u05ff]{3,}$/u.test(t)) out.add(t.slice(1));
  }
  return out;
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

  /**
   * Generic catalog search: structured attribute/option/budget filters
   * are exact (case-insensitive) and must all hold; free text is scored
   * by Unicode-aware token overlap against everything the catalog says
   * about a product (title, description, category, attribute values —
   * including any multilingual keywords the business itself provides).
   * Nothing here knows what kind of products these are.
   */
  async searchProducts(query: ProductSearchQuery): Promise<{ products: Product[] }> {
    const queryTokens = tokenize([query.text, query.category, ...Object.values(query.attributes ?? {})].filter(Boolean).join(" "));
    const matchesOptions = (v: Product["variants"][number]) =>
      Object.entries(query.options ?? {}).every(([key, value]) => v.options[key]?.toLowerCase() === value.toLowerCase());

    const scored = this.products
      .filter((product) => {
        if (query.category && product.category.toLowerCase() !== query.category.toLowerCase()) return false;
        for (const [key, value] of Object.entries(query.attributes ?? {})) {
          if (!textIncludes(product.attributes[key], value.toLowerCase())) return false;
        }
        if (query.options && !product.variants.some(matchesOptions)) return false;
        if (query.budget && !product.variants.some((v) => v.price.currency === query.budget!.currency && v.price.amount <= query.budget!.amount)) return false;
        return true;
      })
      .map((product) => {
        const haystack = tokenize([product.title, product.description, product.category, Object.values(product.attributes).flat().join(" ")].join(" "));
        const score = [...queryTokens].filter((t) => haystack.has(t)).length;
        const available = product.variants.some((v) => v.inventory.available > 0 && matchesOptions(v));
        return { product, score, available };
      })
      .filter(({ score }) => queryTokens.size === 0 || score > 0);

    scored.sort((a, b) => Number(b.available) - Number(a.available) || b.score - a.score);
    return { products: scored.slice(0, 5).map(({ product }) => clone(product)) };
  }

  private findProduct(productId: string): Product | undefined {
    return this.products.find((p) => p.id === productId);
  }

  async getProduct(productId: string): Promise<Product | undefined> {
    const product = this.findProduct(productId);
    return product ? clone(product) : undefined;
  }

  async createCart(input: { businessId: string; customerId: string; conversationId: string }): Promise<Cart> {
    const existing = [...this.carts.values()].find((c) => c.businessId === input.businessId && c.conversationId === input.conversationId && c.status !== "ordered");
    if (existing) return clone(existing);
    const cart: Cart = { id: id("cart"), ...input, lines: [], total: money(0, "ILS"), status: "open" };
    this.carts.set(cart.id, cart);
    return clone(cart);
  }

  async getCart(cartId: string): Promise<Cart | undefined> {
    const cart = this.carts.get(cartId);
    return cart ? clone(cart) : undefined;
  }

  async addToCart(input: { cartId: string; productId: string; variantId: string; quantity: number }): Promise<Cart> {
    const cart = this.carts.get(input.cartId);
    if (!cart) throw new Error("Cart not found");
    if (cart.status === "ordered") throw new Error("Cart is no longer editable");
    // Editing reopens a cart that had a checkout: that checkout's amount no longer applies.
    cart.status = "open";
    const product = this.findProduct(input.productId);
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
    return clone(cart);
  }

  async updateQuantity(input: { cartId: string; lineId: string; quantity: number }): Promise<Cart> {
    const cart = this.carts.get(input.cartId);
    if (!cart) throw new Error("Cart not found");
    if (cart.status === "ordered") throw new Error("Cart is no longer editable");
    cart.status = "open";
    cart.lines = input.quantity <= 0 ? cart.lines.filter((l) => l.id !== input.lineId) : cart.lines.map((l) => l.id === input.lineId ? { ...l, quantity: input.quantity } : l);
    cart.total = cartTotal(cart.lines);
    this.carts.set(cart.id, cart);
    return clone(cart);
  }

  async createCheckout(input: { cartId: string }): Promise<Checkout> {
    const cart = this.carts.get(input.cartId);
    if (!cart || cart.lines.length === 0) throw new Error("Cart is empty");
    cart.status = "checkout";
    this.carts.set(cart.id, cart);
    return { id: id("checkout"), cartId: cart.id, amount: clone(cart.total), status: "pending" };
  }

  async createOrder(input: { cartId: string; idempotencyKey: string }): Promise<Order> {
    const existing = [...this.orders.values()].find((order) => order.idempotencyKey === input.idempotencyKey);
    if (existing) return clone(existing);
    const cart = this.carts.get(input.cartId);
    if (!cart) throw new Error("Cart not found");
    if (cart.status === "ordered") throw new Error("Cart is no longer editable");
    for (const line of cart.lines) {
      const product = this.findProduct(line.productId);
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
      lines: clone(cart.lines),
      total: clone(cart.total),
      status: "paid",
      idempotencyKey: input.idempotencyKey,
      verifiedAt: new Date().toISOString(),
    };
    this.orders.set(order.id, order);
    return clone(order);
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    return this.orders.get(orderId);
  }
}
