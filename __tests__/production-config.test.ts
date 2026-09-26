import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Production (NODE_ENV=production, which every Vercel deployment sets)
 * must never silently fall back to MockReasoner or the in-memory
 * backend/store just because a credential was missing — that would mean a
 * real customer conversation quietly running without AI or without
 * persistence, with no one aware. Each getter throws a
 * BarryConfigurationError instead.
 *
 * Uses vi.resetModules() + dynamic import per test because getReasoner() /
 * getConversationStore() / getBackend() are module-level singletons —
 * this exercises the real "cold start" selection logic without adding a
 * test-only reset hook to production code.
 */

const ENV_KEYS = ["NODE_ENV", "BARRY_REASONER", "OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.resetModules();
});

describe("production configuration guard", () => {
  it("getReasoner() throws in production without OPENAI_API_KEY, instead of silently using MockReasoner", async () => {
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.OPENAI_API_KEY;
    delete process.env.BARRY_REASONER;

    const { getReasoner } = await import("@/lib/reasoner");
    expect(() => getReasoner()).toThrow(/production configuration error/i);
  });

  it("getReasoner() succeeds in production when properly configured for OpenAI", async () => {
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "production" });
    process.env.BARRY_REASONER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

    const { getReasoner } = await import("@/lib/reasoner");
    expect(() => getReasoner()).not.toThrow();
    expect(getReasoner().name).toBe("llm");
  });

  it("getReasoner() falls back to MockReasoner outside production (dev/test) with no key set", async () => {
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "test" });
    delete process.env.OPENAI_API_KEY;
    delete process.env.BARRY_REASONER;

    const { getReasoner } = await import("@/lib/reasoner");
    expect(getReasoner().name).toBe("mock");
  });

  it("getConversationStore() throws in production without Supabase credentials", async () => {
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getConversationStore } = await import("@/lib/state");
    expect(() => getConversationStore()).toThrow(/production configuration error/i);
  });

  it("getBackend() throws in production without Supabase credentials", async () => {
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getBackend } = await import("@/lib/store");
    expect(() => getBackend()).toThrow(/production configuration error/i);
  });

  it("getConversationStore()/getBackend() fall back to memory outside production with no Supabase credentials", async () => {
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "test" });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getConversationStore } = await import("@/lib/state");
    const { getBackend } = await import("@/lib/store");
    expect(() => getConversationStore()).not.toThrow();
    expect(() => getBackend()).not.toThrow();
  });
});
