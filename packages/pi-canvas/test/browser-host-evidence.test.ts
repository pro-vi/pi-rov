import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultBrowserArtifactRendererRegistry } from "../src/builtin-browser-renderers.js";
import { createFormCanvasRequest } from "../src/builtin-form-renderer.js";
import type { BrowserHostSessionReceipt } from "../src/browser-host.js";
import { BROWSER_HOST_RECEIPT_FILE_LIMIT_BYTES, BROWSER_HOST_SCOPED_RECEIPT_SCAN_LIMIT, readBrowserHostEvidence, summarizeBrowserHostEvidenceReceipts, withBrowserHostReadiness } from "../src/browser-host-evidence.js";
import { formatBrowserHostReceiptFileName } from "../src/browser-host-receipts.js";
import { PiCanvasRuntime } from "../src/runtime.js";
import { createCanvasStore, sha256 } from "../src/store.js";
import type { BrowserHostTraceEvent } from "../src/types.js";

void test("browser-host evidence orders current receipts by latest event activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  const activeReceipt = makeReceipt(readback, {
    hostSessionId: "active-with-latest-evidence",
    openedAt: "2026-06-27T00:00:00.000Z",
    events: [
      makeEvent("active-with-latest-evidence", "evidence-canvas", "session_opened", "2026-06-27T00:00:00.000Z"),
      {
        ...makeEvent("active-with-latest-evidence", "evidence-canvas", "layout_audit_recorded", "2026-06-27T00:10:00.000Z", "ok"),
        sourceHash: readback.state.sourceHash,
        afterVersion: readback.state.version,
      },
    ],
    layoutAudits: [
      {
        id: "layout-clean",
        sourceHash: readback.state.sourceHash,
        stateVersion: readback.state.version,
        origin: "http://127.0.0.1:1",
        createdAt: "2026-06-27T00:10:00.000Z",
        findings: [],
        errorCount: 0,
        warningCount: 0,
      },
    ],
  });
  const inactiveButOpenedLater = makeReceipt(readback, {
    hostSessionId: "inactive-opened-later",
    openedAt: "2026-06-27T00:05:00.000Z",
    events: [makeEvent("inactive-opened-later", "evidence-canvas", "session_opened", "2026-06-27T00:05:00.000Z")],
  });

  const evidence = summarizeBrowserHostEvidenceReceipts(receiptDir, readback, [inactiveButOpenedLater, activeReceipt]);
  const exportEvidence = withBrowserHostReadiness(readback, evidence, createDefaultBrowserArtifactRendererRegistry());

  assert.equal(evidence.receipts[0]?.hostSessionId, "active-with-latest-evidence");
  assert.equal(evidence.receipts[0]?.currentLayoutAuditCount, 1);
  assert.equal(exportEvidence.readiness?.status, "ready");
  assert.equal(exportEvidence.readiness?.checks.layoutAuditRecorded, true);
  assert.equal(exportEvidence.readiness?.checks.layoutAuditClean, true);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host readiness does not let external layout evidence hide current inline layout errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  const receipt: BrowserHostSessionReceipt = {
    ...makeReceipt(readback, {
      hostSessionId: "mixed-layout-evidence",
      openedAt: "2026-06-27T00:00:00.000Z",
      events: [
        makeEvent("mixed-layout-evidence", "evidence-canvas", "session_opened", "2026-06-27T00:00:00.000Z"),
        {
          ...makeEvent("mixed-layout-evidence", "evidence-canvas", "layout_audit_recorded", "2026-06-27T00:10:00.000Z", "failed"),
          sourceHash: readback.state.sourceHash,
          afterVersion: readback.state.version,
        },
      ],
      layoutAudits: [
        {
          id: "inline-layout-error",
          sourceHash: readback.state.sourceHash,
          stateVersion: readback.state.version,
          origin: "http://127.0.0.1:1",
          createdAt: "2026-06-27T00:10:00.000Z",
          findings: [{ kind: "overflow", selector: "[data-testid='evidence-canvas-board']", severity: "error", overflowPx: 16 }],
          errorCount: 1,
          warningCount: 0,
        },
      ],
    }),
    layoutAuditPath: join(dir, "clean-external-layout-audit.json"),
    layoutAuditErrorCount: 0,
    layoutAuditSourceHash: readback.state.sourceHash,
    layoutAuditStateVersion: readback.state.version,
  };

  const evidence = summarizeBrowserHostEvidenceReceipts(receiptDir, readback, [receipt]);
  const exportEvidence = withBrowserHostReadiness(readback, evidence, createDefaultBrowserArtifactRendererRegistry());

  assert.equal(evidence.receipts[0]?.currentLayoutAuditCount, 2);
  assert.equal(evidence.receipts[0]?.currentLayoutAuditErrorCount, 1);
  assert.equal(exportEvidence.readiness?.status, "blocked");
  assert.equal(exportEvidence.readiness?.readyForHandoff, false);
  assert.equal(exportEvidence.readiness?.checks.layoutAuditRecorded, true);
  assert.equal(exportEvidence.readiness?.checks.layoutAuditClean, false);
  assert.match(exportEvidence.readiness?.reason ?? "", /layout audit for current state has 1 error/);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host readiness requires committed action evidence to match receipt state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  const receipt = makeReceipt(readback, {
    hostSessionId: "future-action-version",
    openedAt: "2026-06-27T00:00:00.000Z",
    events: [
      makeEvent("future-action-version", "evidence-canvas", "session_opened", "2026-06-27T00:00:00.000Z"),
      {
        ...makeEvent("future-action-version", "evidence-canvas", "action_committed", "2026-06-27T00:01:00.000Z", "ok"),
        sourceHash: readback.state.sourceHash,
        beforeVersion: readback.state.version,
        afterVersion: readback.state.version + 10,
        rendererActionType: "move_card",
      },
      makeEvent("future-action-version", "evidence-canvas", "layout_audit_recorded", "2026-06-27T00:02:00.000Z", "ok"),
    ],
    layoutAudits: [
      {
        id: "layout-clean",
        sourceHash: readback.state.sourceHash,
        stateVersion: readback.state.version,
        origin: "http://127.0.0.1:1",
        createdAt: "2026-06-27T00:02:00.000Z",
        findings: [],
        errorCount: 0,
        warningCount: 0,
      },
    ],
  });

  const evidence = summarizeBrowserHostEvidenceReceipts(receiptDir, readback, [receipt]);
  const exportEvidence = withBrowserHostReadiness(readback, evidence, createDefaultBrowserArtifactRendererRegistry());

  assert.equal(evidence.receipts[0]?.latestActionEvent?.afterVersion, readback.state.version + 10);
  assert.equal(exportEvidence.readiness?.status, "blocked");
  assert.equal(exportEvidence.readiness?.readyForHandoff, false);
  assert.equal(exportEvidence.readiness?.checks.latestActionAcceptedForHandoff, false);
  assert.match(exportEvidence.readiness?.reason ?? "", /action evidence is inconsistent/);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host readiness requires recorded review note evidence to match receipt state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  const receipt = makeReceipt(readback, {
    hostSessionId: "wrong-review-note-version",
    openedAt: "2026-06-27T00:00:00.000Z",
    events: [
      makeEvent("wrong-review-note-version", "evidence-canvas", "session_opened", "2026-06-27T00:00:00.000Z"),
      {
        ...makeEvent("wrong-review-note-version", "evidence-canvas", "review_note_recorded", "2026-06-27T00:01:00.000Z", "ok"),
        sourceHash: readback.state.sourceHash,
        afterVersion: readback.state.version + 1,
      },
      makeEvent("wrong-review-note-version", "evidence-canvas", "layout_audit_recorded", "2026-06-27T00:02:00.000Z", "ok"),
    ],
    layoutAudits: [
      {
        id: "layout-clean",
        sourceHash: readback.state.sourceHash,
        stateVersion: readback.state.version,
        origin: "http://127.0.0.1:1",
        createdAt: "2026-06-27T00:02:00.000Z",
        findings: [],
        errorCount: 0,
        warningCount: 0,
      },
    ],
  });

  const evidence = summarizeBrowserHostEvidenceReceipts(receiptDir, readback, [receipt]);
  const exportEvidence = withBrowserHostReadiness(readback, evidence, createDefaultBrowserArtifactRendererRegistry());

  assert.equal(evidence.receipts[0]?.latestReviewNoteEvent?.afterVersion, readback.state.version + 1);
  assert.equal(exportEvidence.readiness?.status, "blocked");
  assert.equal(exportEvidence.readiness?.readyForHandoff, false);
  assert.equal(exportEvidence.readiness?.checks.latestReviewNoteAcceptedForHandoff, false);
  assert.match(exportEvidence.readiness?.reason ?? "", /review note evidence is inconsistent/);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host readiness requires recorded layout audit evidence to match receipt state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  const receipt = makeReceipt(readback, {
    hostSessionId: "wrong-layout-event-version",
    openedAt: "2026-06-27T00:00:00.000Z",
    events: [
      makeEvent("wrong-layout-event-version", "evidence-canvas", "session_opened", "2026-06-27T00:00:00.000Z"),
      {
        ...makeEvent("wrong-layout-event-version", "evidence-canvas", "layout_audit_recorded", "2026-06-27T00:01:00.000Z", "ok"),
        sourceHash: readback.state.sourceHash,
        afterVersion: readback.state.version + 1,
      },
    ],
    layoutAudits: [
      {
        id: "layout-clean",
        sourceHash: readback.state.sourceHash,
        stateVersion: readback.state.version,
        origin: "http://127.0.0.1:1",
        createdAt: "2026-06-27T00:01:00.000Z",
        findings: [],
        errorCount: 0,
        warningCount: 0,
      },
    ],
  });

  const evidence = summarizeBrowserHostEvidenceReceipts(receiptDir, readback, [receipt]);
  const exportEvidence = withBrowserHostReadiness(readback, evidence, createDefaultBrowserArtifactRendererRegistry());

  assert.equal(evidence.receipts[0]?.latestLayoutAuditEvent?.afterVersion, readback.state.version + 1);
  assert.equal(exportEvidence.readiness?.status, "blocked");
  assert.equal(exportEvidence.readiness?.readyForHandoff, false);
  assert.equal(exportEvidence.readiness?.checks.latestLayoutAuditAcceptedForHandoff, false);
  assert.match(exportEvidence.readiness?.reason ?? "", /layout audit evidence is inconsistent/);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host evidence reports unreadable receipt files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  await mkdir(receiptDir, { recursive: true });
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("evidence-canvas", "malformed", readback.paths.sourcePath)), '{"id":', "utf-8");
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("evidence-canvas", "invalid", readback.paths.sourcePath)), '{"artifactId":"evidence-canvas"}\n', "utf-8");
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("evidence-canvas", "oversized", readback.paths.sourcePath)), "x".repeat(BROWSER_HOST_RECEIPT_FILE_LIMIT_BYTES + 1), "utf-8");
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("evidence-canvas", "other-source", "/tmp/other-project/artifacts/evidence-canvas/canvas.source.json")), '{"id":', "utf-8");
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("other-artifact", "malformed", readback.paths.sourcePath)), '{"id":', "utf-8");
  await writeFile(join(receiptDir, "legacy-unscoped-browser-host-receipt.json"), '{"id":', "utf-8");
  await mkdir(join(receiptDir, "legacy-directory-browser-host-receipt.json"));
  const linkedTargetPath = join(dir, "outside-linked-receipt.json");
  await writeFile(linkedTargetPath, '{"id":', "utf-8");
  await symlink(linkedTargetPath, join(receiptDir, formatBrowserHostReceiptFileName("evidence-canvas", "linked", readback.paths.sourcePath)));

  const evidence = await readBrowserHostEvidence(dir, readback);
  const exportEvidence = withBrowserHostReadiness(readback, evidence, createDefaultBrowserArtifactRendererRegistry());

  assert.equal(evidence.receipts.length, 0);
  assert.equal(evidence.receiptReadErrors?.length, 3);
  assert.deepEqual(
    evidence.receiptReadErrors?.map((error) => error.reason).sort(),
    ["invalid-json", "invalid-receipt", "too-large"],
  );
  assert.equal(exportEvidence.receiptReadErrors?.length, 3);
  assert.equal(exportEvidence.readiness?.status, "blocked");
  assert.equal(exportEvidence.readiness?.readyForHandoff, false);
  assert.match(exportEvidence.readiness?.reason ?? "", /could not be read/);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host evidence bounds scoped receipt ingestion to latest modified receipt files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  await mkdir(receiptDir, { recursive: true });
  const oldMalformedPath = join(receiptDir, formatBrowserHostReceiptFileName("evidence-canvas", "run-999", readback.paths.sourcePath));
  await writeFile(oldMalformedPath, '{"id":', "utf-8");
  await utimes(oldMalformedPath, new Date("2026-06-26T00:00:00.000Z"), new Date("2026-06-26T00:00:00.000Z"));

  const latestIndex = BROWSER_HOST_SCOPED_RECEIPT_SCAN_LIMIT + 5;
  for (let index = 1; index <= latestIndex; index += 1) {
    const runId = `run-${String(index).padStart(3, "0")}`;
    const openedAt = new Date(Date.UTC(2026, 5, 27, 0, index, 0)).toISOString();
    const modifiedAt = new Date(Date.UTC(2026, 5, 27, 1, index, 0));
    const receipt = makeReceipt(readback, {
      hostSessionId: runId,
      openedAt,
      events: [makeEvent(runId, "evidence-canvas", "session_opened", openedAt)],
    });
    const path = join(receiptDir, formatBrowserHostReceiptFileName("evidence-canvas", runId, readback.paths.sourcePath));
    await writeFile(path, `${JSON.stringify(receipt)}\n`, "utf-8");
    await utimes(path, modifiedAt, modifiedAt);
  }

  const evidence = await readBrowserHostEvidence(dir, readback);

  assert.equal(evidence.receiptReadErrors, undefined);
  assert.equal(evidence.receipts.length, 5);
  assert.equal(evidence.receipts[0]?.hostSessionId, `run-${String(latestIndex).padStart(3, "0")}`);
  assert.equal(evidence.receipts[4]?.hostSessionId, `run-${String(latestIndex - 4).padStart(3, "0")}`);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host evidence ignores valid receipts with mismatched scoped filenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-evidence-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create(createFormArtifactRequest("evidence-canvas"));
  const receiptDir = join(dir, "browser-host-receipts");
  await mkdir(receiptDir, { recursive: true });

  const scopedReceipt = makeReceipt(readback, {
    hostSessionId: "mis-scoped-valid",
    openedAt: "2026-06-27T00:00:00.000Z",
    events: [makeEvent("mis-scoped-valid", "evidence-canvas", "session_opened", "2026-06-27T00:00:00.000Z")],
  });
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("other-artifact", "mis-scoped-valid", readback.paths.sourcePath)), `${JSON.stringify(scopedReceipt)}\n`, "utf-8");

  const scopedEvidence = await readBrowserHostEvidence(dir, readback);
  assert.equal(scopedEvidence.receipts.length, 0);

  const legacyPath = join(receiptDir, "legacy-valid-browser-host-receipt.json");
  await writeFile(legacyPath, `${JSON.stringify({ ...scopedReceipt, hostSessionId: "legacy-valid", receiptPath: legacyPath })}\n`, "utf-8");

  const legacyEvidence = await readBrowserHostEvidence(dir, readback);
  assert.equal(legacyEvidence.receipts.length, 1);
  assert.equal(legacyEvidence.receipts[0]?.hostSessionId, "legacy-valid");

  await rm(dir, { recursive: true, force: true });
});

