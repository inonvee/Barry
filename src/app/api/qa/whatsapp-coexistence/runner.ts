import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { POST as whatsappPost } from "@/app/api/channels/whatsapp/route";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { updateConversation } from "@/lib/state/update";
import { getReasoner } from "@/lib/reasoner";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { applyControlChange, loadControls } from "@/lib/hq/controls";
import { readControl, readControlLog } from "@/lib/runtime/control";
import { readHandoffs } from "@/lib/runtime/handoff";
import { readDeliveries, setGatewayHookForConversation } from "@/lib/channels/gateway";
import { observeGraphSends, whatsappRoleRouting, whatsappSendModes, type GraphSendAttempt } from "@/lib/channels/whatsapp";
import { setRoleSendersOverride } from "@/lib/channels/role-routing";
import { BusinessNumberError, allBusinessNumbers, registerBusinessNumber, removeBusinessNumber, setTeamRepliesInApp } from "@/lib/channels/business-numbers";
import { TEAM_MEMBER, deleteTakeoverSignals, listTakeoverSignals, recordEcho } from "@/lib/channels/human-takeover";
import { createLinkCode } from "@/lib/owner-channel/identity";
import { listCommandRecords } from "@/lib/owner/command-service";
import { ownerReturnToBarry } from "@/lib/owner/human-control";
import { listBusinessSummaries } from "@/lib/fixtures";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { databaseProjectRef } from "@/lib/qa/preview-acceptance-guard";
import { countSyntheticIdentities, ensureRestorePoint, readRestorePoint, restoreFromPoint, revokeSyntheticIdentities } from "@/lib/qa/restore-point";
import { ACCEPTANCE_BUSINESS } from "../acceptance/runner";

const BIZ = ACCEPTANCE_BUSINESS;

/**
 * WHATSAPP COEXISTENCE + HUMAN TAKEOVER — DEPLOYED PREVIEW ACCEPTANCE (temporary QA surface). Runs inside the Preview
 * deployment (its secrets, the Preview Supabase, the live model) with SYNTHETIC business customer numbers registered
 * for the run (durable connections, removed after) and SYNTHETIC Meta webhooks, signed with the deployment's app
 * secret: customer messages (field "messages") and employee echoes (field "smb_message_echoes", the documented
 * coexistence payload). Nothing is sent: customer replies go to a recording stand-in that never touches the network.
 *
 *   routing    A tenant routing by business number · B BARRY owns by default · C customer reaches BARRY · M wrong numbers
 *   takeover   D employee echo → HUMAN · E BARRY silent · F customer kept · G person-authored · H duplicate · I BARRY's own
 *              message ignored · J delayed echo can't take it back
 *   race       N the employee wins at every race point (before / during reasoning, before send, right after, reordered)
 *   return     K owner returns it (Owner BARRY WhatsApp + the web service) · L the customer can't
 *   isolation  M cross-tenant: another business's echo / number / owner can't touch this conversation
 *   (every stage) O realGraphSendAttempts = 0 · P full restore / cleanup
 */

export const COEX_STAGES = ["routing", "takeover", "race", "return", "isolation"] as const;
export type CoexStage = (typeof COEX_STAGES)[number];
export type CoexCheck = { stage: CoexStage | "preflight" | "restore"; name: string; ok: boolean; detail?: unknown };
export type CoexReport = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  verdict?: "PASS" | "FAIL";
  stages: CoexStage[];
  deployment: { environment: string | undefined; databaseProject: string | null; commit: string | null; reasoner: string; storage: string; sendModes: ReturnType<typeof whatsappSendModes> };
  conversations: string[];
  checks: CoexCheck[];
  passed?: number;
  failed?: number;
  cleanup: string;
};

const BASE = "https://preview-acceptance.internal";
const short = (s: string | undefined, n = 200) => (s ?? "").slice(0, n);
export const COEX_STAGE_BUDGET_MS = 230_000;
class StageBudgetExceeded extends Error {
  constructor() {
    super("the stage ran out of its time budget");
  }
}
function qaName(runId: string, i: number): string {
  const d = runId.replace(/\D/g, "").slice(-5);
  return `Qa${"bcdfghjklm"[i]}${[...d].map((c) => "bcdfghjklmnpqrstvwxz"[Number(c)]).join("")}`;
}

