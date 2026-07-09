import type { ModelRef } from "../types.js";

export const EVAL_FIXTURE_VERSION = 1;
export const EVAL_RUN_VERSION = 1;
export const EVAL_REPORT_VERSION = 1;
export const SYNTHETIC_EVAL_RUN_VERSION = 1;

export const EVAL_VARIANT_IDS = ["raw-full", "raw-truncated", "head-tail", "distill-spark"] as const;

export type EvalVariantId = (typeof EVAL_VARIANT_IDS)[number];

export type TranscriptCandidateRole = "toolResult" | "bashExecution";

export interface TranscriptCandidate {
  id: string;
  sessionPath: string;
  lineNumber: number;
  entryId: string;
  parentId: string | null;
  role: TranscriptCandidateRole;
  toolName: string;
  input: Record<string, unknown>;
  rawText: string;
  rawHash: string;
  textBytes: number;
  lineCount: number;
  productionEligible: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  toolCallId?: string;
  isError?: boolean;
  exitCode?: number;
  truncated?: boolean;
  ineligibilityReason?: string;
}

export interface TranscriptScanWarning {
  sessionPath: string;
  lineNumber?: number;
  reason: string;
}

export interface TranscriptScanResult {
  filesScanned: number;
  entriesScanned: number;
  candidates: TranscriptCandidate[];
  warnings: TranscriptScanWarning[];
}

export type EvalFactType = "line-ref" | "path" | "url" | "error" | "test" | "command" | "exit-fact" | "quote";

export interface EvalFact {
  id: string;
  type: EvalFactType;
  value: string;
  normalizedValue: string;
  confidence: number;
  rawOccurrences: number;
  laterOccurrences: number;
  source: "raw-reused-later" | "metadata-reused-later";
}

export interface EvalFixtureSource {
  sessionPath: string;
  lineNumber: number;
  entryId: string;
  parentId: string | null;
  role: TranscriptCandidateRole;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
}

export interface EvalCachedDistill {
  model: ModelRef;
  summary: string;
  createdAt: string;
}

export interface EvalFixtureManifest {
  version: typeof EVAL_FIXTURE_VERSION;
  id: string;
  candidateId: string;
  fixtureHash: string;
  createdAt: string;
  source: EvalFixtureSource;
  toolName: string;
  input: Record<string, unknown>;
  rawHash: string;
  rawBytes: number;
  rawLines: number;
  rawTextPath: string;
  productionEligible: boolean;
  scoreable: boolean;
  facts: EvalFact[];
  stale: boolean;
  cachedDistill?: EvalCachedDistill;
  ineligibilityReason?: string;
}

export type EvalVariantStatus = "ok" | "skipped" | "failed" | "fallback";

export interface EvalVariantResult {
  variant: EvalVariantId;
  status: EvalVariantStatus;
  rawHash: string;
  rawBytes: number;
  outputBytes: number;
  latencyMs: number;
  compressionRatio: number;
  outputText?: string;
  reason?: string;
  model?: ModelRef;
  summaryBytes?: number;
  validationOk?: boolean;
}

export interface EvalFixtureResult {
  fixtureId: string;
  rawHash: string;
  toolName: string;
  scoreable: boolean;
  productionEligible: boolean;
  variantResults: Partial<Record<EvalVariantId, EvalVariantResult>>;
}

export interface EvalRunResult {
  version: typeof EVAL_RUN_VERSION;
  id: string;
  createdAt: string;
  live: boolean;
  model?: ModelRef;
  variants: EvalVariantId[];
  fixtureResults: EvalFixtureResult[];
  candidateCount?: number;
}

export interface EvalVariantScore {
  variant: EvalVariantId;
  status: EvalVariantStatus;
  rawBytes: number;
  outputBytes: number;
  bytesSaved: number;
  estimatedRawTokens: number;
  estimatedOutputTokens: number;
  estimatedTokensSaved: number;
  compressionRatio: number;
  latencyMs: number;
  qualityFacts: number;
  retainedFacts: number;
  retention: number | null;
  missingFacts: EvalFact[];
  expansionNeeded: boolean;
}

export interface EvalScoredFixture {
  fixtureId: string;
  toolName: string;
  scoreable: boolean;
  productionEligible: boolean;
  variantScores: Partial<Record<EvalVariantId, EvalVariantScore>>;
}

export interface EvalVariantAggregate {
  variant: EvalVariantId;
  fixtures: number;
  evaluated: number;
  skipped: number;
  failed: number;
  fallback: number;
  productionEligibleEvaluated: number;
  totalRawBytes: number;
  totalOutputBytes: number;
  bytesSaved: number;
  estimatedTokensSaved: number;
  averageCompressionRatio: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  qualityFixtures: number;
  averageRetention: number | null;
  expansionNeededRate: number | null;
}

export interface EvalReportCounts {
  fixtures: number;
  evaluatedFixtures: number;
  pendingFixtures: number;
  staleFixtures: number;
  scoreableFixtures: number;
  productionEligibleFixtures: number;
  candidateCount?: number;
}

export interface EvalReport {
  version: typeof EVAL_REPORT_VERSION;
  id: string;
  createdAt: string;
  runId: string;
  counts: EvalReportCounts;
  aggregates: EvalVariantAggregate[];
  scoredFixtures: EvalScoredFixture[];
}

export interface EvalReplayModelRequest {
  fixture: EvalFixtureManifest;
  variant: EvalVariantResult;
  prompt: string;
}

export type EvalReplayInvoker = (request: EvalReplayModelRequest) => Promise<string>;

export interface EvalReplayResult {
  fixtureId: string;
  variant: EvalVariantId;
  status: "ok" | "skipped" | "failed";
  success: boolean;
  reason: string;
  answer?: string;
}

export interface SyntheticEvalCaseResult {
  id: string;
  title: string;
  rawBytes: number;
  outputBytes: number;
  bytesSaved: number;
  compressionRatio: number;
  latencyMs: number;
  modelCalls: number;
  modelCallsSkipped: number;
  cacheHits: number;
  reducerHits: number;
  requiredFacts: string[];
  retainedFacts: number;
  retention: number | null;
  expansionNeeded: boolean;
}

export interface SyntheticEvalRunResult {
  version: typeof SYNTHETIC_EVAL_RUN_VERSION;
  id: string;
  createdAt: string;
  cases: SyntheticEvalCaseResult[];
  totals: {
    rawBytes: number;
    outputBytes: number;
    bytesSaved: number;
    modelCalls: number;
    modelCallsSkipped: number;
    cacheHits: number;
    reducerHits: number;
    averageRetention: number | null;
    expansionNeededRate: number | null;
  };
}
