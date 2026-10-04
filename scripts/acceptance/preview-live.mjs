#!/usr/bin/env node
// DEPLOYED-PREVIEW ACCEPTANCE — drives the REAL deployed app (Vercel Preview → Preview Supabase) through its
// public HTTP surface: signed WhatsApp webhooks, owner routes, founder controls, the background cron. Uses ONE
// synthetic customer number on ONE test business. Never runs against Production (refuses unless the deployment
// reports a non-production environment AND the expected Preview database project).
//
//   BARRY_PREVIEW_URL          https://<preview-deployment>.vercel.app
//   BARRY_EXPECT_DB            glqrfoljvdbyrmbvupym   (the Preview Supabase project the deployment must use)
//   BARRY_BUSINESS_ID          the test business routed in BARRY_WHATSAPP_ROUTES (e.g. fashion-retailer)
//   WHATSAPP_PHONE_NUMBER_ID   the Preview's routed test phone_number_id (BARRY_WHATSAPP_ROUTES key)
//   WHATSAPP_APP_SECRET        same value as the Preview env (signs the synthetic webhooks)
//   BARRY_OWNER_TOKEN          owner token for the business (global or per-business)
//   BARRY_FOUNDER_TOKEN        founder token (mode changes + cron "at")
//   CRON_SECRET                same value as the Preview env
//   BARRY_TEST_CUSTOMER        optional. Defaults to a synthetic number. If the Preview sends LIVE, this MUST be
//                              your own WhatsApp test recipient (never a real customer).
//   VERCEL_BYPASS              optional: Vercel deployment-protection bypass secret
//
// Output: a PASS/FAIL line per check and evidence JSON (scripts/acceptance/preview-evidence-<ts>.json). The
// conversation id is printed so the stored rows can be verified directly in the Preview database.
import crypto from "node:crypto";
import fs from "node:fs";

const env = (k, d) => process.env[k] ?? d;
const BASE = env("BARRY_PREVIEW_URL", "").replace(/\/$/, "");
const EXPECT_DB = env("BARRY_EXPECT_DB", "glqrfoljvdbyrmbvupym");
const BIZ = env("BARRY_BUSINESS_ID");
const PNID = env("WHATSAPP_PHONE_NUMBER_ID");
const APP_SECRET = env("WHATSAPP_APP_SECRET");
const OWNER = env("BARRY_OWNER_TOKEN");
const FOUNDER = env("BARRY_FOUNDER_TOKEN");
const CRON = env("CRON_SECRET");
const CUSTOMER = env("BARRY_TEST_CUSTOMER", `97250000${String(Date.now()).slice(-4)}`);
const BYPASS = env("VERCEL_BYPASS");
const missing = Object.entries({ BARRY_PREVIEW_URL: BASE, BARRY_BUSINESS_ID: BIZ, WHATSAPP_PHONE_NUMBER_ID: PNID, WHATSAPP_APP_SECRET: APP_SECRET, BARRY_OWNER_TOKEN: OWNER, BARRY_FOUNDER_TOKEN: FOUNDER, CRON_SECRET: CRON }).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}`);
  process.exit(2);
}

const CONV = `wa:${BIZ}:${CUSTOMER}`;
const RUN = `acc${Date.now().toString(36)}`;
const results = [];
const evidence = { base: BASE, business: BIZ, conversationId: CONV, run: RUN, steps: {} };
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, { body, headers = {}, raw } = {}) {
  const h = { ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}), ...headers };
  if (body !== undefined && !raw) h["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const owner = (method, path, body) => http(method, path, { body, headers: { "x-barry-owner-token": OWNER } });
const founder = (method, path, body) => http(method, path, { body, headers: { authorization: `Bearer ${FOUNDER}` } });

let seq = 0;
function webhook(text, id = `wamid.${RUN}.${++seq}`) {
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PNID }, contacts: [{ wa_id: CUSTOMER, profile: { name: "Acceptance Test" } }], messages: [{ id, from: CUSTOMER, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] };
  const raw = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex")}`;
  return { id, send: () => http("POST", "/api/channels/whatsapp", { raw, headers: { "content-type": "application/json", "x-hub-signature-256": sig } }) };
}
/** Meta re-delivers on non-2xx: emulate it (bounded), as the provider would. */
async function deliver(w, tries = 4) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await w.send();
    if (r.status === 200) return r;
    await sleep(1500 * (i + 1));
  }
  return r;
}
const convo = async () => (await owner("GET", `/api/owner/conversation?businessId=${encodeURIComponent(BIZ)}&conversationId=${encodeURIComponent(CONV)}`)).json;
const count = (c, from) => (c?.messages ?? []).filter((m) => m.from === from).length;
const deliveriesFor = (c, id) => (c?.deliveries ?? []).filter((d) => d.inboundId === id);

