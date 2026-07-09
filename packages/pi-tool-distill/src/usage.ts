import type { ExpandMode } from "./types.js";

export const USAGE_DELTA_SCHEMA = "tool-distill.usage-delta.v1";
export const TRACKING_SCHEMA = "tool-distill.tracking.v1";
export const ACTIVATION_SCHEMA = "tool-distill.activation.v1";
export const STATS_RESPONSE_SCHEMA = "tool-distill.stats.v1";

export type UsageSource = "live" | "backfill";
export type ToolResultUsageClass = "semantic" | "semantic-cache" | "reducer" | "fallback" | "validation-rejected" | "raw-write-failed";
export type UsageClass = ToolResultUsageClass | "expand";
export type ActivationEventType = "started" | "stopped" | "inferred-started";
export type BoundedFailureReason =
  | "raw-write-failed"
  | "model-error"
  | "summary-rejected"
  | "metadata-update-failed"
  | "unknown-artifact"
  | "store-error"
  | "historical";

export interface DistillerUsageFields {
  distillerInputTokensExact?: number;
  distillerOutputTokensExact?: number;
  distillerTokensEstimated?: number;
  distillerCostUsdExact?: number;
}

export interface ToolResultUsageDeltaV1 extends DistillerUsageFields {
  schema: typeof USAGE_DELTA_SCHEMA;
  source: UsageSource;
  usageClass: ToolResultUsageClass;
  at: number;
  sessionKey: string;
  cwdHash: string;
  artifactId?: string;
  toolNameHash?: string;
  rawBytes: number;
  visibleBytes: number;
  mainBytesDelta: number;
  estimatedMainTokensDelta: number;
  semanticModelCalls: 0 | 1;
  semanticCacheHits: 0 | 1;
  reducerHits: 0 | 1;
  fallbackCount: 0 | 1;
  validationRejectedCount: 0 | 1;
  failureReason?: BoundedFailureReason;
}

export interface ExpansionUsageDeltaV1 {
  schema: typeof USAGE_DELTA_SCHEMA;
  source: "live";
  usageClass: "expand";
  at: number;
  sessionKey: string;
  cwdHash: string;
  artifactId: string;
  expandMode: ExpandMode;
  maxChars: number;
}

export type UsageDelta = ToolResultUsageDeltaV1 | ExpansionUsageDeltaV1;

export interface TrackingInfoV1 {
  schema: typeof TRACKING_SCHEMA;
  trackingStartedAt: number;
}

export interface ActivationUsageEventV1 {
  schema: typeof ACTIVATION_SCHEMA;
  event: ActivationEventType;
  at: number;
  mode: "auto" | "force" | "off";
  activationId: string;
  partial?: boolean;
}

export interface UsageTotals {
  records: number;
  rawBytes: number;
  visibleBytes: number;
  mainBytesDelta: number;
  estimatedMainTokensDelta: number;
  semanticModelCalls: number;
  semanticCacheHits: number;
  reducerHits: number;
  fallbackCount: number;
  validationRejectedCount: number;
  expansionCount: number;
  distillerInputTokensExact: number;
  distillerOutputTokensExact: number;
  distillerTokensEstimated: number;
  distillerCostUsdExact: number;
}

export interface UnknownBackfillCounters {
  expansions: boolean;
  distillerSpend: boolean;
  skipped: boolean;
}

export interface UsageStatsReportV1 {
  schema: typeof STATS_RESPONSE_SCHEMA;
  generatedAt: number;
  scope: "project" | "global";
  cwdHash?: string;
  period: { kind: "all" | "since" | "activation"; since?: number; until?: number; partial?: boolean };
  tracked: UsageTotals;
  backfill?: UsageTotals & { unknown: UnknownBackfillCounters };
  combined?: UsageTotals & { label: "tracked-plus-historical-estimate" };
  warnings: string[];
}

interface BaseToolUsageInput extends DistillerUsageFields {
  source?: UsageSource;
  at: number;
  sessionKey: string;
  cwdHash: string;
  artifactId?: string;
  toolNameHash?: string;
  rawBytes: number;
  visibleBytes: number;
  failureReason?: BoundedFailureReason;
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.round(bytes / 4);
}

export function makeSemanticUsageDelta(input: BaseToolUsageInput): ToolResultUsageDeltaV1 {
  return makeToolResultDelta(input, "semantic", {
    semanticModelCalls: 1,
    semanticCacheHits: 0,
    reducerHits: 0,
    fallbackCount: 0,
    validationRejectedCount: 0,
  });
}

export function makeSemanticCacheUsageDelta(input: BaseToolUsageInput): ToolResultUsageDeltaV1 {
  return makeToolResultDelta(input, "semantic-cache", {
    semanticModelCalls: 0,
    semanticCacheHits: 1,
    reducerHits: 0,
    fallbackCount: 0,
    validationRejectedCount: 0,
  });
}

export function makeReducerUsageDelta(input: BaseToolUsageInput): ToolResultUsageDeltaV1 {
  return makeToolResultDelta(input, "reducer", {
    semanticModelCalls: 0,
    semanticCacheHits: 0,
    reducerHits: 1,
    fallbackCount: 0,
    validationRejectedCount: 0,
  });
}

