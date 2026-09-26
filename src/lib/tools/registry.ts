import type { AnyToolDefinition, ToolCallResult, ToolContext } from "./types";
import {
  checkAvailability,
  createBooking,
  checkInventory,
  createPaymentRequest,
  requestApproval,
  createFollowUp,
  createLead,
  sendMedia,
  fulfillOrder,
} from "./definitions";

const ALL_TOOLS: AnyToolDefinition[] = [
  checkAvailability,
  createBooking,
  checkInventory,
  createPaymentRequest,
  requestApproval,
  createFollowUp,
  createLead,
  sendMedia,
  fulfillOrder,
];

const REGISTRY = new Map<string, AnyToolDefinition>(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AnyToolDefinition | undefined {
  return REGISTRY.get(name);
}

export function listTools(): AnyToolDefinition[] {
  return ALL_TOOLS;
}

/** Validate input against schema, execute, validate output. Never lets a tool mutate state via raw/unvalidated input. */
export async function callTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext
): Promise<ToolCallResult> {
  const tool = getTool(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

  const parsedInput = tool.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return { ok: false, error: `Invalid input for ${name}: ${parsedInput.error.message}` };
  }

  try {
    const rawOutput = await tool.execute(parsedInput.data, ctx);
    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      return { ok: false, error: `Invalid output for ${name}: ${parsedOutput.error.message}` };
    }
    return { ok: true, output: parsedOutput.data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Tool execution failed" };
  }
}
