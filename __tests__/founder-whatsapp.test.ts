import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { applyControlChange, listControlAudit, loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { parseWebhook } from "@/lib/channels/whatsapp";
import { createLinkCode } from "@/lib/owner-channel/identity";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import { createFounderLinkCode, listFounderIdentities } from "@/lib/founder-channel/identity";
import { FOUNDER_CONTEXT_TTL_MS, processFounderInbound, readFounderSession } from "@/lib/founder-channel/gateway";
import { getFounderCommand, listFounderCommands } from "@/lib/founder/command-service";
import { interpretFounder, resolveBusinesses } from "@/lib/founder/command";
import { fleetDirectory } from "@/lib/founder/command-service";
import type { OwnerInbound, OwnerOutbound, OwnerSender } from "@/lib/owner-channel/transport";
import { GET as linkGet, POST as linkPost } from "@/app/api/hq/founder/whatsapp/route";

/**
 * FOUNDER WHATSAPP V1 — the founder talks to Founder BARRY on WhatsApp through the SAME command service HQ uses
 * (interpretation → grounding → confirmation → audited founder control → verification). Only a verified founder
 * identity, linked with an HQ-issued one-time code, reaches it; owners and customers never do. Nothing is sent:
 * the founder line is a capturing fake / dry run.
 */

const TOKEN = "founder-whatsapp-test-token-long-enough-0001";
const RINA = "fashion-retailer";
const GARAGE = "garage";
let seq = 0;
const mid = () => `wamid.FWA${Date.now()}${seq++}`;
const phone = () => `97250${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const msg = (text: string, from: string, id = mid()): OwnerInbound => ({ channel: "whatsapp", messageId: id, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), text });
const tap = (actionId: string, from: string, id = mid()): OwnerInbound => ({ channel: "whatsapp", messageId: id, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), actionId });
function line(): OwnerSender & { sent: OwnerOutbound[] } {
  const sent: OwnerOutbound[] = [];
  return { channel: "whatsapp", mode: "live", sent, send: async (_to, m) => (sent.push(m), { providerMessageId: `fo_${sent.length}` }) };
}
const opts = { interpreter: null, composer: null } as const;

beforeAll(() => {
  process.env.BARRY_FOUNDER_TOKEN = TOKEN;
});
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
});
afterEach(async () => {
  for (const id of [RINA, GARAGE]) await applyControlChange(id, { pausedBusiness: false, safeMode: false, approvalRequiredForAll: false, pausedCapabilities: [], mode: "simulator" }, { by: "test", reason: "cleanup" });
  setLockStoreForTests(undefined);
});

async function founder() {
  const p = phone();
  const l = line();
  const { code } = await createFounderLinkCode();
  const r = await processFounderInbound(msg(`LINK ${code}`, p), l, opts);
  expect(r.status).toBe("linked");
  const say = async (text: string, id?: string) => {
    const out = await processFounderInbound(msg(text, p, id), l, opts);
    return { out, text: out.status === "processed" || out.status === "duplicate" ? out.outbound.text : "", reply: out.status === "processed" || out.status === "duplicate" ? out.reply : undefined };
  };
  return { phone: p, line: l, say, press: (actionId: string, id?: string) => processFounderInbound(tap(actionId, p, id), l, opts) };
}

describe("founder identity — explicit, verified, revocable; owners and customers never reach it", () => {
  it("an unknown number is rejected — it gets NO reply at all (the founder line may be live) and nothing runs", async () => {
    const l = line();
    const before = (await listFounderCommands(500)).length;
    const r = await processFounderInbound(msg("pause BARRY for Rina Studio", phone()), l, opts);
    expect(r.status).toBe("rejected");
    expect(l.sent).toHaveLength(0);
    expect((await listFounderCommands(500)).length).toBe(before);
    expect((await loadControls(RINA)).pausedBusiness).toBe(false);
  });

  it("a business owner's link (or an owner code) never becomes founder access", async () => {
    const p = phone();
    const { code } = await createLinkCode(RINA);
    expect((await processOwnerInbound(msg(`LINK ${code}`, p), line(), { businessIds: [RINA] })).status).toBe("linked");
    // The same verified number on the founder line: not a founder.
    expect((await processFounderInbound(msg("What do I need to know today?", p), line(), opts)).status).toBe("rejected");
    // An owner code redeemed on the founder line: refused.
    const again = await createLinkCode(RINA);
    expect((await processFounderInbound(msg(`LINK ${again.code}`, p), line(), opts)).status).toBe("rejected");
  });

  it("founder codes come only from HQ auth; single use; revocation and a rotated founder token end access", async () => {
    expect((await linkPost(new Request("https://x/api/hq/founder/whatsapp", { method: "POST", body: JSON.stringify({ action: "link_code" }), headers: { "content-type": "application/json" } }))).status).toBe(401);
    const res = await linkPost(new Request("https://x/api/hq/founder/whatsapp", { method: "POST", body: JSON.stringify({ action: "link_code" }), headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } }));
    const { code } = (await res.json()) as { code: string };
    const p = phone();
    expect((await processFounderInbound(msg(`LINK ${code}`, p), line(), opts)).status).toBe("linked");
    expect((await processFounderInbound(msg(`LINK ${code}`, phone()), line(), opts)).status).toBe("rejected"); // replayed by someone else
    const list = (await (await linkGet(new Request("https://x/api/hq/founder/whatsapp", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as { identities: { ref: string; number: string; active: boolean }[] };
    const mine = list.identities.find((i) => i.number === `···${p.slice(-4)}`)!;
    expect(mine.active).toBe(true);
    expect(JSON.stringify(list)).not.toContain(p);
    process.env.BARRY_FOUNDER_TOKEN = `${TOKEN}-rotated`;
    expect((await processFounderInbound(msg("What do I need to know today?", p), line(), opts)).status).toBe("rejected");
    process.env.BARRY_FOUNDER_TOKEN = TOKEN;
    expect((await processFounderInbound(msg("What do I need to know today?", p), line(), opts)).status).toBe("processed");
    const rv = await linkPost(new Request("https://x/api/hq/founder/whatsapp", { method: "POST", body: JSON.stringify({ action: "revoke", ref: mine.ref }), headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } }));
    expect(rv.status).toBe(200);
    expect((await processFounderInbound(msg("What do I need to know today?", p), line(), opts)).status).toBe("rejected");
  });

  it("the founder line is separate from customer and owner lines at the adapter (a number configured twice is never a founder line)", () => {
    const payload = (pn: string) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: pn }, messages: [{ id: `m-${pn}`, from: "972500000000", type: "text", text: { body: "pause BARRY for Rina" } }] } }] }] });
    const routes = { pn_customer: RINA };
    const f = parseWebhook(payload("pn_founder"), routes, ["pn_owner"], ["pn_founder"]);
    expect([f.founder.length, f.owner.length, f.messages.length]).toEqual([1, 0, 0]);
    const c = parseWebhook(payload("pn_customer"), routes, ["pn_owner"], ["pn_customer"]);
    expect([c.founder.length, c.messages.length]).toEqual([0, 1]);
    const o = parseWebhook(payload("pn_owner"), routes, ["pn_owner"], ["pn_owner"]);
    expect([o.founder.length, o.owner.length]).toEqual([0, 1]);
  });
});

describe("language — Hebrew and English map to the same founder intents", () => {
  const he: [string, object][] = [
    ["מה קורה היום?", { family: "fleet_read", topic: "brief" }],
    ["איזה עסק צריך אותי?", { family: "fleet_read", topic: "attention" }],
    ["יש תקלות?", { family: "incident_read", topic: "incidents" }],
    ["מי הכי קרוב לעלות לאוויר?", { family: "fleet_read", topic: "launch" }],
    ["יש אישורים שמחכים?", { family: "fleet_read", topic: "approvals" }],
    ["כמה אנחנו מוציאים על מודלים?", { family: "commercial_read", topic: "models" }],
    ["איזה עסק הכי יקר לנו לתפעל?", { family: "commercial_read", topic: "cost_to_serve" }],
  ];
  it.each(he)("%s", (t, intent) => expect(interpretFounder(t)).toMatchObject(intent));
  const withBiz: [string, object][] = [
    ["מה קורה אצל רינה?", { family: "business_inspect", followUp: "overview" }],
    ["והכסף שלה?", { family: "business_inspect", followUp: "money" }],
    ["מה ברי עושה שם עכשיו?", { family: "business_inspect", followUp: "overview" }],
    ["למה העסק הזה לא מוכן לעלות?", { family: "business_inspect", followUp: "readiness" }],
    ["תעצור את ברי אצל רינה", { family: "founder_action", action: "pause_business" }],
    ["תעצור שם את ברי", { family: "founder_action", action: "pause_business" }],
    ["תחזיר אותו לעבוד", { family: "founder_action", action: "resume_business" }],
    ["תדרוש אישור על כל פעולה משמעותית אצל העסק הזה", { family: "founder_action", action: "require_approval_on" }],
    ["תשהה את התשלומים שם", { family: "founder_action", action: "pause_capability", capability: "payments" }],
    ["תחזיר את התשלומים", { family: "founder_action", action: "resume_capability", capability: "payments" }],
    ["תעביר אותו למצב מפוקח", { family: "founder_action", action: "set_mode", mode: "supervised" }],
  ];
  it.each(withBiz)("%s (business in context)", (t, intent) => expect(interpretFounder(t, { hasBusiness: true })).toMatchObject(intent));
  const en: [string, object, boolean][] = [
    ["What do I need to know today?", { family: "fleet_read", topic: "brief" }, false],
    ["Which businesses need me?", { family: "fleet_read", topic: "attention" }, false],
    ["Who is closest to going live?", { family: "fleet_read", topic: "launch" }, false],
    ["How much are we spending on models?", { family: "commercial_read", topic: "models" }, false],
    ["Any approvals waiting?", { family: "fleet_read", topic: "approvals" }, false],
    ["and her money?", { family: "business_inspect", followUp: "money" }, true],
    ["Why isn't it ready to go live?", { family: "business_inspect", followUp: "readiness" }, true],
    ["Require approval for every consequential action there", { family: "founder_action", action: "require_approval_on" }, true],
    ["Pause payments there", { family: "founder_action", action: "pause_capability", capability: "payments" }, true],
    ["Resume payments", { family: "founder_action", action: "resume_capability", capability: "payments" }, true],
    ["Switch it to supervised mode", { family: "founder_action", action: "set_mode", mode: "supervised" }, true],
  ];
  it.each(en)("%s", (t, intent, hasBusiness) => expect(interpretFounder(t, { hasBusiness })).toMatchObject(intent));

  it("a Hebrew business alias grounds (with attached prepositions); an ambiguous word is never guessed", () => {
    const dir = fleetDirectory();
    expect(resolveBusinesses("מה קורה אצל רינה?", dir).matched.map((b) => b.id)).toEqual([RINA]);
    expect(resolveBusinesses("תעצור את ברי לרינה", dir).matched.map((b) => b.id)).toEqual([RINA]);
    const twins = [{ id: "a-1", name: "Blue Studio" }, { id: "b-2", name: "Blue Garage" }];
    expect(resolveBusinesses("pause blue", twins)).toMatchObject({ matched: [], ambiguous: [{ word: "blue" }] });
  });
});

describe("conversation — the business in focus carries follow-ups; it expires; fleet topics clear it", () => {
  it("“מה קורה אצל רינה?” → “והכסף שלה?” → “תעצור שם את ברי” → Confirm: pauses exactly Rina, audited before → after", async () => {
    const f = await founder();
    const a = await f.say("מה קורה אצל רינה?");
    expect(a.reply?.scope).toEqual({ kind: "business", businessIds: [RINA] });
    const m = await f.say("והכסף שלה?");
    expect(m.reply?.intent).toBe("business_inspect");
    expect(m.reply?.scope.businessIds).toEqual([RINA]);
    expect(m.text).toMatch(/Rina Studio/);
    const p = await f.say("תעצור שם את ברי");
    expect(p.reply?.status).toBe("needs_confirmation");
    expect(p.text).toContain("Rina Studio");
    expect((await loadControls(RINA)).pausedBusiness).toBe(false); // not before confirmation
    const button = p.out.status === "processed" ? p.out.outbound.actions![0] : undefined;
    expect(button?.title).toBe("אשר");
    const done = await f.press(button!.id);
    expect(done.status).toBe("processed");
    expect((await loadControls(RINA)).pausedBusiness).toBe(true);
    expect((await loadControls(GARAGE)).pausedBusiness).toBe(false);
    if (done.status === "processed") expect(done.outbound.text).toMatch(/לפני → אחרי: false → true/);
    const audit = (await listControlAudit(RINA))[0];
    expect(audit.by).toBe(`founder (Founder BARRY, WhatsApp ···${f.phone.slice(-4)})`);
    expect(audit.before.pausedBusiness).toBe(false);
    expect(audit.after.pausedBusiness).toBe(true);
    // The same button again: a replay — nothing runs, no second audit.
    const auditCount = (await listControlAudit(RINA)).length;
    await f.press(button!.id);
    expect((await listControlAudit(RINA)).length).toBe(auditCount);
    // "תחזיר אותו לעבוד" → "כן" resumes the founder pause (same business, confirmed by text).
    const r = await f.say("תחזיר אותו לעבוד");
    expect(r.reply?.status).toBe("needs_confirmation");
    await f.say("כן");
    expect((await loadControls(RINA)).pausedBusiness).toBe(false);
  });

  it("an unrelated fleet question clears the focus — a later “pause there” asks which business", async () => {
    const f = await founder();
    await f.say("What's going on with Rina Studio?");
    await f.say("What do I need to know today?");
    const p = await f.say("Pause BARRY there");
    expect(p.reply?.status).toBe("clarify");
    expect((await loadControls(RINA)).pausedBusiness).toBe(false);
  });

  it("expired context can't be used to mutate state", async () => {
    const f = await founder();
    await f.say("What's going on with Rina Studio?");
    const late = new Date(Date.now() + FOUNDER_CONTEXT_TTL_MS + 60_000);
    const r = await processFounderInbound(msg("Pause BARRY there", f.phone), f.line, { ...opts, now: late });
    expect(r.status === "processed" && r.reply.status).toBe("clarify");
    expect((await loadControls(RINA)).pausedBusiness).toBe(false);
  });

  it("a stale “yes” (no pending confirmation) changes nothing", async () => {
    const f = await founder();
    const y = await f.say("yes");
    expect(y.reply?.status).toBe("refused");
  });

  it("a Confirm button from another founder identity is refused", async () => {
    const a = await founder();
    const b = await founder();
    const p = await a.say("Pause BARRY for Rina Studio");
    const id = p.out.status === "processed" ? p.out.outbound.actions![0].id : "";
    const r = await b.press(id);
    expect(r.status).toBe("rejected");
    expect((await loadControls(RINA)).pausedBusiness).toBe(false);
  });
});

describe("mutations — the existing founder controls, confirmed, tenant-scoped, audited, verified", () => {
  it("require approval for everything / pause + resume a capability / switch to supervised — each through applyControlChange", async () => {
    const f = await founder();
    await f.say("What's going on with Rina Studio?");
    for (const [ask, check] of [
      ["Require approval for every consequential action there", async () => expect((await loadControls(RINA)).approvalRequiredForAll).toBe(true)],
      ["Pause payments there", async () => expect((await loadControls(RINA)).pausedCapabilities).toEqual(["payments.*"])],
      ["Resume payments", async () => expect((await loadControls(RINA)).pausedCapabilities).toEqual([])],
      ["Switch it to supervised mode", async () => expect((await loadControls(RINA)).mode).toBe("supervised")],
    ] as const) {
      const p = await f.say(ask);
      expect(p.reply?.status, ask).toBe("needs_confirmation");
      await f.say("yes");
      await check();
    }
    const audit = await listControlAudit(RINA);
    expect(audit.slice(0, 4).every((a) => a.by.includes("WhatsApp"))).toBe(true);
    expect((await loadControls(GARAGE)).approvalRequiredForAll).toBe(false);
  });

  it("LIVE is never switched from a conversation; a loosening control says so", async () => {
    const f = await founder();
    await f.say("What's going on with Rina Studio?");
    const live = await f.say("Switch it to live mode");
    expect(live.reply?.status).toBe("clarify");
    expect((await loadControls(RINA)).mode).toBe("simulator");
    await applyControlChange(RINA, { approvalRequiredForAll: true }, { by: "test", reason: "setup" });
    const off = await f.say("Lift approval for everything at Rina Studio");
    expect(off.text).toMatch(/LOOSENS/);
  });

  it("an owner pause and a founder pause: the founder can resume a founder pause; an owner cannot (existing rule)", async () => {
    const f = await founder();
    await f.say("Pause BARRY for Rina Studio");
    await f.say("yes");
    expect((await loadControls(RINA)).pausedBy).toMatch(/Founder BARRY, WhatsApp/);
    const { ownerResume } = await import("@/lib/owner/mode");
    const { resolveBusinessGraph } = await import("@/lib/business-graph-repository");
    await expect(ownerResume(resolveBusinessGraph(RINA), "the owner (web)")).rejects.toThrow(/BARRY team paused/);
  });

  it("a duplicate inbound message id runs once and isn't answered twice", async () => {
    const f = await founder();
    const id = mid();
    await f.say("Pause BARRY for Rina Studio", id);
    const sent = f.line.sent.length;
    const again = await f.say("Pause BARRY for Rina Studio", id);
    expect(again.out.status).toBe("duplicate");
    expect(f.line.sent.length).toBe(sent);
    const yesId = mid();
    await f.say("yes", yesId);
    const audits = (await listControlAudit(RINA)).length;
    await f.say("yes", yesId);
    expect((await listControlAudit(RINA)).length).toBe(audits);
  });

  it("every founder command is a durable trace with the WhatsApp identity", async () => {
    const f = await founder();
    const r = await f.say("Which businesses need me?");
    const rec = await getFounderCommand(r.reply!.key);
    expect(rec?.founder).toBe(`founder (whatsapp ···${f.phone.slice(-4)})`);
    expect(rec?.trace[0]).toMatchObject({ step: "identity", outcome: "ok" });
    expect((await readFounderSession((await listFounderIdentities()).find((l) => l.channelUserId === f.phone)!.id)).lastKey).toBe(r.reply!.key);
  });
});

describe("reads — the same read models HQ shows; truthful money and cost", () => {
  it("fleet brief, attention, incidents, readiness, launch ranking, approvals, money, model cost", async () => {
    const f = await founder();
    for (const q of ["מה קורה היום?", "Which businesses need me?", "יש תקלות?", "מי הכי קרוב לעלות לאוויר?", "Any approvals waiting?", "Why isn't Rina Studio ready to go live?", "How much are we spending on models?", "What's going on with Rina Studio?", "and her money?"]) {
      const r = await f.say(q);
      expect(r.out.status, q).toBe("processed");
      expect(r.text.length, q).toBeGreaterThan(10);
      expect(r.reply?.status, q).not.toBe("failed");
    }
    const money = await f.say("and her money?");
    expect(money.text).toMatch(/nothing estimated/);
    expect(money.text).not.toMatch(/recovered \d/);
    const ready = await f.say("Why isn't Rina Studio ready to go live?");
    expect(ready.text).toMatch(/launch gate/);
    const models = await f.say("How much are we spending on models?");
    expect(models.text).toMatch(/No metered model usage|ESTIMATED|measured/);
  });
});

describe("proactive founder notifications — meaningful, coalesced, never twice, truthful about delivery", () => {
  const items = (keys: string[]) => keys.map((k) => ({ key: k, category: "critical_incident" as const, businessId: RINA, businessName: "Rina Studio", text: `Rina Studio: incident ${k}` }));

  it("new items → ONE coalesced message per founder; the same items never again; a new item alone next time", async () => {
    const { notifyFounderAlerts, listFounderNotices } = await import("@/lib/founder-channel/alerts");
    const f = await founder();
    await f.say("What do I need to know today?"); // inside the 24h window
    const out = line();
    const ref = (await import("@/lib/founder-channel/identity")).founderRef((await listFounderIdentities()).find((l) => l.channelUserId === f.phone)!.id);
    const first = (await notifyFounderAlerts({ sender: out, items: items(["a1", "a2"]) })).filter((n) => n.ref === ref);
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("sent"); // the capturing fake line; nothing really leaves the test
    expect(first[0].text).toMatch(/2 system-level things/);
    expect((await notifyFounderAlerts({ sender: out, items: items(["a1", "a2"]) })).filter((n) => n.ref === ref)).toHaveLength(0);
    const third = (await notifyFounderAlerts({ sender: out, items: items(["a1", "a2", "a3"]) })).filter((n) => n.ref === ref);
    expect(third).toHaveLength(1);
    expect(third[0].items).toEqual(["a3"]);
    expect((await listFounderNotices()).filter((n) => n.ref === ref && n.kind === "alert")).toHaveLength(2);
  });

  it("dry run records, never sends; outside the 24-hour window it is recorded as blocked, truthfully", async () => {
    const { notifyFounderAlerts } = await import("@/lib/founder-channel/alerts");
    const f = await founder();
    const dry: OwnerSender & { sent: number } = { channel: "whatsapp", mode: "dry_run", sent: 0, send: async () => ((dry.sent += 1), {}) };
    const ref = (await import("@/lib/founder-channel/identity")).founderRef((await listFounderIdentities()).find((l) => l.channelUserId === f.phone)!.id);
    const d = (await notifyFounderAlerts({ sender: dry, items: items([`d-${f.phone}`]) })).filter((n) => n.ref === ref);
    expect(d[0].status).toBe("dry_run");
    expect(dry.sent).toBe(0);
    const late = new Date(Date.now() + 25 * 3600_000);
    const b = (await notifyFounderAlerts({ sender: line(), now: late, items: items([`late-${f.phone}`]) })).filter((n) => n.ref === ref);
    expect(b[0]).toMatchObject({ status: "blocked", reason: expect.stringMatching(/24-hour window/) });
  });

  it("transitions are read against the durable watch: a steady state never re-alerts", async () => {
    const { founderAlertItems } = await import("@/lib/founder-channel/alerts");
    const first = await founderAlertItems({ observe: true, launch: false });
    const again = await founderAlertItems({ observe: true, launch: false });
    const transitions = (xs: { category: string }[]) => xs.filter((x) => x.category === "blocked" || x.category === "launch_ready" || x.category === "launch_regressed");
    expect(transitions(again)).toHaveLength(0);
    expect(Array.isArray(first)).toBe(true);
  });
});
