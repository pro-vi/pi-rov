import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { markDistilled } from "../artifacts.js";
import { DEFAULT_DISTILL_SETTINGS } from "../config.js";
import { buildObservationCard, selectRawText } from "../content.js";
import { buildDistillPrompt, synthesizeQuestion } from "../prompts.js";
import { validateSummary } from "../validation.js";
import type { DistillSettings, ModelRef, ObservationArtifact } from "../types.js";
import { EVAL_VARIANT_IDS, type EvalFixtureManifest, type EvalFixtureResult, type EvalVariantId, type EvalVariantResult } from "./types.js";

export interface EvalDistillModelRequest {
  modelRef: ModelRef;
  prompt: string;
  settings: DistillSettings;
}

export type EvalDistillModelInvoker = (request: EvalDistillModelRequest) => Promise<string>;

export interface EvalVariantOptions {
  variants?: EvalVariantId[];
  truncationChars?: number;
  headTailChars?: number;
  live?: boolean;
  model?: ModelRef;
  invokeDistillModel?: EvalDistillModelInvoker;
  now?: () => number;
}

const DEFAULT_TRUNCATION_CHARS = 50_000;
const DEFAULT_HEAD_TAIL_CHARS = 8_000;

export async function runFixtureVariants(
  fixture: EvalFixtureManifest,
  rawText: string,
  options: EvalVariantOptions = {},
): Promise<EvalFixtureResult> {
  const variants = options.variants ?? [...EVAL_VARIANT_IDS];
  const variantResults: Partial<Record<EvalVariantId, EvalVariantResult>> = {};
  for (const variant of variants) {
    variantResults[variant] = await runVariant(variant, fixture, rawText, options);
  }
  return {
    fixtureId: fixture.id,
    rawHash: fixture.rawHash,
    toolName: fixture.toolName,
    scoreable: fixture.scoreable,
    productionEligible: fixture.productionEligible,
    variantResults,
  };
}

export async function runVariant(
  variant: EvalVariantId,
  fixture: EvalFixtureManifest,
  rawText: string,
  options: EvalVariantOptions = {},
): Promise<EvalVariantResult> {
  const now = options.now ?? Date.now;
  const started = now();
  if (variant === "raw-full") {
    return finishTextVariant(variant, fixture, rawText, rawText, started, now());
  }
  if (variant === "raw-truncated") {
    const output = selectRawText(rawText, "raw", options.truncationChars ?? DEFAULT_TRUNCATION_CHARS);
    return finishTextVariant(variant, fixture, rawText, output, started, now());
  }
  if (variant === "head-tail") {
    const output = headTailText(rawText, options.headTailChars ?? DEFAULT_HEAD_TAIL_CHARS);
    return finishTextVariant(variant, fixture, rawText, output, started, now());
  }
  return runDistillVariant(fixture, rawText, options, started, now);
}

function finishTextVariant(
  variant: EvalVariantId,
  fixture: EvalFixtureManifest,
  rawText: string,
  outputText: string,
  started: number,
  ended: number,
): EvalVariantResult {
  const outputBytes = Buffer.byteLength(outputText, "utf-8");
  return {
    variant,
    status: "ok",
    rawHash: fixture.rawHash,
    rawBytes: Buffer.byteLength(rawText, "utf-8"),
    outputBytes,
    latencyMs: Math.max(0, ended - started),
    compressionRatio: rawText.length === 0 ? 0 : outputBytes / Buffer.byteLength(rawText, "utf-8"),
    outputText,
  };
}

