import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenAIReasoner } from "@/lib/reasoner/openai-reasoner";
import { REFERENCE_CASES, runReferenceCase, summarise, type CaseResult } from "./support/reference-corpus";

/**
 * LIVE model comparison on BARRY's own semantic corpus.
 *
 *   OPENAI_API_KEY=... npm run eval:models
 *   BARRY_EVAL_MODELS="gpt-4o-mini,gpt-5.6-terra@low,gpt-5.6-sol@low,gpt-5.6-sol@medium"
 *   BARRY_EVAL_PRICES='{"gpt-4o-mini":{"in":0.15,"out":0.6}}'   # optional, USD per 1M tokens
 *
 * Each case runs the whole pipeline: scripted setup turns create real state,
 * then the model under test understands ONE customer message; grounding,
 * compiler, policy and the provider decide what happens. The report is
 * written to eval-reports/. Nothing here is asserted against a threshold —
 * it measures; the launch model is chosen from the evidence.
 *
 * Skipped unless BARRY_LIVE_EVAL=1 and OPENAI_API_KEY are set. The key is
 * never printed or written.
 */

const LIVE = Boolean(process.env.OPENAI_API_KEY && process.env.BARRY_LIVE_EVAL === "1");
const MODELS = (process.env.BARRY_EVAL_MODELS ?? "gpt-4o-mini,gpt-5.6-terra,gpt-5.6-sol")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function parsePrices(): Record<string, { in: number; out: number }> {
  try {
    return JSON.parse(process.env.BARRY_EVAL_PRICES ?? "{}");
  } catch {
    return {};
  }
}

describe.skipIf(!LIVE)("LIVE: model comparison on the reference/decision corpus", () => {
  it(
    "runs every case against every configured model and writes a report",
    async () => {
      const cases = REFERENCE_CASES.filter((c) => c.group !== "live_regression");
      const prices = parsePrices();
      const rows: { entry: string; summary: ReturnType<typeof summarise>; failures: CaseResult[]; costUsd: number | null }[] = [];

      for (const entry of MODELS) {
        const [model, effort] = entry.split("@");
        const reasoner = new OpenAIReasoner({ model, reasoningEffort: effort });
        const results: CaseResult[] = [];
        for (const c of cases) {
          try {
            results.push(await runReferenceCase(c, reasoner));
          } catch (err) {
            results.push({
              id: c.id, group: c.group, text: c.text, pass: false, failures: [`error: ${err instanceof Error ? err.message : String(err)}`],
              referenceChecked: false, referenceCorrect: false, decisionChecked: false, decisionCorrect: false,
              falseAction: false, unsupportedReference: false, structuredValid: false,
            });
          }
        }
        const summary = summarise(results);
        const price = prices[model];
        const costUsd = price ? (summary.tokens.prompt * price.in + summary.tokens.completion * price.out) / 1_000_000 : null;
        rows.push({ entry, summary, failures: results.filter((r) => !r.pass), costUsd });
      }

      const lines = [
        `# BARRY semantic model comparison — ${new Date().toISOString()}`,
        "",
        `Corpus: ${cases.length} cases (reference resolution, ambiguity, purchase decisions, change of mind, payment claims, negotiation). Setup turns scripted; the evaluated turn uses the model.`,
        "",
        "| model | correct | references | purchaseDecision | false actions | unsupported refs | valid JSON | p50 ms | p90 ms | tokens in/out/reasoning | cost USD |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
        ...rows.map(
          (r) =>
            `| ${r.entry} | ${r.summary.semanticCorrectness} | ${r.summary.referenceResolution} | ${r.summary.purchaseDecisionCorrect} | ${r.summary.falseActionRate} | ${r.summary.unsupportedReferenceRate} | ${r.summary.structuredOutputValidity} | ${r.summary.latencyP50Ms ?? "—"} | ${r.summary.latencyP90Ms ?? "—"} | ${r.summary.tokens.prompt}/${r.summary.tokens.completion}/${r.summary.tokens.reasoning} | ${r.costUsd === null ? "—" : r.costUsd.toFixed(4)} |`
        ),
        "",
        ...rows.flatMap((r) => [
          `## ${r.entry} — failures (${r.failures.length})`,
          ...r.failures.map((f) => `- [${f.group}] "${f.text}": ${f.failures.join("; ")}`),
          "",
        ]),
      ];
      const dir = path.join(__dirname, "..", "eval-reports");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `semantic-models-${Date.now()}.md`);
      fs.writeFileSync(file, lines.join("\n"));
      console.info(lines.join("\n"));
      console.info(`[eval] report written to ${file}`);
      expect(rows.length).toBe(MODELS.length);
    },
    30 * 60_000
  );
});
