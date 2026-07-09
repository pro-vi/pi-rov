import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createArtifactStore } from "../artifacts.js";
import { DEFAULT_DISTILL_SETTINGS } from "../config.js";
import { extractToolText } from "../content.js";
import { DistillRuntime } from "../runtime.js";
import { createSummaryCache } from "../summary-cache.js";
import type { DistillRuntimeContext, DistillSettings, ModelRef } from "../types.js";
import { SYNTHETIC_EVAL_RUN_VERSION, type SyntheticEvalCaseResult, type SyntheticEvalRunResult } from "./types.js";

export interface SyntheticEvalOptions {
  artifactBaseDir: string;
  now?: () => number;
}

interface SyntheticCaseDefinition {
  id: string;
  title: string;
  events: ToolResultEvent[];
  settings: DistillSettings;
  requiredFacts: string[];
}

const SYNTHETIC_MODEL: ModelRef = { provider: "synthetic", modelId: "distill-spark" };
const FACT = "src/foo.test.ts:42 TimeoutError";

export async function runSyntheticEval(options: SyntheticEvalOptions): Promise<SyntheticEvalRunResult> {
  const startedAt = options.now?.() ?? Date.now();
  const cases: SyntheticEvalCaseResult[] = [];
  for (const definition of syntheticCases()) {
    cases.push(await runSyntheticCase(definition, options));
  }
  return {
    version: SYNTHETIC_EVAL_RUN_VERSION,
    id: `synthetic-${startedAt}`,
    createdAt: new Date(startedAt).toISOString(),
    cases,
    totals: summarizeCases(cases),
  };
}

function syntheticCases(): SyntheticCaseDefinition[] {
  const largeRaw = `${"noise ".repeat(4_000)}\n${FACT}\n${"more noise\n".repeat(600)}`;
  const appendBase = Array.from({ length: 180 }, (_, index) => `test log ${index}: repeated setup output`).join("\n");
  return [
    {
      id: "exact-duplicate-cache",
      title: "Exact duplicate semantic cache hit",
      events: [bashEvent("dup-1", "npm test", largeRaw), bashEvent("dup-2", "npm test", largeRaw)],
      settings: modelSettings(),
      requiredFacts: [FACT],
    },
    {
      id: "append-only-reducer",
      title: "Append-only safe reducer without model",
      events: [bashEvent("append-1", "npm test", appendBase), bashEvent("append-2", "npm test", `${appendBase}\n${FACT}`)],
      settings: noModelSettings(),
      requiredFacts: [FACT],
    },
    {
      id: "same-raw-different-question",
      title: "Same raw output with a changed question",
      events: [bashEvent("question-1", "npm test", largeRaw), bashEvent("question-2", "rg TimeoutError", largeRaw)],
      settings: modelSettings(),
      requiredFacts: [FACT],
    },
  ];
}

async function runSyntheticCase(definition: SyntheticCaseDefinition, options: SyntheticEvalOptions): Promise<SyntheticEvalCaseResult> {
  let modelCalls = 0;
  const storeOptions = options.now ? { baseDir: options.artifactBaseDir, now: options.now } : { baseDir: options.artifactBaseDir };
  const runtimeOptions = {
    store: createArtifactStore(`/tmp/tool-distill-synthetic/${definition.id}`, storeOptions),
    summaryCache: createSummaryCache(`/tmp/tool-distill-synthetic/${definition.id}`, { baseDir: options.artifactBaseDir }),
    loadSettings: async () => definition.settings,
    invokeModel: async () => {
      modelCalls += 1;
      return validSyntheticSummary();
    },
  };
  const runtime = new DistillRuntime(options.now ? { ...runtimeOptions, now: options.now } : runtimeOptions);

  const started = options.now?.() ?? Date.now();
  let rawBytes = 0;
  let outputBytes = 0;
  const visibleOutputs: string[] = [];
  const ctx = syntheticContext();
  for (const event of definition.events) {
    const rawText = extractToolText(event.content).text;
    rawBytes += Buffer.byteLength(rawText, "utf-8");
    const patch = await runtime.processToolResult(event, ctx);
    const visibleText = patch?.content ? extractToolText(patch.content).text : rawText;
    visibleOutputs.push(visibleText);
    outputBytes += Buffer.byteLength(visibleText, "utf-8");
  }
  const retainedFacts = definition.requiredFacts.filter((fact) => visibleOutputs.some((text) => text.includes(fact))).length;
  const retention = definition.requiredFacts.length === 0 ? null : retainedFacts / definition.requiredFacts.length;
  return {
    id: definition.id,
    title: definition.title,
    rawBytes,
    outputBytes,
    bytesSaved: Math.max(0, rawBytes - outputBytes),
    compressionRatio: rawBytes === 0 ? 0 : outputBytes / rawBytes,
    latencyMs: Math.max(0, (options.now?.() ?? Date.now()) - started),
    modelCalls,
    modelCallsSkipped: runtime.metrics.semanticCacheHits + runtime.metrics.reduced,
    cacheHits: runtime.metrics.semanticCacheHits,
    reducerHits: runtime.metrics.reduced,
    requiredFacts: definition.requiredFacts,
    retainedFacts,
    retention,
    expansionNeeded: retention !== null && retention < 1,
  };
}

function summarizeCases(cases: SyntheticEvalCaseResult[]): SyntheticEvalRunResult["totals"] {
  const quality = cases.filter((item) => item.retention !== null);
  return {
    rawBytes: sum(cases.map((item) => item.rawBytes)),
    outputBytes: sum(cases.map((item) => item.outputBytes)),
    bytesSaved: sum(cases.map((item) => item.bytesSaved)),
    modelCalls: sum(cases.map((item) => item.modelCalls)),
    modelCallsSkipped: sum(cases.map((item) => item.modelCallsSkipped)),
    cacheHits: sum(cases.map((item) => item.cacheHits)),
    reducerHits: sum(cases.map((item) => item.reducerHits)),
    averageRetention: average(quality.map((item) => item.retention).filter(isNumber)),
    expansionNeededRate: quality.length === 0 ? null : quality.filter((item) => item.expansionNeeded).length / quality.length,
  };
}

function modelSettings(): DistillSettings {
  return {
    ...DEFAULT_DISTILL_SETTINGS,
    mode: "auto",
    thresholdChars: 10,
    model: SYNTHETIC_MODEL,
    policies: { ...DEFAULT_DISTILL_SETTINGS.policies, bash: "semantic" },
  };
}

function noModelSettings(): DistillSettings {
  const { model: _model, ...settings } = modelSettings();
  return settings;
}

function bashEvent(toolCallId: string, command: string, text: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: { command },
    content: [{ type: "text", text }],
    details: { synthetic: true },
    isError: command.includes("test"),
  } satisfies ToolResultEvent;
}

function validSyntheticSummary(): string {
  return [
    "## Outcome",
    "Synthetic command output contains the required failure evidence.",
    "## Verbatim evidence",
    FACT,
    "## Omitted",
    "Repeated synthetic noise lines.",
    "## Uncertainty",
    "No uncertainty.",
  ].join("\n");
}

function syntheticContext(): DistillRuntimeContext {
  return { cwd: "/tmp/tool-distill-synthetic" };
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

function isNumber(value: number | null): value is number {
  return typeof value === "number";
}
