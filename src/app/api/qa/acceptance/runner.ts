import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { POST as whatsappPost } from "@/app/api/channels/whatsapp/route";
import { POST as handoffsPost } from "@/app/api/owner/handoffs/route";
import { POST as approvalsPost } from "@/app/api/owner/approvals/route";
import { POST as modePost } from "@/app/api/owner/mode/route";
import { GET as conversationGet } from "@/app/api/owner/conversation/route";
import { POST as controlsPost } from "@/app/api/hq/controls/route";
import { GET as cronGet, POST as cronPost } from "@/app/api/cron/background/route";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { updateConversation } from "@/lib/state/update";
import { getInboxStore } from "@/lib/channels/inbox";
import { getReasoner } from "@/lib/reasoner";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { applyControlChange, listControlAudit, loadControls } from "@/lib/hq/controls";
import { databaseProjectRef } from "@/lib/qa/preview-acceptance-guard";

/** The routed WhatsApp test business the acceptance runs against (synthetic customers only). */
export const ACCEPTANCE_BUSINESS = "fashion-retailer";
const BIZ = ACCEPTANCE_BUSINESS;

/**
 * IN-DEPLOYMENT PREVIEW ACCEPTANCE — the same checks as scripts/acceptance/preview-live.mjs, run INSIDE the
 * Preview deployment so they use its own secrets without ever exporting them. Every step goes through the real
 * route handlers (signature verification, owner / founder / cron auth, the gateway, the live reasoner, the
 * Supabase stores) with real Request objects; nothing is mocked.
 *
 * Synthetic customers only: numbers start with 999 (an unassigned country code — never a real person), one
 * per stage, profile name "QA acceptance <run>"; every conversation is stamped `__qaAcceptance=<run>`.
 * Sending is dry_run (the route refuses otherwise). The business's controls are restored at the end.
 */

export const STAGES = ["channel", "handoff", "supervised", "mode", "cron"] as const;
export type Stage = (typeof STAGES)[number];
export type Check = { stage: Stage | "preflight" | "audit" | "restore"; name: string; ok: boolean; detail?: unknown };
export type AcceptanceReport = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  verdict?: "PASS" | "FAIL";
  stages: Stage[];
  deployment: { environment: string | undefined; databaseProject: string | null; commit: string | null; reasoner: string; storage: string; sendMode: string | undefined };
  conversations: string[];
  checks: Check[];
  passed?: number;
  failed?: number;
  cleanup: string;
};

const BASE = "https://preview-acceptance.internal";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Creds = { appSecret: string; ownerToken: string; founderToken: string; cronSecret: string };

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers: init.headers, body: init.body });
}
async function json(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: { text: text.slice(0, 200) } };
  }
}

