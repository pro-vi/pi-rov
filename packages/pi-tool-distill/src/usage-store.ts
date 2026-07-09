import { randomUUID } from "node:crypto";
import { appendFile, link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUsageRoot, isSafeCwdHash } from "./paths.js";
import type { DistillMode } from "./types.js";
import {
  ACTIVATION_SCHEMA,
  STATS_RESPONSE_SCHEMA,
  TRACKING_SCHEMA,
  USAGE_DELTA_SCHEMA,
  addUsageDeltaToTotals,
  emptyUsageTotals,
  type ActivationEventType,
  type ActivationUsageEventV1,
  type BoundedFailureReason,
  type TrackingInfoV1,
  type UsageDelta,
  type UsageStatsReportV1,
  type UsageTotals,
} from "./usage.js";

export interface UsageStoreOptions {
  usageRoot?: string;
  agentDir?: string;
  now?: () => number;
}

export interface UsageQuery {
  scope: "project" | "global";
  cwdHash?: string;
  since?: number;
  until?: number;
  periodKind?: "all" | "since" | "activation";
  periodPartial?: boolean;
  includeBackfill?: boolean;
}

export interface UsageReadResult {
  deltas: UsageDelta[];
  warnings: string[];
}

export interface UsageStore {
  usageRoot: string;
  append(delta: unknown): Promise<void>;
  readDeltas(includeBackfill?: boolean): Promise<UsageReadResult>;
  summarize(query: UsageQuery): Promise<UsageStatsReportV1>;
  ensureTracking(): Promise<TrackingInfoV1>;
  readActivations(): Promise<ActivationUsageEventV1[]>;
  appendActivation(event: ActivationUsageEventV1): Promise<void>;
}

export interface UsageRecorder {
  record(delta: UsageDelta): void;
  flush(): Promise<void>;
  failureCount(): number;
}

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
  const usageRoot = options.usageRoot ?? getUsageRoot(options.agentDir);
  const now = options.now ?? Date.now;
  return {
    usageRoot,
    async append(delta: unknown): Promise<void> {
      const safe = validateUsageDelta(delta);
      await ensureTrackingInfo(usageRoot, now);
      const file = usageFileForDelta(usageRoot, safe);
      await appendJsonLine(file, safe);
    },
    async readDeltas(includeBackfill = true): Promise<UsageReadResult> {
      return readUsageDeltas(usageRoot, includeBackfill);
    },
    async summarize(query: UsageQuery): Promise<UsageStatsReportV1> {
      const read = await readUsageDeltas(usageRoot, true);
      return summarizeUsageDeltas(read.deltas, query, read.warnings, now());
    },
    async ensureTracking(): Promise<TrackingInfoV1> {
      return ensureTrackingInfo(usageRoot, now);
    },
    async readActivations(): Promise<ActivationUsageEventV1[]> {
      return readActivationEvents(usageRoot);
    },
    async appendActivation(event: ActivationUsageEventV1): Promise<void> {
      const safe = validateActivationEvent(event);
      await ensureTrackingInfo(usageRoot, now);
      await appendJsonLine(join(usageRoot, "activations.jsonl"), safe);
    },
  };
}

function compactUsageStoreOptions(options: { usageRoot?: string; agentDir?: string; now?: () => number }): UsageStoreOptions {
  const compact: UsageStoreOptions = {};
  if (options.usageRoot !== undefined) compact.usageRoot = options.usageRoot;
  if (options.agentDir !== undefined) compact.agentDir = options.agentDir;
  if (options.now !== undefined) compact.now = options.now;
  return compact;
}

export function createUsageRecorder(store: UsageStore): UsageRecorder {
  let pending: Promise<void> = Promise.resolve();
  let failures = 0;
  return {
    record(delta: UsageDelta): void {
      pending = pending
        .then(() => store.append(delta))
        .catch(() => {
          failures += 1;
        });
    },
    async flush(): Promise<void> {
      await pending;
    },
    failureCount(): number {
      return failures;
    },
  };
}

export async function ensureTrackingInfo(usageRoot: string, now: () => number = Date.now): Promise<TrackingInfoV1> {
  const existing = await readTrackingInfoIfPresent(usageRoot);
  if (existing) {
    return existing;
  }
  const path = join(usageRoot, "tracking.json");
  await mkdir(dirname(path), { recursive: true });
  const created: TrackingInfoV1 = { schema: TRACKING_SCHEMA, trackingStartedAt: now() };
  const content = `${JSON.stringify(created, null, 2)}\n`;
  const linked = await tryAtomicCreate(path, content);
  if (linked) {
    return created;
  }
  const raced = await readTrackingInfoIfPresent(usageRoot);
  if (raced) {
    return raced;
  }
  await atomicReplace(path, content);
  return created;
}

