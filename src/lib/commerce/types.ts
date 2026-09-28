export type Money = { amount: number; currency: string };

export type ProductVariant = {
  id: string;
  sku: string;
  title: string;
  options: Record<string, string>;
  price: Money;
  inventory: { available: number };
};

export type Product = {
  id: string;
  title: string;
  description: string;
  category: string;
  attributes: Record<string, string | string[]>;
  media: { url: string; alt: string }[];
  url?: string;
  variants: ProductVariant[];
};

export type ProductSearchQuery = {
  text?: string;
  category?: string;
  occasion?: string;
  color?: string;
  size?: string;
  budget?: Money;
};

export type CartLine = {
  id: string;
  productId: string;
  variantId: string;
  title: string;
  quantity: number;
  unitPrice: Money;
  options: Record<string, string>;
};

export type Cart = {
  id: string;
  businessId: string;
  customerId: string;
  conversationId: string;
  lines: CartLine[];
  total: Money;
  status: "open" | "checkout" | "ordered";
  providerCartId?: string;
};

export type Checkout = {
  id: string;
  cartId: string;
  amount: Money;
  checkoutUrl?: string;
  paymentRequestId?: string;
  status: "pending" | "paid" | "expired";
};

export type Order = {
  id: string;
  businessId: string;
  customerId: string;
  conversationId: string;
  cartId: string;
  lines: CartLine[];
  total: Money;
  status: "created" | "paid" | "fulfilled" | "cancelled";
  providerOrderId?: string;
  idempotencyKey: string;
  verifiedAt: string;
};

export type CommerceAdapter = {
  readonly name: "memory" | "custom-commerce";
  searchProducts(query: ProductSearchQuery): Promise<{ products: Product[] }>;
  getProduct(productId: string): Promise<Product | undefined>;
  createCart(input: { businessId: string; customerId: string; conversationId: string }): Promise<Cart>;
  getCart(cartId: string): Promise<Cart | undefined>;
  addToCart(input: { cartId: string; productId: string; variantId: string; quantity: number }): Promise<Cart>;
  updateQuantity(input: { cartId: string; lineId: string; quantity: number }): Promise<Cart>;
  createCheckout(input: { cartId: string }): Promise<Checkout>;
  createOrder(input: { cartId: string; idempotencyKey: string }): Promise<Order>;
  getOrder(orderId: string): Promise<Order | undefined>;
};
