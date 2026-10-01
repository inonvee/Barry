import { beforeAll, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { fleetTenant } from "@/lib/hq/fleet";
import { listControlAudit, loadControls } from "@/lib/hq/controls";
import { activateProposal, decideProposal, listProposals } from "@/lib/hq/proposals";
import { recordCost, recordSupportTime, monthPeriod } from "@/lib/commercial/cost";
import { saveInitiative } from "@/lib/initiative/store";
import type { Initiative } from "@/lib/initiative/model";
import { interpretFounder, resolveBusinesses, intentFromModel } from "@/lib/founder/command";
import { founderBrief, founderHealth, loadFounderFleet } from "@/lib/founder/read-model";
import { executeFounderCommand, getFounderCommand, listFounderCommands, redact, founderHome, type FounderActor } from "@/lib/founder/command-service";

/**
 * FOUNDER BARRY CONTROL PLANE V1 — one founder command service over the fleet: grounded reads, the
 * Founder Brief, business drilldown, existing founder controls with confirmation + verification,
 * gated proposals, "handle what you safely can", and a durable trace.
 *
 * Seeded fleet (the fixture tenants):
 *   A  Wanderlust Bags Co. (ecommerce-bags) — healthy, one quiet conversation
 *   B  Midtown Auto Care (garage)          — payments provider in error (degraded)
 *   C  Oakhaven Furniture (furniture-store) — free month over, recurring not confirmed, no verified value
 *   D  Rina Studio (fashion-retailer)       — one active, high-importance initiative
 */

const founder: FounderActor = { kind: "founder", via: "test" };
let n = 0;
const ask = (text: string, extra: { context?: { businessId?: string }; key?: string; interpreter?: (t: string) => Promise<unknown> } = {}) => executeFounderCommand({ actor: founder, key: extra.key ?? `t-${Date.now()}-${n++}`, text, ...extra });
const confirm = (key: string) => executeFounderCommand({ actor: founder, key: `c-${n++}`, confirmKey: key });

const A = "ecommerce-bags";
const B = "garage";
const C = "furniture-store";
const D = "fashion-retailer";
const INITIATIVE_TITLE = "Customers keep asking about returns";

beforeAll(async () => {
  process.env.BARRY_FOUNDER_TOKEN = "founder-test-token-that-is-long-enough-123456";
  const now = new Date();
  // A — one ordinary conversation.
  await handleCustomerMessage(fleetTenant(A)!, `founder-a-${Date.now()}`, "cust-a", "Hi! What bags do you have?");
  // B — the payments provider is in error.
  await getBackend().upsertBusinessConnection({ businessId: B, capability: "payments", provider: "memory", status: "error", config: {}, credentialsRef: "", permissions: [] });
  // C — free month ended yesterday, recurring never confirmed.
  const ended = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const started = new Date(now.getTime() - 31 * 24 * 3600_000).toISOString();
  await getBackend().upsertOperatorRecord({ businessId: C, kind: "commercial_account", key: "current", data: { businessId: C, plan: "OPERATOR", planVersion: "2026-10-v1", features: [], monthlyPrice: 300, currency: "USD", setupPrice: 500, setupStatus: "paid", foundingCustomer: false, priceLockUntil: null, lockedMonthlyPrice: null, subscriptionState: "free_period", freePeriodStartsAt: started, freePeriodEndsAt: ended, recurringStartsAt: ended, recurringConfirmedAt: null, cancellationEffectiveAt: null, pausedAt: null, activation: { at: started, by: "founder", gate: "READY" }, notes: "", source: "test", createdAt: started, updatedAt: started, revision: 3 } });
  // D — one persisted, surfaced, high-importance initiative (evidence ids must never reach the founder).
  const initiative: Initiative = { id: "ini-founder-d", businessId: D, category: "customer_experience", detector: "repeated_questions", subject: "returns", title: INITIATIVE_TITLE, observation: "5 customers asked about returns this week.", basis: "Counted from 5 conversations", evidence: [{ kind: "conversation", id: "conv-private-evidence-1" }], metric: { count: 5 }, provenance: { scanId: "scan-1", detectedAt: now.toISOString(), window: { from: started, to: now.toISOString(), label: "7 days" }, localDate: now.toISOString().slice(0, 10), timezone: "UTC" }, confidence: "high", importance: "high", impact: { type: "customer_experience" }, recommendation: { text: "Add a returns answer." }, entitlement: "not_needed", authority: "owner_decides", canAct: false, ownerActionNeeded: true, fingerprint: "fp-d", state: "surfaced", rank: 1, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), surfacedAt: now.toISOString(), scans: 1 };
  await saveInitiative(initiative);
}, 60_000);

