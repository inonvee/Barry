import { BusinessGraphSchema, type BusinessGraph } from "@/lib/business-graph";
import { generateDailySlots } from "./helpers";

export function buildSpaGraph(): BusinessGraph {
  return BusinessGraphSchema.parse({
    business: {
      id: "spa",
      name: "Serenity Massage Spa",
      description: "A neighborhood massage and wellness spa.",
      locale: "en-US",
      timezone: "America/New_York",
      tone: { voice: "warm", formality: "casual", emojiOk: true },
      operatingHours: [
        { day: "mon", open: "09:00", close: "19:00" },
        { day: "tue", open: "09:00", close: "19:00" },
        { day: "wed", open: "09:00", close: "19:00" },
        { day: "thu", open: "09:00", close: "19:00" },
        { day: "fri", open: "09:00", close: "20:00" },
        { day: "sat", open: "10:00", close: "17:00" },
      ],
    },
    capabilities: { requiresScheduling: true, requiresPayment: true, requiresApproval: true },
    offers: [
      {
        id: "offer-couples-massage",
        kind: "service",
        name: "Couples Massage",
        description: "60-minute side-by-side massage for two.",
        price: 220,
        currency: "USD",
        requiresScheduling: true,
        durationMinutes: 60,
        requiredResourceTypes: ["therapist"],
        requiredCustomerInfo: ["name", "phone"],
        requiresPayment: true,
        depositAmount: 50,
      },
      {
        id: "offer-solo-massage",
        kind: "service",
        name: "Solo Swedish Massage",
        description: "60-minute relaxation massage.",
        price: 120,
        currency: "USD",
        requiresScheduling: true,
        durationMinutes: 60,
        requiredResourceTypes: ["therapist"],
        requiredCustomerInfo: ["name", "phone"],
        requiresPayment: true,
        depositAmount: 30,
      },
    ],
    resources: [
      { id: "therapist-1", type: "therapist", name: "Ana" },
      { id: "therapist-2", type: "therapist", name: "Bruno" },
    ],
    availability: [
      ...generateDailySlots("therapist-1", 7, [9, 10, 11, 12, 13, 14, 15], 60),
      ...generateDailySlots("therapist-2", 7, [10, 11, 12, 13, 14, 15, 16], 60),
    ],
    inventory: [],
    knowledge: [
      {
        id: "know-parking",
        topic: "parking",
        content: "Free parking is available directly behind the spa.",
        kind: "faq",
      },
      {
        id: "know-cancellation",
        topic: "cancellation policy",
        content: "Cancellations within 24 hours forfeit the deposit.",
        kind: "policy_text",
      },
    ],
    policies: [
      { id: "pol-discount", description: "Max automatic discount", rule: { type: "max_auto_discount_pct", value: 5 } },
      { id: "pol-refund", description: "Refunds need approval", rule: { type: "refund_requires_approval", value: true } },
      { id: "pol-booking", description: "Bookings auto-allowed", rule: { type: "bookings_auto_allowed", value: true } },
      { id: "pol-custom-price", description: "Custom pricing needs approval", rule: { type: "custom_pricing_requires_approval", value: true } },
      { id: "pol-max-payment", description: "Max automatic payment amount", rule: { type: "max_auto_payment_amount", value: 500 } },
    ],
    availableActions: [
      { name: "checkAvailability" },
      { name: "createBooking" },
      { name: "createPaymentRequest" },
      { name: "requestApproval" },
      { name: "createFollowUp" },
    ],
    goals: ["bookAppointment", "collectDeposit"],
  });
}
