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
  searchProducts,
  addToCart,
  updateCartLine,
  createCommerceCheckout,
  createCommerceOrder,
  verifyPayment,
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
  searchProducts,
  addToCart,
  updateCartLine,
  createCommerceCheckout,
  createCommerceOrder,
  verifyPayment,
];

const REGISTRY = new Map<string, AnyToolDefinition>(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AnyToolDefinition | undefined {
  return REGISTRY.get(name);
}

export function listTools(): AnyToolDefinition[] {
  return ALL_TOOLS;
}

/**
 * `toolResult.error` reaches the customer verbatim — deterministic-
 * compose's "action" case literally interpolates it into the reply
 * ("Sorry — I ran into an issue (${toolResult.error})"), and the LLM
 * reasoner is told to describe `toolError` as-is. Only a message a tool
 * deliberately threw FOR the customer belongs here; every backend error
 * (`supabase-backend.ts`'s "Failed to create booking: <raw Postgres
 * error>", a Zod schema-validation message, "Unknown tool: X") is an
 * internal implementation detail that must never reach them.
 */
const CUSTOMER_SAFE_TOOL_ERRORS = new Set<string>([
  "Slot no longer available",
  "Item sold out before this order could be fulfilled",
  "A payment request is already pending for this conversation",
  "Requested variant not available",
  "Cart is empty",
  "Cart changed after payment",
  "That item is no longer available",
]);

const GENERIC_TOOL_ERROR = "Something went wrong on our end — could we try that again in a moment?";

/** Never let an internal error message (a raw exception, a Zod validation error, a backend/API error) reach the customer — only a message a tool deliberately threw FOR them passes through unchanged. The real error is still logged server-side for debugging. */
function sanitizeToolError(rawMessage: string, context: string): string {
  if (CUSTOMER_SAFE_TOOL_ERRORS.has(rawMessage)) return rawMessage;
  console.error(`[callTool] ${context}: ${rawMessage}`);
  return GENERIC_TOOL_ERROR;
}

/** Validate input against schema, execute, validate output. Never lets a tool mutate state via raw/unvalidated input. */
export async function callTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext
): Promise<ToolCallResult> {
  const tool = getTool(name);
  if (!tool) return { ok: false, error: sanitizeToolError(`Unknown tool: ${name}`, "unknown tool") };

  const parsedInput = tool.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return {
      ok: false,
      error: sanitizeToolError(`Invalid input for ${name}: ${parsedInput.error.message}`, "invalid input"),
    };
  }

  try {
    const rawOutput = await tool.execute(parsedInput.data, ctx);
    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      return {
        ok: false,
        error: sanitizeToolError(`Invalid output for ${name}: ${parsedOutput.error.message}`, "invalid output"),
      };
    }
    return { ok: true, output: parsedOutput.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return { ok: false, error: sanitizeToolError(message, "execution error") };
  }
}
