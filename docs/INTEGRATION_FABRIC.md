# Business Stack Compiler / Universal Integration Fabric

**BARRY adapts to the business. The business does not adapt to BARRY.**

BARRY is **not** an integrations catalog and **not** a collection of
provider-specific workflows. BARRY compiles the business's existing
operational stack into a verified, executable capability model — and reasons
only in that model.

```
Business + existing systems + workflows + policies + authority
  → Learn Business / Learn Stack (owner-approved evidence)
  → system discovery → capability mapping PROPOSALS (fact / inference / recommendation)
  → validated connection contracts (manifests) → conformance → owner activation
  → Business Genome + capability map (stored connections)
  → planner / compiler  (capability ids only)
  → policy + authority
  → capability resolver  ("which active, healthy, authorized system of THIS business can do X?")
  → connector / transport → the business's system
  → verification → persistent state
```

The provider is an implementation detail of a connector.

Code: `src/lib/fabric/`.

## 1. Capabilities (`fabric/capability.ts`, `fabric/builtin.ts`)

A capability is a namespaced, versioned contract — `payments.verify`,
`commerce.cart.update`, `shipping.track`, `procurement.quote.request`,
anything. There is **no closed enum**: a new domain is a
`registerCapability(...)` call, not an edit to the planner or runtime.

A contract carries: id, semver, purpose, input and output schemas (validated
on every call), effect (`read` / `consequential`), verification
(`provider_confirmed` / `none`), idempotency (`key_required` / `none`),
authority (`policy_gated` / `none`), provenance (`barry_core` /
`business_manifest`), legacy aliases, and conformance examples.

Invariants enforced at registration: a consequential capability must be
policy-gated **and** provider-confirmed; a registered contract can't silently
change version or effect.

Today's commerce, payments, scheduling and messaging capabilities are
ordinary registrations (`builtin.ts`). The planner's actions name the
capability ids they need (`ACTION_REQUIREMENTS` in
`src/lib/capabilities/model.ts`); the runtime gate checks those ids against
what the business's connected systems provide, and each trace step records
the capability id and the system that served it.

## 2. Systems (`fabric/system.ts`)

Every business system — a first-party adapter, the business's own API, a
regional tool — is described by one **system descriptor**:

- identity, kind (`first_party` / `generic_protocol` / `custom` / `learned`),
  connector, domain, transport (typed adapter or HTTP manifest);
- capability **mappings**, each with version, lifecycle status, provenance,
  owner-verification requirement, verification time and conformance record;
- auth by **reference** only (`env:<system>:<name>`) — never a value;
- non-secret config, webhooks, rate-limit metadata, health, activation,
  simulated flag, priority, schema version, provenance.

Stored `business_connections` rows **are** the descriptors' state. A
manifest-described system keeps its manifest and mapping statuses in the
row's `config`, so no second connection architecture exists. No migration was
needed.

`publicDescriptor()` is the only projection that leaves the server. It carries
names and statuses, never credentials and never the manifest.

## 3. One registry, one resolver (`fabric/registry.ts`)

Connector factories register once:

- first-party adapters (`commerce/registry.ts`, `payments/registry.ts`,
  `scheduling/registry.ts`);
- the generic HTTP connector (`fabric/connectors/http.ts`);
- later, learned connectors.

Each factory declares its credential variable **names**, its display-safe
config keys, its setup checks, and — for inbound events — how to tell which
business an event belongs to. Vendor code lives only there.

The runtime asks exactly one question:
`resolveCapability(businessId, capabilityId)`. It answers with the
business's highest-priority system whose mapping for that capability is
**active**, or a refusal code:

`unknown_capability · no_system · mapping_not_active · system_inactive ·
system_unhealthy · simulation_not_allowed · no_connector · not_configured ·
not_supported_by_system · connector_error`

**Fail closed.** The selected system failing is a failure. Resolution never
moves on to another system, a fixture, or a simulator. Simulators (the
in-memory commerce, payments and scheduling connectors) run only in dev,
tests, or an explicitly allowed preview (`VERCEL_ENV=preview`,
`BARRY_ALLOW_SIMULATION=1`). This now also covers the legacy default payments
and scheduling simulators, which a production deployment previously could
have fallen back to.

Domain defaults (legacy single-tenant env configuration, simulator fixtures)
are ordinary descriptors registered per domain, subject to the same gates.

## 4. Execution (`fabric/executor.ts`)

`executeCapability(ctx, capability, input, { authorize })` runs these steps
in order:

1. Validate the input against the contract.
2. Require an idempotency key for writes.
3. Resolve the system.
4. Get an authority decision for consequential capabilities. **There is no
   default: without an authorizer, a write does not run.**
