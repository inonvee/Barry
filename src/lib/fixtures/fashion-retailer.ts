import { BusinessGraphSchema, type BusinessGraph } from "@/lib/business-graph";
import type { Product } from "@/lib/commerce/types";

export function fashionCatalog(): Product[] {
  return [
    {
      id: "prod-midnight-wrap-dress",
      title: "Midnight Wrap Dress",
      description: "Black wrap dress suitable for evening events.",
      category: "dress",
      attributes: { color: "black", occasion: ["wedding", "event"], material: "crepe" },
      media: [{ url: "https://example.com/images/midnight-wrap.jpg", alt: "Midnight Wrap Dress" }],
      url: "https://example.com/products/midnight-wrap-dress",
      variants: [
        { id: "var-midnight-s", sku: "MWD-S-BLK", title: "S / Black", options: { size: "S", color: "black" }, price: { amount: 420, currency: "ILS" }, inventory: { available: 0 } },
        { id: "var-midnight-m", sku: "MWD-M-BLK", title: "M / Black", options: { size: "M", color: "black" }, price: { amount: 420, currency: "ILS" }, inventory: { available: 3 } },
        { id: "var-midnight-l", sku: "MWD-L-BLK", title: "L / Black", options: { size: "L", color: "black" }, price: { amount: 420, currency: "ILS" }, inventory: { available: 2 } },
      ],
    },
    {
      id: "prod-onyx-slip-dress",
      title: "Onyx Slip Dress",
      description: "Black midi dress with adjustable straps.",
      category: "dress",
      attributes: { color: "black", occasion: ["wedding", "cocktail"], material: "satin blend" },
      media: [{ url: "https://example.com/images/onyx-slip.jpg", alt: "Onyx Slip Dress" }],
      url: "https://example.com/products/onyx-slip-dress",
      variants: [
        { id: "var-onyx-m", sku: "OSD-M-BLK", title: "M / Black", options: { size: "M", color: "black" }, price: { amount: 390, currency: "ILS" }, inventory: { available: 1 } },
        { id: "var-onyx-l", sku: "OSD-L-BLK", title: "L / Black", options: { size: "L", color: "black" }, price: { amount: 390, currency: "ILS" }, inventory: { available: 0 } },
      ],
    },
    {
      id: "prod-slim-belt",
      title: "Slim Occasion Belt",
      description: "Black belt often paired with event dresses.",
      category: "accessory",
      attributes: { color: "black", occasion: ["wedding", "event"] },
      media: [{ url: "https://example.com/images/slim-belt.jpg", alt: "Slim Occasion Belt" }],
      url: "https://example.com/products/slim-belt",
      variants: [
        { id: "var-belt-one", sku: "BELT-ONE-BLK", title: "One Size / Black", options: { size: "One Size", color: "black" }, price: { amount: 90, currency: "ILS" }, inventory: { available: 8 } },
      ],
    },
  ];
}

export function buildFashionRetailerGraph(): BusinessGraph {
  return BusinessGraphSchema.parse({
    business: {
      id: "fashion-retailer",
      name: "Rina Studio",
      description: "Occasion wear and accessories retailer.",
      locale: "he-IL",
      timezone: "Asia/Jerusalem",
      tone: { voice: "warm", formality: "neutral", emojiOk: false },
      operatingHours: [],
    },
    capabilities: { requiresInventory: true, requiresPayment: true },
    offers: [],
    resources: [],
    availability: [],
    inventory: [],
    knowledge: [
      { id: "returns", topic: "returns", kind: "policy_text", content: "Returns are accepted within 14 days. Sale items can be exchanged only." },
      { id: "shipping", topic: "shipping", kind: "policy_text", content: "Free shipping above ₪399." },
    ],
    policies: [
      { id: "pol-discount", description: "Max automatic discount", rule: { type: "max_auto_discount_pct", value: 5 } },
      { id: "pol-max-payment", description: "Max automatic payment amount", rule: { type: "max_auto_payment_amount", value: 2000 } },
      { id: "pol-booking", description: "No bookings", rule: { type: "bookings_auto_allowed", value: true } },
    ],
    availableActions: [
      { name: "searchProducts" },
      { name: "addToCart" },
      { name: "updateCartLine" },
      { name: "createCommerceCheckout" },
      { name: "createCommerceOrder" },
      { name: "createPaymentRequest" },
      { name: "requestApproval" },
    ],
    goals: ["completePurchase"],
  });
}
