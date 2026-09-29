import { BusinessGraphSchema, type BusinessGraph } from "@/lib/business-graph";
import { generateDailySlots } from "./helpers";

export function buildPersonalTrainerGraph(): BusinessGraph {
  return BusinessGraphSchema.parse({
    business: {
      id: "personal-trainer",
      name: "Coach Riley Fitness",
      description: "1:1 personal training and fitness consultations.",
      locale: "en-US",
      timezone: "America/Denver",
      tone: { voice: "playful", formality: "casual", emojiOk: true },
      operatingHours: [
        { day: "mon", open: "06:00", close: "20:00" },
        { day: "tue", open: "06:00", close: "20:00" },
        { day: "wed", open: "06:00", close: "20:00" },
        { day: "thu", open: "06:00", close: "20:00" },
        { day: "fri", open: "06:00", close: "20:00" },
      ],
    },
    capabilities: { requiresScheduling: true, requiresPayment: true },
    offers: [
      {
        id: "offer-free-consult",
        kind: "consultation",
        name: "Free Fitness Consultation",
        description: "30-minute goal-setting call, no cost.",
        price: 0,
        currency: "USD",
        requiresScheduling: true,
        durationMinutes: 30,
        requiredResourceTypes: ["trainer"],
        requiredCustomerInfo: ["name", "email"],
        requiresPayment: false,
      },
      {
        id: "offer-training-session",
        kind: "service",
        name: "1:1 Training Session",
        description: "60-minute personal training session.",
        price: 80,
        currency: "USD",
        requiresScheduling: true,
        durationMinutes: 60,
        requiredResourceTypes: ["trainer"],
        requiredCustomerInfo: ["name", "email"],
        requiresPayment: true,
        depositAmount: 80,
      },
    ],
    resources: [{ id: "trainer-riley", type: "trainer", name: "Riley" }],
    availability: [...generateDailySlots("trainer-riley", 8, [6, 7, 12, 17, 18, 19], 60, "America/Denver")],
    inventory: [],
    knowledge: [
      { id: "know-location", topic: "location", content: "Sessions take place at Riverside Gym, 2nd floor studio.", kind: "faq" },
    ],
    policies: [
      { id: "pol-booking", description: "Bookings auto-allowed", rule: { type: "bookings_auto_allowed", value: true } },
      { id: "pol-discount", description: "No automatic discounts", rule: { type: "max_auto_discount_pct", value: 0 } },
      { id: "pol-max-payment", description: "Max automatic payment amount", rule: { type: "max_auto_payment_amount", value: 200 } },
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
