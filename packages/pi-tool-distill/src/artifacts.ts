import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { previewInput } from "./content.js";
import type { ArtifactReadResult, ArtifactStore, ArtifactSummarySource, ArtifactWriteRequest, ModelRef, ObservationArtifact, ArtifactStatus } from "./types.js";

export interface ArtifactStoreOptions {
  baseDir?: string;
  now?: () => number;
}

export function createArtifactStore(cwd: string, options: ArtifactStoreOptions = {}): ArtifactStore {
  const root = options.baseDir ?? join(getAgentDir(), "tool-distill");
  const cwdHash = sha256(cwd).slice(0, 16);
  const rawDir = join(root, cwdHash, "raw");
  const metaDir = join(root, cwdHash, "metadata");
  const now = options.now ?? Date.now;

  return {
    async writeRaw(request: ArtifactWriteRequest): Promise<ObservationArtifact> {
      const rawHash = sha256(request.rawText);
      const id = sha256(`${request.toolCallId}:${rawHash}`).slice(0, 20);
      const rawPath = join(rawDir, `${id}.txt`);
      const metadataPath = join(metaDir, `${id}.json`);
      const normalized = fingerprintText(request.rawText);
      const artifact: ObservationArtifact = {
        id,
        status: "raw",
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        createdAt: now(),
        cwd: request.cwd,
        rawPath,
        metadataPath,
        rawHash,
        rawBytes: Buffer.byteLength(request.rawText, "utf-8"),
        rawLines: request.rawText.length === 0 ? 0 : request.rawText.split("\n").length,
        inputPreview: previewInput(request.input),
        normalizedHash: normalized.normalizedHash,
        normalizedBytes: normalized.normalizedBytes,
        normalizedLines: normalized.normalizedLines,
      };

      await atomicWrite(rawPath, request.rawText);
      await atomicWrite(metadataPath, serializeArtifact(artifact));
      return artifact;
    },

    async update(artifact: ObservationArtifact): Promise<ObservationArtifact> {
      await atomicWrite(artifact.metadataPath, serializeArtifact(artifact));
      return artifact;
    },

    async read(id: string): Promise<ArtifactReadResult | undefined> {
      if (!isSafeArtifactId(id)) {
        return undefined;
      }
      const metadataPath = join(metaDir, `${id}.json`);
      try {
        const metadataRaw = await readFile(metadataPath, "utf-8");
        const parsed: unknown = JSON.parse(metadataRaw);
        const artifact = parseArtifact(parsed);
        if (!artifact) {
          return undefined;
        }
        const rawText = await readFile(artifact.rawPath, "utf-8");
        return { artifact, rawText };
      } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }
    },

    async listRecent(limit: number): Promise<ObservationArtifact[]> {
      try {
        const entries = await readdir(metaDir, { withFileTypes: true });
        const artifacts: ObservationArtifact[] = [];
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) {
            continue;
          }
          const raw = await readFile(join(metaDir, entry.name), "utf-8");
          const parsed: unknown = JSON.parse(raw);
          const artifact = parseArtifact(parsed);
          if (artifact) {
            artifacts.push(artifact);
          }
        }
        return artifacts.sort((left, right) => right.createdAt - left.createdAt).slice(0, Math.max(0, limit));
      } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      }
    },
  };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface TextFingerprint {
  normalizedText: string;
  normalizedHash: string;
  normalizedBytes: number;
  normalizedLines: number;
}

export function fingerprintText(rawText: string): TextFingerprint {
  const normalizedText = normalizeFingerprintText(rawText);
  return {
    normalizedText,
    normalizedHash: sha256(normalizedText),
    normalizedBytes: Buffer.byteLength(normalizedText, "utf-8"),
    normalizedLines: normalizedText.length === 0 ? 0 : normalizedText.split("\n").length,
  };
}

export function normalizeFingerprintText(rawText: string): string {
  return rawText
    .replace(/\r\n?/g, "\n")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .trimEnd();
}

export function markDistilled(artifact: ObservationArtifact, summary: string, model: ModelRef): ObservationArtifact {
  const summaryBytes = Buffer.byteLength(summary, "utf-8");
  return {
    ...artifact,
    status: "distilled",
    method: "semantic",
    model,
    summary,
    summaryBytes,
    compressionRatio: artifact.rawBytes === 0 ? 0 : summaryBytes / artifact.rawBytes,
  };
}

export function markDistilledFromCache(
  artifact: ObservationArtifact,
  summary: string,
  model: ModelRef,
  source: { cacheKey: string; sourceArtifactId: string },
): ObservationArtifact {
  const summaryBytes = Buffer.byteLength(summary, "utf-8");
  return {
    ...artifact,
    status: "distilled",
    method: "semantic-cache",
    model,
    summary,
    summaryBytes,
    compressionRatio: artifact.rawBytes === 0 ? 0 : summaryBytes / artifact.rawBytes,
    summarySource: { kind: "semantic-cache", cacheKey: source.cacheKey, sourceArtifactId: source.sourceArtifactId },
  };
}

export function markReduced(
  artifact: ObservationArtifact,
  summary: string,
  source: { reducerId: string; previousArtifactId?: string; omittedBytes?: number },
): ObservationArtifact {
  const summaryBytes = Buffer.byteLength(summary, "utf-8");
  const summarySource: ArtifactSummarySource = { kind: "reducer", reducerId: source.reducerId };
  if (source.previousArtifactId) summarySource.previousArtifactId = source.previousArtifactId;
  if (source.omittedBytes !== undefined) summarySource.omittedBytes = source.omittedBytes;
  return {
    ...artifact,
    status: "reduced",
    method: "reducer",
    summary,
    summaryBytes,
    compressionRatio: artifact.rawBytes === 0 ? 0 : summaryBytes / artifact.rawBytes,
    summarySource,
  };
}

