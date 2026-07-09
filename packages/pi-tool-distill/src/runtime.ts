import { randomUUID } from "node:crypto";
import { complete, type ProviderStreamOptions } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SEMANTIC_TOOLS, HARD_PASS_TOOLS } from "./constants.js";
import { markDistilled, markDistilledFromCache, markFallback, markReduced, sha256 } from "./artifacts.js";
import {
  appendFallbackNotice,
  buildDistillDetails,
  buildObservationCard,
  extractToolText,
  looksLikeDiff,
  selectRawText,
} from "./content.js";
import { DISTILL_PROMPT_VERSION, buildDistillPrompt, synthesizeQuestion } from "./prompts.js";
import { reduceToolResult, type ReducerCandidate } from "./reducers.js";
import { cwdHashForPath } from "./paths.js";
import { buildSemanticCacheSignature, createSummaryCacheEntry } from "./summary-cache.js";
import {
  makeExpansionUsageDelta,
  makeFallbackUsageDelta,
  makeRawWriteFailedUsageDelta,
  makeReducerUsageDelta,
  makeSemanticCacheUsageDelta,
  makeSemanticUsageDelta,
  makeValidationRejectedUsageDelta,
  type DistillerUsageFields,
  type UsageDelta,
} from "./usage.js";
import { validateSummary } from "./validation.js";
import type {
  ArtifactStore,
  DistillDecision,
  DistillMetrics,
  DistillModelInvoker,
  DistillDetails,
  DistillModelRequest,
  DistillModelResult,
  DistillDecisionAction,
  DistillRuntimeContext,
  DistillRuntimeOptions,
  DistillSelfTestResult,
  DistillSettings,
  ExpandRequest,
  ExtractedToolText,
  ModelRef,
  ObservationArtifact,
  SemanticSummaryCache,
  SemanticSummaryCacheLookup,
  SemanticSummaryCacheSignature,
  ToolResultContent,
  UsageRecorder,
} from "./types.js";

type ToolResultPatch = {
  content?: ToolResultContent[];
  details?: unknown;
  isError?: boolean;
};

interface ProcessToolResultOptions {
  skipSemanticCache?: boolean;
  noEmitUsage?: boolean;
}

interface ExpandArtifactOptions {
  ctx?: DistillRuntimeContext;
  noEmitUsage?: boolean;
}

const SELFTEST_SENTINEL = "TOOL_DISTILL_SELFTEST_SENTINEL raw recovery proof";

export class DistillRuntime {
  readonly metrics: DistillMetrics;
  private readonly store: ArtifactStore;
  private readonly summaryCache: SemanticSummaryCache | undefined;
  private readonly loadSettingsFn: () => Promise<DistillSettings>;
  private readonly invokeModelFn: DistillModelInvoker;
  private readonly usageRecorder: UsageRecorder | undefined;
  private readonly now: () => number;

  constructor(options: DistillRuntimeOptions) {
    this.store = options.store;
    this.summaryCache = options.summaryCache;
    this.loadSettingsFn = options.loadSettings;
    this.invokeModelFn = options.invokeModel ?? invokeConfiguredModel;
    this.usageRecorder = options.usageRecorder;
    this.now = options.now ?? Date.now;
    this.metrics = createDistillMetrics();
  }

  async loadSettings(): Promise<DistillSettings> {
    return this.loadSettingsFn();
  }

  usageRecordErrorCount(): number {
    return this.metrics.usageRecordErrors + (this.usageRecorder?.failureCount() ?? 0);
  }

  async processToolResult(event: ToolResultEvent, ctx: DistillRuntimeContext): Promise<ToolResultPatch | undefined> {
    return this.processToolResultWithSettings(event, ctx, await this.loadSettingsFn());
  }

