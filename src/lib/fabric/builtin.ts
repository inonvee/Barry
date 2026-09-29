import { z } from "zod";
import { registerCapability, type AnyCapabilityContract } from "./capability";

/**
 * The capability contracts BARRY ships with today. They are ordinary
 * registrations — the same call a business manifest makes for
 * `shipping.track` — not a privileged enum. `aliases` are the operation
 * names adapters declared before the fabric existed.
 */

const Money = z.object({ amount: z.number().nonnegative(), currency: z.string().min(3).max(3) });
const Key = z.string().min(8).max(200);
const Id = z.string().min(1).max(200);
const Verified = z.literal(true);

const core = { provenance: { source: "barry_core" as const } };
const read = { effect: "read" as const, verification: "none" as const, idempotency: "none" as const, authority: "none" as const, ...core };
const write = { effect: "consequential" as const, verification: "provider_confirmed" as const, idempotency: "key_required" as const, authority: "policy_gated" as const, ...core };

const Variant = z.object({ id: Id, options: z.record(z.string(), z.string()), price: Money, available: z.number().int().nonnegative() });
const Product = z.object({ id: Id, title: z.string(), variants: z.array(Variant) });
const CartLine = z.object({ lineId: Id, productId: Id, variantId: Id, quantity: z.number().int().positive() });