5. Call the connector.
6. Validate the output against the contract.
7. Treat a write as done only if the system **confirmed** it (`verified: true`
   comes from the connector's success check, never from a status code alone).

Failures keep their meaning: `invalid_input`, `idempotency_key_required`,
`not_authorized`, `requires_approval`, `provider_error` (the system's own
error), `invalid_output`, `unverified`. Every result carries provenance:
capability, contract version, system, connector, and simulated flag.

## 5. Unknown systems: declarative HTTP manifests (`fabric/http-manifest.ts`, `fabric/connectors/http.ts`)

A system BARRY has never seen is mapped by a manifest, not by code. For each
operation the manifest gives:

- the capability it implements;
- the method and relative path, with `{field}` placeholders;
- query and body wiring from contract input fields;
- response JSON pointers for each contract output field;
- for writes, the idempotency header and the **success check** — the
  response value that proves the system did it.

A manifest is untrusted data until `validateHttpManifest` accepts it. The
checks are deterministic:

- the base URL is public https (the Learn Business SSRF checks: no private or
  loopback addresses, no credentials, default ports only);
- paths are clean and relative, and placeholders are contract input fields;
- no header hijacking (Authorization, Host, Cookie, and so on);
- every contract output is mapped, and `verified` is never mapped;
- writes are never GET, and are idempotent and provider-confirmed.

At execution the connector re-validates the manifest and URL-encodes path
values. It refuses redirects, bounds size and time, and re-checks DNS at
connect time, so rebinding to a private address fails. Credentials come by
reference and are never shown to the model or the browser. **The model never
issues HTTP requests.**

## 6. Model-assisted mapping (`fabric/mapping.ts`, `fabric/model-mapper.ts`)

From owner-approved evidence BARRY proposes; it never activates. Mapping
statements come in four kinds:

| Kind | Meaning |
|---|---|
| FACT | the evidence itself declares it (an OpenAPI operation tagged `x-barry-capability`) |
| INFERENCE | a heuristic or a model suggests it. It is re-validated: only real capabilities in the requested domains, only operations the document really has. Never "high" confidence. |
| RECOMMENDATION | what the owner should provide or connect |
| EXECUTABLE | a mapping that validated, passed conformance **and** was activated by the owner |

- `importOpenApi` reads a document as untrusted data. It is size- and
  count-bounded, does no `$ref` resolution, fetches nothing, and treats no
  text as instructions.
- `draftManifest` wires only exact field-name matches and lists everything
  else as missing. For example, it will not guess which response value proves
  a write.
- `advanceMapping` is the only lifecycle path, one checked step at a time:
  - `proposed → validated`: the manifest operation validates;
  - `validated → conformance_passed`: a passing report for this capability;
  - `conformance_passed → active`: the owner's activation, recorded.
- Any mapping can be disabled at any time. Confidence never skips a step.
- `OpenAICapabilityMapper` sends the model only the structural summary
  (operation refs, names, field names) and capability ids and purposes.

## 7. Conformance (`fabric/conformance.ts`)

`runConformance` drives a connector through `invokeConnector` — the same
post-resolution code the runtime uses — and checks:

- it declares the capability;
- invalid input never reaches the system;
- output normalizes to the contract;
- writes confirm success explicitly;
- the same idempotency key returns the same result;
- server errors and rejected authorization stay failures;
- an unconfirmed write is never a success;
- unsupported capabilities are refused.

Fault checks need a harness that can make the system fail (for HTTP systems,
a sandbox or mock transport). Skipped checks never count as a pass. Run
conformance against a sandbox or mock, never a live system with real side
effects. The same suite certifies first-party adapters, e.g. the commerce
simulator's `commerce.catalog.search`.

## 8. Where model reasoning ends and deterministic authority begins

| Model (proposes) | Deterministic (decides) |
|---|---|
| what the customer means (IR) | grounding, compilation into actions |
| which API operation looks like which capability | manifest validation, conformance, owner activation |
| — | which system serves a capability (resolver) |
| — | whether a write may run (policy / authority) |
| — | whether it happened (provider confirmation) |

## 9. Capability-native planning and authority

**Let the model reason freely. Constrain its authority, not its intelligence.**

### Generic capability action (`tools/capability-tool.ts`, `runtime/compiler.ts`)

The model can propose any of the business's capabilities through one IR
field. `capabilityRequest` is `{capability, input, purpose}`; strict-mode
output sends the input as a bounded JSON object string. The compiler turns a
grounded proposal into ONE generic action, `invokeCapability`. A new domain
therefore never needs a planner branch.

Everything that makes the call safe is deterministic, and happens in this
order:

1. **Grounding** (`reasoner/verify.ts`):
   - the capability must be on THIS business's surface and executable now;
   - every input value must be something the customer said, a customer field
     BARRY holds, or a value an earlier capability result returned.

   An ungrounded value rejects the whole proposal, and the rejection is
   recorded.
2. **Contract**:
   - missing required inputs become `capability_needs_input`, so BARRY asks
     for exactly those fields;
   - the input is validated against the capability's schema.
3. **Authority**: see below. It is checked before execution, and a read needs
   an explicit rule just like a write.
4. **Idempotency**: BARRY derives the key from the business, the
   conversation, the capability and the canonical input. The model never
   supplies it, and repeating a plan repeats the same call.
5. **Execution**: `executeCapability()`. The fabric picks the business's
   system; the model never selects a provider.
6. **Verification**: a consequential call is done only when the system
   confirmed it.
7. **State**: results, with provenance, are kept (bounded) for the next
   reasoning step.
8. **Trace**: see below.

The model never gets HTTP, database access, credentials, endpoints or
connector internals.

### Capability surface (`capabilities/surface.ts`)

The capability surface is business-specific. It lists only capabilities one
of this business's systems maps **and can execute now**, each with:

- purpose;
- read or consequential;
- input names and types;
- the business's authority summary: automatic, conditional, owner approval,
  not permitted, or read-only.

It never includes systems, credentials, manifests or endpoints.

Some capabilities are left off. Those the typed flows own (cart, checkout,
payment links, bookings, and so on) are excluded, and so is every capability
of a domain the business runs through a typed flow. Those flows bind
capabilities to richer state and are not bypassed.

### Authority (`policy/authority.ts`, Business Genome `authority`)

Authority is per capability, per business, context-aware and deterministic.
Rules are bounded data, not code:

- `capability`: an exact id, or a `domain.*` wildcard;
- `effect`: `allow`, `require_approval`, or `deny`;
- `when`: conditions that must all hold. Each compares ONE top-level input
  field with a literal, using `lte`, `lt`, `gte`, `gt`, `eq`, `neq`, `in` or
  `exists`.

Among matching rules the most restrictive wins: deny, then require_approval,
then allow. A condition that can't be evaluated never grants authority, and
it always counts toward a restriction. **With no matching rule the call is
denied — reads included.** A read changes nothing in an external system, but
reading a customer record, an invoice, a contract or an internal cost is
still something the business must have authorized. Authority is never
assumed from a contract's `effect`. The fabric executor enforces the same
rule one level down: no authority decision, no call. Every decision names its
rule.

Example:

```json
[
  { "id": "credit-small", "capability": "billing.credit.issue", "effect": "allow", "when": [{ "field": "amount", "op": "lte", "value": 50 }] },
  { "id": "credit-large", "capability": "billing.credit.issue", "effect": "require_approval", "when": [{ "field": "amount", "op": "gt", "value": 50 }] }
]
```

### Approval continuation

When authority says `requires_approval`, nothing is sent. The approval is
persisted with the exact call, and the conversation pauses (`escalated`).

On the owner's approval, `resumeAfterApproval` re-runs **exactly** the
approved call with the same idempotency key. The tool first re-checks all of
the following:

- same business and conversation;
- same capability and input fingerprint;
- the approval is approved and less than 7 days old;
- current rules still permit it (a rule that now denies it wins).

The owner cannot substitute a different call. An approval resolves once, so a
second resolution is a no-op. Declined, expired, tampered and
cross-conversation approvals never execute.

### Reasoning continuation (goal-driven, bounded)

After a generic step succeeds, the model is re-asked about the same customer
message, now with the results. It may propose ONE next capability, which is
grounded, compiled and authorized like the first. For example: a delayed
shipment leads to opening a support case.

The loop stops when:

- a required input or a customer decision is missing;
- owner approval is needed;
- authority denies the call;
- the capability is unavailable or the system errors;
- the model proposes nothing new, or the same call again;
- `MAX_STEPS_PER_TURN` is reached.

### Trace (per generic step)

Each generic step records:

- the capability, the model's purpose, and the input **field names** (never
  values);