  async runSelfTest(ctx: DistillRuntimeContext): Promise<DistillSelfTestResult> {
    const settings = await this.loadSettingsFn();
    if (!settings.model) {
      return { success: false, expandedTailVerified: false, reason: "no distiller model configured" };
    }

    const selfTestSettings: DistillSettings = {
      ...settings,
      mode: "force",
      thresholdChars: 500,
      policies: { ...settings.policies, bash: "semantic" },
    };
    const event = buildSelfTestEvent(`tool-distill-selftest-${this.now()}-${randomUUID()}`);
    const patch = await this.processToolResultWithSettings(event, ctx, selfTestSettings, { skipSemanticCache: true, noEmitUsage: true });
    const details = readDistillDetailsFromPatch(patch?.details);
    if (!details) {
      return {
        success: false,
        expandedTailVerified: false,
        model: settings.model,
        reason: this.metrics.lastDecision?.reason ?? "selftest did not create a recoverable artifact",
      };
    }

    const expanded = await this.expandArtifact({ id: details.artifactId, mode: "tail", maxChars: selfTestSettings.maxExpandChars }, { ctx, noEmitUsage: true });
    const expandedTailVerified = expanded.isError !== true && expanded.text.includes(SELFTEST_SENTINEL);
    const success = details.status === "distilled" && details.method === "semantic" && expandedTailVerified;
    const result: DistillSelfTestResult = {
      success,
      expandedTailVerified,
      artifactId: details.artifactId,
      model: settings.model,
      rawBytes: details.rawBytes,
      rawLines: details.rawLines,
    };
    if (!success) {
      result.reason =
        details.fallbackReason ?? (expandedTailVerified ? `selftest ended with status ${details.status} and method ${details.method ?? "unknown"}` : "selftest expansion did not include sentinel");
    }
    return result;
  }

