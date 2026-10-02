import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "@/lib/fabric";
import { GET, POST } from "@/app/api/hq/founder/command/route";
import { applyControlChange, listControlAudit, loadControls } from "@/lib/hq/controls";
import { getBackend } from "@/lib/store";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import { lookupFounderReply } from "@/lib/founder/command-service";
import { MESSAGES, NOT_RECEIVED_AFTER_MS, recoverFounderReply, sendFounderCommand, type TransportDeps } from "@/lib/founder/reconcile";
import { languageProblem, voice, type FounderEnvelope } from "@/lib/founder/voice";
import { briefStories, founderBrief, loadFounderFleet, type BriefItem } from "@/lib/founder/read-model";
import { itemsMode } from "@/lib/founder/presentation";
import { FounderReplyView, type Reply } from "@/components/hq/FounderCommand";

/**
 * LIVE GATE REPAIR (iPhone, Preview, 2026-10-02):
 *  1. "Load failed" although the server finished and persisted the command (21 s request; the phone dropped the
 *     response) → the client recovers the reply by its pre-generated key; it never sends the command again.
 *  2. A Hebrew question answered entirely in English by the composer → language check + one constrained repair.
 *  3. The answer duplicated by a raw item dump → items under "Details", answer primary.
 *  4. The daily brief listed a demo tenant and split one business into separate bullets → real businesses only,
 *     one paragraph per business from the same facts.
 */
const TOKEN = "founder-test-token-that-is-long-enough-123456";
beforeAll(() => {
  process.env.BARRY_FOUNDER_TOKEN = TOKEN;
});
const GARAGE = "garage";
afterEach(async () => {
  if ((await loadControls(GARAGE)).pausedBusiness) await applyControlChange(GARAGE, { pausedBusiness: false }, { by: "test", reason: "cleanup" });
});

const auth = { authorization: `Bearer ${TOKEN}` };
/** A transport where the SERVER really runs (route handlers) but the phone can lose the POST's response. */
function transport(opts: { losePostResponse?: boolean; dropPostBeforeServer?: boolean } = {}) {
  const calls = { post: 0, get: 0 };
  const deps: TransportDeps = {
    sleep: async () => {},
    fetch: async (url, init) => {
      const u = `https://barry.example${url}`;
      if (init?.method === "POST") {
        calls.post++;
        if (opts.dropPostBeforeServer) throw new TypeError("Load failed");
        const res = await POST(new Request(u, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: init.body as string }));
        if (opts.losePostResponse) throw new TypeError("Load failed"); // the server finished; the phone never got it
        return res;
      }
      calls.get++;
      return GET(new Request(u, { headers: auth }));
    },
  };
  return { deps, calls };
}
const commandsWithKey = async (key: string) => (await getBackend().listOperatorRecords(FLEET_SCOPE, "founder_command")).filter((r) => r.key === key).length;