export async function runPreviewAcceptance(creds: Creds, opts: { phoneNumberId: string; stages: Stage[]; runId: string }): Promise<AcceptanceReport> {
  const { runId, phoneNumberId } = opts;
  const startedAt = new Date().toISOString();
  let reasonerName = "unavailable";
  try {
    reasonerName = getReasoner().name;
  } catch {
    /* reported below */
  }
  const report: AcceptanceReport = {
    runId,
    startedAt,
    stages: opts.stages,
    deployment: { environment: process.env.VERCEL_ENV, databaseProject: databaseProjectRef(), commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null, reasoner: reasonerName === "llm" ? "live model" : reasonerName, storage: isSupabaseConfigured() ? "durable (Supabase)" : "memory", sendMode: process.env.BARRY_WHATSAPP_SEND },
    conversations: [],
    checks: [],
    cleanup: `Synthetic conversations are stamped __qaAcceptance=${runId} (ids wa:${BIZ}:999…). POST { "cleanup": "${runId}" } deletes them; this report is kept.`,
  };
  const check = (stage: Check["stage"], name: string, ok: boolean, detail?: unknown) => report.checks.push({ stage, name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });

  const owner = { "x-barry-owner-token": creds.ownerToken, "content-type": "application/json" };
  const founder = { authorization: `Bearer ${creds.founderToken}`, "content-type": "application/json" };
  const digits = String(parseInt(runId.replace(/\D/g, "").slice(-7) || "0", 10)).padStart(7, "0");
  const phoneFor = (stage: Stage) => `999${STAGES.indexOf(stage)}${digits}`;
  const convFor = (stage: Stage) => `wa:${BIZ}:${phoneFor(stage)}`;
  let seq = 0;

  const webhook = (stage: Stage, text: string, id = `wamid.qa.${runId}.${++seq}`) => {
    const phone = phoneFor(stage);
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: phone, profile: { name: `QA acceptance ${runId}` } }], messages: [{ id, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
    const signature = `sha256=${crypto.createHmac("sha256", creds.appSecret).update(raw, "utf8").digest("hex")}`;
    return { id, send: async (sig = signature) => json(await whatsappPost(req("/api/channels/whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }))) };
  };
  /** Meta re-delivers on non-2xx; emulate it (bounded). */
  const deliver = async (w: ReturnType<typeof webhook>) => {
    let r = await w.send();
    for (let i = 0; i < 3 && r.status !== 200; i++) {
      await sleep(1500 * (i + 1));
      r = await w.send();
    }
    return r;
  };
  type View = { messages: { from: string; text: string; notSent?: string }[]; deliveries: { inboundId: string; status: string }[]; control?: { holder: string }; controlLog?: { from: string; to: string; by: string; at: string }[]; turns?: { customerMessage: string; actions: string[]; stoppedBecause: string | null }[] };
  const view = async (stage: Stage): Promise<View> => (await json(await conversationGet(req(`/api/owner/conversation?businessId=${BIZ}&conversationId=${encodeURIComponent(convFor(stage))}&advanced=1`, { headers: owner })))).body as unknown as View;
  const n = (v: View, from: string) => (v.messages ?? []).filter((m) => m.from === from).length;
  const deliveriesOf = (v: View, id: string) => (v.deliveries ?? []).filter((d) => d.inboundId === id);
  const mark = async (stage: Stage) => {
    const id = convFor(stage);
    if (!report.conversations.includes(id)) report.conversations.push(id);
    await updateConversation(id, (s) => {
      s.knownFields.__qaAcceptance = runId;
    }).catch(() => undefined);
  };

  // ── Preflight ─────────────────────────────────────────────────────────────────────────────────────────
  const original = await loadControls(BIZ);
  check("preflight", "live reasoner", reasonerName === "llm", report.deployment.reasoner);
  check("preflight", "durable Supabase storage on the Preview project", isSupabaseConfigured() && report.deployment.databaseProject === "glqrfoljvdbyrmbvupym", report.deployment.databaseProject);
  check("preflight", "WhatsApp sending is dry_run", process.env.BARRY_WHATSAPP_SEND === "dry_run");
  const badSig = await webhook("channel", "unsigned probe").send("sha256=" + "0".repeat(64));
  check("preflight", "webhook with a wrong signature is rejected before anything runs", badSig.status === 401, badSig.status);
  // A known starting point: SIMULATOR, not paused (restored to the original at the end).
  await applyControlChange(BIZ, { mode: "simulator", pausedBusiness: false }, { by: `founder (qa acceptance ${runId})`, reason: `acceptance ${runId}: known starting point` });

  try {
    // ── Channel: inbound, reply, truthful dry run, duplicate id, burst, persistence ──────────────────────
    if (opts.stages.includes("channel")) {
      const m1 = webhook("channel", "Hi! Do you have the Midnight Wrap Dress?");
      const r1 = await deliver(m1);
      await mark("channel");
      let v = await view("channel");
      check("channel", "signed inbound webhook accepted and processed", r1.status === 200 && (r1.body.processed as number) === 1, r1.body);
      check("channel", "BARRY generated a reply (live reasoner) and the conversation persisted", n(v, "customer") === 1 && n(v, "barry") === 1, { last: v.messages?.at(-1)?.text?.slice(0, 160) });
      const d1 = deliveriesOf(v, m1.id);
      check("channel", "truthful dry-run delivery (one record, status dry_run, transcript marked not sent)", d1.length === 1 && d1[0].status === "dry_run" && v.messages.find((m) => m.from === "barry")?.notSent === "dry_run", d1);
      const dup = await Promise.all([m1.send(), m1.send()]);
      await m1.send();
      v = await view("channel");
      check("channel", "duplicate Meta message id: no second turn, no second delivery", n(v, "customer") === 1 && n(v, "barry") === 1 && deliveriesOf(v, m1.id).length === 1, dup.map((d) => d.status));
      const burst = ["Is it available in M?", "And in L?", "What does it cost?"].map((t) => webhook("channel", t));
      const first = await Promise.all(burst.map((w) => w.send()));
      for (const [i, w] of burst.entries()) if (first[i].status !== 200) await deliver(w);
      v = await view("channel");
      const texts = v.messages.filter((m) => m.from === "customer").map((m) => m.text);
      check("channel", "rapid burst: every message stored, in order", JSON.stringify(texts.slice(-3)) === JSON.stringify(["Is it available in M?", "And in L?", "What does it cost?"]), { firstStatuses: first.map((f) => f.status), texts });
      check("channel", "rapid burst: exactly one delivery per inbound (no duplicate sends)", burst.every((w) => deliveriesOf(v, w.id).length === 1), burst.map((w) => deliveriesOf(v, w.id).length));
      // Straight from the database (not the view): durable rows.
      const stored = await getConversationStore().get(convFor("channel"));
      const inbox = await getInboxStore().listByConversation(convFor("channel"));
      check("channel", "durable persistence: conversation, turns and inbox rows in Supabase", Boolean(stored) && (stored!.version ?? 0) > 0 && stored!.turns.length === 4 && inbox.length === 4 && new Set(inbox.map((r) => r.providerMessageId)).size === 4 && inbox.every((r) => r.status === "dry_run"), { version: stored?.version, turns: stored?.turns.length, inbox: inbox.map((r) => r.status) });
      check("channel", "every turn used the live reasoner", (stored?.turns ?? []).every((t) => t.reasoner === "llm"), stored?.turns.map((t) => t.reasoner));
    }

    // ── Handoff: take over, customer writes, owner reply (idempotent), give back ───────────────────────────
    if (opts.stages.includes("handoff")) {
      await deliver(webhook("handoff", "Hello, I have a question about an order"));
      await mark("handoff");
      const take = await json(await handoffsPost(req("/api/owner/handoffs", { method: "POST", headers: owner, body: JSON.stringify({ businessId: BIZ, conversationId: convFor("handoff"), action: "take_over" }) })));
      check("handoff", "owner takes over the conversation", take.status === 200 && (take.body.control as { holder?: string })?.holder === "human", take.body.control);
      const before = n(await view("handoff"), "barry");
      const held = webhook("handoff", "Hello? Is anyone there?");
      const hr = await deliver(held);
      let v = await view("handoff");
      check("handoff", "customer message stored while a person owns the conversation", v.messages.at(-1)?.from === "customer" && v.messages.at(-1)?.text === "Hello? Is anyone there?", hr.body);
      check("handoff", "BARRY silent during human ownership (no reply, no delivery)", n(v, "barry") === before && deliveriesOf(v, held.id).length === 0);
      const requestId = `${runId}-owner-reply`;
      const replyBody = JSON.stringify({ businessId: BIZ, conversationId: convFor("handoff"), action: "reply", requestId, text: "Hi, this is the team — checking for you now." });
      const replies = await Promise.all([1, 2].map(async () => json(await handoffsPost(req("/api/owner/handoffs", { method: "POST", headers: owner, body: replyBody })))));
      const again = await json(await handoffsPost(req("/api/owner/handoffs", { method: "POST", headers: owner, body: replyBody })));
      v = await view("handoff");
      check("handoff", "owner reply goes through BARRY's channel, stored as the owner's (dry run)", n(v, "owner") === 1 && replies.some((r) => r.status === 200 && (r.body.reply as { status?: string })?.status === "dry_run"), replies.map((r) => r.status));
      check("handoff", "owner reply idempotency: concurrent + repeated request → one message, one delivery", n(v, "owner") === 1 && deliveriesOf(v, `owner:${requestId}`).length === 1, { thirdStatus: again.status });
      const back = await json(await handoffsPost(req("/api/owner/handoffs", { method: "POST", headers: owner, body: JSON.stringify({ businessId: BIZ, conversationId: convFor("handoff"), action: "resume" }) })));
      check("handoff", "control returned to BARRY", back.status === 200 && (back.body.control as { holder?: string })?.holder === "barry");
      await deliver(webhook("handoff", "Thanks! Do you ship to Haifa?"));
      v = await view("handoff");
      check("handoff", "BARRY answers again after give-back", v.messages.at(-1)?.from === "barry");
      check("handoff", "control log reconstructs who owned it and when", (v.controlLog ?? []).map((e) => `${e.from}->${e.to}`).join(",") === "barry->human,human->barry", v.controlLog);
    }

    // ── SUPERVISED: low-risk autonomy, consequential approval, approve + decline ───────────────────────────
    if (opts.stages.includes("supervised")) {
      const sup = await json(await controlsPost(req("/api/hq/controls", { method: "POST", headers: founder, body: JSON.stringify({ businessId: BIZ, reason: `acceptance ${runId}: supervised`, confirm: "yes", mode: "supervised" }) })));
      check("supervised", "founder sets SUPERVISED (audited)", sup.status === 200 && (sup.body.controls as { mode?: string })?.mode === "supervised");
      const backend = getBackend();
      const pendingFor = async (conv: string) => (await backend.listApprovals(BIZ)).filter((a) => a.conversationId === conv && a.status === "pending");
      const shop = async (stage: Stage, phoneSuffix: string) => {
        // Two customers on the supervised stage share the stage prefix; the second gets its own number.
        const phone = `${phoneFor(stage)}${phoneSuffix}`.slice(0, 15);
        const conv = `wa:${BIZ}:${phone}`;
        const send = (text: string) => {
          const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: phone, profile: { name: `QA acceptance ${runId}` } }], messages: [{ id: `wamid.qa.${runId}.${++seq}`, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
          const sig = `sha256=${crypto.createHmac("sha256", creds.appSecret).update(raw, "utf8").digest("hex")}`;
          return deliver({ id: "", send: async () => json(await whatsappPost(req("/api/channels/whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }))) });
        };
        await send("Hi, I'd like to buy the Midnight Wrap Dress in size M, please add it to my cart.");
        report.conversations.push(conv);
        await updateConversation(conv, (s) => {
          s.knownFields.__qaAcceptance = runId;
        }).catch(() => undefined);
        const steps = () => getConversationStore().get(conv).then((s) => (s?.turns ?? []).flatMap((t) => t.trace?.steps ?? []));
        let cartStep = (await steps()).find((s) => s.action === "addToCart" || s.action === "updateCartLine");
        if (!cartStep) {
          await send("Yes — size M, add one to my cart.");
          cartStep = (await steps()).find((s) => s.action === "addToCart" || s.action === "updateCartLine");
        }
        for (const text of ["Great, I want to check out now. My name is Dana Levi and my phone is 0501234567.", "Yes, please go ahead with the checkout."]) {
          if ((await pendingFor(conv)).length) break;
          await send(text);
        }
        const all = await steps();
        return { conv, cartStep, checkoutStep: all.find((s) => s.action === "createCommerceCheckout" || s.action === "createPaymentRequest" || s.action === "createCommerceOrder"), pending: await pendingFor(conv) };
      };
      const a = await shop("supervised", "1");
      check("supervised", "low-risk reversible action ran on its own (cart, no approval)", Boolean(a.cartStep) && a.cartStep!.policy.status === "allowed" && a.cartStep!.result?.ok === true, a.cartStep ? { action: a.cartStep.action, policy: a.cartStep.policy.status, ok: a.cartStep.result?.ok } : "no cart step (live model did not add to cart)");
      check("supervised", "consequential action (checkout / payment) required the owner's approval", Boolean(a.checkoutStep) && a.checkoutStep!.policy.status === "requires_approval" && a.pending.length === 1 && a.pending[0].policyId === "operating_mode:supervised", a.checkoutStep ? { action: a.checkoutStep.action, policy: a.checkoutStep.policy.status, policyId: a.pending[0]?.policyId } : "no checkout step");
      check("supervised", "no payment link was created before approval", !a.pending.length || !(await getConversationStore().get(a.conv))?.knownFields.__paymentRequestId);
      if (a.pending[0]) {
        const ok = await json(await approvalsPost(req("/api/owner/approvals", { method: "POST", headers: owner, body: JSON.stringify({ businessId: BIZ, approvalId: a.pending[0].id, action: "approve" }) })));
        const twice = await json(await approvalsPost(req("/api/owner/approvals", { method: "POST", headers: owner, body: JSON.stringify({ businessId: BIZ, approvalId: a.pending[0].id, action: "approve" }) })));
        const rec = await backend.getApproval(a.pending[0].id);
        check("supervised", "owner approves → decided once, the runtime resumes", ok.status === 200 && rec?.status === "approved" && twice.status !== 500, { first: ok.status, result: ok.body.result, second: twice.status, status: rec?.status });
      } else check("supervised", "owner approves → decided once, the runtime resumes", false, "no approval to decide");
      const b = await shop("supervised", "2");
      if (b.pending[0]) {
        const no = await json(await approvalsPost(req("/api/owner/approvals", { method: "POST", headers: owner, body: JSON.stringify({ businessId: BIZ, approvalId: b.pending[0].id, action: "decline" }) })));
        const rec = await backend.getApproval(b.pending[0].id);
        const state = await getConversationStore().get(b.conv);
        check("supervised", "owner declines → declined, nothing charged", no.status === 200 && rec?.status === "declined" && !state?.knownFields.__paymentRequestId, { status: rec?.status, result: no.body.result });
      } else check("supervised", "owner declines → declined, nothing charged", false, "no approval to decide (live model did not reach checkout)");
    }

    // ── Pause / resume and operating-mode enforcement (customer runtime + scheduled work) ─────────────────
    const slotAt = (() => {
      const d = new Date(Date.now() + (30 + (Date.now() % 300)) * 24 * 3600_000);
      d.setUTCHours(9, 15, 0, 0); // 11:15–12:15 in the business's timezone (inside the 09–20 follow-up window)
      return d.toISOString();
    })();
    const followups = (r: { body: Record<string, unknown> }) => ((r.body.tick as { outcomes?: { job: string; decision: string; reason: string; summary?: { sent?: number; dryRun?: number } }[] })?.outcomes ?? []).find((o) => o.job === "followups");
    const slot = async () => json(await cronPost(req(`/api/cron/background?businessId=${BIZ}&at=${encodeURIComponent(slotAt)}`, { method: "POST", headers: { authorization: `Bearer ${creds.founderToken}` } })));

    if (opts.stages.includes("mode")) {
      if (!opts.stages.includes("supervised")) await applyControlChange(BIZ, { mode: "supervised" }, { by: `founder (qa acceptance ${runId})`, reason: `acceptance ${runId}: supervised` });
      await deliver(webhook("mode", "Hi, quick question about sizes"));
      await mark("mode");
      const pause = await json(await modePost(req("/api/owner/mode", { method: "POST", headers: owner, body: JSON.stringify({ businessId: BIZ, action: "pause" }) })));
      check("mode", "owner pauses BARRY", pause.status === 200 && pause.body.mode === "paused" && pause.body.pausedBy === "owner", pause.body);
      const before = n(await view("mode"), "barry");
      const p = webhook("mode", "Are you open today?");
      await deliver(p);
      const v = await view("mode");
      check("mode", "paused: the customer message is kept, nothing answered or sent", v.messages.at(-1)?.text === "Are you open today?" && n(v, "barry") === before && deliveriesOf(v, p.id).length === 0);
      const pausedSlot = followups(await slot());
      check("mode", "paused: scheduled follow-ups do not run", pausedSlot?.decision === "skipped" && /paused/.test(pausedSlot.reason), pausedSlot);
      const resume = await json(await modePost(req("/api/owner/mode", { method: "POST", headers: owner, body: JSON.stringify({ businessId: BIZ, action: "resume" }) })));
      check("mode", "owner resumes BARRY (back to SUPERVISED)", resume.status === 200 && resume.body.mode === "supervised", resume.body);
    }

    // ── Cron: auth, one run per slot, supervised respected, truthful counts ───────────────────────────────
    if (opts.stages.includes("cron")) {
      if ((await loadControls(BIZ)).mode !== "supervised") await applyControlChange(BIZ, { mode: "supervised" }, { by: `founder (qa acceptance ${runId})`, reason: `acceptance ${runId}: supervised` });
      const none = await cronGet(req("/api/cron/background"));
      const wrong = await cronGet(req("/api/cron/background", { headers: { authorization: "Bearer not-the-cron-secret-not-the-cron-secret" } }));
      check("cron", "cron refuses no secret and a wrong secret", none.status === 401 && wrong.status === 401, [none.status, wrong.status]);
      const real = await json(await cronGet(req("/api/cron/background", { headers: { authorization: `Bearer ${creds.cronSecret}` } })));
      const tick = real.body.tick as { evaluated?: number; ran?: number; failed?: number; outcomes?: unknown[] } | undefined;
      check("cron", "cron runs with the deployment's secret; failures are reported (non-2xx) with every outcome", (real.status === 200 || real.status === 500) && Array.isArray(tick?.outcomes) && (real.status === 500) === Boolean(tick?.failed), { status: real.status, evaluated: tick?.evaluated, ran: tick?.ran, failed: tick?.failed });
      const first = followups(await slot());
      const second = followups(await slot());
      check("cron", "one run per slot: the same slot evaluated twice runs once", first?.decision === "ran" && second?.decision === "skipped" && /already ran/.test(second?.reason ?? ""), { first, second });
      check("cron", "operating mode enforced: SUPERVISED scheduled work sends nothing on its own; dry runs not counted as sent", (first?.summary?.sent ?? 0) === 0 && /supervised/.test(first?.reason ?? ""), first);
    }
  } catch (err) {
    check("restore", "runner error", false, err instanceof Error ? err.message.slice(0, 300) : String(err));
  } finally {
    // ── Restore the test business exactly as it was, then reconstruct the audit trail ─────────────────────
    await applyControlChange(BIZ, { mode: original.mode, pausedBusiness: original.pausedBusiness }, { by: `founder (qa acceptance ${runId})`, reason: `acceptance ${runId}: restore` }).catch((e) => check("restore", "restore controls", false, e instanceof Error ? e.message : "failed"));
    const restored = await loadControls(BIZ);
    check("restore", "test business restored to its original mode", restored.mode === original.mode && restored.pausedBusiness === original.pausedBusiness, { mode: restored.mode, paused: restored.pausedBusiness });
    const audit = (await listControlAudit(BIZ)).filter((a) => a.at >= startedAt).sort((x, y) => x.at.localeCompare(y.at));
    const trail = audit.map((a) => ({ at: a.at, by: a.by, from: `${a.before.mode}${a.before.pausedBusiness ? "+paused" : ""}`, to: `${a.after.mode}${a.after.pausedBusiness ? "+paused" : ""}` }));
    const expectsMode = opts.stages.includes("mode");
    check("audit", "every control change in this run is audited (who, when, before → after)", audit.length > 0 && audit.every((a) => a.by && a.at) && (!expectsMode || (trail.some((t) => t.by === "the owner (web)" && t.to.endsWith("+paused")) && trail.some((t) => t.by === "the owner (web)" && t.from.endsWith("+paused")))), trail);
    if (opts.stages.includes("handoff")) {
      const log = JSON.parse((await getConversationStore().get(convFor("handoff")))?.knownFields.__controlLog ?? "[]") as { from: string; to: string; by: string; at: string }[];
      check("audit", "conversation ownership reconstructable from the stored control log", log.length >= 2 && log.every((e) => e.by && e.at), log.map((e) => `${e.at} ${e.from}->${e.to} by ${e.by}`));
    }
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.filter((c) => c.ok).length;
    report.failed = report.checks.length - report.passed;
    report.verdict = report.failed === 0 ? "PASS" : "FAIL";
    // The auditable evidence record (no secrets: statuses, ids, counts and short texts only).
    await getBackend().upsertOperatorRecord({ businessId: BIZ, kind: "founder_state", key: `qa_acceptance:${runId}`, data: report as unknown as Record<string, unknown> }).catch(() => undefined);
  }
  return report;
}

export async function loadAcceptanceReport(runId: string): Promise<AcceptanceReport | undefined> {
  const r = (await getBackend().listOperatorRecords(BIZ, "founder_state")).find((x) => x.key === `qa_acceptance:${runId}`);
  return r?.data as unknown as AcceptanceReport | undefined;
}

/** Remove one run's synthetic conversations (messages and turns cascade); the evidence record stays. */
export async function cleanupAcceptanceRun(runId: string): Promise<number> {
  const report = await loadAcceptanceReport(runId);
  if (!report) return 0;
  let removed = 0;
  for (const id of report.conversations) {
    if (!id.startsWith(`wa:${BIZ}:999`)) continue; // only ever synthetic numbers
    removed += await getConversationStore().deleteConversationsByPrefix(BIZ, id);
  }
  return removed;
}