  private async processToolResultWithSettings(
    event: ToolResultEvent,
    ctx: DistillRuntimeContext,
    settings: DistillSettings,
    options: ProcessToolResultOptions = {},
  ): Promise<ToolResultPatch | undefined> {
    const extracted = extractToolText(event.content);
    const decision = decideDistillation(event, extracted, settings);
    this.recordDecision(event.toolName, decision.action, decision.reason);

    if (!decision.shouldDistill) {
      this.metrics.skipped += 1;
      return undefined;
    }

    this.metrics.eligible += 1;
    this.metrics.rawBytes += extracted.textBytes;

    let artifact: ObservationArtifact;
    try {
      artifact = await this.store.writeRaw({
        cwd: ctx.cwd,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        rawText: extracted.text,
      });
    } catch {
      this.metrics.fallback += 1;
      this.recordDecision(event.toolName, "skip", "raw artifact write failed");
      const content = appendFallbackNotice(event.content, "raw artifact write failed");
      this.recordUsage(
        makeRawWriteFailedUsageDelta({
          at: this.now(),
          sessionKey: sessionKeyFromContext(ctx),
          cwdHash: cwdHashForPath(ctx.cwd),
          toolNameHash: hashToolName(event.toolName),
          rawBytes: extracted.textBytes,
          visibleBytes: contentBytes(content),
        }),
        options,
      );
      return { content };
    }

    const question = synthesizeQuestion(event.toolName, event.input);
    const settingsWithModel = settings.model ? { ...settings, model: settings.model } : undefined;
    const cacheSignature = settingsWithModel ? this.buildCacheSignature(event, artifact, settingsWithModel, question) : undefined;
    if (settingsWithModel && cacheSignature && options.skipSemanticCache !== true) {
      const cached = await this.trySemanticCacheHit(event, ctx, artifact, extracted.text, settingsWithModel, cacheSignature, options);
      if (cached) {
        return cached;
      }
    }

    const reducerHit = await this.tryReducerHit(event, ctx, artifact, extracted.text, settingsWithModel !== undefined, options);
    if (reducerHit) {
      return reducerHit;
    }

    if (!settingsWithModel) {
      this.metrics.skipped += 1;
      this.recordDecision(event.toolName, "skip", "no distiller model configured", artifact.id);
      return undefined;
    }

    const prompt = buildDistillPrompt({ event, artifact, rawText: extracted.text, settings, question });

    let summary: string;
    let distillerUsage: DistillerUsageFields;
    this.metrics.semanticModelCalls += 1;
    try {
      const modelResult = normalizeModelResult(await this.invokeModelFn({ modelRef: settingsWithModel.model, prompt, settings, ctx }));
      summary = modelResult.summary;
      distillerUsage = distillerUsageFields(modelResult.usage, prompt, summary);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "distiller model failed";
      const fallback = markFallback(artifact, reason, settingsWithModel.model);
      await this.safeUpdate(fallback);
      this.metrics.fallback += 1;
      this.recordDecision(event.toolName, "skip", reason, artifact.id);
      const content = appendFallbackNotice(event.content, `${reason}; raw saved as ${artifact.id}`);
      this.recordUsage(
        makeFallbackUsageDelta({
          at: this.now(),
          sessionKey: sessionKeyFromContext(ctx),
          cwdHash: cwdHashForPath(ctx.cwd),
          artifactId: artifact.id,
          toolNameHash: hashToolName(event.toolName),
          rawBytes: artifact.rawBytes,
          visibleBytes: contentBytes(content),
          semanticModelCalls: 1,
          failureReason: "model-error",
        }),
        options,
      );
      return {
        content,
        details: mergeDetails(event.details, buildDistillDetails(fallback)),
      };
    }

    const validation = validateSummary(extracted.text, summary, settings);
    if (!validation.ok) {
      const reason = validation.reason ?? "summary rejected";
      const fallback = markFallback(artifact, reason, settingsWithModel.model);
      await this.safeUpdate(fallback);
      this.metrics.fallback += 1;
      this.recordDecision(event.toolName, "skip", reason, artifact.id);
      const content = appendFallbackNotice(event.content, `${reason}; raw saved as ${artifact.id}`);
      this.recordUsage(
        makeValidationRejectedUsageDelta({
          at: this.now(),
          sessionKey: sessionKeyFromContext(ctx),
          cwdHash: cwdHashForPath(ctx.cwd),
          artifactId: artifact.id,
          toolNameHash: hashToolName(event.toolName),
          rawBytes: artifact.rawBytes,
          visibleBytes: contentBytes(content),
          ...distillerUsage,
        }),
        options,
      );
      return {
        content,
        details: mergeDetails(event.details, buildDistillDetails(fallback)),
      };
    }

    const distilled = markDistilled(artifact, summary.trim(), settingsWithModel.model);
    try {
      await this.store.update(distilled);
    } catch {
      const reason = "distilled metadata update failed";
      const fallback = markFallback(artifact, reason, settingsWithModel.model);
      await this.safeUpdate(fallback);
      this.metrics.fallback += 1;
      this.recordDecision(event.toolName, "skip", reason, artifact.id);
      const content = appendFallbackNotice(event.content, `${reason}; raw saved as ${artifact.id}`);
      this.recordUsage(
        makeFallbackUsageDelta({
          at: this.now(),
          sessionKey: sessionKeyFromContext(ctx),
          cwdHash: cwdHashForPath(ctx.cwd),
          artifactId: artifact.id,
          toolNameHash: hashToolName(event.toolName),
          rawBytes: artifact.rawBytes,
          visibleBytes: contentBytes(content),
          semanticModelCalls: 1,
          failureReason: "metadata-update-failed",
          ...distillerUsage,
        }),
        options,
      );
      return {
        content,
        details: mergeDetails(event.details, buildDistillDetails(fallback)),
      };
    }
    await this.safeWriteSummaryCache(cacheSignature, distilled.summary ?? summary.trim(), distilled.id);
    this.metrics.distilled += 1;
    this.metrics.distilledBytes += distilled.summaryBytes ?? 0;
    this.recordDecision(event.toolName, "semantic", "distilled", distilled.id);

    const card = buildObservationCard(distilled, summary);
    this.recordUsage(
      makeSemanticUsageDelta({
        at: this.now(),
        sessionKey: sessionKeyFromContext(ctx),
        cwdHash: cwdHashForPath(ctx.cwd),
        artifactId: distilled.id,
        toolNameHash: hashToolName(event.toolName),
        rawBytes: distilled.rawBytes,
        visibleBytes: Buffer.byteLength(card, "utf-8"),
        ...distillerUsage,
      }),
      options,
    );

    return {
      content: [{ type: "text", text: card }],
      details: mergeDetails(event.details, buildDistillDetails(distilled)),
    };
  }

