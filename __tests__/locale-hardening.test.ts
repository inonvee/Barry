import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { deniedText, understandingUnavailableText, writeBlockedText } from "@/lib/reasoner/deterministic-compose";
import { resolveReplyLanguage } from "@/lib/reasoner/language";
import { followUpText } from "@/lib/operator/executor";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { SEMANTIC_GROUPS } from "./support/semantic-corpus";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * CHECKPOINT 8 — LIVE-MODEL / LOCALE HARDENING (deterministic part): every deterministic, tool-error
 * or blocked reply follows the established customer language — Hebrew stays Hebrew absent an explicit
 * switch — and the production-like corpus carries the Hebrew commerce semantics the model must map.
 * The model comparison itself runs through the live eval harness (BARRY_LIVE_EVAL=1).
 */

const HEB = /[֐-׿]/;
let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

describe("locale-safe fallbacks", () => {
  it("deterministic texts exist in Hebrew and English and never mix", () => {
    for (const [he, en] of [
      [deniedText({ code: "he" }), deniedText({ code: "en" })],
      [understandingUnavailableText("he", { held: true }), understandingUnavailableText("en", { held: true })],
      [writeBlockedText({ reason: "over_budget", total: 450, cap: 400, currency: "ILS" }, "he"), writeBlockedText({ reason: "over_budget", total: 450, cap: 400, currency: "ILS" }, "en")],
      [followUpText("abandoned_checkout_recovery", { amount: 420, currency: "ILS" } as never, "he")!, followUpText("abandoned_checkout_recovery", { amount: 420, currency: "ILS" } as never, "en")!],
    ]) {
      expect(he).toMatch(HEB);
      expect(en).not.toMatch(HEB);
      expect(he).not.toMatch(/\b(sorry|reminder|cart)\b/i);
    }
  });

  it("the reply language sticks to the customer's established language; a price or emoji never switches it", () => {
    expect(resolveReplyLanguage({ customerMessages: ["היי, יש שמלה שחורה?"], businessLocale: "en-US" }).code).toBe("he");
    expect(resolveReplyLanguage({ customerMessages: ["היי, יש שמלה שחורה?", "400"], stored: "he", businessLocale: "en-US" }).code).toBe("he");
    expect(resolveReplyLanguage({ customerMessages: ["היי", "ok switching to english now please"], stored: "he", businessLocale: "he-IL" }).code).toBe("en");
    expect(resolveReplyLanguage({ customerMessages: ["👍"], businessLocale: "he-IL" }).code).toBe("he");
  });

  it("a founder-blocked write in a Hebrew conversation is refused in Hebrew with nothing sent or charged", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("loc");
    model.plan = () => ({ commerce: { intent: "search", query: { text: "שמלה שחורה", category: "dress", attributes: { color: "black" } } }, advancesTransaction: true });
    const first = await handleCustomerMessage(r.g, id, "c", "היי, יש שמלה שחורה?");
    expect(first.response).toMatch(HEB);
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
    await handleCustomerMessage(r.g, id, "c", "אקח את הראשונה ב-M");
    await applyControlChange(r.g.business.id, { pauseConsequentialWrites: true }, { by: "founder", reason: "locale test" });
    model.plan = () => ({ commerce: { intent: "checkout" }, customerInfo: { name: "דנה", phone: "0501234567" }, evidence: { "customerInfo.name": "דנה", "customerInfo.phone": "0501234567" }, advancesTransaction: true });
    const blocked = await handleCustomerMessage(r.g, id, "c", "לתשלום בבקשה, דנה 0501234567");
    expect(blocked.response).toMatch(HEB);
    expect(blocked.response).not.toMatch(/\b(sorry|cannot|can't)\b/i);
    expect(blocked.state.knownFields.__paymentRequestId).toBeUndefined();
  });
});

describe("Hebrew commerce semantics are in the production-like corpus", () => {
  it("the corpus carries the natural sentence with size, occasion and ILS budget, plus typo / slang variants, as ONE meaning", () => {
    const g = SEMANTIC_GROUPS.find((x) => x.id === "search_black_dress_M_wedding_under_400")!;
    expect(g.paraphrases.he).toContain("היי אני מחפשת שמלה שחורה מידה M לחתונה עד 400 שקל");
    expect(g.paraphrases.he.length).toBeGreaterThanOrEqual(5);
    expect(g.ir.commerce).toMatchObject({ intent: "search", query: { budget: { amount: 400, currency: "ILS" }, attributes: { color: "black", occasion: "wedding" } }, variant: { size: "M" } });
  });
});
