import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { loadControls, applyControlChange, listControlAudit } from "@/lib/hq/controls";
import { interpretFounder } from "@/lib/founder/command";
import { executeFounderCommand, getFounderCommand, type FounderActor } from "@/lib/founder/command-service";
import { checkComposed, voice, type FounderComposer, type FounderEnvelope } from "@/lib/founder/voice";

/**
 * FOUNDER BARRY — CONVERSATION LAYER EVALS. The runtime decides what is true; the conversation layer only
 * decides how to say it. Follow-ups use the previous turn as CONTEXT (never truth or authority); a composer
 * may reword the grounded envelope but is rejected — and the grounded text shown — whenever it invents a
 * number or business, claims an action, implies something was sent, or drops a required confirmation.
 */
const founder: FounderActor = { kind: "founder", via: "test" };
let n = 0;
const say = (text: string, extra: { previousKey?: string; context?: { businessId?: string }; composer?: FounderComposer; now?: Date } = {}) => executeFounderCommand({ actor: founder, key: `conv-${Date.now()}-${n++}`, text, ...extra });
const RINA = "fashion-retailer";
const GARAGE = "garage";
afterEach(async () => {
  for (const id of [RINA, GARAGE]) {
    const c = await loadControls(id);
    if (c.pausedBusiness) await applyControlChange(id, { pausedBusiness: false }, { by: "test", reason: "cleanup" });
  }
});

describe("multi-turn context is grounded", () => {
  it("follow-up business reference: 'and Midtown?' repeats the previous question for the newly named business", async () => {
    const first = await say("What's going on with Rina?");
    const next = await say("and Midtown?", { previousKey: first.key, context: { businessId: RINA } });
    expect(next.intent).toBe("business_inspect");
    expect(next.scope.businessIds).toEqual([GARAGE]);
    expect(next.answer).toMatch(/^Midtown Auto Care /);
    expect((await getFounderCommand(next.key))?.followUpOf).toBe(first.key);
  });

  it("'what about the other one?' picks the other of exactly two businesses from the previous turn — and an action still needs confirmation", async () => {
    const both = await say("Pause Rina and Midtown.");
    expect(both.status).toBe("clarify");
    const other = await say("what about the other one?", { previousKey: both.key, context: { businessId: RINA } });
    expect(other.intent).toBe("founder_action");
    expect(other.scope.businessIds).toEqual([GARAGE]);
    expect(other.status).toBe("needs_confirmation");
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(false);
  });

  it("'yes' confirms EXACTLY the pending control of the previous turn; nothing pending → nothing happens", async () => {
    const auditBefore = (await listControlAudit(GARAGE)).length;
    const nothing = await say("yes");
    expect(nothing.status).toBe("refused");
    expect(nothing.answer).toMatch(/nothing waiting for your confirmation/);
    const ask = await say("Pause BARRY for Midtown Auto Care.");
    expect(ask.status).toBe("needs_confirmation");
    const yes = await say("yes", { previousKey: ask.key });
    expect(yes.status).toBe("executed");
    expect(yes.key).toBe(ask.key);
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(true);
    expect((await listControlAudit(GARAGE)).length).toBe(auditBefore + 1);
    // Saying yes again finds nothing pending — never a second execution.
    const again = await say("כן", { previousKey: ask.key });
    expect(again.status).toBe("refused");
    expect((await listControlAudit(GARAGE)).length).toBe(auditBefore + 1);
  });

  it("stale context: a 'yes' more than 10 minutes after the question executes nothing", async () => {
    const ask = await say("Pause BARRY for Midtown Auto Care.");
    const late = await say("do it", { previousKey: ask.key, now: new Date(Date.now() + 11 * 60_000) });
    expect(late.status).toBe("refused");
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(false);
  });

  it("ambiguous context: 'the other one' with no two-business turn behind it resolves nothing", async () => {
    const first = await say("What's going on with Rina?");
    const r = await say("what about the other one?", { previousKey: first.key, context: { businessId: RINA } });
    expect(r.scope.businessIds).not.toContain(GARAGE);
    expect(r.status).not.toBe("executed");
  });

  it("'is that actually real money?' explains what the previous figure is made of — without re-running anything", async () => {
    const cost = await say("Which customers are costing us the most to serve?");
    const real = await say("is that actually real money?", { previousKey: cost.key });
    expect(real.answer).toMatch(/costs, not money in/);
    expect(real.answer).toMatch(/lower bound/);
    const value = await say("Which businesses aren't getting enough value from BARRY?");
    expect((await say("is that real?", { previousKey: value.key })).answer).toMatch(/provider-verified payments/);
  });
});

