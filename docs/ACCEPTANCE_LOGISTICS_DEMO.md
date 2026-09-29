# Manual acceptance: generic capability planner (Barry Logistics Demo)

**Barry Logistics Demo — SIMULATED** is a preview/demo fixture, not a real
business. Its carrier and helpdesk are in-process **DEMO MOCKS** registered as
simulated connectors in the Fabric. Everything else is the real BARRY runtime:

- the configured reasoner;
- grounding and compilation;
- per-capability authority and approvals;
- Fabric resolution and execution;
- verification, state and traces.

The fixture exists only where simulation is allowed: dev, tests, or a Vercel
**Preview**. A production deployment neither lists nor loads it.

## Setup
- Use a Preview deployment with the real reasoner configured:
  - `BARRY_REASONER=openai`
  - `OPENAI_API_KEY`
  - `BARRY_REASONER_MODEL` and `BARRY_REASONER_REASONING_EFFORT` as desired.
- Open `/simulator` and choose **Barry Logistics Demo — SIMULATED**. Keep the
  Inspector and Approvals panels open.
- Check the Inspector's *Models & runtime* card: it shows the reasoner model
  and effort that actually ran.

## What the business exposes
| Capability | Kind | Authority rule |
|---|---|---|
| `shipping.track` | read | `demo-track-allowed` → allow |
| `support.ticket.create` | write | `demo-tickets-need-approval` → require approval |

**DEMO MOCK carrier:**

| Tracking number | Status | ETA |
|---|---|---|
| `ABC123` | delayed | 2026-10-03 |
| `XYZ789` | in_transit | 2026-10-01 |
| `DEF456` | delivered | — |
| anything else | not_found | — |

**DEMO MOCK helpdesk:**
- ticket ids start at `T-1001`;
- one ticket per idempotency key;
- it explicitly confirms every ticket it creates.

## Flows and what to check in the Inspector

**A. English read: "Where is package ABC123?"**
- *Understanding → Capability request*: `shipping.track`, grounded,
  `trackingNumber="ABC123"`.
- *Operator steps*:
  - step 1 is `invokeCapability`;
  - authority is allowed, rule `demo-track-allowed`;
  - system is `demo-mock-carrier` (simulated);
  - executed.
- The reply describes "delayed" and the ETA.

**B. Hebrew read: "איפה החבילה ABC123 שלי?"**
Same as A. The reply is in Hebrew.

**C. Missing input: "Where is my package?" / "איפה החבילה שלי?"**
- No step is executed.
- *Reply contract → Missing fields* lists `trackingNumber`, and BARRY asks for
  the number.
- If the model invented one, *Capability request* shows **rejected** and
  nothing runs.

**D. Out-of-surface: e.g. "Refund my last payment" / "תזמין לי שולחן למסעדה"**
- There is no executed capability step.
- Any proposal is **rejected** as "not a capability of this business".

**E. Cross-domain: "My package ABC123 still hasn't arrived" (or Hebrew)**
- Step 1: `shipping.track`, executed; the result is `delayed`.
- Step 2 (*continuation*): `support.ticket.create`. It is a proposal from the
  model, not runtime code. Its authority is `requires_approval` (rule
  `demo-tickets-need-approval`), and it is **not executed**.
- The stop reason is `owner_approval_required`.
- In *Approvals*: `support.ticket.create (capability call)` is pending with the
  exact input. Approve it.
- The approval turn shows:
  - trigger `approval`;
  - executed and **provider-verified**;
  - system `demo-mock-helpdesk`;
  - the reply names `T-1001`.
- Approving again does nothing, so there is still exactly one ticket.

## Caveats
- The helpdesk mock lives in process memory. A new server instance on a
  serverless Preview starts again at `T-1001`.
- The carrier data is fixed.
