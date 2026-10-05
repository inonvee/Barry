import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { getConversationStore } from "@/lib/state";
import { whatsappConfig, whatsappOwnerConfig, whatsappSendModes } from "@/lib/channels/whatsapp";
import { createLinkCode, listOwnerIdentities } from "@/lib/owner-channel/identity";
import { createFounderLinkCode } from "@/lib/founder-channel/identity";
import { ownerSenderFor, notifyOwnerAlert } from "@/lib/owner/briefs";
import { ownerReply, ownerSenderFor as ownerReplySender, ownerTakeOver } from "@/lib/owner/human-control";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { buildQaStatus } from "@/lib/qa/status";
import { POST } from "@/app/api/channels/whatsapp/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * THREE INDEPENDENT SEND MODES on ONE shared WhatsApp number:
 *   customer → BARRY_WHATSAPP_SEND · owner → BARRY_WHATSAPP_OWNER_SEND · founder → BARRY_WHATSAPP_FOUNDER_SEND
 * Each fails closed (anything but exactly "live" = dry_run), and the mode follows the AUTHENTICATED ROLE — never the
 * receiving phone_number_id. The Graph API is a stub recording every call: a real send is visible, not assumed.
 */

const SECRET = "test-app-secret-send-modes";
const BIZ = "fashion-retailer";
const LINE = "PN_SHARED";
const BASE_ENV = {
  WHATSAPP_APP_SECRET: SECRET,
  WHATSAPP_ACCESS_TOKEN: "test-access-token",
  WHATSAPP_VERIFY_TOKEN: "v",
  BARRY_WHATSAPP_ROUTES: `${LINE}=${BIZ}`,
  BARRY_WHATSAPP_ROLE_ROUTING: "identity",
  BARRY_OWNER_TOKEN: "test-owner-token-0123456789",
  BARRY_FOUNDER_TOKEN: "test-founder-token-0123456789abcdefXYZ",
};
const saved = { ...process.env };
let calls: { line: string; to: string }[] = [];
let seq = 0;
const FOUNDER = "972531110001";
const OWNER = "972531110002";
const CUSTOMER = "972531110003";

function env(modes: { customer?: string; owner?: string; founder?: string }) {
  for (const k of ["BARRY_WHATSAPP_SEND", "BARRY_WHATSAPP_OWNER_SEND", "BARRY_WHATSAPP_FOUNDER_SEND", "BARRY_WHATSAPP_OWNER_NUMBERS", "BARRY_WHATSAPP_FOUNDER_NUMBERS"]) delete process.env[k];
  Object.assign(process.env, BASE_ENV);
  if (modes.customer !== undefined) process.env.BARRY_WHATSAPP_SEND = modes.customer;
  if (modes.owner !== undefined) process.env.BARRY_WHATSAPP_OWNER_SEND = modes.owner;
  if (modes.founder !== undefined) process.env.BARRY_WHATSAPP_FOUNDER_SEND = modes.founder;
}

