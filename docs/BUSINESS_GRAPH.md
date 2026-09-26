# The Business Graph

Defined in `src/lib/business-graph/schema.ts` as Zod schemas (source of
truth for both TypeScript types and runtime validation). A `BusinessGraph`
is the complete structured description of one business.

## Shape

```
BusinessGraph
├── business         name, description, locale, timezone, tone, operating hours
├── capabilities      requiresScheduling / requiresInventory / requiresPayment / requiresApproval
├── offers[]           anything a customer can obtain
├── resources[]        therapists, rooms, vehicle bays, trainers, ...
├── availability[]     open (resourceId, start, end) slots
├── inventory[]        sku -> quantityOnHand
├── knowledge[]        facts, FAQ, policy text, product/service info
├── policies[]         what BARRY can decide on its own vs. must escalate
├── availableActions[] which tools are enabled for this business
└── goals[]            commercial goals this business cares about
```

## Offers

An `Offer` (`OfferSchema`) can be a product, service, appointment,
package, consultation, or quote. Its flags — not its `kind` — drive
runtime behavior:

- `requiresScheduling` + `durationMinutes` + `requiredResourceTypes` → the
  runtime will call `checkAvailability` / `createBooking`.
- `requiresInventory` + `sku` → the runtime will call `checkInventory` /
  `fulfillOrder`.
- `requiresPayment` (+ optional `depositAmount`) → the runtime will call
  `createPaymentRequest` before proceeding.
- `price: null` with no scheduling/inventory → treated as a quote/lead
  (`createLead` is used to qualify instead of transact).
- `requiredCustomerInfo` → fields the runtime must collect (name, email,
  phone, ...) before it will act. Missing entries drive the
  `info_gathering` conversation stage.

## Policies

Each `Policy` wraps one typed `rule`:

- `max_auto_discount_pct` — discounts at or below this % are automatic;
  above it, `requestApproval` is triggered.
- `refund_requires_approval` — boolean gate on refunds.
- `bookings_auto_allowed` — boolean gate on `createBooking`.
- `custom_pricing_requires_approval` — boolean gate on quoted/custom prices.
- `max_auto_payment_amount` — payment requests above this amount escalate.

The Policy Engine (`src/lib/policy/engine.ts`) is the only code that reads
these. Nothing else interprets a policy.

## Available actions

`availableActions` is a business-level allowlist of tool names
(`{ name, enabled }`). The Policy Engine denies any action not on this
list before it even considers the specific policy rules — this is what
lets e.g. the personal trainer fixture simply never expose
`checkInventory` in the simulator, without any code caring that "personal
trainers don't sell inventory."

## Test fixtures

`src/lib/fixtures/*.ts` build five `BusinessGraph`s used both by the
simulator and by the scenario tests:

| Fixture | Capabilities exercised |
|---|---|
| `spa.ts` | scheduling + payment + approval (discount/refund) |
| `ecommerce-bags.ts` | inventory + payment, out-of-stock handling |
| `garage.ts` | scheduling + payment + custom-pricing approval |
| `personal-trainer.ts` | scheduling with and without payment, zero auto-discount |
| `furniture-store.ts` | inventory + payment + lead qualification (custom orders) |

Availability windows are generated relative to "now" at fixture build
time (`fixtures/helpers.ts`) so demos and tests always see open slots in
the future.