  async expandArtifact(request: ExpandRequest, options: ExpandArtifactOptions = {}): Promise<{ text: string; details?: unknown; isError?: boolean }> {
    const found = await this.store.read(request.id);
    if (!found) {
      return {
        text: `Unknown tool-distill artifact: ${request.id}`,
        details: { artifactId: request.id, error: "unknown artifact" },
        isError: true,
      };
    }
    this.metrics.expanded += 1;
    this.recordUsage(
      makeExpansionUsageDelta({
        at: this.now(),
        sessionKey: sessionKeyFromContext(options.ctx),
        cwdHash: cwdHashForPath(options.ctx?.cwd ?? found.artifact.cwd),
        artifactId: found.artifact.id,
        expandMode: request.mode,
        maxChars: request.maxChars,
      }),
      options,
    );
    const selected = selectRawText(found.rawText, request.mode, request.maxChars, found.artifact.summary);
    const header = [
      `[tool-distill expand ${found.artifact.id}]`,
      `tool: ${found.artifact.toolName}`,
      `status: ${found.artifact.status}`,
      `rawPath: ${found.artifact.rawPath}`,
      "",
    ].join("\n");
    return {
      text: `${header}${selected}`,
      details: buildDistillDetails(found.artifact),
    };
  }

  async recent(limit = 10): Promise<ObservationArtifact[]> {
    return this.store.listRecent(limit);
  }

  private async trySemanticCacheHit(
    event: ToolResultEvent,
    ctx: DistillRuntimeContext,
    artifact: ObservationArtifact,
    rawText: string,
    settings: DistillSettings & { model: ModelRef },
    signature: SemanticSummaryCacheSignature,
    options: ProcessToolResultOptions,
  ): Promise<ToolResultPatch | undefined> {
    if (!this.summaryCache) {
      return undefined;
    }

    let lookup: SemanticSummaryCacheLookup;
    try {
      lookup = await this.summaryCache.read(signature);
    } catch {
      this.metrics.semanticCacheErrors += 1;
      return undefined;
    }
    if (lookup.status === "miss") {
      this.metrics.semanticCacheMisses += 1;
      return undefined;
    }
    if (lookup.status === "stale") {
      this.metrics.semanticCacheStale += 1;
      return undefined;
    }
    if (lookup.status === "error") {
      this.metrics.semanticCacheErrors += 1;
      return undefined;
    }
    if (lookup.status === "invalid") {
      this.metrics.semanticCacheInvalid += 1;
      return undefined;
    }

    const validation = validateSummary(rawText, lookup.entry.summary, settings);
    if (!validation.ok) {
      this.metrics.semanticCacheInvalid += 1;
      return undefined;
    }

    const cached = markDistilledFromCache(artifact, lookup.entry.summary.trim(), settings.model, {
      cacheKey: lookup.entry.key,
      sourceArtifactId: lookup.entry.sourceArtifactId,
    });
    try {
      await this.store.update(cached);
    } catch {
      const reason = "semantic cache metadata update failed";
      const fallback = markFallback(artifact, reason, settings.model);
      await this.safeUpdate(fallback);
      this.metrics.fallback += 1;
      this.recordDecision(event.toolName, "skip", reason, artifact.id);
      const content = appendFallbackNotice(event.content, `${reason}; raw saved as ${artifact.id}`);
      this.recordUsage(
        makeFallbackUsageDelta({
          at: this.now(),
          sessionKey: sessionKeyFromContext(ctx),
          cwdHash: cwdHashForPath(ctx.cwd),
          artifactId: artifact.id,
          toolNameHash: hashToolName(event.toolName),
          rawBytes: artifact.rawBytes,
          visibleBytes: contentBytes(content),
          failureReason: "metadata-update-failed",
        }),
        options,
      );
      return {
        content,
        details: mergeDetails(event.details, buildDistillDetails(fallback)),
      };
    }

    this.metrics.semanticCacheHits += 1;
    this.metrics.distilled += 1;
    this.metrics.distilledBytes += cached.summaryBytes ?? 0;
    this.recordDecision(event.toolName, "semantic-cache", "semantic cache hit", cached.id);
    const card = buildObservationCard(cached, lookup.entry.summary);
    this.recordUsage(
      makeSemanticCacheUsageDelta({
        at: this.now(),
        sessionKey: sessionKeyFromContext(ctx),
        cwdHash: cwdHashForPath(ctx.cwd),
        artifactId: cached.id,
        toolNameHash: hashToolName(event.toolName),
        rawBytes: cached.rawBytes,
        visibleBytes: Buffer.byteLength(card, "utf-8"),
      }),
      options,
    );
    return {
      content: [{ type: "text", text: card }],
      details: mergeDetails(event.details, buildDistillDetails(cached)),
    };
  }