export function markFallback(artifact: ObservationArtifact, reason: string, model?: ModelRef): ObservationArtifact {
  const {
    method: _method,
    summary: _summary,
    summaryBytes: _summaryBytes,
    compressionRatio: _compressionRatio,
    summarySource: _summarySource,
    fallbackReason: _fallbackReason,
    ...base
  } = artifact;
  const next: ObservationArtifact = {
    ...base,
    status: "fallback",
    fallbackReason: reason,
  };
  if (model) {
    next.model = model;
  }
  return next;
}

function serializeArtifact(artifact: ObservationArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
}

function parseArtifact(value: unknown): ObservationArtifact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value, "id");
  const status = readStatus(value, "status");
  const toolCallId = readString(value, "toolCallId");
  const toolName = readString(value, "toolName");
  const createdAt = readNumber(value, "createdAt");
  const cwd = readString(value, "cwd");
  const rawPath = readString(value, "rawPath");
  const metadataPath = readString(value, "metadataPath");
  const rawHash = readString(value, "rawHash");
  const rawBytes = readNumber(value, "rawBytes");
  const rawLines = readNumber(value, "rawLines");
  const inputPreview = readString(value, "inputPreview");

  if (
    !id ||
    !status ||
    !toolCallId ||
    !toolName ||
    createdAt === undefined ||
    !cwd ||
    !rawPath ||
    !metadataPath ||
    !rawHash ||
    rawBytes === undefined ||
    rawLines === undefined ||
    inputPreview === undefined
  ) {
    return undefined;
  }

  const artifact: ObservationArtifact = {
    id,
    status,
    toolCallId,
    toolName,
    createdAt,
    cwd,
    rawPath,
    metadataPath,
    rawHash,
    rawBytes,
    rawLines,
    inputPreview,
  };

  const model = readModelRef(value.model);
  if (model) artifact.model = model;
  const method = readMethod(value, "method");
  if (method) artifact.method = method;
  const normalizedHash = readString(value, "normalizedHash");
  if (normalizedHash !== undefined) artifact.normalizedHash = normalizedHash;
  const normalizedBytes = readNumber(value, "normalizedBytes");
  if (normalizedBytes !== undefined) artifact.normalizedBytes = normalizedBytes;
  const normalizedLines = readNumber(value, "normalizedLines");
  if (normalizedLines !== undefined) artifact.normalizedLines = normalizedLines;
  if (status === "distilled" || status === "reduced") {
    const summary = readString(value, "summary");
    if (summary === undefined) return undefined;
    artifact.summary = summary;
    const summaryBytes = readNumber(value, "summaryBytes");
    if (summaryBytes !== undefined) artifact.summaryBytes = summaryBytes;
    const compressionRatio = readNumber(value, "compressionRatio");
    if (compressionRatio !== undefined) artifact.compressionRatio = compressionRatio;
    const summarySource = readSummarySource(value.summarySource);
    if (summarySource) artifact.summarySource = summarySource;
  }
  if (status === "fallback") {
    const fallbackReason = readString(value, "fallbackReason");
    if (fallbackReason !== undefined) artifact.fallbackReason = fallbackReason;
  }

  normalizeSummaryMethod(artifact);
  return artifact;
}

function normalizeSummaryMethod(artifact: ObservationArtifact): void {
  if (artifact.summarySource?.kind === "semantic-cache" && artifact.summarySource.cacheKey) {
    artifact.method = "semantic-cache";
    return;
  }
  if (artifact.summarySource?.kind === "reducer" && artifact.summarySource.reducerId) {
    artifact.method = "reducer";
    return;
  }
  if (artifact.method === "semantic-cache" || artifact.method === "reducer") {
    delete artifact.method;
  }
}

function readModelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = value.provider;
  const modelId = value.modelId;
  if (typeof provider === "string" && typeof modelId === "string") {
    return { provider, modelId };
  }
  return undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStatus(record: Record<string, unknown>, key: string): ArtifactStatus | undefined {
  const value = record[key];
  return value === "raw" || value === "distilled" || value === "reduced" || value === "fallback" ? value : undefined;
}

function readMethod(record: Record<string, unknown>, key: string): ObservationArtifact["method"] | undefined {
  const value = record[key];
  return value === "semantic" || value === "semantic-cache" || value === "reducer" ? value : undefined;
}

function readSummarySource(value: unknown): ArtifactSummarySource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind !== "semantic-cache" && kind !== "reducer") {
    return undefined;
  }
  const source: ArtifactSummarySource = { kind };
  const cacheKey = readString(value, "cacheKey");
  const sourceArtifactId = readString(value, "sourceArtifactId");
  const reducerId = readString(value, "reducerId");
  const previousArtifactId = readString(value, "previousArtifactId");
  const omittedBytes = readNumber(value, "omittedBytes");
  if (cacheKey !== undefined) source.cacheKey = cacheKey;
  if (sourceArtifactId !== undefined) source.sourceArtifactId = sourceArtifactId;
  if (reducerId !== undefined) source.reducerId = reducerId;
  if (previousArtifactId !== undefined) source.previousArtifactId = previousArtifactId;
  if (omittedBytes !== undefined) source.omittedBytes = omittedBytes;
  return source;
}

function isSafeArtifactId(id: string): boolean {
  return /^[a-f0-9]{20}$/.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
