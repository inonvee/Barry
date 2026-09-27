import { describe, expect, it } from "vitest";
import { compile } from "@/lib/runtime/compiler";
import { handleCustomerMessage } from "@/lib/runtime";
import { createInitialConversationState } from "@/lib/state";
import { MockReasoner } from "@/lib/reasoner/mock-reasoner";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * Priority 8 (Phase 1.5 Finalization Mission): Hebrew/mixed-language
 * smoke tests. MockReasoner's entity extraction is intentionally
 * English-regex-only (multilingual understanding is OpenAIReasoner's
 * job) — the bar here is that Hebrew/RTL/mixed-language text NEVER
 * crashes the pipeline, is NEVER silently mishandled into a fabricated
 * fact, and round-trips byte-for-byte through ConversationState wherever
 * it's stored (a customer's own name, for instance).
 */
describe("Hebrew / mixed-language smoke tests", () => {
  it("a pure-Hebrew message never throws and falls back to a safe general response", async () => {
    const graph = buildSpaGraph();
    const conv = "heb1";
    const customer = "cust1";

    const t = await handleCustomerMessage(graph, conv, customer, "כמה עולה עיסוי זוגי?");

    expect(t.turn.selectedAction).toBeNull();
    expect(typeof t.response).toBe("string");
    expect(t.response.length).toBeGreaterThan(0);
  });

  it("a mixed Hebrew/English message selects the English-named offer and extracts an embedded phone number", async () => {
    const graph = buildSpaGraph();
    const conv = "heb2";
    const customer = "cust2";

    const t = await handleCustomerMessage(
      graph,
      conv,
      customer,
      "אני רוצה להזמין couples massage, הטלפון שלי הוא 054-123-4567"
    );

    expect(t.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t.state.knownFields.phone).toContain("054");
  });

  it("a Hebrew customer name is stored and round-trips exactly (no mangling/mojibake)", async () => {
    const graph = buildSpaGraph();
    const conv = "heb3";
    const customer = "cust3";

    await handleCustomerMessage(graph, conv, customer, "couples massage");
    await handleCustomerMessage(graph, conv, customer, "054-123-4567"); // phone first
    const t = await handleCustomerMessage(graph, conv, customer, "יונתן כהן"); // then name

    expect(t.state.knownFields.name).toBe("יונתן כהן");
  });

  it("MockReasoner.understand() never throws on Hebrew/RTL/emoji/control-character input", async () => {
    const graph = buildSpaGraph();
    const reasoner = new MockReasoner();
    const state = createInitialConversationState("heb4", graph.business.id, "cust4");

    const adversarialMessages = [
      "עברית בלבד ללא אנגלית כלל",
      "מעורב Hebrew and English בטקסט אחד",
      "🎉 עברית עם אימוג'י 🎉",
      "‏‎ mixed RTL/LTR marks ‮",
      "",
    ];

    for (const message of adversarialMessages) {
      await expect(reasoner.understand({ graph, state, customerMessage: message })).resolves.toBeDefined();
    }
  });

  it("compiler-level: a Hebrew value in knownFieldsUpdate never crashes compile() and is stored verbatim", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("heb5", graph.business.id, "cust5");
    state.selectedOfferId = "offer-couples-massage";
    const ir: BarryIR = {
      intent: "test",
      entities: {},
      constraints: {},
      knownFieldsUpdate: { name: "שרה לוי", phone: "050-9876543" },
    };

    const outcome = compile(graph, state, ir);

    expect(outcome.kind).not.toBe("compiler_error");
    expect(state.knownFields.name).toBe("שרה לוי");
  });

  it("a Hebrew requestedCapability string (never a recognized English keyword) never fabricates a fact", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("heb6", graph.business.id, "cust6");
    const ir: BarryIR = {
      intent: "test",
      selectedOfferId: "offer-couples-massage",
      entities: {},
      constraints: {},
      knownFieldsUpdate: {},
      requestedCapability: "כמה זה עולה",
    };

    const outcome = compile(graph, state, ir);

    expect(outcome.kind).not.toBe("offer_fact");
  });
});
