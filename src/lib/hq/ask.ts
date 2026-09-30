import OpenAI from "openai";
import { createCompletion, modelFor, samplingParams } from "@/lib/reasoner/model-config";
import { classifyProviderError } from "@/lib/reasoner/openai-reasoner";
import type { ModelCallFailure } from "@/lib/reasoner/types";
import { checkAnswerAgainstBriefing } from "@/lib/owner/ask";
import { getFleet, type Fleet } from "./fleet";
import { currentRelease, type ReleaseState } from "@/lib/release/manifest";

/**
 * ASK HQ BARRY — the founder's read-only operator over the FLEET read models (fleet status, incidents,
 * controls, obligations, the release candidate). Every figure comes from the briefing; the answer links
 * to the business / incident / conversation / capability / release it talks about. Never an action.
 */

const money = (m: Record<string, number>) => Object.entries(m).filter(([, v]) => v > 0).map(([c, v]) => `${v} ${c}`).join(" + ") || "none";

export function hqBriefing(fleet: Fleet, release: ReleaseState) {
  return {
    at: fleet.at,
    build: fleet.build,
    release: { state: release.state, sha: release.sha, preview: release.preview, liveProofRequired: release.manifest.liveProofRequired.map((c) => c.title), knownBlockers: release.manifest.knownBlockers, lastVerdict: release.verdict ? `${release.verdict.verdict} on ${release.verdict.sha.slice(0, 7)} at ${release.verdict.at}${release.verdict.note ? ` — ${release.verdict.note}` : ""}` : "none recorded" },
    fleet: {
      businesses: fleet.summary.businesses,
      healthy: fleet.summary.healthy,
      needFounder: fleet.summary.needFounder,
      broke: fleet.summary.broke.map((b) => ({ business: b.name, businessId: b.id, incident: b.incident.title, severity: b.incident.severity, kind: b.incident.kind, since: b.incident.firstSeen, status: b.incident.status, nextAction: b.incident.nextAction, ...(b.incident.links.conversationId ? { conversationId: b.incident.links.conversationId } : {}), ...(b.incident.capability ? { capability: b.incident.capability } : {}) })),
      changed: fleet.summary.changed.slice(0, 12),
      moneyBlocked: fleet.summary.moneyBlocked.map((m) => ({ business: m.name, businessId: m.id, stuckWithOwner: money(m.stuckWithOwner), atRisk: money(m.atRisk) })),
      notReady: fleet.summary.notReady,
    },
    businesses: fleet.businesses.map((b) => ({
      id: b.id,
      name: b.name,
      health: b.health,
      stage: b.stage,
      mode: b.controls.mode,
      controls: { writesPaused: b.controls.pauseConsequentialWrites, humanOnly: b.controls.approvalRequiredForAll, pausedCapabilities: b.controls.pausedCapabilities, disabledChannels: b.controls.disabledChannels },
      model: `${b.model.mode.replace("_", " ")} · ${b.model.status}`,
      storage: b.storage,
      whatsapp: b.channel.whatsapp,
      providers: b.providers,
      readiness: b.readiness.label,
      readinessBlockers: b.readiness.blockers.slice(0, 4),
      interventions: b.interventions,
      approvalsActive: b.approvalsActive,
      approvalsHeld: b.approvalsHeld,
      handoffsOpen: b.handoffsOpen,
      incidents: { high: b.incidents.high, medium: b.incidents.medium, low: b.incidents.low },
      obligations: b.obligations,
      money: { stuckWithOwner: money(b.money.stuckWithOwner), waitingOnCustomer: money(b.money.waitingOnCustomer), atRisk: money(b.money.atRisk), simulatedTestMoney: money(b.money.simulated) },
      conversations: b.conversations,
      unavailable: b.unavailable,
    })),
    capabilityFailures: capabilityFailureRanking(fleet),
  };
}

export type HqBriefing = ReturnType<typeof hqBriefing>;

/** Which capability is failing most across the fleet, from open incidents (never a guess). */
function capabilityFailureRanking(fleet: Fleet): { capability: string; incidents: number; businesses: string[] }[] {
  const map = new Map<string, { incidents: number; businesses: Set<string> }>();
  for (const b of fleet.businesses) {
    for (const i of b.incidents.open) {
      if (!i.capability) continue;
      const e = map.get(i.capability) ?? { incidents: 0, businesses: new Set<string>() };
      e.incidents += i.occurrences;
      e.businesses.add(b.name);
      map.set(i.capability, e);
    }
  }
  return [...map.entries()].map(([capability, e]) => ({ capability, incidents: e.incidents, businesses: [...e.businesses] })).sort((a, b) => b.incidents - a.incidents);
}

