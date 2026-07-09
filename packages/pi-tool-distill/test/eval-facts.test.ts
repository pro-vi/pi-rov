import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFixture } from "../src/eval/fixtures.js";
import { mineFacts } from "../src/eval/facts.js";
import { scanSessionFile } from "../src/eval/transcripts.js";
import type { TranscriptCandidate } from "../src/eval/types.js";

void test("buildFixture mines reused path facts and writes a local raw manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-distill-eval-facts-"));
  const session = join(dir, "session.jsonl");
  const out = join(dir, "evals");
  await writeFile(
    session,
    jsonl([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-05-25T00:00:00.000Z", cwd: "/tmp/project" },
      { type: "message", id: "b1", parentId: null, timestamp: "2026-05-25T00:00:01.000Z", message: { role: "bashExecution", command: "npm test", output: `${"noise\n".repeat(20)}FAIL src/foo.test.ts:42 expected 1 got 2\nTimeoutError`, exitCode: 1, cancelled: false, truncated: false } },
      { type: "message", id: "u1", parentId: "b1", timestamp: "2026-05-25T00:00:02.000Z", message: { role: "user", content: "Please inspect src/foo.test.ts:42 from the npm test failure." } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-05-25T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "The important error is TimeoutError in src/foo.test.ts:42." }] } },
    ]),
    "utf-8",
  );

  const scan = await scanSessionFile(session, { thresholdBytes: 10 });
  const candidate = requireCandidate(scan.candidates[0]);
  const fixture = await buildFixture(candidate, { rootDir: out, now: () => new Date("2026-05-25T00:00:10.000Z") });

  assert.equal(fixture.scoreable, true);
  assert.equal(fixture.facts.some((fact) => fact.value === "src/foo.test.ts:42"), true);
  assert.equal(fixture.facts.some((fact) => fact.value === "TimeoutError"), true);
  assert.equal(fixture.rawHash, candidate.rawHash);
  assert.equal(await readFile(fixture.rawTextPath, "utf-8"), candidate.rawText);

  await rm(dir, { recursive: true, force: true });
});

void test("mineFacts marks fixtures unscoreable when no later reused facts exist", () => {
  const candidate = candidateWithRaw("FAIL src/foo.test.ts:42 expected 1 got 2");

  const facts = mineFacts(candidate, "The next message talks about something else.");

  assert.equal(facts.length, 0);
});

void test("mineFacts collapses duplicate facts by normalized type and value", () => {
  const candidate = candidateWithRaw("src/foo.test.ts:42 failed\nsrc/foo.test.ts:42 failed again\n");

  const facts = mineFacts(candidate, "We should inspect src/foo.test.ts:42 now.");

  assert.equal(facts.filter((fact) => fact.type === "line-ref" && fact.value === "src/foo.test.ts:42").length, 1);
});

void test("mineFacts includes command facts only when later transcript reuses the command", () => {
  const candidate = candidateWithRaw("large output with no paths");

  const facts = mineFacts(candidate, "The npm test command failed and should be rerun.");

  assert.equal(facts.some((fact) => fact.type === "command" && fact.value === "npm test"), true);
});

function candidateWithRaw(rawText: string): TranscriptCandidate {
  return {
    id: "candidate-1",
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
    lineCount: rawText.length === 0 ? 0 : rawText.split("\n").length,
    productionEligible: true,
  };
}

function requireCandidate(candidate: TranscriptCandidate | undefined): TranscriptCandidate {
  assert.ok(candidate);
  return candidate;
}

function jsonl(values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}
