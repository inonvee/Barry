import { AsyncLocalStorage } from "node:async_hooks";

/**
 * MODEL USAGE METER — every model call made while serving one turn is counted here (scoped per turn
 * with AsyncLocalStorage, so concurrent turns never mix). Token counts are what the PROVIDER reported;
 * nothing is guessed. Calls outside a metered scope are simply not counted.
 */
export type ModelCallRole = "reasoner" | "composer" | "checker" | "learner";

export type ModelCall = {
  model: string;
  role: ModelCallRole;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** False when the provider returned no usage block (counts are then 0 and the cost is unavailable). */
  providerReported: boolean;
  at: string;
};

const scope = new AsyncLocalStorage<ModelCall[]>();

export function meterModelCall(call: Omit<ModelCall, "at">): void {
  scope.getStore()?.push({ ...call, at: new Date().toISOString() });
}

export async function withUsageMeter<T>(fn: () => Promise<T>): Promise<{ result: T; calls: ModelCall[] }> {
  const calls: ModelCall[] = [];
  const result = await scope.run(calls, fn);
  return { result, calls };
}