export async function readTrackingInfoIfPresent(usageRoot: string): Promise<TrackingInfoV1 | undefined> {
  const path = join(usageRoot, "tracking.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parseTrackingInfo(parsed);
  } catch {
    return undefined;
  }
}

export async function recordActivationTransition(options: {
  usageRoot?: string;
  agentDir?: string;
  previousMode: DistillMode;
  nextMode: DistillMode;
  now?: () => number;
}): Promise<void> {
  const previousActive = options.previousMode === "auto" || options.previousMode === "force";
  const nextActive = options.nextMode === "auto" || options.nextMode === "force";
  if (previousActive === nextActive) {
    return;
  }
  const store = createUsageStore(compactUsageStoreOptions(options));
  const at = (options.now ?? Date.now)();
  await store.appendActivation(makeActivationEvent(previousActive ? "stopped" : "started", options.nextMode, at));
}

export async function ensureInferredActivation(options: { usageRoot?: string; agentDir?: string; mode: DistillMode; now?: () => number }): Promise<void> {
  if (options.mode !== "auto" && options.mode !== "force") {
    return;
  }
  const store = createUsageStore(compactUsageStoreOptions(options));
  const tracking = await store.ensureTracking();
  const activations = await store.readActivations();
  const hasActivation = activations.some((event) => event.event === "started" || event.event === "inferred-started");
  if (hasActivation) {
    return;
  }
  await store.appendActivation(makeActivationEvent("inferred-started", options.mode, tracking.trackingStartedAt, true));
}

export function makeActivationEvent(event: ActivationEventType, mode: DistillMode, at: number, partial?: boolean): ActivationUsageEventV1 {
  const activation: ActivationUsageEventV1 = {
    schema: ACTIVATION_SCHEMA,
    event,
    at,
    mode,
    activationId: `activation-${at}-${randomUUID()}`,
  };
  if (partial) {
    activation.partial = true;
  }
  return activation;
}

export async function writeBackfillSnapshot(usageRoot: string, snapshotId: string, deltas: UsageDelta[]): Promise<void> {
  if (!isSafeId(snapshotId)) {
    throw new Error("unsafe backfill snapshot id");
  }
  await ensureTrackingInfo(usageRoot);
  const file = join(usageRoot, "backfill", `${snapshotId}.jsonl`);
  const lines: string[] = [];
  for (const delta of deltas) {
    const safe = validateUsageDelta(delta);
    if (safe.source !== "backfill") {
      throw new Error("backfill snapshot can only contain backfill deltas");
    }
    const line = JSON.stringify(safe);
    if (Buffer.byteLength(`${line}\n`, "utf-8") > 4096) {
      throw new Error("usage line exceeds 4KB limit");
    }
    lines.push(line);
  }
  await atomicReplace(file, `${lines.join("\n")}\n`);
}

export function summarizeUsageDeltas(deltas: UsageDelta[], query: UsageQuery, warnings: string[] = [], generatedAt = Date.now()): UsageStatsReportV1 {
  const filtered = filterUsageDeltas(deltas, query);
  const deduped = dedupeUsageDeltas(filtered);
  let tracked = emptyUsageTotals();
  let backfill = emptyUsageTotals();
  for (const delta of deduped) {
    if (delta.source === "backfill") {
      backfill = addUsageDeltaToTotals(backfill, delta);
    } else {
      tracked = addUsageDeltaToTotals(tracked, delta);
    }
  }
  const report: UsageStatsReportV1 = {
    schema: STATS_RESPONSE_SCHEMA,
    generatedAt,
    scope: query.scope,
    period: { kind: query.periodKind ?? (query.since === undefined ? "all" : "since") },
    tracked,
    warnings,
  };
  if (query.periodPartial !== undefined) {
    report.period.partial = query.periodPartial;
  }
  if (query.cwdHash) {
    report.cwdHash = query.cwdHash;
  }
  if (query.since !== undefined) {
    report.period.since = query.since;
  }
  if (query.until !== undefined) {
    report.period.until = query.until;
  }
  if (backfill.records > 0) {
    report.backfill = { ...backfill, unknown: { expansions: true, distillerSpend: true, skipped: true } };
  }
  if (query.includeBackfill && backfill.records > 0) {
    report.combined = { ...combineTotals(tracked, backfill), label: "tracked-plus-historical-estimate" };
  }
  return report;
}