function createFormArtifactRequest(artifactId: string) {
  return createFormCanvasRequest(artifactId, "Form Canvas", {
    components: [{ id: "layout", kind: "single-select", prompt: "Layout", options: [{ id: "a", title: "Sidebar" }, { id: "b", title: "Tabs" }] }],
  });
}

function makeReceipt(
  readback: Awaited<ReturnType<PiCanvasRuntime["create"]>>,
  options: {
    hostSessionId: string;
    openedAt: string;
    events: BrowserHostTraceEvent[];
    layoutAudits?: BrowserHostSessionReceipt["layoutAudits"];
  },
): BrowserHostSessionReceipt {
  return {
    candidateId: "receipt-order-test",
    scenarioId: "receipt-order-test",
    command: "test",
    runId: options.hostSessionId,
    artifactId: readback.source.artifactId,
    sourceHash: readback.state.sourceHash,
    initialStateVersion: readback.state.version,
    finalStateVersion: readback.state.version,
    hostSessionId: options.hostSessionId,
    signedUrl: "http://127.0.0.1/session/redacted",
    allowedOrigin: "http://127.0.0.1:1",
    tokenHash: sha256(options.hostSessionId),
    status: "open",
    openedAt: options.openedAt,
    fallback: "terminal-render",
    renderer: "builtin.canvas",
    sourcePath: readback.paths.sourcePath,
    statePath: readback.paths.statePath,
    actionLogPath: readback.paths.actionsPath,
    reviewDiffPaths: [],
    actions: [],
    reviewNotes: [],
    layoutAudits: options.layoutAudits ?? [],
    rejections: [],
    events: options.events,
    receiptPath: `/tmp/${options.hostSessionId}-browser-host-receipt.json`,
  };
}

function makeEvent(
  sessionId: string,
  artifactId: string,
  kind: BrowserHostTraceEvent["kind"],
  createdAt: string,
  status?: BrowserHostTraceEvent["status"],
): BrowserHostTraceEvent {
  return {
    eventId: `event-${sessionId}-${kind}`,
    kind,
    createdAt,
    sessionId,
    artifactId,
    ...(status === undefined ? {} : { status }),
  };
}
