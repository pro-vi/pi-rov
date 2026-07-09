import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureManifest } from "../src/eval/fixtures.js";
import { replayFixtureVariant, scoreReplayAnswer } from "../src/eval/replay.js";
import type { EvalFact, EvalFixtureManifest, EvalVariantResult, TranscriptCandidate } from "../src/eval/types.js";

void test("replayFixtureVariant succeeds when model identifies the same failing file", async () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42")]);
  const variant = variantResult("The test failed at src/foo.test.ts:42.");

  const result = await replayFixtureVariant(fixture, variant, {
    live: true,
    invoke: async () => "Inspect src/foo.test.ts:42 and rerun npm test.",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.success, true);
  assert.match(result.reason, /retained all/);
});

void test("replay scoring accepts distill_expand when hidden evidence is missing", () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42")]);
  const variant = variantResult("The output says a test failed, but exact paths were omitted.");

  const score = scoreReplayAnswer("Call distill_expand with tail mode to recover the exact failing file.", fixture, variant);

  assert.equal(score.success, true);
  assert.match(score.reason, /requested expansion/);
});

void test("replayFixtureVariant skips cleanly without live model access", async () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42")]);
  const variant = variantResult("src/foo.test.ts:42 failed");

  const result = await replayFixtureVariant(fixture, variant);

  assert.equal(result.status, "skipped");
  assert.equal(result.success, false);
  assert.match(result.reason, /requires --live/);
});

void test("replayFixtureVariant records model errors as failed outcomes", async () => {
  const fixture = fixtureWithFacts([fact("line-ref", "src/foo.test.ts:42")]);
  const variant = variantResult("src/foo.test.ts:42 failed");

  const result = await replayFixtureVariant(fixture, variant, {
    live: true,
    invoke: async () => {
      throw new Error("model unavailable");
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.reason, /model unavailable/);
});

function fixtureWithFacts(facts: EvalFact[]): EvalFixtureManifest {
  const rawText = `${"x".repeat(1_000)}\nsrc/foo.test.ts:42`;
  const candidate: TranscriptCandidate = {
    id: "abcdef0123456789abcd",
    sessionPath: "/tmp/session.jsonl",
    lineNumber: 1,
    entryId: "entry-1",
    parentId: null,
    role: "bashExecution",
    toolName: "bash",
    input: { command: "npm test" },
    rawText,
    rawHash: "hash",
    textBytes: Buffer.byteLength(rawText, "utf-8"),
    lineCount: rawText.split("\n").length,
    productionEligible: true,
  };
  return createFixtureManifest(candidate, facts, "/tmp/raw.txt", () => new Date("2026-05-25T00:00:00.000Z"));
}

function fact(type: EvalFact["type"], value: string): EvalFact {
  return {
    id: `${type}-${value}`,
    type,
    value,
    normalizedValue: value.toLowerCase(),
    confidence: 0.9,
    rawOccurrences: 1,
    laterOccurrences: 1,
    source: "raw-reused-later",
  };
}

function variantResult(outputText: string): EvalVariantResult {
  return {
    variant: "distill-spark",
    status: "ok",
    rawHash: "hash",
    rawBytes: 1_000,
    outputBytes: Buffer.byteLength(outputText, "utf-8"),
    latencyMs: 1,
    compressionRatio: Buffer.byteLength(outputText, "utf-8") / 1_000,
    outputText,
  };
}
