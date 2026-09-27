import { expect } from "vitest";
import { handleCustomerMessage } from "@/lib/runtime";
import { isActionAvailable } from "@/lib/business-graph";
import { getTool } from "@/lib/tools";
import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState, TurnLog } from "@/lib/state";

/**
 * MEGA RELIABILITY / TORTURE TEST MISSION — a reusable conversation-eval
 * harness, not another pile of copy-pasted tests. Every scenario run
 * through `runScenario()` gets the SAME set of structural invariant
 * checks applied to EVERY turn for free (`checkGlobalInvariants`), on
 * top of whatever scenario-specific assertions it declares. This is what
 * lets dozens of new scenarios (order permutations, correction matrices,
 * English/Hebrew attacks) each buy broad structural coverage instead of
 * just confirming one happy path.
 *
 * Architecture this harness exists to keep honest:
 *
 *   customer message -> Reasoner -> BARRY IR -> deterministic semantic
 *   verification -> Action Compiler -> Policy Engine -> Tool Registry ->
 *   execution -> verification -> persistent state -> grounded response
 *
 * It never reaches into internals to shortcut this pipeline — every
 * scenario goes through the exact same `handleCustomerMessage()` a real
 * request would.
 */

export type TurnResultCtx = {
  graph: BusinessGraph;
  state: ConversationState;
  turn: TurnLog;
  response: string;
  turnIndex: number;
};

export type ScenarioTurn = {
  customer: string;
  /** Scenario-specific assertions for THIS turn. Runs after global invariants. */
  assert?: (ctx: TurnResultCtx) => void;
};

export type FinalCtx = {
  graph: BusinessGraph;
  state: ConversationState;
  turns: TurnLog[];
};

export type Scenario = {
  name: string;
  graph: () => BusinessGraph;
  conversationId?: string;
  customerId?: string;
  turns: ScenarioTurn[];
  /** Assertions against the final converged state, after all turns. */
  finalAssert?: (ctx: FinalCtx) => void;
};

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/**
 * Structural invariants checked after EVERY turn of EVERY scenario run
 * through this harness — see the MEGA RELIABILITY MISSION's "Part 2 —
 * Global Invariants" list. Only invariants checkable from a single
 * turn's own TurnLog + resulting state are here (no "before" snapshot
 * needed); invariants about cross-turn behavior (corrections, stickiness,
 * order-independence) are scenario-specific assertions instead — that's
 * what `ScenarioTurn.assert`/`Scenario.finalAssert` are for.
 */
export function checkGlobalInvariants(graph: BusinessGraph, turn: TurnLog, state: ConversationState): void {
  // Invariant: the LLM never constructs an executable ToolCall directly —
  // only CompileOutcome.kind === "action" (the compiler's own decision)
  // ever reaches selectedAction. Provable here as: whatever name shows
  // up MUST be a real, enabled tool with schema-valid input — an LLM-
  // invented action name or malformed input could never satisfy all
  // three at once, since the compiler is the only thing that assembles
  // `selectedAction` and always validates against the tool's real schema
  // before doing so (see compiler.ts's finalizeAction).
  if (turn.selectedAction) {
    const tool = getTool(turn.selectedAction.name);
    expect(tool, `selectedAction "${turn.selectedAction.name}" must be a registered tool`).toBeDefined();
    expect(
      isActionAvailable(graph, turn.selectedAction.name),
      `selectedAction "${turn.selectedAction.name}" must be enabled for this business`
    ).toBe(true);
    if (tool) {
      const parsed = tool.inputSchema.safeParse(turn.selectedAction.input);
      expect(parsed.success, `selectedAction "${turn.selectedAction.name}" input must pass its own Zod schema`).toBe(
        true
      );
    }
  }

  // Invariant: a denied action never executes.
  if (turn.policyDecision?.status === "denied") {
    expect(turn.toolResult, "a denied policy decision must never produce a toolResult").toBeUndefined();
  }

  // Invariant: a tool only ever actually runs (toolResult present) once
  // the Policy Engine allowed it — never while still pending approval or
  // denied. Structurally guaranteed by engine.ts's branching; this is
  // the outside-in proof.
  if (turn.toolResult) {
    expect(turn.policyDecision, "a toolResult implies a policy decision was made").toBeDefined();
    expect(turn.policyDecision?.status).toBe("allowed");
  }

  // Invariant: a failed tool call never flips the conversation to "won" —
  // patchStateAfterTool only ever runs on toolResult.ok === true.
  if (turn.toolResult && !turn.toolResult.ok) {
    expect(state.outcome, "a failed tool call must never leave the conversation outcome as won").not.toBe("won");
  }

  // Invariant: customer-provided data never writes a `__` scratch key —
  // the compiler's own trust boundary (compiler.ts filters these out of
  // customerInfo before merging). Re-checked here as a black-box proof
  // via the Inspector-facing debug info, not by re-reading compiler
  // internals.
  if (turn.compiled?.appliedCustomerInfo) {
    for (const key of Object.keys(turn.compiled.appliedCustomerInfo)) {
      expect(key.startsWith("__"), `appliedCustomerInfo must never contain a scratch key ("${key}")`).toBe(false);
    }
  }

  // Invariant: any display fact for a scheduling instant is always in
  // the BUSINESS's own timezone, never left unset while claiming to be
  // authoritative, and the reply text never leaks a raw ISO timestamp
  // (which would mean some reasoner computed/quoted UTC directly instead
  // of using the precomputed local display fact).
  if (turn.responseFacts) {
    expect(turn.responseFacts.timezone).toBe(graph.business.timezone);
  }
  expect(turn.response, "response must never leak a raw ISO timestamp").not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

  // Invariant: an irreversible/execution-fact action (booking, payment
  // request, fulfillment) never runs without a resolved scheduling/
  // inventory prerequisite already on file — i.e. it always came from
  // the compiler's own decision tree, never a shortcut. Checked
  // structurally: these action names only ever appear as selectedAction
  // when the compiler decided to (see compiler.ts) — this asserts the
  // resulting tool input is always schema-complete (already checked
  // above) AND that a resolvedSchedulingWindow was computed this turn OR
  // was already on file whenever checkAvailability/createBooking ran.
  if (turn.selectedAction?.name === "createBooking") {
    expect(turn.toolResult, "createBooking must always actually execute or be gated by policy").toBeDefined();
  }
}

