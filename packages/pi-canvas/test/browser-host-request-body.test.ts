import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BROWSER_HOST_RECEIPT_LIMITS, BROWSER_HOST_REQUEST_BODY_LIMIT_BYTES, BrowserHostSessionManager, type LocalBrowserHostSession } from "../src/browser-host.js";
import { createFormCanvasRequest } from "../src/builtin-form-renderer.js";
import { isRecord } from "../src/json.js";
import { PiCanvasRuntime } from "../src/runtime.js";
import { createCanvasStore } from "../src/store.js";

function createCanvasFixture(artifactId: string) {
  return createFormCanvasRequest(artifactId, "Canvas Fixture", {
    components: [{ id: "choice", kind: "single-select", prompt: "Pick one", options: [{ id: "a", title: "Option A" }, { id: "b", title: "Option B" }] }],
  });
}

void test("browser-host POST endpoints report typed request body errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-body-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create(createCanvasFixture("chooser"));
  const session = await new BrowserHostSessionManager().getOrStart(`${cwd}:chooser`, {
    runtime,
    artifactId: "chooser",
    candidateId: "browser-body-test",
    scenarioId: "browser-body-test",
    runId: "browser-body-test",
    reportsDir: join(dir, "browser-host-receipts"),
  });

  try {
    const page = await fetch(session.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    // frame-src 'self' is required or the form's sandboxed design-variant/html-embed iframes render blank.
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-src 'self'/);

    const invalidJson = await postRaw(session, "action", "{");
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.errorCode, "body_invalid_json");
    assert.equal(invalidJson.referrerPolicy, "no-referrer");
    assert.equal(invalidJson.contentTypeOptions, "nosniff");

    const nonObject = await postRaw(session, "review-note", "[]");
    assert.equal(nonObject.status, 400);
    assert.equal(nonObject.body.errorCode, "body_invalid");

    const oversized = await postRaw(session, "layout-audit", JSON.stringify({ body: "x".repeat(65_000) }));
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.errorCode, "body_too_large");

    const multibyteOversized = JSON.stringify({ text: "é".repeat(Math.ceil(BROWSER_HOST_REQUEST_BODY_LIMIT_BYTES / 2)) });
    assert.ok(multibyteOversized.length < BROWSER_HOST_REQUEST_BODY_LIMIT_BYTES);
    assert.ok(Buffer.byteLength(multibyteOversized, "utf-8") > BROWSER_HOST_REQUEST_BODY_LIMIT_BYTES);
    const multibyte = await postRaw(session, "review-note", multibyteOversized);
    assert.equal(multibyte.status, 413);
    assert.equal(multibyte.body.errorCode, "body_too_large");

    assert.ok(session.receipt.events.some((event) => event.kind === "action_rejected" && event.errorCode === "body_invalid_json"));
    assert.ok(session.receipt.events.some((event) => event.kind === "review_note_rejected" && event.errorCode === "body_invalid"));
    assert.ok(session.receipt.events.some((event) => event.kind === "layout_audit_rejected" && event.errorCode === "body_too_large"));
    assert.ok(session.receipt.events.some((event) => event.kind === "review_note_rejected" && event.errorCode === "body_too_large"));
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("browser-host receipts bound retained evidence while keeping latest events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-receipt-limits-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create(createCanvasFixture("chooser"));
  const session = await new BrowserHostSessionManager().getOrStart(`${cwd}:chooser`, {
    runtime,
    artifactId: "chooser",
    candidateId: "browser-receipt-limits-test",
    scenarioId: "browser-receipt-limits-test",
    runId: "browser-receipt-limits-test",
    reportsDir: join(dir, "browser-host-receipts"),
  });

  try {
    let stateVersion = session.receipt.finalStateVersion;
    const actionIterations = BROWSER_HOST_RECEIPT_LIMITS.actions + 5;
    for (let index = 0; index < actionIterations; index += 1) {
      const result = await postJson(session, "action", {
        artifactId: "chooser",
        sessionId: session.receipt.hostSessionId,
        sourceHash: session.receipt.sourceHash,
        stateVersion,
        origin: session.receipt.allowedOrigin,
        action: { componentId: "choice", op: "affirm", optionId: index % 2 === 0 ? "a" : "b" },
      });
      assert.equal(result.status, 200);
      const nextVersion = result.body.stateVersion;
      if (typeof nextVersion !== "number") throw new Error("action response must include stateVersion");
      stateVersion = nextVersion;
    }

    const noteIterations = BROWSER_HOST_RECEIPT_LIMITS.reviewNotes + 5;
    for (let index = 0; index < noteIterations; index += 1) {
      const result = await postJson(session, "review-note", {
        artifactId: "chooser",
        sessionId: session.receipt.hostSessionId,
        sourceHash: session.receipt.sourceHash,
        stateVersion,
        origin: session.receipt.allowedOrigin,
        text: `bounded receipt note ${index}`,
        target: { kind: "page" },
      });
      assert.equal(result.status, 200);
    }

    const rejectionIterations = BROWSER_HOST_RECEIPT_LIMITS.rejections + 5;
    for (let index = 0; index < rejectionIterations; index += 1) {
      const rejected = await postRaw(session, "action", "{");
      assert.equal(rejected.status, 400);
    }

    assert.equal(session.receipt.actions.length, BROWSER_HOST_RECEIPT_LIMITS.actions);
    assert.equal(session.receipt.reviewNotes.length, BROWSER_HOST_RECEIPT_LIMITS.reviewNotes);
    assert.equal(session.receipt.rejections.length, BROWSER_HOST_RECEIPT_LIMITS.rejections);
    assert.equal(session.receipt.events.length, BROWSER_HOST_RECEIPT_LIMITS.events);
    assert.equal(session.receipt.actions.at(-1)?.afterVersion, stateVersion);
    assert.equal(session.receipt.reviewNotes.at(-1)?.text, `bounded receipt note ${noteIterations - 1}`);
    assert.equal(session.receipt.rejections.at(-1)?.reason, "Browser host request body must be valid JSON");
    assert.equal(session.receipt.events.at(-1)?.kind, "action_rejected");
    assert.equal(session.receipt.events.at(-1)?.errorCode, "body_invalid_json");
    assert.ok(!session.receipt.reviewNotes.some((note) => note.text === "bounded receipt note 0"));
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function postRaw(
  session: LocalBrowserHostSession,
  endpoint: "action" | "review-note" | "layout-audit",
  body: string,
): Promise<{ status: number; body: Record<string, unknown>; referrerPolicy: string | null; contentTypeOptions: string | null }> {
  const response = await fetch(`${session.receipt.allowedOrigin}/session/${session.receipt.hostSessionId}/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": session.receipt.allowedOrigin,
      "x-pi-canvas-token": session.token,
    },
    body,
  });
  const parsed: unknown = await response.json();
  assert.ok(isRecord(parsed));
  return {
    status: response.status,
    body: parsed,
    referrerPolicy: response.headers.get("referrer-policy"),
    contentTypeOptions: response.headers.get("x-content-type-options"),
  };
}

async function postJson(
  session: LocalBrowserHostSession,
  endpoint: "action" | "review-note" | "layout-audit",
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${session.receipt.allowedOrigin}/session/${session.receipt.hostSessionId}/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": session.receipt.allowedOrigin,
      "x-pi-canvas-token": session.token,
    },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  assert.ok(isRecord(parsed));
  return { status: response.status, body: parsed };
}
