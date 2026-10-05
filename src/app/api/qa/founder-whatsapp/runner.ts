import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { POST as whatsappPost } from "@/app/api/channels/whatsapp/route";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { updateConversation } from "@/lib/state/update";
import { getReasoner } from "@/lib/reasoner";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { listControlAudit, loadControls } from "@/lib/hq/controls";
import { observeGraphSends, parseWebhook, whatsappConfig, whatsappFounderConfig, whatsappRoleRouting, whatsappSendModes, type GraphSendAttempt } from "@/lib/channels/whatsapp";
import { setRoleSendersOverride } from "@/lib/channels/role-routing";
import { createLinkCode, listOwnerIdentities, revokeOwnerIdentity } from "@/lib/owner-channel/identity";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import type { OwnerInbound, OwnerSender } from "@/lib/owner-channel/transport";
import { createFounderLinkCode, founderRef, listFounderIdentities, revokeFounderIdentity } from "@/lib/founder-channel/identity";
import { processFounderInbound, type FounderInboundResult } from "@/lib/founder-channel/gateway";
import { founderAlertItems, listFounderNotices, notifyFounderAlerts, sendFounderDailyBrief } from "@/lib/founder-channel/alerts";
import { getFounderCommand, listFounderCommands } from "@/lib/founder/command-service";
import { loadValueAccount } from "@/lib/commercial/value";
import { monthPeriod } from "@/lib/commercial/cost";
import { hasMoney } from "@/lib/format/money";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { databaseProjectRef } from "@/lib/qa/preview-acceptance-guard";
import { countSyntheticIdentities, ensureRestorePoint, readRestorePoint, restoreFromPoint, revokeSyntheticIdentities } from "@/lib/qa/restore-point";
import { ACCEPTANCE_BUSINESS } from "../acceptance/runner";

const BIZ = ACCEPTANCE_BUSINESS;

/**
 * FOUNDER WHATSAPP V1 — DEPLOYED PREVIEW ACCEPTANCE (temporary QA surface). Runs INSIDE the Preview deployment with
 * its own secrets, the Preview Supabase, the live model (interpreter + composer) and dry-run transport:
 *
 *  - the founder writes through the real founder gateway (`processFounderInbound`: HQ-issued link code → verified
 *    founder identity → session → the Founder BARRY command service → audited founder controls) from a synthetic
 *    9998… number linked for the run and revoked at the end;
 *  - a synthetic business owner (9998 2…) and a synthetic customer (9996…) prove they never reach the founder path;
 *  - founder controls are applied ONLY to the test business, and every lever is restored from a durable restore point.
 *
 * Every check reads the durable records (founder command traces, the controls audit, the controls themselves).
 */

export const FWA_STAGES = ["identity", "reads", "context", "mutations", "notifications", "shared_line"] as const;
export type FwaStage = (typeof FWA_STAGES)[number];
export type FwaCheck = { stage: FwaStage | "preflight" | "audit" | "restore"; name: string; ok: boolean; detail?: unknown };
export type FwaReport = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  verdict?: "PASS" | "FAIL";
  stages: FwaStage[];
  deployment: { environment: string | undefined; databaseProject: string | null; commit: string | null; reasoner: string; founderModel: string; storage: string; sendMode: string | undefined; founderLine: string };
  founder: string;
  conversations: string[];
  checks: FwaCheck[];
  passed?: number;
  failed?: number;
  cleanup: string;
};

const BASE = "https://preview-acceptance.internal";
const short = (s: string | undefined, n = 240) => (s ?? "").slice(0, n);
/** The founder line in this run: dry run (recorded, never sent). */
const dryLine: OwnerSender = { channel: "whatsapp", mode: "dry_run", send: async () => ({}) };
export const FWA_STAGE_BUDGET_MS = 230_000;
class StageBudgetExceeded extends Error {
  constructor() {
    super("the stage ran out of its time budget");
  }
}

