import { factAppearsInText } from "./facts.js";
import { EVAL_VARIANT_IDS, type EvalFixtureManifest, type EvalReportCounts, type EvalRunResult, type EvalScoredFixture, type EvalVariantAggregate, type EvalVariantId, type EvalVariantResult, type EvalVariantScore } from "./types.js";

export function scoreRun(fixtures: EvalFixtureManifest[], run: EvalRunResult): EvalScoredFixture[] {
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const scored: EvalScoredFixture[] = [];
  for (const fixtureResult of run.fixtureResults) {
    const fixture = fixturesById.get(fixtureResult.fixtureId);
    if (!fixture || fixture.rawHash !== fixtureResult.rawHash) {
      continue;
    }
    const variantScores: Partial<Record<EvalVariantId, EvalVariantScore>> = {};
    for (const variant of EVAL_VARIANT_IDS) {
      const result = fixtureResult.variantResults[variant];
      if (result) {
        variantScores[variant] = scoreVariantResult(fixture, result);
      }
    }
    scored.push({
      fixtureId: fixture.id,
      toolName: fixture.toolName,
      scoreable: fixture.scoreable,
      productionEligible: fixture.productionEligible,
      variantScores,
    });
  }
  return scored.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
}

export function scoreVariantResult(fixture: EvalFixtureManifest, result: EvalVariantResult): EvalVariantScore {
  const outputText = result.outputText ?? "";
  const canScoreQuality = fixture.scoreable && (result.status === "ok" || result.status === "fallback");
  const missingFacts = canScoreQuality ? fixture.facts.filter((fact) => !factAppearsInText(fact, outputText)) : [];
  const retainedFacts = canScoreQuality ? fixture.facts.length - missingFacts.length : 0;
  const retention = canScoreQuality && fixture.facts.length > 0 ? retainedFacts / fixture.facts.length : null;
  const estimatedRawTokens = estimateTokensFromBytes(result.rawBytes);
  const estimatedOutputTokens = estimateTokensFromBytes(result.outputBytes);
  return {
    variant: result.variant,
    status: result.status,
    rawBytes: result.rawBytes,
    outputBytes: result.outputBytes,
    bytesSaved: Math.max(0, result.rawBytes - result.outputBytes),
    estimatedRawTokens,
    estimatedOutputTokens,
    estimatedTokensSaved: Math.max(0, estimatedRawTokens - estimatedOutputTokens),
    compressionRatio: result.compressionRatio,
    latencyMs: result.latencyMs,
    qualityFacts: canScoreQuality ? fixture.facts.length : 0,
    retainedFacts,
    retention,
    missingFacts,
    expansionNeeded: canScoreQuality && missingFacts.length > 0,
  };
}

export function aggregateVariantScores(scoredFixtures: EvalScoredFixture[], variants: EvalVariantId[] = [...EVAL_VARIANT_IDS]): EvalVariantAggregate[] {
  return variants.map((variant) => aggregateVariant(scoredFixtures, variant));
}

export function reportCounts(fixtures: EvalFixtureManifest[], run: EvalRunResult): EvalReportCounts {
  const evaluatedIds = new Set(run.fixtureResults.map((result) => result.fixtureId));
  const counts: EvalReportCounts = {
    fixtures: fixtures.length,
    evaluatedFixtures: fixtures.filter((fixture) => evaluatedIds.has(fixture.id)).length,
    pendingFixtures: fixtures.filter((fixture) => !evaluatedIds.has(fixture.id)).length,
    staleFixtures: fixtures.filter((fixture) => fixture.stale).length,
    scoreableFixtures: fixtures.filter((fixture) => fixture.scoreable).length,
    productionEligibleFixtures: fixtures.filter((fixture) => fixture.productionEligible).length,
  };
  if (run.candidateCount !== undefined) counts.candidateCount = run.candidateCount;
  return counts;
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function aggregateVariant(scoredFixtures: EvalScoredFixture[], variant: EvalVariantId): EvalVariantAggregate {
  const scores = scoredFixtures.map((fixture) => ({ fixture, score: fixture.variantScores[variant] })).filter(hasScore);
  const evaluated = scores.filter(({ score }) => score.status === "ok" || score.status === "fallback");
  const quality = evaluated.filter(({ score }) => score.retention !== null);
  const latencies = evaluated.map(({ score }) => score.latencyMs).sort((left, right) => left - right);
  const compressionRatios = evaluated.map(({ score }) => score.compressionRatio);
  const averageRetention = average(quality.map(({ score }) => score.retention).filter(isNumber));
  const aggregate: EvalVariantAggregate = {
    variant,
    fixtures: scores.length,
    evaluated: evaluated.length,
    skipped: scores.filter(({ score }) => score.status === "skipped").length,
    failed: scores.filter(({ score }) => score.status === "failed").length,
    fallback: scores.filter(({ score }) => score.status === "fallback").length,
    productionEligibleEvaluated: evaluated.filter(({ fixture }) => fixture.productionEligible).length,
    totalRawBytes: sum(evaluated.map(({ score }) => score.rawBytes)),
    totalOutputBytes: sum(evaluated.map(({ score }) => score.outputBytes)),
    bytesSaved: sum(evaluated.map(({ score }) => score.bytesSaved)),
    estimatedTokensSaved: sum(evaluated.map(({ score }) => score.estimatedTokensSaved)),
    averageCompressionRatio: average(compressionRatios),
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    qualityFixtures: quality.length,
    averageRetention,
    expansionNeededRate: quality.length === 0 ? null : quality.filter(({ score }) => score.expansionNeeded).length / quality.length,
  };
  return aggregate;
}

function hasScore(value: { fixture: EvalScoredFixture; score: EvalVariantScore | undefined }): value is { fixture: EvalScoredFixture; score: EvalVariantScore } {
  return value.score !== undefined;
}

function isNumber(value: number | null): value is number {
  return typeof value === "number";
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return sum(values) / values.length;
}

function percentile(sortedValues: number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1));
  return sortedValues[index] ?? null;
}
