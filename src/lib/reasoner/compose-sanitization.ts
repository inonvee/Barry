import type { ComposeResponseInput, CustomerFacingLocalDisplay, SchedulingDisplayFacts } from "./types";

type ComposeToolResult = ComposeResponseInput["toolResult"];

function sanitizeDisplay(display: CustomerFacingLocalDisplay): CustomerFacingLocalDisplay {
  return {
    localDate: display.localDate,
    localTime: display.localTime,
    timeZone: display.timeZone,
  };
}

export function sanitizeSchedulingForCompose(scheduling: SchedulingDisplayFacts | undefined): SchedulingDisplayFacts | undefined {
  if (!scheduling) return undefined;
  return {
    offeredSlot: scheduling.offeredSlot ? sanitizeDisplay(scheduling.offeredSlot) : undefined,
    availableSlots: scheduling.availableSlots?.map(sanitizeDisplay),
  };
}

function stripSchedulingTimestampsFromOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  if (Array.isArray(output)) return output.map(stripSchedulingTimestampsFromOutput);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (key === "start" || key === "end") continue;
    sanitized[key] = stripSchedulingTimestampsFromOutput(value);
  }
  return sanitized;
}

export function sanitizeToolResultForCompose(input: ComposeResponseInput): ComposeToolResult {
  const { outcome, toolResult } = input;
  if (!toolResult?.ok || outcome.kind !== "action") return toolResult;
  if (outcome.action.name !== "checkAvailability" && outcome.action.name !== "createBooking") return toolResult;

  return {
    ...toolResult,
    output: stripSchedulingTimestampsFromOutput(toolResult.output),
  };
}

export function sanitizeComposeInput(input: ComposeResponseInput): ComposeResponseInput {
  return {
    ...input,
    toolResult: sanitizeToolResultForCompose(input),
    scheduling: sanitizeSchedulingForCompose(input.scheduling),
  };
}
