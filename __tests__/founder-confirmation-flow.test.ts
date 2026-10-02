import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "@/lib/fabric";
import { GET, POST } from "@/app/api/hq/founder/command/route";
import { applyControlChange, listControlAudit, loadControls } from "@/lib/hq/controls";
import { executeFounderCommand, getFounderCommand, type FounderActor } from "@/lib/founder/command-service";
import { sendFounderCommand, type TransportDeps } from "@/lib/founder/reconcile";
import { FounderReplyView, type Reply } from "@/components/hq/FounderCommand";

/**
 * LIVE FINDINGS (iPhone, Preview): after "תשהה את Midtown" the confirmation result came back in English, and a
 * second press of the SAME Confirm button rendered another "Done · verified" card (the runtime was correct — one
 * execution, one audit — but it read as if it ran twice). A confirmation is part of the same turn: it answers
 * in the original command's language, and a used confirmation is shown as "already done".
 */
const founder: FounderActor = { kind: "founder", via: "test" };
const TOKEN = "founder-test-token-that-is-long-enough-123456";
const GARAGE = "garage";
let n = 0;
const key = (p: string) => `${p}-${Date.now()}-${n++}`;
const ask = (text: string, k = key("cf")) => executeFounderCommand({ actor: founder, key: k, text });
const confirm = (k: string) => executeFounderCommand({ actor: founder, key: `x-${n++}`, confirmKey: k });
const HEBREW = /[א-ת]/;
beforeAll(() => {
  process.env.BARRY_FOUNDER_TOKEN = TOKEN;
});
afterEach(async () => {
  if ((await loadControls(GARAGE)).pausedBusiness) await applyControlChange(GARAGE, { pausedBusiness: false }, { by: "test", reason: "cleanup" });
});

