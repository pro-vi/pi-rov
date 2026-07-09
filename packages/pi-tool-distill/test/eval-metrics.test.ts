import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureManifest } from "../src/eval/fixtures.js";
import { aggregateVariantScores, scoreRun, scoreVariantResult } from "../src/eval/metrics.js";
import { createEvalReport, renderEvalReportMarkdown } from "../src/eval/report.js";
import { EVAL_RUN_VERSION, type EvalFact, type EvalFixtureManifest, type EvalRunResult, type EvalVariantResult, type TranscriptCandidate } from "../src/eval/types.js";

void test("scoreVariantResult reports full required-fact retention", () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42"), fact("error", "TimeoutError")]);
  const result = variantResult("raw-full", "src/foo.test.ts:42 failed with TimeoutError");

  const score = scoreVariantResult(fixture, result);

  assert.equal(score.retention, 1);
  assert.equal(score.retainedFacts, 2);
  assert.equal(score.missingFacts.length, 0);
});

void test("scoreVariantResult excludes no-fact fixtures from quality aggregate but keeps size metrics", () => {
  const fixture = fixtureWithFacts([]);
  const result = variantResult("raw-truncated", "small output");

  const score = scoreVariantResult(fixture, result);

  assert.equal(score.retention, null);
  assert.equal(score.qualityFacts, 0);
  assert.ok(score.bytesSaved > 0);
});

void test("partial fact retention identifies missing facts and appears in report markdown", () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42"), fact("error", "TimeoutError")]);
  const run: EvalRunResult = {
    version: EVAL_RUN_VERSION,
    id: "run-1",
    createdAt: "2026-05-25T00:00:00.000Z",
    live: false,
    variants: ["head-tail"],
    fixtureResults: [
      {
        fixtureId: fixture.id,
        rawHash: fixture.rawHash,
        toolName: fixture.toolName,
        scoreable: fixture.scoreable,
        productionEligible: fixture.productionEligible,
        variantResults: { "head-tail": variantResult("head-tail", "src/foo.test.ts:42 failed") },
      },
    ],
  };

  const report = createEvalReport([fixture], run, { id: "report-1", now: () => new Date("2026-05-25T00:00:01.000Z") });
  const markdown = renderEvalReportMarkdown(report);

  assert.equal(report.aggregates[0]?.averageRetention, 0.5);
  assert.equal(report.aggregates[0]?.expansionNeededRate, 1);
  assert.match(markdown, /TimeoutError/);
  assert.match(markdown, /0\.500/);
});

void test("scoreRun ignores run results whose raw hash no longer matches the fixture", () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42")]);
  const run: EvalRunResult = {
    version: EVAL_RUN_VERSION,
    id: "run-1",
    createdAt: "2026-05-25T00:00:00.000Z",
    live: false,
    variants: ["raw-full"],
    fixtureResults: [
      {
        fixtureId: fixture.id,
        rawHash: "different-hash",
        toolName: fixture.toolName,
        scoreable: fixture.scoreable,
        productionEligible: fixture.productionEligible,
        variantResults: { "raw-full": variantResult("raw-full", "src/foo.test.ts:42") },
      },
    ],
  };

  assert.equal(scoreRun([fixture], run).length, 0);
});

void test("failed variants do not poison aggregates", () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42")]);
  const run: EvalRunResult = {
    version: EVAL_RUN_VERSION,
    id: "run-1",
    createdAt: "2026-05-25T00:00:00.000Z",
    live: false,
    variants: ["distill-spark"],
    fixtureResults: [
      {
        fixtureId: fixture.id,
        rawHash: fixture.rawHash,
        toolName: fixture.toolName,
        scoreable: fixture.scoreable,
        productionEligible: fixture.productionEligible,
        variantResults: {
          "distill-spark": {
            variant: "distill-spark",
            status: "failed",
            rawHash: fixture.rawHash,
            rawBytes: 1_000,
            outputBytes: 0,
            latencyMs: 12,
            compressionRatio: 0,
            reason: "model unavailable",
          },
        },
      },
    ],
  };

  const scored = scoreRun([fixture], run);
  const aggregate = aggregateVariantScores(scored, ["distill-spark"])[0];

  assert.equal(aggregate?.failed, 1);
  assert.equal(aggregate?.evaluated, 0);
  assert.equal(aggregate?.averageRetention, null);
});

function fixtureWithFacts(facts: EvalFact[]): EvalFixtureManifest {
  const rawText = `${"x".repeat(1_000)}\nsrc/foo.test.ts:42 TimeoutError`;
  const candidate: TranscriptCandidate = {
    id: "abcdef0123456789abcd",
    sessionPath: "/tmp/session.jsonl",
    lineNumber: 1,
    entryId: "entry-1",
    parentId: null,
    role: "bashExecution",
    toolName: "bash",
    input: { command: "npm test" },
    rawText,
    rawHash: "hash",
    textBytes: Buffer.byteLength(rawText, "utf-8"),
    lineCount: rawText.split("\n").length,
    productionEligible: true,
  };
  return createFixtureManifest(candidate, facts, "/tmp/raw.txt", () => new Date("2026-05-25T00:00:00.000Z"));
}

function fact(type: EvalFact["type"], value: string): EvalFact {
  return {
    id: `${type}-${value}`,
    type,
    value,
    normalizedValue: value.toLowerCase(),
    confidence: 0.9,
    rawOccurrences: 1,
    laterOccurrences: 1,
    source: "raw-reused-later",
  };
}

function variantResult(variant: EvalVariantResult["variant"], outputText: string): EvalVariantResult {
  return {
    variant,
    status: "ok",
    rawHash: "hash",
    rawBytes: 1_000,
    outputBytes: Buffer.byteLength(outputText, "utf-8"),
    latencyMs: 1,
    compressionRatio: Buffer.byteLength(outputText, "utf-8") / 1_000,
    outputText,
  };
}
