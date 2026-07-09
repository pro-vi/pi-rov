import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runEvalCli, type EvalCliIO } from "../src/eval/cli.js";

void test("eval CLI scans, runs offline, and reports from a synthetic transcript", async () => {
  const root = await mkdir(join(tmpdir(), `tool-distill-eval-cli-${Date.now()}-`), { recursive: true });
  const dir = root ?? join(tmpdir(), "tool-distill-eval-cli-fallback");
  const sessionsRoot = join(dir, "sessions");
  const out = join(dir, "eval-out");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(join(sessionsRoot, "session.jsonl"), transcriptJsonl(), "utf-8");
  const output: string[] = [];
  const errors: string[] = [];
  const io: EvalCliIO = { cwd: dir, stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };

  assert.equal(await runEvalCli(["scan", "--sessions-root", sessionsRoot, "--out", out, "--threshold", "10"], io), 0);
  assert.equal(await runEvalCli(["run", "--out", out, "--sample", "1"], io), 0);
  assert.equal(await runEvalCli(["report", "--out", out], io), 0);

  const scanIndex = await readFile(join(out, "scan-index.json"), "utf-8");
  assert.match(scanIndex, /"candidateCount": 1/);
  assert.equal(errors.length, 0);
  assert.match(output.join("\n"), /offline run/);
  assert.match(output.join("\n"), /Variant aggregates/);

  await rm(dir, { recursive: true, force: true });
});

void test("eval CLI rejects live run without model before making model calls", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io: EvalCliIO = { cwd: tmpdir(), stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };

  const code = await runEvalCli(["run", "--live"], io);

  assert.equal(code, 1);
  assert.match(errors.join("\n"), /--live requires --model/);
  assert.equal(output.length, 0);
});

void test("eval CLI reports unknown live model as an actionable error", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io: EvalCliIO = { cwd: tmpdir(), stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };

  const code = await runEvalCli(["run", "--live", "--model", "missing-provider/missing-model"], io);

  assert.equal(code, 1);
  assert.match(errors.join("\n"), /model not found/);
  assert.equal(output.length, 0);
});

function transcriptJsonl(): string {
  const lines = [
    { type: "session", version: 3, id: "session-1", timestamp: "2026-05-25T00:00:00.000Z", cwd: "/tmp/project" },
    { type: "message", id: "b1", parentId: null, timestamp: "2026-05-25T00:00:01.000Z", message: { role: "bashExecution", command: "npm test", output: `${"noise\n".repeat(20)}FAIL src/foo.test.ts:42 expected 1 got 2`, exitCode: 1, cancelled: false, truncated: false } },
    { type: "message", id: "a1", parentId: "b1", timestamp: "2026-05-25T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "The failing location is src/foo.test.ts:42 from npm test." }] } },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