  private async tryReducerHit(
    event: ToolResultEvent,
    ctx: DistillRuntimeContext,
    artifact: ObservationArtifact,
    rawText: string,
    modelAvailable: boolean,
    options: ProcessToolResultOptions,
  ): Promise<ToolResultPatch | undefined> {
    const candidates = await this.loadReducerCandidates(artifact);
    const hit = reduceToolResult({ current: artifact, rawText, candidates });
    if (!hit) {
      return undefined;
    }
    if (modelAvailable && hit.reducerId === "normalized-duplicate") {
      // Exact repeats are handled by the semantic cache. For normalized-only repeats,
      // prefer one semantic summary over a content-light duplicate pointer when a model is available.
      return undefined;
    }

    const reduced = markReduced(artifact, hit.summary, {
      reducerId: hit.reducerId,
      previousArtifactId: hit.previousArtifactId,
      omittedBytes: hit.omittedBytes,
    });
    try {
      await this.store.update(reduced);
    } catch {
      const reason = "reduced metadata update failed";
      const fallback = markFallback(artifact, reason);
      await this.safeUpdate(fallback);
      this.metrics.fallback += 1;
      this.recordDecision(event.toolName, "skip", reason, artifact.id);
      const content = appendFallbackNotice(event.content, `${reason}; raw saved as ${artifact.id}`);
      this.recordUsage(
        makeFallbackUsageDelta({
          at: this.now(),
          sessionKey: sessionKeyFromContext(ctx),
          cwdHash: cwdHashForPath(ctx.cwd),
          artifactId: artifact.id,
          toolNameHash: hashToolName(event.toolName),
          rawBytes: artifact.rawBytes,
          visibleBytes: contentBytes(content),
          failureReason: "metadata-update-failed",
        }),
        options,
      );
      return {
        content,
        details: mergeDetails(event.details, buildDistillDetails(fallback)),
      };
    }

    this.metrics.reduced += 1;
    this.metrics.distilledBytes += reduced.summaryBytes ?? 0;
    this.recordDecision(event.toolName, "reducer", hit.reducerId, reduced.id);
    const card = buildObservationCard(reduced, hit.summary);
    this.recordUsage(
      makeReducerUsageDelta({
        at: this.now(),
        sessionKey: sessionKeyFromContext(ctx),
        cwdHash: cwdHashForPath(ctx.cwd),
        artifactId: reduced.id,
        toolNameHash: hashToolName(event.toolName),
        rawBytes: reduced.rawBytes,
        visibleBytes: Buffer.byteLength(card, "utf-8"),
      }),
      options,
    );
    return {
      content: [{ type: "text", text: card }],
      details: mergeDetails(event.details, buildDistillDetails(reduced)),
    };
  }

  private async loadReducerCandidates(current: ObservationArtifact): Promise<ReducerCandidate[]> {
    let recent: ObservationArtifact[];
    try {
      recent = await this.store.listRecent(25);
    } catch {
      return [];
    }
    const candidates: ReducerCandidate[] = [];
    for (const artifact of recent) {
      if (artifact.id === current.id || artifact.toolName !== current.toolName) {
        continue;
      }
      try {
        const found = await this.store.read(artifact.id);
        if (found) {
          candidates.push({ artifact: found.artifact, rawText: found.rawText });
        }
      } catch {
        // Reducer lookup is an optimization; stale metadata must not affect the tool result.
      }
    }
    return candidates;
  }

  private buildCacheSignature(event: ToolResultEvent, artifact: ObservationArtifact, settings: DistillSettings & { model: ModelRef }, question: string): SemanticSummaryCacheSignature {
    return buildSemanticCacheSignature({
      rawHash: artifact.rawHash,
      toolName: event.toolName,
      input: event.input,
      question,
      promptVersion: DISTILL_PROMPT_VERSION,
      model: settings.model,
      settings,
    });
  }

