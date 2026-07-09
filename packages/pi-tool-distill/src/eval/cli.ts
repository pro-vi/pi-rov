import { randomUUID } from "node:crypto";
import { opendir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { complete, type ProviderStreamOptions } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THRESHOLD_CHARS } from "../constants.js";
import { parseModelRef } from "../config.js";
import { buildFixture, candidateIndexRecord, listFixtureManifests, loadFixtureRawText } from "./fixtures.js";
import { createEvalReport, createRunId, renderEvalReportMarkdown, writeEvalReport, writeSyntheticEvalReport } from "./report.js";
import { defaultSessionRoot, scanTranscriptTree } from "./transcripts.js";
import { runSyntheticEval } from "./synthetic.js";
import { runFixtureVariants, type EvalDistillModelInvoker } from "./variants.js";
import {
  EVAL_RUN_VERSION,
  EVAL_VARIANT_IDS,
  type EvalFixtureResult,
  type EvalRunResult,
  type EvalVariantId,
  type EvalVariantResult,
} from "./types.js";
import type { DistillSettings, ModelRef } from "../types.js";

export interface EvalCliIO {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ParsedArgs {
  command: string;
  options: Map<string, string>;
  flags: Set<string>;
}

const DEFAULT_EVAL_ROOT = join("reports", "evals", "tool-distill");

export async function runEvalCli(argv: string[] = process.argv.slice(2), io: EvalCliIO = defaultIO()): Promise<number> {
  const parsed = parseArgs(argv);
  try {
    if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
      io.stdout(helpText());
      return 0;
    }
    if (parsed.command === "scan") {
      return await scanCommand(parsed, io);
    }
    if (parsed.command === "run") {
      return await runCommand(parsed, io);
    }
    if (parsed.command === "report") {
      return await reportCommand(parsed, io);
    }
    if (parsed.command === "synthetic") {
      return await syntheticCommand(parsed, io);
    }
    io.stderr(`Unknown eval command: ${parsed.command}\n\n${helpText()}`);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`tool-distill eval failed: ${message}`);
    return 1;
  }
}

async function scanCommand(parsed: ParsedArgs, io: EvalCliIO): Promise<number> {
  const rootDir = resolveEvalRoot(parsed, io.cwd);
  const sessionsRoot = parsed.options.get("sessions-root") ?? defaultSessionRoot();
  const thresholdBytes = parseIntegerOption(parsed, "threshold", DEFAULT_THRESHOLD_CHARS);
  const sample = parseOptionalInteger(parsed, "sample");
  const scan = await scanTranscriptTree(sessionsRoot, { thresholdBytes });
  const candidates = sample === undefined ? scan.candidates : scan.candidates.slice(0, sample);
  const fixtures = [];
  for (const candidate of candidates) {
    fixtures.push(await buildFixture(candidate, { rootDir }));
  }

  const index = {
    createdAt: new Date().toISOString(),
    sessionsRoot,
    thresholdBytes,
    filesScanned: scan.filesScanned,
    entriesScanned: scan.entriesScanned,
    candidateCount: scan.candidates.length,
    fixtureCount: fixtures.length,
    warnings: scan.warnings,
    candidates: scan.candidates.map(candidateIndexRecord),
  };
  const indexPath = join(rootDir, "scan-index.json");
  await writeJson(indexPath, index);
  io.stdout(`tool-distill eval scan wrote ${fixtures.length} fixture(s) from ${scan.candidates.length} candidate(s) to ${rootDir}`);
  if (scan.warnings.length > 0) {
    io.stdout(`warnings: ${scan.warnings.length}`);
  }
  return 0;
}

async function runCommand(parsed: ParsedArgs, io: EvalCliIO): Promise<number> {
  const rootDir = resolveEvalRoot(parsed, io.cwd);
  const sample = parseOptionalInteger(parsed, "sample");
  const live = parsed.flags.has("live");
  const modelRef = parseModelOption(parsed);
  if (live && !modelRef) {
    io.stderr("--live requires --model <provider>/<modelId>; offline evals never call a model.");
    return 1;
  }
  const invokeDistillModel = live && modelRef ? await createLiveDistillInvoker(modelRef) : undefined;
  const allFixtures = await listFixtureManifests(rootDir);
  const usableFixtures = allFixtures.filter((fixture) => !fixture.stale);
  const fixtures = sample === undefined ? usableFixtures : usableFixtures.slice(0, sample);
  const fixtureResults: EvalFixtureResult[] = [];
  for (const fixture of fixtures) {
    const rawText = await loadFixtureRawText(fixture);
    const variantOptions = { live };
    if (modelRef) Object.assign(variantOptions, { model: modelRef });
    if (invokeDistillModel) Object.assign(variantOptions, { invokeDistillModel });
    fixtureResults.push(await runFixtureVariants(fixture, rawText, variantOptions));
  }
  const runId = createRunId();
  const run: EvalRunResult = {
    version: EVAL_RUN_VERSION,
    id: runId,
    createdAt: new Date().toISOString(),
    live,
    variants: [...EVAL_VARIANT_IDS],
    fixtureResults,
  };
  if (modelRef) run.model = modelRef;
  const candidateCount = await readCandidateCount(rootDir);
  if (candidateCount !== undefined) run.candidateCount = candidateCount;
  const runPath = join(rootDir, "runs", runId, "run.json");
  await writeJson(runPath, run);
  io.stdout(`tool-distill eval run wrote ${fixtureResults.length} fixture result(s) to ${runPath}`);
  if (live) {
    io.stdout(`live distill model: ${modelRef?.provider}/${modelRef?.modelId}`);
  } else {
    io.stdout("offline run: distill-spark variant is skipped unless fixtures contain cached summaries");
  }
  return 0;
}

