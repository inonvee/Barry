import { afterEach, describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { BASELINE_MODEL, createCompletion, isReasoningModel, modelFor, samplingParams } from "@/lib/reasoner/model-config";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { ScriptedReasoner } from "./support/semantic-corpus";
import { OpenAIReasoner } from "@/lib/reasoner/openai-reasoner";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { createInitialConversationState } from "@/lib/state";

const KEYS = ["BARRY_MODEL", "BARRY_REASONER_MODEL", "BARRY_COMPOSER_MODEL", "BARRY_LEARNER_MODEL", "BARRY_REASONER_REASONING_EFFORT", "BARRY_COMPOSER_REASONING_EFFORT"];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  setReasonerForTests(undefined);
  setPaymentAdapterForTests(undefined);
});

describe("model selection per job", () => {
  it("defaults to the unchanged baseline when nothing is configured", () => {
    expect(modelFor("reasoner")).toBe(BASELINE_MODEL);
    expect(modelFor("composer")).toBe(BASELINE_MODEL);
  });

  it("understanding and composition are configured independently; legacy BARRY_MODEL is the fallback", () => {
    process.env.BARRY_MODEL = "legacy-model";
    expect(modelFor("reasoner")).toBe("legacy-model");
    process.env.BARRY_REASONER_MODEL = "gpt-5.6-sol";
    process.env.BARRY_COMPOSER_MODEL = "gpt-5.6-terra";
    expect(modelFor("reasoner")).toBe("gpt-5.6-sol");
    expect(modelFor("composer")).toBe("gpt-5.6-terra");
    expect(modelFor("learner")).toBe("gpt-5.6-sol");
  });

  it("reasoning models get reasoning effort, never temperature; other models get temperature", () => {
    expect(isReasoningModel("gpt-5.6-sol")).toBe(true);
    expect(isReasoningModel("gpt-5.6-terra")).toBe(true);
    expect(isReasoningModel("gpt-4o-mini")).toBe(false);
    process.env.BARRY_REASONER_REASONING_EFFORT = "low";
    expect(samplingParams("gpt-5.6-sol", "reasoner", 0.2)).toEqual({ reasoning_effort: "low" });
    expect(samplingParams("gpt-5.6-sol", "reasoner", 0.2, "medium")).toEqual({ reasoning_effort: "medium" });
    expect(samplingParams("gpt-4o-mini", "reasoner", 0.2)).toEqual({ temperature: 0.2 });
    process.env.BARRY_REASONER_REASONING_EFFORT = "turbo";
    expect(() => samplingParams("gpt-5.6-sol", "reasoner", 0.2)).toThrow(/Invalid reasoning effort/);
  });

  it("a model that rejects a sampling parameter is retried once without it — the request is otherwise unchanged", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            calls.push(params);
            if ("temperature" in params) throw Object.assign(new Error("Unsupported parameter: 'temperature'"), { status: 400 });
            return { choices: [{ message: { content: "{}" } }] };
          },
        },
      },
    } as unknown as OpenAI;
    await createCompletion(client, { model: "new-model", messages: [{ role: "user", content: "x" }], temperature: 0.2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ model: "new-model", messages: [{ role: "user", content: "x" }] });
  });
});