export function makeFallbackUsageDelta(input: BaseToolUsageInput & { semanticModelCalls?: 0 | 1 }): ToolResultUsageDeltaV1 {
  return makeToolResultDelta(input, "fallback", {
    semanticModelCalls: input.semanticModelCalls ?? 0,
    semanticCacheHits: 0,
    reducerHits: 0,
    fallbackCount: 1,
    validationRejectedCount: 0,
  });
}

export function makeValidationRejectedUsageDelta(input: BaseToolUsageInput): ToolResultUsageDeltaV1 {
  return makeToolResultDelta(input, "validation-rejected", {
    semanticModelCalls: 1,
    semanticCacheHits: 0,
    reducerHits: 0,
    fallbackCount: 1,
    validationRejectedCount: 1,
    failureReason: input.failureReason ?? "summary-rejected",
  });
}

export function makeRawWriteFailedUsageDelta(input: Omit<BaseToolUsageInput, "artifactId">): ToolResultUsageDeltaV1 {
  return makeToolResultDelta({ ...input, failureReason: input.failureReason ?? "raw-write-failed" }, "raw-write-failed", {
    semanticModelCalls: 0,
    semanticCacheHits: 0,
    reducerHits: 0,
    fallbackCount: 1,
    validationRejectedCount: 0,
  });
}

export function makeExpansionUsageDelta(input: {
  at: number;
  sessionKey: string;
  cwdHash: string;
  artifactId: string;
  expandMode: ExpandMode;
  maxChars: number;
}): ExpansionUsageDeltaV1 {
  return {
    schema: USAGE_DELTA_SCHEMA,
    source: "live",
    usageClass: "expand",
    at: input.at,
    sessionKey: input.sessionKey,
    cwdHash: input.cwdHash,
    artifactId: input.artifactId,
    expandMode: input.expandMode,
    maxChars: input.maxChars,
  };
}

export function emptyUsageTotals(): UsageTotals {
  return {
    records: 0,
    rawBytes: 0,
    visibleBytes: 0,
    mainBytesDelta: 0,
    estimatedMainTokensDelta: 0,
    semanticModelCalls: 0,
    semanticCacheHits: 0,
    reducerHits: 0,
    fallbackCount: 0,
    validationRejectedCount: 0,
    expansionCount: 0,
    distillerInputTokensExact: 0,
    distillerOutputTokensExact: 0,
    distillerTokensEstimated: 0,
    distillerCostUsdExact: 0,
  };
}

export function addUsageDeltaToTotals(totals: UsageTotals, delta: UsageDelta): UsageTotals {
  const next = { ...totals, records: totals.records + 1 };
  if (delta.usageClass === "expand") {
    next.expansionCount += 1;
    return next;
  }
  next.rawBytes += delta.rawBytes;
  next.visibleBytes += delta.visibleBytes;
  next.mainBytesDelta += delta.mainBytesDelta;
  next.estimatedMainTokensDelta += delta.estimatedMainTokensDelta;
  next.semanticModelCalls += delta.semanticModelCalls;
  next.semanticCacheHits += delta.semanticCacheHits;
  next.reducerHits += delta.reducerHits;
  next.fallbackCount += delta.fallbackCount;
  next.validationRejectedCount += delta.validationRejectedCount;
  next.distillerInputTokensExact += delta.distillerInputTokensExact ?? 0;
  next.distillerOutputTokensExact += delta.distillerOutputTokensExact ?? 0;
  next.distillerTokensEstimated += delta.distillerTokensEstimated ?? 0;
  next.distillerCostUsdExact += delta.distillerCostUsdExact ?? 0;
  return next;
}

function makeToolResultDelta(
  input: BaseToolUsageInput,
  usageClass: ToolResultUsageClass,
  counters: Pick<
    ToolResultUsageDeltaV1,
    "semanticModelCalls" | "semanticCacheHits" | "reducerHits" | "fallbackCount" | "validationRejectedCount"
  > & { failureReason?: BoundedFailureReason },
): ToolResultUsageDeltaV1 {
  const mainBytesDelta = input.rawBytes - input.visibleBytes;
  const delta: ToolResultUsageDeltaV1 = {
    schema: USAGE_DELTA_SCHEMA,
    source: input.source ?? "live",
    usageClass,
    at: input.at,
    sessionKey: input.sessionKey,
    cwdHash: input.cwdHash,
    rawBytes: input.rawBytes,
    visibleBytes: input.visibleBytes,
    mainBytesDelta,
    estimatedMainTokensDelta: estimateTokensFromBytes(mainBytesDelta),
    semanticModelCalls: counters.semanticModelCalls,
    semanticCacheHits: counters.semanticCacheHits,
    reducerHits: counters.reducerHits,
    fallbackCount: counters.fallbackCount,
    validationRejectedCount: counters.validationRejectedCount,
  };
  if (input.artifactId) delta.artifactId = input.artifactId;
  if (input.toolNameHash) delta.toolNameHash = input.toolNameHash;
  if (input.distillerInputTokensExact !== undefined) delta.distillerInputTokensExact = input.distillerInputTokensExact;
  if (input.distillerOutputTokensExact !== undefined) delta.distillerOutputTokensExact = input.distillerOutputTokensExact;
  if (input.distillerTokensEstimated !== undefined) delta.distillerTokensEstimated = input.distillerTokensEstimated;
  if (input.distillerCostUsdExact !== undefined) delta.distillerCostUsdExact = input.distillerCostUsdExact;
  const failureReason = counters.failureReason ?? input.failureReason;
  if (failureReason) delta.failureReason = failureReason;
  return delta;
}