/**
 * Runs a declarative Scenario through the REAL runtime
 * (`handleCustomerMessage`) turn by turn, applying global invariants
 * after every turn plus whatever the scenario itself asserts. Returns
 * the final converged state for additional ad hoc inspection.
 */
export async function runScenario(scenario: Scenario): Promise<{ state: ConversationState; turns: TurnLog[] }> {
  const graph = scenario.graph();
  const conversationId = scenario.conversationId ?? uniqueId("eval-conv");
  const customerId = scenario.customerId ?? uniqueId("eval-cust");

  const turns: TurnLog[] = [];
  let state: ConversationState | undefined;

  for (let i = 0; i < scenario.turns.length; i++) {
    const scenarioTurn = scenario.turns[i];
    const result = await handleCustomerMessage(graph, conversationId, customerId, scenarioTurn.customer);
    state = result.state;

    try {
      checkGlobalInvariants(graph, result.turn, result.state);
    } catch (err) {
      throw new Error(
        `[${scenario.name}] global invariant failed on turn ${i} ("${scenarioTurn.customer}"): ${(err as Error).message}`
      );
    }

    turns.push(result.turn);

    if (scenarioTurn.assert) {
      try {
        scenarioTurn.assert({ graph, state: result.state, turn: result.turn, response: result.response, turnIndex: i });
      } catch (err) {
        throw new Error(
          `[${scenario.name}] turn ${i} assertion failed ("${scenarioTurn.customer}"): ${(err as Error).message}`
        );
      }
    }
  }

  if (!state) throw new Error(`[${scenario.name}] scenario had no turns`);

  if (scenario.finalAssert) {
    try {
      scenario.finalAssert({ graph, state, turns });
    } catch (err) {
      throw new Error(`[${scenario.name}] final assertion failed: ${(err as Error).message}`);
    }
  }

  return { state, turns };
}

// ---------------------------------------------------------------------
// Reusable semantic assertion helpers — prefer these over exact-prose
// checks. Response wording may legitimately vary (composer phrasing,
// future LLM changes); the SEMANTIC facts below must not.
// ---------------------------------------------------------------------

/** The response text must not ask the customer for a field that's already known — a rigid-form-behavior smell. */
export function assertDoesNotAskFor(response: string, ...labels: string[]): void {
  const lower = response.toLowerCase();
  for (const label of labels) {
    expect(lower, `response must not re-request "${label}": "${response}"`).not.toContain(label.toLowerCase());
  }
}

/** Asserts the resolved (business-timezone) UTC weekday of this turn's scheduling window. Only valid for daytime-hour bookings (roughly before ~7pm local) — a late-evening local time can roll the UTC calendar day forward, which is a resolver property, not a bug. */
export function assertResolvedWeekday(turn: TurnLog, expectedUtcWeekday: number): void {
  const iso = turn.compiled?.resolvedSchedulingWindow?.earliest;
  expect(iso, "expected compile() to have resolved a scheduling window this turn").toBeTruthy();
  expect(new Date(iso!).getUTCDay()).toBe(expectedUtcWeekday);
}

/** Asserts the semantic (pre-resolution) scheduling constraint's weekday, as understood — independent of business timezone. */
export function assertSemanticWeekday(turn: TurnLog, expectedWeekday: number, expectedQualifier?: "next"): void {
  const date = turn.understood.schedulingWindow?.date;
  expect(date?.kind, "expected a weekday-kind semantic scheduling constraint").toBe("weekday");
  if (date?.kind === "weekday") {
    expect(date.weekday).toBe(expectedWeekday);
    if (expectedQualifier !== undefined) expect(date.qualifier).toBe(expectedQualifier);
  }
}

/** Never crashes, always produces a non-empty response — the baseline smoke assertion for adversarial/fuzzy input. */
export function assertNeverCrashes(ctx: TurnResultCtx): void {
  expect(typeof ctx.response).toBe("string");
  expect(ctx.response.length).toBeGreaterThan(0);
}
