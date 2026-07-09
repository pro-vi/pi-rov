import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureManifest } from "../src/eval/fixtures.js";
import { runFixtureVariants, runVariant } from "../src/eval/variants.js";
import type { EvalFixtureManifest, TranscriptCandidate } from "../src/eval/types.js";

const validSummary = [
  "## Outcome",
  "Tests failed.",
  "## Verbatim evidence",
  "src/foo.test.ts:42 expected 1 got 2",
  "## Omitted",
  "Repeated logs.",
  "## Uncertainty",
  "No uncertainty.",
].join("\n");

void test("deterministic variants produce bounded text and metrics", async () => {
  const rawText = `${"head\n".repeat(2_000)}src/foo.test.ts:42 expected 1 got 2\n${"tail\n".repeat(2_000)}`;
  const fixture = fixtureForRaw(rawText);

  const rawFull = await runVariant("raw-full", fixture, rawText);
  const truncated = await runVariant("raw-truncated", fixture, rawText, { truncationChars: 1_000 });
  const headTail = await runVariant("head-tail", fixture, rawText, { headTailChars: 1_000 });
  const distillSkipped = await runVariant("distill-spark", fixture, rawText);

  assert.equal(rawFull.outputText, rawText);
  assert.ok(truncated.outputBytes < rawFull.outputBytes);
  assert.match(truncated.outputText ?? "", /raw truncated/);
  assert.ok(headTail.outputBytes < rawFull.outputBytes);
  assert.match(headTail.outputText ?? "", /head-tail/);
  assert.equal(distillSkipped.status, "skipped");
});

void test("live distill variant records model, validation, latency, and summary bytes", async () => {
  const rawText = `${"x".repeat(20_000)}\nsrc/foo.test.ts:42 expected 1 got 2`;
  const fixture = fixtureForRaw(rawText);

  const result = await runVariant("distill-spark", fixture, rawText, {
    live: true,
    model: { provider: "test", modelId: "spark" },
    invokeDistillModel: async () => validSummary,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.model?.provider, "test");
  assert.equal(result.validationOk, true);
  assert.ok((result.summaryBytes ?? 0) > 0);
  assert.match(result.outputText ?? "", /tool-distill: distilled bash result/);
  assert.ok(result.latencyMs >= 0);
});

void test("distill model failure records fallback instead of throwing", async () => {
  const rawText = `${"x".repeat(20_000)}\nFAIL`;
  const fixture = fixtureForRaw(rawText);

  const result = await runVariant("distill-spark", fixture, rawText, {
    live: true,
    model: { provider: "test", modelId: "spark" },
    invokeDistillModel: async () => {
      throw new Error("auth failed");
    },
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.outputText, rawText);
  assert.match(result.reason ?? "", /auth failed/);
});

void test("runFixtureVariants preserves production eligibility for aggregate filtering", async () => {
  const rawText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n".repeat(200);
  const fixture = fixtureForRaw(rawText, false);

  const result = await runFixtureVariants(fixture, rawText, { variants: ["raw-full"] });

  assert.equal(result.productionEligible, false);
  assert.equal(result.variantResults["raw-full"]?.status, "ok");
});

function fixtureForRaw(rawText: string, productionEligible = true): EvalFixtureManifest {
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
    productionEligible,
  };
  return createFixtureManifest(candidate, [], "/tmp/raw.txt", () => new Date("2026-05-25T00:00:00.000Z"));
}