  private async safeWriteSummaryCache(signature: SemanticSummaryCacheSignature | undefined, summary: string, sourceArtifactId: string): Promise<void> {
    if (!this.summaryCache || !signature) {
      return;
    }
    try {
      const key = this.summaryCache.keyFor(signature);
      await this.summaryCache.write(createSummaryCacheEntry({ key, signature, summary, sourceArtifactId }));
    } catch {
      this.metrics.semanticCacheErrors += 1;
    }
  }

  private async safeUpdate(artifact: ObservationArtifact): Promise<void> {
    try {
      await this.store.update(artifact);
    } catch {
      // Raw output is already saved; metadata update failure should not hide original tool output.
    }
  }

  private recordUsage(delta: UsageDelta, options: ProcessToolResultOptions | ExpandArtifactOptions): void {
    if (options.noEmitUsage === true || !this.usageRecorder) {
      return;
    }
    try {
      this.usageRecorder.record(delta);
    } catch {
      this.metrics.usageRecordErrors += 1;
    }
  }

  private recordDecision(toolName: string, action: DistillDecisionAction, reason: string, artifactId?: string): void {
    const snapshot = {
      toolName,
      action,
      reason,
      at: this.now(),
    };
    this.metrics.lastDecision = artifactId ? { ...snapshot, artifactId } : snapshot;
  }
}

export function createDistillMetrics(): DistillMetrics {
  return {
    eligible: 0,
    distilled: 0,
    reduced: 0,
    skipped: 0,
    fallback: 0,
    expanded: 0,
    rawBytes: 0,
    distilledBytes: 0,
    semanticModelCalls: 0,
    semanticCacheHits: 0,
    semanticCacheMisses: 0,
    semanticCacheStale: 0,
    semanticCacheInvalid: 0,
    semanticCacheErrors: 0,
    usageRecordErrors: 0,
  };
}

export function decideDistillation(event: ToolResultEvent, extracted: ExtractedToolText, settings: DistillSettings): DistillDecision {
  if (settings.mode === "off") {
    return { action: "pass", reason: "disabled", shouldDistill: false };
  }

  const explicit = settings.policies[event.toolName];
  if (explicit === "pass" || explicit === "deny") {
    return { action: explicit, reason: `policy ${explicit}`, shouldDistill: false };
  }

  if (HARD_PASS_TOOLS.has(event.toolName) && explicit !== "semantic") {
    return { action: "pass", reason: "exactness-sensitive tool", shouldDistill: false };
  }

  if (extracted.hasImages) {
    return { action: "pass", reason: "image content is not supported in V0", shouldDistill: false };
  }

  if (extracted.text.trim().length === 0) {
    return { action: "pass", reason: "no text content", shouldDistill: false };
  }

  if (looksLikeDiff(event.toolName, event.input, extracted.text) && explicit !== "semantic") {
    return { action: "pass", reason: "diff-like output is exactness-sensitive", shouldDistill: false };
  }

  const semanticByDefault = DEFAULT_SEMANTIC_TOOLS.has(event.toolName);
  const semantic = explicit === "semantic" || semanticByDefault || settings.mode === "force";
  if (!semantic) {
    return { action: "pass", reason: "tool not semantic by default", shouldDistill: false };
  }

  if (settings.mode !== "force" && explicit !== "semantic" && extracted.textBytes < settings.thresholdChars) {
    return { action: "pass", reason: "below threshold", shouldDistill: false };
  }

  return { action: "semantic", reason: explicit === "semantic" ? "explicit semantic policy" : "eligible", shouldDistill: true };
}

async function invokeConfiguredModel(request: DistillModelRequest): Promise<DistillModelResult> {
  if (!request.ctx.modelRegistry) {
    throw new Error("distiller model registry unavailable in this runtime context");
  }
  const model = request.ctx.modelRegistry.find(request.modelRef.provider, request.modelRef.modelId);
  if (!model) {
    throw new Error(`distiller model not found: ${formatModelRef(request.modelRef)}`);
  }

  const auth = await request.ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`distiller auth failed: ${auth.error}`);
  }
  if (!auth.apiKey) {
    throw new Error(`no API key for distiller model: ${formatModelRef(request.modelRef)}`);
  }

  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: request.prompt }],
      timestamp: Date.now(),
    },
  ];

  const options: ProviderStreamOptions = {
    apiKey: auth.apiKey,
    maxTokens: request.settings.maxModelTokens,
  };
  if (auth.headers) {
    options.headers = auth.headers;
  }
  if (request.ctx.signal) {
    options.signal = request.ctx.signal;
  }

  const response = await complete(model, { messages }, options);
  const summary = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return {
    summary,
    usage: {
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      costUsd: response.usage.cost.total,
    },
  };
}

