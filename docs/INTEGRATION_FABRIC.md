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

## 9. What is implemented vs prepared (honest status)

**Implemented**
- Open capability contracts. Today's capabilities are migrated onto them, and
  the runtime gate and traces use capability ids.
- One connector registry and resolver. Commerce, payments and scheduling
  adapters are migrated onto it: their provider switches, the credentials
  switch, the status special cases and vendor webhook sniffing are gone from
  shared code.
- The executor, the declarative HTTP connector, conformance, the mapping
  lifecycle, and the OpenAPI import.
- Portability proofs (`__tests__/fabric-portability.test.ts`), against
  **in-process mock systems**.

**Prepared, not yet built**
- The conversation planner still plans only its existing domains (commerce,
  scheduling, payments). A new domain's capabilities are executable through
  the fabric but not yet chosen by the customer conversation. That needs a
  Genome/policy way to authorize and plan them.
- Consequential commerce steps still run through typed adapters. A
  generic-only (manifest) system in a planner domain is refused, with a
  reason, rather than half-used.
- No UI or API yet lets an owner upload a manifest or OpenAPI document; the
  lifecycle is exercised in tests.
- The `business_connections` unique `(business_id, capability)` constraint
  allows one system per domain per business. Several systems can still
  implement the same capability from different domains.
- No real external system has been connected through a manifest.
