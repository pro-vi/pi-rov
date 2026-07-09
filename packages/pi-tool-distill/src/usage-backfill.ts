import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getToolDistillRoot, getUsageRoot, isSafeCwdHash } from "./paths.js";
import {
  TRACKING_SCHEMA,
  makeFallbackUsageDelta,
  makeReducerUsageDelta,
  makeSemanticCacheUsageDelta,
  makeSemanticUsageDelta,
  type ToolResultUsageDeltaV1,
  type TrackingInfoV1,
  type UsageDelta,
} from "./usage.js";
import { ensureTrackingInfo, readTrackingInfoIfPresent, writeBackfillSnapshot } from "./usage-store.js";

export interface BackfillOptions {
  toolDistillRoot?: string;
  usageRoot?: string;
  agentDir?: string;
  dryRun?: boolean;
  now?: () => number;
}

export interface BackfillResult {
  dryRun: boolean;
  snapshotId?: string;
  scannedCwdHashes: number;
  scannedArtifacts: number;
  records: number;
  skipped: number;
  warnings: string[];
}

interface BackfillArtifactInfo {
  id: string;
  toolCallId: string;
  createdAt: number;
  status: "raw" | "distilled" | "reduced" | "fallback";
  method?: "semantic" | "semantic-cache" | "reducer";
  rawBytes: number;
  summaryBytes?: number;
}

export async function runUsageBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const now = options.now ?? Date.now;
  const usageRoot = options.usageRoot ?? getUsageRoot(options.agentDir);
  const toolDistillRoot = options.toolDistillRoot ?? getToolDistillRoot(options.agentDir);
  const tracking = await resolveBackfillTracking(usageRoot, options.dryRun === true, now);
  const warnings: string[] = [];
  const cwdHashes = await listCwdHashDirs(toolDistillRoot, warnings);
  const deltas: UsageDelta[] = [];
  let scannedArtifacts = 0;
  let skipped = 0;

  for (const cwdHash of cwdHashes) {
    const metadataDir = join(toolDistillRoot, cwdHash, "metadata");
    const files = await listMetadataFiles(metadataDir, warnings);
    for (const file of files) {
      scannedArtifacts += 1;
      const artifact = await readBackfillArtifact(join(metadataDir, file), warnings);
      if (!artifact || artifact.createdAt >= tracking.trackingStartedAt || artifact.toolCallId.startsWith("tool-distill-selftest-")) {
        skipped += 1;
        continue;
      }
      const delta = artifactToBackfillDelta(cwdHash, artifact, `backfill-${tracking.trackingStartedAt}`);
      if (delta) {
        deltas.push(delta);
      } else {
        skipped += 1;
      }
    }
  }

  const snapshotId = `backfill-${tracking.trackingStartedAt}`;
  if (options.dryRun !== true && deltas.length > 0) {
    await writeBackfillSnapshot(usageRoot, snapshotId, deltas);
  }

  return {
    dryRun: options.dryRun === true,
    ...(options.dryRun === true || deltas.length === 0 ? {} : { snapshotId }),
    scannedCwdHashes: cwdHashes.length,
    scannedArtifacts,
    records: deltas.length,
    skipped,
    warnings,
  };
}

async function resolveBackfillTracking(usageRoot: string, dryRun: boolean, now: () => number): Promise<TrackingInfoV1> {
  if (!dryRun) {
    return ensureTrackingInfo(usageRoot, now);
  }
  return (await readTrackingInfoIfPresent(usageRoot)) ?? { schema: TRACKING_SCHEMA, trackingStartedAt: now() };
}

function artifactToBackfillDelta(cwdHash: string, artifact: BackfillArtifactInfo, sessionKey: string): ToolResultUsageDeltaV1 | undefined {
  const common = {
    source: "backfill" as const,
    at: artifact.createdAt,
    sessionKey,
    cwdHash,
    artifactId: artifact.id,
    rawBytes: artifact.rawBytes,
  };
  if (artifact.status === "distilled" && artifact.method === "semantic") {
    return makeSemanticUsageDelta({ ...common, visibleBytes: artifact.summaryBytes ?? artifact.rawBytes });
  }
  if (artifact.status === "distilled" && artifact.method === "semantic-cache") {
    return makeSemanticCacheUsageDelta({ ...common, visibleBytes: artifact.summaryBytes ?? artifact.rawBytes });
  }
  if (artifact.status === "reduced" && artifact.method === "reducer") {
    return makeReducerUsageDelta({ ...common, visibleBytes: artifact.summaryBytes ?? artifact.rawBytes });
  }
  if (artifact.status === "fallback") {
    return makeFallbackUsageDelta({ ...common, visibleBytes: artifact.rawBytes, failureReason: "historical" });
  }
  return undefined;
}

async function listCwdHashDirs(root: string, warnings: string[]): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isSafeCwdHash(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    warnings.push("could not read tool-distill root");
    return [];
  }
}

async function listMetadataFiles(metadataDir: string, warnings: string[]): Promise<string[]> {
  try {
    const entries = await readdir(metadataDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /^[a-f0-9]{20}\.json$/.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    warnings.push("could not read metadata directory");
    return [];
  }
}

async function readBackfillArtifact(path: string, warnings: string[]): Promise<BackfillArtifactInfo | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parseBackfillArtifact(parsed);
  } catch {
    warnings.push("skipped invalid metadata");
    return undefined;
  }
}

function parseBackfillArtifact(value: unknown): BackfillArtifactInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value, "id");
  const toolCallId = readString(value, "toolCallId");
  const createdAt = readNumber(value, "createdAt");
  const status = readStatus(value.status);
  const method = readMethod(value.method);
  const rawBytes = readNumber(value, "rawBytes");
  const summaryBytes = readNumber(value, "summaryBytes");
  if (!id || !/^[a-f0-9]{20}$/.test(id) || !toolCallId || createdAt === undefined || !status || rawBytes === undefined) {
    return undefined;
  }
  const artifact: BackfillArtifactInfo = { id, toolCallId, createdAt, status, rawBytes };
  if (method) artifact.method = method;
  if (summaryBytes !== undefined) artifact.summaryBytes = summaryBytes;
  return artifact;
}

function readStatus(value: unknown): BackfillArtifactInfo["status"] | undefined {
  return value === "raw" || value === "distilled" || value === "reduced" || value === "fallback" ? value : undefined;
}

function readMethod(value: unknown): BackfillArtifactInfo["method"] | undefined {
  return value === "semantic" || value === "semantic-cache" || value === "reducer" ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
