import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createArtifactStore } from "../src/artifacts.js";
import { DEFAULT_DISTILL_SETTINGS } from "../src/config.js";
import { extractToolText } from "../src/content.js";
import { decideDistillation, DistillRuntime } from "../src/runtime.js";
import { createSummaryCache } from "../src/summary-cache.js";
import { createUsageRecorder, createUsageStore } from "../src/usage-store.js";
import type { UsageDelta } from "../src/usage.js";
import type { ArtifactStore, DistillRuntimeContext, DistillSettings, ObservationArtifact, SemanticSummaryCache } from "../src/types.js";

const validSummary = [
  "## Outcome",
  "Tests failed.",
  "## Verbatim evidence",
  "src/foo.test.ts:42 expected 1 got 2",
  "## Omitted",
  "Passing tests and npm progress logs.",
  "## Uncertainty",
  "No uncertainty.",
].join("\n");

function bashEvent(text: string, command = "npm test", toolCallId = "call-runtime"): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: { command },
    content: [{ type: "text", text }],
    details: { code: 1 },
    isError: false,
  } as ToolResultEvent;
}

function readEvent(text: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: "call-read",
    input: { path: "src/foo.ts" },
    content: [{ type: "text", text }],
    details: undefined,
    isError: false,
  } as ToolResultEvent;
}

function context(sessionId = "runtime-session"): DistillRuntimeContext {
  return { cwd: "/tmp/project", sessionManager: { getSessionId: () => sessionId } };
}

function settings(overrides: Partial<DistillSettings> = {}): DistillSettings {
  return {
    ...DEFAULT_DISTILL_SETTINGS,
    mode: "auto",
    thresholdChars: 10,
    model: { provider: "openai-codex", modelId: "gpt-5.3-spark" },
    policies: { ...DEFAULT_DISTILL_SETTINGS.policies, bash: "semantic" },
    ...overrides,
  };
}

void test("decideDistillation respects disabled, exact tools, threshold, and force", () => {
  const large = extractToolText([{ type: "text", text: "x".repeat(100) }]);
  assert.equal(decideDistillation(bashEvent("x".repeat(100)), large, settings({ mode: "off" })).shouldDistill, false);
  assert.equal(decideDistillation(readEvent("x".repeat(100)), large, settings({ mode: "force" })).shouldDistill, false);
  assert.equal(decideDistillation(bashEvent("tiny"), extractToolText([{ type: "text", text: "tiny" }]), settings({ policies: {} })).shouldDistill, false);
  assert.equal(decideDistillation(bashEvent("tiny"), extractToolText([{ type: "text", text: "tiny" }]), settings({ mode: "force", policies: {} })).shouldDistill, true);
});