async function main() {
  // 0. Isolation preflight — refuse anything that isn't the Preview on the Preview database.
  const st = await http("GET", "/api/qa/status");
  evidence.steps.status = st.json;
  const isolated = st.status === 200 && st.json?.environment !== "production" && st.json?.databaseProject === EXPECT_DB;
  check("preview isolation: deployment reports non-production env and the Preview database", isolated, { environment: st.json?.environment, databaseProject: st.json?.databaseProject, storage: st.json?.storage });
  if (!isolated) return;
  const live = st.json?.whatsapp?.state === "live sending";
  evidence.sendMode = live ? "live" : "dry_run";
  check("cron secret configured on the deployment", st.json?.cron === "secret configured", st.json?.cron);

  // 1. Inbound text → BARRY reply, truthful state, persistence.
  const m1 = webhook("Hi! Do you have the midnight dress?");
  const r1 = await deliver(m1);
  let c = await convo();
  evidence.steps.first = { webhook: r1.status, messages: c?.messages?.length };
  check("whatsapp inbound accepted", r1.status === 200, r1.json);
  check("BARRY replied and the conversation persisted", count(c, "customer") === 1 && count(c, "barry") === 1);
  const d1 = deliveriesFor(c, m1.id);
  check("truthful delivery state (one record, matches the send mode)", d1.length === 1 && d1[0].status === (live ? "sent" : "dry_run"), d1);
  if (!live) check("dry-run reply is marked not sent in the transcript", (c.messages.find((m) => m.from === "barry") ?? {}).notSent === "dry_run");

  // 2. Duplicate delivery of the same message id (concurrent + later): nothing runs or sends twice.
  await Promise.all([m1.send(), m1.send()]);
  await m1.send();
  c = await convo();
  check("duplicate message id: no second turn, no second send", count(c, "customer") === 1 && count(c, "barry") === 1 && deliveriesFor(c, m1.id).length === 1);

  // 3. Three rapid messages.
  const burst = ["Is it available in M?", "And in L?", "What's the price?"].map((t) => webhook(t));
  const first = await Promise.all(burst.map((w) => w.send()));
  evidence.steps.burstFirstStatuses = first.map((r) => r.status);
  for (const [i, w] of burst.entries()) if (first[i].status !== 200) await deliver(w);
  c = await convo();
  const custTexts = c.messages.filter((m) => m.from === "customer").map((m) => m.text);
  check("rapid messages: all stored, in order", JSON.stringify(custTexts.slice(-3)) === JSON.stringify(["Is it available in M?", "And in L?", "What's the price?"]), custTexts);
  check("rapid messages: exactly one delivery per inbound (no duplicate sends)", burst.every((w) => deliveriesFor(c, w.id).length === 1), burst.map((w) => deliveriesFor(c, w.id).length));

  // 4. Handoff: take over, customer writes, owner replies (retried), give back.
  const take = await owner("POST", "/api/owner/handoffs", { businessId: BIZ, conversationId: CONV, action: "take_over" });
  check("owner takes over", take.status === 200 && take.json?.control?.holder === "human", take.json);
  const barryBefore = count(await convo(), "barry");
  const held = webhook("Hello? Anyone there?");
  await deliver(held);
  c = await convo();
  check("customer message stored while handed off; BARRY silent", c.messages.at(-1)?.from === "customer" && count(c, "barry") === barryBefore);
  const requestId = `${RUN}-reply-1`;
  const [rep1, rep2] = await Promise.all([1, 2].map(() => owner("POST", "/api/owner/handoffs", { businessId: BIZ, conversationId: CONV, action: "reply", requestId, text: "Hi, this is the team — I'm checking for you now." })));
  c = await convo();
  check("owner reply sent through BARRY's channel, stored as the owner's", count(c, "owner") === 1 && [rep1.status, rep2.status].includes(200), { statuses: [rep1.status, rep2.status], reply: rep1.json?.reply?.status });
  check("owner reply retried with the same request id: one message, one delivery", deliveriesFor(c, `owner:${requestId}`).length === 1);
  const back = await owner("POST", "/api/owner/handoffs", { businessId: BIZ, conversationId: CONV, action: "resume" });
  check("control returned to BARRY", back.status === 200 && back.json?.control?.holder === "barry");
  const after = webhook("Thanks! One more question — do you ship to Haifa?");
  await deliver(after);
  c = await convo();
  check("BARRY answers again after return", c.messages.at(-1)?.from === "barry");
  check("control log reconstructs who held it", (c.controlLog ?? []).map((e) => `${e.from}->${e.to}`).join(",") === "barry->human,human->barry", c.controlLog);

  // 5. SUPERVISED + approval: checkout needs the owner; the owner approves through the real route.
  const sup = await founder("POST", "/api/hq/controls", { businessId: BIZ, reason: `acceptance ${RUN}: supervised`, confirm: "yes", mode: "supervised" });
  check("founder sets SUPERVISED (audited)", sup.status === 200 && sup.json?.controls?.mode === "supervised", sup.json?.audit?.id);
  for (const t of (env("BARRY_APPROVAL_SCRIPT") ? JSON.parse(env("BARRY_APPROVAL_SCRIPT")) : ["I'll take the midnight dress in M please", "Yes, checkout please. My name is Dana, phone 0501234567"])) await deliver(webhook(t));
  const ws = (await owner("GET", `/api/owner/workspace?businessId=${encodeURIComponent(BIZ)}`)).json;
  const pending = (ws?.approvals ?? []).filter((a) => a.conversationId === CONV && a.lifecycle === "active");
  evidence.steps.approvals = pending.map((a) => ({ id: a.id, action: a.requestedAction ?? a.summary }));
  if (!pending.length) check("approval created for the money step (live model may phrase the flow differently — inspect the conversation)", false, "no active approval for this conversation");
  else {
    const dec = await owner("POST", "/api/owner/approvals", { businessId: BIZ, approvalId: pending[0].id, action: "approve" });
    const again = await owner("POST", "/api/owner/approvals", { businessId: BIZ, approvalId: pending[0].id, action: "approve" });
    check("approval enforced, then approved once by the owner", dec.status === 200 && again.status !== 500, { first: dec.status, second: again.status, result: dec.json?.result });
  }

  // 6. Pause / resume.
  const pause = await owner("POST", "/api/owner/mode", { businessId: BIZ, action: "pause" });
  check("owner pauses BARRY", pause.status === 200 && pause.json?.mode === "paused" && pause.json?.pausedBy === "owner", pause.json);
  const bp = count(await convo(), "barry");
  await deliver(webhook("Are you open today?"));
  c = await convo();
  check("paused: message kept, no reply", c.messages.at(-1)?.from === "customer" && count(c, "barry") === bp);
  const resume = await owner("POST", "/api/owner/mode", { businessId: BIZ, action: "resume" });
  check("owner resumes BARRY", resume.status === 200 && resume.json?.mode === "supervised", resume.json);

  // 7. Background operation.
  const noAuth = await http("GET", "/api/cron/background");
  const badAuth = await http("GET", "/api/cron/background", { headers: { authorization: "Bearer not-the-secret-not-the-secret" } });
  check("cron refuses no / wrong secret", noAuth.status === 401 && badAuth.status === 401, [noAuth.status, badAuth.status]);
  const tick1 = await http("GET", "/api/cron/background", { headers: { authorization: `Bearer ${CRON}` } });
  check("cron runs with the secret (failures, if any, are reported as non-2xx with the outcomes)", [200, 500].includes(tick1.status) && Array.isArray(tick1.json?.tick?.outcomes), { status: tick1.status, ran: tick1.json?.tick?.ran, failed: tick1.json?.tick?.failed });
  // A business-local noon slot, evaluated twice: one run, then "already ran".
  const at = new Date(Date.now() + 2 * 24 * 3600_000);
  at.setUTCHours(9, 15, 0, 0); // 12:15 in UTC+3 (Asia/Jerusalem); other zones: set BARRY_SLOT_AT
  const slotAt = env("BARRY_SLOT_AT", at.toISOString());
  const a = await http("POST", `/api/cron/background?businessId=${encodeURIComponent(BIZ)}&at=${encodeURIComponent(slotAt)}`, { headers: { authorization: `Bearer ${FOUNDER}` } });
  const b = await http("POST", `/api/cron/background?businessId=${encodeURIComponent(BIZ)}&at=${encodeURIComponent(slotAt)}`, { headers: { authorization: `Bearer ${FOUNDER}` } });
  const fu = (r) => (r.json?.tick?.outcomes ?? []).find((o) => o.job === "followups");
  evidence.steps.cron = { tick1: tick1.json?.tick, slotA: fu(a), slotB: fu(b) };
  check("one run per slot (second evaluation of the same slot does nothing)", fu(a)?.decision === "ran" && fu(b)?.decision === "skipped" && /already ran/.test(fu(b)?.reason ?? ""), { a: fu(a), b: fu(b) });
  check("SUPERVISED respected by scheduled follow-ups (nothing sent on its own)", (fu(a)?.summary?.sent ?? 0) === 0, fu(a));

  // 8. Restore: back to SIMULATOR (the test business's default).
  const restore = await founder("POST", "/api/hq/controls", { businessId: BIZ, reason: `acceptance ${RUN}: restore`, confirm: "yes", mode: "simulator" });
  check("restored the test business to SIMULATOR", restore.status === 200);
}

main()
  .catch((err) => check("runner error", false, err instanceof Error ? err.message : String(err)))
  .finally(() => {
    const file = `scripts/acceptance/preview-evidence-${RUN}.json`;
    fs.writeFileSync(file, JSON.stringify({ ...evidence, results }, null, 2));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed. Evidence: ${file}\nVerify the stored rows in the Preview database for conversation ${CONV}.`);
    process.exit(failed ? 1 : 0);
  });
