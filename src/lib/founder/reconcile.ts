/**
 * FOUNDER COMMAND TRANSPORT (client-safe, pure apart from the injected fetch / sleep).
 *
 * The client generates the command key BEFORE sending, and the server records the command durably before doing
 * any work. So when a phone loses the response (mobile Safari "Load failed", a dropped connection, a 5xx from the
 * edge) the answer is RECOVERED by reading that key — the command is never sent again, so nothing can run twice.
 * Recovery is bounded; a real failure is shown only when no durable result can be found.
 */

export type ReconcileReply = { key: string; status: string; [k: string]: unknown };
export type SendOutcome<R extends ReconcileReply = ReconcileReply> =
  | { kind: "reply"; reply: R; recovered: boolean }
  | { kind: "error"; message: string }
  | { kind: "lost"; message: string };

export type TransportDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  onRecovering?: () => void;
};

const ENDPOINT = "/api/hq/founder/command";
/** Poll delays while recovering (~50 s in total). */
export const RECOVERY_DELAYS_MS = [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 10000];
/** The server writes the key before working: still nothing under it after this long means it never arrived. */
export const NOT_RECEIVED_AFTER_MS = 12_000;

export const MESSAGES = {
  session: "Your HQ session ended — sign in again, then ask again.",
  notReceived: "BARRY never received that — nothing was changed. Send it again.",
  lost: "BARRY may still be working on this, or the answer was lost on the way. Nothing will run twice — check again in a moment.",
};

/** Send one command (key already inside `body`) and get its reply, recovering a lost response by key. */
export async function sendFounderCommand<R extends ReconcileReply>(body: Record<string, unknown>, key: string, deps: TransportDeps): Promise<SendOutcome<R>> {
  try {
    const r = await deps.fetch(ENDPOINT, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) return { kind: "error", message: MESSAGES.session };
    let d: (R & { error?: string }) | undefined;
    try {
      d = (await r.json()) as R & { error?: string };
    } catch {
      d = undefined; // a cut-off or non-JSON body: the server may still have finished
    }
    if (r.ok && d && typeof d.status === "string") {
      if (d.status === "received") return recoverFounderReply<R>(key, { ...deps, onRecovering: undefined }); // the same key is still being worked on
      return { kind: "reply", reply: d, recovered: false };
    }
    // A clear, deliberate refusal from BARRY (bad request, conflict) is final — nothing to recover.
    if (d?.error && r.status >= 400 && r.status < 500 && r.status !== 408) return { kind: "error", message: d.error };
  } catch {
    // Transport failure: fall through to recovery by key.
  }
  deps.onRecovering?.();
  return recoverFounderReply<R>(key, deps);
}

/** Read the durable reply of `key` until it settles, within a bounded budget. Read-only: never re-sends. */
export async function recoverFounderReply<R extends ReconcileReply>(key: string, deps: TransportDeps): Promise<SendOutcome<R>> {
  let waited = 0;
  for (const delay of RECOVERY_DELAYS_MS) {
    await deps.sleep(delay);
    waited += delay;
    try {
      const r = await deps.fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, { method: "GET", credentials: "same-origin", cache: "no-store" });
      if (r.status === 401) return { kind: "error", message: MESSAGES.session };
      if (r.status === 404) {
        if (waited >= NOT_RECEIVED_AFTER_MS) return { kind: "error", message: MESSAGES.notReceived };
        continue;
      }
      if (!r.ok) continue;
      const d = (await r.json()) as { found: boolean; settled?: boolean; reply?: R };
      if (d.found && d.settled && d.reply && d.reply.key === key) return { kind: "reply", reply: d.reply, recovered: true };
    } catch {
      // still offline / flaky: keep trying within the budget
    }
  }
  return { kind: "lost", message: MESSAGES.lost };
}
