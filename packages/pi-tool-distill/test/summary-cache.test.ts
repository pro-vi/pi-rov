import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "../src/artifacts.js";
import { DEFAULT_DISTILL_SETTINGS } from "../src/config.js";
import { DISTILL_PROMPT_VERSION } from "../src/prompts.js";
import { buildSemanticCacheSignature, createSummaryCache, createSummaryCacheEntry, stableInputHash } from "../src/summary-cache.js";
import type { DistillSettings, ModelRef, SemanticSummaryCacheSignature } from "../src/types.js";

const model: ModelRef = { provider: "openai-codex", modelId: "spark" };

void test("summary cache writes and reads a validated signature hit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-summary-cache-"));
  const cache = createSummaryCache("/tmp/project", { baseDir: dir, now: () => new Date("2026-01-01T00:00:00.000Z") });
  const signature = signatureFor({ input: { command: "npm test", env: { A: "1" } } });
  const key = cache.keyFor(signature);

  await cache.write(createSummaryCacheEntry({ key, signature, summary: validSummary(), sourceArtifactId: "aaaaaaaaaaaaaaaaaaaa", now: () => new Date("2026-01-01T00:00:00.000Z") }));
  const hit = await cache.read(signature);

  assert.equal(hit.status, "hit");
  if (hit.status === "hit") {
    assert.equal(hit.entry.key, key);
    assert.equal(hit.entry.summary, validSummary());
    assert.equal(hit.entry.sourceArtifactId, "aaaaaaaaaaaaaaaaaaaa");
    assert.equal(hit.entry.summaryBytes, Buffer.byteLength(validSummary(), "utf-8"));
  }

  await rm(dir, { recursive: true, force: true });
});

void test("summary cache signature changes miss instead of reusing a summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-summary-cache-"));
  const cache = createSummaryCache("/tmp/project", { baseDir: dir });
  const original = signatureFor({ question: "What failed?" });
  const changedQuestion = signatureFor({ question: "What files are listed?" });

  await cache.write(createSummaryCacheEntry({ key: cache.keyFor(original), signature: original, summary: validSummary(), sourceArtifactId: "bbbbbbbbbbbbbbbbbbbb" }));
  const miss = await cache.read(changedQuestion);

  assert.equal(miss.status, "miss");

  await rm(dir, { recursive: true, force: true });
});

void test("summary cache uses stable input hashing independent of object key order", () => {
  const left = stableInputHash({ command: "npm test", options: { bail: true, shard: 1 } });
  const right = stableInputHash({ options: { shard: 1, bail: true }, command: "npm test" });

  assert.equal(left, right);
});

void test("summary cache reports corrupt JSON as invalid and signature drift as stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-summary-cache-"));
  const cache = createSummaryCache("/tmp/project", { baseDir: dir });
  const signature = signatureFor();
  const key = cache.keyFor(signature);
  const path = join(dir, sha256("/tmp/project").slice(0, 16), "summary-cache", `${key}.json`);
  await mkdir(join(dir, sha256("/tmp/project").slice(0, 16), "summary-cache"), { recursive: true });

  await writeFile(path, "{not json", "utf-8");
  assert.equal((await cache.read(signature)).status, "invalid");

  const staleSignature = signatureFor({ maxSummaryChars: 1234 });
  await writeFile(
    path,
    `${JSON.stringify(createSummaryCacheEntry({ key, signature: staleSignature, summary: validSummary(), sourceArtifactId: "cccccccccccccccccccc" }), null, 2)}\n`,
    "utf-8",
  );
  assert.equal((await cache.read(signature)).status, "stale");

  await rm(dir, { recursive: true, force: true });
});

function signatureFor(overrides: { input?: Record<string, unknown>; question?: string; maxSummaryChars?: number } = {}): SemanticSummaryCacheSignature {
  const settings: DistillSettings = {
    ...DEFAULT_DISTILL_SETTINGS,
    model,
    maxSummaryChars: overrides.maxSummaryChars ?? DEFAULT_DISTILL_SETTINGS.maxSummaryChars,
  };
  return buildSemanticCacheSignature({
    rawHash: sha256("raw output"),
    toolName: "bash",
    input: overrides.input ?? { command: "npm test" },
    question: overrides.question ?? "What failed?",
    promptVersion: DISTILL_PROMPT_VERSION,
    model,
    settings,
  });
}

function validSummary(): string {
  return [
    "## Outcome",
    "Tests failed.",
    "## Verbatim evidence",
    "src/foo.test.ts:42 TimeoutError",
    "## Omitted",
    "Passing tests.",
    "## Uncertainty",
    "No uncertainty.",
  ].join("\n");
}