describe("Hebrew and code-switching", () => {
  it("the same closed intents in Hebrew, with English business names", () => {
    expect(interpretFounder("מה אני צריך לדעת היום?")).toEqual({ family: "fleet_read", topic: "brief" });
    expect(interpretFounder("מה קורה עם Rina?", { hasBusiness: true })).toEqual({ family: "business_inspect", followUp: "overview" });
    expect(interpretFounder("למה?", { hasBusiness: true })).toEqual({ family: "business_inspect", followUp: "why" });
    expect(interpretFounder("תשהה את Midtown", { hasBusiness: true })).toEqual({ family: "founder_action", action: "pause_business" });
    expect(interpretFounder("תחזיר את Midtown לפעולה", { hasBusiness: true })).toEqual({ family: "founder_action", action: "resume_business" });
    expect(interpretFounder("תריץ סריקה ל-Rina Studio", { hasBusiness: true })).toEqual({ family: "initiative_scan", force: false });
    expect(interpretFounder("תריץ initiative scan ל-Rina", { hasBusiness: true })).toEqual({ family: "initiative_scan", force: false });
    expect(interpretFounder("תריץ סריקה בכפייה ל-Rina לבדיקה", { hasBusiness: true })).toEqual({ family: "initiative_scan", force: true });
    expect(interpretFounder("מי עולה לנו הכי הרבה?")).toEqual({ family: "commercial_read", topic: "cost_to_serve" });
    expect(interpretFounder("מה השתנה מאתמול?")).toEqual({ family: "fleet_read", topic: "changed" });
    expect(interpretFounder("תכניס את Rina למצב בטוח", { hasBusiness: true })).toEqual({ family: "founder_action", action: "safe_mode_on" });
    expect(interpretFounder("תראה לי את הטוקן של וואטסאפ").family).toBe("unsupported");
  });

  it("a Hebrew command runs the same grounded path, and the envelope says the founder wrote Hebrew", async () => {
    let seen: FounderEnvelope | undefined;
    const r = await say("תשהה את Midtown", { composer: async (env) => ((seen = env), undefined) });
    expect(r.status).toBe("needs_confirmation");
    expect(seen?.language).toBe("he");
    expect(seen?.confirmationRequired).toBe("Pause BARRY for Midtown Auto Care");
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(false);
  });
});

