import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { ConversationBusyError, withConversationLock } from "@/lib/state/lock";
import { giveToHuman, readControl, readControlLog, readOwnerReplies } from "@/lib/runtime/control";
import { conversationIdFor, readDeliveries } from "./gateway";
import { noteEchoReceived } from "./business-numbers";
import type { BusinessEcho } from "./whatsapp";

/**
 * AUTOMATIC EMPLOYEE TAKEOVER (WhatsApp coexistence) — when someone at the business replies to a customer from the
 * WhatsApp Business app, Meta sends a signed `smb_message_echoes` webhook for that message. That echo — and ONLY that
 * echo — proves a person on the business's side wrote to that customer. BARRY then steps out of that conversation
 * (holder → human, through the SAME handoff control as every other takeover) before it can send anything else.
 *
 * Two steps, so the employee always wins a race:
 *  1. SIGNAL (lock-free, immediate, durable, idempotent by the echo's message id): written the moment the webhook
 *     arrives, even while BARRY is in the middle of a turn holding the conversation's lock. Every BARRY send path
 *     re-checks for it right before anything leaves (`takeoverBlocksSend`).
 *  2. APPLY (under the conversation's lock): the employee's message enters the transcript in time order, authored by
 *     a person (never BARRY), and the holder becomes human — once.
 *
 * Never inferred: an echo whose id is one of BARRY's own sends is ignored (Meta doesn't echo Cloud API sends; this is
 * defense in depth). An echo older than the owner's last explicit "give it back to BARRY" is history — it joins the
 * transcript but never takes the conversation again (a delayed echo can't steal it back). Meta's echo carries no
 * employee name, so BARRY says "a team member", never a guessed name.
 */

export const TEAM_MEMBER = "a team member (WhatsApp Business app)";
const KIND = "channel_identity" as const;
const PREFIX = "takeover:";

export type TakeoverSignal = BusinessEcho & { conversationId: string; receivedAt: string; applied?: { at: string; outcome: "took_over" | "already_human" | "history_only" } };

const keyOf = (conversationId: string, messageId: string) => `${PREFIX}${conversationId}:${messageId}`.slice(0, 240);

export async function listTakeoverSignals(businessId: string, conversationId?: string): Promise<TakeoverSignal[]> {
  const prefix = conversationId ? `${PREFIX}${conversationId}:` : PREFIX;
  return (await getBackend().listOperatorRecords(businessId, KIND)).filter((r) => r.key.startsWith(prefix)).map((r) => r.data as unknown as TakeoverSignal);
}

/** BARRY's own provider message ids in this conversation (customer replies, follow-ups, owner messages sent via BARRY). */
function ownProviderIds(state: ConversationState | undefined): Set<string> {
  if (!state) return new Set();
  const ids = readDeliveries(state.knownFields).map((d) => d.providerMessageId).filter((x): x is string => Boolean(x));
  for (const r of Object.values(readOwnerReplies(state))) if (r.providerMessageId) ids.push(r.providerMessageId);
  return new Set(ids);
}

/** When the conversation was last explicitly given back to BARRY ("" if never). */
function lastReturnToBarry(state: Pick<ConversationState, "knownFields">): string {
  return readControlLog(state).filter((e) => e.to === "barry").map((e) => e.at).sort().at(-1) ?? "";
}

/** Would this signal take the conversation (vs. being history only)? Pure. */
export function signalTakesOver(state: Pick<ConversationState, "knownFields">, s: Pick<TakeoverSignal, "at" | "receivedAt">): boolean {
  const back = lastReturnToBarry(state);
  // The echo's own timestamp decides: written before the owner gave the conversation back → history, not a takeover.
  // Meta's timestamps are whole seconds: within the SAME second the order is unknowable, and then the person wins.
  return !back || Math.floor(Date.parse(s.at) / 1000) >= Math.floor(Date.parse(back) / 1000);
}

export type EchoOutcome = { status: "recorded" | "duplicate" | "own_message"; conversationId: string; signal?: TakeoverSignal };

/** Step 1 — the durable signal, written immediately (no lock). Idempotent by the echo's message id. */
export async function recordEcho(echo: BusinessEcho, now = new Date()): Promise<EchoOutcome> {
  const conversationId = conversationIdFor("whatsapp", echo.businessId, echo.customer);
  const existing = (await listTakeoverSignals(echo.businessId, conversationId)).find((s) => s.messageId === echo.messageId);
  if (existing) return { status: "duplicate", conversationId, signal: existing };
  const state = await getConversationStore().get(conversationId);
  if (ownProviderIds(state).has(echo.messageId)) return { status: "own_message", conversationId };
  const signal: TakeoverSignal = { ...echo, conversationId, receivedAt: now.toISOString() };
  await getBackend().upsertOperatorRecord({ businessId: echo.businessId, kind: KIND, key: keyOf(conversationId, echo.messageId), data: signal as unknown as Record<string, unknown> });
  await noteEchoReceived(echo.businessId, echo.lineId, signal.receivedAt).catch(() => undefined);
  return { status: "recorded", conversationId, signal };
}

/** Signals not yet applied to the conversation. */
async function pending(businessId: string, conversationId: string): Promise<TakeoverSignal[]> {
  return (await listTakeoverSignals(businessId, conversationId)).filter((s) => !s.applied).sort((a, b) => a.at.localeCompare(b.at));
}

/** Is a person's takeover waiting to be applied (so BARRY must not send)? Read-only; safe anywhere. */
export async function takeoverPending(state: ConversationState): Promise<boolean> {
  return (await pending(state.businessId, state.id).catch(() => [] as TakeoverSignal[])).some((s) => signalTakesOver(state, s));
}