function normalizeModelResult(result: string | DistillModelResult): DistillModelResult {
  return typeof result === "string" ? { summary: result } : result;
}

function distillerUsageFields(usage: DistillModelResult["usage"] | undefined, prompt: string, summary: string): DistillerUsageFields {
  if (usage) {
    const fields: DistillerUsageFields = {};
    if (usage.inputTokens !== undefined) fields.distillerInputTokensExact = usage.inputTokens;
    if (usage.outputTokens !== undefined) fields.distillerOutputTokensExact = usage.outputTokens;
    if (usage.costUsd !== undefined) fields.distillerCostUsdExact = usage.costUsd;
    return fields;
  }
  return {
    distillerTokensEstimated: Math.round((Buffer.byteLength(prompt, "utf-8") + Buffer.byteLength(summary, "utf-8")) / 4),
  };
}

function sessionKeyFromContext(ctx: DistillRuntimeContext | undefined): string {
  const getter = ctx?.sessionManager?.getSessionId;
  const sessionId = typeof getter === "function" ? getter.call(ctx?.sessionManager) : undefined;
  return sessionId && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : "sessionless";
}

function hashToolName(toolName: string): string {
  return sha256(toolName).slice(0, 16);
}

function contentBytes(content: ToolResultContent[]): number {
  return content.reduce((total, part) => (part.type === "text" ? total + Buffer.byteLength(part.text, "utf-8") : total), 0);
}

function formatModelRef(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

function buildSelfTestEvent(toolCallId: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: { command: "tool-distill selftest synthetic-output" },
    content: [{ type: "text", text: buildSelfTestRawText() }],
    details: { selftest: true },
    isError: false,
  };
}

function buildSelfTestRawText(): string {
  const logLines = Array.from({ length: 300 }, (_, index) => {
    const padded = String(index + 1).padStart(3, "0");
    return `selftest log ${padded}: repeated output line proving large tool-result compression remains recoverable after distillation.`;
  });
  return [
    "tool-distill selftest synthetic tool output",
    "Expected outcome: distiller creates a compact card with the required sections.",
    "Important evidence: src/selftest.ts:42 simulated failure line for exact path preservation.",
    ...logLines,
    SELFTEST_SENTINEL,
  ].join("\n");
}

function readDistillDetailsFromPatch(value: unknown): DistillDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = readDistillDetailsRecord(value);
  if (direct) {
    return direct;
  }
  return readDistillDetailsRecord(value.distill);
}

function readDistillDetailsRecord(value: unknown): DistillDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const artifactId = value.artifactId;
  const status = value.status;
  const rawPath = value.rawPath;
  const rawHash = value.rawHash;
  const rawBytes = value.rawBytes;
  const rawLines = value.rawLines;
  const toolName = value.toolName;
  if (
    typeof artifactId !== "string" ||
    (status !== "raw" && status !== "distilled" && status !== "reduced" && status !== "fallback") ||
    typeof rawPath !== "string" ||
    typeof rawHash !== "string" ||
    typeof rawBytes !== "number" ||
    typeof rawLines !== "number" ||
    typeof toolName !== "string"
  ) {
    return undefined;
  }
  const details: DistillDetails = { artifactId, status, rawPath, rawHash, rawBytes, rawLines, toolName };
  if (value.method === "semantic" || value.method === "semantic-cache" || value.method === "reducer") details.method = value.method;
  if (typeof value.compressionRatio === "number") details.compressionRatio = value.compressionRatio;
  if (typeof value.fallbackReason === "string") details.fallbackReason = value.fallbackReason;
  return details;
}

function mergeDetails(existing: unknown, distill: unknown): unknown {
  if (isRecord(existing)) {
    return { ...existing, distill };
  }
  return { distill };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
