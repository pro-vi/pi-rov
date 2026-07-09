import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactStore, markDistilled, markDistilledFromCache, markFallback, markReduced, sha256 } from "../src/artifacts.js";

void test("writeRaw persists raw output and metadata with stable hash id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });

  const first = await store.writeRaw({
    cwd: "/tmp/project",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "npm test" },
    rawText: "FAIL test\nexpected 1 got 2",
  });
  const second = await store.writeRaw({
    cwd: "/tmp/project",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "npm test" },
    rawText: "FAIL test\nexpected 1 got 2",
  });

  assert.equal(first.id, second.id);
  assert.equal(first.rawHash, sha256("FAIL test\nexpected 1 got 2"));
  assert.equal(first.normalizedHash, sha256("FAIL test\nexpected 1 got 2"));
  assert.equal(await readFile(first.rawPath, "utf-8"), "FAIL test\nexpected 1 got 2");

  const found = await store.read(first.id);
  assert.equal(found?.artifact.id, first.id);
  assert.equal(found?.rawText, "FAIL test\nexpected 1 got 2");

  await rm(dir, { recursive: true, force: true });
});

void test("writeRaw stores normalized fingerprints for safe reducers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });

  const artifact = await store.writeRaw({
    cwd: "/tmp/project",
    toolCallId: "call-normalized",
    toolName: "bash",
    input: {},
    rawText: "\u001B[31mFAIL\u001B[0m\r\nline with spaces   \r\n",
  });

  assert.equal(artifact.normalizedHash, sha256("FAIL\nline with spaces"));
  assert.equal(artifact.normalizedBytes, Buffer.byteLength("FAIL\nline with spaces", "utf-8"));
  assert.equal(artifact.normalizedLines, 2);

  const found = await store.read(artifact.id);
  assert.equal(found?.artifact.normalizedHash, artifact.normalizedHash);

  await rm(dir, { recursive: true, force: true });
});

void test("update stores distilled and fallback metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });
  const artifact = await store.writeRaw({
    cwd: "/tmp/project",
    toolCallId: "call-2",
    toolName: "bash",
    input: { command: "npm test" },
    rawText: "a".repeat(1000),
  });

  const distilled = await store.update(markDistilled(artifact, "short summary", { provider: "openai-codex", modelId: "spark" }));
  const foundDistilled = await store.read(distilled.id);
  assert.equal(foundDistilled?.artifact.status, "distilled");
  assert.equal(foundDistilled?.artifact.method, "semantic");
  assert.equal(foundDistilled?.artifact.summary, "short summary");

  const fallback = await store.update(markFallback(distilled, "summary rejected"));
  const foundFallback = await store.read(fallback.id);
  assert.equal(foundFallback?.artifact.status, "fallback");
  assert.equal(foundFallback?.artifact.fallbackReason, "summary rejected");
  assert.equal(foundFallback?.artifact.summary, undefined);
  assert.equal(foundFallback?.artifact.summaryBytes, undefined);
  assert.equal(foundFallback?.artifact.compressionRatio, undefined);
  assert.equal(foundFallback?.artifact.method, undefined);

  await rm(dir, { recursive: true, force: true });
});

void test("update stores reduced and semantic-cache metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });
  const artifact = await store.writeRaw({
    cwd: "/tmp/project",
    toolCallId: "call-2b",
    toolName: "bash",
    input: { command: "npm test" },
    rawText: "a".repeat(2000),
  });

  const reduced = await store.update(markReduced(artifact, "reduced summary", { reducerId: "normalized-duplicate", previousArtifactId: "abcdefabcdefabcdefab", omittedBytes: 1900 }));
  const foundReduced = await store.read(reduced.id);
  assert.equal(foundReduced?.artifact.status, "reduced");
  assert.equal(foundReduced?.artifact.method, "reducer");
  assert.equal(foundReduced?.artifact.summary, "reduced summary");
  assert.equal(foundReduced?.artifact.summarySource?.reducerId, "normalized-duplicate");
  assert.equal(foundReduced?.artifact.summarySource?.previousArtifactId, "abcdefabcdefabcdefab");

  const cached = await store.update(
    markDistilledFromCache(artifact, "cached summary", { provider: "openai-codex", modelId: "spark" }, { cacheKey: "cache-key", sourceArtifactId: "12345123451234512345" }),
  );
  const foundCached = await store.read(cached.id);
  assert.equal(foundCached?.artifact.status, "distilled");
  assert.equal(foundCached?.artifact.method, "semantic-cache");
  assert.equal(foundCached?.artifact.summarySource?.cacheKey, "cache-key");
  assert.equal(foundCached?.artifact.summarySource?.sourceArtifactId, "12345123451234512345");

  await rm(dir, { recursive: true, force: true });
});