async function syntheticCommand(parsed: ParsedArgs, io: EvalCliIO): Promise<number> {
  const rootDir = resolveEvalRoot(parsed, io.cwd);
  const run = await runSyntheticEval({ artifactBaseDir: join(rootDir, "synthetic-artifacts", createRunId()) });
  const paths = await writeSyntheticEvalReport(rootDir, run);
  io.stdout(`tool-distill synthetic eval wrote ${paths.jsonPath}`);
  io.stdout(`tool-distill synthetic eval wrote ${paths.markdownPath}`);
  return 0;
}

async function reportCommand(parsed: ParsedArgs, io: EvalCliIO): Promise<number> {
  const rootDir = resolveEvalRoot(parsed, io.cwd);
  const fixtures = await listFixtureManifests(rootDir);
  const explicitRun = parsed.options.get("run");
  const run = explicitRun ? await loadRunResult(explicitRun) : (await loadLatestRunResult(rootDir)) ?? emptyRunResult(await readCandidateCount(rootDir));
  const report = createEvalReport(fixtures, run);
  const paths = await writeEvalReport(rootDir, report);
  io.stdout(`tool-distill eval report wrote ${paths.markdownPath}`);
  io.stdout(renderEvalReportMarkdown(report));
  return 0;
}

async function createLiveDistillInvoker(modelRef: ModelRef): Promise<EvalDistillModelInvoker> {
  const registry = ModelRegistry.create(AuthStorage.create());
  const model = registry.find(modelRef.provider, modelRef.modelId);
  if (!model) {
    throw new Error(`live eval model not found: ${modelRef.provider}/${modelRef.modelId}`);
  }
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`live eval auth failed for ${modelRef.provider}/${modelRef.modelId}: ${auth.error}`);
  }
  if (!auth.apiKey) {
    throw new Error(`live eval auth missing for ${modelRef.provider}/${modelRef.modelId}; run /login or configure an API key first`);
  }
  const apiKey = auth.apiKey;
  return async (request: { prompt: string; settings: DistillSettings }) => {
    const options: ProviderStreamOptions = { apiKey, maxTokens: request.settings.maxModelTokens };
    if (auth.headers) options.headers = auth.headers;
    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: request.prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );
    return response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      options.set(key, value);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(withoutPrefix, next);
      index += 1;
    } else {
      flags.add(withoutPrefix);
    }
  }
  return { command, options, flags };
}

function resolveEvalRoot(parsed: ParsedArgs, cwd: string): string {
  return parsed.options.get("out") ?? join(cwd, DEFAULT_EVAL_ROOT);
}

function parseModelOption(parsed: ParsedArgs): ModelRef | undefined {
  const value = parsed.options.get("model");
  return value ? parseModelRef(value) : undefined;
}

function parseIntegerOption(parsed: ParsedArgs, name: string, fallback: number): number {
  const parsedValue = parseOptionalInteger(parsed, name);
  return parsedValue ?? fallback;
}

function parseOptionalInteger(parsed: ParsedArgs, name: string): number | undefined {
  const value = parsed.options.get(name);
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`--${name} must be a positive integer`);
  }
  const numberValue = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return numberValue;
}

