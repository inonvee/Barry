import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/store/supabase-client";

/**
 * CONVERSATION LOCK — one writer per conversation at a time, across every server instance.
 *
 * A lease in the database (conversation_locks, migration 0019): acquiring is one atomic statement
 * (insert, or take over a lease that has EXPIRED), releasing deletes only the holder's own lease. A
 * holder that dies leaves a lease that expires on its own (TTL), never a permanent block. Different
 * conversations never wait on each other.
 *
 * The lock is re-entrant within one request (AsyncLocalStorage): a turn that runs under the inbound
 * gateway's lock and then resumes the same conversation doesn't deadlock on itself.
 *
 * The lock serializes the work; the version check on save (ConversationStore.save) is the backstop —
 * if a lease ever lapses mid-work and another writer gets in, the late save fails instead of overwriting.
 */

export const LOCK_TTL_MS = 120_000;

export class ConversationBusyError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} is being worked on by another request; try again`);
    this.name = "ConversationBusyError";
  }
}

export interface LockStore {
  /** Atomically take the lease if it is free, expired, or already ours. */
  tryAcquire(conversationId: string, holder: string, ttlMs: number): Promise<boolean>;
  release(conversationId: string, holder: string): Promise<void>;
  /** Resolves when the lease may have become free (or after `ms`). Never decides anything itself. */
  waitForChange(conversationId: string, ms: number): Promise<void>;
}

export class MemoryLockStore implements LockStore {
  private leases = new Map<string, { holder: string; expiresAt: number }>();
  private waiters = new Map<string, Set<() => void>>();
  now: () => number = () => Date.now();

  async tryAcquire(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    const cur = this.leases.get(conversationId);
    if (cur && cur.holder !== holder && cur.expiresAt > this.now()) return false;
    this.leases.set(conversationId, { holder, expiresAt: this.now() + ttlMs });
    return true;
  }

  async release(conversationId: string, holder: string): Promise<void> {
    if (this.leases.get(conversationId)?.holder === holder) this.leases.delete(conversationId);
    const ws = this.waiters.get(conversationId);
    this.waiters.delete(conversationId);
    for (const w of ws ?? []) w();
  }

  waitForChange(conversationId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(conversationId) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      this.waiters.set(conversationId, set);
    });
  }

  /** Tests: who holds a conversation's lease right now. */
  holderOf(conversationId: string): string | undefined {
    const cur = this.leases.get(conversationId);
    return cur && cur.expiresAt > this.now() ? cur.holder : undefined;
  }

  reset(): void {
    this.leases.clear();
  }
}

/** PostgREST "function not found" — migration 0019 isn't applied. */
const missingFunction = (e: { code?: string; message?: string } | null) => Boolean(e && (e.code === "PGRST202" || e.code === "42883" || /function .* does not exist|Could not find the function/i.test(e.message ?? "")));

let guardMissingLogged = false;
/** Loud, once: running without the database concurrency guard is a deployment error. */
export function reportGuardMissing(what: string): void {
  if (guardMissingLogged) return;
  guardMissingLogged = true;
  console.error(`[barry:concurrency] ${what} — migration 0019 (conversation concurrency guard) is NOT applied. Conversations are NOT protected against concurrent writes. Apply it before any real customer traffic.`);
}

export class SupabaseLockStore implements LockStore {
  /** null = unknown, false = migration 0019 missing (fall back to in-process locking, loudly). */
  installed: boolean | null = null;
  private local = new MemoryLockStore();

  async tryAcquire(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    if (this.installed === false) return this.local.tryAcquire(conversationId, holder, ttlMs);
    const { data, error } = await getSupabaseClient().rpc("barry_try_conversation_lock", { p_conversation_id: conversationId, p_holder: holder, p_ttl_ms: ttlMs });
    if (missingFunction(error)) {
      this.installed = false;
      reportGuardMissing("conversation locks unavailable");
      return this.local.tryAcquire(conversationId, holder, ttlMs);
    }
    if (error) throw new Error(`Failed to take the conversation lock: ${error.message}`);
    this.installed = true;
    return data === true;
  }

  async release(conversationId: string, holder: string): Promise<void> {
    if (this.installed === false) return this.local.release(conversationId, holder);
    const { error } = await getSupabaseClient().rpc("barry_release_conversation_lock", { p_conversation_id: conversationId, p_holder: holder });
    // A failed release is not fatal: the lease expires on its own.
    if (error) console.error("[barry:concurrency] lock release failed (the lease will expire)", error.message);
  }

  async waitForChange(conversationId: string, ms: number): Promise<void> {
    if (this.installed === false) return this.local.waitForChange(conversationId, ms);
    await new Promise((r) => setTimeout(r, Math.min(ms, 400)));
  }
}

const holderOfProcess = globalThis as { __barryLockStore?: LockStore };

export function getLockStore(): LockStore {
  if (!holderOfProcess.__barryLockStore) holderOfProcess.__barryLockStore = isSupabaseConfigured() ? new SupabaseLockStore() : new MemoryLockStore();
  return holderOfProcess.__barryLockStore;
}

export function setLockStoreForTests(store: LockStore | undefined): void {
  holderOfProcess.__barryLockStore = store;
}

const held = new AsyncLocalStorage<Map<string, string>>();

/** True when the current request already holds this conversation's lock. */
export function holdsConversationLock(conversationId: string): boolean {
  return held.getStore()?.has(conversationId) ?? false;
}

/**
 * Run `fn` holding the conversation's lock. Waits up to `waitMs` for another holder to finish, then
 * throws ConversationBusyError (fail closed: nothing ran). Re-entrant within the same request.
 */
export async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>, opts: { waitMs?: number; ttlMs?: number } = {}): Promise<T> {
  if (holdsConversationLock(conversationId)) return fn();
  const store = getLockStore();
  const holder = `h_${crypto.randomUUID()}`;
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  while (!(await store.tryAcquire(conversationId, holder, opts.ttlMs ?? LOCK_TTL_MS))) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ConversationBusyError(conversationId);
    await store.waitForChange(conversationId, left);
  }
  const outer = held.getStore();
  const mine = new Map(outer ?? []);
  mine.set(conversationId, holder);
  try {
    return await held.run(mine, fn);
  } finally {
    await store.release(conversationId, holder);
  }
}
