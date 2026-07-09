import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { EXPAND_MODES, DEFAULT_DISTILL_MODES, DEFAULT_POLICY_ACTIONS } from "./constants.js";
import type { UsageDelta } from "./usage.js";

export type DistillMode = (typeof DEFAULT_DISTILL_MODES)[number];
export type PolicyAction = (typeof DEFAULT_POLICY_ACTIONS)[number];
export type ExpandMode = (typeof EXPAND_MODES)[number];

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface DistillSettings {
  mode: DistillMode;
  thresholdChars: number;
  maxSummaryChars: number;
  maxExpandChars: number;
  maxModelTokens: number;
  maxSummaryRatio: number;
  model?: ModelRef;
  policies: Record<string, PolicyAction>;
}

export interface DistillMetrics {
  eligible: number;
  distilled: number;
  reduced: number;
  skipped: number;
  fallback: number;
  expanded: number;
  rawBytes: number;
  distilledBytes: number;
  semanticModelCalls: number;
  semanticCacheHits: number;
  semanticCacheMisses: number;
  semanticCacheStale: number;
  semanticCacheInvalid: number;
  semanticCacheErrors: number;
  usageRecordErrors: number;
  lastDecision?: DistillDecisionSnapshot;
}

export type DistillDecisionAction = PolicyAction | "skip" | ObservationMethod;

export interface DistillDecisionSnapshot {
  toolName: string;
  action: DistillDecisionAction;
  reason: string;
  at: number;
  artifactId?: string;
}

export interface ExtractedToolText {
  text: string;
  textBytes: number;
  lineCount: number;
  hasImages: boolean;
  textBlockCount: number;
}

export interface DistillDecision {
  action: PolicyAction;
  reason: string;
  shouldDistill: boolean;
}

export type ArtifactStatus = "raw" | "distilled" | "reduced" | "fallback";
export type ObservationMethod = "semantic" | "semantic-cache" | "reducer";

export interface ArtifactSummarySource {
  kind: "semantic-cache" | "reducer";
  cacheKey?: string;
  sourceArtifactId?: string;
  reducerId?: string;
  previousArtifactId?: string;
  omittedBytes?: number;
}

export interface ObservationArtifact {
  id: string;
  status: ArtifactStatus;
  toolCallId: string;
  toolName: string;
  createdAt: number;
  cwd: string;
  rawPath: string;
  metadataPath: string;
  rawHash: string;
  rawBytes: number;
  rawLines: number;
  inputPreview: string;
  model?: ModelRef;
  method?: ObservationMethod;
  summary?: string;
  summaryBytes?: number;
  compressionRatio?: number;
  summarySource?: ArtifactSummarySource;
  normalizedHash?: string;
  normalizedBytes?: number;
  normalizedLines?: number;
  fallbackReason?: string;
}

export interface ArtifactWriteRequest {
  cwd: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  rawText: string;
}

export interface ArtifactReadResult {
  artifact: ObservationArtifact;
  rawText: string;
}

export interface ArtifactStore {
  writeRaw(request: ArtifactWriteRequest): Promise<ObservationArtifact>;
  update(artifact: ObservationArtifact): Promise<ObservationArtifact>;
  read(id: string): Promise<ArtifactReadResult | undefined>;
  listRecent(limit: number): Promise<ObservationArtifact[]>;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface DistillPromptRequest {
  event: ToolResultEvent;
  artifact: ObservationArtifact;
  rawText: string;
  settings: DistillSettings;
  question: string;
}

export interface DistillRuntimeContext {
  cwd: string;
  sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId"> | undefined;
  modelRegistry?: ExtensionContext["modelRegistry"] | undefined;
  signal?: AbortSignal | undefined;
}

export interface DistillModelRequest {
  modelRef: ModelRef;
  prompt: string;
  settings: DistillSettings;
  ctx: DistillRuntimeContext;
}

export interface DistillModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface DistillModelResult {
  summary: string;
  usage?: DistillModelUsage;
}

export type DistillModelInvoker = (request: DistillModelRequest) => Promise<string | DistillModelResult>;

export interface UsageRecorder {
  record(delta: UsageDelta): void;
  flush(): Promise<void>;
  failureCount(): number;
}

export interface DistillRuntimeOptions {
  store: ArtifactStore;
  summaryCache?: SemanticSummaryCache;
  loadSettings: () => Promise<DistillSettings>;
  invokeModel?: DistillModelInvoker;
  usageRecorder?: UsageRecorder;
  now?: () => number;
}

export interface DistillSelfTestResult {
  success: boolean;
  expandedTailVerified: boolean;
  reason?: string;
  artifactId?: string;
  model?: ModelRef;
  rawBytes?: number;
  rawLines?: number;
}

export interface DistillProcessResult {
  content: TextContent[];
  details: DistillDetails;
}

export interface DistillDetails {
  artifactId: string;
  status: ArtifactStatus;
  rawPath: string;
  rawHash: string;
  rawBytes: number;
  rawLines: number;
  toolName: string;
  model?: ModelRef;
  method?: ObservationMethod;
  compressionRatio?: number;
  summarySource?: ArtifactSummarySource;
  fallbackReason?: string;
}

export interface SemanticSummaryCacheSignature {
  rawHash: string;
  toolName: string;
  inputHash: string;
  questionHash: string;
  promptVersion: number;
  model: ModelRef;
  maxSummaryChars: number;
  maxSummaryRatio: number;
}

export interface SemanticSummaryCacheEntry {
  version: 1;
  key: string;
  signature: SemanticSummaryCacheSignature;
  summary: string;
  summaryBytes: number;
  sourceArtifactId: string;
  model: ModelRef;
  createdAt: string;
}

export type SemanticSummaryCacheLookup =
  | { status: "hit"; entry: SemanticSummaryCacheEntry }
  | { status: "miss" }
  | { status: "stale"; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "error"; reason: string };

export interface SemanticSummaryCache {
  keyFor(signature: SemanticSummaryCacheSignature): string;
  read(signature: SemanticSummaryCacheSignature): Promise<SemanticSummaryCacheLookup>;
  write(entry: SemanticSummaryCacheEntry): Promise<void>;
}

export interface ExpandRequest {
  id: string;
  mode: ExpandMode;
  maxChars: number;
}

export type ToolResultContent = TextContent | ImageContent;

export type ModelLookup = (provider: string, modelId: string) => Model<Api> | undefined;
