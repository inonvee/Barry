import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * simulator-session.ts reads `window.localStorage`; this test file runs in
 * vitest's plain "node" environment (see vitest.config.mts) so there's no
 * real `window`. A minimal in-memory stub avoids pulling in jsdom just for
 * this — it only needs getItem/setItem, which is all the module uses.
 */
function makeFakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function installFakeWindow() {
  globalThis.window = { localStorage: makeFakeLocalStorage() } as unknown as Window & typeof globalThis;
}

function removeWindow() {
  // @ts-expect-error - simulating an environment with no window (SSR / this test's own baseline)
  globalThis.window = undefined;
}

beforeEach(() => {
  installFakeWindow();
});

afterEach(() => {
  removeWindow();
});

describe("simulator-session (conversation restore persistence)", () => {
  it("persists and restores a customerId per business", async () => {
    const { getOrCreateCustomerId } = await import("@/lib/simulator-session");
    const first = getOrCreateCustomerId("spa");
    const second = getOrCreateCustomerId("spa");
    expect(second).toBe(first);
  });

  it("scopes customerId/conversationId separately per business — no cross-contamination", async () => {
    const { getOrCreateCustomerId, setStoredConversationId, getStoredConversationId } = await import(
      "@/lib/simulator-session"
    );
    const spaCustomer = getOrCreateCustomerId("spa");
    const garageCustomer = getOrCreateCustomerId("garage");
    expect(spaCustomer).not.toBe(garageCustomer);

    setStoredConversationId("spa", "conv-spa-1");
    setStoredConversationId("garage", "conv-garage-1");
    expect(getStoredConversationId("spa")).toBe("conv-spa-1");
    expect(getStoredConversationId("garage")).toBe("conv-garage-1");
  });

  it("returns null for a business with no stored conversation yet", async () => {
    const { getStoredConversationId } = await import("@/lib/simulator-session");
    expect(getStoredConversationId("furniture-store")).toBeNull();
  });

  it("never throws when localStorage is unavailable (private browsing / SSR)", async () => {
    removeWindow();
    const { getOrCreateCustomerId, getStoredConversationId, setStoredConversationId } = await import(
      "@/lib/simulator-session"
    );
    expect(() => getOrCreateCustomerId("spa")).not.toThrow();
    expect(() => getStoredConversationId("spa")).not.toThrow();
    expect(() => setStoredConversationId("spa", "x")).not.toThrow();
  });
});
