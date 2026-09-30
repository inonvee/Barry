/**
 * Per-business simulator identity, persisted in localStorage so a page
 * refresh or reopening the tab restores the same conversation instead of
 * silently starting a new one server-side never hears about. Scoped by
 * businessId so switching businesses can never attach one business's
 * conversation to another's.
 *
 * Wrapped in try/catch: private browsing, disabled storage, or SSR must
 * never crash the simulator — they just mean "start fresh this time."
 */

function key(kind: "conversationId" | "customerId", businessId: string): string {
  return `barry:${kind}:${businessId}`;
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getOrCreateCustomerId(businessId: string): string {
  try {
    const existing = window.localStorage.getItem(key("customerId", businessId));
    if (existing) return existing;
    const fresh = randomId("cust");
    window.localStorage.setItem(key("customerId", businessId), fresh);
    return fresh;
  } catch {
    return randomId("cust");
  }
}

export function getStoredConversationId(businessId: string): string | null {
  try {
    return window.localStorage.getItem(key("conversationId", businessId));
  } catch {
    return null;
  }
}

export function setStoredConversationId(businessId: string, conversationId: string): void {
  try {
    window.localStorage.setItem(key("conversationId", businessId), conversationId);
  } catch {
    // ignore — non-persistent fallback is acceptable, never crash on it
  }
}

export function createConversationId(): string {
  return randomId("conv");
}

/**
 * THE SIMULATOR'S BUSINESS-SCOPED VIEW MODEL.
 *
 * Every piece of data the simulator loads is stored together with the business (and, for the
 * conversation, the conversation id) it was loaded FOR. What the page renders is derived by
 * `simulatorView` from the CURRENT business only: data loaded for another business — or a late
 * response that arrives after the owner switched — is never shown, no matter which component
 * would render it (chat, cart, payment prompt, Inspector, approvals, graph).
 */
export type SimulatorScope = { businessId: string; conversationId: string; customerId: string };

export type SimulatorData<State, Approval, Graph> = {
  scope: SimulatorScope | null;
  conversation: { businessId: string; conversationId: string; state: State | null } | null;
  approvals: { businessId: string; list: Approval[]; locked: boolean } | null;
  graph: { businessId: string; graph: Graph | null } | null;
};

export type SimulatorView<State, Approval, Graph> = {
  scope: SimulatorScope | null;
  state: State | null;
  approvals: Approval[];
  approvalsLocked: boolean;
  graph: Graph | null;
};

export function simulatorView<State extends { id: string; businessId: string }, Approval extends { businessId: string }, Graph extends { business: { id: string } }>(
  data: SimulatorData<State, Approval, Graph>,
  businessId: string | null
): SimulatorView<State, Approval, Graph> {
  const scope = businessId && data.scope?.businessId === businessId ? data.scope : null;
  const c = data.conversation;
  const state =
    scope && c && c.businessId === businessId && c.conversationId === scope.conversationId && c.state && c.state.id === scope.conversationId && c.state.businessId === businessId
      ? c.state
      : null;
  const a = businessId && data.approvals?.businessId === businessId ? data.approvals : null;
  const g = businessId && data.graph?.businessId === businessId && data.graph.graph?.business.id === businessId ? data.graph.graph : null;
  return {
    scope,
    state,
    approvals: a ? a.list.filter((x) => x.businessId === businessId) : [],
    approvalsLocked: a?.locked ?? false,
    graph: g,
  };
}

/**
 * A conversation state arriving from the server replaces the shown one only when it is for the same
 * business + conversation AND not older: a delayed response (fewer turns, or an earlier save) can never
 * overwrite a newer authoritative state — its cart, approvals or messages.
 */
export function acceptConversation<State extends { id: string; businessId: string; turns: unknown[]; updatedAt: string }>(
  current: { businessId: string; conversationId: string; state: State | null } | null,
  at: { businessId: string; conversationId: string },
  next: State | null
): boolean {
  if (next && (next.businessId !== at.businessId || next.id !== at.conversationId)) return false;
  const held = current && current.businessId === at.businessId && current.conversationId === at.conversationId ? current.state : null;
  if (!held || !next) return true;
  if (next.turns.length !== held.turns.length) return next.turns.length > held.turns.length;
  return next.updatedAt >= held.updatedAt;
}

/** Key for remounting business-scoped components (drafts, selected Inspector turn) when the scope changes. */
export function scopeKey(scope: SimulatorScope | null): string {
  return scope ? `${scope.businessId}/${scope.conversationId}` : "none";
}
