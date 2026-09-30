import { MockReasoner } from "@/lib/reasoner/mock-reasoner";
import type { BarryIR, ComposeResponseInput, Reasoner, ReasonerContext } from "@/lib/reasoner/types";

/**
 * QA scripted reasoner: the exact IR a competent model would produce for each scripted customer
 * message, so a scenario reaches the same acceptance state on every deployment. Unscripted messages
 * fall back to the offline simulator. Replies are composed deterministically.
 */
export class QaScriptedReasoner implements Reasoner {
  readonly name = "llm" as const;
  readonly model = "qa-scripted";
  private readonly fallback = new MockReasoner();
  constructor(private readonly script: Record<string, Partial<BarryIR>>) {}

  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const scripted = this.script[ctx.customerMessage];
    if (!scripted) return this.fallback.understand(ctx);
    return { intent: "qa_scripted", entities: {}, constraints: {}, customerInfo: {}, ...structuredClone(scripted) } as BarryIR;
  }

  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    return this.fallback.composeResponse(ctx, input);
  }
}
