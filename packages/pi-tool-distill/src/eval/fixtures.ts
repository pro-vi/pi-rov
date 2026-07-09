import { randomUUID } from "node:crypto";
import { mkdir, opendir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "../artifacts.js";
import { mineFactsForCandidate } from "./facts.js";
import { EVAL_FIXTURE_VERSION, type EvalFact, type EvalFixtureManifest, type EvalFixtureSource, type TranscriptCandidate } from "./types.js";

export interface FixtureBuildOptions {
  rootDir: string;
  now?: () => Date;
  laterWindowLines?: number;
}

export interface FixturePaths {
  fixtureDir: string;
  rawTextPath: string;
  manifestPath: string;
}

export async function buildFixture(candidate: TranscriptCandidate, options: FixtureBuildOptions): Promise<EvalFixtureManifest> {
  const miningOptions = options.laterWindowLines === undefined ? {} : { laterWindowLines: options.laterWindowLines };
  const facts = await mineFactsForCandidate(candidate, miningOptions);
  return writeFixture(candidate, facts, options);
}

export async function writeFixture(candidate: TranscriptCandidate, facts: EvalFact[], options: FixtureBuildOptions): Promise<EvalFixtureManifest> {
  const paths = fixturePaths(options.rootDir, candidate.id);
  const manifest = createFixtureManifest(candidate, facts, paths.rawTextPath, options.now ?? (() => new Date()));
  await atomicWrite(paths.rawTextPath, candidate.rawText);
  await atomicWrite(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function createFixtureManifest(candidate: TranscriptCandidate, facts: EvalFact[], rawTextPath: string, now: () => Date = () => new Date()): EvalFixtureManifest {
  const source = fixtureSource(candidate);
  const scoreable = facts.length > 0;
  const hashBasis = {
    version: EVAL_FIXTURE_VERSION,
    candidateId: candidate.id,
    source,
    toolName: candidate.toolName,
    input: candidate.input,
    rawHash: candidate.rawHash,
    rawBytes: candidate.textBytes,
    rawLines: candidate.lineCount,
    rawTextPath,
    productionEligible: candidate.productionEligible,
    scoreable,
    facts,
    stale: false,
  };
  const fixtureHash = sha256(JSON.stringify(hashBasis));
  const manifest: EvalFixtureManifest = {
    version: EVAL_FIXTURE_VERSION,
    id: candidate.id,
    candidateId: candidate.id,
    fixtureHash,
    createdAt: now().toISOString(),
    source,
    toolName: candidate.toolName,
    input: candidate.input,
    rawHash: candidate.rawHash,
    rawBytes: candidate.textBytes,
    rawLines: candidate.lineCount,
    rawTextPath,
    productionEligible: candidate.productionEligible,
    scoreable,
    facts,
    stale: false,
  };
  if (candidate.ineligibilityReason !== undefined) {
    manifest.ineligibilityReason = candidate.ineligibilityReason;
  }
  return manifest;
}

export function fixturePaths(rootDir: string, fixtureId: string): FixturePaths {
  const fixtureDir = join(rootDir, "fixtures", fixtureId);
  return {
    fixtureDir,
    rawTextPath: join(fixtureDir, "raw.txt"),
    manifestPath: join(fixtureDir, "fixture.json"),
  };
}

export async function loadFixtureManifest(path: string): Promise<EvalFixtureManifest> {
  const raw = await readFile(path, "utf-8");
  const parsed = parseJson(raw);
  const fixture = parseFixtureManifest(parsed);
  if (!fixture) {
    throw new Error(`Invalid tool-distill eval fixture manifest: ${path}`);
  }
  return fixture;
}

export async function loadFixtureRawText(fixture: EvalFixtureManifest): Promise<string> {
  return readFile(fixture.rawTextPath, "utf-8");
}

export async function listFixtureManifests(rootDir: string): Promise<EvalFixtureManifest[]> {
  const fixturesDir = join(rootDir, "fixtures");
  const paths: string[] = [];
  try {
    await collectFixtureManifestPaths(fixturesDir, paths);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const fixtures: EvalFixtureManifest[] = [];
  for (const path of paths.sort((left, right) => left.localeCompare(right))) {
    fixtures.push(await loadFixtureManifest(path));
  }
  return fixtures;
}

export function fixtureSource(candidate: TranscriptCandidate): EvalFixtureSource {
  const source: EvalFixtureSource = {
    sessionPath: candidate.sessionPath,
    lineNumber: candidate.lineNumber,
    entryId: candidate.entryId,
    parentId: candidate.parentId,
    role: candidate.role,
  };
  if (candidate.sessionId !== undefined) source.sessionId = candidate.sessionId;
  if (candidate.cwd !== undefined) source.cwd = candidate.cwd;
  if (candidate.timestamp !== undefined) source.timestamp = candidate.timestamp;
  return source;
}

export function candidateIndexRecord(candidate: TranscriptCandidate): Omit<TranscriptCandidate, "rawText"> {
  const { rawText: _rawText, ...metadata } = candidate;
  return metadata;
}

function parseFixtureManifest(value: unknown): EvalFixtureManifest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const version = value.version;
  const id = readString(value, "id");
  const candidateId = readString(value, "candidateId");
  const fixtureHash = readString(value, "fixtureHash");
  const createdAt = readString(value, "createdAt");
  const source = parseFixtureSource(value.source);
  const toolName = readString(value, "toolName");
  const input = isRecord(value.input) ? value.input : undefined;
  const rawHash = readString(value, "rawHash");
  const rawBytes = readNumber(value, "rawBytes");
  const rawLines = readNumber(value, "rawLines");
  const rawTextPath = readString(value, "rawTextPath");
  const productionEligible = readBoolean(value, "productionEligible");
  const scoreable = readBoolean(value, "scoreable");
  const stale = readBoolean(value, "stale");
  const facts = parseFacts(value.facts);
  if (
    version !== EVAL_FIXTURE_VERSION ||
    !id ||
    !candidateId ||
    !fixtureHash ||
    !createdAt ||
    !source ||
    !toolName ||
    !input ||
    !rawHash ||
    rawBytes === undefined ||
    rawLines === undefined ||
    !rawTextPath ||
    productionEligible === undefined ||
    scoreable === undefined ||
    stale === undefined ||
    !facts
  ) {
    return undefined;
  }
  const fixture: EvalFixtureManifest = {
    version,
    id,
    candidateId,
    fixtureHash,
    createdAt,
    source,
    toolName,
    input,
    rawHash,
    rawBytes,
    rawLines,
    rawTextPath,
    productionEligible,
    scoreable,
    facts,
    stale,
  };
  const ineligibilityReason = readString(value, "ineligibilityReason");
  if (ineligibilityReason !== undefined) fixture.ineligibilityReason = ineligibilityReason;
  const cachedDistill = parseCachedDistill(value.cachedDistill);
  if (cachedDistill) fixture.cachedDistill = cachedDistill;
  return fixture;
}

function parseFixtureSource(value: unknown): EvalFixtureSource | undefined {
  if (!isRecord(value)) return undefined;
  const sessionPath = readString(value, "sessionPath");
  const lineNumber = readNumber(value, "lineNumber");
  const entryId = readString(value, "entryId");
  const parentId = readParentId(value, "parentId");
  const role = value.role;
  if (!sessionPath || lineNumber === undefined || !entryId || parentId === undefined || (role !== "toolResult" && role !== "bashExecution")) {
    return undefined;
  }
  const source: EvalFixtureSource = { sessionPath, lineNumber, entryId, parentId, role };
  const sessionId = readString(value, "sessionId");
  const cwd = readString(value, "cwd");
  const timestamp = readString(value, "timestamp");
  if (sessionId !== undefined) source.sessionId = sessionId;
  if (cwd !== undefined) source.cwd = cwd;
  if (timestamp !== undefined) source.timestamp = timestamp;
  return source;
}

function parseFacts(value: unknown): EvalFact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const facts: EvalFact[] = [];
  for (const item of value) {
    const fact = parseFact(item);
    if (!fact) {
      return undefined;
    }
    facts.push(fact);
  }
  return facts;
}

function parseFact(value: unknown): EvalFact | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, "id");
  const type = value.type;
  const factType = type === "line-ref" || type === "path" || type === "url" || type === "error" || type === "test" || type === "command" || type === "exit-fact" || type === "quote" ? type : undefined;
  const factValue = readString(value, "value");
  const normalizedValue = readString(value, "normalizedValue");
  const confidence = readNumber(value, "confidence");
  const rawOccurrences = readNumber(value, "rawOccurrences");
  const laterOccurrences = readNumber(value, "laterOccurrences");
  const source = value.source;
  if (!id || !factType || !factValue || !normalizedValue || confidence === undefined || rawOccurrences === undefined || laterOccurrences === undefined) {
    return undefined;
  }
  if (source !== "raw-reused-later" && source !== "metadata-reused-later") {
    return undefined;
  }
  return { id, type: factType, value: factValue, normalizedValue, confidence, rawOccurrences, laterOccurrences, source };
}

function parseCachedDistill(value: unknown): EvalFixtureManifest["cachedDistill"] | undefined {
  if (!isRecord(value) || !isRecord(value.model)) return undefined;
  const provider = readString(value.model, "provider");
  const modelId = readString(value.model, "modelId");
  const summary = readString(value, "summary");
  const createdAt = readString(value, "createdAt");
  if (!provider || !modelId || !summary || !createdAt) return undefined;
  return { model: { provider, modelId }, summary, createdAt };
}

function parseJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}

async function collectFixtureManifestPaths(root: string, paths: string[]): Promise<void> {
  const dir = await opendir(root);
  for await (const entry of dir) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFixtureManifestPaths(path, paths);
    } else if (entry.isFile() && entry.name === "fixture.json") {
      paths.push(path);
    }
  }
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

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readParentId(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