async function readCandidateCount(rootDir: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(rootDir, "scan-index.json"), "utf-8");
    const parsed = parseJson(raw);
    if (!isRecord(parsed)) return undefined;
    const count = parsed.candidateCount;
    return typeof count === "number" && Number.isFinite(count) ? count : undefined;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function loadLatestRunResult(rootDir: string): Promise<EvalRunResult | undefined> {
  const runsDir = join(rootDir, "runs");
  const paths: string[] = [];
  try {
    const dir = await opendir(runsDir);
    for await (const entry of dir) {
      if (entry.isDirectory()) {
        paths.push(join(runsDir, entry.name, "run.json"));
      }
    }
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  const latest = paths.sort((left, right) => right.localeCompare(left))[0];
  return latest ? loadRunResult(latest) : undefined;
}

async function loadRunResult(path: string): Promise<EvalRunResult> {
  const raw = await readFile(path, "utf-8");
  const parsed = parseRunResult(parseJson(raw));
  if (!parsed) {
    throw new Error(`Invalid eval run result: ${path}`);
  }
  return parsed;
}

function emptyRunResult(candidateCount: number | undefined): EvalRunResult {
  const run: EvalRunResult = {
    version: EVAL_RUN_VERSION,
    id: "no-run",
    createdAt: new Date().toISOString(),
    live: false,
    variants: [...EVAL_VARIANT_IDS],
    fixtureResults: [],
  };
  if (candidateCount !== undefined) run.candidateCount = candidateCount;
  return run;
}

function parseRunResult(value: unknown): EvalRunResult | undefined {
  if (!isRecord(value) || value.version !== EVAL_RUN_VERSION) return undefined;
  const id = readString(value, "id");
  const createdAt = readString(value, "createdAt");
  const live = readBoolean(value, "live");
  const variants = parseVariants(value.variants);
  const fixtureResults = parseFixtureResults(value.fixtureResults);
  if (!id || !createdAt || live === undefined || !variants || !fixtureResults) {
    return undefined;
  }
  const run: EvalRunResult = { version: EVAL_RUN_VERSION, id, createdAt, live, variants, fixtureResults };
  const model = parseModel(value.model);
  if (model) run.model = model;
  const candidateCount = readNumber(value, "candidateCount");
  if (candidateCount !== undefined) run.candidateCount = candidateCount;
  return run;
}

function parseFixtureResults(value: unknown): EvalFixtureResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const results: EvalFixtureResult[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const fixtureId = readString(item, "fixtureId");
    const rawHash = readString(item, "rawHash");
    const toolName = readString(item, "toolName");
    const scoreable = readBoolean(item, "scoreable");
    const productionEligible = readBoolean(item, "productionEligible");
    const variantResults = parseVariantResults(item.variantResults);
    if (!fixtureId || !rawHash || !toolName || scoreable === undefined || productionEligible === undefined || !variantResults) {
      return undefined;
    }
    results.push({ fixtureId, rawHash, toolName, scoreable, productionEligible, variantResults });
  }
  return results;
}

function parseVariantResults(value: unknown): Partial<Record<EvalVariantId, EvalVariantResult>> | undefined {
  if (!isRecord(value)) return undefined;
  const results: Partial<Record<EvalVariantId, EvalVariantResult>> = {};
  for (const variant of EVAL_VARIANT_IDS) {
    const parsed = parseVariantResult(value[variant]);
    if (parsed) {
      results[variant] = parsed;
    }
  }
  return results;
}

function parseVariantResult(value: unknown): EvalVariantResult | undefined {
  if (!isRecord(value)) return undefined;
  const variant = parseVariant(value.variant);
  const status = value.status;
  const rawHash = readString(value, "rawHash");
  const rawBytes = readNumber(value, "rawBytes");
  const outputBytes = readNumber(value, "outputBytes");
  const latencyMs = readNumber(value, "latencyMs");
  const compressionRatio = readNumber(value, "compressionRatio");
  if (!variant || (status !== "ok" && status !== "skipped" && status !== "failed" && status !== "fallback") || !rawHash || rawBytes === undefined || outputBytes === undefined || latencyMs === undefined || compressionRatio === undefined) {
    return undefined;
  }
  const result: EvalVariantResult = { variant, status, rawHash, rawBytes, outputBytes, latencyMs, compressionRatio };
  const outputText = readString(value, "outputText");
  const reason = readString(value, "reason");
  const model = parseModel(value.model);
  const summaryBytes = readNumber(value, "summaryBytes");
  const validationOk = readBoolean(value, "validationOk");
  if (outputText !== undefined) result.outputText = outputText;
  if (reason !== undefined) result.reason = reason;
  if (model) result.model = model;
  if (summaryBytes !== undefined) result.summaryBytes = summaryBytes;
  if (validationOk !== undefined) result.validationOk = validationOk;
  return result;
}

function parseVariants(value: unknown): EvalVariantId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants: EvalVariantId[] = [];
  for (const item of value) {
    const variant = parseVariant(item);
    if (!variant) return undefined;
    variants.push(variant);
  }
  return variants;
}

function parseVariant(value: unknown): EvalVariantId | undefined {
  return value === "raw-full" || value === "raw-truncated" || value === "head-tail" || value === "distill-spark" ? value : undefined;
}

function parseModel(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const provider = readString(value, "provider");
  const modelId = readString(value, "modelId");
  return provider && modelId ? { provider, modelId } : undefined;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
}

function parseJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  return parsed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function defaultIO(): EvalCliIO {
  return {
    cwd: process.cwd(),
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
  };
}

function helpText(): string {
  return [
    "Tool distill transcript eval harness",
    "",
    "Commands:",
    "  scan   --sessions-root <path> --out <dir> --threshold <bytes> [--sample N]",
    "  run    --out <dir> [--sample N] [--live --model provider/modelId]",
    "  report --out <dir> [--run path/to/run.json]",
    "  synthetic --out <dir>",
    "",
    `Defaults: --sessions-root ${join(homedir(), ".pi", "agent", "sessions")}, --out ${DEFAULT_EVAL_ROOT}`,
    "Offline runs never call a model; distill-spark is skipped unless cached summaries exist.",
  ].join("\n");
}