export function hqBriefingText(b: HqBriefing): string {
  const lines = [
    `Fleet at ${b.at}: ${b.fleet.healthy} of ${b.fleet.businesses} businesses healthy. Build ${b.build.commit ? b.build.commit.slice(0, 7) : "local"} (${b.build.environment}) · release ${b.release.state}.`,
    b.fleet.needFounder.length ? `Need you: ${b.fleet.needFounder.map((x) => `${x.name} — ${x.why}`).join("; ")}.` : "Nobody needs you right now.",
    b.fleet.broke.length ? `Broke: ${b.fleet.broke.slice(0, 6).map((x) => `${x.business}: ${x.incident} (${x.severity}, ${x.status}) → ${x.nextAction}`).join("; ")}.` : "No open incidents above low severity.",
    b.fleet.changed.length ? `Changed: ${b.fleet.changed.slice(0, 6).map((x) => `${x.name}: ${x.what}`).join("; ")}.` : "Nothing changed in the last 24 hours.",
    b.fleet.moneyBlocked.length ? `Money blocked: ${b.fleet.moneyBlocked.map((x) => `${x.business}: ${x.stuckWithOwner} with the owner, ${x.atRisk} at risk`).join("; ")}.` : "No money is blocked on an owner or at risk.",
    b.fleet.notReady.length ? `Not ready: ${b.fleet.notReady.map((x) => `${x.name} (${x.level.replace(/_/g, " ").toLowerCase()}${x.blocker ? `: ${x.blocker}` : ""})`).join("; ")}.` : "Every business is at least ready for a supervised pilot.",
    `Simulator-only: ${b.businesses.filter((x) => x.stage === "simulator_only").map((x) => x.name).join(", ") || "none"}. Supervised: ${b.businesses.filter((x) => x.stage === "supervised").map((x) => x.name).join(", ") || "none"}. Live-ready: ${b.businesses.filter((x) => x.stage === "live_ready").map((x) => x.name).join(", ") || "none"}.`,
    b.capabilityFailures.length ? `Failing most: ${b.capabilityFailures.slice(0, 3).map((c) => `${c.capability} (${c.incidents} in ${c.businesses.join(", ")})`).join("; ")}.` : "",
    b.release.liveProofRequired.length ? `Live proof still required: ${b.release.liveProofRequired.slice(0, 8).join("; ")}.` : "",
    b.release.knownBlockers.length ? `Known blockers: ${b.release.knownBlockers.join("; ")}.` : "",
    `Last Work verdict: ${b.release.lastVerdict}.`,
  ];
  return lines.filter(Boolean).join("\n");
}

const HQ_PROMPT = `You are BARRY HQ's founder assistant: you help the founder operate the BARRY fleet across businesses. You are READ-ONLY.
Answer the founder's question using ONLY the JSON briefing. Rules:
- Every number, name, status and incident you state must appear in the briefing. If it isn't there, say you don't have it.
- Prioritise exceptions: who needs the founder, what broke (with severity and next action), what changed, where money is blocked, which businesses are not ready.
- "release" describes the current candidate build: its state, what still needs live proof and the last Work verdict. Never say something is live-proven unless the briefing says so.
- Name the business, incident, capability or conversation you refer to so the founder can open it.
- You cannot act: you never pause, resume, approve, resolve or deploy anything. If asked to, say where the founder does it (the business page in HQ) and that you can't.
- Be brief and concrete. Plain text, no JSON, no headers.`;

export type HqAnswer = { answer: string; source: "model" | "briefing"; reason?: string; failure?: ModelCallFailure; briefing: HqBriefing; links: HqAnswerLinks };
export type HqAnswerLinks = { businesses: { id: string; name: string; href: string }[]; incidents: { businessId: string; key: string; title: string; href: string }[]; conversations: { businessId: string; conversationId: string; href: string }[]; release: { href: string } };

function linksOf(fleet: Fleet): HqAnswerLinks {
  return {
    businesses: fleet.businesses.map((b) => ({ id: b.id, name: b.name, href: `/hq/${encodeURIComponent(b.id)}` })),
    incidents: fleet.businesses.flatMap((b) => b.incidents.open.slice(0, 5).map((i) => ({ businessId: b.id, key: i.key, title: i.title, href: `/hq/${encodeURIComponent(b.id)}#incidents` }))),
    conversations: fleet.businesses.flatMap((b) => b.incidents.open.flatMap((i) => (i.links.conversationId ? [{ businessId: b.id, conversationId: i.links.conversationId, href: `/hq/${encodeURIComponent(b.id)}/conversations/${encodeURIComponent(i.links.conversationId)}` }] : []))).slice(0, 12),
    release: { href: "/hq#release" },
  };
}

export async function askHq(question: string, opts: { client?: Pick<OpenAI, "chat">; now?: Date; fleet?: Fleet } = {}): Promise<HqAnswer> {
  const fleet = opts.fleet ?? (await getFleet({ now: opts.now }));
  const release = await currentRelease();
  const briefing = hqBriefing(fleet, release);
  const links = linksOf(fleet);
  const client = opts.client ?? (process.env.BARRY_REASONER === "openai" && process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 }) : undefined);
  if (!client) return { answer: hqBriefingText(briefing), source: "briefing", reason: "no AI model configured — showing the fleet summary", briefing, links };
  const model = modelFor("composer");
  try {
    const completion = await createCompletion(client as OpenAI, {
      model,
      messages: [
        { role: "system", content: HQ_PROMPT },
        { role: "user", content: JSON.stringify({ briefing, question: question.slice(0, 1000) }) },
      ],
      ...samplingParams(model, "composer", 0.2),
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return { answer: hqBriefingText(briefing), source: "briefing", reason: "the AI returned nothing — showing the fleet summary", briefing, links };
    const problem = checkAnswerAgainstBriefing(text, briefing, question);
    if (problem) return { answer: hqBriefingText(briefing), source: "briefing", reason: `the AI's answer couldn't be verified (${problem}) — showing the fleet summary`, briefing, links };
    return { answer: text, source: "model", briefing, links };
  } catch (err) {
    return { answer: hqBriefingText(briefing), source: "briefing", reason: "AI unavailable — showing the fleet summary", failure: classifyProviderError(err), briefing, links };
  }
}
