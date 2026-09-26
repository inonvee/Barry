import type { z } from "zod";
import type { BusinessGraph } from "@/lib/business-graph";

/** Execution context passed to every tool adapter. */
export type ToolContext = {
  graph: BusinessGraph;
  conversationId: string;
  customerId: string;
};

export type ToolDefinition<InputSchema extends z.ZodType, OutputSchema extends z.ZodType> = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  /** Simulated adapter execution. Real adapters (Stripe, calendars) replace this later. */
  execute: (input: z.infer<InputSchema>, ctx: ToolContext) => Promise<z.infer<OutputSchema>>;
};

export function defineTool<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  def: ToolDefinition<InputSchema, OutputSchema>
): ToolDefinition<InputSchema, OutputSchema> {
  return def;
}

export type AnyToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, ctx: ToolContext) => Promise<any>;
};

export type ToolCallResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string };