export const BUILTIN_CAPABILITIES: AnyCapabilityContract[] = [
  {
    id: "commerce.catalog.search",
    version: "1.0.0",
    purpose: "Find products in the business's real catalog.",
    input: z.object({ text: z.string().max(500).optional(), category: z.string().max(200).optional(), attributes: z.record(z.string(), z.string()).optional(), maxPrice: z.number().positive().optional() }),
    output: z.object({ products: z.array(Product) }),
    aliases: ["catalogSearch"],
    examples: { valid: { text: "blue" }, invalid: { maxPrice: -1 } },
    ...read,
  },
  {
    id: "commerce.catalog.schema",
    version: "1.0.0",
    purpose: "Describe how the catalog is organised (categories, attributes, variant options, currency).",
    input: z.object({}),
    output: z.object({ categories: z.array(z.string()), currency: z.string() }).loose(),
    aliases: ["catalogSchema"],
    ...read,
  },
  {
    id: "commerce.variants.read",
    version: "1.0.0",
    purpose: "Read a product's variants (size/color/...) with price and stock.",
    input: z.object({ productId: Id }),
    output: z.object({ variants: z.array(Variant) }),
    aliases: ["variants"],
    ...read,
  },
  {
    id: "commerce.inventory.read",
    version: "1.0.0",
    purpose: "Read live stock for a variant.",
    input: z.object({ productId: Id, variantId: Id }),
    output: z.object({ available: z.number().int().nonnegative() }),
    aliases: ["liveInventory"],
    ...read,
  },
  {
    id: "commerce.cart.create",
    version: "1.0.0",
    purpose: "Open a cart in the business's commerce system.",
    input: z.object({ customerRef: Id, conversationRef: Id, idempotencyKey: Key }),
    output: z.object({ cartId: Id, verified: Verified }),
    aliases: ["cart"],
    ...write,
  },
  {
    id: "commerce.cart.update",
    version: "1.0.0",
    purpose: "Add, change or remove cart lines.",
    input: z.object({ cartId: Id, productId: Id.optional(), variantId: Id.optional(), lineId: Id.optional(), quantity: z.number().int().nonnegative(), idempotencyKey: Key }),
    output: z.object({ cartId: Id, lines: z.array(CartLine), total: Money, verified: Verified }),
    aliases: ["cart"],
    ...write,
  },
  {
    id: "commerce.checkout.create",
    version: "1.0.0",
    purpose: "Open a checkout for a cart.",
    input: z.object({ cartId: Id, idempotencyKey: Key }),
    output: z.object({ checkoutId: Id, amount: Money, checkoutUrl: z.string().url().optional(), verified: Verified }),
    aliases: ["checkout"],
    ...write,
  },
  {
    id: "commerce.order.create",
    version: "1.0.0",
    purpose: "Create the order for a cart after verified payment.",
    input: z.object({ cartId: Id, paymentRef: Id, idempotencyKey: Key }),
    output: z.object({ orderId: Id, total: Money, verified: Verified }),
    aliases: ["orders"],
    ...write,
  },
  {
    id: "commerce.order.status",
    version: "1.0.0",
    purpose: "Look up an order's status.",
    input: z.object({ orderId: Id }),
    output: z.object({ orderId: Id, status: z.string() }),
    aliases: ["orderStatus"],
    ...read,
  },
  {
    id: "payments.create_request",
    version: "1.0.0",
    purpose: "Create a payment request / link for an exact amount.",
    input: z.object({ amount: z.number().positive(), currency: z.string().length(3), reason: z.string().max(500), idempotencyKey: Key }),
    output: z.object({ paymentId: Id, checkoutUrl: z.string().url(), status: z.enum(["pending", "paid", "failed", "cancelled"]), verified: Verified }),
    aliases: ["paymentLinks"],
    examples: { valid: { amount: 390, currency: "ILS", reason: "Order", idempotencyKey: "conformance-key-1" }, invalid: { amount: -5, currency: "ILS", reason: "x", idempotencyKey: "conformance-key-1" } },
    ...write,
  },
  {
    id: "payments.verify",
    version: "1.0.0",
    purpose: "Ask the provider for a payment's real status. A customer's claim is never payment.",
    input: z.object({ paymentId: Id }),
    output: z.object({ paymentId: Id, status: z.enum(["pending", "paid", "failed", "cancelled"]) }),
    aliases: ["statusLookup"],
    ...read,
  },
  {
    id: "payments.webhook.verify",
    version: "1.0.0",
    purpose: "Authenticate a provider's payment event.",
    input: z.object({ rawBody: z.string().max(1_000_000), headers: z.record(z.string(), z.string()) }),
    output: z.object({ paymentId: Id, eventId: Id, status: z.enum(["pending", "paid", "failed", "cancelled"]) }),
    aliases: ["webhookVerification"],
    conversational: false,
    ...read,
  },
  {
    id: "payments.refund",
    version: "1.0.0",
    purpose: "Refund a payment (fully or partly).",
    input: z.object({ paymentId: Id, amount: z.number().positive(), idempotencyKey: Key }),
    output: z.object({ refundId: Id, verified: Verified }),
    aliases: ["refunds"],
    ...write,
  },
  {
    id: "scheduling.availability.read",
    version: "1.0.0",
    purpose: "Read real open times.",
    input: z.object({ serviceRef: Id, earliest: z.string().datetime(), latest: z.string().datetime().optional(), partySize: z.number().int().positive().default(1) }),
    output: z.object({ slots: z.array(z.object({ resourceId: Id, start: z.string(), end: z.string() })) }),
    aliases: ["availability"],
    ...read,
  },
  {
    id: "scheduling.booking.create",
    version: "1.0.0",
    purpose: "Book a confirmed slot.",
    input: z.object({ serviceRef: Id, resourceId: Id, start: z.string().datetime(), end: z.string().datetime(), customerRef: Id, idempotencyKey: Key }),
    output: z.object({ bookingId: Id, verified: Verified }),
    aliases: ["booking"],
    ...write,
  },
  {
    id: "scheduling.booking.lookup",
    version: "1.0.0",
    purpose: "Look up a booking.",
    input: z.object({ bookingId: Id }),
    output: z.object({ bookingId: Id, status: z.string() }),
    aliases: ["bookingLookup"],
    ...read,
  },
  {
    id: "messaging.send",
    version: "1.0.0",
    purpose: "Send a message to a customer on their channel.",
    input: z.object({ channelRef: Id, to: Id, text: z.string().min(1).max(4096), idempotencyKey: Key }),
    output: z.object({ messageId: Id, verified: Verified }),
    aliases: ["send"],
    ...write,
  },
];

for (const contract of BUILTIN_CAPABILITIES) registerCapability(contract);
