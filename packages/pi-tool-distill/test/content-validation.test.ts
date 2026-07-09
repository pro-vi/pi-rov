import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DISTILL_SETTINGS } from "../src/config.js";
import { extractToolText, looksLikeDiff, selectRawText } from "../src/content.js";
import { validateSummary } from "../src/validation.js";

void test("extractToolText joins text blocks and notes images", () => {
  const extracted = extractToolText([
    { type: "text", text: "hello" },
    { type: "image", data: "abc", mimeType: "image/png" },
    { type: "text", text: "world" },
  ]);

  assert.equal(extracted.text, "hello\nworld");
  assert.equal(extracted.hasImages, true);
  assert.equal(extracted.textBlockCount, 2);
});

void test("looksLikeDiff detects command and patch shapes", () => {
  assert.equal(looksLikeDiff("bash", { command: "git diff" }, "anything"), true);
  assert.equal(looksLikeDiff("bash", { command: "echo ok" }, "diff --git a/a b/a\n@@ -1 +1 @@"), true);
  assert.equal(looksLikeDiff("bash", { command: "npm test" }, "FAIL"), false);
});

void test("selectRawText supports summary, head, tail, and raw truncation", () => {
  const raw = "0123456789";
  assert.equal(selectRawText(raw, "summary", 4, "summary text"), "summary text");
  assert.match(selectRawText(raw, "head", 4), /^0123/);
  assert.match(selectRawText(raw, "tail", 4), /6789$/);
  assert.match(selectRawText(raw, "raw", 4), /raw truncated/);
});

void test("validateSummary accepts complete cards and rejects bad cards", () => {
  const good = [
    "## Outcome",
    "Tests failed.",
    "## Verbatim evidence",
    "src/foo.test.ts:42 expected 1 got 2",
    "## Omitted",
    "Passing tests and progress logs.",
    "## Uncertainty",
    "No uncertainty.",
  ].join("\n");

  const source = `${"x".repeat(20_000)}\nerror src/foo.test.ts:42`;
  assert.equal(validateSummary(source, good, DEFAULT_DISTILL_SETTINGS).ok, true);
  assert.equal(validateSummary(source, "", DEFAULT_DISTILL_SETTINGS).ok, false);
  assert.equal(validateSummary(source, "please provide command output", DEFAULT_DISTILL_SETTINGS).ok, false);
  assert.equal(validateSummary(source, "## Outcome\nOnly one section", DEFAULT_DISTILL_SETTINGS).ok, false);
  assert.equal(validateSummary("short", good, DEFAULT_DISTILL_SETTINGS).ok, false);
});
