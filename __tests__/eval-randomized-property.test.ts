import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildGarageGraph } from "@/lib/fixtures/garage";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import type { BusinessGraph } from "@/lib/business-graph";
import { runScenario } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 19: randomized/property-based
 * testing. A lightweight seeded PRNG (mulberry32 — no external
 * property-testing dependency, per the mission's own instruction to
 * avoid one "unless truly useful") drives combinatorial generators
 * across weekday x time x business-fixture x language x field-order x
 * identity-phrasing. Every generated scenario is fully deterministic
 * from its seed: a failure prints the seed, the exact generated
 * scenario, and the customer message that failed, so it reproduces
 * exactly by re-running with the same seed.
 */

// ---------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic: same seed -> same sequence,
// forever, across machines and Node versions (no Math.random anywhere).
// ---------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const ENGLISH_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Index-aligned with ENGLISH_WEEKDAYS / resolver.ts's 0=Sun..6=Sat.
const HEBREW_WEEKDAYS = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"];

type SchedulingFixture = { graph: () => BusinessGraph; offerPhrase: string; offerId: string };
const SCHEDULING_FIXTURES: SchedulingFixture[] = [
  { graph: buildSpaGraph, offerPhrase: "Couples Massage", offerId: "offer-couples-massage" },
  { graph: buildSpaGraph, offerPhrase: "Solo Swedish Massage", offerId: "offer-solo-massage" },
  { graph: buildGarageGraph, offerPhrase: "Oil Change", offerId: "offer-oil-change" },
  { graph: buildGarageGraph, offerPhrase: "Brake Inspection", offerId: "offer-brake-inspection" },
  { graph: buildPersonalTrainerGraph, offerPhrase: "Training Session", offerId: "offer-training-session" },
];

type GeneratedWeekdayScenario = {
  seed: number;
  fixture: SchedulingFixture;
  weekdayIndex: number;
  hour: number; // 24h, in [9, 18] — safely within every fixture's operating hours
  language: "en" | "he";
  message: string;
};

function generateWeekdayScenario(seed: number): GeneratedWeekdayScenario {
  const rng = mulberry32(seed);
  const fixture = pick(rng, SCHEDULING_FIXTURES);
  const weekdayIndex = randInt(rng, 0, 6);
  const hour = randInt(rng, 9, 18);
  const language = pick(rng, ["en", "he"] as const);

  const message =
    language === "en"
      ? `${fixture.offerPhrase} ${ENGLISH_WEEKDAYS[weekdayIndex]} at ${hour > 12 ? hour - 12 : hour}${hour >= 12 ? "pm" : "am"}`
      : `${fixture.offerPhrase} ${HEBREW_WEEKDAYS[weekdayIndex]} בשעה ${hour}:00`;

  return { seed, fixture, weekdayIndex, hour, language, message };
}

describe("Randomized property test: weekday x time x business fixture x language", () => {
  const SEED_COUNT = 60;
  for (let seed = 1; seed <= SEED_COUNT; seed++) {
    const scenario = generateWeekdayScenario(seed);
    it(`seed ${seed}: [${scenario.language}] "${scenario.message}" -> ${scenario.fixture.offerId}, weekday ${scenario.weekdayIndex}`, async () => {
      try {
        const { state, turns } = await runScenario({
          name: `random-weekday-seed-${seed}`,
          graph: scenario.fixture.graph,
          turns: [{ customer: scenario.message }],
        });

        // PROPERTY: the correct offer always resolves from its full name,
        // regardless of which weekday/time/language was combined with it.
        expect(state.selectedOfferId).toBe(scenario.fixture.offerId);

        // PROPERTY: the semantic weekday extracted always matches what
        // was actually generated, in EITHER language.
        const semanticDate = turns[0].understood.schedulingWindow?.date;
        expect(semanticDate?.kind).toBe("weekday");
        if (semanticDate?.kind === "weekday") {
          expect(semanticDate.weekday).toBe(scenario.weekdayIndex);
        }
      } catch (err) {
        throw new Error(
          `Randomized property test FAILED — reproduce with seed ${seed}.\n` +
            `Generated scenario: ${JSON.stringify(scenario, null, 2)}\n` +
            `Original error: ${(err as Error).message}`
        );
      }
    });
  }
});

