# Domain truth and transaction state

This is the response to live attack pass #2, which tested commit `94ab6a4`. The fix is architectural. The composer is treated as imperfect: what it may state is limited by records the runtime owns, and the runtime checks the reply before it goes out.

## 1. Business effects, not call success (`src/lib/runtime/ledger.ts`)

Every executed operation goes through `classifyExecution()`, which turns a returned call into a **domain effect**: an effect type plus a status. Being `allowed`, `ok: true`, or an HTTP 200 only means the call returned; it says nothing about the business.

| Operation result | Ledger effect / status |
|---|---|
| `verifyPayment` → `{status: pending}` | `payment.pending` (a check, **not** a payment) |
| `verifyPayment` → `{status: paid}` | `payment.settled` |
| approval required | `request.awaiting_owner` (nothing carried out) |
| generic write, system confirmed | `<capability>` / `effected` |
| generic write, not confirmed | `<capability>` / `effected_unconfirmed` |
| tool / transport error | `<op>.failed` / `failed` |
| cart change requested but not applied | `cart.not_changed` / `no_effect` |

Reply claims are satisfied **only** by matching ledger effects:

| The reply claims… | …which needs this ledger effect |
|---|---|
| booked | `booking.created` |
| paid / verified | `payment.settled` |
| opened / created | a confirmed create effect |
| changed | an update effect |
| cancelled | a cancel, withdraw or supersede effect |
| refunded | a refund effect |
| sent | `payment.link_created` or a follow-up |
| available / in stock | a lookup in **this** turn |

These rules hold for:
- model replies;
- regenerated replies;
- the deterministic fallback;
- replies after the owner resolves a request.

Earlier assistant messages are never evidence.

## 2. Immutable receipts

Ledger entries are append-only. Each one freezes:
- the operation;
- its customer-safe **terms** (reference, quantity, amount, items);
- the owner-request id;
- the business **reference** it produced.

Lifecycle changes (withdrawn, superseded, declined, executed) are *new* entries.

`findMisattributedReferences()` rejects any reply that puts a produced reference (e.g. `T-1001`) next to another request's identifiers. This check is structural: it uses the recorded pairs, not wording.

## 3. One quantity-aware money object (`src/lib/runtime/pricing.ts`)

A `Quote` is built from Genome prices × quantity (IR `constraints.quantity`, latest correction wins) × discount, plus the business's **own** shipping rule:
- **`free_shipping_over`:** free strictly above the threshold.
- **`flat_shipping_fee`:** that fee applies below the threshold.
- **Neither rule:** shipping is *unknown*, never invented, and the quote is marked incomplete.

The same quote supplies:
- the approval payload (`amount`, `quantity`, `lines`);
- the payment link;
- stock checks (they check the requested quantity);
- the composer's `pricing`;
- the amount check;
- the deterministic status rendering.

A payment request whose terms change supersedes the older revision still pending. There is exactly one active revision.

## 4. Read intent ≠ mutation intent ≠ checkout consent

New model-owned IR signals, shown literally in the Inspector under "Turn signals":
- **`readRequested`:** a requested lookup (open times, stock) runs even when the message doesn't advance a purchase. It never books or charges.
- **`checkoutConsent`:** `false` blocks every step toward payment in that turn. A cart change never implies checkout.
- **`advancesTransaction` / `withdrawsRequest` / `changesPendingRequest`:** carried over from pass #1.

## 5. Regenerate the whole reply, don't strip sentences

`guardReply()` collects every problem in a draft:
- internal leak;
- unsupported claim, amount or measurement;
- misattributed reference;
- wrong language (checked by script).

It then asks the composer to **rewrite the whole reply**, listing those problems, so conclusions that depended on a bad claim go too (for example, "fits perfectly" when the dimensions are unknown). If the rewrite still fails, the deterministic reply is used, carrying `renderStatus()`. That rendering lists:
- each request with its own terms and lifecycle;
- whether anything is booked or paid;
- whether anything is waiting on the owner;
- the authoritative quote.

## 6. Authoritative approval lifecycle

`GET /api/simulator/approvals` returns each record with:
- **`lifecycle`:** active, superseded, withdrawn, declined, executed, executed_unconfirmed, failed, or approved;
- **`revision`:** its revision number within the operation;
- **`summary`:** the terms, including quantity and total.

The simulator refreshes the list after **every** turn. Only *active* requests have Approve/Decline buttons. The server-side execution protection remains the real safeguard: a stale approve still executes nothing.

## Verification status

- **Deterministically tested:**
  - `__tests__/pass2-domain-truth.test.ts`, which replays the pass #2 sequences with the live composer's false sentences;
  - the pass #1 and human-conversation suites;
  - the full suite.
- **Not live-proven:** the live suite (`npm run eval:conversation`) includes pass #2 scenarios, but it needs `OPENAI_API_KEY` plus the Preview model settings.

### Known limits

- Claim detection still reads BARRY's *outgoing* text against a closed effect vocabulary. What changed is that the evidence is now the ledger.
- A lookup the customer asks for runs only if the model sets `readRequested`.
- The weekday-qualifier ambiguity from Spa (Oct 5 → Oct 12) was not addressed.

## Pass #3: structural invariants (commit `b51eced` attack)

1. **Final-write consent** (`src/lib/runtime/write-gate.ts`). The gate runs immediately before any payment-bearing write, in three places:
   - when a request is proposed to the owner;
   - when a write is executed;
   - after an owner approves, re-checked against the customer's current constraints.

   It re-reads the cart and quote, then enforces:
   - **Scope:** only the consented lines, in the consented quantity.
   - **References:** an invalid reference is never consent.
   - **Hard cap:** the customer's hard maximum (IR `constraints.budgetMax`). If the cap includes shipping and the shipping cost is unknown, nothing is created.

   A blocked write is recorded as `write.blocked` (no effect), and the reply says why, with the real numbers. A cart change in a later turn invalidates earlier checkout consent.
2. **Exact mutation subject.** Cart mutations resolve the grounded `cart_line` position against the real cart, never the last line touched. Reference grounding counts the real cart lines. Each receipt freezes:
   - the item (product and options);
   - the quantity before and after;
   - the returned cart.

   A change not visible on that line is recorded as `cart.change_not_verified` (failed). A reply claiming "the cart is empty" is checked against the provider's cart.
3. **Exact domain-effect narration.** A payment link is not an email delivery, and an enquiry is not an arranged callback: each needs its own effect. Booking needs `booking.created` (the Hebrew booking vocabulary now included). "The owner is reviewing" needs a request that is actually waiting. A measurement the customer gave may be repeated as theirs, never asserted as a product fact.
4. **Atomic revision.** When a customer changes a pending request's terms, the change is settled after the turn:
   - if a valid replacement was created, the old request is superseded;
   - if not, the old request is still superseded, and the reply says nothing is waiting on the owner.

   Withdrawal is scoped by `withdrawScope`. Approval resolution is compare-and-set on `pending` in both backends, so concurrent or stale approvals execute nothing twice.
5. **Temporal constraints.** A scheduling constraint carries `end` and `startExclusive`. Both survive to UTC, and the availability tool holds every provider's answer to them. Changing service clears a stale party size.