describe("the confirmation answers in the language of the original command", () => {
  it("Hebrew pending action → Hebrew confirmation question → Hebrew executed result and verification", async () => {
    const k = key("he");
    const pending = await ask("תשהה את Midtown", k);
    expect(pending.status).toBe("needs_confirmation");
    expect(pending.language).toBe("he");
    expect(pending.answer).toMatch(HEBREW);
    expect(pending.answer).toContain("Midtown Auto Care");
    expect(pending.confirmation?.label).toBe("השהיית BARRY עבור Midtown Auto Care");
    const done = await confirm(k);
    expect(done.status).toBe("executed");
    expect(done.language).toBe("he");
    expect(done.answer).toMatch(/^בוצע — השהיית BARRY עבור Midtown Auto Care\./);
    expect(done.answer).not.toMatch(/Done|Verified/);
    expect(done.verification).toMatch(/בבקרות הקבועות/);
    expect(done.verification).toContain("pausedBusiness = true");
    expect(done.followUps).toEqual(["תחזיר את Midtown Auto Care לפעולה"]);
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(true);
  });

  it("English pending action → English result (unchanged)", async () => {
    const k = key("en");
    const pending = await ask("Pause BARRY for Midtown Auto Care.", k);
    expect(pending.language).toBe("en");
    expect(pending.answer).toMatch(/^Pause BARRY for Midtown Auto Care\?/);
    const done = await confirm(k);
    expect(done.language).toBe("en");
    expect(done.answer).toMatch(/^Done — pause BARRY for Midtown Auto Care\. Verified in the durable controls/);
    expect(done.verification).toMatch(/in the durable controls \(updated/);
  });

  it("the language is the ORIGINAL command's — a follow-up 'yes' in another language doesn't switch it", async () => {
    const k = key("mix");
    const pending = await ask("תשהה את Midtown", k);
    const done = await executeFounderCommand({ actor: founder, key: key("yes"), text: "yes", previousKey: pending.key });
    expect(done.answer).toMatch(HEBREW);
    expect((await getFounderCommand(k))?.language).toBe("he");
  });
});

describe("a used confirmation is shown as already done — never as a second execution", () => {
  it("replay: nothing runs again, no new audit, the original verification and timestamp are unchanged", async () => {
    const k = key("rp");
    await ask("תשהה את Midtown", k);
    const auditBefore = (await listControlAudit(GARAGE)).length;
    const first = await confirm(k);
    expect(first.replay).toBeUndefined();
    const stamp = (await loadControls(GARAGE)).updatedAt;
    const rec1 = await getFounderCommand(k);
    const again = await confirm(k);
    expect(again.replay).toBe(true);
    expect(again.duplicate).toBe(true);
    expect(again.status).toBe("executed");
    expect(again.answer).toMatch(/^כבר בוצע — האישור הזה כבר נוצל: Midtown Auto Care הושהה ב-/);
    expect(again.verification).toBe(first.verification);
    expect(again.items).toEqual([]);
    expect(again.followUps).toEqual([]);
    expect((await listControlAudit(GARAGE)).length).toBe(auditBefore + 1);
    expect((await loadControls(GARAGE)).updatedAt).toBe(stamp);
    const rec2 = await getFounderCommand(k);
    expect(rec2?.action?.confirmedAt).toBe(rec1?.action?.confirmedAt);
    expect(rec2?.updatedAt).toBe(rec1?.updatedAt);
    // English wording
    const p = key("rpp");
    await ask("Pause BARRY for Midtown Auto Care.", p);
    await applyControlChange(GARAGE, { pausedBusiness: false }, { by: "test", reason: "reset" });
    const done = await confirm(p);
    expect(done.status === "executed" || done.status === "no_change").toBe(true);
    const replayEn = await confirm(p);
    expect(replayEn.replay).toBe(true);
    expect(replayEn.answer).toMatch(/^Already done — this confirmation was already used: Midtown Auto Care was paused at .* Nothing ran again\.$/);
  });

  it("the replay doesn't claim the CURRENT state (it may have changed since): it says what that confirmation did, and when", async () => {
    const k = key("stale");
    await ask("Pause BARRY for Midtown Auto Care.", k);
    await confirm(k);
    await applyControlChange(GARAGE, { pausedBusiness: false }, { by: "test", reason: "resumed since" });
    const again = await confirm(k);
    expect(again.answer).not.toMatch(/is (?:already )?paused/);
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(false);
  });

  it("works through lost-response reconciliation: the recovered reply is the original result, not a replay", async () => {
    const k = key("lost");
    const deps = (lose: boolean): TransportDeps => ({
      sleep: async () => {},
      fetch: async (url, init) => {
        const u = `https://barry.example${url}`;
        const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
        if (init?.method === "POST") {
          const res = await POST(new Request(u, { method: "POST", headers, body: init.body as string }));
          if (lose) throw new TypeError("Load failed");
          return res;
        }
        return GET(new Request(u, { headers }));
      },
    });
    const pending = await sendFounderCommand<Reply>({ text: "תשהה את Midtown", key: k }, k, deps(false));
    expect(pending.kind === "reply" && pending.reply.status).toBe("needs_confirmation");
    const before = (await listControlAudit(GARAGE)).length;
    const out = await sendFounderCommand<Reply>({ confirmKey: k }, k, deps(true));
    expect(out.kind).toBe("reply");
    if (out.kind === "reply") {
      expect(out.recovered).toBe(true);
      expect(out.reply.status).toBe("executed");
      expect(out.reply.replay).toBeUndefined();
      expect(String(out.reply.answer)).toMatch(/^בוצע — /);
    }
    expect((await listControlAudit(GARAGE)).length).toBe(before + 1);
  });
});

describe("the UI shows it", () => {
  const base: Reply = { key: "fc_1", status: "needs_confirmation", answer: "השהיית BARRY עבור Midtown Auto Care?", items: [], followUps: ["Confirm"], proposalIds: [], intent: "founder_action", scope: { kind: "business", businessIds: ["garage"] }, confirmation: { key: "fc_1", title: "Pause BARRY for Midtown Auto Care", effect: "…", label: "השהיית BARRY עבור Midtown Auto Care" }, duplicate: false, language: "he" };
  const html = (r: Reply, confirmed = false) => renderToString(createElement(FounderReplyView, { reply: r, busy: false, confirmed, onConfirm: () => {}, onFollowUp: () => {} }));

  it("Hebrew confirmation: pill, button and label in Hebrew; business name untranslated", () => {
    const h = html(base);
    expect(h).toContain("דורש אישור");
    expect(h).toContain("אשר — השהיית BARRY עבור Midtown Auto Care");
    expect(html({ ...base, status: "executed", confirmation: undefined, answer: "בוצע — …" })).toContain("בוצע ואומת");
  });

  it("English stays English", () => {
    const h = html({ ...base, language: "en", confirmation: { ...base.confirmation!, label: undefined } });
    expect(h).toContain("Needs your confirmation");
    expect(h).toContain("Confirm — Pause BARRY for Midtown Auto Care");
  });

  it("a replay is badged 'already done' (not 'done · verified'); a spent Confirm button is disabled", () => {
    const rp = html({ ...base, status: "executed", confirmation: undefined, replay: true, duplicate: true, answer: "כבר בוצע — …" });
    expect(rp).toContain("כבר בוצע");
    expect(rp).not.toContain("בוצע ואומת");
    expect(html({ ...base, language: "en", status: "executed", confirmation: undefined, replay: true, answer: "Already done — …" })).toMatch(/data-testid="founder-pill"[^>]*>Already done</);
    const spent = html(base, true);
    expect(spent).toContain("אושר");
    expect(spent).toMatch(/<button[^>]*disabled=""[^>]*data-testid="founder-confirm"/);
  });
});
