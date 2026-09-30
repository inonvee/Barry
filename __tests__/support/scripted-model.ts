import { getBackend } from "@/lib/store";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import type { BarryIR, ComposeResponseInput, ModelCallFailure, Reasoner, ReasonerContext, UnderstandingResult } from "@/lib/reasoner";
import type { BusinessGraph } from "@/lib/business-graph";

/**
 * A scripted "model" for runtime tests: the plan returns the IR a model would (or "FAIL" for an
 * unavailable provider), the writer returns what a composer would say. Everything else — grounding,
 * compiling, authority, execution, ledger, reply checks — is the real runtime.
 */
export const RATE_LIMITED: ModelCallFailure = { kind: "provider_rate_limited", status: 429, code: "rate_limit_exceeded", message: "Rate limit reached for requests", transient: true };
export const QUOTA_EXHAUSTED: ModelCallFailure = { kind: "provider_quota_exhausted", status: 429, code: "insufficient_quota", message: "You exceeded your current quota", transient: false };

export type Plan = Partial<BarryIR> | "FAIL" | undefined;

export class ScriptedModel implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "scripted";
  failure: ModelCallFailure = RATE_LIMITED;
  calls = 0;
  constructor(
    public plan: (ctx: ReasonerContext) => Plan,
    public write: (input: ComposeResponseInput) => string = composeDeterministic,
    public composerFails = false
  ) {}
  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    return (await this.understandDetailed(ctx)).ir;
  }
  async understandDetailed(ctx: ReasonerContext): Promise<UnderstandingResult> {
    this.calls++;
    const p = this.plan(ctx);
    const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
    if (p === "FAIL") return { ir: { intent: "understanding_failed", entities: {}, constraints: {}, customerInfo: {} }, valid: false, attempts: 1, failure: this.failure, latencyMs: 3, usage, model: this.model };
    const q = p ?? {};
    return { ir: { intent: "scripted", entities: {}, customerInfo: {}, ...q, constraints: { ...(q.constraints ?? {}) } } as BarryIR, valid: true, attempts: 1, latencyMs: 3, usage, model: this.model };
  }
  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    if (this.composerFails) {
      ctx.diagnostics?.composerFailures.push(this.failure);
      return composeDeterministic(input);
    }
    return this.write(input);
  }
}

let n = 0;
export const conv = (p: string) => `t-${p}-${Date.now()}-${n++}`;
export const approvalsOf = async (g: BusinessGraph, id: string) => (await getBackend().listApprovals(g.business.id)).filter((a) => a.conversationId === id);

/** A fresh, isolated fashion-retailer tenant with an in-memory store and payments. */
export function isolatedRetailer(): { g: BusinessGraph; commerce: MemoryCommerceAdapter; dispose: () => void } {
  const id = `t-rina-${Date.now()}-${n++}`;
  const commerce = new MemoryCommerceAdapter(fashionCatalog());
  registerCommerceAdapterFactoryForTests(id, () => commerce);
  setPaymentAdapterForTests(new MemoryPaymentAdapter());
  const base = buildFashionRetailerGraph();
  return {
    g: { ...base, business: { ...base.business, id } },
    commerce,
    dispose: () => {
      registerCommerceAdapterFactoryForTests(id, undefined);
      setPaymentAdapterForTests(undefined);
    },
  };
}

export const ticket = (reference: string, reason = "delivery_delay") => ({ capabilityRequest: { capability: "support.ticket.create", input: { reference, reason }, purpose: "case" }, advancesTransaction: true });