export function validateUsageDelta(value: unknown): UsageDelta {
  if (!isRecord(value)) {
    throw new Error("usage delta must be an object");
  }
  assertNoForbiddenKeys(value);
  const usageClass = readString(value, "usageClass");
  if (usageClass === "expand") {
    return validateExpansionDelta(value);
  }
  return validateToolResultDelta(value);
}

function validateToolResultDelta(record: Record<string, unknown>): UsageDelta {
  assertAllowedKeys(record, [
    "schema",
    "source",
    "usageClass",
    "at",
    "sessionKey",
    "cwdHash",
    "artifactId",
    "toolNameHash",
    "rawBytes",
    "visibleBytes",
    "mainBytesDelta",
    "estimatedMainTokensDelta",
    "semanticModelCalls",
    "semanticCacheHits",
    "reducerHits",
    "fallbackCount",
    "validationRejectedCount",
    "distillerInputTokensExact",
    "distillerOutputTokensExact",
    "distillerTokensEstimated",
    "distillerCostUsdExact",
    "failureReason",
  ]);
  const schema = requireLiteral(record, "schema", USAGE_DELTA_SCHEMA);
  const source = requireUsageSource(record.source);
  const usageClass = requireToolResultUsageClass(record.usageClass);
  const at = requireFiniteNumber(record, "at");
  const sessionKey = requireSessionKey(record.sessionKey);
  const cwdHash = requireCwdHash(record.cwdHash);
  const rawBytes = requireFiniteNumber(record, "rawBytes");
  const visibleBytes = requireFiniteNumber(record, "visibleBytes");
  const mainBytesDelta = requireFiniteNumber(record, "mainBytesDelta");
  const estimatedMainTokensDelta = requireFiniteNumber(record, "estimatedMainTokensDelta");
  const delta = {
    schema,
    source,
    usageClass,
    at,
    sessionKey,
    cwdHash,
    rawBytes,
    visibleBytes,
    mainBytesDelta,
    estimatedMainTokensDelta,
    semanticModelCalls: requireBit(record, "semanticModelCalls"),
    semanticCacheHits: requireBit(record, "semanticCacheHits"),
    reducerHits: requireBit(record, "reducerHits"),
    fallbackCount: requireBit(record, "fallbackCount"),
    validationRejectedCount: requireBit(record, "validationRejectedCount"),
  } satisfies UsageDelta;
  const artifactId = optionalArtifactId(record.artifactId);
  const toolNameHash = optionalHash(record.toolNameHash, "toolNameHash");
  const distillerInputTokensExact = optionalNonNegative(record.distillerInputTokensExact, "distillerInputTokensExact");
  const distillerOutputTokensExact = optionalNonNegative(record.distillerOutputTokensExact, "distillerOutputTokensExact");
  const distillerTokensEstimated = optionalNonNegative(record.distillerTokensEstimated, "distillerTokensEstimated");
  const distillerCostUsdExact = optionalNonNegative(record.distillerCostUsdExact, "distillerCostUsdExact");
  const failureReason = optionalFailureReason(record.failureReason);
  return {
    ...delta,
    ...(artifactId ? { artifactId } : {}),
    ...(toolNameHash ? { toolNameHash } : {}),
    ...(distillerInputTokensExact !== undefined ? { distillerInputTokensExact } : {}),
    ...(distillerOutputTokensExact !== undefined ? { distillerOutputTokensExact } : {}),
    ...(distillerTokensEstimated !== undefined ? { distillerTokensEstimated } : {}),
    ...(distillerCostUsdExact !== undefined ? { distillerCostUsdExact } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

function validateExpansionDelta(record: Record<string, unknown>): UsageDelta {
  assertAllowedKeys(record, ["schema", "source", "usageClass", "at", "sessionKey", "cwdHash", "artifactId", "expandMode", "maxChars"]);
  return {
    schema: requireLiteral(record, "schema", USAGE_DELTA_SCHEMA),
    source: requireLiteral(record, "source", "live"),
    usageClass: requireLiteral(record, "usageClass", "expand"),
    at: requireFiniteNumber(record, "at"),
    sessionKey: requireSessionKey(record.sessionKey),
    cwdHash: requireCwdHash(record.cwdHash),
    artifactId: requireArtifactId(record.artifactId),
    expandMode: requireExpandMode(record.expandMode),
    maxChars: requireFiniteNumber(record, "maxChars"),
  };
}

function validateActivationEvent(value: unknown): ActivationUsageEventV1 {
  if (!isRecord(value)) {
    throw new Error("activation event must be an object");
  }
  assertAllowedKeys(value, ["schema", "event", "at", "mode", "activationId", "partial"]);
  const event = requireActivationEvent(value.event);
  const activation: ActivationUsageEventV1 = {
    schema: requireLiteral(value, "schema", ACTIVATION_SCHEMA),
    event,
    at: requireFiniteNumber(value, "at"),
    mode: requireMode(value.mode),
    activationId: requireSessionKey(value.activationId),
  };
  if (value.partial !== undefined) {
    if (value.partial !== true) {
      throw new Error("partial must be true when present");
    }
    activation.partial = true;
  }
  return activation;
}

async function readUsageDeltas(usageRoot: string, includeBackfill: boolean): Promise<UsageReadResult> {
  const warnings: string[] = [];
  const files = [...(await listJsonlFiles(join(usageRoot, "sessions"), warnings)), ...(includeBackfill ? await listJsonlFiles(join(usageRoot, "backfill"), warnings) : [])];
  const deltas: UsageDelta[] = [];
  for (const file of files) {
    const lines = await readJsonlLines(file, warnings);
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        deltas.push(validateUsageDelta(parsed));
      } catch {
        warnings.push("skipped invalid usage line");
      }
    }
  }
  return { deltas, warnings };
}

async function readActivationEvents(usageRoot: string): Promise<ActivationUsageEventV1[]> {
  const file = join(usageRoot, "activations.jsonl");
  const warnings: string[] = [];
  const lines = await readJsonlLines(file, warnings);
  const events: ActivationUsageEventV1[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      events.push(validateActivationEvent(parsed));
    } catch {
      // Invalid activation lines are ignored; stats can still fold usage deltas.
    }
  }
  return events;
}