describe("1. lost responses are recovered by key — never re-sent", () => {
  it("normal request: the reply comes straight back", async () => {
    const key = `fc_ok_${Date.now()}`;
    const { deps, calls } = transport();
    const out = await sendFounderCommand<Reply>({ text: "What's going on with Rina?", key }, key, deps);
    expect(out).toMatchObject({ kind: "reply", recovered: false });
    expect(calls.get).toBe(0);
  });

  it("server persisted, client lost the response → the SAME key is recovered, the command exists once", async () => {
    const key = `fc_lost_${Date.now()}`;
    let recovering = false;
    const { deps, calls } = transport({ losePostResponse: true });
    const out = await sendFounderCommand<Reply>({ text: "What's going on with Rina?", key }, key, { ...deps, onRecovering: () => (recovering = true) });
    expect(recovering).toBe(true);
    expect(out.kind).toBe("reply");
    if (out.kind === "reply") {
      expect(out.recovered).toBe(true);
      expect(out.reply.key).toBe(key);
      expect(out.reply.status).toBe("answered");
      expect(String(out.reply.answer)).toMatch(/^Rina Studio /);
    }
    expect(calls.post).toBe(1); // never re-sent
    expect(await commandsWithKey(key)).toBe(1);
  });

  it("a confirmed control whose response is lost executes exactly once and is recovered verified", async () => {
    const key = `fc_ctl_${Date.now()}`;
    const ask = await sendFounderCommand<Reply>({ text: "Pause BARRY for Midtown Auto Care.", key }, key, transport().deps);
    expect(ask.kind === "reply" && ask.reply.status).toBe("needs_confirmation");
    const before = (await listControlAudit(GARAGE)).length;
    const { deps, calls } = transport({ losePostResponse: true });
    const out = await sendFounderCommand<Reply>({ confirmKey: key }, key, deps);
    expect(out.kind === "reply" && out.reply.status).toBe("executed");
    expect(out.kind === "reply" && out.reply.verification).toMatch(/pausedBusiness = true/);
    expect(calls.post).toBe(1);
    expect((await listControlAudit(GARAGE)).length).toBe(before + 1);
    // Recovering again (a second "Check again") reads; it never confirms twice.
    await recoverFounderReply<Reply>(key, transport().deps);
    expect((await listControlAudit(GARAGE)).length).toBe(before + 1);
  });

  it("a request that never reached the server ends in a clear failure (bounded), and nothing was recorded", async () => {
    const key = `fc_never_${Date.now()}`;
    const out = await sendFounderCommand<Reply>({ text: "What's going on with Rina?", key }, key, transport({ dropPostBeforeServer: true }).deps);
    expect(out).toEqual({ kind: "error", message: MESSAGES.notReceived });
    expect(await commandsWithKey(key)).toBe(0);
    expect(NOT_RECEIVED_AFTER_MS).toBeGreaterThan(0);
  });

  it("a still-running command is not settled; reconciliation never adopts another command's reply", async () => {
    const key = `fc_running_${Date.now()}`;
    await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "founder_command", key, data: { key, founder: "founder (test)", text: "x", intent: { family: "fleet_read", topic: "brief" }, interpretedBy: "rules", scope: { kind: "fleet", businessIds: [] }, resolution: { matched: [], ambiguous: [] }, grounded: [], authority: "read", status: "received", answer: "", items: [], followUps: [], proposalIds: [], trace: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    expect(await lookupFounderReply(key)).toMatchObject({ found: true, settled: false });
    expect(await recoverFounderReply<Reply>(key, transport().deps)).toEqual({ kind: "lost", message: MESSAGES.lost });
    const crossed: TransportDeps = { sleep: async () => {}, fetch: async () => Response.json({ found: true, settled: true, reply: { key: "fc_someone_else", status: "answered" } }) };
    expect((await recoverFounderReply<Reply>(key, crossed)).kind).toBe("lost");
  });

  it("an expired session is a clear error, not an endless recovery", async () => {
    const deps: TransportDeps = { sleep: async () => {}, fetch: async () => new Response("{}", { status: 401 }) };
    expect(await sendFounderCommand<Reply>({ text: "hi", key: "fc_x_12345678" }, "fc_x_12345678", deps)).toEqual({ kind: "error", message: MESSAGES.session });
  });

  it("GET ?key is founder-only and read-only", async () => {
    expect((await GET(new Request("https://barry.example/api/hq/founder/command?key=fc_anything"))).status).toBe(401);
    expect((await GET(new Request("https://barry.example/api/hq/founder/command?key=fc_missing_key_123", { headers: auth }))).status).toBe(404);
  });
});

describe("2. the reply is in the founder's language", () => {
  const env = (over: Partial<FounderEnvelope> = {}): FounderEnvelope => ({ question: "מה קורה עם Midtown?", language: "he", intent: "business_inspect", status: "answered", grounded: "Midtown Auto Care is healthy. No open incidents above low; no customer conversations in the last 24 hours. The google-calendar connection needs re-verification (low).", items: [], done: [], notDone: [], confirmationRequired: null, nothingSent: true, proposals: [], businessesInScope: ["Midtown Auto Care"], followUps: [], ...over });
  const FLEET = ["Rina Studio", "Midtown Auto Care"];

  it("Hebrew → Hebrew passes, including English business names and technical words", () => {
    expect(languageProblem("ב-Midtown Auto Care הכול תקין: אין תקלות פתוחות ואין שיחות עם לקוחות ב-24 השעות האחרונות. החיבור ל-google-calendar צריך אימות מחדש, אבל זה לא דחוף.", env(), FLEET)).toBeUndefined();
    expect(languageProblem("Rina Studio צריכה תשומת לב: יש שיחות שמחכות להחלטה של הבעלים, ו-checkout אחד נכשל.", env({ businessesInScope: ["Rina Studio"] }), FLEET)).toBeUndefined();
  });

  it("English → English passes; occasional Hebrew proper nouns are fine", () => {
    expect(languageProblem("Midtown Auto Care is healthy — no open incidents and no customer conversations in the last 24 hours.", env({ language: "en", question: "What's going on with Midtown?" }), FLEET)).toBeUndefined();
  });

  it("a fully English reply to a Hebrew question is rejected (the live failure)", () => {
    expect(languageProblem("Midtown Auto Care is healthy. There are no open incidents above low, and nothing is waiting on the owner. There have been no conversations in the last 24 hours.", env(), FLEET)).toMatch(/mostly English/);
    expect(languageProblem("ב-Midtown הכול תקין.\nThe scheduling connection with Google Calendar needs re-verification, but it's a low priority and nothing is waiting on the owner today.", env(), FLEET)).toMatch(/English/);
  });

  it("one constrained repair: wrong language → rewritten in Hebrew → shown only if every truth check passes again", async () => {
    let calls = 0;
    const fixed = await voice(env(), async (_e, opts) => {
      calls++;
      return opts?.repair ? "ב-Midtown Auto Care הכול תקין: אין תקלות פתוחות ואין שיחות עם לקוחות ב-24 השעות האחרונות. החיבור ל-google-calendar צריך אימות מחדש." : "Midtown Auto Care is healthy, with no open incidents and no customer conversations in the last 24 hours. The calendar connection needs re-verification.";
    }, FLEET);
    expect(calls).toBe(2);
    expect(fixed.source).toBe("composer");
    expect(fixed.reason).toMatch(/language repaired/);
    // The repair may not smuggle in a new number, business or action.
    for (const sneaky of ["ב-Midtown Auto Care יש 7 תקלות פתוחות ב-24 השעות האחרונות, וגם החיבור ל-google-calendar צריך אימות מחדש.", "ב-Midtown Auto Care ו-Rina Studio הכול תקין ב-24 השעות האחרונות, החיבור ל-google-calendar צריך אימות.", "השהיתי את Midtown Auto Care כי החיבור ל-google-calendar צריך אימות מחדש ב-24 השעות האחרונות."]) {
      const out = await voice(env(), async (_e, opts) => (opts?.repair ? sneaky : "Midtown Auto Care is healthy, with no open incidents and no customer conversations in the last 24 hours. The calendar connection needs re-verification."), FLEET);
      expect(out.source, sneaky).toBe("grounded");
      expect(out.reason).toMatch(/repair rejected/);
    }
  });

  it("a truth failure gets no second chance", async () => {
    let calls = 0;
    const out = await voice(env(), async () => (calls++, "ב-Midtown Auto Care יש 12 שיחות שמחכות לבעלים וגם תקלה פתוחה ב-24 השעות האחרונות."), FLEET);
    expect(calls).toBe(1);
    expect(out.source).toBe("grounded");
  });
});

describe("3. answer first, details one tap away", () => {
  const base: Reply = { key: "fc_1", status: "answered", answer: "Rina Studio is the main thing I'd look at first — it needs attention.", items: [{ title: "Rina Studio needs attention", detail: "4 conversations waiting on the owner.", href: "/hq/fashion-retailer?view=attention" }], followUps: ["Why?"], proposalIds: [], intent: "fleet_read", scope: { kind: "fleet", businessIds: [] }, duplicate: false };
  const html = (r: Reply) => renderToString(createElement(FounderReplyView, { reply: r, busy: false, onConfirm: () => {}, onFollowUp: () => {} }));

  it("an answered turn shows the answer, with the items collapsed under Details (links still reachable)", () => {
    const h = html(base);
    expect(itemsMode("answered", 1)).toBe("details");
    expect(h).toMatch(/<details[^>]*data-testid="founder-details"/);
    expect(h).not.toMatch(/<details[^>]*open/);
    expect(h).toContain('href="/hq/fashion-retailer?view=attention"');
    expect(h.indexOf("main thing I&#x27;d look at first")).toBeLessThan(h.indexOf("founder-details"));
  });

  it("a confirmation stays prominent (no item dump); a proposal's items stay open", () => {
    const confirm = html({ ...base, status: "needs_confirmation", confirmation: { key: "fc_1", title: "Pause BARRY for Midtown Auto Care", effect: "…" } });
    expect(confirm).toMatch(/data-testid="founder-confirm"/);
    expect(confirm).not.toMatch(/founder-details/);
    expect(itemsMode("proposed", 1)).toBe("open");
    expect(html({ ...base, status: "proposed", proposalIds: ["prop_1"] })).not.toMatch(/founder-details/);
  });
});

describe("4. the daily brief is a chief of staff's, about real businesses", () => {
  it("demo / simulated tenants are left out of the brief (named in excludedDemo), by canonical demo metadata", async () => {
    const view = await loadFounderFleet();
    const demo = view.businesses.find((b) => b.demo);
    expect(demo).toBeDefined();
    const loud = { ...view, businesses: view.businesses.map((b) => (b.demo ? { ...b, founderHealth: { state: "degraded" as const, words: "degraded", reasons: ["AI unavailable."] } } : b)) };
    const brief = founderBrief(loud);
    expect(brief.items.some((i) => i.businessId === demo!.id)).toBe(false);
    expect(brief.excludedDemo).toContain(demo!.name);
    expect(brief.healthy).not.toContain(demo!.name);
  });

  it("one business's facts become ONE paragraph, every fact and number kept, most important first", () => {
    const items: BriefItem[] = [
      { key: "health:r", severity: "medium", kind: "health", businessId: "r", businessName: "Rina Studio", title: "Rina Studio needs attention", why: "Cart change failed (medium). 4 conversations waiting on the owner. ₪390 at risk.", move: "", href: "" },
      { key: "initiative:r", severity: "low", kind: "initiative", businessId: "r", businessName: "Rina Studio", title: "BARRY noticed 2 things worth acting on at Rina Studio", why: "8 unpaid payment links; Customers keep asking about returns", move: "", href: "" },
      { key: "health:m", severity: "low", kind: "health", businessId: "m", businessName: "Midtown Auto Care", title: "Midtown Auto Care is still paused", why: "Paused by founder.", move: "", href: "" },
    ];
    const stories = briefStories(items);
    expect(stories.map((s) => s.businessName)).toEqual(["Rina Studio", "Midtown Auto Care"]);
    const rina = stories[0].text;
    expect(rina).toMatch(/^Rina Studio is the main thing I'd look at first — it needs attention\./);
    for (const fact of ["Cart change failed (medium).", "4 conversations waiting on the owner.", "₪390 at risk.", "8 unpaid payment links", "Customers keep asking about returns"]) expect(rina).toContain(fact);
    expect(rina.match(/Rina Studio/g)).toHaveLength(1);
    expect(stories[1].text).toBe("Midtown Auto Care is still paused. Paused by founder.");
  });
});