async function runDistillVariant(
  fixture: EvalFixtureManifest,
  rawText: string,
  options: EvalVariantOptions,
  started: number,
  now: () => number,
): Promise<EvalVariantResult> {
  const model = options.model ?? fixture.cachedDistill?.model;
  const cachedSummary = fixture.cachedDistill?.summary;
  if (!options.live && !cachedSummary) {
    return skippedDistillResult(fixture, rawText, started, now(), "distill-spark requires --live or a cached distill summary");
  }
  if (!model) {
    return skippedDistillResult(fixture, rawText, started, now(), "distill-spark requires a model");
  }

  const settings = distillEvalSettings(model);
  let summary: string;
  if (cachedSummary !== undefined && !options.live) {
    summary = cachedSummary;
  } else {
    if (!options.invokeDistillModel) {
      return skippedDistillResult(fixture, rawText, started, now(), "live distill requested without a model invoker");
    }
    const prompt = buildDistillPrompt({
      event: fixtureToolEvent(fixture, rawText),
      artifact: fixtureArtifact(fixture),
      rawText,
      settings,
      question: synthesizeQuestion(fixture.toolName, fixture.input),
    });
    try {
      summary = await options.invokeDistillModel({ modelRef: model, prompt, settings });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "distill model failed";
      return fallbackDistillResult(fixture, rawText, started, now(), reason, model);
    }
  }

  const validation = validateSummary(rawText, summary, settings);
  if (!validation.ok) {
    return fallbackDistillResult(fixture, rawText, started, now(), validation.reason ?? "summary rejected", model, false);
  }

  const distilled = markDistilled(fixtureArtifact(fixture), summary.trim(), model);
  const outputText = buildObservationCard(distilled, summary);
  const outputBytes = Buffer.byteLength(outputText, "utf-8");
  const result: EvalVariantResult = {
    variant: "distill-spark",
    status: "ok",
    rawHash: fixture.rawHash,
    rawBytes: Buffer.byteLength(rawText, "utf-8"),
    outputBytes,
    latencyMs: Math.max(0, now() - started),
    compressionRatio: rawText.length === 0 ? 0 : outputBytes / Buffer.byteLength(rawText, "utf-8"),
    outputText,
    model,
    validationOk: true,
  };
  if (distilled.summaryBytes !== undefined) result.summaryBytes = distilled.summaryBytes;
  return result;
}

function skippedDistillResult(fixture: EvalFixtureManifest, rawText: string, started: number, ended: number, reason: string): EvalVariantResult {
  return {
    variant: "distill-spark",
    status: "skipped",
    rawHash: fixture.rawHash,
    rawBytes: Buffer.byteLength(rawText, "utf-8"),
    outputBytes: 0,
    latencyMs: Math.max(0, ended - started),
    compressionRatio: 0,
    reason,
  };
}

function fallbackDistillResult(
  fixture: EvalFixtureManifest,
  rawText: string,
  started: number,
  ended: number,
  reason: string,
  model: ModelRef,
  validationOk = true,
): EvalVariantResult {
  const outputBytes = Buffer.byteLength(rawText, "utf-8");
  return {
    variant: "distill-spark",
    status: "fallback",
    rawHash: fixture.rawHash,
    rawBytes: outputBytes,
    outputBytes,
    latencyMs: Math.max(0, ended - started),
    compressionRatio: outputBytes === 0 ? 0 : 1,
    outputText: rawText,
    reason,
    model,
    validationOk,
  };
}

function headTailText(rawText: string, maxChars: number): string {
  if (rawText.length <= maxChars) {
    return rawText;
  }
  const half = Math.max(1, Math.floor((maxChars - 120) / 2));
  const head = rawText.slice(0, half);
  const tail = rawText.slice(rawText.length - half);
  return [head, `[head-tail: omitted ${rawText.length - head.length - tail.length} chars from middle of ${rawText.length}]`, tail].join("\n");
}

function distillEvalSettings(model: ModelRef): DistillSettings {
  return {
    ...DEFAULT_DISTILL_SETTINGS,
    mode: "force",
    model,
    policies: { ...DEFAULT_DISTILL_SETTINGS.policies, bash: "semantic" },
  };
}

function fixtureToolEvent(fixture: EvalFixtureManifest, rawText: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: fixture.toolName,
    toolCallId: fixture.candidateId,
    input: fixture.input,
    content: [{ type: "text", text: rawText }],
    details: { evalFixtureId: fixture.id },
    isError: false,
  } satisfies ToolResultEvent;
}

function fixtureArtifact(fixture: EvalFixtureManifest): ObservationArtifact {
  return {
    id: fixture.id.slice(0, 20),
    status: "raw",
    toolCallId: fixture.candidateId,
    toolName: fixture.toolName,
    createdAt: Date.parse(fixture.createdAt),
    cwd: fixture.source.cwd ?? "",
    rawPath: fixture.rawTextPath,
    metadataPath: `${fixture.rawTextPath}.metadata.json`,
    rawHash: fixture.rawHash,
    rawBytes: fixture.rawBytes,
    rawLines: fixture.rawLines,
    inputPreview: JSON.stringify(fixture.input).slice(0, 500),
  };
}
