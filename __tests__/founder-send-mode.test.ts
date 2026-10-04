import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { getConversationStore } from "@/lib/state";
import { readDeliveries } from "@/lib/channels/gateway";
import { whatsappConfig, whatsappFounderConfig, whatsappOwnerConfig, whatsappOwnerSender, whatsappSendModes, whatsappSender, whatsappFounderSender } from "@/lib/channels/whatsapp";
import { createLinkCode } from "@/lib/owner-channel/identity";
import { listCommandRecords } from "@/lib/owner/command-service";
import { createFounderLinkCode } from "@/lib/founder-channel/identity";
import { listFounderCommands } from "@/lib/founder/command-service";
import { POST } from "@/app/api/channels/whatsapp/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * FOUNDER-ONLY LIVE SENDING. BARRY_WHATSAPP_FOUNDER_SEND=live makes the founder line live while customer and owner
 * lines keep following BARRY_WHATSAPP_SEND=dry_run. Driven through the real signed webhook route; the Graph API is a
 * stub that records every call — a real send would show up there, so "nothing else was sent" is checked, not assumed.
 */

const SECRET = "test-app-secret-founder-send";
const RINA = "fashion-retailer";
const ENV = {
  WHATSAPP_APP_SECRET: SECRET,
  WHATSAPP_ACCESS_TOKEN: "test-access-token",
  WHATSAPP_VERIFY_TOKEN: "v",
  BARRY_WHATSAPP_ROUTES: `PN_CUSTOMER=${RINA}`,
  BARRY_WHATSAPP_OWNER_NUMBERS: "PN_OWNER",
  BARRY_WHATSAPP_FOUNDER_NUMBERS: "PN_FOUNDER",
  BARRY_WHATSAPP_SEND: "dry_run",
  BARRY_WHATSAPP_FOUNDER_SEND: "live",
  BARRY_OWNER_TOKEN: "test-owner-token-0123456789",
  BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ",
};
const saved = { ...process.env };
let calls: { phoneNumberId: string; to: string }[] = [];
let seq = 0;
const phone = () => `97252${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

beforeEach(() => {
  Object.assign(process.env, ENV);
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
  setReasonerForTests(new ScriptedModel(() => undefined));
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    const m = String(url).match(/graph\.facebook\.com\/[^/]+\/([^/]+)\/messages/);
    if (m) {
      calls.push({ phoneNumberId: decodeURIComponent(m[1]), to: (JSON.parse(init?.body ?? "{}") as { to?: string }).to ?? "" });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${calls.length}` }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setReasonerForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

