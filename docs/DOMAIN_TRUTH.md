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

## Pass #4 — understanding failure is a first-class outcome (commit `6afff0b` attack)

**Root cause of F32 (and the enabler of F31).** On a failure, `OpenAIReasoner.understandDetailed()` returned `emptyIR("understanding_failed")` with a failure string. The engine then called `understand()`, which returns only `.ir`, so that string was discarded.

The empty IR was compiled as a normal turn: no signals, which becomes `ask_general`, which becomes "What can I help you with? We offer …". The provider's error went only to `console.error`.

In the live logs, the composer (a different model with no schema) was *also* falling back to its deterministic text on the same turns: T8+ replied exactly "What can I help you with?" with no guard fallback recorded. That points to provider-level call failures (rate limit, quota or outage) rather than schema drift. It stays UNVERIFIED until a live trace shows the classified status.

1. **Observable** (`trace.understanding`, `trace.reply.composerFailures`, Inspector "Understanding" chip). Each turn records:
   - valid or failed;
   - attempts and latency;
   - the classified failure: `provider_rate_limited | provider_quota_exhausted | provider_unavailable | provider_timeout | provider_connection | provider_auth | provider_rejected_request | empty_completion | json_parse_error | schema_validation_error | invalid_model_config`;
   - HTTP status, provider code and a sanitized message;
   - salvaged fields.

   A composer call that fell back is recorded too.
2. **Retry policy.**
   - Transient provider errors (429 honouring retry-after, 5xx, timeouts, connection) are retried with backoff by the provider client (`maxRetries: 2`).
   - Permanent errors (quota, auth, 400) are not retried.
   - Only malformed *output* gets one corrective re-ask, which carries the validation issue.
3. **Salvage, not all-or-nothing.**
   - A schema-invalid field becomes "not stated" (null, `[]`, or the invalid list item is removed) and is recorded. The rest of the understanding survives.
   - If a dropped field could carry a decision (signals, quantity, cap, commerce, capability request, …), the turn **fails closed**: no advance, no consent.
   - The Zod contract no longer rejects lengths the wire schema allows (`capabilityRequest.purpose` / `inputJson`).
4. **Explicit degraded turn.** Failed understanding is never compiled:
   - no withdrawal, no step, no write;
   - an `understanding.failed` ledger entry;
   - a deterministic reply saying the message wasn't processed and nothing was changed or sent, plus where things stand when anything is pending or done, plus that a pending owner request is on hold.

## F31 — customer-intent revalidation of approvals

An owner's approval is not the customer's consent. Before `resumeAfterApproval` resolves or executes anything, `customerIntentHold()` checks the conversation after the request's latest "asked" or "reconfirmed" ledger entry. It holds the request when either of these is true:

- a later customer turn's understanding **failed** (or failed closed);
- a later customer message names an identifier that is a **near-miss** of one of the request's own identifiers (same shape, ≤⅓ characters differ; e.g. C302 vs Q4-C301).

This uses ledger order and message position, never meaning. A held request:
- stays pending, with lifecycle `held` and the reason in Approvals (Approve disabled, Decline allowed);
- produces a question to the customer;
- is released only when a validly understood turn re-proposes exactly the same terms (`request.reconfirmed`).

Safety therefore no longer depends on `changesPendingRequest` alone.

## Other findings

- **F24:** a variant change can replace the provider's cart line. The ledger now verifies the provider's *returned* line (`out.lineId`): options and quantity. It records `item` → `itemAfter`, quantity before and after.
- **F23/F25:** these are handled by reply-grounding checks — see the list below.
- **F28:** changed terms with no replacement in the first understanding trigger one continuation understanding. It is given `replacingRequests` and is compiled and authorized as usual.
- **F29:** a status answer lists each owner request with its own terms, lifecycle and reference (not only the latest).
- **F26/F27:** opening hours are a composer fact (empty = unknown). The prompt now says the business name is never the customer's name (prompt only).

**New reply-grounding checks:**
- an item narrated as being added to the cart (done, now or next) needs a cart effect *this turn* for that item;
- a blocked write always gets the deterministic reply, including any real earlier steps;
- a future owner promise needs a request that is actually waiting;
- a clock time needs a source: facts or hours, a lookup, the ledger or the customer.

Deterministic coverage: `__tests__/pass4-understanding.test.ts`. Live verification: NOT run in this environment (no `OPENAI_API_KEY` / Vercel access).

## Paid-pilot correctness additions

- **Revalidation** (`revalidateUnresolvedTurns`, engine): a customer message BARRY couldn't understand while a request was pending is re-understood in its own context once understanding is available. This happens before the next customer turn, at the owner's Approve, or on an owner re-check.
  - If the message withdrew or changed the request, that change is applied to exactly the requests pending before the message: they are withdrawn or superseded, never executed. The customer is told.
  - If it provably left them untouched, an `understanding.revalidated` entry releases the hold.
  - While understanding is unavailable, the request stays held.
- **Multi-ask completeness:**
  - The IR's `asks` lists every ask in the message, and which one the IR covers.
  - After a customer-triggered change succeeds, the next uncovered change is continued: re-understood, grounded, compiled and authorized. At most two continuations run per message; exact repeats are refused, and a continuation never withdraws or revises anything.
  - What is never reached goes to the reply as `notDone`.
- **Handoff** (`handoff.created` / `handoff.resolved` ledger effects): a callback claim needs a handoff whose business declared its response path.
- **Fact provenance:** composer facts carry `provenance`; hours a business never gave are `not_provided`.

See `docs/PAID_PILOT.md` for the owner product, revenue attribution, channels and readiness.