async function listJsonlFiles(dir: string, warnings: string[]): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && isSafeJsonlName(entry.name)).map((entry) => join(dir, entry.name));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    warnings.push("could not read usage directory");
    return [];
  }
}

async function readJsonlLines(file: string, warnings: string[]): Promise<string[]> {
  try {
    const raw = await readFile(file, "utf-8");
    return raw.split("\n").filter((line) => line.trim().length > 0);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    warnings.push("could not read usage file");
    return [];
  }
}

function filterUsageDeltas(deltas: UsageDelta[], query: UsageQuery): UsageDelta[] {
  return deltas.filter((delta) => {
    if (query.scope === "project" && query.cwdHash && delta.cwdHash !== query.cwdHash) {
      return false;
    }
    if (query.since !== undefined && delta.at < query.since) {
      return false;
    }
    if (query.until !== undefined && delta.at > query.until) {
      return false;
    }
    return true;
  });
}

function dedupeUsageDeltas(deltas: UsageDelta[]): UsageDelta[] {
  const liveArtifactKeys = new Set(
    deltas
      .filter((delta) => delta.source === "live" && delta.usageClass !== "expand" && delta.artifactId)
      .map((delta) => `${delta.cwdHash}:${delta.artifactId}`),
  );
  const keyed = new Map<string, UsageDelta>();
  const unkeyed: UsageDelta[] = [];
  for (const delta of deltas) {
    if (delta.usageClass === "expand" || !delta.artifactId) {
      unkeyed.push(delta);
      continue;
    }
    const artifactKey = `${delta.cwdHash}:${delta.artifactId}`;
    if (delta.source === "backfill" && liveArtifactKeys.has(artifactKey)) {
      continue;
    }
    const key = delta.source === "backfill" ? `backfill:${artifactKey}` : `live:${artifactKey}:${delta.usageClass}`;
    if (!keyed.has(key)) {
      keyed.set(key, delta);
    }
  }
  return [...unkeyed, ...keyed.values()];
}

function combineTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    records: left.records + right.records,
    rawBytes: left.rawBytes + right.rawBytes,
    visibleBytes: left.visibleBytes + right.visibleBytes,
    mainBytesDelta: left.mainBytesDelta + right.mainBytesDelta,
    estimatedMainTokensDelta: left.estimatedMainTokensDelta + right.estimatedMainTokensDelta,
    semanticModelCalls: left.semanticModelCalls + right.semanticModelCalls,
    semanticCacheHits: left.semanticCacheHits + right.semanticCacheHits,
    reducerHits: left.reducerHits + right.reducerHits,
    fallbackCount: left.fallbackCount + right.fallbackCount,
    validationRejectedCount: left.validationRejectedCount + right.validationRejectedCount,
    expansionCount: left.expansionCount + right.expansionCount,
    distillerInputTokensExact: left.distillerInputTokensExact + right.distillerInputTokensExact,
    distillerOutputTokensExact: left.distillerOutputTokensExact + right.distillerOutputTokensExact,
    distillerTokensEstimated: left.distillerTokensEstimated + right.distillerTokensEstimated,
    distillerCostUsdExact: left.distillerCostUsdExact + right.distillerCostUsdExact,
  };
}