describe("interpretation: semantic intent, never authority", () => {
  it("maps the twelve founder commands to their intent families", () => {
    const has = { hasBusiness: true };
    expect(interpretFounder("What do I need to know today?")).toEqual({ family: "fleet_read", topic: "brief" });
    expect(interpretFounder("Which businesses need attention?")).toEqual({ family: "fleet_read", topic: "attention" });
    expect(interpretFounder("What's going on with Rina?", has)).toEqual({ family: "business_inspect", followUp: "overview" });
    expect(interpretFounder("Which customers are costing us the most to serve?")).toEqual({ family: "commercial_read", topic: "cost_to_serve" });
    expect(interpretFounder("Which businesses aren't getting enough value from BARRY?")).toEqual({ family: "value_read" });
    expect(interpretFounder("What did BARRY notice across the fleet?")).toEqual({ family: "initiative_read" });
    expect(interpretFounder("Which businesses have broken integrations?")).toEqual({ family: "incident_read", topic: "integrations" });
    expect(interpretFounder("Pause BARRY for Spa.", has)).toEqual({ family: "founder_action", action: "pause_business" });
    expect(interpretFounder("Resume Spa.", has)).toEqual({ family: "founder_action", action: "resume_business" });
    expect(interpretFounder("Prepare a rollout to Rina and Spa.", has)).toEqual({ family: "proposal", kind: "rollout" });
    expect(interpretFounder("What changed since yesterday?")).toEqual({ family: "fleet_read", topic: "changed" });
    expect(interpretFounder("Handle what you safely can and leave me what needs approval.")).toEqual({ family: "handle_safe" });
    expect(interpretFounder("What's the release state?")).toEqual({ family: "release_read" });
    expect(interpretFounder("Put Spa in safe mode", has)).toEqual({ family: "founder_action", action: "safe_mode_on" });
    expect(interpretFounder("Take Spa out of safe mode", has)).toEqual({ family: "founder_action", action: "safe_mode_off" });
  });

  it("global vs business scope: a bare follow-up uses the business; 'since yesterday' stays fleet-wide", () => {
    expect(interpretFounder("What changed?", { hasBusiness: true })).toEqual({ family: "business_inspect", followUp: "changed" });
    expect(interpretFounder("What changed since yesterday?", { hasBusiness: true })).toEqual({ family: "fleet_read", topic: "changed" });
    expect(interpretFounder("Why?", { hasBusiness: true })).toEqual({ family: "business_inspect", followUp: "why" });
    expect(interpretFounder("Why?")).toMatchObject({ family: "unsupported" });
    expect(interpretFounder("Which businesses are paused?")).toEqual({ family: "fleet_read", topic: "attention" });
  });

  it("refuses arbitrary SQL, env changes, secrets, deploys and deciding for an owner", () => {
    for (const t of ["Run SQL to delete the old conversations", "Set the env var OPENAI_API_KEY to something else", "Show me the WhatsApp token", "Deploy the new code to production now", "Approve the discount for the owner at Rina", "Bypass the approval for Spa", "Change the discount policy for Rina to 30%"]) {
      expect(interpretFounder(t, { hasBusiness: true }).family, t).toBe("unsupported");
    }
  });

  it("resolves businesses only from the directory: exact words, ambiguity never guessed, generic words ignored", () => {
    const dir = [{ id: "spa", name: "Serenity Massage Spa" }, { id: "fashion-retailer", name: "Rina Studio" }, { id: "spa-2", name: "Harbor Spa" }];
    expect(resolveBusinesses("What's going on with Rina?", dir).matched.map((b) => b.id)).toEqual(["fashion-retailer"]);
    const amb = resolveBusinesses("Pause BARRY for Spa", dir);
    expect(amb.matched).toEqual([]);
    expect(amb.ambiguous[0].candidates.map((c) => c.id).sort()).toEqual(["spa", "spa-2"]);
    expect(resolveBusinesses("Pause Serenity", dir).matched.map((b) => b.id)).toEqual(["spa"]);
    expect(resolveBusinesses("What does BARRY need from the studio business?", dir).matched).toEqual([]);
    expect(resolveBusinesses("Tell me about Nonexistent Corp", dir)).toEqual({ matched: [], ambiguous: [] });
  });

  it("a model may interpret, but its output is schema-checked and carries no authority", () => {
    expect(intentFromModel({ family: "founder_action", action: "run_sql" })).toBeUndefined();
    expect(intentFromModel({ family: "admin", action: "pause_business" })).toBeUndefined();
    expect(intentFromModel({ family: "founder_action", action: "pause_business", businesses: ["Spa"], authorized: true })).toEqual({ intent: { family: "founder_action", action: "pause_business" }, businessHints: ["Spa"] });
  });
});

