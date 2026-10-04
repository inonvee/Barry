import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { POST as whatsappPost } from "@/app/api/channels/whatsapp/route";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { updateConversation } from "@/lib/state/update";
import { getReasoner } from "@/lib/reasoner";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { applyControlChange, listControlAudit, loadControls } from "@/lib/hq/controls";
import { operatingMode } from "@/lib/runtime/operating-mode";
import { readControl, readControlLog } from "@/lib/runtime/control";
import { createHandoff, readHandoffs } from "@/lib/runtime/handoff";
import { parseWebhook, whatsappConfig, whatsappOwnerConfig } from "@/lib/channels/whatsapp";
import { createLinkCode, listOwnerIdentities, revokeOwnerIdentity } from "@/lib/owner-channel/identity";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import type { OwnerInbound, OwnerSender } from "@/lib/owner-channel/transport";
import { listCommandRecords } from "@/lib/owner/command-service";
import { listBriefs, notifyOwnerAttention } from "@/lib/owner/briefs";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { hasMoney } from "@/lib/format/money";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { databaseProjectRef } from "@/lib/qa/preview-acceptance-guard";
import { ensureRestorePoint, readRestorePoint, restoreFromPoint } from "@/lib/qa/restore-point";
import { ACCEPTANCE_BUSINESS } from "../acceptance/runner";

const BIZ = ACCEPTANCE_BUSINESS;

/**
 * OWNER WHATSAPP V1 — DEPLOYED PREVIEW ACCEPTANCE (temporary QA surface). Runs INSIDE the Preview deployment
 * with its own secrets, the Preview Supabase and the live model:
 *
 *  - customers write through the real signed WhatsApp webhook route (synthetic 999… numbers, dry-run sending);
 *  - the owner writes through the real owner gateway (`processOwnerInbound`: link code → verified identity →
 *    business → command service) with a synthetic, freshly linked 999… owner number, revoked at the end. The
 *    owner line's replies are dry-run (recorded, never sent) — no real WhatsApp message leaves.
 *
 * Every mutation is checked against the same records the web reads (approvals, conversation control, the
 * operating mode, the audit). The business's controls are restored at the end.
 */

export const OWA_STAGES = ["identity", "reads", "decisions", "conversation", "mode", "notifications"] as const;
export type OwaStage = (typeof OWA_STAGES)[number];
export type OwaCheck = { stage: OwaStage | "preflight" | "audit" | "restore"; name: string; ok: boolean; detail?: unknown };
export type OwaReport = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  verdict?: "PASS" | "FAIL";
  stages: OwaStage[];
  deployment: { environment: string | undefined; databaseProject: string | null; commit: string | null; reasoner: string; ownerModel: string; storage: string; sendMode: string | undefined; ownerLineMode: string };
  owner: string;
  conversations: string[];
  checks: OwaCheck[];
  passed?: number;
  failed?: number;
  cleanup: string;
};
type Creds = { appSecret: string };

const BASE = "https://preview-acceptance.internal";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string | undefined, n = 220) => (s ?? "").slice(0, n);

/** Letters-only synthetic names (the read model matches customers by name words). */
function qaName(runId: string, i: number): string {
  const d = runId.replace(/\D/g, "").slice(-5);
  return `Qa${"bcdfghjklm"[i]}${[...d].map((c) => "bcdfghjklmnpqrstvwxz"[Number(c)]).join("")}`;
}

/** A notice in this run: dry run, or blocked for a stated reason (no owner line / outside the 24h window) — never sent. */
const truthfulNotice = (b: { status: string; reason?: string }) => b.status === "dry_run" || (b.status === "blocked" && Boolean(b.reason));

/** The owner line in this run: dry-run (recorded, never sent). */
const dryOwnerLine: OwnerSender = { channel: "whatsapp", mode: "dry_run", send: async () => ({}) };

/** A stage stops itself before Vercel's function limit (300s) so it always reaches its own restore. */
export const STAGE_BUDGET_MS = 230_000;
class StageBudgetExceeded extends Error {
  constructor() {
    super("the stage ran out of its time budget");
  }
}