async function tryAtomicCreate(path: string, content: string): Promise<boolean> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx" });
  try {
    await link(tempPath, path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function atomicReplace(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf-8") > 4096) {
    throw new Error("usage line exceeds 4KB limit");
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, { encoding: "utf-8", flag: "a" });
}

function usageFileForDelta(usageRoot: string, delta: UsageDelta): string {
  if (delta.source === "backfill") {
    return join(usageRoot, "backfill", `${delta.sessionKey}.jsonl`);
  }
  return join(usageRoot, "sessions", `${delta.sessionKey}.jsonl`);
}

function parseTrackingInfo(value: unknown): TrackingInfoV1 | undefined {
  if (!isRecord(value) || value.schema !== TRACKING_SCHEMA) {
    return undefined;
  }
  const trackingStartedAt = value.trackingStartedAt;
  return typeof trackingStartedAt === "number" && Number.isFinite(trackingStartedAt) ? { schema: TRACKING_SCHEMA, trackingStartedAt } : undefined;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new Error(`unknown usage field: ${key}`);
    }
  }
}

function assertNoForbiddenKeys(record: Record<string, unknown>): void {
  const forbidden = new Set(["cwd", "rawPath", "metadataPath", "inputPreview", "summary", "fallbackReason", "rawText", "command"]);
  for (const key of Object.keys(record)) {
    if (forbidden.has(key)) {
      throw new Error(`forbidden usage field: ${key}`);
    }
  }
}

function requireLiteral<T extends string>(record: Record<string, unknown>, key: string, literal: T): T {
  if (record[key] !== literal) {
    throw new Error(`expected ${key}=${literal}`);
  }
  return literal;
}

function requireFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected finite number for ${key}`);
  }
  return value;
}

function optionalNonNegative(value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`expected non-negative number for ${key}`);
  }
  return value;
}

function requireBit(record: Record<string, unknown>, key: string): 0 | 1 {
  const value = record[key];
  if (value !== 0 && value !== 1) {
    throw new Error(`expected bit for ${key}`);
  }
  return value;
}

function requireUsageSource(value: unknown): "live" | "backfill" {
  if (value !== "live" && value !== "backfill") {
    throw new Error("invalid usage source");
  }
  return value;
}

function requireToolResultUsageClass(value: unknown): "semantic" | "semantic-cache" | "reducer" | "fallback" | "validation-rejected" | "raw-write-failed" {
  if (value === "semantic" || value === "semantic-cache" || value === "reducer" || value === "fallback" || value === "validation-rejected" || value === "raw-write-failed") {
    return value;
  }
  throw new Error("invalid usage class");
}

function optionalFailureReason(value: unknown): BoundedFailureReason | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "raw-write-failed" ||
    value === "model-error" ||
    value === "summary-rejected" ||
    value === "metadata-update-failed" ||
    value === "unknown-artifact" ||
    value === "store-error" ||
    value === "historical"
  ) {
    return value;
  }
  throw new Error("invalid failure reason");
}

function requireActivationEvent(value: unknown): ActivationEventType {
  if (value === "started" || value === "stopped" || value === "inferred-started") {
    return value;
  }
  throw new Error("invalid activation event");
}

function requireMode(value: unknown): "auto" | "force" | "off" {
  if (value === "auto" || value === "force" || value === "off") {
    return value;
  }
  throw new Error("invalid activation mode");
}

function requireExpandMode(value: unknown): "summary" | "raw" | "head" | "tail" {
  if (value === "summary" || value === "raw" || value === "head" || value === "tail") {
    return value;
  }
  throw new Error("invalid expand mode");
}

function requireSessionKey(value: unknown): string {
  if (typeof value !== "string" || !isSafeId(value) || value.includes(".jsonl")) {
    throw new Error("unsafe session key");
  }
  return value;
}

function requireCwdHash(value: unknown): string {
  if (typeof value !== "string" || !isSafeCwdHash(value)) {
    throw new Error("unsafe cwd hash");
  }
  return value;
}

function requireArtifactId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{20}$/.test(value)) {
    throw new Error("unsafe artifact id");
  }
  return value;
}

function optionalArtifactId(value: unknown): string | undefined {
  return value === undefined ? undefined : requireArtifactId(value);
}

function optionalHash(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[a-f0-9]{16,64}$/.test(value)) {
    throw new Error(`unsafe ${key}`);
  }
  return value;
}

function isSafeJsonlName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}\.jsonl$/.test(value);
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) && !value.includes("/") && !value.includes("\\");
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
