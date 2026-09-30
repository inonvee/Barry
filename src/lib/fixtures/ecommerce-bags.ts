import { BusinessGraphSchema, type BusinessGraph } from "@/lib/business-graph";

export function buildEcommerceBagsGraph(): BusinessGraph {
  return BusinessGraphSchema.parse({
    business: {
      id: "ecommerce-bags",
      name: "Wanderlust Bags Co.",
      description: "Online store selling handcrafted travel and everyday bags.",
      locale: "en-US",
      timezone: "America/Los_Angeles",
      tone: { voice: "friendly", formality: "casual", emojiOk: true },
      operatingHours: [],
    },
    capabilities: { requiresInventory: true, requiresPayment: true },
    offers: [
      {
        id: "offer-weekender",
        kind: "product",
        name: "Weekender Duffel",
        description: "Canvas and leather weekender bag, 45L.",
        price: 189,
        currency: "USD",
        requiresInventory: true,
        sku: "SKU-WEEKENDER",
        requiredCustomerInfo: ["email"],
        requiresPayment: true,
      },
      {
        id: "offer-tote",
        kind: "product",
        name: "Everyday Tote",
        description: "Lightweight tote for work and errands.",
        price: 79,
        currency: "USD",
        requiresInventory: true,
        sku: "SKU-TOTE",
        requiredCustomerInfo: ["email"],
        requiresPayment: true,
      },
      {
        id: "offer-backpack",
        kind: "product",
        name: "Commuter Backpack",
        description: "Water-resistant backpack with laptop sleeve.",
        price: 129,
        currency: "USD",
        requiresInventory: true,
        sku: "SKU-BACKPACK",
        requiredCustomerInfo: ["email"],
        requiresPayment: true,
      },
    ],
    resources: [],
    availability: [],
    inventory: [
      { sku: "SKU-WEEKENDER", quantityOnHand: 4 },
      { sku: "SKU-TOTE", quantityOnHand: 0 },
      { sku: "SKU-BACKPACK", quantityOnHand: 12 },
    ],
    knowledge: [
      { id: "know-shipping", topic: "shipping", content: "Free shipping on orders over $75, arrives in 3-5 business days.", kind: "faq" },
      { id: "know-returns", topic: "returns", content: "30-day returns on unused items with tags attached.", kind: "policy_text" },
    ],
    policies: [
      { id: "pol-discount", description: "Max automatic discount", rule: { type: "max_auto_discount_pct", value: 10 } },
      { id: "pol-refund", description: "Refunds need approval", rule: { type: "refund_requires_approval", value: true } },
      { id: "pol-max-payment", description: "Max automatic payment amount", rule: { type: "max_auto_payment_amount", value: 1000 } },
      { id: "pol-free-shipping", description: "Free shipping on orders over $75", rule: { type: "free_shipping_over", value: 75 } },
    ],
    availableActions: [
      { name: "checkInventory" },
      { name: "createPaymentRequest" },
      { name: "requestApproval" },
      { name: "createFollowUp" },
      { name: "fulfillOrder" },
    ],
    goals: ["completePurchase"],
  });
}
