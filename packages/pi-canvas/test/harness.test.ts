import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectProcessOutput, killSpawnedProcessGroup, runHarnessScenario, type HarnessScenarioId } from "../src/harness.js";

void test("process output collection times out hung helpers", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  const startedAt = Date.now();
  const output = await collectProcessOutput(child, { timeoutMs: 50, timeoutMessage: "hung helper timeout" });

  assert.equal(output.timedOut, true);
  assert.equal(output.exitCode, null);
  assert.match(output.stderr, /hung helper timeout/);
  assert.ok(Date.now() - startedAt < 1_000);
  if (child.exitCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("hung helper child was not terminated")), 1_000)),
    ]);
  }
});

void test("process output timeout cleanup can terminate detached helper groups", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);",
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("detached helper pid must exist");

  const output = await collectProcessOutput(child, {
    timeoutMs: 50,
    timeoutMessage: "detached helper timeout",
    onTimeout: () => {
      killSpawnedProcessGroup(child, "SIGTERM");
      setTimeout(() => killSpawnedProcessGroup(child, "SIGKILL"), 100).unref();
    },
  });

  assert.equal(output.timedOut, true);
  assert.match(output.stderr, /detached helper timeout/);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.throws(() => process.kill(-pid, 0), /ESRCH/);
});

void test("roundtrip-green passes in degraded fixture mode without claiming success gate", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "roundtrip-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.outsideIn.surfaceKind, "degraded");
  assert.ok(run.insideOut.reviewDiffPaths.length >= 2);
  assert.match(await readFile(join(dirs.reportsDir, `${run.runId}.json`), "utf-8"), /"scenarioId": "roundtrip-green"/);

  await cleanupDirs(dirs);
});

void test("direct-tui-roundtrip-green passes through the TUI component without claiming success gate", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "direct-tui-roundtrip-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.outsideIn.surfaceKind, "tui");
  assert.ok(run.outsideIn.terminalTranscriptPath);
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser.degraded" && assertion.verdict === "pass"));
  assert.match(await readFile(run.outsideIn.terminalTranscriptPath, "utf-8"), /tui input \+ set count=1/);

  await cleanupDirs(dirs);
});

void test("iframe-state-bridge-contract-green records iframe compliance without claiming product success", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "iframe-state-bridge-contract-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.candidateId, "html-iframe-state-bridge-apps-style");
  assert.ok(run.assertions.some((assertion) => assertion.id === "iframe.sandbox-policy" && assertion.verdict === "pass"));
  assert.ok(run.assertions.some((assertion) => assertion.id === "iframe.bridge-action-persisted" && assertion.verdict === "pass"));
  assert.ok(run.insideOut.reviewDiffPaths.length >= 2);
  assert.match(await readFile(run.insideOut.readbackJsonPath, "utf-8"), /"count": 1/);

  await cleanupDirs(dirs);
});

void test("iframe-sandbox-policy-red fails for unsafe sandbox and CSP", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "iframe-sandbox-policy-red", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "fail");
  assert.ok(run.assertions.some((assertion) => assertion.id === "iframe.sandbox-policy" && assertion.verdict === "fail"));
  assert.match(await readFile(run.insideOut.readbackJsonPath, "utf-8"), /allow-same-origin/);
  assert.match(await readFile(run.insideOut.readbackJsonPath, "utf-8"), /csp missing/);

  await cleanupDirs(dirs);
});

void test("iframe-action-roundtrip-green persists typed adjacent-host actions", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "iframe-action-roundtrip-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.candidateId, "html-iframe-state-bridge-apps-style");
  assert.ok(run.assertions.some((assertion) => assertion.id === "iframe.malformed-rejected" && assertion.verdict === "pass"));
  assert.ok(run.assertions.some((assertion) => assertion.id === "iframe.export-diffable" && assertion.verdict === "pass"));
  assert.match(await readFile(run.insideOut.readbackJsonPath, "utf-8"), /"title": "Published"/);
  assert.match(await readFile(run.insideOut.readbackJsonPath, "utf-8"), /"done": true/);

  await cleanupDirs(dirs);
});

void test("iframe-holdout-task-board-green persists richer iframe task-board actions", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "iframe-holdout-task-board-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.candidateId, "html-iframe-state-bridge-apps-style");
  assert.ok(run.assertions.some((assertion) => assertion.id === "iframe.holdout-invalid-rejected" && assertion.verdict === "pass"));
  assert.ok(run.assertions.some((assertion) => assertion.id === "iframe.holdout-export" && assertion.verdict === "pass"));
  const readback = await readFile(run.insideOut.readbackJsonPath, "utf-8");
  assert.match(readback, /"filter": "active"/);
  assert.match(readback, /"selectedTaskId": "taskB"/);
  assert.match(readback, /"done": true/);

  await cleanupDirs(dirs);
});

