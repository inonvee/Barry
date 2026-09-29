import { BusinessGraphSchema, type BusinessGraph } from "@/lib/business-graph";
import { generateDailySlots } from "./helpers";

export function buildGarageGraph(): BusinessGraph {
  return BusinessGraphSchema.parse({
    business: {
      id: "garage",
      name: "Midtown Auto Care",
      description: "Full-service automotive garage.",
      locale: "en-US",
      timezone: "America/Chicago",
      tone: { voice: "professional", formality: "neutral", emojiOk: false },
      operatingHours: [
        { day: "mon", open: "08:00", close: "18:00" },
        { day: "tue", open: "08:00", close: "18:00" },
        { day: "wed", open: "08:00", close: "18:00" },
        { day: "thu", open: "08:00", close: "18:00" },
        { day: "fri", open: "08:00", close: "18:00" },
      ],
    },
    capabilities: { requiresScheduling: true, requiresPayment: true, requiresApproval: true },
    offers: [
      {
        id: "offer-oil-change",
        kind: "service",
        name: "Oil Change",
        description: "Standard oil and filter change.",
        price: 65,
        currency: "USD",
        requiresScheduling: true,
        durationMinutes: 30,
        requiredResourceTypes: ["vehicle_bay"],
        requiredCustomerInfo: ["name", "phone"],
        requiresPayment: true,
        depositAmount: 65,
      },
      {
        id: "offer-brake-inspection",
        kind: "service",
        name: "Brake Inspection",
        description: "Full brake system inspection with quote for any needed work.",
        price: null,
        currency: "USD",
        requiresScheduling: true,
        durationMinutes: 45,
        requiredResourceTypes: ["vehicle_bay"],
        requiredCustomerInfo: ["name", "phone"],
        requiresPayment: false,
      },
    ],
    resources: [
      { id: "bay-1", type: "vehicle_bay", name: "Bay 1" },
      { id: "bay-2", type: "vehicle_bay", name: "Bay 2" },
    ],
    availability: [
      ...generateDailySlots("bay-1", 8, [8, 9, 10, 11, 13, 14, 15], 30, "America/Chicago"),
      ...generateDailySlots("bay-2", 8, [8, 9, 10, 11, 13, 14, 15], 30, "America/Chicago"),
    ],
    inventory: [],
    knowledge: [
      { id: "know-warranty", topic: "warranty", content: "All parts and labor are covered by a 12-month warranty.", kind: "faq" },
    ],
    policies: [
      { id: "pol-booking", description: "Bookings auto-allowed", rule: { type: "bookings_auto_allowed", value: true } },
      { id: "pol-custom-price", description: "Custom pricing (quotes) needs approval", rule: { type: "custom_pricing_requires_approval", value: true } },
      { id: "pol-discount", description: "Max automatic discount", rule: { type: "max_auto_discount_pct", value: 5 } },
      { id: "pol-max-payment", description: "Max automatic payment amount", rule: { type: "max_auto_payment_amount", value: 300 } },
    ],
    availableActions: [
      { name: "checkAvailability" },
      { name: "createBooking" },
      { name: "createPaymentRequest" },
      { name: "requestApproval" },
      { name: "createFollowUp" },
    ],
    goals: ["bookAppointment", "requestQuote"],
  });
}
