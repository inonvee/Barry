# BARRY

BARRY is a universal AI business operator: it learns how a business
works, talks to customers, makes policy-bound decisions, performs
approved actions, and involves the owner only when necessary.

This is Phase 1: proving the core architecture. One runtime, driven
entirely by structured business data (the **Business Graph**), operates
five structurally different test businesses — a massage spa, an
ecommerce bag store, a garage, a personal trainer, and a furniture store
— with no per-industry code.

## Start here

- `docs/ARCHITECTURE.md` — folder structure, the runtime loop, why the
  reasoner is deterministic in Phase 1.
- `docs/BUSINESS_GRAPH.md` — the data model every business is described by.
- `docs/BARRY_RUNTIME.md` — Observe→Understand→...→Update in detail.
- `docs/DEPLOYMENT.md` — how this gets a live URL.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 — it redirects to `/simulator`, the
engineering cockpit: pick a test business, chat as the customer, and
inspect BARRY's reasoning, policy decisions, tool calls, and pending
owner approvals in real time.

## Quality gates

```bash
npm run lint
npx tsc --noEmit
npm run test
npm run build
```