void test("read ignores status-inconsistent metadata fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });
  const artifact = await store.writeRaw({
    cwd: "/tmp/project",
    toolCallId: "call-3",
    toolName: "bash",
    input: {},
    rawText: "raw",
  });
  await writeFile(
    artifact.metadataPath,
    `${JSON.stringify({ ...artifact, status: "raw", summary: "stale", summaryBytes: 5, compressionRatio: 0.5, fallbackReason: "stale" })}\n`,
    "utf-8",
  );

  const found = await store.read(artifact.id);
  assert.equal(found?.artifact.status, "raw");
  assert.equal(found?.artifact.summary, undefined);
  assert.equal(found?.artifact.summaryBytes, undefined);
  assert.equal(found?.artifact.compressionRatio, undefined);
  assert.equal(found?.artifact.fallbackReason, undefined);

  await rm(dir, { recursive: true, force: true });
});

void test("read rejects distilled or reduced metadata without a summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });
  const artifact = await store.writeRaw({ cwd: "/tmp/project", toolCallId: "missing-summary", toolName: "bash", input: {}, rawText: "raw" });

  await writeFile(artifact.metadataPath, `${JSON.stringify({ ...artifact, status: "distilled", method: "semantic" })}\n`, "utf-8");
  assert.equal(await store.read(artifact.id), undefined);

  await rm(dir, { recursive: true, force: true });
});

void test("read normalizes inconsistent method and summary source metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });
  const artifact = await store.writeRaw({ cwd: "/tmp/project", toolCallId: "inconsistent-method", toolName: "bash", input: {}, rawText: "raw" });

  await writeFile(
    artifact.metadataPath,
    `${JSON.stringify({ ...artifact, status: "distilled", method: "semantic-cache", summary: "short", summaryBytes: 5, compressionRatio: 0.5 })}\n`,
    "utf-8",
  );
  assert.equal((await store.read(artifact.id))?.artifact.method, undefined);

  await writeFile(
    artifact.metadataPath,
    `${JSON.stringify({ ...artifact, status: "distilled", summary: "short", summaryBytes: 5, compressionRatio: 0.5, summarySource: { kind: "semantic-cache", cacheKey: "cache", sourceArtifactId: "old" } })}\n`,
    "utf-8",
  );
  assert.equal((await store.read(artifact.id))?.artifact.method, "semantic-cache");

  await rm(dir, { recursive: true, force: true });
});

void test("read ignores unknown status and method values safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => 123 });
  const artifact = await store.writeRaw({ cwd: "/tmp/project", toolCallId: "unknown", toolName: "bash", input: {}, rawText: "raw" });

  await writeFile(artifact.metadataPath, `${JSON.stringify({ ...artifact, status: "mystery" })}\n`, "utf-8");
  assert.equal(await store.read(artifact.id), undefined);

  await writeFile(artifact.metadataPath, `${JSON.stringify({ ...artifact, status: "distilled", method: "mystery", summary: "short", summaryBytes: 5 })}\n`, "utf-8");
  const found = await store.read(artifact.id);
  assert.equal(found?.artifact.status, "distilled");
  assert.equal(found?.artifact.method, undefined);

  await rm(dir, { recursive: true, force: true });
});

void test("listRecent returns newest artifacts first and unknown ids are safe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-artifacts-"));
  let current = 100;
  const store = createArtifactStore("/tmp/project", { baseDir: dir, now: () => current });
  await store.writeRaw({ cwd: "/tmp/project", toolCallId: "a", toolName: "bash", input: {}, rawText: "one" });
  current = 200;
  await store.writeRaw({ cwd: "/tmp/project", toolCallId: "b", toolName: "bash", input: {}, rawText: "two" });

  const recent = await store.listRecent(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]?.toolCallId, "b");
  assert.equal(await store.read("../../bad"), undefined);

  await rm(dir, { recursive: true, force: true });
});
