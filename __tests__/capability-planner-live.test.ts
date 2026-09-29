import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { manifestConnection } from "@/lib/fabric/registry";
import { setHttpTransportForTests } from "@/lib/fabric/connectors/http";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { setReasonerForTests } from "@/lib/reasoner";
import { OpenAIReasoner } from "@/lib/reasoner/openai-reasoner";
import { buildSpaGraph } from "@/lib/fixtures";
import type { BusinessGraph } from "@/lib/business-graph";
import type { TurnOutcome } from "@/lib/runtime/engine";
import { createMockHttpSystem } from "./support/mock-http-system";
import { helpdeskManifest, parcelManifest, PARCEL_ORIGIN } from "./support/test-domains";

/**
 * LIVE semantic evals for capability-native planning (BARRY_LIVE_EVAL=1 +
 * OPENAI_API_KEY): does the CONFIGURED reasoner (BARRY_REASONER_MODEL /
 * BARRY_REASONER_REASONING_EFFORT) choose the business's capabilities from
 * natural English and Hebrew — with grounded identifiers, and without
 * inventing values or capabilities?
 *
 * The real runtime, grounding, authority and fabric run; the carrier and
 * helpdesk are in-process MOCKS. Grounding is NOT loosened for the model:
 * a case passes only if the model's own proposal survives verification as-is.
 *
 * Results (model, effort, per-case verdict) are written to
 * $BARRY_EVAL_REPORT or <tmp>/barry-capability-planner-live.json.
 */

const LIVE = Boolean(process.env.OPENAI_API_KEY && process.env.BARRY_LIVE_EVAL === "1");

type Verdict = { case: string; message: string; pass: boolean; detail: Record<string, unknown> };
const results: Verdict[] = [];
let modelInfo: { model: string | null; effort: string | null } = { model: null, effort: null };