beforeEach(() => {
  env({});
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
  setReasonerForTests(new ScriptedModel(() => undefined));
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    const m = String(url).match(/graph\.facebook\.com\/[^/]+\/([^/]+)\/messages/);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ line: decodeURIComponent(m[1]), to: String(body.to ?? "") });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${calls.length}` }] }), { status: 200 });
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

async function deliver(from: string, text: string) {
  const id = `wamid.sm.${Date.now()}.${seq++}`;
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: LINE }, contacts: [{ wa_id: from, profile: { name: "Dana" } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
  const sig = `sha256=${crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
  const res = await POST(new NextRequest("https://x/api/channels/whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }));
  return (await res.json()) as { roles: { role: string; status: string }[] };
}

/** Founder + owner linked on the shared number, then one message from each role and one from a customer. */
async function threeRolesOnOneNumber() {
  const fc = await createFounderLinkCode();
  expect((await deliver(FOUNDER, `LINK ${fc.code}`)).roles[0]).toMatchObject({ role: "founder", status: "linked" });
  const oc = await createLinkCode(BIZ);
  expect((await deliver(OWNER, `LINK ${oc.code}`)).roles[0]).toMatchObject({ role: "owner", status: "linked" });
  calls = [];
  expect((await deliver(FOUNDER, "What do I need to know today?")).roles[0]?.role).toBe("founder");
  expect((await deliver(OWNER, "What needs me?")).roles[0]?.role).toBe("owner");
  expect((await deliver(CUSTOMER, "Hi, are you open on Friday?")).roles).toEqual([]);
  return { founder: calls.filter((c) => c.to === FOUNDER), owner: calls.filter((c) => c.to === OWNER), customer: calls.filter((c) => c.to === CUSTOMER) };
}

describe("three independent modes, each failing closed", () => {
  it("unset → everything dry_run; only exactly \"live\" is live", () => {
    expect(whatsappSendModes()).toMatchObject({ customer: "dry_run", owner: "dry_run", founder: "dry_run" });
    env({ customer: "LIVE", owner: "true", founder: "live " });
    expect(whatsappSendModes()).toMatchObject({ customer: "dry_run", owner: "dry_run", founder: "live" });
  });

  it("enabling Owner live never enables Customer live (and Customer live never enables Owner live)", () => {
    env({ owner: "live" });
    expect(whatsappSendModes()).toMatchObject({ customer: "dry_run", owner: "live", founder: "dry_run" });
    expect(whatsappConfig().sendMode).toBe("dry_run");
    env({ customer: "live" });
    expect(whatsappSendModes()).toMatchObject({ customer: "live", owner: "dry_run" });
    expect(whatsappOwnerConfig().sendMode).toBe("dry_run");
  });

  it("/api/qa/status reports customer, owner and founder independently (with their variables)", async () => {
    env({ customer: "dry_run", owner: "live", founder: "live" });
    const s = (await buildQaStatus()) as unknown as { sendModes: Record<string, { mode: string; variable: string }> };
    expect(s.sendModes).toEqual({
      customer: { mode: "dry_run", variable: "BARRY_WHATSAPP_SEND" },
      owner: { mode: "live", variable: "BARRY_WHATSAPP_OWNER_SEND" },
      founder: { mode: "live", variable: "BARRY_WHATSAPP_FOUNDER_SEND" },
    });
  });
});

describe("the SAME shared number: outbound mode by authenticated ROLE", () => {
  it("Founder live / Owner dry / Customer dry → only the founder's reply reaches the Graph API", async () => {
    env({ customer: "dry_run", owner: "dry_run", founder: "live" });
    const sent = await threeRolesOnOneNumber();
    expect(sent.founder.length).toBeGreaterThan(0);
    expect(sent.founder.every((c) => c.line === LINE)).toBe(true);
    expect(sent.owner).toHaveLength(0);
    expect(sent.customer).toHaveLength(0);
  });

  it("Founder live / Owner live / Customer dry → founder and owner replies are sent from the shared line; the customer's is not", async () => {
    env({ customer: "dry_run", owner: "live", founder: "live" });
    const sent = await threeRolesOnOneNumber();
    expect(sent.founder.length).toBeGreaterThan(0);
    expect(sent.owner.length).toBeGreaterThan(0);
    expect([...sent.founder, ...sent.owner].every((c) => c.line === LINE)).toBe(true);
    expect(sent.customer).toHaveLength(0);
  });

  it("Owner dry / Customer live → the customer's reply is sent, the owner's is not (same number)", async () => {
    env({ customer: "live", owner: "dry_run", founder: "dry_run" });
    const sent = await threeRolesOnOneNumber();
    expect(sent.customer.length).toBeGreaterThan(0);
    expect(sent.owner).toHaveLength(0);
    expect(sent.founder).toHaveLength(0);
  });
});

describe("owner proactive notices and the owner's own replies to customers use the OWNER mode", () => {
  async function linkOwner() {
    const oc = await createLinkCode(BIZ);
    await deliver(OWNER, `LINK ${oc.code}`);
    return (await listOwnerIdentities(BIZ)).find((l) => l.channelUserId === OWNER)!;
  }

  it("proactive notices on the shared line: owner live → sent (to the owner, from the shared line); customer mode is irrelevant", async () => {
    env({ customer: "dry_run", owner: "live" });
    const link = await linkOwner();
    expect(ownerSenderFor(BIZ, link)?.mode).toBe("live");
    await applyControlChange(BIZ, { mode: "supervised" }, { by: "founder (test)", reason: "test" });
    calls = [];
    const out = (await notifyOwnerAlert(resolveBusinessGraph(BIZ), `sm-${seq++}`, "A test alert")).filter((b) => b.to === `···${OWNER.slice(-4)}`);
    expect(out[0]?.status).toBe("sent");
    expect(calls).toEqual([{ line: LINE, to: OWNER }]);
    env({ customer: "live", owner: "dry_run" });
    expect(ownerSenderFor(BIZ, link)?.mode).toBe("dry_run");
    await applyControlChange(BIZ, { mode: "simulator" }, { by: "founder (test)", reason: "test" });
  });

  it("the owner's handoff reply to a customer follows BARRY_WHATSAPP_OWNER_SEND, never the customer mode", async () => {
    env({ customer: "dry_run", owner: "dry_run" });
    await deliver(CUSTOMER, "Hi, can a person help me?");
    const id = `wa:${BIZ}:${CUSTOMER}`;
    const convo = (await getConversationStore().get(id))!;
    expect(ownerReplySender(convo).mode).toBe("dry_run");
    env({ customer: "live", owner: "dry_run" });
    expect(ownerReplySender(convo).mode).toBe("dry_run");
    env({ customer: "dry_run", owner: "live" });
    expect(ownerReplySender(convo).mode).toBe("live");
    const graph = resolveBusinessGraph(BIZ);
    await ownerTakeOver(graph, id, "the owner (web)");
    calls = [];
    const r = await ownerReply(graph, id, { requestId: `rq_${"a".repeat(16)}`, text: "Checking now.", by: "the owner (web)" });
    expect(r.status).toBe("sent");
    expect(calls).toEqual([{ line: LINE, to: CUSTOMER }]);
  });
});