describe("the configured models are what runs, and a bad configuration fails closed", () => {
  const withKey = <T,>(fn: () => T): T => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-not-used";
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  };

  it("the preview configuration: a reasoning model for understanding (with its effort), a separate composer", () => {
    process.env.BARRY_REASONER_MODEL = "gpt-5.6-sol";
    process.env.BARRY_REASONER_REASONING_EFFORT = "low";
    process.env.BARRY_COMPOSER_MODEL = "gpt-4o-mini";
    const r = withKey(() => new OpenAIReasoner());
    expect(r.model).toBe("gpt-5.6-sol");
    expect(r.reasoningEffort).toBe("low");
    expect(r.composerModel).toBe("gpt-4o-mini");
    expect(r.composerReasoningEffort).toBeUndefined(); // not a reasoning model: temperature, no effort
    expect(r.configError).toBeUndefined();
  });

  it("an invalid effort never reaches the provider: understanding fails closed and replies are deterministic", async () => {
    process.env.BARRY_REASONER_MODEL = "gpt-5.6-sol";
    process.env.BARRY_REASONER_REASONING_EFFORT = "turbo";
    const r = withKey(() => new OpenAIReasoner());
    expect(r.configError).toMatch(/Invalid reasoning effort "turbo"/);
    const graph = buildSpaGraph();
    const ctx = { graph, state: createInitialConversationState("c", graph.business.id, "cust"), customerMessage: "hello" };
    const result = await r.understandDetailed(ctx);
    expect(result).toMatchObject({ valid: false, attempts: 0, failure: "invalid_model_config" });
    expect(result.ir.intent).toBe("understanding_failed");
    const text = await r.composeResponse(ctx, { outcome: { kind: "ask_general", stage: "discovery", offerNames: [] } });
    expect(typeof text).toBe("string");
  });
});

describe("the target live flow (Rina Studio playbook: name + phone before checkout)", () => {
  it("search -> 'אני אקח אותה במדיום' -> Onyx M in the cart and a request for name + phone -> details -> checkout link", async () => {
    const id = `target-flow-${Date.now()}`;
    const adapter = new MemoryCommerceAdapter(fashionCatalog());
    registerCommerceAdapterFactoryForTests(id, () => adapter);
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const base = buildFashionRetailerGraph();
    const graph = { ...base, business: { ...base.business, id } };
    const SEARCH = "היי אני מחפשת שמלה במידה מדיום עד 400 ש״ח";
    const TAKE = "אני אקח אותה במדיום";
    const DETAILS = "דנה כהן 0501234567";
    // What a competent model emits — note the reference is just "it": no position.
    const script: Record<string, Partial<BarryIR>> = {
      [SEARCH]: { intent: "search", commerce: { intent: "search", query: { text: SEARCH, category: "dress", budget: { amount: 400, currency: "ILS" } }, variant: { size: "M" } } },
      [TAKE]: { intent: "select", purchaseDecision: true, commerce: { intent: "select", variant: { size: "M" } } },
      [DETAILS]: { intent: "details", customerInfo: { name: "דנה כהן", phone: "0501234567" }, evidence: { "customerInfo.name": "דנה כהן", "customerInfo.phone": "0501234567" } },
    };
    setReasonerForTests(new ScriptedReasoner(script));
    const conv = `conv-${id}`;
    try {
      const search = await handleCustomerMessage(graph, conv, "c", SEARCH);
      expect(search.rich?.products?.map((p) => p.title)).toEqual(["Onyx Slip Dress"]);

      const take = await handleCustomerMessage(graph, conv, "c", TAKE);
      expect(take.turn.trace?.steps.map((s) => [s.action, s.result?.ok])).toEqual([["addToCart", true]]);
      expect(take.turn.trace?.stop).toEqual({ reason: "needs_customer", outcome: "checkout_needs_info" });
      const cart = await adapter.getCart(take.state.knownFields.__commerceCartId);
      expect(cart?.lines.map((l) => [l.title, l.options.size, l.unitPrice.amount])).toEqual([["Onyx Slip Dress", "M", 390]]);
      expect(take.response).not.toMatch(/which (item|one)|איזה פריט/i);
      expect(take.response).toMatch(/שם/);
      expect(take.response).toMatch(/טלפון/);

      const pay = await handleCustomerMessage(graph, conv, "c", DETAILS);
      expect(pay.turn.trace?.steps.map((s) => s.action)).toEqual(["createCommerceCheckout"]);
      expect(pay.rich?.paymentUrl).toMatch(/^https:\/\//);
      expect(pay.state.knownFields.__paid).toBeUndefined();
    } finally {
      registerCommerceAdapterFactoryForTests(id, undefined);
    }
  });
});