void test("processToolResult returns a distilled card with raw expansion handle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => validSummary,
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nsrc/foo.test.ts:42 expected 1 got 2`), context());

  assert.ok(result);
  assert.ok(result.content);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /tool-distill: distilled bash result/);
  assert.match(text, /distill_expand/);
  assert.equal(runtime.metrics.distilled, 1);

  const artifactId = readArtifactId(result.details);
  assert.ok(artifactId);
  const expanded = await runtime.expandArtifact({ id: artifactId, mode: "tail", maxChars: 1000 });
  assert.match(expanded.text, /src\/foo\.test\.ts:42/);
  assert.equal(runtime.metrics.expanded, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult emits durable semantic usage with actual card bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const usageRoot = join(dir, "usage-root");
  const usageStore = createUsageStore({ usageRoot });
  const usageRecorder = createUsageRecorder(usageStore);
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => ({ summary: validSummary, usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 } }),
    usageRecorder,
    now: () => 456,
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nsrc/foo.test.ts:42 expected 1 got 2`), context("session-live"));
  await usageRecorder.flush();
  const read = await usageStore.readDeltas();
  const delta = read.deltas[0];

  assert.ok(result);
  assert.ok(delta);
  assert.equal(delta.usageClass, "semantic");
  assert.equal(delta.sessionKey, "session-live");
  assert.equal(delta.semanticModelCalls, 1);
  assert.equal(delta.distillerInputTokensExact, 50);
  assert.equal(delta.distillerOutputTokensExact, 10);
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  assert.equal(delta.visibleBytes, Buffer.byteLength(text, "utf-8"));
  assert.equal(delta.mainBytesDelta, delta.rawBytes - delta.visibleBytes);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult reuses semantic cache for identical raw with a current raw artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  let modelCalls = 0;
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    summaryCache: createSummaryCache("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => {
      modelCalls += 1;
      return validSummary;
    },
  });
  const raw = `${"x".repeat(20_000)}\nsrc/foo.test.ts:42 expected 1 got 2`;

  const first = await runtime.processToolResult(bashEvent(raw, "npm test", "call-first"), context());
  const second = await runtime.processToolResult(bashEvent(raw, "npm test", "call-second"), context());

  const firstId = readArtifactId(first?.details);
  const secondId = readArtifactId(second?.details);
  assert.ok(firstId);
  assert.ok(secondId);
  assert.notEqual(firstId, secondId);
  assert.equal(modelCalls, 1);
  assert.equal(runtime.metrics.semanticCacheHits, 1);
  assert.equal(readStatus(second?.details), "distilled");
  assert.equal(readMethod(second?.details), "semantic-cache");
  const secondText = second?.content?.[0]?.type === "text" ? second.content[0].text : "";
  assert.match(secondText, new RegExp(`^raw: ${secondId}$`, "m"));
  assert.match(secondText, new RegExp(`summary reused from: ${firstId}`));
  const expanded = await runtime.expandArtifact({ id: secondId, mode: "tail", maxChars: 1000 });
  assert.match(expanded.text, /src\/foo\.test\.ts:42/);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult ignores invalid cached summaries and calls the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  let modelCalls = 0;
  const raw = `${"x".repeat(20_000)}\nsrc/foo.test.ts:42 expected 1 got 2`;
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    summaryCache: invalidSummaryCache(),
    loadSettings: async () => settings(),
    invokeModel: async () => {
      modelCalls += 1;
      return validSummary;
    },
  });

  const result = await runtime.processToolResult(bashEvent(raw, "npm test", "call-invalid-cache"), context());

  assert.ok(result);
  assert.equal(modelCalls, 1);
  assert.equal(runtime.metrics.semanticCacheInvalid, 1);
  assert.equal(readMethod(result.details), "semantic");

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult can reduce repeated output without a configured model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  let modelCalls = 0;
  const noModelSettings: DistillSettings = {
    mode: "auto",
    thresholdChars: 10,
    maxSummaryChars: DEFAULT_DISTILL_SETTINGS.maxSummaryChars,
    maxExpandChars: DEFAULT_DISTILL_SETTINGS.maxExpandChars,
    maxModelTokens: DEFAULT_DISTILL_SETTINGS.maxModelTokens,
    maxSummaryRatio: DEFAULT_DISTILL_SETTINGS.maxSummaryRatio,
    policies: { ...DEFAULT_DISTILL_SETTINGS.policies, bash: "semantic" },
  };
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => noModelSettings,
    invokeModel: async () => {
      modelCalls += 1;
      return validSummary;
    },
  });
  const previous = Array.from({ length: 160 }, (_, index) => `line ${index}: repeated prior output`).join("\n");

  const first = await runtime.processToolResult(bashEvent(previous, "npm test", "call-no-model-1"), context());
  const second = await runtime.processToolResult(bashEvent(`${previous}\nFAIL src/foo.test.ts:42 TimeoutError`, "npm test", "call-no-model-2"), context());

  assert.equal(first, undefined);
  assert.ok(second);
  assert.equal(modelCalls, 0);
  assert.equal(runtime.metrics.reduced, 1);
  assert.equal(readStatus(second.details), "reduced");
  assert.equal(readMethod(second.details), "reducer");
  const text = second.content?.[0]?.type === "text" ? second.content[0].text : "";
  assert.match(text, /tool-distill: reduced bash result/);
  assert.match(text, /src\/foo\.test\.ts:42 TimeoutError/);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult treats cache IO errors as non-fatal misses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  let modelCalls = 0;
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    summaryCache: errorSummaryCache(),
    loadSettings: async () => settings(),
    invokeModel: async () => {
      modelCalls += 1;
      return validSummary;
    },
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL`, "npm test", "call-cache-error"), context());

  assert.ok(result);
  assert.equal(modelCalls, 1);
  assert.ok(runtime.metrics.semanticCacheErrors >= 1);
  assert.equal(runtime.metrics.distilled, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult preserves original content when summary validation fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => "please provide command output",
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL`), context());

  assert.ok(result);
  assert.ok(result.content);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /FAIL/);
  assert.match(text, /tool-distill fallback/);
  assert.equal(runtime.metrics.fallback, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("validation-rejected summaries emit spend and fallback usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const usageRoot = join(dir, "usage-root");
  const usageStore = createUsageStore({ usageRoot });
  const usageRecorder = createUsageRecorder(usageStore);
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => ({ summary: "please provide command output", usage: { inputTokens: 5, outputTokens: 2 } }),
    usageRecorder,
  });

  await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL`), context("session-rejected"));
  await usageRecorder.flush();
  const delta = (await usageStore.readDeltas()).deltas[0];

  assert.ok(delta);
  assert.equal(delta.usageClass, "validation-rejected");
  assert.equal(delta.semanticModelCalls, 1);
  assert.equal(delta.fallbackCount, 1);
  assert.equal(delta.validationRejectedCount, 1);
  assert.equal(delta.distillerInputTokensExact, 5);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult preserves original content when distiller throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => {
      throw new Error("auth failed");
    },
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL`), context());

  assert.ok(result);
  assert.ok(result.content);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /FAIL/);
  assert.match(text, /auth failed/);
  assert.equal(runtime.metrics.fallback, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult preserves original content when distilled metadata update fails", async () => {
  const runtime = new DistillRuntime({
    store: updateFailingStore(),
    loadSettings: async () => settings(),
    invokeModel: async () => validSummary,
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL`), context());

  assert.ok(result);
  assert.ok(result.content);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /FAIL/);
  assert.match(text, /distilled metadata update failed/);
  assert.equal(runtime.metrics.distilled, 0);
  assert.equal(runtime.metrics.fallback, 1);
});

void test("processToolResult preserves original content when artifact write fails", async () => {
  const runtime = new DistillRuntime({
    store: failingStore(),
    loadSettings: async () => settings(),
    invokeModel: async () => {
      throw new Error("should not call model after raw write failure");
    },
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL`), context());

  assert.ok(result);
  assert.ok(result.content);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /FAIL/);
  assert.match(text, /raw artifact write failed/);
  assert.equal(runtime.metrics.fallback, 1);
});