- authority: status, rule and reason;
- the resolving system, connector and contract version;
- executed, verified, and any failure code;
- the stop reason.

HQ shows the business's capability surface, its authority rules, recent
generic calls, and refusal and failure counts.

## 10. What is implemented vs prepared (honest status)

**Implemented and tested (mocked model and mocked external systems):**
- the open capability contracts, one registry and resolver, the executor,
  the manifest connector, conformance, and the mapping lifecycle;
- capability-native planning, per-capability authority, approval
  continuation, and reasoning continuation;
- the proofs in `__tests__/capability-planner.test.ts` and
  `__tests__/fabric-portability.test.ts`.

**Not live-proven:**
- No live model has been evaluated on proposing `capabilityRequest`. The
  prompt and schema exist; the model evals don't cover it yet.
- No real external system (carrier, helpdesk, ledger) has been connected
  through a manifest.

**Still specialized, by design:**
- Commerce, payments and scheduling keep their typed flows and typed tools,
  which bind carts, snapshots, slots and payment verification.
- A generic-only system in one of those domains is refused, with a reason,
  rather than half-used.

**Not built:**
- Owner UI or API to author authority rules or upload manifests. Rules live in
  the Business Genome data; the lifecycle is exercised in tests.
- One system per domain per business, from the `business_connections`
  unique constraint.
- Capability results are kept in conversation state (the last 8) and are not
  yet indexed across conversations.
