import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactStore, markDistilled, markFallback, markReduced } from "../src/artifacts.js";
import { cwdHashForPath, getUsageRoot } from "../src/paths.js";
import { runUsageBackfill } from "../src/usage-backfill.js";
import { createUsageStore } from "../src/usage-store.js";

const MODEL = { provider: "test", modelId: "spark" };
const SUMMARY = ["## Outcome", "Done", "## Verbatim evidence", "src/a.ts:1", "## Omitted", "none", "## Uncertainty", "none"].join("\n");

void test("backfill maps semantic metadata without persisting summary or input preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-distill-backfill-"));
  const usageRoot = getUsageRoot(root);
  const artifactRoot = join(root, "tool-distill");
  const store = createArtifactStore("/tmp/project", { baseDir: artifactRoot, now: () => 100 });
  const artifact = await store.writeRaw({ cwd: "/tmp/project", toolCallId: "call-backfill", toolName: "bash", input: { command: "secret --token=abc" }, rawText: "x".repeat(2000) });
  await store.update(markDistilled(artifact, SUMMARY, MODEL));

  const result = await runUsageBackfill({ toolDistillRoot: artifactRoot, usageRoot, now: () => 200 });
  const usage = createUsageStore({ usageRoot });
  const read = await usage.readDeltas();
  const serialized = JSON.stringify(read.deltas);

  assert.equal(result.records, 1);
  assert.equal(read.deltas[0]?.source, "backfill");
  assert.equal(read.deltas[0]?.usageClass, "semantic");
  assert.equal(serialized.includes("secret --token"), false);
  assert.equal(serialized.includes("## Outcome"), false);
  assert.equal(serialized.includes("inputPreview"), false);

  await rm(root, { recursive: true, force: true });
});

void test("backfill scans all cwd hashes and repeated runs dedup in stats", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-distill-backfill-"));
  const usageRoot = getUsageRoot(root);
  const artifactRoot = join(root, "tool-distill");
  for (const cwd of ["/tmp/project-a", "/tmp/project-b"]) {
    const store = createArtifactStore(cwd, { baseDir: artifactRoot, now: () => 100 });
    const artifact = await store.writeRaw({ cwd, toolCallId: `call-${cwd}`, toolName: "bash", input: { command: "npm test" }, rawText: "x".repeat(3000) });
    await store.update(markDistilled(artifact, SUMMARY, MODEL));
  }

  await runUsageBackfill({ toolDistillRoot: artifactRoot, usageRoot, now: () => 200 });
  await runUsageBackfill({ toolDistillRoot: artifactRoot, usageRoot, now: () => 200 });
  const usage = createUsageStore({ usageRoot });
  const global = await usage.summarize({ scope: "global", includeBackfill: true });
  const projectA = await usage.summarize({ scope: "project", cwdHash: cwdHashForPath("/tmp/project-a"), includeBackfill: true });

  assert.equal(global.backfill?.records, 2);
  assert.equal(projectA.backfill?.records, 1);

  await rm(root, { recursive: true, force: true });
});

void test("backfill dry-run does not create tracking or snapshot files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-distill-backfill-"));
  const usageRoot = getUsageRoot(root);
  const artifactRoot = join(root, "tool-distill");
  const store = createArtifactStore("/tmp/project", { baseDir: artifactRoot, now: () => 100 });
  const artifact = await store.writeRaw({ cwd: "/tmp/project", toolCallId: "call-dry-run", toolName: "bash", input: { command: "npm test" }, rawText: "x".repeat(3000) });
  await store.update(markDistilled(artifact, SUMMARY, MODEL));

  const result = await runUsageBackfill({ toolDistillRoot: artifactRoot, usageRoot, dryRun: true, now: () => 200 });

  assert.equal(result.dryRun, true);
  assert.equal(result.records, 1);
  assert.equal(await exists(join(usageRoot, "tracking.json")), false);
  assert.equal(await exists(join(usageRoot, "backfill")), false);

  await rm(root, { recursive: true, force: true });
});

void test("backfill maps fallback and reducer classes conservatively", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-distill-backfill-"));
  const usageRoot = getUsageRoot(root);
  const artifactRoot = join(root, "tool-distill");
  const store = createArtifactStore("/tmp/project", { baseDir: artifactRoot, now: () => 100 });
  const reducedRaw = await store.writeRaw({ cwd: "/tmp/project", toolCallId: "call-reduced", toolName: "bash", input: { command: "npm test" }, rawText: "x".repeat(3000) });
  await store.update(markReduced(reducedRaw, SUMMARY, { reducerId: "append-only-repeat" }));
  const fallbackRaw = await store.writeRaw({ cwd: "/tmp/project", toolCallId: "call-fallback", toolName: "bash", input: { command: "npm test" }, rawText: "x".repeat(3000) });
  await store.update(markFallback(fallbackRaw, "summary rejected", MODEL));

  await runUsageBackfill({ toolDistillRoot: artifactRoot, usageRoot, now: () => 200 });
  const usage = createUsageStore({ usageRoot });
  const report = await usage.summarize({ scope: "global", includeBackfill: true });

  assert.equal(report.backfill?.reducerHits, 1);
  assert.equal(report.backfill?.fallbackCount, 1);
  assert.equal(report.backfill?.unknown.expansions, true);
  assert.equal(report.backfill?.unknown.distillerSpend, true);

  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
