import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanSessionFile, TranscriptScanError } from "../src/eval/transcripts.js";

void test("scanSessionFile emits large bash tool-result candidates with stable ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-distill-eval-transcripts-"));
  const session = join(dir, "session.jsonl");
  await writeFile(
    session,
    jsonl([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-05-25T00:00:00.000Z", cwd: "/tmp/project" },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-05-25T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }] },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-05-25T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: `${"x".repeat(40)}\nsrc/foo.test.ts:42 expected 1 got 2` }], isError: false },
      },
    ]),
    "utf-8",
  );

  const first = await scanSessionFile(session, { thresholdBytes: 10 });
  const second = await scanSessionFile(session, { thresholdBytes: 10 });

  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0]?.id, second.candidates[0]?.id);
  assert.equal(first.candidates[0]?.toolName, "bash");
  assert.equal(first.candidates[0]?.input.command, "npm test");
  assert.equal(first.candidates[0]?.productionEligible, true);
  assert.equal(first.candidates[0]?.lineNumber, 3);
  assert.equal(first.warnings.length, 0);

  await rm(dir, { recursive: true, force: true });
});

void test("scanner discovers exactness-sensitive candidates but marks them ineligible unless forced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-distill-eval-transcripts-"));
  const session = join(dir, "session.jsonl");
  await writeFile(
    session,
    jsonl([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-05-25T00:00:00.000Z", cwd: "/tmp/project" },
      { type: "message", id: "a1", parentId: null, timestamp: "2026-05-25T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/foo.ts" } }] } },
      { type: "message", id: "r1", parentId: "a1", timestamp: "2026-05-25T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "export const value = 1;\n".repeat(5) }], isError: false } },
      { type: "message", id: "b1", parentId: "r1", timestamp: "2026-05-25T00:00:03.000Z", message: { role: "bashExecution", command: "git diff", output: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n".repeat(3), exitCode: 0, cancelled: false, truncated: false } },
    ]),
    "utf-8",
  );

  const normal = await scanSessionFile(session, { thresholdBytes: 10 });
  const forced = await scanSessionFile(session, { thresholdBytes: 10, forceProductionEligibility: true });

  assert.equal(normal.candidates.length, 2);
  assert.deepEqual(normal.candidates.map((candidate) => candidate.productionEligible), [false, false]);
  assert.match(normal.candidates[0]?.ineligibilityReason ?? "", /exactness-sensitive/);
  assert.match(normal.candidates[1]?.ineligibilityReason ?? "", /diff-like/);
  assert.deepEqual(forced.candidates.map((candidate) => candidate.productionEligible), [true, true]);

  await rm(dir, { recursive: true, force: true });
});

void test("scanner records malformed JSONL warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-distill-eval-transcripts-"));
  const session = join(dir, "session.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "s" })}\nnot json\n`, "utf-8");

  const result = await scanSessionFile(session, { thresholdBytes: 10 });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]?.reason ?? "", /malformed/);

  await rm(dir, { recursive: true, force: true });
});

void test("scanner raises typed errors for missing files", async () => {
  await assert.rejects(
    () => scanSessionFile(join(tmpdir(), "missing-tool-distill-session.jsonl")),
    (error: unknown) => error instanceof TranscriptScanError && error.code === "missing-file",
  );
});

function jsonl(values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}