export async function runOwnerWhatsappAcceptance(creds: Creds, opts: { phoneNumberId: string; stages: OwaStage[]; runId: string; budgetMs?: number }): Promise<OwaReport> {
  const { runId, phoneNumberId } = opts;
  const startedAt = new Date().toISOString();
  let reasonerName = "unavailable";
  try {
    reasonerName = getReasoner().name;
  } catch {
    /* reported below */
  }
  const digits = String(parseInt(runId.replace(/\D/g, "").slice(-7) || "0", 10)).padStart(7, "0");
  const OWNER = `99990${digits}`;
  const STRANGER = `99991${digits}`;
  const masked = `···${OWNER.slice(-4)}`;
  const report: OwaReport = {
    runId,
    startedAt,
    stages: opts.stages,
    deployment: {
      environment: process.env.VERCEL_ENV,
      databaseProject: databaseProjectRef(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
      reasoner: reasonerName === "llm" ? "live model" : reasonerName,
      ownerModel: process.env.BARRY_REASONER === "openai" && process.env.OPENAI_API_KEY ? "live model (gap-filling, closed set)" : "deterministic only",
      storage: isSupabaseConfigured() ? "durable (Supabase)" : "memory",
      sendMode: process.env.BARRY_WHATSAPP_SEND,
      ownerLineMode: whatsappOwnerConfig().sendMode,
    },
    owner: `synthetic owner ${masked} (linked for this run, revoked at the end)`,
    conversations: [],
    checks: [],
    cleanup: `Synthetic conversations are stamped __qaAcceptance=${runId} (ids wa:${BIZ}:9997…). POST { "cleanup": "${runId}" } deletes them; this report is kept.`,
  };
  const check = (stage: OwaCheck["stage"], name: string, ok: boolean, detail?: unknown) => report.checks.push({ stage, name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  const graph = resolveBusinessGraph(BIZ);
  // Cooperative time budget: every customer / owner step checks it, so an over-long stage stops between steps.
  const deadline = Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS);
  const budget = () => {
    if (Date.now() > deadline) throw new StageBudgetExceeded();
  };

  // ── Customers: the real signed webhook route ────────────────────────────────────────────────────────────
  let seq = 0;
  let customerN = 0;
  const customer = (name: string) => {
    const phone = `9997${customerN++}${digits}`;
    const id = `wa:${BIZ}:${phone}`;
    const send = async (text: string) => {
      budget();
      const wamid = `wamid.owa.${runId}.${++seq}`;
      const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: phone, profile: { name } }], messages: [{ id: wamid, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
      const sig = `sha256=${crypto.createHmac("sha256", creds.appSecret).update(raw, "utf8").digest("hex")}`;
      const post = async () => (await whatsappPost(new NextRequest(`${BASE}/api/channels/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }))).status;
      let status = await post();
      for (let i = 0; i < 3 && status !== 200; i++) {
        await sleep(1500 * (i + 1));
        status = await post();
      }
      if (!report.conversations.includes(id)) {
        report.conversations.push(id);
        await updateConversation(id, (s) => {
          s.knownFields.__qaAcceptance = runId;
        }).catch(() => undefined);
      }
      return { status, wamid };
    };
    return { id, name, phone, send };
  };
  const state = (id: string) => getConversationStore().get(id);
  const count = async (id: string, role: string) => ((await state(id))?.messages ?? []).filter((m) => m.role === role).length;

  // ── The owner: the real owner gateway with a synthetic, verified number ───────────────────────────────
  let ownerSeq = 0;
  const inbound = (text: string, from = OWNER, messageId = `wamid.owa.owner.${runId}.${++ownerSeq}`, actionId?: string): OwnerInbound => ({ channel: "whatsapp", messageId, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), ...(actionId ? { actionId } : { text }) });
  const owner = async (text: string, o: { from?: string; messageId?: string; actionId?: string } = {}) => {
    budget();
    const r = await processOwnerInbound(inbound(text, o.from ?? OWNER, o.messageId, o.actionId), dryOwnerLine, { businessIds: [BIZ] });
    const reply = r.status === "processed" || r.status === "duplicate" ? r.command.reply : undefined;
    return { status: r.status, text: reply?.text ?? "", actions: reply?.actions ?? [], intent: r.status === "processed" || r.status === "duplicate" ? r.command.intent?.kind : undefined, delivery: r.status === "processed" ? r.delivery?.status : undefined };
  };
  const said = (x: { status: string; intent?: string; text: string }) => ({ status: x.status, intent: x.intent, reply: short(x.text) });

  // ── Restore point: recover from a run that died (timeout / killed), then record the true original ─────────
  const by = `founder (qa owner-whatsapp ${runId})`;
  if (await readRestorePoint(BIZ)) {
    const rec = await restoreFromPoint(BIZ, by, `owner-whatsapp acceptance ${runId}: recover from an interrupted earlier run`);
    check("preflight", "recovered the test business from an interrupted earlier run (restore point)", rec.restored, rec);
  }
  const original = await ensureRestorePoint(BIZ, by);
  check("preflight", "live reasoner", reasonerName === "llm", report.deployment.reasoner);
  check("preflight", "durable Supabase storage on the Preview project", isSupabaseConfigured() && report.deployment.databaseProject === "glqrfoljvdbyrmbvupym", report.deployment.databaseProject);
  check("preflight", "WhatsApp sending is dry_run (customer and owner lines)", process.env.BARRY_WHATSAPP_SEND === "dry_run" && whatsappOwnerConfig().sendMode === "dry_run");
  await applyControlChange(BIZ, { mode: "supervised", pausedBusiness: false }, { by, reason: `owner-whatsapp acceptance ${runId}: known starting point (SUPERVISED)` });

  let linkId: string | undefined;
  try {
    // Link the synthetic owner number (a one-time code from a signed-in owner, sent FROM the number).
    const { code } = await createLinkCode(BIZ);
    const linked = await processOwnerInbound(inbound(`LINK ${code}`), dryOwnerLine, { businessIds: [BIZ] });
    linkId = (await listOwnerIdentities(BIZ)).find((l) => l.channelUserId === OWNER && l.status === "active")?.id;
    check("preflight", "synthetic owner number linked with a one-time code (verified sender)", linked.status === "linked" && Boolean(linkId), linked.status);

    // ── Identity and separation ──────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("identity")) {
      const ok = await owner("What needs me?");
      check("identity", "verified owner recognized and served", ok.status === "processed" && ok.intent === "query", said(ok));
      const before = (await listCommandRecords(BIZ)).length;
      const stranger = await owner("pause BARRY", { from: STRANGER });
      check("identity", "an unknown phone cannot issue commands (rejected, nothing recorded, mode unchanged)", stranger.status === "rejected" && (await listCommandRecords(BIZ)).length === before && operatingMode(await loadControls(BIZ)) === "supervised", { status: stranger.status });
      // The owner's own number writing to the CUSTOMER line is a customer — never an owner command.
      const asCustomer = customer(qaName(runId, 9));
      const routes = whatsappConfig().routes;
      const probe = (pnid: string) => parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: pnid }, messages: [{ id: `probe-${pnid}`, from: OWNER, type: "text", text: { body: "pause BARRY" } }] } }] }] }, routes, whatsappOwnerConfig().numbers);
      const onCustomer = probe(phoneNumberId);
      check("identity", "customer and owner paths are separate: the owner's number on the customer line is parsed as a customer message", onCustomer.messages.length === 1 && onCustomer.owner.length === 0, { customer: onCustomer.messages.length, owner: onCustomer.owner.length });
      const c = await asCustomer.send("pause BARRY");
      check("identity", "a customer saying “pause BARRY” is a customer turn — the mode is unchanged", c.status === 200 && operatingMode(await loadControls(BIZ)) === "supervised" && (await count(asCustomer.id, "customer")) === 1, { status: c.status });
    }

    // ── Reads ────────────────────────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("reads")) {
      const ws = await getOwnerWorkspace(graph);
      for (const [text, topic] of [["What needs me?", "needs_you"], ["מה צריך אותי?", "needs_you"], ["יש משהו דחוף?", "needs_you"], ["What is BARRY handling?", "working"], ["מה ברי עושה עכשיו?", "working"], ["What are we waiting on?", "waiting"], ["על מה אנחנו מחכים?", "waiting"]] as const) {
        const r = await owner(text);
        const rec = (await listCommandRecords(BIZ)).find((x) => x.text === text && x.actor.includes(masked));
        check("reads", `“${text}” → ${topic}`, r.status === "processed" && rec?.intent?.kind === "query" && (rec.intent as { topic?: string }).topic === topic && r.text.length > 0, said(r));
      }
      const today = await owner("How much came in today?");
      const truthful = hasMoney(ws.revenue.direct) ? !/nothing yet/.test(today.text) : /nothing yet/.test(today.text);
      check("reads", "money today is truthful (verified provider payments only; nothing invented)", today.status === "processed" && truthful && (hasMoney(ws.revenue.recovered) || !/Recovered/.test(today.text)), { reply: short(today.text, 400), verifiedDirect: ws.revenue.direct });
      const he = await owner("כמה נכנס היום?");
      check("reads", "money in Hebrew", he.status === "processed" && /נגבה/.test(he.text), said(he));
      for (const [text, focus, empty] of [["What money is stuck?", "stuck", /No money is stuck/], ["What is awaiting payment?", "awaiting", /Nothing is awaiting payment/], ["Which payments failed?", "failed", /Nothing failed/]] as const) {
        const r = await owner(text);
        const real = ws.opportunities.items.filter((o) => !o.simulated);
        const hasItems = focus === "stuck" ? real.length > 0 : focus === "awaiting" ? real.some((o) => o.kind === "unpaid_link" || o.kind === "unpaid_deposit") : real.some((o) => o.kind === "payment_failed") || ws.outcomes.some((o) => o.kind === "failed" && !o.simulated);
        check("reads", `money: ${focus} — answered from records (empty only when the records are empty)`, r.status === "processed" && empty.test(r.text) === !hasItems, said(r));
      }
    }

    // ── Decisions (live model reaches checkout; SUPERVISED requires approval) ────────────────────────────
    if (opts.stages.includes("decisions")) {
      const backend = getBackend();
      const pendingFor = async (conv: string) => (await backend.listApprovals(BIZ)).filter((a) => a.conversationId === conv && a.status === "pending");
      const shop = async (i: number) => {
        const c = customer(qaName(runId, i));
        await c.send("Hi, I'd like to buy the Midnight Wrap Dress in size M, please add it to my cart.");
        for (const text of ["Yes — size M, add one to my cart.", `Great, I want to check out now. My name is ${c.name} Levi and my phone is 0501234567.`, "Yes, please go ahead with the checkout."]) {
          if ((await pendingFor(c.id)).length) break;
          await c.send(text);
        }
        return { ...c, pending: await pendingFor(c.id) };
      };
      const a = await shop(0);
      const b = await shop(1);
      check("decisions", "two customers' checkouts are waiting on the owner (SUPERVISED, live model)", a.pending.length === 1 && b.pending.length === 1, { a: a.pending.length, b: b.pending.length });
      if (a.pending[0] && b.pending[0]) {
        // A fresh, unrelated request first: nothing in context.
        await owner("How much came in today?");
        const bare = await owner("approve");
        check("decisions", "ambiguous: a bare “approve” with several requests and nothing in context is shown and asked — never guessed", /won't guess/.test(bare.text) && (await backend.getApproval(a.pending[0].id))?.status === "pending" && (await backend.getApproval(b.pending[0].id))?.status === "pending", said(bare));
        await owner("How much came in today?");
        const stale = await owner("yes");
        check("decisions", "a new unrelated request clears the context: a later “yes” decides nothing", (await backend.getApproval(a.pending[0].id))?.status === "pending" && (await backend.getApproval(b.pending[0].id))?.status === "pending", said(stale));
        const notices = (await listBriefs(BIZ)).filter((x) => x.kind === "decision" && x.to === masked && x.at >= startedAt);
        // Dry run when the owner line is configured; otherwise recorded as blocked with the truthful reason. Never sent.
        check("decisions", "each new request was announced to the owner once (Approve / Decline) — dry run or truthfully blocked, never sent", notices.length >= 2 && notices.every(truthfulNotice), notices.map((x) => `${x.status}${x.reason ? ` (${x.reason})` : ""}: ${short(x.text, 80)}`));
        const explain = await owner(`what is the request for ${a.name}?`);
        check("decisions", "“what is the request for <customer>?” explains it (why, consequence, Approve / Decline) without deciding it", /If you approve/.test(explain.text) && explain.actions.length === 2 && (await backend.getApproval(a.pending[0].id))?.status === "pending", said(explain));
        const yesId = `wamid.owa.owner.${runId}.yes`;
        const yes = await owner("yes", { messageId: yesId });
        const dup = await owner("yes", { messageId: yesId });
        const approvedA = await backend.getApproval(a.pending[0].id);
        check("decisions", "“yes” approves exactly the request in context through the web's approval path", approvedA?.status === "approved" && /Approved/.test(yes.text), said(yes));
        check("decisions", "the same owner inbound id again is a duplicate — decided once", dup.status === "duplicate" && (await listCommandRecords(BIZ)).filter((r) => r.key.endsWith(yesId)).length === 1, { status: dup.status });
        check("decisions", "BARRY resumed the customer's conversation after the approval", ((await state(a.id))?.messages.at(-1)?.role ?? "") === "barry");
        await owner(`what is the request for ${b.name}?`);
        const no = await owner("אל תאשר");
        const declinedB = await backend.getApproval(b.pending[0].id);
        check("decisions", "Hebrew decline (“אל תאשר”) declines the request in context; nothing charged", declinedB?.status === "declined" && !(await state(b.id))?.knownFields.__paymentRequestId, said(no));
      } else check("decisions", "approvals to decide", false, "the live model did not reach checkout for both customers");
    }

    // ── Conversation control (the handoff service) ──────────────────────────────────────────────────────
    if (opts.stages.includes("conversation")) {
      const c = customer(qaName(runId, 2));
      await c.send("Hi, I have a problem with my order, can a person help me?");
      // BARRY hands the conversation to a person (the deterministic handoff, independent of model wording).
      if (readControl((await state(c.id))!).holder !== "human") await updateConversation(c.id, (s) => createHandoff(graph, s, { trigger: "customer_asked", reason: "wants a person" }));
      const take = await owner(`I'll take it with ${c.name}`);
      let s = (await state(c.id))!;
      check("conversation", "owner takes over from WhatsApp → the existing handoff state changes (held by this owner)", readControl(s).holder === "human" && /owner on WhatsApp/.test(readControl(s).by), { reply: short(take.text), control: readControl(s) });
      const barryBefore = await count(c.id, "barry");
      await c.send("Hello? Anyone?");
      s = (await state(c.id))!;
      check("conversation", "a customer message while the owner holds it is stored, not answered", s.messages.at(-1)?.content === "Hello? Anyone?" && (await count(c.id, "barry")) === barryBefore);
      const ctx = await owner("what's going on with her?");
      check("conversation", "asking BARRY for context about the conversation in focus", ctx.status === "processed" && ctx.text.includes(c.name), said(ctx));
      const draft = await owner(`tell ${c.name} that I'm checking and will get back to her shortly`);
      check("conversation", "a natural instruction becomes a draft shown first (nothing sent yet)", /I'll send/.test(draft.text) && draft.actions.length === 2 && (await count(c.id, "owner")) === 0, said(draft));
      const send = await owner("send it");
      s = (await state(c.id))!;
      const ownerMsgs = s.messages.filter((m) => m.role === "owner");
      check("conversation", "“send it” → the owner's message goes through BARRY's channel, stored as the owner's (dry run, not sent)", ownerMsgs.length === 1 && /owner on WhatsApp/.test(ownerMsgs[0].author ?? "") && /Test mode/.test(send.text), { reply: short(send.text), sent: short(ownerMsgs[0]?.content) });
      if (draft.actions[0]) await owner("", { actionId: draft.actions[0].id });
      check("conversation", "tapping Send again never sends twice", (await count(c.id, "owner")) === 1);
      const back = await owner("תחזיר לברי");
      s = (await state(c.id))!;
      check("conversation", "give back (Hebrew) → BARRY holds the conversation again", readControl(s).holder === "barry", said(back));
      await c.send("Thanks! Do you ship to Haifa?");
      check("conversation", "BARRY answers again after give-back", ((await state(c.id))?.messages.at(-1)?.role ?? "") === "barry");
    }

    // ── Operating control ────────────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("mode")) {
      const c = customer(qaName(runId, 3));
      await c.send("Hi, quick question about sizes");
      const pause = await owner("תעצור הכל");
      check("mode", "“תעצור הכל” pauses BARRY (owner pause, same as the web)", operatingMode(await loadControls(BIZ)) === "paused" && (await loadControls(BIZ)).pausedBy?.includes(masked) === true, said(pause));
      const before = await count(c.id, "barry");
      await c.send("Are you open today?");
      check("mode", "paused: the customer message is stored, not answered", (await state(c.id))?.messages.at(-1)?.content === "Are you open today?" && (await count(c.id, "barry")) === before);
      const q = await owner("what mode are we in?");
      check("mode", "“what mode are we in?” → paused, by the owner", /Paused — by you/.test(q.text), said(q));
      const resume = await owner("תחזיר אותו לעבוד");
      check("mode", "“תחזיר אותו לעבוד” resumes (back to SUPERVISED)", operatingMode(await loadControls(BIZ)) === "supervised", said(resume));
      await applyControlChange(BIZ, { pausedBusiness: true }, { by: `founder (qa owner-whatsapp ${runId})`, reason: `owner-whatsapp acceptance ${runId}: founder pause` });
      const override = await owner("resume BARRY");
      check("mode", "a founder pause cannot be overridden by the owner", operatingMode(await loadControls(BIZ)) === "paused" && /BARRY team paused/.test(override.text), said(override));
      await applyControlChange(BIZ, { pausedBusiness: false }, { by: `founder (qa owner-whatsapp ${runId})`, reason: `owner-whatsapp acceptance ${runId}: lift founder pause` });
    }

    // ── Notifications ────────────────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("notifications")) {
      await owner("What needs me?"); // keeps the synthetic owner inside WhatsApp's 24-hour window
      // The durable outcome, not a call's return value: the customer webhook itself notifies the owner (the route
      // calls notifyOwnerAttention after every customer turn), so the runner's own call is only a fallback.
      const attention = async () => (await listBriefs(BIZ)).filter((b) => b.kind === "attention" && b.to === masked);
      const baseline = new Set((await attention()).map((b) => b.key));
      const c = customer(qaName(runId, 4));
      await c.send("Hello, I need to speak with someone please");
      let handoff = readHandoffs((await state(c.id))!).find((h) => h.status !== "resolved");
      const handoffBy = handoff ? "the live model (customer webhook)" : "the runner (deterministic fallback: the model did not hand off)";
      if (!handoff) {
        await updateConversation(c.id, (s) => createHandoff(graph, s, { trigger: "customer_asked", reason: "wants a person" }));
        handoff = readHandoffs((await state(c.id))!).find((h) => h.status !== "resolved");
      }
      const item = `handoff:${handoff?.id}`;
      const forHandoff = async () => (await attention()).filter((b) => (b.items ?? []).includes(item));
      let notices = (await forHandoff()).filter((b) => !baseline.has(b.key));
      const notifiedBy = notices.length ? "the customer webhook" : "the runner (fallback notifyOwnerAttention)";
      if (!notices.length) {
        await notifyOwnerAttention(graph);
        notices = (await forHandoff()).filter((b) => !baseline.has(b.key));
      }
      check("notifications", "customer needs a person → exactly one durable owner attention notice for this handoff (coalesced) — dry run or truthfully blocked", Boolean(handoff) && notices.length === 1 && truthfulNotice(notices[0]) && notices[0].text.includes(c.name), { handoff: handoff?.id, handoffBy, notifiedBy, notices: notices.map((r) => ({ key: r.key, status: r.status, reason: r.reason, items: r.items, text: short(r.text) })) });
      // Dedupe: another attempt creates nothing — no second durable notice for the same handoff, ever.
      const again = (await notifyOwnerAttention(graph)).filter((r) => r.to === masked);
      const all = await forHandoff();
      check("notifications", "the same alert is never sent twice (a further attempt creates no second durable notice)", Boolean(handoff) && again.length === 0 && all.length === 1, { againReturned: again.length, durableForHandoff: all.length });
      const runBriefs = (await listBriefs(BIZ)).filter((b) => b.at >= startedAt);
      check("notifications", "no real sends in dry run: every owner notice in this run is dry_run or blocked (none sent)", runBriefs.length > 0 && runBriefs.every((b) => b.status === "dry_run" || b.status === "blocked"), runBriefs.map((b) => `${b.kind}:${b.status}`));
    }
  } catch (err) {
    if (err instanceof StageBudgetExceeded) check("restore", `stage stopped: it exceeded its ${Math.round((opts.budgetMs ?? STAGE_BUDGET_MS) / 1000)}s time budget (Vercel's limit is 300s) — the business is restored below`, false);
    else check("restore", "runner error", false, err instanceof Error ? err.message.slice(0, 300) : String(err));
  } finally {
    // ── Audit, then restore ──────────────────────────────────────────────────────────────────────────────
    const records = (await listCommandRecords(BIZ).catch(() => [])).filter((r) => r.createdAt >= startedAt && r.actor.includes(masked));
    const mutations = records.filter((r) => ["approval_response", "conversation_takeover", "conversation_reply", "conversation_giveback", "mode_change", "affirm", "negate"].includes(r.intent?.kind ?? ""));
    const mutating = opts.stages.some((x) => x === "decisions" || x === "conversation" || x === "mode");
    if (mutating) check("audit", "every owner mutation is a durable command record with its actor and trace", mutations.length > 0 && mutations.every((r) => r.status === "done" && r.trace.length >= 3), mutations.map((r) => `${r.intent?.kind}: ${r.trace.map((t) => `${t.step}/${t.outcome}`).join(" ")}`));
    else check("audit", "read-only stages: the owner's commands mutated nothing (no decision, takeover, reply, give back or mode change)", records.length > 0 && mutations.length === 0, { commands: records.length, mutations: mutations.map((r) => r.intent?.kind) });
    if (opts.stages.includes("mode")) {
      const audit = (await listControlAudit(BIZ)).filter((a) => a.at >= startedAt && a.by.includes(masked));
      check("audit", "the owner's pause / resume are in the controls audit (who, when, before → after)", audit.length >= 2, audit.map((a) => `${a.at} ${a.by}: ${a.before.pausedBusiness ? "paused" : "running"} → ${a.after.pausedBusiness ? "paused" : "running"}`));
    }
    const held = report.conversations.length ? await Promise.all(report.conversations.map(async (id) => readControlLog((await state(id)) ?? ({ knownFields: {} } as never)))) : [];
    if (opts.stages.includes("conversation")) check("audit", "conversation ownership changes are in the stored control log", held.some((log) => log.some((e) => /owner on WhatsApp/.test(e.by))), held.flat().map((e) => `${e.from}->${e.to} by ${e.by}`));
    if (linkId) await revokeOwnerIdentity(BIZ, linkId, `qa owner-whatsapp ${runId}: end of run`).catch(() => undefined);
    // Through the durable restore point (original mode + pause, every synthetic owner link revoked, point cleared).
    await restoreFromPoint(BIZ, by, `owner-whatsapp acceptance ${runId}: restore`).catch((e) => check("restore", "restore controls", false, e instanceof Error ? e.message : "failed"));
    const restored = await loadControls(BIZ);
    check("restore", "test business restored to its original mode; synthetic owner revoked; restore point cleared", restored.mode === original.mode && restored.pausedBusiness === original.pausedBusiness && !(await listOwnerIdentities(BIZ)).some((l) => l.channelUserId === OWNER && l.status === "active") && !(await readRestorePoint(BIZ)), { mode: restored.mode, paused: restored.pausedBusiness, original: { mode: original.mode, paused: original.pausedBusiness } });
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.filter((c) => c.ok).length;
    report.failed = report.checks.length - report.passed;
    report.verdict = report.failed === 0 ? "PASS" : "FAIL";
    await getBackend().upsertOperatorRecord({ businessId: BIZ, kind: "founder_state", key: `qa_owner_whatsapp:${runId}`, data: report as unknown as Record<string, unknown> }).catch(() => undefined);
  }
  return report;
}

export async function loadOwnerWhatsappReport(runId: string): Promise<OwaReport | undefined> {
  const r = (await getBackend().listOperatorRecords(BIZ, "founder_state")).find((x) => x.key === `qa_owner_whatsapp:${runId}`);
  return r?.data as unknown as OwaReport | undefined;
}

/** Remove one run's synthetic customer conversations (9997… numbers only); the evidence record stays. */
export async function cleanupOwnerWhatsappRun(runId: string): Promise<number> {
  const report = await loadOwnerWhatsappReport(runId);
  if (!report) return 0;
  let removed = 0;
  for (const id of report.conversations) {
    if (!id.startsWith(`wa:${BIZ}:9997`)) continue;
    removed += await getConversationStore().deleteConversationsByPrefix(BIZ, id);
  }
  return removed;
}
