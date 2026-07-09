import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { sha256 } from "./artifacts.js";
import type {
  DistillSettings,
  ModelRef,
  SemanticSummaryCache,
  SemanticSummaryCacheEntry,
  SemanticSummaryCacheLookup,
  SemanticSummaryCacheSignature,
} from "./types.js";

export interface SummaryCacheOptions {
  baseDir?: string;
  now?: () => Date;
}

interface BuildSignatureRequest {
  rawHash: string;
  toolName: string;
  input: Record<string, unknown>;
  question: string;
  promptVersion: number;
  model: ModelRef;
  settings: Pick<DistillSettings, "maxSummaryChars" | "maxSummaryRatio">;
}

type StableJson = null | boolean | number | string | StableJson[] | { [key: string]: StableJson };

export function createSummaryCache(cwd: string, options: SummaryCacheOptions = {}): SemanticSummaryCache {
  const root = options.baseDir ?? join(getAgentDir(), "tool-distill");
  const cwdHash = sha256(cwd).slice(0, 16);
  const cacheDir = join(root, cwdHash, "summary-cache");

  return {
    keyFor(signature: SemanticSummaryCacheSignature): string {
      return summaryCacheKey(signature);
    },

    async read(signature: SemanticSummaryCacheSignature): Promise<SemanticSummaryCacheLookup> {
      const key = summaryCacheKey(signature);
      const path = join(cacheDir, `${key}.json`);
      let raw: string;
      try {
        raw = await readFile(path, "utf-8");
      } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) {
          return { status: "miss" };
        }
        return { status: "error", reason: error instanceof Error ? error.message : "summary cache read failed" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: "invalid", reason: "summary cache JSON is invalid" };
      }

      const entry = parseEntry(parsed);
      if (!entry) {
        return { status: "invalid", reason: "summary cache entry has invalid shape" };
      }
      if (entry.key !== key || !sameSignature(entry.signature, signature)) {
        return { status: "stale", reason: "summary cache signature does not match current distill contract" };
      }
      return { status: "hit", entry };
    },

    async write(entry: SemanticSummaryCacheEntry): Promise<void> {
      await atomicWrite(join(cacheDir, `${entry.key}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    },
  };
}

export function buildSemanticCacheSignature(request: BuildSignatureRequest): SemanticSummaryCacheSignature {
  return {
    rawHash: request.rawHash,
    toolName: request.toolName,
    inputHash: stableInputHash(request.input),
    questionHash: sha256(request.question),
    promptVersion: request.promptVersion,
    model: request.model,
    maxSummaryChars: request.settings.maxSummaryChars,
    maxSummaryRatio: request.settings.maxSummaryRatio,
  };
}

export function createSummaryCacheEntry(request: {
  key: string;
  signature: SemanticSummaryCacheSignature;
  summary: string;
  sourceArtifactId: string;
  now?: () => Date;
}): SemanticSummaryCacheEntry {
  return {
    version: 1,
    key: request.key,
    signature: request.signature,
    summary: request.summary,
    summaryBytes: Buffer.byteLength(request.summary, "utf-8"),
    sourceArtifactId: request.sourceArtifactId,
    model: request.signature.model,
    createdAt: (request.now ?? (() => new Date()))().toISOString(),
  };
}

export function stableInputHash(input: Record<string, unknown>): string {
  return sha256(stableStringify(input));
}

export function summaryCacheKey(signature: SemanticSummaryCacheSignature): string {
  return sha256(stableStringify(signature));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value));
}

function toStableJson(value: unknown): StableJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toStableJson(item));
  }
  if (isRecord(value)) {
    const output: { [key: string]: StableJson } = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = toStableJson(value[key]);
    }
    return output;
  }
  return null;
}

function sameSignature(left: SemanticSummaryCacheSignature, right: SemanticSummaryCacheSignature): boolean {
  return stableStringify(left) === stableStringify(right);
}

function parseEntry(value: unknown): SemanticSummaryCacheEntry | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  const key = readString(value, "key");
  const signature = parseSignature(value.signature);
  const summary = readString(value, "summary");
  const summaryBytes = readNumber(value, "summaryBytes");
  const sourceArtifactId = readString(value, "sourceArtifactId");
  const model = parseModelRef(value.model);
  const createdAt = readString(value, "createdAt");
  if (!key || !signature || summary === undefined || summaryBytes === undefined || !sourceArtifactId || !model || !createdAt) {
    return undefined;
  }
  return { version: 1, key, signature, summary, summaryBytes, sourceArtifactId, model, createdAt };
}

function parseSignature(value: unknown): SemanticSummaryCacheSignature | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawHash = readString(value, "rawHash");
  const toolName = readString(value, "toolName");
  const inputHash = readString(value, "inputHash");
  const questionHash = readString(value, "questionHash");
  const promptVersion = readNumber(value, "promptVersion");
  const model = parseModelRef(value.model);
  const maxSummaryChars = readNumber(value, "maxSummaryChars");
  const maxSummaryRatio = readNumber(value, "maxSummaryRatio");
  if (!rawHash || !toolName || !inputHash || !questionHash || promptVersion === undefined || !model || maxSummaryChars === undefined || maxSummaryRatio === undefined) {
    return undefined;
  }
  return { rawHash, toolName, inputHash, questionHash, promptVersion, model, maxSummaryChars, maxSummaryRatio };
}

function parseModelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = readString(value, "provider");
  const modelId = readString(value, "modelId");
  return provider && modelId ? { provider, modelId } : undefined;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
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
