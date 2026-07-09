import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintText, sha256 } from "../src/artifacts.js";
import { reduceToolResult } from "../src/reducers.js";
import type { ObservationArtifact } from "../src/types.js";

void test("normalized duplicate reducer ignores ANSI, CRLF, and trailing whitespace", () => {
  const previousText = longLines("same output", 140);
  const currentText = `\u001B[32m${previousText.replace(/\n/g, "  \r\n")}\u001B[0m   \r\n`;
  const previous = artifact("11111111111111111111", previousText, 100);
  const current = artifact("22222222222222222222", currentText, 200);

  const hit = reduceToolResult({ current, rawText: currentText, candidates: [{ artifact: previous, rawText: previousText }] });

  assert.equal(hit?.reducerId, "normalized-duplicate");
  assert.equal(hit?.previousArtifactId, previous.id);
  assert.match(hit?.summary ?? "", /mechanically equivalent/);
  assert.match(hit?.summary ?? "", new RegExp(previous.id));
});

void test("append-only reducer keeps bounded new suffix and points to previous artifact", () => {
  const previousText = longLines("test log", 160);
  const suffix = "\nFAIL src/foo.test.ts:42 TimeoutError";
  const currentText = `${previousText}${suffix}`;
  const previous = artifact("33333333333333333333", previousText, 100);
  const current = artifact("44444444444444444444", currentText, 200);

  const hit = reduceToolResult({ current, rawText: currentText, candidates: [{ artifact: previous, rawText: previousText }] });

  assert.equal(hit?.reducerId, "append-only");
  assert.equal(hit?.previousArtifactId, previous.id);
  assert.match(hit?.summary ?? "", /src\/foo\.test\.ts:42 TimeoutError/);
  assert.match(hit?.summary ?? "", /omitted/i);
  assert.ok((hit?.omittedBytes ?? 0) >= 1000);
});

void test("append-only reducer misses when prior block is below minimum length", () => {
  const previousText = "short previous";
  const currentText = `${previousText}\nnew line`;
  const previous = artifact("55555555555555555555", previousText, 100);
  const current = artifact("66666666666666666666", currentText, 200);

  const hit = reduceToolResult({ current, rawText: currentText, candidates: [{ artifact: previous, rawText: previousText }] });

  assert.equal(hit, undefined);
});

void test("append-only reducer shows every admitted suffix without clipping", () => {
  const previousText = longLines("previous", 160);
  const suffix = `\n${"N".repeat(3_500)}`;
  const currentText = `${previousText}${suffix}`;
  const previous = artifact("aaaaaaaaaaaaaaaaaaaa", previousText, 100);
  const current = artifact("bbbbbbbbbbbbbbbbbbbb", currentText, 200);

  const hit = reduceToolResult({ current, rawText: currentText, candidates: [{ artifact: previous, rawText: previousText }] });

  assert.equal(hit?.reducerId, "append-only");
  assert.match(hit?.summary ?? "", new RegExp("N".repeat(3_500)));
  assert.doesNotMatch(hit?.summary ?? "", /snippet truncated/);
});

void test("append-only reducer misses instead of hiding a large new suffix", () => {
  const previousText = longLines("previous", 160);
  const largeSuffix = `\n${longLines("new evidence", 900)}`;
  const currentText = `${previousText}${largeSuffix}`;
  const previous = artifact("77777777777777777777", previousText, 100);
  const current = artifact("88888888888888888888", currentText, 200);

  const hit = reduceToolResult({ current, rawText: currentText, candidates: [{ artifact: previous, rawText: previousText }] });

  assert.equal(hit, undefined);
});

void test("safe reducers miss on empty input without throwing", () => {
  const current = artifact("99999999999999999999", "", 200);

  const hit = reduceToolResult({ current, rawText: "", candidates: [] });

  assert.equal(hit, undefined);
});

function longLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${String(index + 1).padStart(3, "0")} repeated payload with enough bytes to cross reducer gates`).join("\n");
}

function artifact(id: string, rawText: string, createdAt: number): ObservationArtifact {
  const fingerprint = fingerprintText(rawText);
  return {
    id,
    status: "raw",
    toolCallId: `call-${id}`,
    toolName: "bash",
    createdAt,
    cwd: "/tmp/project",
    rawPath: `/tmp/${id}.txt`,
    metadataPath: `/tmp/${id}.json`,
    rawHash: sha256(rawText),
    rawBytes: Buffer.byteLength(rawText, "utf-8"),
    rawLines: rawText.length === 0 ? 0 : rawText.split("\n").length,
    inputPreview: "{}",
    normalizedHash: fingerprint.normalizedHash,
    normalizedBytes: fingerprint.normalizedBytes,
    normalizedLines: fingerprint.normalizedLines,
  };
}