export async function runCoexistenceAcceptance(creds: { appSecret: string }, opts: { controlLine: string; stages: CoexStage[]; runId: string; budgetMs?: number }): Promise<CoexReport> {
  const { runId } = opts;
  const startedAt = new Date().toISOString();
  let reasonerName = "unavailable";
  try {
    reasonerName = getReasoner().name;
  } catch {
    /* reported below */
  }
  const digits = String(parseInt(runId.replace(/\D/g, "").slice(-7) || "0", 10)).padStart(7, "0");
  const d6 = digits.slice(1);
  const OTHER = listBusinessSummaries().find((b) => b.id !== BIZ)!.id;
  // Synthetic business numbers (999…: never real) and synthetic customers / owner.
  const PN_A = `9990${d6}1`;
  const PN_B = `9990${d6}2`;
  const PN_X = `9990${d6}3`;
  const CUST = (i: number) => `99956${d6}${i}`;
  const OWNER = `99957${d6}8`;
  const report: CoexReport = {
    runId,
    startedAt,
    stages: opts.stages,
    deployment: { environment: process.env.VERCEL_ENV, databaseProject: databaseProjectRef(), commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null, reasoner: reasonerName === "llm" ? "live model" : reasonerName, storage: isSupabaseConfigured() ? "durable (Supabase)" : "memory", sendModes: whatsappSendModes() },
    conversations: [],
    checks: [],
    cleanup: "Every synthetic number, takeover signal and conversation of a stage is removed at the end of that stage; this report is kept.",
  };
  const check = (stage: CoexCheck["stage"], name: string, ok: boolean, detail?: unknown) => report.checks.push({ stage, name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  const deadline = Date.now() + (opts.budgetMs ?? COEX_STAGE_BUDGET_MS);
  const budget = () => {
    if (Date.now() > deadline) throw new StageBudgetExceeded();
  };

  // Real-transport instrumentation: every real Graph attempt counted; synthetic recipients blocked before any call.
  const graphAttempts: GraphSendAttempt[] = [];
  const stopObserving = observeGraphSends((a) => {
    graphAttempts.push(a);
    return a.to.replace(/\D/g, "").startsWith("999") ? "block" : undefined;
  });
  // Customer replies: a recording stand-in that "delivers" with a provider id (so BARRY's own message ids exist) but
  // never touches the network. Owner / founder: dry.
  let seq = 0;
  const barrySends: { to: string; id: string; at: string }[] = [];
  setRoleSendersOverride({
    customer: () => ({ channel: "whatsapp", mode: "live", send: async (to: string) => { const id = `wamid.qa.barry.${runId}.${++seq}`; barrySends.push({ to, id, at: new Date().toISOString() }); return { providerMessageId: id }; } }),
    owner: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }),
    founder: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }),
    ownerToCustomer: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }),
  });

  const sign = (payload: unknown) => {
    const raw = JSON.stringify(payload);
    return new NextRequest(`${BASE}/api/channels/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", creds.appSecret).update(raw, "utf8").digest("hex")}` }, body: raw });
  };
  const ts = (d = new Date()) => String(Math.floor(d.getTime() / 1000));
  const track = async (businessId: string, phone: string) => {
    const id = `wa:${businessId}:${phone}`;
    if (await getConversationStore().get(id)) {
      if (!report.conversations.includes(id)) report.conversations.push(id);
      await updateConversation(id, (s) => {
        s.knownFields.__qaAcceptance = runId;
      }).catch(() => undefined);
    }
  };
  const customer = async (line: string, businessId: string, from: string, text: string, o: { id?: string; name?: string } = {}) => {
    budget();
    const id = o.id ?? `wamid.qa.in.${runId}.${++seq}`;
    const res = await whatsappPost(sign({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: line }, contacts: [{ wa_id: from, profile: { name: o.name ?? qaName(runId, 0) } }], messages: [{ id, from, timestamp: ts(), type: "text", text: { body: text } }] } }] }] }));
    await track(businessId, from);
    return { status: res.status, id, body: (await res.json().catch(() => ({}))) as { roles?: { role: string; status: string }[] } };
  };
  const echo = async (line: string, businessId: string, to: string, text: string, o: { id?: string; at?: Date } = {}) => {
    budget();
    const id = o.id ?? `wamid.qa.echo.${runId}.${++seq}`;
    const res = await whatsappPost(sign({ object: "whatsapp_business_account", entry: [{ id: "QA-WABA", changes: [{ field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: { display_phone_number: line, phone_number_id: line }, message_echoes: [{ from: line, to, id, timestamp: ts(o.at), type: "text", text: { body: text } }] } }] }] }));
    await track(businessId, to);
    return { status: res.status, id, body: (await res.json().catch(() => ({}))) as { echoes?: { status: string; applied: boolean }[] } };
  };
  const convo = (businessId: string, phone: string) => getConversationStore().get(`wa:${businessId}:${phone}`);
  const holder = async (businessId: string, phone: string) => {
    const c = await convo(businessId, phone);
    return c ? readControl(c).holder : "none";
  };
  const sentTo = (phone: string) => barrySends.filter((s) => s.to === phone).length;

  // ── Preflight: recover, sweep stale synthetic identities, restore point, known start; synthetic numbers ─────
  const by = `founder (qa whatsapp-coexistence ${runId})`;
  if (await readRestorePoint(BIZ)) {
    const rec = await restoreFromPoint(BIZ, by, `whatsapp-coexistence acceptance ${runId}: recover from an interrupted earlier run`);
    check("preflight", "recovered the test business from an interrupted earlier run (restore point)", rec.restored, rec);
  }
  const stale = await revokeSyntheticIdentities(by, `whatsapp-coexistence acceptance ${runId}: stale synthetic identities`);
  const staleNumbers = (await allBusinessNumbers().catch(() => [])).filter((n) => n.phoneNumberId.startsWith("999"));
  for (const n of staleNumbers) await removeBusinessNumber(n.businessId, n.phoneNumberId);
  check("preflight", "no synthetic identity or synthetic business number is left from an earlier run", (await countSyntheticIdentities()).syntheticOwnersActive === 0, { staleRevoked: stale, staleNumbersRemoved: staleNumbers.length });
  const original = await ensureRestorePoint(BIZ, by);
  const modes = whatsappSendModes();
  check("preflight", "live reasoner", reasonerName === "llm", report.deployment.reasoner);
  check("preflight", "durable Supabase storage on the Preview project", isSupabaseConfigured() && report.deployment.databaseProject === "glqrfoljvdbyrmbvupym", report.deployment.databaseProject);
  check("preflight", "customer and owner sending is dry_run", process.env.BARRY_WHATSAPP_SEND === "dry_run" && modes.customer === "dry_run" && modes.owner === "dry_run", modes);
  check("preflight", "BARRY's control number routes the owner by identity (BARRY_WHATSAPP_ROLE_ROUTING=identity)", whatsappRoleRouting() === "identity", { roleRouting: whatsappRoleRouting() });
  await applyControlChange(BIZ, { mode: "supervised", pausedBusiness: false }, { by, reason: `whatsapp-coexistence acceptance ${runId}: known starting point (SUPERVISED)` });

  try {
    // Two synthetic businesses' customer numbers, onboarded with coexistence PENDING verification — exactly the
    // post-Embedded-Signup state. Verification is only by evidence: one echo per number.
    await registerBusinessNumber({ businessId: BIZ, phoneNumberId: PN_A, wabaId: `QA-WABA-A-${runId}`, coexistence: "pending_verification", by });
    await registerBusinessNumber({ businessId: OTHER, phoneNumberId: PN_B, wabaId: `QA-WABA-B-${runId}`, coexistence: "pending_verification", by });
    await setTeamRepliesInApp(BIZ, PN_A, true, by);
    await setTeamRepliesInApp(OTHER, PN_B, true, by);
    await echo(PN_A, BIZ, CUST(9), "QA verification message from the WhatsApp Business app");
    await echo(PN_B, OTHER, CUST(9), "QA verification message from the WhatsApp Business app");
    const nums = (await allBusinessNumbers()).filter((n) => n.phoneNumberId === PN_A || n.phoneNumberId === PN_B);
    check("preflight", "coexistence becomes VERIFIED only by evidence (a signed echo for that number)", nums.length === 2 && nums.every((n) => n.coexistence === "verified" && n.status === "connected"), nums.map((n) => ({ business: n.businessId, coexistence: n.coexistence, status: n.status })));

    // ── routing (A, B, C, M) ─────────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("routing")) {
      // B is about the INITIAL holder: captured at the turn's beforeReasoning point — the conversation exists and pending
      // takeovers were applied, but the reasoner has not run, so nothing in the turn (e.g. a legitimate handoff) can
      // have changed it yet. The final holder is reported separately (the turn may hand off, which is not a failure of B).
      let initialHolder = "not captured (the beforeReasoning point was never reached)";
      let initialLog: unknown[] = [];
      const removeHook = setGatewayHookForConversation(`wa:${BIZ}:${CUST(1)}`, "beforeReasoning", async () => {
        const st = await getConversationStore().get(`wa:${BIZ}:${CUST(1)}`);
        initialHolder = st ? readControl(st).holder : "none (the conversation did not exist yet)";
        initialLog = st ? readControlLog(st) : [];
      });
      let a: Awaited<ReturnType<typeof customer>>;
      try {
        a = await customer(PN_A, BIZ, CUST(1), "Hi, are you open on Friday?");
      } finally {
        removeHook();
      }
      const b = await customer(PN_B, OTHER, CUST(1), "Hi, are you open on Friday?");
      const x = await customer(PN_X, BIZ, CUST(2), "Hello?");
      check("routing", "A: each business number routes to ITS business only (same customer, two businesses, two conversations)", a.status === 200 && b.status === 200 && Boolean(await convo(BIZ, CUST(1))) && Boolean(await convo(OTHER, CUST(1))), { a: a.status, b: b.status });
      check("routing", "M: an unregistered number routes nowhere (no conversation in any business)", x.status === 200 && !(await convo(BIZ, CUST(2))) && !(await convo(OTHER, CUST(2))), { status: x.status });
      const after = await convo(BIZ, CUST(1));
      check("routing", "B: BARRY owns a new conversation by default (holder captured before the first turn could change it)", initialHolder === "barry", {
        initialHolder,
        initialControlLog: initialLog,
        finalHolder: after ? readControl(after).holder : "none",
        controlLog: after ? readControlLog(after) : [],
        openHandoffAfterTurn: after ? readHandoffs(after).some((h) => h.status !== "resolved") : false,
      });
      const c = await convo(BIZ, CUST(1));
      check("routing", "C: the customer's message reached BARRY and BARRY answered (recorded stand-in, nothing sent)", c?.messages[0]?.role === "customer" && c.messages.some((m) => m.role === "barry") && sentTo(CUST(1)) >= 1, { messages: c?.messages.map((m) => m.role), sends: sentTo(CUST(1)) });
      let refused = "";
      try {
        await registerBusinessNumber({ businessId: OTHER, phoneNumberId: PN_A, wabaId: "QA", by });
      } catch (err) {
        refused = err instanceof BusinessNumberError ? err.code : "error";
      }
      check("routing", "a business's number can't be connected to another business", refused === "bound_to_other_business", { refused });
    }

    // ── takeover (D, E, F, G, H, I, J) ──────────────────────────────────────────────────────────────────
    if (opts.stages.includes("takeover")) {
      const P = CUST(3);
      await customer(PN_A, BIZ, P, "Can I book tomorrow?");
      const before = sentTo(P);
      const barryId = readDeliveries((await convo(BIZ, P))?.knownFields ?? {}).map((d) => d.providerMessageId).filter(Boolean).at(-1);
      const own = barryId ? await echo(PN_A, BIZ, P, "(BARRY's own reply)", { id: barryId }) : undefined;
      check("takeover", "I: BARRY's own API message is NOT an employee takeover (an echo with BARRY's provider id is ignored)", Boolean(barryId) && own?.body.echoes?.[0]?.status === "own_message" && (await holder(BIZ, P)) === "barry", { echo: own?.body.echoes });
      const e = await echo(PN_A, BIZ, P, "Hi! I'll check tomorrow for you.", { id: `wamid.qa.echo.${runId}.takeover` });
      const c1 = (await convo(BIZ, P))!;
      check("takeover", "D: a verified employee echo changes the holder to HUMAN (the existing handoff control, audited)", e.body.echoes?.[0]?.status === "recorded" && readControl(c1).holder === "human" && readControl(c1).by === TEAM_MEMBER && readControlLog(c1).some((x) => x.to === "human" && x.by === TEAM_MEMBER), { echo: e.body.echoes, control: readControl(c1) });
      check("takeover", "G: the employee's message is in the transcript as a PERSON's (never BARRY's), in order", c1.messages.some((m) => m.role === "owner" && m.author === TEAM_MEMBER && m.content === "Hi! I'll check tomorrow for you.") && !c1.messages.some((m) => m.role === "barry" && m.content === "Hi! I'll check tomorrow for you."), c1.messages.map((m) => `${m.role}${m.author ? `(${m.author})` : ""}`));
      await customer(PN_A, BIZ, P, "Great, 3pm?");
      const c2 = (await convo(BIZ, P))!;
      check("takeover", "E: BARRY is silent immediately (no reply after the takeover)", sentTo(P) === before && c2.messages.at(-1)?.role === "customer", { sendsBefore: before, sendsAfter: sentTo(P) });
      check("takeover", "F: customer messages keep being stored while a person holds it", c2.messages.at(-1)?.content === "Great, 3pm?");
      const dup = await echo(PN_A, BIZ, P, "Hi! I'll check tomorrow for you.", { id: `wamid.qa.echo.${runId}.takeover` });
      const c3 = (await convo(BIZ, P))!;
      check("takeover", "H: the same employee event again is idempotent (one transcript message, one takeover)", dup.body.echoes?.[0]?.status === "duplicate" && c3.messages.filter((m) => m.role === "owner").length === 1 && readControlLog(c3).filter((x) => x.to === "human").length === 1, { echo: dup.body.echoes });
      // J: give it back (the web's service), then an OLDER echo arrives late — history only, BARRY keeps it.
      await ownerReturnToBarry(resolveBusinessGraph(BIZ), `wa:${BIZ}:${P}`, "the owner (web)");
      const late = await echo(PN_A, BIZ, P, "an older reply, delivered late", { at: new Date(Date.now() - 120_000) });
      const c4 = (await convo(BIZ, P))!;
      check("takeover", "J: a delayed / duplicate echo (written before the return) can't take the conversation back", late.body.echoes?.[0]?.status === "recorded" && readControl(c4).holder === "barry" && c4.messages.some((m) => m.content === "an older reply, delivered late" && m.role === "owner"), { holder: readControl(c4).holder });
    }

    // ── race (N) ─────────────────────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("race")) {
      const results: Record<string, unknown> = {};
      // N1: the employee replied BEFORE BARRY reasons.
      {
        const P = CUST(4);
        await customer(PN_A, BIZ, P, "Hello");
        const before = sentTo(P);
        await echo(PN_A, BIZ, P, "Got it");
        await customer(PN_A, BIZ, P, "Can I book tomorrow?");
        results.beforeReasoning = { holder: await holder(BIZ, P), newSends: sentTo(P) - before };
        check("race", "N: employee replied BEFORE BARRY reasons → BARRY doesn't reply", (await holder(BIZ, P)) === "human" && sentTo(P) === before, results.beforeReasoning);
      }
      // N2 / N3: during reasoning, and after reasoning before the send (the deployment's own race points).
      for (const [point, i] of [["beforeReasoning", 5], ["beforeSend", 6]] as const) {
        const P = CUST(i);
        await customer(PN_A, BIZ, P, "Hello");
        const before = sentTo(P);
        const conversationId = `wa:${BIZ}:${P}`;
        const remove = setGatewayHookForConversation(conversationId, point, async () => {
          // What the webhook does first when the employee's echo lands mid-turn: the durable signal, no lock.
          await recordEcho({ lineId: PN_A, businessId: BIZ, messageId: `wamid.qa.echo.${runId}.race.${point}`, customer: P, at: new Date().toISOString(), type: "text", text: "I'll take this one" });
        });
        let inbound = "";
        try {
          inbound = (await customer(PN_A, BIZ, P, "Can I book tomorrow?")).id;
        } finally {
          remove();
        }
        const c = (await convo(BIZ, P))!;
        const last = readDeliveries(c.knownFields).at(-1);
        // A redelivery of the same customer message must never send the suppressed reply later.
        await customer(PN_A, BIZ, P, "Can I book tomorrow?", { id: inbound });
        results[point] = { holder: readControl(c).holder, lastDelivery: last?.status, newSends: sentTo(P) - before };
        check("race", `N: employee replies ${point === "beforeReasoning" ? "WHILE BARRY reasons" : "after BARRY reasoned, before its reply leaves"} → BARRY's reply is SUPPRESSED (not sent, never retried); the person holds it`, readControl(c).holder === "human" && last?.status === "suppressed" && sentTo(P) === before && c.messages.some((m) => m.role === "owner" && m.content === "I'll take this one"), results[point]);
      }
      // N4: echo and customer message delivered concurrently, and the echo redelivered out of order.
      {
        const P = CUST(7);
        await customer(PN_A, BIZ, P, "Hello");
        const before = sentTo(P);
        const id = `wamid.qa.echo.${runId}.race.concurrent`;
        await Promise.all([customer(PN_A, BIZ, P, "Is 3pm free?"), echo(PN_A, BIZ, P, "Let me check", { id })]);
        await echo(PN_A, BIZ, P, "Let me check", { id });
        const c = (await convo(BIZ, P))!;
        // The invariant: once the employee's reply is recorded, nothing of BARRY's leaves (a reply that physically left
        // before it is the only possible earlier send — and then BARRY still steps out).
        const recordedAt = (await listTakeoverSignals(BIZ, `wa:${BIZ}:${P}`)).find((x) => x.messageId === id)?.receivedAt ?? new Date(0).toISOString();
        const sendsAfterEcho = barrySends.filter((s) => s.to === P && Date.parse(s.at) > Date.parse(recordedAt));
        results.concurrent = { holder: readControl(c).holder, newSends: sentTo(P) - before, sendsAfterEcho: sendsAfterEcho.length, takeovers: readControlLog(c).filter((x) => x.to === "human").length };
        check("race", "N: concurrent + reordered delivery → the person holds it, one takeover, and nothing of BARRY's leaves after the employee's reply", readControl(c).holder === "human" && sendsAfterEcho.length === 0 && readControlLog(c).filter((x) => x.to === "human").length === 1, results.concurrent);
      }
    }

    // ── return (K, L) ───────────────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("return")) {
      const P = CUST(8);
      const name = qaName(runId, 8);
      await customer(PN_A, BIZ, P, "Hello", { name });
      await echo(PN_A, BIZ, P, "Hi, it's the shop");
      await customer(PN_A, BIZ, P, "תחזיר לברי", { name });
      await customer(PN_A, BIZ, P, "give it back to BARRY", { name });
      const lHolder = await holder(BIZ, P);
      check("return", "L: the customer can't return the conversation to BARRY", lHolder === "human", { observedHolder: lHolder });
      // K: the owner, from Owner BARRY on BARRY's control number (verified, linked for this run).
      const { code } = await createLinkCode(BIZ);
      const linked = await customer(opts.controlLine, BIZ, OWNER, `LINK ${code}`);
      const ask = await customer(opts.controlLine, BIZ, OWNER, "מי נמצא כרגע אצל עובד?");
      const askRec = (await listCommandRecords(BIZ)).find((r) => r.key === `whatsapp:${ask.id}`);
      check("return", "the owner asks “who's with an employee?” and hears it in plain words", linked.body.roles?.[0]?.role === "owner" && askRec?.intent?.kind === "query" && new RegExp(name).test(askRec.reply?.text ?? "") && !/echo|webhook|holder|lease|Cloud API/i.test(askRec?.reply?.text ?? ""), { reply: short(askRec?.reply?.text, 400) });
      const back = await customer(opts.controlLine, BIZ, OWNER, `תחזיר את השיחה עם ${name} לברי`);
      const backRec = (await listCommandRecords(BIZ)).find((r) => r.key === `whatsapp:${back.id}`);
      check("return", "K: Owner BARRY WhatsApp “תחזיר את השיחה עם X לברי” returns it to BARRY (same handoff service)", backRec?.intent?.kind === "conversation_giveback" && (await holder(BIZ, P)) === "barry", { reply: short(backRec?.reply?.text) });
      const before = sentTo(P);
      await customer(PN_A, BIZ, P, "So, are you open Friday?", { name });
      check("return", "BARRY continues from the current state with the NEXT message (nothing replayed)", sentTo(P) === before + 1, { newSends: sentTo(P) - before });
      // The web path (same service) after another employee takeover.
      await echo(PN_A, BIZ, P, "Actually I'll answer that");
      await ownerReturnToBarry(resolveBusinessGraph(BIZ), `wa:${BIZ}:${P}`, "the owner (web)");
      check("return", "K: the web handoff service returns it too", (await holder(BIZ, P)) === "barry");
    }

    // ── isolation (M) ───────────────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("isolation")) {
      const P = CUST(1);
      await customer(PN_A, BIZ, P, "Hello A");
      await customer(PN_B, OTHER, P, "Hello B");
      await echo(PN_B, OTHER, P, "B's team here");
      check("isolation", "M: another business's employee echo (same customer number) takes only THAT business's conversation", (await holder(OTHER, P)) === "human" && (await holder(BIZ, P)) === "barry" && !(await convo(BIZ, P))?.messages.some((m) => m.role === "owner"), { a: await holder(BIZ, P), b: await holder(OTHER, P) });
      let err = "";
      try {
        await ownerReturnToBarry(resolveBusinessGraph(BIZ), `wa:${OTHER}:${P}`, "the owner (web)");
      } catch (e) {
        err = e instanceof Error ? e.name : "error";
      }
      check("isolation", "M: this business's owner can't return another business's conversation", Boolean(err) && (await holder(OTHER, P)) === "human", { error: err });
    }
  } catch (err) {
    if (err instanceof StageBudgetExceeded) check("restore", `stage stopped: it exceeded its ${Math.round((opts.budgetMs ?? COEX_STAGE_BUDGET_MS) / 1000)}s time budget — restored below`, false);
    else check("restore", "runner error", false, err instanceof Error ? err.message.slice(0, 300) : String(err));
  } finally {
    // ── P: restore + cleanup ─────────────────────────────────────────────────────────────────────────────
    setRoleSendersOverride(undefined);
    await restoreFromPoint(BIZ, by, `whatsapp-coexistence acceptance ${runId}: restore`).catch((e) => check("restore", "restore controls", false, e instanceof Error ? e.message : "failed"));
    const restored = await loadControls(BIZ);
    check("restore", "business controls restored (mode, pause); restore point cleared", restored.mode === original.mode && restored.pausedBusiness === original.pausedBusiness && !(await readRestorePoint(BIZ)), { mode: restored.mode, paused: restored.pausedBusiness });
    for (const [b, p] of [[BIZ, PN_A], [OTHER, PN_B]] as const) await removeBusinessNumber(b, p).catch(() => 0);
    const numbersLeft = (await allBusinessNumbers().catch(() => [])).filter((n) => n.phoneNumberId.startsWith("999")).length;
    let signalsLeft = 0;
    for (const id of [...report.conversations, `wa:${BIZ}:${CUST(9)}`, `wa:${OTHER}:${CUST(9)}`]) {
      const b = id.split(":")[1];
      await deleteTakeoverSignals(b, id).catch(() => 0);
      signalsLeft += (await listTakeoverSignals(b, id).catch(() => [])).length;
      await getConversationStore().deleteConversationsByPrefix(b, id).catch(() => 0);
    }
    const convosLeft = (await Promise.all(report.conversations.map((id) => getConversationStore().get(id).catch(() => undefined)))).filter(Boolean).length;
    await revokeSyntheticIdentities(by, `whatsapp-coexistence acceptance ${runId}: end of run`).catch(() => undefined);
    const ids = await countSyntheticIdentities().catch(() => ({ syntheticOwnersActive: -1, syntheticFoundersActive: -1 }));
    check("restore", "synthetic business numbers removed", numbersLeft === 0, { numbersLeft });
    check("restore", "synthetic conversations and takeover records removed (handoff state gone with them)", convosLeft === 0 && signalsLeft === 0, { conversations: report.conversations.length, convosLeft, signalsLeft });
    check("restore", "synthetic identities removed (owners / founders active = 0)", ids.syntheticOwnersActive === 0 && ids.syntheticFoundersActive === 0, ids);
    check("restore", "Production untouched (this ran on the Preview database)", report.deployment.environment === "preview" && report.deployment.databaseProject === "glqrfoljvdbyrmbvupym", { environment: report.deployment.environment, databaseProject: report.deployment.databaseProject });
    stopObserving();
    check("restore", "realGraphSendAttempts === 0 (nothing reached the real WhatsApp transport)", graphAttempts.length === 0, { realGraphSendAttempts: graphAttempts.length });
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.filter((c) => c.ok).length;
    report.failed = report.checks.length - report.passed;
    report.verdict = report.failed === 0 ? "PASS" : "FAIL";
    await getBackend().upsertOperatorRecord({ businessId: BIZ, kind: "founder_state", key: `qa_whatsapp_coexistence:${runId}`, data: report as unknown as Record<string, unknown> }).catch(() => undefined);
  }
  return report;
}

export async function loadCoexistenceReport(runId: string): Promise<CoexReport | undefined> {
  const r = (await getBackend().listOperatorRecords(BIZ, "founder_state")).find((x) => x.key === `qa_whatsapp_coexistence:${runId}`);
  return r?.data as unknown as CoexReport | undefined;
}