describe("the composer may reword, never extend", () => {
  const env = (over: Partial<FounderEnvelope> = {}): FounderEnvelope => ({ question: "q", language: "en", intent: "initiative_scan", status: "executed", grounded: "I found 5 things worth attention at Rina Studio. The biggest: 8 unpaid payment links haven't had a follow-up. I haven't contacted anyone — the owner decides each one.", items: [{ title: "Rina Studio: 8 unpaid payment links" }], done: ["Scan scan_1 recorded for Rina Studio (2026-10-02); 5 initiatives open now."], notDone: [], confirmationRequired: null, nothingSent: true, proposals: [], businessesInScope: ["Rina Studio"], followUps: [], ...over });
  const FLEET = ["Rina Studio", "Midtown Auto Care", "Serenity Massage Spa"];

  it("accepts a natural rewording that keeps every number and claims nothing new", () => {
    expect(checkComposed("Five things stand out at Rina Studio — the biggest is 8 unpaid payment links with no follow-up yet. I haven't reached anyone; it's the owner's call. Want me to start with the unpaid payments?", env(), FLEET)).toBeUndefined();
  });

  it("rejects an invented number, an invented business, a send claim, an un-done action, a dropped confirmation, an 'applied' proposal", () => {
    expect(checkComposed("Rina Studio has 9 unpaid links worth ₪999.", env(), FLEET)).toMatch(/figures not in the grounded reply/);
    expect(checkComposed("Rina Studio and Midtown Auto Care both have open links.", env(), FLEET)).toMatch(/names a business/);
    expect(checkComposed("I sent reminders to the 8 customers at Rina Studio.", env(), FLEET)).toMatch(/sent/);
    expect(checkComposed("I paused Rina Studio while scanning.", env(), FLEET)).toMatch(/not executed/);
    expect(checkComposed("Midtown Auto Care will be paused.", env({ intent: "founder_action", status: "needs_confirmation", grounded: "Pause BARRY for Midtown Auto Care?\nConfirm to apply it.", confirmationRequired: "Pause BARRY for Midtown Auto Care", done: [], businessesInScope: ["Midtown Auto Care"] }), FLEET)).toMatch(/confirmation/);
    expect(checkComposed("I paused Midtown Auto Care — confirm?", env({ status: "needs_confirmation", confirmationRequired: "Pause BARRY for Midtown Auto Care", done: [] }), FLEET)).toMatch(/not executed/);
    expect(checkComposed("Done — the rollout to Rina Studio is live.", env({ intent: "proposal", status: "proposed", done: [] }), FLEET)).toBeDefined();
    expect(checkComposed("השהיתי את Rina Studio.", env({ status: "answered", done: [] }), FLEET)).toMatch(/not executed/);
  });

  it("a rejected or failing composer falls back to the exact grounded text", async () => {
    const e = env();
    expect(await voice(e, async () => "Rina made ₪5,000 today!", FLEET)).toMatchObject({ text: e.grounded, source: "grounded", reason: expect.stringMatching(/rejected/) });
    expect(await voice(e, async () => {
      throw new Error("model down");
    }, FLEET)).toMatchObject({ text: e.grounded, source: "grounded" });
    expect(await voice(e, undefined, FLEET)).toEqual({ text: e.grounded, source: "grounded" });
    expect(await voice(e, async () => "Five things stand out at Rina Studio; the biggest is 8 unpaid payment links. I haven't reached anyone.", FLEET)).toMatchObject({ source: "composer" });
  });

  it("end to end: a good composer reply is shown; a hallucinating one is replaced and the reason recorded", async () => {
    const good = await say("What do I need to know today?", { composer: async (envl) => `Here's the short version: ${envl.grounded}` });
    expect(good.voice).toBe("composer");
    expect(good.answer).toMatch(/^Here's the short version:/);
    const badKey = `conv-bad-${Date.now()}`;
    const bad = await executeFounderCommand({ actor: founder, key: badKey, text: "What do I need to know today?", composer: async () => "Everything is fine and Rina made ₪12,345 this week." });
    expect(bad.voice).toBe("grounded");
    expect(bad.answer).not.toMatch(/12,345/);
    const rec = await getFounderCommand(badKey);
    expect(rec?.voice?.reason).toMatch(/figures not in the grounded reply/);
    expect(rec?.groundedAnswer).toBe(bad.answer);
  });

  it("preserves 'nothing was sent' and the approval requirement through a Hebrew composer", async () => {
    const r = await say("תשהה את Midtown Auto Care", { composer: async () => "אני משהה את Midtown Auto Care — רק תאשר ואעשה את זה." });
    expect(r.voice).toBe("composer");
    expect(r.status).toBe("needs_confirmation");
    expect(r.confirmation?.title).toBe("Pause BARRY for Midtown Auto Care");
    const sneaky = await say("תשהה את Midtown Auto Care", { composer: async () => "השהיתי את Midtown Auto Care." });
    expect(sneaky.voice).toBe("grounded");
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(false);
  });
});