void test("browser-terminal-replay-agreement-green compares DOM replay readback and export", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "browser-terminal-replay-agreement-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.candidateId, "html-iframe-state-bridge-apps-style");
  assert.ok(run.assertions.some((assertion) => assertion.id === "agreement.replay" && assertion.verdict === "pass"));
  assert.ok(run.assertions.some((assertion) => assertion.id === "agreement.export" && assertion.verdict === "pass"));
  assert.match(await readFile(run.outsideIn.terminalTranscriptPath ?? "", "utf-8"), /Iframe Count: 1/);
  assert.match(await readFile(run.insideOut.readbackJsonPath, "utf-8"), /"count": 1/);

  await cleanupDirs(dirs);
});

void test("browser-host-contract-green records a real local host session contract", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "browser-host-contract-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.candidateId, "pi-owned-browser-host-artifact");
  assert.equal(run.outsideIn.surfaceKind, "browser-host");
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser-host.session-url" && assertion.verdict === "pass"));
  assert.ok(run.outsideIn.terminalTranscriptPath?.endsWith("-browser-host-receipt.json"));

  await cleanupDirs(dirs);
});

void test("browser-host-review-note-green records receipt-only human feedback", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "browser-host-review-note-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.candidateId, "pi-owned-browser-host-artifact");
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser-host-review.note-recorded" && assertion.verdict === "pass"));
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser-host-review.state-unchanged" && assertion.verdict === "pass"));
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser-host-review.no-action-log" && assertion.verdict === "pass"));
  assert.match(await readFile(run.outsideIn.terminalTranscriptPath ?? "", "utf-8"), /"review_note_recorded"/);

  await cleanupDirs(dirs);
});

void test("browser-host-same-trace-success-gate-green marks only complete same-trace receipt successful", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "browser-host-same-trace-success-gate-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, true);
  assert.equal(run.candidateId, "pi-owned-browser-host-artifact");
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser-host.receipt-complete" && assertion.verdict === "pass"));
  assert.match(await readFile(run.outsideIn.terminalTranscriptPath ?? "", "utf-8"), /"visualEvidencePath"/);
  assert.match(await readFile(run.outsideIn.terminalTranscriptPath ?? "", "utf-8"), /"exportDir"/);

  await cleanupDirs(dirs);
});

void test("browser-host-reopen-focus-green reuses the session and artifact", async () => {
  const dirs = await createDirs();
  const run = await runHarnessScenario({ scenarioId: "browser-host-reopen-focus-green", baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

  assert.equal(run.verdict, "pass");
  assert.equal(run.successGateSatisfied, false);
  assert.equal(run.candidateId, "pi-owned-browser-host-artifact");
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser-host.reopen-session" && assertion.verdict === "pass"));
  assert.ok(run.assertions.some((assertion) => assertion.id === "browser-host.no-duplicate-artifact" && assertion.verdict === "pass"));

  await cleanupDirs(dirs);
});

const expectedRedScenarios: HarnessScenarioId[] = [
  "visual-only-red",
  "unpersisted-state-red",
  "export-without-diff-red",
  "browser-terminal-disagreement-red",
  "iframe-visual-only-red",
  "iframe-unpersisted-state-red",
  "iframe-bridge-disagreement-red",
  "iframe-sandbox-policy-red",
  "browser-terminal-replay-disagreement-red",
  "browser-host-raw-html-file-red",
  "browser-host-dom-state-red",
  "browser-host-stale-version-red",
  "browser-host-concurrent-stale-red",
  "browser-host-wrong-session-red",
  "browser-host-export-without-diff-red",
  "browser-host-visual-only-red",
  "browser-host-layout-overflow-red",
  "browser-host-layout-clipped-text-red",
  "browser-host-layout-overlap-red",
];

for (const scenarioId of expectedRedScenarios) {
  void test(`${scenarioId} fails for the expected control reason`, async () => {
    const dirs = await createDirs();
    const run = await runHarnessScenario({ scenarioId, baseDir: dirs.baseDir, cwd: dirs.cwd, reportsDir: dirs.reportsDir });

    assert.equal(run.verdict, "fail");
    assert.ok(run.assertions.some((assertion) => assertion.verdict === "fail"));

    await cleanupDirs(dirs);
  });
}

async function createDirs(): Promise<{ baseDir: string; cwd: string; reportsDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-canvas-cwd-"));
  const reportsDir = await mkdtemp(join(tmpdir(), "pi-canvas-reports-"));
  return { baseDir, cwd, reportsDir };
}

async function cleanupDirs(dirs: { baseDir: string; cwd: string; reportsDir: string }): Promise<void> {
  await rm(dirs.baseDir, { recursive: true, force: true });
  await rm(dirs.cwd, { recursive: true, force: true });
  await rm(dirs.reportsDir, { recursive: true, force: true });
}