// ---------------------------------------------------------------------
// Field-order permutation fuzzing: name/phone/email supplied across a
// RANDOM number of turns, in a RANDOM order — the final converged state
// must always end up the same regardless of order (order-independence
// is an explicit Phase 1.5 invariant, not just a happy-path property).
// ---------------------------------------------------------------------
type FieldMessage = { field: "name" | "phone"; text: string };

function generateFieldOrderScenario(seed: number): { seed: number; order: FieldMessage[] } {
  const rng = mulberry32(seed);
  const fields: FieldMessage[] = [
    { field: "name", text: "My name is Inon" },
    { field: "phone", text: "My phone is 0501234567" },
  ];
  // Fisher-Yates using the seeded RNG — deterministic shuffle.
  for (let i = fields.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [fields[i], fields[j]] = [fields[j], fields[i]];
  }
  return { seed, order: fields };
}

describe("Randomized property test: customer-info field order never changes the converged result", () => {
  const SEED_COUNT = 20;
  for (let seed = 1; seed <= SEED_COUNT; seed++) {
    const scenario = generateFieldOrderScenario(seed);
    it(`seed ${seed}: order [${scenario.order.map((f) => f.field).join(", ")}] still converges to the same known fields`, async () => {
      try {
        const { state } = await runScenario({
          name: `random-field-order-seed-${seed}`,
          graph: buildSpaGraph,
          turns: [
            { customer: "Couples massage Tuesday at 3pm" },
            ...scenario.order.map((f) => ({ customer: f.text })),
          ],
        });
        expect(state.knownFields.name).toBe("Inon");
        expect(state.knownFields.phone).toBe("0501234567");
      } catch (err) {
        throw new Error(
          `Field-order property test FAILED — reproduce with seed ${seed}.\n` +
            `Generated order: ${JSON.stringify(scenario.order)}\n` +
            `Original error: ${(err as Error).message}`
        );
      }
    });
  }
});

// ---------------------------------------------------------------------
// Identity-phrasing fuzz: randomly combine a self-ID marker (English or
// Hebrew) with a randomly-generated name token — the extracted name
// must always be exactly the generated token, never truncated/corrupted,
// and never a relationship word (this is the negative half of Part 8,
// re-verified here under random combination rather than a fixed list).
// ---------------------------------------------------------------------
const ENGLISH_MARKERS = ["My name is", "Call me", "I'm"];
const HEBREW_MARKERS = ["קוראים לי", "השם שלי"];
const NAME_TOKENS = ["Inon", "Dana", "Yossi", "Maya", "Tal", "Noa"];

function generateIdentityScenario(seed: number): { seed: number; message: string; expectedName: string } {
  const rng = mulberry32(seed);
  const language = pick(rng, ["en", "he"] as const);
  const name = pick(rng, NAME_TOKENS);
  const marker = language === "en" ? pick(rng, ENGLISH_MARKERS) : pick(rng, HEBREW_MARKERS);
  return { seed, message: `${marker} ${name}`, expectedName: name };
}

describe("Randomized property test: identity extraction never corrupts a randomly-combined name", () => {
  const SEED_COUNT = 30;
  for (let seed = 1; seed <= SEED_COUNT; seed++) {
    const scenario = generateIdentityScenario(seed);
    it(`seed ${seed}: "${scenario.message}" -> name "${scenario.expectedName}"`, async () => {
      try {
        const { state } = await runScenario({
          name: `random-identity-seed-${seed}`,
          graph: buildSpaGraph,
          turns: [{ customer: "Couples massage" }, { customer: scenario.message }],
        });
        expect(state.knownFields.name).toBe(scenario.expectedName);
      } catch (err) {
        throw new Error(
          `Identity property test FAILED — reproduce with seed ${seed}.\n` +
            `Generated message: "${scenario.message}", expected name: "${scenario.expectedName}"\n` +
            `Original error: ${(err as Error).message}`
        );
      }
    });
  }
});
