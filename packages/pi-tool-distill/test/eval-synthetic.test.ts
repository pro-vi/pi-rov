import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runEvalCli, type EvalCliIO } from "../src/eval/cli.js";
import { renderSyntheticEvalMarkdown } from "../src/eval/report.js";
import { runSyntheticEval } from "../src/eval/synthetic.js";

void test("synthetic eval proves semantic cache skips repeated model calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-synthetic-"));

  const run = await runSyntheticEval({ artifactBaseDir: dir, now: () => 1_000 });
  const duplicate = run.cases.find((item) => item.id === "exact-duplicate-cache");

  assert.ok(duplicate);
  assert.equal(duplicate.modelCalls, 1);
  assert.equal(duplicate.cacheHits, 1);
  assert.equal(duplicate.modelCallsSkipped, 1);
  assert.equal(duplicate.retention, 1);
  assert.equal(duplicate.expansionNeeded, false);
  assert.ok(duplicate.bytesSaved > 0);

  await rm(dir, { recursive: true, force: true });
});

void test("synthetic eval covers append-only reducer and changed-question cache miss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-synthetic-"));

  const run = await runSyntheticEval({ artifactBaseDir: dir, now: () => 1_000 });
  const appendOnly = run.cases.find((item) => item.id === "append-only-reducer");
  const changedQuestion = run.cases.find((item) => item.id === "same-raw-different-question");

  assert.ok(appendOnly);
  assert.equal(appendOnly.modelCalls, 0);
  assert.equal(appendOnly.reducerHits, 1);
  assert.equal(appendOnly.retention, 1);
  assert.ok(appendOnly.bytesSaved > 0);

  assert.ok(changedQuestion);
  assert.equal(changedQuestion.modelCalls, 2);
  assert.equal(changedQuestion.cacheHits, 0);
  assert.equal(changedQuestion.expansionNeeded, false);

  const markdown = renderSyntheticEvalMarkdown(run);
  assert.match(markdown, /Compression ratio/);
  assert.match(markdown, /Model calls skipped/);
  assert.match(markdown, /Expansion needed/);

  await rm(dir, { recursive: true, force: true });
});

void test("eval CLI synthetic command writes JSON and Markdown reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-synthetic-cli-"));
  const out = join(dir, "eval-out");
  const output: string[] = [];
  const errors: string[] = [];
  const io: EvalCliIO = { cwd: dir, stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };

  const code = await runEvalCli(["synthetic", "--out", out], io);
  const secondCode = await runEvalCli(["synthetic", "--out", out], io);

  assert.equal(code, 0);
  assert.equal(secondCode, 0);
  assert.equal(errors.length, 0);
  assert.match(output.join("\n"), /synthetic eval wrote/);
  const jsonPath = output.join("\n").match(/wrote (.*synthetic.*\.json)/)?.[1];
  assert.ok(jsonPath);
  const json = await readFile(jsonPath, "utf-8");
  assert.match(json, /exact-duplicate-cache/);
  const secondJsonPath = output.join("\n").match(/wrote (.*synthetic.*\.json)[\s\S]*wrote (.*synthetic.*\.json)/)?.[2];
  assert.ok(secondJsonPath);
  const secondJson = await readFile(secondJsonPath, "utf-8");
  assert.match(secondJson, /"id": "exact-duplicate-cache"[\s\S]*"modelCalls": 1[\s\S]*"cacheHits": 1/);
  assert.match(await readFile(jsonPath.replace(/\.json$/, ".md"), "utf-8"), /Synthetic case results/);

  await rm(dir, { recursive: true, force: true });
});