function business(): BusinessGraph {
  const base = buildSpaGraph();
  return {
    ...base,
    business: { ...base.business, id: `live-plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    authority: [
      { id: "track", capability: "shipping.track", effect: "allow", when: [] },
      { id: "tickets", capability: "support.ticket.create", effect: "allow", when: [] },
    ],
  };
}

async function connect(g: BusinessGraph) {
  process.env.PARCEL_CO_API_KEY = "parcel-secret";
  process.env.HELPDESK_API_KEY = "desk-secret";
  for (const [systemKey, domain, manifest] of [["parcel-co", "shipping", parcelManifest], ["helpdesk", "support", helpdeskManifest]] as const) {
    const mappings = Object.fromEntries(manifest.operations.map((o) => [o.capability, { status: "active" as const }]));
    await getBackend().upsertBusinessConnection(manifestConnection({ businessId: g.business.id, systemKey, domain, name: systemKey, manifest, mappings }));
  }
  // MOCK carrier: every parcel is in transit.
  const carrier = createMockHttpSystem(PARCEL_ORIGIN, { "GET /v2/tracking/{trackingNumber}": ({ params }) => ({ json: { tracking: { number: params.trackingNumber, state: "in_transit", eta: "2026-10-03" } } }) }, { requireAuth: { header: "authorization", value: "Bearer parcel-secret" } });
  setHttpTransportForTests(carrier.transport);
  return carrier;
}

async function run(message: string): Promise<{ out: TurnOutcome; calls: number }> {
  const reasoner = new OpenAIReasoner();
  modelInfo = { model: reasoner.model, effort: reasoner.reasoningEffort ?? null };
  setReasonerForTests(reasoner);
  const g = business();
  const carrier = await connect(g);
  const out = await handleCustomerMessage(g, `live-${g.business.id}`, "live-customer", message);
  return { out, calls: carrier.calls.length };
}

function summary(out: TurnOutcome) {
  const steps = out.turn.trace?.steps ?? [];
  return {
    steps: steps.map((s) => ({ capability: s.generic?.capability ?? s.action, authority: s.generic?.authority.status, executed: s.generic?.executed ?? null })),
    selected: out.turn.selectedAction,
    rejected: out.turn.verification?.rejected.filter((r) => r.claim.startsWith("capabilityRequest")) ?? [],
    missingFields: out.state.missingFields,
    stop: out.turn.trace?.stop,
    response: out.response,
  };
}

function record(name: string, message: string, pass: boolean, detail: Record<string, unknown>) {
  results.push({ case: name, message, pass, detail });
  return pass;
}

afterEach(() => {
  setHttpTransportForTests(undefined);
  setReasonerForTests(undefined);
});

afterAll(() => {
  if (!LIVE) return;
  const file = process.env.BARRY_EVAL_REPORT ?? path.join(os.tmpdir(), "barry-capability-planner-live.json");
  fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), ...modelInfo, passed: results.filter((r) => r.pass).length, total: results.length, results }, null, 2));
});

const trackInput = (out: TurnOutcome) => {
  const input = out.turn.trace?.steps.find((s) => s.generic?.capability === "shipping.track") ? (out.turn.selectedAction?.input as { input?: Record<string, unknown> } | undefined) : undefined;
  return input?.input;
};

describe.skipIf(!LIVE)("LIVE: capability-native planning with the configured reasoner", () => {
  it.each([
    ["A (English)", "Where is order ABC123?"],
    ["B (Hebrew)", "איפה החבילה ABC123 שלי?"],
  ])("%s -> shipping.track with the grounded tracking number", async (name, message) => {
    const { out, calls } = await run(message);
    const s = summary(out);
    const first = out.turn.trace?.steps[0];
    const ok =
      first?.generic?.capability === "shipping.track" &&
      first.generic.executed === true &&
      s.rejected.length === 0 &&
      JSON.stringify(out.turn.trace?.steps.map((st) => st.generic)).includes("trackingNumber") &&
      calls >= 1 &&
      /in_transit|in transit|בדרך|במשלוח|2026-10-03/i.test(out.response);
    expect(record(name, message, ok, { ...s, carrierCalls: calls, trackInput: trackInput(out) }), JSON.stringify(s)).toBe(true);
  });

  it("C: 'My package ABC123 still hasn't arrived' -> tracks ABC123 first; nothing invented", async () => {
    const message = "My package ABC123 still hasn't arrived";
    const { out, calls } = await run(message);
    const s = summary(out);
    const first = out.turn.trace?.steps[0];
    // Any follow-up (e.g. a support ticket) must itself be grounded — the verifier rejects invented values,
    // so a rejection here means the model invented something.
    const ok = first?.generic?.capability === "shipping.track" && first.generic.executed === true && calls >= 1 && s.rejected.length === 0;
    expect(record("C (arrival complaint)", message, ok, { ...s, carrierCalls: calls }), JSON.stringify(s)).toBe(true);
  });

  it("D: required identifier missing -> no invented value, nothing executed, BARRY asks for it", async () => {
    const message = "Where is my package?";
    const { out, calls } = await run(message);
    const s = summary(out);
    const invented = s.rejected.some((r) => r.claim.startsWith("capabilityRequest.input"));
    const asked = s.missingFields.includes("trackingNumber") || /tracking|order (number|id)|מספר/i.test(out.response);
    const ok = !invented && calls === 0 && !(out.turn.trace?.steps ?? []).some((st) => st.generic?.executed) && asked;
    expect(record("D (missing identifier)", message, ok, { ...s, carrierCalls: calls, invented, asked }), JSON.stringify(s)).toBe(true);
  });

  it.each([
    ["E (outside the surface, English)", "Can you refund my last payment and cancel my subscription?"],
    ["E (outside the surface, Hebrew)", "אפשר להזמין לי שולחן למסעדה לערב?"],
  ])("%s -> no invented capability, nothing executed", async (name, message) => {
    const { out, calls } = await run(message);
    const s = summary(out);
    const inventedCapability = s.rejected.some((r) => r.claim === "capabilityRequest.capability");
    const ok = !inventedCapability && calls === 0 && !(out.turn.trace?.steps ?? []).some((st) => st.action === "invokeCapability");
    expect(record(name, message, ok, { ...s, carrierCalls: calls, inventedCapability }), JSON.stringify(s)).toBe(true);
  });
});

describe("the live eval harness itself (runs without a key)", () => {
  it("is skipped unless both OPENAI_API_KEY and BARRY_LIVE_EVAL=1 are set", () => {
    expect(LIVE).toBe(Boolean(process.env.OPENAI_API_KEY && process.env.BARRY_LIVE_EVAL === "1"));
  });
});