void test("runSelfTest succeeds with mocked distiller and verifies raw tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => validSummary,
    now: () => 123,
  });

  const result = await runtime.runSelfTest(context());

  assert.equal(result.success, true);
  assert.equal(result.expandedTailVerified, true);
  assert.match(result.artifactId ?? "", /^[a-f0-9]{20}$/);
  assert.equal(runtime.metrics.distilled, 1);
  assert.equal(runtime.metrics.expanded, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("runSelfTest does not emit durable usage records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const usageStore = createUsageStore({ usageRoot: join(dir, "usage-root") });
  const usageRecorder = createUsageRecorder(usageStore);
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => validSummary,
    usageRecorder,
    now: () => 123,
  });

  const result = await runtime.runSelfTest(context("session-selftest"));
  await usageRecorder.flush();
  const read = await usageStore.readDeltas();

  assert.equal(result.success, true);
  assert.equal(read.deltas.length, 0);

  await rm(dir, { recursive: true, force: true });
});

void test("runSelfTest bypasses semantic cache so each run exercises the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  let modelCalls = 0;
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    summaryCache: createSummaryCache("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => {
      modelCalls += 1;
      return validSummary;
    },
    now: () => 123,
  });

  const first = await runtime.runSelfTest(context());
  const second = await runtime.runSelfTest(context());

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(modelCalls, 2);
  assert.equal(runtime.metrics.semanticModelCalls, 2);
  assert.equal(runtime.metrics.semanticCacheHits, 0);

  await rm(dir, { recursive: true, force: true });
});

void test("runSelfTest reports no configured model without writing artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const noModelSettings: DistillSettings = {
    mode: "auto",
    thresholdChars: 10,
    maxSummaryChars: DEFAULT_DISTILL_SETTINGS.maxSummaryChars,
    maxExpandChars: DEFAULT_DISTILL_SETTINGS.maxExpandChars,
    maxModelTokens: DEFAULT_DISTILL_SETTINGS.maxModelTokens,
    maxSummaryRatio: DEFAULT_DISTILL_SETTINGS.maxSummaryRatio,
    policies: { ...DEFAULT_DISTILL_SETTINGS.policies, bash: "semantic" },
  };
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => noModelSettings,
    invokeModel: async () => validSummary,
  });

  const result = await runtime.runSelfTest(context());

  assert.equal(result.success, false);
  assert.equal(result.artifactId, undefined);
  assert.match(result.reason ?? "", /no distiller model configured/);
  assert.equal(runtime.metrics.eligible, 0);

  await rm(dir, { recursive: true, force: true });
});