/**
 * Must BARRY stay quiet in this conversation right now? A person holds it, or a person's takeover is waiting to be
 * applied. Fails SAFE: if the signals can't be read, BARRY does not send.
 */
export async function takeoverBlocksSend(conversationId: string): Promise<{ blocked: boolean; reason?: string }> {
  const state = await getConversationStore().get(conversationId);
  if (!state) return { blocked: false };
  if (readControl(state).holder === "human") return { blocked: true, reason: "a person holds this conversation" };
  try {
    if (await takeoverPending(state)) return { blocked: true, reason: "a team member just replied from WhatsApp — BARRY stepped out" };
  } catch {
    return { blocked: true, reason: "who holds this conversation couldn't be confirmed" };
  }
  return { blocked: false };
}

/** Step 2 on a conversation copy the caller will save (under the lock). Returns what changed. Idempotent. */
export async function applyTakeoversTo(state: ConversationState, now = new Date()): Promise<{ applied: TakeoverSignal[]; tookOver: boolean }> {
  const list = await pending(state.businessId, state.id);
  let tookOver = false;
  const done: TakeoverSignal[] = [];
  for (const s of list) {
    // The employee's message, in time order, authored by a person — never BARRY. (Never duplicated.)
    const content = s.text ?? `(${s.type === "image" ? "a photo" : s.type === "document" ? "a file" : s.type === "audio" ? "a voice message" : `a ${s.type} message`} sent from WhatsApp)`;
    if (!state.messages.some((m) => m.role === "owner" && m.at === s.at && m.author === TEAM_MEMBER && m.content === content)) {
      const i = state.messages.findIndex((m) => Date.parse(m.at) > Date.parse(s.at));
      const msg = { role: "owner" as const, content, at: s.at, author: TEAM_MEMBER };
      if (i === -1) state.messages.push(msg);
      else state.messages.splice(i, 0, msg);
    }
    let outcome: NonNullable<TakeoverSignal["applied"]>["outcome"];
    if (!signalTakesOver(state, s)) outcome = "history_only";
    else if (readControl(state).holder === "human") outcome = "already_human";
    else {
      giveToHuman(state, TEAM_MEMBER, `a team member replied manually from the business's WhatsApp at ${s.at}, so BARRY stepped out`);
      tookOver = true;
      outcome = "took_over";
    }
    done.push({ ...s, applied: { at: now.toISOString(), outcome } });
  }
  return { applied: done, tookOver };
}

async function markApplied(signals: TakeoverSignal[]): Promise<void> {
  for (const s of signals) await getBackend().upsertOperatorRecord({ businessId: s.businessId, kind: KIND, key: keyOf(s.conversationId, s.messageId), data: s as unknown as Record<string, unknown> });
}

/**
 * Apply every pending takeover of one conversation: under its lock, on the latest copy, saved with the version
 * check, THEN the signals are marked applied (a crash between the two re-applies idempotently). Creates the
 * conversation when the employee wrote first (it starts held by the person).
 */
export async function applyPendingTakeovers(businessId: string, conversationId: string, customerId: string, opts: { waitMs?: number; now?: Date } = {}): Promise<{ applied: number; tookOver: boolean }> {
  return withConversationLock(
    conversationId,
    async () => {
      if (!(await pending(businessId, conversationId)).length) return { applied: 0, tookOver: false };
      const store = getConversationStore();
      const state = await store.getOrCreate(conversationId, businessId, customerId);
      const r = await applyTakeoversTo(state, opts.now);
      await store.save(state);
      await markApplied(r.applied);
      return { applied: r.applied.length, tookOver: r.tookOver };
    },
    { waitMs: opts.waitMs ?? 20_000 }
  );
}

/** Mark signals applied after the CALLER saved the conversation it applied them to (already under the lock). */
export async function commitAppliedTakeovers(signals: TakeoverSignal[]): Promise<void> {
  await markApplied(signals);
}

/**
 * The webhook's job for a batch of echoes: record every signal FIRST (so any BARRY send in flight sees it), then
 * apply each conversation's. `retry: true` when a conversation stayed busy past the wait — the signal is already
 * durable (BARRY can't send over it); Meta's redelivery applies it (idempotently).
 */
export async function handleEchoes(echoes: BusinessEcho[], opts: { waitMs?: number; now?: Date } = {}): Promise<{ results: (EchoOutcome & { applied?: boolean })[]; retry: boolean }> {
  const results: (EchoOutcome & { applied?: boolean })[] = [];
  for (const e of echoes) results.push(await recordEcho(e, opts.now));
  let retry = false;
  const seen = new Set<string>();
  for (const [i, e] of echoes.entries()) {
    const r = results[i];
    if (r.status === "own_message" || seen.has(r.conversationId)) continue;
    seen.add(r.conversationId);
    try {
      await applyPendingTakeovers(e.businessId, r.conversationId, `wa:${e.customer}`, opts);
      r.applied = true;
    } catch (err) {
      if (!(err instanceof ConversationBusyError)) throw err;
      retry = true;
    }
  }
  return { results, retry };
}

/** Remove signals (QA cleanup). */
export async function deleteTakeoverSignals(businessId: string, conversationId: string): Promise<number> {
  const keys = (await getBackend().listOperatorRecords(businessId, KIND)).filter((r) => r.key.startsWith(`${PREFIX}${conversationId}:`)).map((r) => r.key);
  return keys.length ? getBackend().deleteOperatorRecords(businessId, KIND, keys) : 0;
}