export async function runFounderWhatsappAcceptance(creds: { appSecret: string }, opts: { phoneNumberId: string; stages: FwaStage[]; runId: string; budgetMs?: number }): Promise<FwaReport> {
  const { runId, phoneNumberId } = opts;
  const startedAt = new Date().toISOString();
  let reasonerName = "unavailable";
  try {
    reasonerName = getReasoner().name;
  } catch {
    /* reported below */
  }
  const digits = String(parseInt(runId.replace(/\D/g, "").slice(-7) || "0", 10)).padStart(7, "0");
  const FOUNDER = `99980${digits}`;
  const FOUNDER_B = `99983${digits}`;
  const STRANGER = `99981${digits}`;
  const OWNER = `99982${digits}`;
  const masked = `···${FOUNDER.slice(-4)}`;
  // Shared-line synthetic numbers: distinct last digits so the masked identities (···1234) never collide.
  const d6 = digits.slice(1);
  const SF = `99984${d6}1`;
  const liveModel = process.env.BARRY_REASONER === "openai" && Boolean(process.env.OPENAI_API_KEY);
  const report: FwaReport = {
    runId,
    startedAt,
    stages: opts.stages,
    deployment: { environment: process.env.VERCEL_ENV, databaseProject: databaseProjectRef(), commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null, reasoner: reasonerName === "llm" ? "live model" : reasonerName, founderModel: liveModel ? "live model (interpreter + composer, checked)" : "deterministic only", storage: isSupabaseConfigured() ? "durable (Supabase)" : "memory", sendMode: process.env.BARRY_WHATSAPP_SEND, founderLine: whatsappFounderConfig().configured ? `configured (${whatsappFounderConfig().sendMode}; this run uses a dry-run line)` : "not configured — replies recorded as dry run here" },
    founder: `synthetic founder ${masked} (linked for this run, revoked at the end)`,
    conversations: [],
    checks: [],
    cleanup: `Synthetic customer conversations are stamped __qaAcceptance=${runId} (ids wa:${BIZ}:999…). POST { "cleanup": "${runId}" } deletes them; this report is kept.`,
  };
  const check = (stage: FwaCheck["stage"], name: string, ok: boolean, detail?: unknown) => report.checks.push({ stage, name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  const deadline = Date.now() + (opts.budgetMs ?? FWA_STAGE_BUDGET_MS);
  const budget = () => {
    if (Date.now() > deadline) throw new StageBudgetExceeded();
  };

  let seq = 0;
  const inbound = (text: string, from: string, messageId = `wamid.fwa.${runId}.${++seq}`, actionId?: string): OwnerInbound => ({ channel: "whatsapp", messageId, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), ...(actionId ? { actionId } : { text }) });
  /** The founder writes (the real gateway; live interpreter + composer when configured). */
  const founder = async (text: string, o: { from?: string; messageId?: string; actionId?: string } = {}) => {
    budget();
    const r: FounderInboundResult = await processFounderInbound(inbound(text, o.from ?? FOUNDER, o.messageId, o.actionId), dryLine);
    const reply = r.status === "processed" || r.status === "duplicate" ? r.reply : undefined;
    const record = reply ? await getFounderCommand(reply.key) : undefined;
    return { status: r.status, reply, record, text: r.status === "processed" || r.status === "duplicate" ? r.outbound.text : "", actions: r.status === "processed" || r.status === "duplicate" ? (r.outbound.actions ?? []) : [], delivery: r.status === "processed" ? r.delivery?.status : undefined };
  };
  const said = (x: Awaited<ReturnType<typeof founder>>) => ({ status: x.status, intent: x.reply?.intent, scope: x.reply?.scope, result: x.reply?.status, reply: short(x.text) });

  const customer = async (text: string) => {
    budget();
    const phone = `99960${digits}`;
    const id = `wa:${BIZ}:${phone}`;
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: phone, profile: { name: `QA founder ${runId}` } }], messages: [{ id: `wamid.fwa.cust.${runId}.${++seq}`, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
    const sig = `sha256=${crypto.createHmac("sha256", creds.appSecret).update(raw, "utf8").digest("hex")}`;
    const res = await whatsappPost(new NextRequest(`${BASE}/api/channels/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }));
    if (!report.conversations.includes(id)) {
      report.conversations.push(id);
      await updateConversation(id, (s) => {
        s.knownFields.__qaAcceptance = runId;
      }).catch(() => undefined);
    }
    return { status: res.status, id };
  };

  // ── Restore point (recover a run that died first), preflight ─────────────────────────────────────────
  const by = `founder (qa founder-whatsapp ${runId})`;
  if (await readRestorePoint(BIZ)) {
    const rec = await restoreFromPoint(BIZ, by, `founder-whatsapp acceptance ${runId}: recover from an interrupted earlier run`);
    check("preflight", "recovered the test business from an interrupted earlier run (restore point)", rec.restored, rec);
  }
  // Stale synthetic (999…) owner / founder identities from an interrupted earlier run — even one that left no restore
  // point — are revoked before anything runs. Real owners and the real founder are never touched.
  const stale = await revokeSyntheticIdentities(by, `founder-whatsapp acceptance ${runId}: stale synthetic identities from an earlier run`);
  const clean = await countSyntheticIdentities();
  check("preflight", "no synthetic owner or founder identity is active before the run (stale ones from an earlier run revoked)", clean.syntheticOwnersActive === 0 && clean.syntheticFoundersActive === 0, { staleRevoked: stale, ...clean });
  const original = await ensureRestorePoint(BIZ, by);
  check("preflight", "live reasoner", reasonerName === "llm", report.deployment.reasoner);
  check("preflight", "durable Supabase storage on the Preview project", isSupabaseConfigured() && report.deployment.databaseProject === "glqrfoljvdbyrmbvupym", report.deployment.databaseProject);
  // Customer and owner lines must be dry run. The founder line may be live for the real founder; in THIS run every
  // founder reply and notice goes to a dry-run line (synthetic founders only), so nothing is sent either way.
  const modes = whatsappSendModes();
  check("preflight", "customer and owner sending is dry_run; founder replies in this run are dry run (synthetic founders only)", process.env.BARRY_WHATSAPP_SEND === "dry_run" && modes.customer === "dry_run" && modes.owner === "dry_run", modes);

  const fid = `whatsapp:${FOUNDER}`;
  // ── Real-transport instrumentation: EVERY attempt to send through the real WhatsApp Cloud API (customer, owner or
  //    founder sender) is counted for the report; one to a synthetic 999… recipient is blocked before any network call.
  //    QA replies go through recording dry senders, so the run must end with realGraphSendAttempts = 0.
  const graphAttempts: GraphSendAttempt[] = [];
  const stopObserving = observeGraphSends((a) => {
    graphAttempts.push(a);
    return a.to.replace(/\D/g, "").startsWith("999") ? "block" : undefined;
  });
  try {
    const { code } = await createFounderLinkCode({ label: `qa ${runId}` });
    const linked = await processFounderInbound(inbound(`LINK ${code}`, FOUNDER), dryLine);
    check("preflight", "synthetic founder linked with an HQ-issued one-time code (verified sender)", linked.status === "linked", linked.status);

    // ── Identity and separation ──────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("identity")) {
      const ok = await founder("What do I need to know today?");
      check("identity", "verified founder recognized and served by Founder BARRY", ok.status === "processed" && ok.reply?.intent === "fleet_read" && ok.record?.founder === `founder (whatsapp ${masked})`, said(ok));
      const before = (await listFounderCommands(500)).length;
      const stranger = await founder("Pause BARRY for Rina Studio", { from: STRANGER });
      check("identity", "an unknown sender is rejected — nothing recorded, nothing changed", stranger.status === "rejected" && (await listFounderCommands(500)).length === before && !(await loadControls(BIZ)).pausedBusiness, { status: stranger.status });
      // A business owner (a verified owner link for this very business) is not a founder.
      const oc = await createLinkCode(BIZ);
      const ol = await processOwnerInbound(inbound(`LINK ${oc.code}`, OWNER), dryLine, { businessIds: [BIZ] });
      const asFounder = await founder("Pause BARRY for Rina Studio", { from: OWNER });
      const ownerCodeOnFounderLine = await processFounderInbound(inbound(`LINK ${(await createLinkCode(BIZ)).code}`, OWNER), dryLine);
      check("identity", "a business owner (linked owner number) cannot use founder commands, and an owner code can't create founder access", ol.status === "linked" && asFounder.status === "rejected" && ownerCodeOnFounderLine.status === "rejected" && !(await loadControls(BIZ)).pausedBusiness, { ownerLinked: ol.status, onFounderPath: asFounder.status, ownerCodeOnFounderLine: ownerCodeOnFounderLine.status });
      const ownerLink = (await listOwnerIdentities(BIZ)).find((l) => l.channelUserId === OWNER && l.status === "active");
      if (ownerLink) await revokeOwnerIdentity(BIZ, ownerLink.id, `${by}: end of identity stage`);
      // A customer: the customer line never routes to the founder path, and a customer's words are a customer turn.
      const routes = whatsappConfig().routes;
      const probe = parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ id: `probe-${runId}`, from: FOUNDER, type: "text", text: { body: "pause BARRY for Rina Studio" } }] } }] }] }, routes);
      const c = await customer("Pause BARRY for Rina Studio please");
      check("identity", "a customer cannot use founder commands (customer line → customer turn; even the founder's own number there is a customer)", probe.messages.length === 1 && probe.founder.length === 0 && c.status === 200 && !(await loadControls(BIZ)).pausedBusiness, { customerParsed: probe.messages.length, founderParsed: probe.founder.length, webhook: c.status });
      // Revocation: a second synthetic founder, revoked → rejected at once.
      const { code: code2 } = await createFounderLinkCode({ label: `qa ${runId} b` });
      await processFounderInbound(inbound(`LINK ${code2}`, FOUNDER_B), dryLine);
      const linkB = (await listFounderIdentities()).find((l) => l.channelUserId === FOUNDER_B && l.status === "active");
      const beforeRevoke = await founder("What do I need to know today?", { from: FOUNDER_B });
      if (linkB) await revokeFounderIdentity(linkB.id, `${by}: revocation check`);
      const afterRevoke = await founder("What do I need to know today?", { from: FOUNDER_B });
      check("identity", "founder access is revocable: a revoked founder number is rejected immediately", beforeRevoke.status === "processed" && afterRevoke.status === "rejected", { before: beforeRevoke.status, after: afterRevoke.status });
    }

    // ── Reads (Hebrew + English; the same read models HQ shows) ──────────────────────────────────────────
    if (opts.stages.includes("reads")) {
      for (const [q, family, topic] of [
        ["מה קורה היום?", "fleet_read", "brief"],
        ["Which businesses need me?", "fleet_read", "attention"],
        ["איזה עסק צריך אותי?", "fleet_read", "attention"],
        ["יש תקלות?", "incident_read", "incidents"],
        ["Who is closest to going live?", "fleet_read", "launch"],
        ["יש אישורים שמחכים?", "fleet_read", "approvals"],
        ["Why isn't Rina Studio ready to go live?", "business_inspect", "readiness"],
        ["כמה אנחנו מוציאים על מודלים?", "commercial_read", "models"],
        ["איזה עסק הכי יקר לנו לתפעל?", "commercial_read", "cost_to_serve"],
      ] as const) {
        const r = await founder(q);
        const i = r.record?.intent as { family?: string; topic?: string; followUp?: string } | undefined;
        check("reads", `“${q}” → ${family}:${topic}`, r.status === "processed" && i?.family === family && (i.topic ?? i.followUp) === topic && r.reply?.status !== "failed" && r.text.length > 10, said(r));
      }
      const money = await founder("What's going on with Rina Studio money?");
      const v = await loadValueAccount(resolveBusinessGraph(BIZ), monthPeriod(new Date()), new Date()).catch(() => null);
      const made = { ...(v?.made.generated ?? {}), ...(v?.made.recovered ?? {}) };
      const grounded = money.record?.groundedAnswer ?? "";
      check("reads", "truthful money: from the records only; nothing verified is never claimed as made", money.reply?.intent === "business_inspect" && /nothing estimated/.test(grounded) && (hasMoney(made) || /nothing verified|couldn't read/.test(grounded)), { grounded: short(grounded, 400) });
      const models = await founder("How much are we spending on models?");
      const mg = models.record?.groundedAnswer ?? "";
      check("reads", "truthful model cost: estimated vs measured stated explicitly; nothing fabricated without a record", /No metered model usage|ESTIMATED|measured/.test(mg), { grounded: short(mg, 400) });
      const ready = await founder("Why isn't Rina Studio ready to go live?");
      check("reads", "readiness: the deterministic launch gate (blocked / unknown items named; unknown stays unknown)", /launch gate/.test(ready.record?.groundedAnswer ?? ""), { grounded: short(ready.record?.groundedAnswer, 400) });
    }

    // ── Conversational context ───────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("context")) {
      const a = await founder("מה קורה אצל רינה?");
      check("context", "Hebrew business name (alias) grounds to the business: “מה קורה אצל רינה?”", a.reply?.scope.kind === "business" && a.reply.scope.businessIds[0] === BIZ, said(a));
      const m = await founder("והכסף שלה?");
      check("context", "follow-up pronoun keeps the focus: “והכסף שלה?” → Rina's money", m.reply?.scope.businessIds[0] === BIZ && (m.record?.intent as { followUp?: string }).followUp === "money", said(m));
      const d = await founder("מה ברי עושה שם עכשיו?");
      check("context", "“there” (“שם”) resolves to the business in focus", d.reply?.scope.businessIds[0] === BIZ && d.reply?.intent === "business_inspect", said(d));
      const fleet = await founder("מה קורה היום?");
      const stale = await founder("תעצור שם את ברי");
      check("context", "an unrelated fleet question clears the focus: a later “stop BARRY there” asks which business — nothing changes", fleet.reply?.scope.kind === "fleet" && stale.reply?.status === "clarify" && !(await loadControls(BIZ)).pausedBusiness, { fleet: said(fleet), stale: said(stale) });
      const two = await founder("Pause BARRY for Rina Studio and Midtown Auto Care");
      check("context", "several businesses for a consequential action → clarification, never a guess", two.reply?.status === "clarify" && !(await loadControls(BIZ)).pausedBusiness, said(two));
      const none = await founder("Pause BARRY for Zyxwq Holdings");
      check("context", "an unknown business name → clarification, nothing changed", none.reply?.status === "clarify", said(none));
    }

    // ── Mutations (the existing founder controls; the test business only; audited before → after) ────────
    if (opts.stages.includes("mutations")) {
      const auditBefore = (await listControlAudit(BIZ)).length;
      await founder("מה קורה אצל רינה?");
      const p = await founder("תעצור שם את ברי");
      check("mutations", "pause asks for confirmation first (nothing changed yet), in Hebrew, naming the business", p.reply?.status === "needs_confirmation" && p.actions.length === 1 && !(await loadControls(BIZ)).pausedBusiness, said(p));
      const confirmId = p.actions[0]?.id ?? "";
      const tapId = `wamid.fwa.tap.${runId}`;
      const done = await founder("", { actionId: confirmId, messageId: tapId });
      const c1 = await loadControls(BIZ);
      check("mutations", "Confirm → the business is paused by this founder identity (verified in the durable controls)", done.reply?.status === "executed" && c1.pausedBusiness && /WhatsApp/.test(c1.pausedBy ?? ""), { ...said(done), pausedBy: c1.pausedBy });
      const auditAfterPause = (await listControlAudit(BIZ)).length;
      const dup = await founder("", { actionId: confirmId, messageId: tapId });
      const replay = await founder("", { actionId: confirmId });
      check("mutations", "duplicate inbound id / second tap: idempotent — no second execution, no second audit", dup.status === "duplicate" && (await listControlAudit(BIZ)).length === auditAfterPause && replay.reply?.replay === true, { duplicate: dup.status, replay: replay.reply?.replay });
      const r = await founder("תחזיר אותו לעבוד");
      const ry = await founder("כן");
      check("mutations", "resume a founder-paused business (“תחזיר אותו לעבוד” → “כן”)", r.reply?.status === "needs_confirmation" && ry.reply?.status === "executed" && !(await loadControls(BIZ)).pausedBusiness, { ask: said(r), yes: said(ry) });
      const ap = await founder("תדרוש אישור על כל פעולה משמעותית אצל העסק הזה");
      const apy = await founder("כן");
      check("mutations", "tighten: require approval for every consequential action", ap.reply?.status === "needs_confirmation" && apy.reply?.status === "executed" && (await loadControls(BIZ)).approvalRequiredForAll, { ask: said(ap), yes: said(apy) });
      const cp = await founder("Pause payments there");
      const cpy = await founder("yes");
      const capPaused = (await loadControls(BIZ)).pausedCapabilities;
      check("mutations", "pause a capability (payments.*) at that business", cp.reply?.status === "needs_confirmation" && cpy.reply?.status === "executed" && capPaused.includes("payments.*"), { ask: said(cp), yes: said(cpy), paused: capPaused });
      const cr = await founder("Resume payments there");
      const cry = await founder("yes");
      check("mutations", "resume the capability (stated as loosening control)", cr.reply?.status === "needs_confirmation" && /LOOSENS|מרפה/.test(cr.record?.groundedAnswer ?? cr.text) && cry.reply?.status === "executed" && !(await loadControls(BIZ)).pausedCapabilities.includes("payments.*"), { ask: said(cr), yes: said(cry) });
      const target = (await loadControls(BIZ)).mode === "supervised" ? "simulator" : "supervised";
      const sm = await founder(`Switch it to ${target} mode`);
      const smy = await founder("yes");
      check("mutations", `switch the operating mode (→ ${target}) through the founder control`, sm.reply?.status === "needs_confirmation" && smy.reply?.status === "executed" && (await loadControls(BIZ)).mode === target, { ask: said(sm), yes: said(smy) });
      const live = await founder("Switch it to live mode");
      check("mutations", "LIVE is never switched from a conversation (refused, nothing changed)", live.reply?.status === "clarify" && (await loadControls(BIZ)).mode === target, said(live));
      const audit = (await listControlAudit(BIZ)).filter((a) => a.at >= startedAt && a.by.includes(masked));
      check("audit", "every founder mutation is audited (who — this WhatsApp identity —, when, before → after); only the test business changed", audit.length === 6 && audit.every((a) => a.before && a.after) && (await listControlAudit(BIZ)).length - auditBefore >= 6, audit.map((a) => `${a.at} ${a.by}`));
    }

    // ── Proactive notifications ──────────────────────────────────────────────────────────────────────────
    if (opts.stages.includes("notifications")) {
      await founder("What do I need to know today?"); // keeps the synthetic founder inside WhatsApp's 24h window
      const ref = founderRef(fid);
      // Read-only here (observe: false): QA never consumes a real health / launch transition the founder should hear about.
      const real = await founderAlertItems({ observe: false });
      const reread = await founderAlertItems({ observe: false });
      check("notifications", "alert items derive from the real fleet records (incidents, health, launch gate, cost guardrail), deterministically", JSON.stringify(real.map((i) => i.category).sort()) === JSON.stringify(reread.map((i) => i.category).sort()), { items: real.map((i) => `${i.category}: ${short(i.text, 120)}`) });
      // The delivery pipeline (coalesce → dedupe → 24h window → dry run) with ONE clearly labelled QA item.
      const qaItem = { key: `qa:${runId}`, category: "critical_incident" as const, businessId: BIZ, businessName: "Rina Studio", text: `QA acceptance ${runId}: synthetic alert item (delivery-pipeline proof only)` };
      const synthetic = (l: { channelUserId: string }) => l.channelUserId.startsWith("999");
      const first = (await notifyFounderAlerts({ sender: dryLine, items: [qaItem], only: synthetic })).filter((n) => n.ref === ref);
      const again = (await notifyFounderAlerts({ sender: dryLine, items: [qaItem], only: synthetic })).filter((n) => n.ref === ref);
      check("notifications", "a founder notice is delivered once (dry run — nothing sent) and never twice", first.length === 1 && first[0].status === "dry_run" && again.length === 0 && (await listFounderNotices()).filter((n) => n.ref === ref && (n.items ?? []).includes(qaItem.key)).length === 1, { first: first.map((n) => n.status), again: again.length });
      const brief1 = (await sendFounderDailyBrief({ sender: dryLine, only: synthetic })).filter((n) => n.ref === ref);
      const brief2 = (await sendFounderDailyBrief({ sender: dryLine, only: synthetic })).filter((n) => n.ref === ref);
      check("notifications", "the daily founder brief goes at most once a day (nothing when the fleet is quiet)", brief1.length <= 1 && brief2.length === 0 && brief1.every((n) => n.status === "dry_run"), { first: brief1.map((n) => n.status), second: brief2.length });
      const all = (await listFounderNotices()).filter((n) => n.at >= startedAt && n.to === masked);
      const realFounders = (await listFounderIdentities()).filter((l) => l.status === "active" && !synthetic(l)).map((l) => founderRef(l.id));
      const touchedReal = (await listFounderNotices()).filter((n) => n.at >= startedAt && realFounders.includes(n.ref) && (n.items ?? []).includes(qaItem.key));
      check("notifications", "no real WhatsApp sends: every founder notice in this run is dry_run or blocked, and no real founder's notices were touched", all.every((n) => n.status === "dry_run" || n.status === "blocked") && touchedReal.length === 0, { run: all.map((n) => `${n.kind}:${n.status}`), realFounderNoticesTouched: touchedReal.length });
    }
    // ── ONE WhatsApp number, three roles (BARRY_WHATSAPP_ROLE_ROUTING=identity) — through the real signed webhook ──
    if (opts.stages.includes("shared_line")) {
      const routing = whatsappRoleRouting();
      check("shared_line", "single-number role routing is enabled (BARRY_WHATSAPP_ROLE_ROUTING=identity)", routing === "identity", { roleRouting: routing, sendModes: whatsappSendModes() });
      if (routing === "identity") {
        // Every role's sender is a RECORDING DRY sender for this stage: it notes which role answered and the mode that
        // role WOULD use (founder: BARRY_WHATSAPP_FOUNDER_SEND; owner: BARRY_WHATSAPP_OWNER_SEND; customer: BARRY_WHATSAPP_SEND) — nothing is sent.
        const sends: { role: string; wouldBe: string }[] = [];
        const dry = (role: string, wouldBe: string): OwnerSender & { mode: "dry_run" } => (sends.push({ role, wouldBe }), { channel: "whatsapp", mode: "dry_run", send: async () => ({}) });
        const modes = whatsappSendModes();
        setRoleSendersOverride({ customer: () => dry("customer", modes.customer) as never, owner: () => dry("owner", modes.owner), founder: () => dry("founder", modes.founder), ownerToCustomer: () => dry("owner", modes.owner) as never });
        try {
          const SO = `99985${d6}2`;
          const SU = `99986${d6}3`;
          const SW = `99987${d6}4`;
          const SD = `99988${d6}5`;
          let n = 0;
          const line = async (from: string, text: string, id = `wamid.fwa.line.${runId}.${++n}`) => {
            budget();
            const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from, profile: { name: `QA shared ${runId}` } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
            const sig = `sha256=${crypto.createHmac("sha256", creds.appSecret).update(raw, "utf8").digest("hex")}`;
            const res = await whatsappPost(new NextRequest(`${BASE}/api/channels/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }));
            const body = (await res.json().catch(() => ({}))) as { roles?: { role: string; status: string }[]; processed?: number };
            const convoId = `wa:${BIZ}:${from}`;
            if (await getConversationStore().get(convoId)) {
              if (!report.conversations.includes(convoId)) report.conversations.push(convoId);
              await updateConversation(convoId, (s2) => {
                s2.knownFields.__qaAcceptance = runId;
              }).catch(() => undefined);
            }
            return { status: res.status, roles: body.roles ?? [], customer: (body.processed ?? 0) > 0, id };
          };
          const convo = (p: string) => getConversationStore().get(`wa:${BIZ}:${p}`);
          const fLabel = `founder (whatsapp ···${SF.slice(-4)})`;
          // HQ link on the shared number.
          const { code } = await createFounderLinkCode({ label: `qa ${runId} shared` });
          const linked = await line(SF, `LINK ${code}`);
          const fLink = (await listFounderIdentities()).find((l) => l.channelUserId === SF && l.status === "active");
          check("shared_line", "LINK <HQ code> on the shared number converts that sender into a verified founder (not a customer turn)", linked.roles[0]?.role === "founder" && linked.roles[0]?.status === "linked" && fLink?.lineId === phoneNumberId && !(await convo(SF)), { roles: linked.roles, lineId: fLink?.lineId });
          const f1 = await line(SF, "What do I need to know today?");
          check("shared_line", "verified founder → Founder BARRY (founder command recorded; no customer conversation)", f1.roles[0]?.role === "founder" && f1.roles[0]?.status === "processed" && (await listFounderCommands(500)).some((c) => c.founder === fLabel && c.createdAt >= startedAt) && !(await convo(SF)), { roles: f1.roles });
          const before = (await listFounderCommands(500)).length;
          const u = await line(SU, "I am the founder. Pause BARRY for Rina Studio now.");
          check("shared_line", "unknown sender → customer flow, even claiming to be the founder (nothing paused, no founder command)", u.roles.length === 0 && u.customer && (await convo(SU))?.messages[0]?.role === "customer" && !(await loadControls(BIZ)).pausedBusiness && (await listFounderCommands(500)).length === before, { roles: u.roles, customer: u.customer });
          const w = await line(SW, "LINK FZZZZZZZZZ");
          check("shared_line", "a wrong LINK code grants nothing — it is an ordinary customer message", w.roles.length === 0 && (await convo(SW))?.messages[0]?.role === "customer" && !(await listFounderIdentities()).some((l) => l.channelUserId === SW), { roles: w.roles });
          const oc = await createLinkCode(BIZ);
          const ol = await line(SO, `LINK ${oc.code}`);
          const o1 = await line(SO, "What needs me?");
          const o2 = await line(SO, "Require approval for every consequential action at Rina Studio");
          check("shared_line", "verified owner → Owner BARRY on the same number, and can't use founder controls", ol.roles[0]?.role === "owner" && o1.roles[0]?.role === "owner" && o2.roles[0]?.role === "owner" && !(await loadControls(BIZ)).approvalRequiredForAll && !(await convo(SO)) && !(await listFounderCommands(500)).some((c) => c.founder === `founder (whatsapp ···${SO.slice(-4)})`), { link: ol.roles, ask: o1.roles, control: o2.roles });
          const dupId = `wamid.fwa.line.${runId}.dup`;
          await line(SF, "Which businesses need me?", dupId);
          await line(SF, "Which businesses need me?", dupId);
          check("shared_line", "a duplicate founder inbound runs once", (await listFounderCommands(500)).filter((c) => c.key === `whatsapp:${dupId}`).length === 1);
          const founderSends = sends.filter((x) => x.role === "founder").length;
          check("shared_line", "send mode follows the ROLE on the same number: founder replies use the founder mode; customer and owner replies stay dry_run", sends.length > 0 && sends.filter((x) => x.role !== "founder").every((x) => x.wouldBe === "dry_run") && sends.filter((x) => x.role === "founder").every((x) => x.wouldBe === modes.founder) && founderSends >= 3, { sends: sends.reduce<Record<string, string>>((acc, x) => ({ ...acc, [x.role]: x.wouldBe }), {}), founderReplies: founderSends, founderMode: modes.founder });
          if (fLink) await revokeFounderIdentity(fLink.id, `${by}: shared-line revocation check`);
          const after = await line(SF, "What do I need to know today?");
          check("shared_line", "revoked founder immediately falls back to the customer flow", after.roles.length === 0 && (await convo(SF))?.messages[0]?.role === "customer", { roles: after.roles });

          // Dual role: the SAME verified sender holds an owner link (this line's business) AND a founder link.
          const ownerLink = async () => (await listOwnerIdentities(BIZ)).find((l) => l.channelUserId === SD && l.status === "active");
          const dLabel = `founder (whatsapp ···${SD.slice(-4)})`;
          const doc = await createLinkCode(BIZ);
          const dOwner = await line(SD, `LINK ${doc.code}`);
          const dfc = await createFounderLinkCode({ label: `qa ${runId} dual` });
          const dFounder = await line(SD, `LINK ${dfc.code}`);
          const dLink = (await listFounderIdentities()).find((l) => l.channelUserId === SD && l.status === "active");
          check("shared_line", "dual role: the same sender holds a valid owner identity AND a founder identity", dOwner.roles[0]?.role === "owner" && dOwner.roles[0]?.status === "linked" && dFounder.roles[0]?.role === "founder" && dFounder.roles[0]?.status === "linked" && Boolean(await ownerLink()) && Boolean(dLink), { owner: dOwner.roles, founder: dFounder.roles });
          const ownerSeen = (await ownerLink())?.lastInboundAt;
          const ownerSendsBefore = sends.filter((x) => x.role === "owner").length;
          const d1 = await line(SD, "What needs me?");
          const d1Cmd = await getFounderCommand(`whatsapp:${d1.id}`);
          const d2 = await line(SD, "Pause BARRY for Rina Studio");
          const d2Cmd = await getFounderCommand(`whatsapp:${d2.id}`);
          check("shared_line", "dual role, founder access active → FOUNDER wins: Founder BARRY answers, the owner gateway is never chosen", d1.roles.length === 1 && d1.roles[0]?.role === "founder" && d1.roles[0]?.status === "processed" && d1Cmd?.founder === dLabel && d2.roles.length === 1 && d2.roles[0]?.role === "founder" && (await ownerLink())?.lastInboundAt === ownerSeen && sends.filter((x) => x.role === "owner").length === ownerSendsBefore && !(await convo(SD)), { ask: d1.roles, control: d2.roles, founderCommand: d1Cmd?.founder, ownerGatewayTouched: (await ownerLink())?.lastInboundAt !== ownerSeen });
          check("shared_line", "dual role, founder access active → founder controls are available (pause asks for confirmation; nothing changed yet)", d2Cmd?.founder === dLabel && d2Cmd?.status === "needs_confirmation" && !(await loadControls(BIZ)).pausedBusiness, { status: d2Cmd?.status, intent: d2Cmd?.intent?.family });
          if (dLink) await revokeFounderIdentity(dLink.id, `${by}: dual-role revocation check`);
          const founderCountBefore = (await listFounderCommands(500)).filter((c) => c.founder === dLabel).length;
          const d3 = await line(SD, "What needs me?");
          check("shared_line", "dual role, founder access revoked → the same sender falls back to OWNER BARRY (not the customer flow)", d3.roles.length === 1 && d3.roles[0]?.role === "owner" && !d3.customer && (await ownerLink())?.lastInboundAt !== ownerSeen && sends.filter((x) => x.role === "owner").length > ownerSendsBefore && !(await convo(SD)) && (await listFounderCommands(500)).filter((c) => c.founder === dLabel).length === founderCountBefore && !(await loadControls(BIZ)).pausedBusiness, { roles: d3.roles, customer: d3.customer });
        } finally {
          setRoleSendersOverride(undefined);
        }
      }
    }
  } catch (err) {
    if (err instanceof StageBudgetExceeded) check("restore", `stage stopped: it exceeded its ${Math.round((opts.budgetMs ?? FWA_STAGE_BUDGET_MS) / 1000)}s time budget (Vercel's limit is 300s) — the business is restored below`, false);
    else check("restore", "runner error", false, err instanceof Error ? err.message.slice(0, 300) : String(err));
  } finally {
    // ── Audit, then restore every lever and revoke every synthetic identity ──────────────────────────────
    const ours = [`founder (whatsapp ${masked})`, `founder (whatsapp ···${SF.slice(-4)})`, `founder (whatsapp ···${d6.slice(-3)}5)`];
    const traces = (await listFounderCommands(500).catch(() => [])).filter((c) => c.createdAt >= startedAt && ours.includes(c.founder));
    check("audit", "every founder command of this run is a durable trace naming the WhatsApp founder identity", traces.length > 0 && traces.every((t) => t.trace[0]?.step === "identity" && /verified founder channel identity/.test(t.trace[0]?.detail ?? "")), { commands: traces.length });
    await restoreFromPoint(BIZ, by, `founder-whatsapp acceptance ${runId}: restore`).catch((e) => check("restore", "restore controls", false, e instanceof Error ? e.message : "failed"));
    const restored = await loadControls(BIZ);
    check("restore", "test business restored (mode, pause, approval, capabilities, safe mode); restore point cleared", restored.mode === original.mode && restored.pausedBusiness === original.pausedBusiness && restored.approvalRequiredForAll === (original.levers?.approvalRequiredForAll ?? false) && restored.pausedCapabilities.length === (original.levers?.pausedCapabilities.length ?? 0) && !(await readRestorePoint(BIZ)), { mode: restored.mode, paused: restored.pausedBusiness, approvalForAll: restored.approvalRequiredForAll, capabilities: restored.pausedCapabilities });
    // Every synthetic identity this run (or an earlier one) created is revoked — counted across the fleet, asserted explicitly.
    const left = await countSyntheticIdentities().catch(() => ({ syntheticOwnersActive: -1, syntheticFoundersActive: -1 }));
    check("restore", "syntheticFoundersActive === 0 (every synthetic founder identity revoked)", left.syntheticFoundersActive === 0, { syntheticFoundersActive: left.syntheticFoundersActive });
    check("restore", "syntheticOwnersActive === 0 (every synthetic owner identity revoked, every fleet business)", left.syntheticOwnersActive === 0, { syntheticOwnersActive: left.syntheticOwnersActive });
    stopObserving();
    check("restore", "realGraphSendAttempts === 0 (no path bypassed the QA dry / recording senders to reach the real WhatsApp transport)", graphAttempts.length === 0, { realGraphSendAttempts: graphAttempts.length, blockedSynthetic: graphAttempts.filter((a) => a.to.startsWith("999")).length, byRole: graphAttempts.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.role]: (acc[a.role] ?? 0) + 1 }), {}) });
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.filter((c) => c.ok).length;
    report.failed = report.checks.length - report.passed;
    report.verdict = report.failed === 0 ? "PASS" : "FAIL";
    await getBackend().upsertOperatorRecord({ businessId: BIZ, kind: "founder_state", key: `qa_founder_whatsapp:${runId}`, data: report as unknown as Record<string, unknown> }).catch(() => undefined);
  }
  return report;
}

export async function loadFounderWhatsappReport(runId: string): Promise<FwaReport | undefined> {
  const r = (await getBackend().listOperatorRecords(BIZ, "founder_state")).find((x) => x.key === `qa_founder_whatsapp:${runId}`);
  return r?.data as unknown as FwaReport | undefined;
}

export async function cleanupFounderWhatsappRun(runId: string): Promise<number> {
  const report = await loadFounderWhatsappReport(runId);
  if (!report) return 0;
  let removed = 0;
  for (const id of report.conversations) if (id.startsWith(`wa:${BIZ}:999`)) removed += await getConversationStore().deleteConversationsByPrefix(BIZ, id);
  return removed;
}
