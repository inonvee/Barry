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

/** Links, media and internal fingerprints are rendered/handled by the channel — the text composer never sees them, so it can't paste them. */
const CHANNEL_ONLY_KEYS = new Set(["url", "media", "checkoutUrl", "imageUrl", "snapshotHash", "idempotencyKey", "providerPaymentId"]);

function stripChannelOnlyFields(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  if (Array.isArray(output)) return output.map(stripChannelOnlyFields);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (CHANNEL_ONLY_KEYS.has(key)) continue;
    sanitized[key] = stripChannelOnlyFields(value);
  }
  return sanitized;
}

export function sanitizeToolResultForCompose(input: ComposeResponseInput): ComposeToolResult {
  const { outcome, toolResult } = input;
  if (!toolResult?.ok || outcome.kind !== "action") return toolResult;
  const withoutChannelFields = stripChannelOnlyFields(toolResult.output);
  if (outcome.action.name !== "checkAvailability" && outcome.action.name !== "createBooking") {
    return { ...toolResult, output: withoutChannelFields };
  }

  return {
    ...toolResult,
    output: stripSchedulingTimestampsFromOutput(withoutChannelFields),
  };
}

export function sanitizeComposeInput(input: ComposeResponseInput): ComposeResponseInput {
  return {
    ...input,
    toolResult: sanitizeToolResultForCompose(input),
    scheduling: sanitizeSchedulingForCompose(input.scheduling),
  };
}