describe("grounded fleet answers on the seeded fleet", () => {
  it("health is canonical and explained: A healthy, B degraded, C needs nothing operationally, D healthy-or-thin", async () => {
    const view = await loadFounderFleet();
    const h = (id: string) => view.businesses.find((b) => b.id === id)!.founderHealth;
    expect(h(A).state).toBe("healthy");
    expect(h(A).reasons.join(" ")).toMatch(/No open incidents/);
    expect(h(B).state).toBe("degraded");
    expect(h(B).reasons.join(" ")).toMatch(/payments connection/);
    for (const b of view.businesses) {
      expect(["paused", "degraded", "blocked", "needs_attention", "onboarding", "not_enough_evidence", "healthy"]).toContain(b.founderHealth.state);
      expect(JSON.stringify(b.founderHealth)).not.toMatch(/\d+\s?%/);
    }
  });

  it("the Founder Brief returns only meaningful items: B degraded, C recurring, D noticed — never A, never thin businesses", async () => {
    const r = await ask("What do I need to know today?");
    expect(r.status).toBe("answered");
    const titles = r.items.map((i) => i.title).join(" | ");
    expect(titles).toMatch(/Midtown Auto Care is degraded/);
    expect(titles).toMatch(/Oakhaven Furniture: free month is over/);
    expect(titles).toMatch(/BARRY noticed .* at Rina Studio/);
    expect(titles).not.toMatch(/Wanderlust/);
    expect(titles).not.toMatch(/Coach Riley|Serenity/);
    expect(r.items[0].severity).toBe("high");
  });

  it("the brief stays quiet when nothing important is true — nothing is manufactured", async () => {
    const view = await loadFounderFleet();
    const calm = { ...view, proposals: [], release: null, businesses: view.businesses.map((b) => ({ ...b, account: null, commercialStage: "no_plan" as const, openInitiatives: [], founderHealth: { state: "healthy" as const, words: "healthy", reasons: ["ok"] } })) };
    const brief = founderBrief(calm);
    expect(brief.quiet).toBe(true);
    expect(brief.items).toEqual([]);
    expect(brief.headline).toMatch(/^Nothing needs you/);
  });

  it("which businesses need attention: grounded list with reasons; healthy and thin named apart", async () => {
    const r = await ask("Which businesses need attention?");
    expect(r.answer).toMatch(/Midtown Auto Care: degraded/);
    expect(r.answer).toMatch(/Healthy: .*Wanderlust Bags Co\./);
    expect(r.answer).not.toMatch(/Wanderlust Bags Co\.: /);
  });

  it("drilldown: What's going on with Rina? — status, waiting, incidents, initiative, plan, value, runtime; follow-ups use the context", async () => {
    const r = await ask("What's going on with Rina?");
    expect(r.intent).toBe("business_inspect");
    expect(r.scope).toEqual({ kind: "business", businessIds: [D] });
    expect(r.answer).toMatch(/^Rina Studio /);
    expect(r.answer).toMatch(new RegExp(`BARRY noticed: ${INITIATIVE_TITLE}`));
    expect(r.answer).toMatch(/Verified value: made none verified/);
    expect(r.answer).toMatch(/Runtime /);
    expect(r.followUps).toEqual(["Why?", "Show incident", "What changed?", "What can I do?"]);
    // Tenant safety: nothing from another business.
    for (const other of ["Midtown", "Oakhaven", "Wanderlust", "Serenity", "conv-private-evidence-1"]) expect(r.answer).not.toContain(other);
    const why = await ask("Why?", { context: { businessId: D } });
    expect(why.intent).toBe("business_inspect");
    expect(why.answer).toMatch(/^Rina Studio .* because:/);
    const options = await ask("What can I do?", { context: { businessId: B } });
    expect(options.answer).toMatch(/Pause BARRY for Midtown Auto Care/);
    const inc = await ask("Show incident", { context: { businessId: B } });
    expect(inc.answer).toMatch(/payments connection/);
  });

  it("cost to serve distinguishes measured / estimated / unavailable, and says so when there are no records", async () => {
    const none = await ask("Which customers are costing us the most to serve?");
    expect(none.answer).toMatch(/No cost-to-serve records exist|Unavailable/);
    const p = monthPeriod(new Date());
    await recordCost(C, { category: "hosting_compute", provider: "vercel", amount: 42, currency: "USD", basis: "measured", source: "invoice 2026-10", periodStart: p.start, periodEnd: new Date(Date.parse(p.end) - 1).toISOString() }, "founder");
    await recordSupportTime(A, { minutes: 30, note: "onboarding call" }, "founder");
    const r = await ask("Which customers are costing us the most to serve?");
    const lines = r.answer.split("\n");
    const oak = lines.findIndex((l) => l.includes("Oakhaven Furniture"));
    const wan = lines.findIndex((l) => l.includes("Wanderlust Bags Co."));
    expect(oak).toBeGreaterThan(0);
    expect(wan).toBeGreaterThan(oak);
    expect(lines[oak]).toMatch(/42 USD \(measured, lower bound/);
    expect(lines[wan]).toMatch(/\(estimated, lower bound/);
    expect(r.answer).toMatch(/Unavailable \(no cost records\): .*Rina Studio/);
  });

  it("value keeps verified semantics: no verified value is said plainly, simulated money never counts", async () => {
    const r = await ask("Which businesses aren't getting enough value from BARRY?");
    expect(r.answer).toMatch(/provider-verified MADE, realized SAVED/);
    expect(r.answer).toMatch(/Oakhaven Furniture: nothing verified yet/);
    expect(r.answer).not.toMatch(/made \d/);
  });

  it("broken integrations and initiatives come only from records (no evidence ids, scoped by business)", async () => {
    const i = await ask("Which businesses have broken integrations?");
    expect(i.answer).toMatch(/Midtown Auto Care/);
    expect(i.answer).not.toMatch(/Wanderlust|Rina/);
    const fleetWide = await ask("What did BARRY notice across the fleet?");
    expect(fleetWide.answer).toContain(INITIATIVE_TITLE);
    expect(fleetWide.answer).not.toContain("conv-private-evidence-1");
    expect(fleetWide.answer).not.toContain("5 customers asked");
    const scoped = await ask("What did BARRY notice at Midtown?");
    expect(scoped.scope).toEqual({ kind: "business", businessIds: [B] });
    expect(scoped.answer).not.toContain(INITIATIVE_TITLE);
    expect(scoped.answer).toMatch(/hasn't noticed anything open at Midtown Auto Care/);
  });

  it("release / runtime answers are grounded in the manifest and say when there is no commit", async () => {
    const r = await ask("What's the release state?");
    expect(r.answer).toMatch(/^Release candidate: /);
    expect(r.answer).toMatch(/local build \(no commit\)/);
    expect(r.answer).toMatch(/Last Work verdict: none recorded/);
  });
});

describe("founder actions: existing control, confirmation, verification, idempotency", () => {
  it("Pause Business B: confirm → real control, verified, audited; repeat executes nothing; resume restores", async () => {
    const auditBefore = (await listControlAudit(B)).length;
    const key = `pause-b-${Date.now()}`;
    const r = await ask("Pause BARRY for Midtown Auto Care.", { key });
    expect(r.status).toBe("needs_confirmation");
    expect(r.confirmation?.title).toBe("Pause BARRY for Midtown Auto Care");
    expect((await loadControls(B)).pausedBusiness).toBe(false);
    // Repeating the same command key is a duplicate, never a second plan.
    expect((await ask("Pause BARRY for Midtown Auto Care.", { key })).duplicate).toBe(true);
    const done = await confirm(key);
    expect(done.status).toBe("executed");
    expect(done.verification).toMatch(/pausedBusiness = true in the durable controls/);
    const c = await loadControls(B);
    expect(c.pausedBusiness).toBe(true);
    expect(c.updatedBy).toBe("founder (Founder BARRY)");
    const audit = await listControlAudit(B);
    expect(audit.length).toBe(auditBefore + 1);
    expect(audit[0].reason).toMatch(/Founder BARRY: "Pause BARRY for Midtown Auto Care\."/);
    // A second confirmation executes nothing.
    const again = await confirm(key);
    expect(again.duplicate).toBe(true);
    expect((await listControlAudit(B)).length).toBe(auditBefore + 1);
    // Other businesses untouched.
    expect((await loadControls(A)).pausedBusiness).toBe(false);
    // Already paused → no change, nothing to confirm.
    expect((await ask("Pause Midtown")).status).toBe("no_change");
    const resumeKey = `resume-b-${Date.now()}`;
    expect((await ask("Resume Midtown.", { key: resumeKey })).status).toBe("needs_confirmation");
    expect((await confirm(resumeKey)).status).toBe("executed");
    expect((await loadControls(B)).pausedBusiness).toBe(false);
  });

  it("ambiguous or missing business → clarification and no execution", async () => {
    const before = await listControlAudit(D);
    const none = await ask("Pause BARRY.");
    expect(none.status).toBe("clarify");
    expect(none.confirmation).toBeUndefined();
    const two = await ask("Pause Rina and Midtown.");
    expect(two.status).toBe("clarify");
    expect(two.answer).toMatch(/one business at a time/);
    const unknown = await ask("Pause Nonexistent Corp.");
    expect(unknown.status).toBe("clarify");
    expect(await listControlAudit(D)).toHaveLength(before.length);
    expect((await confirm(none.key)).status).toBe("clarify");
    expect((await confirm("no-such-command")).status).toBe("refused");
    expect(await listControlAudit(D)).toHaveLength(before.length);
  });

  it("the model cannot create founder authority or a business", async () => {
    const forged = await ask("do the thing for them", { interpreter: async () => ({ family: "founder_action", action: "pause_business", businesses: ["Rina"], authorized: true, confirmed: true }) });
    expect(forged.status).toBe("needs_confirmation");
    expect((await loadControls(D)).pausedBusiness).toBe(false);
    const invented = await ask("do the other thing", { interpreter: async () => ({ family: "founder_action", action: "pause_business", businesses: ["Globex Industries"] }) });
    expect(invented.status).toBe("clarify");
    const outside = await ask("do something special", { interpreter: async () => ({ family: "founder_action", action: "drop_database" }) });
    expect(outside.status).toBe("refused");
    await expect(executeFounderCommand({ actor: { kind: "owner" } as unknown as FounderActor, key: "x-owner", text: "Pause Rina" })).rejects.toThrow(/founder/);
  });
});

describe("proposals and handle-what-you-can", () => {
  it("Prepare rollout for A and D: a durable, idempotent proposal that executes nothing — even approved", async () => {
    const auditA = (await listControlAudit(A)).length;
    const auditD = (await listControlAudit(D)).length;
    const r = await ask("Prepare a rollout to Wanderlust and Rina.");
    expect(r.status).toBe("proposed");
    expect(r.proposalIds).toHaveLength(1);
    const again = await ask("Prepare a rollout to Rina and Wanderlust");
    expect(again.proposalIds).toEqual(r.proposalIds);
    const p = (await listProposals()).find((x) => x.id === r.proposalIds[0])!;
    expect(p.kind).toBe("rollout");
    expect(p.affectedBusinesses.sort()).toEqual([A, D].sort());
    expect(p.change).toEqual({});
    expect(p.activation).toBe("gated");
    expect(p.plan?.currentState.join(" ")).toMatch(/Wanderlust Bags Co\.: simulator; runtime/);
    expect(p.plan?.requiredApproval).toMatch(/Founder approval/);
    await decideProposal({ id: p.id, decision: "approved", by: "founder" });
    const act = await activateProposal({ id: p.id, by: "founder" });
    expect(act.applied).toEqual([]);
    expect(act.refused).toMatch(/gated/);
    expect((await listControlAudit(A)).length).toBe(auditA);
    expect((await listControlAudit(D)).length).toBe(auditD);
  });

  it("handle what you safely can: bookkeeping only, safe-mode proposal for B, recurring left for the founder, idempotent", async () => {
    const before = await loadControls(B);
    const r = await ask("Handle what you safely can and leave me what needs approval.");
    expect(r.status).toBe("handled");
    expect(r.answer).toMatch(/Prepared for your approval: Safe mode for Midtown Auto Care/);
    expect(r.answer).toMatch(/Left for you: .*Oakhaven Furniture: confirm the recurring start/);
    expect(r.answer).toMatch(/I changed no business's behaviour/);
    const after = await loadControls(B);
    expect(after.safeMode).toBe(before.safeMode);
    expect(after.pausedBusiness).toBe(before.pausedBusiness);
    const proposalId = r.proposalIds[0];
    const second = await ask("Take care of what you can");
    expect(second.proposalIds).toEqual([proposalId]);
    expect((await listProposals()).filter((p) => p.dedupeKey === `founder:safe_mode:${B}`)).toHaveLength(1);
  });
});

describe("audit trace, secrets, home", () => {
  it("every command leaves a durable trace: founder, intent, scope, grounding, authority, result, verification", async () => {
    const key = `trace-${Date.now()}`;
    await ask("What's going on with Midtown?", { key });
    const rec = await getFounderCommand(key);
    expect(rec?.founder).toBe("founder (test)");
    expect(rec?.intent.family).toBe("business_inspect");
    expect(rec?.scope).toEqual({ kind: "business", businessIds: [B] });
    expect(rec?.grounded.length).toBeGreaterThan(0);
    expect(rec?.trace.map((t) => t.step)).toEqual(expect.arrayContaining(["identity", "interpretation", "scope", "grounding", "reply"]));
    expect((await listFounderCommands()).some((c) => c.key === key)).toBe(true);
  });

  it("secrets never land in a response or a trace", async () => {
    expect(redact("use sk-live_abcdef1234567890 and call +972 52-123-4567")).not.toMatch(/abcdef1234567890|123-4567/);
    const key = `secret-${Date.now()}`;
    const r = await ask("What's going on with Rina? token sk-live_abcdef1234567890", { key });
    const rec = await getFounderCommand(key);
    expect(JSON.stringify(rec)).not.toContain("abcdef1234567890");
    expect(JSON.stringify(r)).not.toContain("abcdef1234567890");
    for (const out of [await ask("What do I need to know today?"), await ask("What's the release state?"), await ask("What's going on with Rina?")]) {
      expect(JSON.stringify(out)).not.toContain(process.env.BARRY_FOUNDER_TOKEN!);
    }
  });

  it("home: what needs you / what Founder BARRY handled / what changed", async () => {
    const home = await founderHome();
    expect(home.brief.items.length).toBeGreaterThan(0);
    expect(home.handled.some((h) => /Pause BARRY for Midtown Auto Care — verified/.test(h.what))).toBe(true);
    expect(home.health.find((h) => h.id === B)?.state).toBe("degraded");
    expect(founderHealth).toBeTypeOf("function");
  });
});

describe("the Founder BARRY API is founder-only", () => {
  it("401 without a founder session or token; 200 with the founder bearer token", async () => {
    const { POST, GET } = await import("@/app/api/hq/founder/command/route");
    const body = JSON.stringify({ text: "What do I need to know today?", key: `api-${Date.now()}` });
    expect((await POST(new Request("http://x/api/hq/founder/command", { method: "POST", headers: { "content-type": "application/json" }, body }))).status).toBe(401);
    expect((await POST(new Request("http://x/api/hq/founder/command", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner-token-that-is-not-the-founder" }, body }))).status).toBe(401);
    const ok = await POST(new Request("http://x/api/hq/founder/command", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.BARRY_FOUNDER_TOKEN}` }, body }));
    expect(ok.status).toBe(200);
    const d = (await ok.json()) as { intent: string; status: string };
    expect(d.intent).toBe("fleet_read");
    expect((await GET(new Request("http://x/api/hq/founder/command"))).status).toBe(401);
  });
});
