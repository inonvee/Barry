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
