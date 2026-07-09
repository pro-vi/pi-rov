import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aggregateVariantScores, reportCounts, scoreRun } from "./metrics.js";
import { EVAL_REPORT_VERSION, type EvalFixtureManifest, type EvalReport, type EvalRunResult, type SyntheticEvalRunResult } from "./types.js";

export interface EvalReportOptions {
  id?: string;
  now?: () => Date;
}

export interface EvalReportWriteResult {
  jsonPath: string;
  markdownPath: string;
}

export function createEvalReport(fixtures: EvalFixtureManifest[], run: EvalRunResult, options: EvalReportOptions = {}): EvalReport {
  const scoredFixtures = scoreRun(fixtures, run);
  return {
    version: EVAL_REPORT_VERSION,
    id: options.id ?? run.id,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    runId: run.id,
    counts: reportCounts(fixtures, run),
    aggregates: aggregateVariantScores(scoredFixtures, run.variants),
    scoredFixtures,
  };
}

export async function writeSyntheticEvalReport(rootDir: string, run: SyntheticEvalRunResult): Promise<EvalReportWriteResult> {
  const reportDir = join(rootDir, "synthetic");
  const jsonPath = join(reportDir, `${run.id}.json`);
  const markdownPath = join(reportDir, `${run.id}.md`);
  await writeText(jsonPath, `${JSON.stringify(run, null, 2)}\n`);
  await writeText(markdownPath, renderSyntheticEvalMarkdown(run));
  return { jsonPath, markdownPath };
}

export function renderSyntheticEvalMarkdown(run: SyntheticEvalRunResult): string {
  const lines = [
    `# Tool Distill Synthetic Eval ${run.id}`,
    "",
    `Created: ${run.createdAt}`,
    "",
    "## Totals",
    "",
    `- Raw bytes: ${run.totals.rawBytes}`,
    `- Output bytes: ${run.totals.outputBytes}`,
    `- Bytes saved: ${run.totals.bytesSaved}`,
    `- Model calls: ${run.totals.modelCalls}`,
    `- Model calls skipped: ${run.totals.modelCallsSkipped}`,
    `- Cache hits: ${run.totals.cacheHits}`,
    `- Reducer hits: ${run.totals.reducerHits}`,
    `- Average retention: ${formatNullableRatio(run.totals.averageRetention)}`,
    `- Expansion needed rate: ${formatNullableRatio(run.totals.expansionNeededRate)}`,
    "",
    "## Synthetic case results",
    "",
    "| Case | Compression ratio | Bytes saved | Model calls | Model calls skipped | Cache hits | Reducer hits | Retention | Expansion needed |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const result of run.cases) {
    lines.push(
      [
        `| ${result.id}`,
        result.compressionRatio.toFixed(3),
        result.bytesSaved,
        result.modelCalls,
        result.modelCallsSkipped,
        result.cacheHits,
        result.reducerHits,
        formatNullableRatio(result.retention),
        result.expansionNeeded ? "yes" : "no",
      ].join(" | ") + " |",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeEvalReport(rootDir: string, report: EvalReport): Promise<EvalReportWriteResult> {
  const reportDir = join(rootDir, "reports");
  const jsonPath = join(reportDir, `${report.id}.json`);
  const markdownPath = join(reportDir, `${report.id}.md`);
  await writeText(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeText(markdownPath, renderEvalReportMarkdown(report));
  return { jsonPath, markdownPath };
}

export function renderEvalReportMarkdown(report: EvalReport): string {
  const lines = [
    `# Tool Distill Eval Report ${report.id}`,
    "",
    `Run: ${report.runId}`,
    `Created: ${report.createdAt}`,
    "",
    "## Counts",
    "",
    `- Fixtures: ${report.counts.fixtures}`,
    `- Evaluated fixtures: ${report.counts.evaluatedFixtures}`,
    `- Pending fixtures: ${report.counts.pendingFixtures}`,
    `- Stale fixtures: ${report.counts.staleFixtures}`,
    `- Scoreable fixtures: ${report.counts.scoreableFixtures}`,
    `- Production-eligible fixtures: ${report.counts.productionEligibleFixtures}`,
  ];
  if (report.counts.candidateCount !== undefined) {
    lines.push(`- Candidate count: ${report.counts.candidateCount}`);
  }
  lines.push(
    "",
    "## Variant aggregates",
    "",
    "| Variant | Evaluated | Skipped | Fallback | Bytes saved | Est. tokens saved | Avg compression | Median latency | P95 latency | Quality fixtures | Avg retention | Expansion-needed rate |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const aggregate of report.aggregates) {
    lines.push(
      [
        `| ${aggregate.variant}`,
        aggregate.evaluated,
        aggregate.skipped,
        aggregate.fallback,
        aggregate.bytesSaved,
        aggregate.estimatedTokensSaved,
        formatNullableRatio(aggregate.averageCompressionRatio),
        formatNullableNumber(aggregate.medianLatencyMs),
        formatNullableNumber(aggregate.p95LatencyMs),
        aggregate.qualityFixtures,
        formatNullableRatio(aggregate.averageRetention),
        formatNullableRatio(aggregate.expansionNeededRate),
      ].join(" | ") + " |",
    );
  }

  lines.push("", "## Missing facts by fixture", "");
  let missingRows = 0;
  for (const fixture of report.scoredFixtures) {
    for (const [variant, score] of Object.entries(fixture.variantScores)) {
      if (!score || score.missingFacts.length === 0) {
        continue;
      }
      missingRows += 1;
      lines.push(`- ${fixture.fixtureId} / ${variant}: ${score.missingFacts.map((fact) => `\`${fact.value}\``).join(", ")}`);
    }
  }
  if (missingRows === 0) {
    lines.push("No missing required facts in evaluated scoreable outputs.");
  }

  return `${lines.join("\n")}\n`;
}

export function createRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value));
}

function formatNullableRatio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}
