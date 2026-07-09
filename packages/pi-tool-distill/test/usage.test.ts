import assert from "node:assert/strict";
import test from "node:test";
import {
  makeExpansionUsageDelta,
  makeFallbackUsageDelta,
  makeSemanticUsageDelta,
  makeValidationRejectedUsageDelta,
} from "../src/usage.js";
import { validateUsageDelta } from "../src/usage-store.js";

const BASE = {
  at: 123,
  sessionKey: "session-123",
  cwdHash: "0123456789abcdef",
  artifactId: "0123456789abcdef0123",
  toolNameHash: "abcdef0123456789",
};

void test("semantic usage uses signed raw minus visible bytes", () => {
  const delta = makeSemanticUsageDelta({ ...BASE, rawBytes: 20_000, visibleBytes: 1_000, distillerInputTokensExact: 100, distillerOutputTokensExact: 20 });

  assert.equal(delta.usageClass, "semantic");
  assert.equal(delta.mainBytesDelta, 19_000);
  assert.equal(delta.estimatedMainTokensDelta, 4_750);
  assert.equal(delta.semanticModelCalls, 1);
  assert.equal(delta.distillerInputTokensExact, 100);
  assert.equal(delta.distillerOutputTokensExact, 20);
  assert.deepEqual(validateUsageDelta(delta), delta);
});

void test("forced small distill can record a negative main-context delta", () => {
  const delta = makeSemanticUsageDelta({ ...BASE, rawBytes: 100, visibleBytes: 500 });

  assert.equal(delta.mainBytesDelta, -400);
  assert.equal(delta.estimatedMainTokensDelta, -100);
  assert.deepEqual(validateUsageDelta(delta), delta);
});

void test("validation rejected records model spend, fallback, and no raw text", () => {
  const delta = makeValidationRejectedUsageDelta({ ...BASE, rawBytes: 2_000, visibleBytes: 2_100, distillerTokensEstimated: 900 });

  assert.equal(delta.usageClass, "validation-rejected");
  assert.equal(delta.semanticModelCalls, 1);
  assert.equal(delta.fallbackCount, 1);
  assert.equal(delta.validationRejectedCount, 1);
  assert.equal(delta.failureReason, "summary-rejected");
  assert.equal(JSON.stringify(delta).includes("inputPreview"), false);
  assert.equal(JSON.stringify(delta).includes("## Outcome"), false);
});

void test("closed write schema rejects extra or unsafe fields at runtime", () => {
  const delta = makeFallbackUsageDelta({ ...BASE, rawBytes: 500, visibleBytes: 600, failureReason: "model-error" });
  assert.deepEqual(validateUsageDelta(delta), delta);

  assert.throws(() => validateUsageDelta({ ...delta, inputPreview: "secret command --token=abc" }), /forbidden usage field/);
  assert.throws(() => validateUsageDelta({ ...delta, summary: "model summary text" }), /forbidden usage field/);
  assert.throws(() => validateUsageDelta({ ...delta, cwd: "/Users/provi/project" }), /forbidden usage field/);
  assert.throws(() => validateUsageDelta({ ...delta, fallbackReason: "free text with a secret" }), /forbidden usage field/);
  assert.throws(() => validateUsageDelta({ ...delta, extra: 1 }), /unknown usage field/);
  assert.throws(() => validateUsageDelta({ ...delta, sessionKey: "/tmp/pi/sessions/abc.jsonl" }), /unsafe session key/);
});

void test("expansion records only safe ids and bounded mode", () => {
  const delta = makeExpansionUsageDelta({ ...BASE, expandMode: "tail", maxChars: 1_000 });

  assert.equal(delta.usageClass, "expand");
  assert.equal(delta.maxChars, 1_000);
  assert.deepEqual(validateUsageDelta(delta), delta);
});
