import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeExpansionUsageDelta, makeFallbackUsageDelta, makeSemanticUsageDelta, makeValidationRejectedUsageDelta } from "../src/usage.js";
import { createUsageStore, ensureInferredActivation, ensureTrackingInfo, writeBackfillSnapshot } from "../src/usage-store.js";

const LIVE = makeSemanticUsageDelta({
  at: 200,
  sessionKey: "session-one",
  cwdHash: "0123456789abcdef",
  artifactId: "0123456789abcdef0123",
  rawBytes: 2_000,
  visibleBytes: 500,
});

void test("usage store appends and summarizes live JSONL records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir, now: () => 100 });

  await store.append(LIVE);
  const read = await store.readDeltas();
  const report = await store.summarize({ scope: "project", cwdHash: "0123456789abcdef" });

  assert.equal(read.deltas.length, 1);
  assert.equal(report.schema, "tool-distill.stats.v1");
  assert.equal(report.tracked.records, 1);
  assert.equal(report.tracked.mainBytesDelta, 1_500);
  assert.equal(report.tracked.semanticModelCalls, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("usage store rejects forbidden fields before persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir });

  await assert.rejects(() => store.append({ ...LIVE, rawPath: "/tmp/raw.txt" }), /forbidden usage field/);
  await assert.rejects(() => store.append({ ...LIVE, sessionKey: "/tmp/session.jsonl" }), /unsafe session key/);

  await rm(dir, { recursive: true, force: true });
});

void test("usage store skips corrupt lines and keeps valid records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir });

  await store.append(LIVE);
  await appendFile(join(dir, "sessions", "session-one.jsonl"), "{not json\n", "utf-8");

  const read = await store.readDeltas();
  assert.equal(read.deltas.length, 1);
  assert.ok(read.warnings.some((warning) => warning.includes("invalid usage line")));

  await rm(dir, { recursive: true, force: true });
});

void test("usage store recreates invalid tracking info instead of bricking stats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tracking.json"), "", "utf-8");

  const tracking = await ensureTrackingInfo(dir, () => 999);
  const store = createUsageStore({ usageRoot: dir });
  await store.append(LIVE);
  const read = await store.readDeltas();

  assert.equal(tracking.trackingStartedAt, 999);
  assert.equal(read.deltas.length, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("usage store preserves concurrent appends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir });
  const other = makeFallbackUsageDelta({
    at: 201,
    sessionKey: "session-one",
    cwdHash: "0123456789abcdef",
    artifactId: "aaaaaaaaaaaaaaaaaaaa",
    rawBytes: 100,
    visibleBytes: 120,
    failureReason: "model-error",
  });

  await Promise.all([store.append(LIVE), store.append(other)]);
  const read = await store.readDeltas();

  assert.equal(read.deltas.length, 2);

  await rm(dir, { recursive: true, force: true });
});

void test("usage store writes inferred activation once for already active settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir, now: () => 100 });

  await ensureInferredActivation({ usageRoot: dir, mode: "auto", now: () => 100 });
  await ensureInferredActivation({ usageRoot: dir, mode: "auto", now: () => 200 });
  const events = await store.readActivations();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "inferred-started");
  assert.equal(events[0]?.partial, true);
  assert.equal(events[0]?.at, 100);

  await rm(dir, { recursive: true, force: true });
});

void test("usage summarization keeps repeated expansions for one artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir });
  const base = {
    at: 300,
    sessionKey: "session-expand",
    cwdHash: "0123456789abcdef",
    artifactId: "0123456789abcdef0123",
    maxChars: 1000,
  };

  await store.append(makeExpansionUsageDelta({ ...base, expandMode: "head" }));
  await store.append(makeExpansionUsageDelta({ ...base, at: 301, expandMode: "tail" }));
  await store.append(makeExpansionUsageDelta({ ...base, at: 302, expandMode: "raw" }));
  const report = await store.summarize({ scope: "global" });

  assert.equal(report.tracked.expansionCount, 3);
  assert.equal(report.tracked.records, 3);

  await rm(dir, { recursive: true, force: true });
});

void test("usage summarization dedups backfill behind any live artifact record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir, now: () => 100 });
  const liveRejected = makeValidationRejectedUsageDelta({
    at: 200,
    sessionKey: "session-one",
    cwdHash: "0123456789abcdef",
    artifactId: "0123456789abcdef0123",
    rawBytes: 2_000,
    visibleBytes: 2_100,
  });
  const backfillFallback = makeFallbackUsageDelta({
    at: 50,
    source: "backfill",
    sessionKey: "backfill-100",
    cwdHash: "0123456789abcdef",
    artifactId: "0123456789abcdef0123",
    rawBytes: 2_000,
    visibleBytes: 2_000,
    failureReason: "historical",
  });

  await store.append(liveRejected);
  await writeBackfillSnapshot(dir, "backfill-100", [backfillFallback]);
  const report = await store.summarize({ scope: "global", includeBackfill: true });

  assert.equal(report.tracked.records, 1);
  assert.equal(report.tracked.fallbackCount, 1);
  assert.equal(report.backfill, undefined);
  assert.equal(report.combined, undefined);

  await rm(dir, { recursive: true, force: true });
});

void test("usage summarization dedups backfill behind live and filters by project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-usage-store-"));
  const store = createUsageStore({ usageRoot: dir, now: () => 100 });
  const backfillDuplicate = { ...LIVE, source: "backfill" as const, sessionKey: "backfill-100", at: 50 };
  const otherProject = makeSemanticUsageDelta({
    at: 50,
    source: "backfill",
    sessionKey: "backfill-100",
    cwdHash: "aaaaaaaaaaaaaaaa",
    artifactId: "bbbbbbbbbbbbbbbbbbbb",
    rawBytes: 500,
    visibleBytes: 100,
  });

  await store.append(LIVE);
  await writeBackfillSnapshot(dir, "backfill-100", [backfillDuplicate, otherProject]);

  const project = await store.summarize({ scope: "project", cwdHash: "0123456789abcdef", includeBackfill: true });
  const global = await store.summarize({ scope: "global", includeBackfill: true });

  assert.equal(project.tracked.records, 1);
  assert.equal(project.backfill, undefined);
  assert.equal(global.tracked.records, 1);
  assert.equal(global.backfill?.records, 1);
  assert.equal(global.combined?.records, 2);

  await rm(dir, { recursive: true, force: true });
});