void test("runSelfTest reports model failure with a recoverable raw artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => {
      throw new Error("live auth failed");
    },
    now: () => 123,
  });

  const result = await runtime.runSelfTest(context());

  assert.equal(result.success, false);
  assert.equal(result.expandedTailVerified, true);
  assert.match(result.artifactId ?? "", /^[a-f0-9]{20}$/);
  assert.match(result.reason ?? "", /live auth failed/);
  assert.equal(runtime.metrics.fallback, 1);
  assert.equal(runtime.metrics.expanded, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("expandArtifact emits a live expansion usage record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const usageStore = createUsageStore({ usageRoot: join(dir, "usage-root") });
  const usageRecorder = createUsageRecorder(usageStore);
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => validSummary,
    usageRecorder,
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL src/foo.test.ts:42`, "npm test", "call-expand-usage"), context("session-expand"));
  const artifactId = readArtifactId(result?.details);
  assert.ok(artifactId);
  await runtime.expandArtifact({ id: artifactId, mode: "tail", maxChars: 500 }, { ctx: context("session-expand") });
  await usageRecorder.flush();
  const deltas = (await usageStore.readDeltas()).deltas;

  assert.equal(deltas.some((delta) => delta.usageClass === "expand"), true);

  await rm(dir, { recursive: true, force: true });
});

void test("expandArtifact reports unknown artifact ids as tool errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => settings(),
    invokeModel: async () => validSummary,
  });

  const expanded = await runtime.expandArtifact({ id: "not-an-artifact", mode: "raw", maxChars: 1000 });
  assert.equal(expanded.isError, true);
  assert.match(expanded.text, /Unknown tool-distill artifact/);

  await rm(dir, { recursive: true, force: true });
});

void test("processToolResult passes through when no model is configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-runtime-"));
  const noModelSettings: DistillSettings = {
    mode: "auto",
    thresholdChars: 10,
    maxSummaryChars: DEFAULT_DISTILL_SETTINGS.maxSummaryChars,
    maxExpandChars: DEFAULT_DISTILL_SETTINGS.maxExpandChars,
    maxModelTokens: DEFAULT_DISTILL_SETTINGS.maxModelTokens,
    maxSummaryRatio: DEFAULT_DISTILL_SETTINGS.maxSummaryRatio,
    policies: { ...DEFAULT_DISTILL_SETTINGS.policies, bash: "semantic" },
  };
  const runtime = new DistillRuntime({
    store: createArtifactStore("/tmp/project", { baseDir: dir }),
    loadSettings: async () => noModelSettings,
    invokeModel: async () => validSummary,
  });

  const result = await runtime.processToolResult(bashEvent(`${"x".repeat(20_000)}\nFAIL`), context());
  assert.equal(result, undefined);
  assert.equal(runtime.metrics.skipped, 1);

  await rm(dir, { recursive: true, force: true });
});

function updateFailingStore(): ArtifactStore {
  return {
    async writeRaw(): Promise<ObservationArtifact> {
      return {
        id: "0123456789abcdef0123",
        status: "raw",
        toolCallId: "call-runtime",
        toolName: "bash",
        createdAt: 123,
        cwd: "/tmp/project",
        rawPath: "/tmp/raw.txt",
        metadataPath: "/tmp/meta.json",
        rawHash: "hash",
        rawBytes: 20_005,
        rawLines: 2,
        inputPreview: "{}",
      };
    },
    async update(): Promise<ObservationArtifact> {
      throw new Error("metadata write failed");
    },
    async read() {
      return undefined;
    },
    async listRecent() {
      return [];
    },
  };
}

function failingStore(): ArtifactStore {
  return {
    async writeRaw(): Promise<ObservationArtifact> {
      throw new Error("disk full");
    },
    async update(artifact: ObservationArtifact): Promise<ObservationArtifact> {
      return artifact;
    },
    async read() {
      return undefined;
    },
    async listRecent() {
      return [];
    },
  };
}

function invalidSummaryCache(): SemanticSummaryCache {
  return {
    keyFor: () => "invalid-summary",
    async read(signature) {
      return {
        status: "hit",
        entry: {
          version: 1,
          key: "invalid-summary",
          signature,
          summary: "not a valid summary",
          summaryBytes: Buffer.byteLength("not a valid summary", "utf-8"),
          sourceArtifactId: "aaaaaaaaaaaaaaaaaaaa",
          model: signature.model,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    },
    async write() {
      return undefined;
    },
  };
}

function errorSummaryCache(): SemanticSummaryCache {
  return {
    keyFor: () => "error-summary",
    async read() {
      return { status: "error", reason: "cache read failed" };
    },
    async write() {
      throw new Error("cache write failed");
    },
  };
}

function readArtifactId(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const distill = details.distill;
  if (!isRecord(distill)) return undefined;
  const artifactId = distill.artifactId;
  return typeof artifactId === "string" ? artifactId : undefined;
}

function readStatus(details: unknown): string | undefined {
  const distill = readDistillRecord(details);
  const status = distill?.status;
  return typeof status === "string" ? status : undefined;
}

function readMethod(details: unknown): string | undefined {
  const distill = readDistillRecord(details);
  const method = distill?.method;
  return typeof method === "string" ? method : undefined;
}

function readDistillRecord(details: unknown): Record<string, unknown> | undefined {
  if (!isRecord(details)) return undefined;
  const distill = details.distill;
  return isRecord(distill) ? distill : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