/** A signed Meta webhook carrying ONE text message to `pnid` from `from`. */
async function deliver(pnid: string, from: string, text: string, id = `wamid.in.${Date.now()}.${seq++}`) {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: pnid }, contacts: [{ wa_id: from, profile: { name: "Test" } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
  const sig = `sha256=${crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
  const res = await POST(new NextRequest("https://x/api/channels/whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }));
  return { status: res.status, body: (await res.json()) as { founder?: string[]; owner?: string[] }, id };
}
async function linkFounder() {
  const p = phone();
  const { code } = await createFounderLinkCode();
  const r = await deliver("PN_FOUNDER", p, `LINK ${code}`);
  expect(r.body.founder).toEqual(["linked"]);
  return p;
}

describe("three send modes, separately", () => {
  it("founder live leaves customer and owner dry run; the status shows all three", () => {
    expect(whatsappSendModes()).toEqual({ customer: "dry_run", owner: "dry_run", founder: "live", ownerLine: "configured", founderLine: "configured" });
    expect(whatsappSender().mode).toBe("dry_run");
    expect(whatsappOwnerSender().mode).toBe("dry_run");
    expect(whatsappFounderSender().mode).toBe("live");
    // Only the exact word "live" turns it on; anything else is dry run.
    process.env.BARRY_WHATSAPP_FOUNDER_SEND = "LIVE ";
    expect(whatsappFounderConfig().sendMode).toBe("dry_run");
    delete process.env.BARRY_WHATSAPP_FOUNDER_SEND;
    expect(whatsappFounderConfig().sendMode).toBe("dry_run");
  });

  it("(1) founder live + customer dry_run: in ONE webhook, only the founder reply reaches the Graph API — from the founder line, to the founder", async () => {
    const founder = await linkFounder();
    calls = [];
    const cust = phone();
    const r1 = await deliver("PN_FOUNDER", founder, "What do I need to know today?");
    const r2 = await deliver("PN_CUSTOMER", cust, "Hi, do you have the Midnight Wrap Dress?");
    expect(r1.body.founder).toEqual(["processed"]);
    expect(r2.status).toBe(200);
    expect(calls).toEqual([{ phoneNumberId: "PN_FOUNDER", to: founder }]);
    const convo = await getConversationStore().get(`wa:${RINA}:${cust}`);
    expect(convo?.messages.some((m) => m.role === "barry")).toBe(true);
    expect(readDeliveries(convo!.knownFields).every((d) => d.status === "dry_run")).toBe(true);
  });

  it("(2) founder live + owner dry_run: a verified owner's command is answered in dry run — no Graph call", async () => {
    const owner = phone();
    const { code } = await createLinkCode(RINA);
    await deliver("PN_OWNER", owner, `LINK ${code}`);
    calls = [];
    const r = await deliver("PN_OWNER", owner, "What needs me?");
    expect(r.body.owner).toEqual(["processed"]);
    expect(calls).toEqual([]);
    const rec = (await listCommandRecords(RINA)).find((c) => c.text === "What needs me?");
    expect(rec?.delivery?.status).toBe("dry_run");
  });

  it("(3) the customer line can't inherit founder live — even the founder's own number writing to it is a dry-run customer", async () => {
    const founder = await linkFounder();
    calls = [];
    expect(whatsappConfig().sendMode).toBe("dry_run");
    await deliver("PN_CUSTOMER", founder, "Pause BARRY for Rina Studio");
    expect(calls).toEqual([]);
    expect((await loadControls(RINA)).pausedBusiness).toBe(false);
    expect((await getConversationStore().get(`wa:${RINA}:${founder}`))?.messages[0]).toMatchObject({ role: "customer" });
  });

  it("(4) the owner line can't inherit founder live — and a number configured as both is an owner line only (dry run)", async () => {
    process.env.BARRY_WHATSAPP_FOUNDER_NUMBERS = "PN_FOUNDER,PN_OWNER";
    expect(whatsappOwnerConfig().sendMode).toBe("dry_run");
    expect(whatsappFounderConfig().numbers).toEqual(["PN_FOUNDER"]);
    const founder = await linkFounder();
    calls = [];
    const r = await deliver("PN_OWNER", founder, "What do I need to know today?");
    expect(r.body.founder).toEqual([]);
    expect(r.body.owner).toEqual(["rejected"]); // not a linked owner — and the owner line's reply is dry run
    expect(calls).toEqual([]);
  });

  it("(5) an unknown sender on the founder line gets nothing back and nothing privileged runs", async () => {
    const before = (await listFounderCommands(500)).length;
    const r = await deliver("PN_FOUNDER", phone(), "Pause BARRY for Rina Studio");
    expect(r.body.founder).toEqual(["rejected"]);
    expect(calls).toEqual([]);
    expect((await listFounderCommands(500)).length).toBe(before);
    expect((await loadControls(RINA)).pausedBusiness).toBe(false);
    // A wrong link code from an unknown number: also no reply.
    await deliver("PN_FOUNDER", phone(), "LINK FAAAAAAAAA");
    expect(calls).toEqual([]);
  });

  it("(6) a duplicate founder inbound (Meta retry) is processed once and answered once", async () => {
    const founder = await linkFounder();
    calls = [];
    const id = `wamid.dup.${Date.now()}`;
    await deliver("PN_FOUNDER", founder, "Which businesses need me?", id);
    await deliver("PN_FOUNDER", founder, "Which businesses need me?", id);
    expect(calls).toHaveLength(1);
    expect((await listFounderCommands(500)).filter((c) => c.key === `whatsapp:${id}`)).toHaveLength(1);
  });
});
