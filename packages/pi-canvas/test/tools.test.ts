import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { BrowserHostSessionManager } from "../src/browser-host.js";
import { createFormCanvasRequest } from "../src/builtin-form-renderer.js";
import { formatBrowserHostReceiptFileName } from "../src/browser-host-receipts.js";
import { isRecord } from "../src/json.js";
import { PiCanvasRuntime } from "../src/runtime.js";
import { createCanvasStore } from "../src/store.js";
import { registerCanvasTools } from "../src/tools.js";

function createCanvasFixture(artifactId: string) {
  return createFormCanvasRequest(artifactId, "Canvas Fixture", {
    components: [{ id: "choice", kind: "single-select", prompt: "Pick one", options: [{ id: "a", title: "Option A" }, { id: "b", title: "Option B" }] }],
  });
}

void test("canvas_render tool owns the TUI render surface instead of the default tool shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create({ artifactId: "demo", title: "Demo", initialState: { message: "Canvas created", createdAt: "2026-06-27", items: [] } });
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const renderTool = tools.get("canvas_render");
  assert.ok(renderTool);
  assert.equal(renderTool.renderShell, "self");

  const result = await renderTool.execute("tool-1", { artifactId: "demo" }, undefined, undefined, makeExtensionContext());
  const text = readFirstText(result);
  const callLines = renderTool.renderCall?.({ artifactId: "demo" }, makeTheme(), makeRenderContext({ artifactId: "demo" })).render(80) ?? [];
  const resultLines = renderTool.renderResult?.(result, makeRenderOptions(), makeTheme(), makeRenderContext({ artifactId: "demo" })).render(80) ?? [];
  const rendered = resultLines.join("\n");

  assert.deepEqual(callLines, []);
  assert.equal(result.terminate, true);
  assert.match(text, /^Rendered canvas demo v1$/m);
  assert.match(rendered, /^pi-canvas: Demo/m);
  assert.match(rendered, /Canvas created/);
  assert.match(rendered, /Created 2026-06-27/);
  assert.match(rendered, /Items +\n  \+-+\+ +\n  \| +\| +\n  \| +No items yet +\|/);
  assert.doesNotMatch(rendered, /canvas_render/);
  assert.doesNotMatch(rendered, /^state$/m);
  assert.doesNotMatch(rendered, /message:|createdAt:|\{"message"/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_render tool surfaces browser-host readiness in text and owned preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create(createCanvasFixture("chooser"));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const renderTool = tools.get("canvas_render");
  assert.ok(renderTool);

  const result = await renderTool.execute("tool-1", { artifactId: "chooser" }, undefined, undefined, makeExtensionContext());
  const text = readFirstText(result);
  const resultLines = renderTool.renderResult?.(result, makeRenderOptions(), makeTheme(), makeRenderContext({ artifactId: "chooser" })).render(80) ?? [];
  const rendered = resultLines.join("\n");

  assert.equal(result.terminate, true);
  assert.match(text, /^Rendered canvas chooser v1$/m);
  assert.match(text, /Browser artifact state: ready - 0\/1 answered, 1 blank, 0 skipped/);
  assert.match(text, /Browser-host readiness: not-presented/);
  assert.match(text, /Browser-host next action: Call canvas_present for this artifact/);
  assert.match(rendered, /^pi-canvas: Canvas Fixture/m);
  assert.match(rendered, /Canvas view requires an adjacent host: browser-host-artifact/);
  assert.match(rendered, /Browser artifact state: ready - 0\/1 answered, 1 blank, 0 skipped/);
  assert.match(rendered, /Browser-host readiness: not-presented/);
  assert.match(rendered, /Browser-host next action: Call canvas_present for this artifact/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_create rejects renderer version mismatches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  assert.ok(createTool);

  await assert.rejects(
    () => createTool.execute("tool-1", { title: "Counter", initialState: { count: 0 }, rendererId: "builtin.counter", rendererVersion: 2 }, undefined, undefined, makeExtensionContext()),
    /Canvas renderer not found: builtin\.counter v2/,
  );

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_browser_artifacts lists governed browser artifact playbooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const catalogTool = tools.get("canvas_browser_artifacts");
  assert.ok(catalogTool);
  assert.ok(catalogTool.promptGuidelines?.some((guideline) => guideline.includes("inventing arbitrary HTML")));

  const catalog = await catalogTool.execute("tool-1", {}, undefined, undefined, makeExtensionContext());
  const text = readFirstText(catalog);
  assert.match(text, /Browser artifact catalog/);
  assert.match(text, /builtin\.canvas v1 - Canvas/);
  assert.match(text, /canonical Pi state/);
  assert.match(text, /Layer: browser-host-artifact; state: canvas_read; evidence: browser-host-receipts/);
  assert.match(text, /Canonical state:/);
  assert.match(text, /Agent action:/);
  assert.match(text, /Create: canvas_create\(\{"title":"<title>","form":/);
  const details = catalog.details;
  assert.ok(isRecord(details));
  assert.ok(Array.isArray(details.artifacts));
  // ADR 0004: one actable substrate — the catalog lists only builtin.canvas.
  assert.equal(details.artifacts.length, 1);
  const form = details.artifacts.find((artifact) => isRecord(artifact) && artifact.rendererId === "builtin.canvas");
  assert.ok(isRecord(form));
  assert.equal(form.layer, "browser-host-artifact");
  assert.equal(form.patternId, "builtin.canvas");
  assert.equal(form.stateAuthority, "canvas_read");
  assert.equal(form.evidenceAuthority, "browser-host-receipts");
  assert.ok(isRecord(form.playbook));
  assert.equal(form.playbook.id, "builtin.canvas");
  assert.ok(Array.isArray(form.create));
  const formCreate = form.create.find((hint) => isRecord(hint) && hint.tool === "canvas_create");
  assert.ok(isRecord(formCreate));
  assert.ok(isRecord(formCreate.params));
  assert.equal(typeof formCreate.params.form, "string");
  assert.ok(isRecord(form.capabilities));
  // The preset shorthand does not require raw surfaceKind/browserRendererId.
  assert.equal(formCreate.params.surfaceKind, undefined);
  assert.equal(formCreate.params.browserRendererId, undefined);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_create form shorthand fans widgets into declared paths and reads back via formReadback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const create = tools.get("canvas_create");
  assert.ok(create);
  await create.execute(
    "tc-form-1",
    {
      artifactId: "form-demo",
      title: "Settings review",
      form: {
        components: [
          { id: "layout", kind: "single-select", prompt: "Layout", required: true, options: [{ id: "a", title: "Sidebar" }, { id: "b", title: "Tabs" }] },
          { id: "extras", kind: "multi-select", prompt: "Extras", options: [{ id: "x", title: "X" }, { id: "y", title: "Y" }] },
        ],
      },
    },
    undefined,
    undefined,
    makeExtensionContext(),
  );

  const readback = await runtime.read("form-demo");
  assert.ok(readback);
  assert.deepEqual(
    readback.source.actions.map((action) => action.path).sort(),
    ["components.extras", "components.layout", "form.submitted"],
  );

  const readTool = tools.get("canvas_read");
  assert.ok(readTool);
  const result = await readTool.execute("tc-form-2", { artifactId: "form-demo" }, undefined, undefined, makeExtensionContext());
  const details = result.details;
  assert.ok(isRecord(details));
  const browserHost = details.browserHost;
  assert.ok(isRecord(browserHost));
  const artifactState = browserHost.artifactState;
  assert.ok(isRecord(artifactState));
  const fields = artifactState.fields;
  assert.ok(isRecord(fields));
  const formReadback = fields.formReadback;
  assert.ok(isRecord(formReadback));
  const rollup = formReadback.rollup;
  assert.ok(isRecord(rollup));
  assert.equal(rollup.total, 2);
  assert.deepEqual(rollup.requiredRemaining, ["layout"]);
  const components = formReadback.components;
  assert.ok(Array.isArray(components));
  const layout = components.find((component) => isRecord(component) && component.id === "layout");
  assert.ok(isRecord(layout));
  assert.equal(layout.status, "untouched");
  assert.deepEqual(layout.blank, ["a", "b"]);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_create accepts the optionChooser preset shorthand and composes a canvas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  assert.ok(createTool);
  assert.match(createTool.promptSnippet ?? "", /browser-host readiness/);

  const created = await createTool.execute(
    "tool-1",
    {
      artifactId: "generic-chooser",
      title: "Choose artifact direction",
      optionChooser: {
        options: [
          { id: "chooser", title: "Chooser", detail: "Bounded decision picker." },
          { id: "kanban", title: "Kanban", detail: "Control-panel steering." },
        ],
      },
    },
    undefined,
    undefined,
    makeExtensionContext([], cwd),
  );

  const createdText = readFirstText(created);
  assert.match(createdText, /Created canvas generic-chooser v1/);
  assert.match(createdText, /Browser artifact state: pending - 0\/1 answered, 1 blank, 0 skipped, required-remaining: choice/);
  assert.match(createdText, /Browser-host readiness: not-presented/);
  assert.match(createdText, /Playbook: Composable form/);
  assert.ok(isRecord(created.details));
  assert.ok(isRecord(created.details.browserHost));
  assert.ok(isRecord(created.details.browserHost.artifactState));
  assert.equal(created.details.browserHost.artifactState.kind, "form");
  assert.equal(created.details.browserHost.artifactState.status, "pending");
  assert.ok(Array.isArray(created.details.nextSteps));
  assert.ok(created.details.nextSteps.some((step) => typeof step === "string" && step.includes("Call canvas_present with artifactId generic-chooser")));
  assert.ok(created.details.nextSteps.every((step) => typeof step !== "string" || !step.includes("Open the live browser-host URL locally")));

  const readback = await runtime.read("generic-chooser");
  assert.equal(readback?.source.title, "Choose artifact direction");
  assert.equal(readback?.source.view?.kind, "browser-host-artifact");
  assert.equal(readback?.source.view?.kind === "browser-host-artifact" ? readback.source.view.rendererId : undefined, "builtin.canvas");
  assert.match(JSON.stringify(readback?.source.view?.kind === "browser-host-artifact" ? readback.source.view.props : undefined), /chooser/);
  assert.match(JSON.stringify(readback?.source.view?.kind === "browser-host-artifact" ? readback.source.view.props : undefined), /kanban/);
  assert.match(JSON.stringify(readback?.state.state), /"submitted":false/);
  assert.match(JSON.stringify(readback?.state.state), /choice/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas form tools create, present, affirm, submit, and read a governed browser host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  const presentTool = tools.get("canvas_present");
  const readTool = tools.get("canvas_read");
  const exportTool = tools.get("canvas_export");
  assert.ok(createTool);
  assert.ok(presentTool);
  assert.ok(readTool);
  assert.ok(exportTool);
  assert.ok(presentTool.promptGuidelines?.some((guideline) => guideline.includes("canonical state comes from canvas_read")));

  const created = await createTool.execute("tool-1", { artifactId: "chooser", title: "Choose a mock direction", optionChooser: {} }, undefined, undefined, makeExtensionContext([], cwd));
  assert.match(readFirstText(created), /Created canvas chooser v1/);
  assert.match(readFirstText(created), /Playbook: Composable form/);
  assert.match(readFirstText(created), /Canonical state:/);
  assert.match(readFirstText(created), /Agent action:/);
  assert.match(readFirstText(created), /Browser artifact state: pending - 0\/1 answered, 1 blank, 0 skipped, required-remaining: choice/);
  assert.match(readFirstText(created), /Browser-host readiness: not-presented/);
  assert.match(readFirstText(created), /Next steps:/);
  assert.match(readFirstText(created), /Call canvas_present with artifactId chooser/);
  assert.match(readFirstText(created), /call canvas_read with artifactId chooser/);
  assert.doesNotMatch(readFirstText(created), /Open the live browser-host URL locally/);
  const createdDetails = created.details;
  assert.ok(isRecord(createdDetails));
  assert.ok(isRecord(createdDetails.playbook));
  assert.equal(createdDetails.playbook.id, "builtin.canvas");
  assert.ok(isRecord(createdDetails.browserHost));
  assert.ok(isRecord(createdDetails.browserHost.artifactState));
  assert.equal(createdDetails.browserHost.artifactState.kind, "form");
  assert.equal(createdDetails.browserHost.artifactState.status, "pending");
  assert.ok(isRecord(createdDetails.browserHost.readiness));
  assert.equal(createdDetails.browserHost.readiness.status, "not-presented");

  const presented = await presentTool.execute("tool-2", { artifactId: "chooser" }, undefined, undefined, makeExtensionContext([], cwd));
  const presentedText = readFirstText(presented);
  assert.match(presentedText, /Browser host session available for chooser/);
  assert.doesNotMatch(presentedText, /^Browser host ready/m);
  assert.match(presentedText, /Presentation policy: local-loopback, transient-session, token-bearing; share policy: do-not-paste-persist-or-share; state: canvas_read; evidence: browser-host-receipts/);
  assert.match(presentedText, /Playbook: Composable form/);
  assert.match(presentedText, /Canonical state:/);
  assert.match(presentedText, /Agent action:/);
  assert.match(presentedText, /Avoid when:/);
  assert.match(presentedText, /Quality gates:/);
  assert.match(presentedText, /Browser artifact state: pending - 0\/1 answered, 1 blank, 0 skipped, required-remaining: choice/);
  assert.match(presentedText, /Browser-host readiness: pending/);
  assert.match(presentedText, /Next steps:/);
  assert.match(presentedText, /call canvas_read with artifactId chooser/);
  assert.match(presentedText, /Do not infer canonical state from browser DOM/);
  const details = presented.details;
  assert.ok(isRecord(details));
  assert.ok(isRecord(details.browserHost));
  assert.ok(isRecord(details.browserHost.playbook));
  assert.ok(isRecord(details.browserHost.artifactState));
  assert.ok(isRecord(details.browserHost.presentationPolicy));
  assert.equal(details.browserHost.presentationPolicy.urlScope, "local-loopback");
  assert.equal(details.browserHost.presentationPolicy.stateAuthority, "canvas_read");
  assert.equal(details.browserHost.presentationPolicy.evidenceAuthority, "browser-host-receipts");
  assert.equal(details.browserHost.artifactState.kind, "form");
  assert.ok(isRecord(details.browserHost.readiness));
  assert.equal(details.browserHost.readiness.status, "pending");
  assert.equal(details.browserHost.playbook.id, "builtin.canvas");
  assert.ok(Array.isArray(details.browserHost.nextSteps));
  assert.ok(details.browserHost.nextSteps.some((step) => typeof step === "string" && step.includes("Open the live browser-host URL locally")));
  assert.ok(details.browserHost.nextSteps.some((step) => typeof step === "string" && step.includes("canvas_export")));
  const url = details.browserHost.url;
  if (typeof url !== "string") throw new Error("browserHost.url must be a string");
  const presentedRender = presentTool.renderResult?.(presented, makeRenderOptions(), makeTheme(), makeRenderContext({ artifactId: "chooser" })).render(100).join("\n") ?? "";
  assert.match(presentedRender, /^pi-canvas: Choose a mock direction/m);
  assert.match(presentedRender, /Browser artifact state: pending - 0\/1 answered, 1 blank, 0 skipped, required-remaining: choice/);
  assert.match(presentedRender, /Browser host session available for chooser/);
  assert.match(presentedRender, /http:\/\/127\.0\.0\.1|http:\/\/localhost/);
  assert.match(presentedRender, /Open the live browser-host URL locally/);
  assert.match(presentedRender, /Receipt:/);
  assert.ok(isRecord(details.browserHost.receipt));
  const receipt = details.browserHost.receipt;
  const receiptPath = receipt.receiptPath;
  const signedUrl = receipt.signedUrl;
  const sourceHash = receipt.sourceHash;
  const hostSessionId = receipt.hostSessionId;
  if (typeof receiptPath !== "string") throw new Error("browserHost.receipt.receiptPath must be a string");
  if (typeof signedUrl !== "string") throw new Error("browserHost.receipt.signedUrl must be a string");
  if (typeof sourceHash !== "string") throw new Error("browserHost.receipt.sourceHash must be a string");
  if (typeof receipt.finalStateVersion !== "number") throw new Error("browserHost.receipt.finalStateVersion must be a number");
  if (typeof hostSessionId !== "string") throw new Error("browserHost.receipt.hostSessionId must be a string");
  assert.match(receiptPath, /artifact-7-chooser-/);
  assert.match(receiptPath, /source-[0-9a-f]{16}-/);
  assert.doesNotMatch(signedUrl, /token=/);
  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token");
  if (!token) throw new Error("browserHost.url must include a live token");

  const html = await (await fetch(url)).text();
  assert.match(html, /composable-form/);
  assert.match(html, /Choose a mock direction/);
  assert.match(html, /pi-canvas-review-dock/);

  // Affirm option-a on the required single-select, then submit the form via the canvas envelope.
  const affirmResponse = await fetch(`${parsedUrl.origin}/session/${hostSessionId}/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: hostSessionId,
      sourceHash,
      stateVersion: receipt.finalStateVersion,
      origin: parsedUrl.origin,
      action: { componentId: "choice", op: "affirm", optionId: "option-a" },
    }),
  });
  const affirmResult: unknown = await affirmResponse.json();
  if (!isRecord(affirmResult)) throw new Error("affirm action response must be an object");
  assert.equal(affirmResponse.ok, true);
  assert.equal(affirmResult.stateVersion, 2);
  assert.match(JSON.stringify((await runtime.read("chooser"))?.state.state), /"option-a":"affirm"/);
  const submitResponse = await fetch(`${parsedUrl.origin}/session/${hostSessionId}/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: hostSessionId,
      sourceHash,
      stateVersion: 2,
      origin: parsedUrl.origin,
      action: { op: "submit" },
    }),
  });
  const submitResult: unknown = await submitResponse.json();
  if (!isRecord(submitResult)) throw new Error("submit action response must be an object");
  assert.equal(submitResponse.ok, true);
  assert.equal(submitResult.stateVersion, 3);
  const currentVersion = 3;

  const reviewResponse = await fetch(`${parsedUrl.origin}/session/${hostSessionId}/review-note`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: hostSessionId,
      sourceHash,
      stateVersion: currentVersion,
      origin: parsedUrl.origin,
      text: "Review from tools test",
      target: { kind: "element", testId: "opt-choice-option-b", selector: "[data-testid=\"opt-choice-option-b\"]", text: "Option B review target" },
    }),
  });
  const reviewResult: unknown = await reviewResponse.json();
  if (!isRecord(reviewResult)) throw new Error("review note response must be an object");
  assert.equal(reviewResponse.ok, true);
  assert.equal(reviewResult.reviewNoteCount, 1);
  const layoutAuditResponse = await fetch(`${parsedUrl.origin}/session/${hostSessionId}/layout-audit`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: hostSessionId,
      sourceHash,
      stateVersion: currentVersion,
      origin: parsedUrl.origin,
      findings: [{ kind: "page-horizontal-overflow", selector: "html", severity: "error", overflowPx: 12, viewportWidth: 390, viewportHeight: 844 }],
    }),
  });
  const layoutAuditResult: unknown = await layoutAuditResponse.json();
  if (!isRecord(layoutAuditResult)) throw new Error("layout audit response must be an object");
  assert.equal(layoutAuditResponse.ok, true);
  assert.equal(layoutAuditResult.errorCount, 1);
  const rejectedLayoutAudit = await fetch(`${parsedUrl.origin}/session/${hostSessionId}/layout-audit`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": "wrong-token" },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: hostSessionId,
      sourceHash,
      stateVersion: currentVersion,
      origin: parsedUrl.origin,
      findings: [],
    }),
  });
  assert.equal(rejectedLayoutAudit.ok, false);
  const receiptText = await readFile(receiptPath, "utf-8");
  assert.match(receiptText, /Review from tools test/);
  assert.match(receiptText, /"targetKey": "element:testId:opt-choice-option-b"/);
  assert.match(receiptText, /review_note_recorded/);
  assert.match(receiptText, /layout_audit_recorded/);
  assert.match(receiptText, /layout_audit_rejected/);
  assert.doesNotMatch(await readFile(receiptPath, "utf-8"), /token=/);
  await writeFile(
    join(dir, "browser-host-receipts", "foreign-browser-host-receipt.json"),
    `${JSON.stringify({
      artifactId: "chooser",
      hostSessionId: "bhost-foreign",
      receiptPath: join(dir, "browser-host-receipts", "foreign-browser-host-receipt.json"),
      sourcePath: "/tmp/other-project/artifacts/chooser/canvas.source.json",
      openedAt: "2026-06-27T00:00:00.000Z",
      finalStateVersion: 1,
      status: "closed",
      actions: [],
      reviewNotes: [{ id: "foreign", text: "foreign note must not leak", target: { kind: "page" }, sourceHash, stateVersion: 1, origin: parsedUrl.origin, createdAt: "2026-06-27T00:00:00.000Z" }],
      events: [],
    })}\n`,
    "utf-8",
  );
  const read = await readTool.execute("tool-3", { artifactId: "chooser" }, undefined, undefined, makeExtensionContext([], cwd));
  const readText = readFirstText(read);
  assert.match(readText, /Browser artifact pattern: Composable form.*\(builtin\.canvas\)/);
  assert.match(readText, /Authority contract: layer browser-host-artifact; state canvas_read; evidence browser-host-receipts/);
  assert.match(readText, /Canonical state contract: Pi owns per-widget answers under components/);
  assert.match(readText, /Agent action contract: canvas_create with a form payload/);
  assert.match(readText, /Browser artifact state: ready - 1\/1 answered, 0 blank, 0 skipped/);
  assert.match(readText, /Browser-host review notes: 1/);
  assert.match(readText, /Review annotations: 1 note across 1 target/);
  assert.match(readText, /Review annotation targets: element:testId:opt-choice-option-b \(1\)/);
  assert.match(readText, /Latest review annotation: element:testId:opt-choice-option-b - Review from tools test/);
  assert.match(readText, /Browser-host layout audits: 1 \(1 errors\)/);
  assert.match(readText, /Browser-host readiness: blocked/);
  assert.match(readText, /Latest review note: Review from tools test/);
  assert.match(readText, /Latest review target: element opt-choice-option-b - Option B review target/);
  assert.match(readText, /element:testId:opt-choice-option-b/);
  assert.match(readText, /Latest layout audit: 1 errors, 0 warnings/);
  assert.match(readText, /Latest layout finding: page-horizontal-overflow html error overflow=12px 390x844/);
  assert.doesNotMatch(readText, /foreign note/);
  const readDetails = read.details;
  assert.ok(isRecord(readDetails));
  assert.ok(isRecord(readDetails.playbook));
  assert.equal(readDetails.playbook.id, "builtin.canvas");
  assert.ok(isRecord(readDetails.browserHost));
  assert.ok(isRecord(readDetails.browserHost.artifactPattern));
  assert.equal(readDetails.browserHost.artifactPattern.layer, "browser-host-artifact");
  assert.equal(readDetails.browserHost.artifactPattern.playbookId, "builtin.canvas");
  assert.equal(readDetails.browserHost.artifactPattern.stateAuthority, "canvas_read");
  assert.equal(readDetails.browserHost.artifactPattern.evidenceAuthority, "browser-host-receipts");
  assert.match(String(readDetails.browserHost.artifactPattern.canonicalState), /components/);
  assert.ok(isRecord(readDetails.browserHost.artifactState));
  assert.equal(readDetails.browserHost.artifactState.kind, "form");
  assert.equal(readDetails.browserHost.artifactState.status, "ready");
  assert.ok(isRecord(readDetails.browserHost.artifactState.fields));
  const formReadback = readDetails.browserHost.artifactState.fields.formReadback;
  assert.ok(isRecord(formReadback));
  assert.equal(formReadback.submitted, true);
  assert.ok(Array.isArray(formReadback.components));
  assert.ok(isRecord(formReadback.components[0]));
  assert.deepEqual(formReadback.components[0].affirmed, ["option-a"]);
  assert.ok(isRecord(readDetails.browserHost.readiness));
  assert.equal(readDetails.browserHost.readiness.status, "blocked");
  assert.ok(Array.isArray(readDetails.browserHost.reviewNotes));
  assert.ok(isRecord(readDetails.browserHost.reviewAnnotations));
  assert.equal(readDetails.browserHost.reviewAnnotations.total, 1);
  assert.equal(readDetails.browserHost.reviewAnnotations.targetCount, 1);
  assert.ok(Array.isArray(readDetails.browserHost.reviewAnnotations.targets));
  assert.ok(readDetails.browserHost.reviewAnnotations.targets.some((target) => isRecord(target) && target.targetKey === "element:testId:opt-choice-option-b" && target.count === 1));
  assert.ok(Array.isArray(readDetails.browserHost.reviewAnnotations.recent));
  assert.ok(readDetails.browserHost.reviewAnnotations.recent.some((note) => isRecord(note) && note.text === "Review from tools test" && note.targetKey === "element:testId:opt-choice-option-b"));
  assert.ok(Array.isArray(readDetails.browserHost.layoutAudits));
  assert.ok(readDetails.browserHost.reviewNotes.some((note) => isRecord(note) && note.text === "Review from tools test"));
  assert.ok(readDetails.browserHost.reviewNotes.some((note) => isRecord(note) && note.targetKey === "element:testId:opt-choice-option-b"));
  assert.ok(readDetails.browserHost.layoutAudits.some((audit) => isRecord(audit) && audit.errorCount === 1));
  assert.ok(!readDetails.browserHost.reviewNotes.some((note) => isRecord(note) && note.text === "foreign note must not leak"));
  assert.ok(isRecord(readDetails.canvas));
  assert.doesNotMatch(JSON.stringify(readDetails.canvas), /Review from tools test/);
  const exported = await exportTool.execute("tool-4", { artifactId: "chooser" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.match(readFirstText(exported), /Browser-host evidence:/);
  assert.match(readFirstText(exported), /Review annotations: 1 note across 1 target/);
  assert.match(readFirstText(exported), /Browser-host readiness: blocked/);
  const exportDetails = exported.details;
  assert.ok(isRecord(exportDetails));
  assert.ok(isRecord(exportDetails.browserHost));
  assert.ok(isRecord(exportDetails.browserHost.readiness));
  assert.equal(exportDetails.browserHost.readiness.status, "blocked");
  const evidencePath = exportDetails.browserHost.evidencePath;
  if (typeof evidencePath !== "string") throw new Error("browserHost.evidencePath must be a string");
  const evidenceText = await readFile(evidencePath, "utf-8");
  assert.match(evidenceText, /"artifactPattern"/);
  assert.match(evidenceText, /"layer": "browser-host-artifact"/);
  assert.match(evidenceText, /"stateAuthority": "canvas_read"/);
  assert.match(evidenceText, /"evidenceAuthority": "browser-host-receipts"/);
  assert.match(evidenceText, /"artifactState"/);
  assert.match(evidenceText, /"formReadback"/);
  assert.match(evidenceText, /"playbookId": "builtin.canvas"/);
  assert.match(evidenceText, /"canonicalState": "Pi owns per-widget answers under components/);
  assert.match(evidenceText, /"agentAction": "canvas_create with a form payload/);
  assert.match(evidenceText, /"reviewAnnotations"/);
  assert.match(evidenceText, /"targetCount": 1/);
  assert.match(evidenceText, /"latestText": "Review from tools test"/);
  assert.match(evidenceText, /Review from tools test/);
  assert.match(evidenceText, /"targetKey": "element:testId:opt-choice-option-b"/);
  assert.match(evidenceText, /page-horizontal-overflow/);
  assert.match(evidenceText, /"status": "blocked"/);
  assert.match(evidenceText, /"readyForHandoff": false/);
  assert.doesNotMatch(evidenceText, /foreign note must not leak/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_update is rejected on a browser canvas; a direct write surfaces stale browser-host evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  const presentTool = tools.get("canvas_present");
  const updateTool = tools.get("canvas_update");
  const readTool = tools.get("canvas_read");
  assert.ok(createTool);
  assert.ok(presentTool);
  assert.ok(updateTool);
  assert.ok(readTool);

  await createTool.execute("tool-create", { artifactId: "update-stale", title: "Update stale", optionChooser: {} }, undefined, undefined, makeExtensionContext([], cwd));
  await presentTool.execute("tool-present", { artifactId: "update-stale" }, undefined, undefined, makeExtensionContext([], cwd));

  // A browser-host canvas is human-write-only: canvas_update rejects agent-side writes to it (ADR 0004 trust model).
  await assert.rejects(
    updateTool.execute("tool-update", { artifactId: "update-stale", path: "form.submitted", value: true, actor: "test" }, undefined, undefined, makeExtensionContext([], cwd)),
    /human commits answers in the browser session|create a new canvas/,
  );

  // Force canonical state to v2 the way the browser action path does — a direct runtime.update that
  // bypasses the tool guard — so the presented receipt (v1) goes stale and canvas_read surfaces it.
  await runtime.update({ artifactId: "update-stale", path: "form.submitted", value: true, actor: "test-preempt" });

  const read = await readTool.execute("tool-read", { artifactId: "update-stale" }, undefined, undefined, makeExtensionContext([], cwd));
  const text = readFirstText(read);
  assert.match(text, /Browser-host readiness: stale/);
  assert.match(text, /Latest browser-host receipt is for state v1, but canonical state is v2/);
  assert.match(text, /Browser-host next action: Call canvas_present to refresh the browser host/);
  assert.ok(isRecord(read.details));
  assert.ok(isRecord(read.details.browserHost));
  assert.ok(isRecord(read.details.browserHost.readiness));
  assert.equal(read.details.browserHost.readiness.status, "stale");
  assert.equal(read.details.browserHost.readiness.readyForHandoff, false);
  assert.ok(isRecord(read.details.browserHost.artifactPattern));
  assert.equal(read.details.browserHost.artifactPattern.playbookId, "builtin.canvas");

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host canvas is human-write-only: canvas_update rejects answer + submit paths, terminal canvas stays writable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  const updateTool = tools.get("canvas_update");
  assert.ok(createTool);
  assert.ok(updateTool);

  await createTool.execute(
    "c1",
    { artifactId: "hw", title: "HW", form: { components: [{ id: "choice", kind: "single-select", prompt: "Pick", required: true, options: [{ id: "a", title: "A" }, { id: "b", title: "B" }] }] } },
    undefined,
    undefined,
    makeExtensionContext([], cwd),
  );
  // The submit gate and an answer widget are both rejected — every declared path is an answer path.
  await assert.rejects(
    updateTool.execute("u1", { artifactId: "hw", path: "form.submitted", value: true }, undefined, undefined, makeExtensionContext([], cwd)),
    /create a new canvas/,
  );
  await assert.rejects(
    updateTool.execute("u2", { artifactId: "hw", path: "components.choice", value: { kind: "single-select", selections: { a: "affirm" }, value: null, unsure: false, skipped: false, note: null, confirmed: false, confirmedSignature: null } }, undefined, undefined, makeExtensionContext([], cwd)),
    /create a new canvas/,
  );
  // Nothing was forged — canonical state is still v1.
  const rb = await runtime.read("hw");
  assert.equal(rb?.state.version, 1);

  // A terminal canvas (updatePolicy defaults to "open") remains writable via canvas_update.
  await runtime.create({ artifactId: "term", title: "Term", initialState: { value: 0 } });
  const t = await updateTool.execute("u3", { artifactId: "term", path: "value", value: 42 }, undefined, undefined, makeExtensionContext([], cwd));
  assert.match(readFirstText(t), /Updated canvas term to v2/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_read and export surface unreadable browser-host receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const readTool = tools.get("canvas_read");
  const exportTool = tools.get("canvas_export");
  assert.ok(readTool);
  assert.ok(exportTool);
  const corruptReadback = await runtime.create(createCanvasFixture("corrupt-receipt"));
  const receiptDir = join(dir, "browser-host-receipts");
  await mkdir(receiptDir, { recursive: true });
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("corrupt-receipt", "corrupt", corruptReadback.paths.sourcePath)), '{"id":', "utf-8");
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("corrupt-receipt", "other-source", "/tmp/other-project/artifacts/corrupt-receipt/canvas.source.json")), '{"id":', "utf-8");
  await writeFile(join(receiptDir, formatBrowserHostReceiptFileName("other-artifact", "corrupt", corruptReadback.paths.sourcePath)), '{"id":', "utf-8");
  await writeFile(join(receiptDir, "legacy-unscoped-browser-host-receipt.json"), '{"id":', "utf-8");

  const read = await readTool.execute("tool-read", { artifactId: "corrupt-receipt" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.match(readFirstText(read), /Browser-host receipt read errors: 1/);
  assert.match(readFirstText(read), /Browser-host readiness: blocked/);
  assert.ok(isRecord(read.details));
  assert.ok(isRecord(read.details.browserHost));
  assert.ok(isRecord(read.details.browserHost.readiness));
  assert.equal(read.details.browserHost.readiness.status, "blocked");
  assert.equal(read.details.browserHost.readiness.readyForHandoff, false);
  assert.ok(Array.isArray(read.details.browserHost.receiptReadErrors));
  assert.equal(read.details.browserHost.receiptReadErrors.length, 1);
  assert.equal(isRecord(read.details.browserHost.receiptReadErrors[0]) ? read.details.browserHost.receiptReadErrors[0].reason : undefined, "invalid-json");

  const exported = await exportTool.execute("tool-export", { artifactId: "corrupt-receipt" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.match(readFirstText(exported), /Browser-host receipt read errors: 1/);
  assert.match(readFirstText(exported), /Browser-host readiness: blocked/);
  assert.ok(isRecord(exported.details));
  assert.ok(isRecord(exported.details.browserHost));
  const evidencePath = exported.details.browserHost.evidencePath;
  if (typeof evidencePath !== "string") throw new Error("browserHost.evidencePath must be a string");
  const evidenceText = await readFile(evidencePath, "utf-8");
  assert.match(evidenceText, /"receiptReadErrors"/);
  assert.match(evidenceText, /"reason": "invalid-json"/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_present owned render preserves browser-host eligibility errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const presentTool = tools.get("canvas_present");
  assert.ok(presentTool);

  const result = await presentTool.execute("tool-1", { artifactId: "demo" }, undefined, undefined, makeExtensionContext());
  const rendered = presentTool.renderResult?.(result, makeRenderOptions(), makeTheme(), makeRenderContext({ artifactId: "demo" })).render(80).join("\n") ?? "";

  assert.match(readFirstText(result), /Canvas does not declare a browser-host view: demo/);
  assert.match(rendered, /^pi-canvas: Demo/m);
  assert.match(rendered, /Canvas does not declare a browser-host view: demo/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_update exposes optimistic locking to model callers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const created = await runtime.create({ artifactId: "cas-update", title: "CAS Update", initialState: { value: 0 } });
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const updateTool = tools.get("canvas_update");
  assert.ok(updateTool);

  const updated = await updateTool.execute(
    "tool-update",
    {
      artifactId: "cas-update",
      path: "value",
      value: 1,
      expectedSourceHash: created.state.sourceHash,
      expectedStateVersion: created.state.version,
    },
    undefined,
    undefined,
    makeExtensionContext([], cwd),
  );

  assert.match(readFirstText(updated), /Updated canvas cas-update to v2/);
  await assert.rejects(
    () =>
      updateTool.execute(
        "tool-stale",
        {
          artifactId: "cas-update",
          path: "value",
          value: 2,
          expectedSourceHash: created.state.sourceHash,
          expectedStateVersion: created.state.version,
        },
        undefined,
        undefined,
        makeExtensionContext([], cwd),
      ),
    /Canvas stale state version: 1 != 2/,
  );

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_present restarts a stale browser host after canonical state changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  const presentTool = tools.get("canvas_present");
  assert.ok(createTool);
  assert.ok(presentTool);

  await createTool.execute("tool-1", { artifactId: "chooser", title: "Choose a mock direction", optionChooser: {} }, undefined, undefined, makeExtensionContext([], cwd));
  const firstPresent = await presentTool.execute("tool-2", { artifactId: "chooser" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.ok(isRecord(firstPresent.details));
  assert.ok(isRecord(firstPresent.details.browserHost));
  assert.ok(isRecord(firstPresent.details.browserHost.receipt));
  const firstReceipt = firstPresent.details.browserHost.receipt;
  const firstUrl = firstPresent.details.browserHost.url;
  if (typeof firstUrl !== "string") throw new Error("first browserHost.url must be a string");
  if (typeof firstReceipt.hostSessionId !== "string") throw new Error("first hostSessionId must be a string");
  if (typeof firstReceipt.receiptPath !== "string") throw new Error("first receiptPath must be a string");
  if (typeof firstReceipt.sourceHash !== "string") throw new Error("first sourceHash must be a string");
  if (typeof firstReceipt.finalStateVersion !== "number") throw new Error("first finalStateVersion must be a number");

  await runtime.update({ artifactId: "chooser", path: "form.submitted", value: true, actor: "test" });

  const firstParsedUrl = new URL(firstUrl);
  const firstToken = firstParsedUrl.searchParams.get("token");
  if (!firstToken) throw new Error("first browserHost.url must include a live token");
  const staleReviewResponse = await fetch(`${firstParsedUrl.origin}/session/${String(firstReceipt.hostSessionId)}/review-note`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": firstParsedUrl.origin, "x-pi-canvas-token": firstToken },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: firstReceipt.hostSessionId,
      sourceHash: firstReceipt.sourceHash,
      stateVersion: firstReceipt.finalStateVersion,
      origin: firstParsedUrl.origin,
      text: "Review from stale browser should not land",
      target: { kind: "page" },
    }),
  });
  const staleReviewResult: unknown = await staleReviewResponse.json();
  if (!isRecord(staleReviewResult)) throw new Error("stale browser review response must be an object");
  assert.equal(staleReviewResponse.ok, false);
  assert.equal(staleReviewResult.errorCode, "state_version_stale");
  const staleLayoutResponse = await fetch(`${firstParsedUrl.origin}/session/${String(firstReceipt.hostSessionId)}/layout-audit`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": firstParsedUrl.origin, "x-pi-canvas-token": firstToken },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: firstReceipt.hostSessionId,
      sourceHash: firstReceipt.sourceHash,
      stateVersion: firstReceipt.finalStateVersion,
      origin: firstParsedUrl.origin,
      findings: [],
    }),
  });
  const staleLayoutResult: unknown = await staleLayoutResponse.json();
  if (!isRecord(staleLayoutResult)) throw new Error("stale browser layout response must be an object");
  assert.equal(staleLayoutResponse.ok, false);
  assert.equal(staleLayoutResult.errorCode, "state_version_stale");
  const staleActionResponse = await fetch(`${firstParsedUrl.origin}/session/${String(firstReceipt.hostSessionId)}/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": firstParsedUrl.origin, "x-pi-canvas-token": firstToken },
    body: JSON.stringify({
      artifactId: "chooser",
      sessionId: firstReceipt.hostSessionId,
      sourceHash: firstReceipt.sourceHash,
      stateVersion: firstReceipt.finalStateVersion,
      origin: firstParsedUrl.origin,
      action: { componentId: "choice", op: "affirm", optionId: "option-a" },
    }),
  });
  const staleActionResult: unknown = await staleActionResponse.json();
  if (!isRecord(staleActionResult)) throw new Error("stale browser action response must be an object");
  assert.equal(staleActionResponse.ok, false);
  assert.equal(staleActionResult.errorCode, "state_version_stale");
  const staleReceiptParsed: unknown = JSON.parse(await readFile(firstReceipt.receiptPath, "utf-8"));
  if (!isRecord(staleReceiptParsed)) throw new Error("stale receipt must be an object");
  assert.equal(staleReceiptParsed.finalStateVersion, 1);
  const staleReceiptJson = JSON.stringify(staleReceiptParsed);
  assert.match(staleReceiptJson, /"errorCode":"state_version_stale"/);
  assert.match(staleReceiptJson, /"kind":"review_note_rejected"/);
  assert.match(staleReceiptJson, /"kind":"layout_audit_rejected"/);
  assert.doesNotMatch(staleReceiptJson, /"reviewNotes":\[\{"id"/);
  assert.doesNotMatch(staleReceiptJson, /"layoutAudits":\[\{"id"/);

  const secondPresent = await presentTool.execute("tool-3", { artifactId: "chooser" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.ok(isRecord(secondPresent.details));
  assert.ok(isRecord(secondPresent.details.browserHost));
  assert.ok(isRecord(secondPresent.details.browserHost.receipt));
  const secondReceipt = secondPresent.details.browserHost.receipt;
  assert.notEqual(secondReceipt.hostSessionId, firstReceipt.hostSessionId);
  assert.equal(secondReceipt.initialStateVersion, 2);
  assert.equal(secondReceipt.finalStateVersion, 2);
  const firstReceiptText = await readFile(firstReceipt.receiptPath, "utf-8");
  assert.match(firstReceiptText, /"status": "closed"/);
  assert.match(firstReceiptText, /"kind": "session_closed"/);

  await rm(dir, { recursive: true, force: true });
});

void test("browser-host readiness treats same-version source hash mismatch as stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const presentTool = tools.get("canvas_present");
  const readTool = tools.get("canvas_read");
  const exportTool = tools.get("canvas_export");
  assert.ok(presentTool);
  assert.ok(readTool);
  assert.ok(exportTool);

  await runtime.create(createCanvasFixture("source-stale"));
  const presented = await presentTool.execute("tool-2", { artifactId: "source-stale" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.ok(isRecord(presented.details));
  assert.ok(isRecord(presented.details.browserHost));
  assert.ok(isRecord(presented.details.browserHost.receipt));
  const receipt = presented.details.browserHost.receipt;
  const url = presented.details.browserHost.url;
  if (typeof url !== "string") throw new Error("browserHost.url must be a string");
  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token");
  if (!token) throw new Error("browserHost.url must include a live token");
  if (typeof receipt.hostSessionId !== "string") throw new Error("hostSessionId must be a string");
  if (typeof receipt.sourceHash !== "string") throw new Error("sourceHash must be a string");
  if (typeof receipt.sourcePath !== "string") throw new Error("sourcePath must be a string");
  if (typeof receipt.receiptPath !== "string") throw new Error("receiptPath must be a string");
  if (typeof receipt.finalStateVersion !== "number") throw new Error("finalStateVersion must be a number");

  const confirmResponse = await fetch(`${parsedUrl.origin}/session/${String(receipt.hostSessionId)}/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
    body: JSON.stringify({
      artifactId: "source-stale",
      sessionId: receipt.hostSessionId,
      sourceHash: receipt.sourceHash,
      stateVersion: receipt.finalStateVersion,
      origin: parsedUrl.origin,
      action: { componentId: "choice", op: "affirm", optionId: "a" },
    }),
  });
  const confirmResult: unknown = await confirmResponse.json();
  if (!isRecord(confirmResult)) throw new Error("source-stale confirm response must be an object");
  assert.equal(confirmResponse.ok, true);
  assert.equal(confirmResult.stateVersion, 2);
  const currentStateVersion = 2;

  const layoutAuditResponse = await fetch(`${parsedUrl.origin}/session/${String(receipt.hostSessionId)}/layout-audit`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
    body: JSON.stringify({
      artifactId: "source-stale",
      sessionId: receipt.hostSessionId,
      sourceHash: receipt.sourceHash,
      stateVersion: currentStateVersion,
      origin: parsedUrl.origin,
      findings: [],
    }),
  });
  assert.equal(layoutAuditResponse.ok, true);
  const readyRead = await readTool.execute("tool-3-ready", { artifactId: "source-stale" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.match(readFirstText(readyRead), /Browser-host readiness: ready/);

  const staleReceiptPath = join(dir, "browser-host-receipts", "source-stale-newer-browser-host-receipt.json");
  await writeFile(
    staleReceiptPath,
    `${JSON.stringify({
      artifactId: "source-stale",
      hostSessionId: "bhost-stale-source",
      receiptPath: staleReceiptPath,
      sourceHash: "stale-source-hash",
      sourcePath: receipt.sourcePath,
      openedAt: "9999-01-01T00:00:00.000Z",
      finalStateVersion: currentStateVersion,
      status: "closed",
      actions: [],
      reviewNotes: [{ id: "stale-note", text: "stale note must not surface", target: { kind: "page" }, sourceHash: "stale-source-hash", stateVersion: currentStateVersion, origin: parsedUrl.origin, createdAt: "9999-01-01T00:00:00.000Z" }],
      layoutAudits: [
        {
          id: "stale-layout",
          sourceHash: "stale-source-hash",
          stateVersion: currentStateVersion,
          origin: parsedUrl.origin,
          createdAt: "9999-01-01T00:00:00.000Z",
          findings: [{ kind: "stale-overflow", selector: "html", severity: "error", overflowPx: 99 }],
          errorCount: 1,
          warningCount: 0,
        },
      ],
      events: [
        {
          eventId: "stale-action-event",
          kind: "action_committed",
          createdAt: "9999-01-01T00:00:00.000Z",
          sessionId: "bhost-stale-source",
          artifactId: "source-stale",
          sourceHash: "stale-source-hash",
          beforeVersion: 1,
          afterVersion: currentStateVersion,
          rendererActionType: "stale_browser_action",
          status: "ok",
        },
      ],
    })}\n`,
    "utf-8",
  );

  const mixedRead = await readTool.execute("tool-4-mixed", { artifactId: "source-stale" }, undefined, undefined, makeExtensionContext([], cwd));
  const mixedText = readFirstText(mixedRead);
  assert.match(mixedText, /Browser-host readiness: ready/);
  assert.doesNotMatch(mixedText, /stale note must not surface/);
  assert.doesNotMatch(mixedText, /stale-overflow/);
  assert.doesNotMatch(mixedText, /stale_browser_action/);
  assert.ok(isRecord(mixedRead.details));
  assert.ok(isRecord(mixedRead.details.browserHost));
  assert.ok(isRecord(mixedRead.details.browserHost.readiness));
  assert.ok(isRecord(mixedRead.details.browserHost.readiness.checks));
  assert.equal(mixedRead.details.browserHost.readiness.readyForHandoff, true);
  assert.equal(mixedRead.details.browserHost.readiness.checks.sourceHashCurrent, true);
  assert.equal(mixedRead.details.browserHost.readiness.checks.stateVersionCurrent, true);
  assert.ok(Array.isArray(mixedRead.details.browserHost.receipts));
  assert.equal(mixedRead.details.browserHost.receipts.length, 2);
  assert.ok(isRecord(mixedRead.details.browserHost.receipts[0]));
  assert.ok(isRecord(mixedRead.details.browserHost.receipts[1]));
  assert.equal(mixedRead.details.browserHost.receipts[0].sourceHash, receipt.sourceHash);
  assert.equal(mixedRead.details.browserHost.receipts[1].sourceHash, "stale-source-hash");
  assert.ok(Array.isArray(mixedRead.details.browserHost.reviewNotes));
  assert.ok(Array.isArray(mixedRead.details.browserHost.layoutAudits));
  assert.ok(!mixedRead.details.browserHost.reviewNotes.some((note) => isRecord(note) && note.text === "stale note must not surface"));
  assert.ok(!mixedRead.details.browserHost.layoutAudits.some((audit) => isRecord(audit) && audit.id === "stale-layout"));

  await rm(receipt.receiptPath, { force: true });

  const staleOnlyRead = await readTool.execute("tool-5-stale-only", { artifactId: "source-stale" }, undefined, undefined, makeExtensionContext([], cwd));
  const staleOnlyText = readFirstText(staleOnlyRead);
  assert.match(staleOnlyText, /Browser-host readiness: stale/);
  assert.match(staleOnlyText, /Latest browser-host receipt is for source stale-source/);
  assert.match(staleOnlyText, /Browser-host next action: Call canvas_present to refresh the browser host/);
  assert.doesNotMatch(staleOnlyText, /stale note must not surface/);
  assert.doesNotMatch(staleOnlyText, /stale-overflow/);
  assert.doesNotMatch(staleOnlyText, /stale_browser_action/);
  assert.ok(isRecord(staleOnlyRead.details));
  assert.ok(isRecord(staleOnlyRead.details.browserHost));
  assert.ok(isRecord(staleOnlyRead.details.browserHost.readiness));
  assert.ok(isRecord(staleOnlyRead.details.browserHost.readiness.checks));
  assert.equal(staleOnlyRead.details.browserHost.readiness.readyForHandoff, false);
  assert.match(String(staleOnlyRead.details.browserHost.readiness.nextAction), /Call canvas_present to refresh the browser host/);
  assert.equal(staleOnlyRead.details.browserHost.readiness.checks.sourceHashCurrent, false);
  assert.equal(staleOnlyRead.details.browserHost.readiness.checks.stateVersionCurrent, true);

  const staleExport = await exportTool.execute("tool-6-stale-export", { artifactId: "source-stale" }, undefined, undefined, makeExtensionContext([], cwd));
  assert.match(readFirstText(staleExport), /Browser-host readiness: stale/);
  assert.match(readFirstText(staleExport), /Browser-host next action: Call canvas_present to refresh the browser host/);
  assert.ok(isRecord(staleExport.details));
  assert.ok(isRecord(staleExport.details.browserHost));
  assert.ok(isRecord(staleExport.details.browserHost.readiness));
  assert.equal(staleExport.details.browserHost.readiness.readyForHandoff, false);
  assert.match(String(staleExport.details.browserHost.readiness.nextAction), /Call canvas_present to refresh the browser host/);
  assert.ok(Array.isArray(staleExport.details.browserHost.reviewNotes));
  assert.ok(!staleExport.details.browserHost.reviewNotes.some((note) => isRecord(note) && note.text === "stale note must not surface"));

  await rm(dir, { recursive: true, force: true });
});

void test("browser host session manager closes oldest sessions when capacity is exceeded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const cwd = join(dir, "project");
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create(createCanvasFixture("first"));
  await runtime.create(createCanvasFixture("second"));
  const reportsDir = join(dir, "browser-host-receipts");
  const manager = new BrowserHostSessionManager({ maxOpenSessions: 1 });

  const first = await manager.getOrStart("first", {
    runtime,
    artifactId: "first",
    candidateId: "test",
    scenarioId: "capacity",
    runId: "first",
    reportsDir,
  });
  const second = await manager.getOrStart("second", {
    runtime,
    artifactId: "second",
    candidateId: "test",
    scenarioId: "capacity",
    runId: "second",
    reportsDir,
  });

  assert.equal(first.receipt.status, "closed");
  assert.equal(second.receipt.status, "open");
  assert.notEqual(first.receipt.hostSessionId, second.receipt.hostSessionId);
  const firstReceiptText = await readFile(first.receipt.receiptPath, "utf-8");
  assert.match(firstReceiptText, /"status": "closed"/);
  assert.match(firstReceiptText, /"kind": "session_closed"/);

  await second.close();
  await rm(dir, { recursive: true, force: true });
});

void test("canvas_create can create and present a browser-host review decision as a canvas form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  const presentTool = tools.get("canvas_present");
  const readTool = tools.get("canvas_read");
  assert.ok(createTool);
  assert.ok(presentTool);
  assert.ok(readTool);
  assert.ok(createTool.promptGuidelines?.some((guideline) => guideline.includes("bounded reviewDecision payload")));

  const created = await createTool.execute(
    "tool-1",
    {
      artifactId: "decision",
      title: "Decision",
      reviewDecision: {
        prompt: "Approve the pi-canvas artifact-control direction?",
        context: "Choose whether the browser artifact is ready for the blog post or needs another revision.",
      },
    },
    undefined,
    undefined,
    makeExtensionContext(),
  );
  const createdText = readFirstText(created);
  assert.match(createdText, /Created canvas decision v1/);
  assert.match(createdText, /Playbook: Composable form/);
  assert.match(createdText, /Browser artifact state: pending - 0\/2 answered, 2 blank, 0 skipped, required-remaining: outcome/);
  assert.match(createdText, /Browser-host readiness: not-presented/);
  assert.match(createdText, /Browser-host next action: Call canvas_present for this artifact/);
  const createdDetails = created.details;
  assert.ok(isRecord(createdDetails));
  assert.ok(isRecord(createdDetails.playbook));
  assert.equal(createdDetails.playbook.id, "builtin.canvas");
  assert.ok(isRecord(createdDetails.browserHost));
  assert.ok(isRecord(createdDetails.browserHost.artifactState));
  assert.equal(createdDetails.browserHost.artifactState.kind, "form");
  assert.equal(createdDetails.browserHost.artifactState.status, "pending");
  assert.ok(isRecord(createdDetails.browserHost.readiness));
  assert.equal(createdDetails.browserHost.readiness.status, "not-presented");
  const initial = await runtime.read("decision");
  assert.equal(initial?.source.view?.kind, "browser-host-artifact");
  assert.equal(initial?.source.view?.kind === "browser-host-artifact" ? initial.source.view.rendererId : "", "builtin.canvas");
  assert.match(JSON.stringify(initial?.state.state), /"components"/);
  assert.match(JSON.stringify(initial?.state.state), /"submitted":false/);

  const presented = await presentTool.execute("tool-2", { artifactId: "decision" }, undefined, undefined, makeExtensionContext());
  const details = presented.details;
  assert.ok(isRecord(details));
  assert.ok(isRecord(details.browserHost));
  assert.ok(isRecord(details.browserHost.playbook));
  assert.equal(details.browserHost.playbook.id, "builtin.canvas");
  const url = details.browserHost.url;
  if (typeof url !== "string") throw new Error("browserHost.url must be a string");
  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token");
  if (!token) throw new Error("browserHost.url must include a live token");
  assert.ok(isRecord(details.browserHost.receipt));
  const receipt = details.browserHost.receipt;
  const hostSessionId = receipt.hostSessionId;
  const sourceHash = receipt.sourceHash;
  if (typeof hostSessionId !== "string") throw new Error("browserHost.receipt.hostSessionId must be a string");
  if (typeof sourceHash !== "string") throw new Error("browserHost.receipt.sourceHash must be a string");
  if (typeof receipt.finalStateVersion !== "number") throw new Error("browserHost.receipt.finalStateVersion must be a number");

  const html = await (await fetch(url)).text();
  assert.match(html, /composable-form/);
  assert.match(html, /Approve the pi-canvas artifact-control direction/);
  assert.match(html, /ready for the blog post/);
  assert.match(html, /Needs discussion/);
  assert.match(html, /needs_discussion/);
  assert.match(html, /pi-canvas-review-dock/);

  const postAction = (stateVersion: number, action: Record<string, unknown>): Promise<Response> =>
    fetch(`${parsedUrl.origin}/session/${hostSessionId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
      body: JSON.stringify({ artifactId: "decision", sessionId: hostSessionId, sourceHash, stateVersion, origin: parsedUrl.origin, action }),
    });
  const postCleanLayoutAudit = (stateVersion: number): Promise<Response> =>
    fetch(`${parsedUrl.origin}/session/${hostSessionId}/layout-audit`, {
      method: "POST",
      headers: { "content-type": "application/json", "origin": parsedUrl.origin, "x-pi-canvas-token": token },
      body: JSON.stringify({ artifactId: "decision", sessionId: hostSessionId, sourceHash, stateVersion, origin: parsedUrl.origin, findings: [] }),
    });

  // Affirm the required outcome, then submit with the comment left BLANK.
  // Loss B: the old "comment required for revise/discuss" gate is gone — a needs_discussion
  // outcome is submittable and reaches ready with no comment.
  const affirm = await postAction(receipt.finalStateVersion, { componentId: "outcome", op: "affirm", optionId: "needs_discussion" });
  const affirmResult: unknown = await affirm.json();
  if (!isRecord(affirmResult)) throw new Error("affirm action response must be an object");
  assert.equal(affirm.ok, true);
  assert.equal(affirmResult.stateVersion, 2);
  const submitBlank = await postAction(2, { op: "submit" });
  const submitBlankResult: unknown = await submitBlank.json();
  if (!isRecord(submitBlankResult)) throw new Error("submit action response must be an object");
  assert.equal(submitBlank.ok, true);
  assert.equal(submitBlankResult.stateVersion, 3);
  assert.equal((await postCleanLayoutAudit(3)).ok, true);

  const readyRead = await readTool.execute("tool-3-ready-blank", { artifactId: "decision" }, undefined, undefined, makeExtensionContext());
  assert.match(readFirstText(readyRead), /Browser-host readiness: ready/);
  assert.match(readFirstText(readyRead), /Browser artifact state: ready - 1\/2 answered, 1 blank, 0 skipped/);
  assert.ok(isRecord(readyRead.details));
  assert.ok(isRecord(readyRead.details.browserHost));
  assert.ok(isRecord(readyRead.details.browserHost.artifactState));
  assert.equal(readyRead.details.browserHost.artifactState.kind, "form");
  assert.equal(readyRead.details.browserHost.artifactState.status, "ready");
  assert.ok(isRecord(readyRead.details.browserHost.readiness));
  assert.ok(isRecord(readyRead.details.browserHost.readiness.checks));
  assert.equal(readyRead.details.browserHost.readiness.checks.rendererHandoffSatisfied, true);
  const readyFields = readyRead.details.browserHost.artifactState.fields;
  assert.ok(isRecord(readyFields));
  const readyReadback = readyFields.formReadback;
  assert.ok(isRecord(readyReadback));
  assert.equal(readyReadback.submitted, true);
  assert.ok(Array.isArray(readyReadback.components));
  const outcomeComp = readyReadback.components.find((component) => isRecord(component) && component.id === "outcome");
  const commentComp = readyReadback.components.find((component) => isRecord(component) && component.id === "comment");
  assert.ok(isRecord(outcomeComp));
  assert.ok(isRecord(commentComp));
  assert.deepEqual(outcomeComp.affirmed, ["needs_discussion"]);
  assert.equal(commentComp.value, null);

  // Set the optional comment (a widget value op, allowed post-submit) and confirm it is captured.
  const comment = await postAction(3, { componentId: "comment", op: "value", value: "Need a final product call." });
  const commentResult: unknown = await comment.json();
  if (!isRecord(commentResult)) throw new Error("comment action response must be an object");
  assert.equal(comment.ok, true);
  assert.equal(commentResult.stateVersion, 4);
  assert.equal((await postCleanLayoutAudit(4)).ok, true);

  const read = await readTool.execute("tool-4", { artifactId: "decision" }, undefined, undefined, makeExtensionContext());
  assert.match(readFirstText(read), /Browser-host readiness: ready/);
  assert.match(readFirstText(read), /Browser artifact state: ready - 2\/2 answered, 0 blank, 0 skipped/);
  assert.match(JSON.stringify(read.details), /Need a final product call/);
  assert.ok(isRecord(read.details));
  assert.ok(isRecord(read.details.browserHost));
  assert.ok(isRecord(read.details.browserHost.artifactState));
  assert.equal(read.details.browserHost.artifactState.status, "ready");
  const fields = read.details.browserHost.artifactState.fields;
  assert.ok(isRecord(fields));
  const formReadback = fields.formReadback;
  assert.ok(isRecord(formReadback));
  assert.ok(Array.isArray(formReadback.components));
  const finalOutcome = formReadback.components.find((component) => isRecord(component) && component.id === "outcome");
  const finalComment = formReadback.components.find((component) => isRecord(component) && component.id === "comment");
  assert.ok(isRecord(finalOutcome));
  assert.ok(isRecord(finalComment));
  assert.deepEqual(finalOutcome.affirmed, ["needs_discussion"]);
  assert.equal(finalComment.value, "Need a final product call.");
  const updated = await runtime.read("decision");
  const actionLogText = await readFile(updated?.paths.actionsPath ?? "", "utf-8");
  assert.match(actionLogText, /"path":"components.outcome"/);
  assert.match(actionLogText, /"path":"components.comment"/);
  assert.match(actionLogText, /"path":"form.submitted"/);

  await rm(dir, { recursive: true, force: true });
});

void test("canvas_present rejects unknown browser renderers at host resolution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-tools-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create({
    artifactId: "unknown-browser",
    title: "Unknown Browser",
    initialState: { value: 0 },
    viewKind: "browser-host-artifact",
    view: {
      kind: "browser-host-artifact",
      bridgeVersion: 1,
      host: "local-browser-host",
      fallback: "terminal-render",
      transport: "http-json",
      rendererId: "missing.browser-renderer",
      rendererVersion: 1,
    },
    actions: [{ type: "set", path: "value", label: "Update value" }],
  });
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const presentTool = tools.get("canvas_present");
  const readTool = tools.get("canvas_read");
  const exportTool = tools.get("canvas_export");
  assert.ok(presentTool);
  assert.ok(readTool);
  assert.ok(exportTool);

  const read = await readTool.execute("tool-read", { artifactId: "unknown-browser" }, undefined, undefined, makeExtensionContext());
  const readText = readFirstText(read);
  assert.match(readText, /Browser-host readiness: blocked/);
  assert.match(readText, /Browser artifact renderer is not registered: missing\.browser-renderer v1/);
  assert.match(readText, /Browser-host next action: Register the browser artifact renderer or migrate this artifact/);
  assert.ok(isRecord(read.details));
  assert.ok(isRecord(read.details.browserHost));
  assert.ok(isRecord(read.details.browserHost.readiness));
  assert.equal(read.details.browserHost.readiness.status, "blocked");
  assert.equal(read.details.browserHost.readiness.readyForHandoff, false);
  assert.match(String(read.details.browserHost.readiness.nextAction), /Register the browser artifact renderer/);
  assert.ok(isRecord(read.details.browserHost.readiness.checks));
  assert.equal(read.details.browserHost.readiness.checks.rendererResolved, false);
  assert.equal(read.details.browserHost.artifactPattern, undefined);

  const exported = await exportTool.execute("tool-export", { artifactId: "unknown-browser" }, undefined, undefined, makeExtensionContext());
  assert.match(readFirstText(exported), /Browser-host readiness: blocked/);
  assert.match(readFirstText(exported), /Browser-host next action: Register the browser artifact renderer or migrate this artifact/);
  assert.ok(isRecord(exported.details));
  assert.ok(isRecord(exported.details.browserHost));
  const evidencePath = exported.details.browserHost.evidencePath;
  if (typeof evidencePath !== "string") throw new Error("browserHost.evidencePath must be a string");
  const evidenceText = await readFile(evidencePath, "utf-8");
  assert.match(evidenceText, /"status": "blocked"/);
  assert.match(evidenceText, /"rendererResolved": false/);
  assert.match(evidenceText, /"nextAction": "Register the browser artifact renderer or migrate this artifact/);
  assert.doesNotMatch(evidenceText, /"artifactPattern"/);

  await assert.rejects(
    () => presentTool.execute("tool-1", { artifactId: "unknown-browser" }, undefined, undefined, makeExtensionContext()),
    /Browser artifact renderer not found: missing\.browser-renderer v1/,
  );

  await rm(dir, { recursive: true, force: true });
});

function makeExtensionContext(sentUserMessages: string[] = [], cwd = "/tmp/project", options: { sendUserMessage?: boolean } = {}): ExtensionContext {
  const ctx: Partial<ExtensionContext> & Pick<
    ExtensionContext,
    "abort" | "compact" | "cwd" | "getContextUsage" | "getSystemPrompt" | "hasPendingMessages" | "hasUI" | "isIdle" | "isProjectTrusted" | "mode" | "shutdown" | "signal" | "ui"
  > & { sendUserMessage?: (content: string | Array<{ type: string }>) => void } = {
    cwd,
    mode: "print",
    hasUI: false,
    ui: makeExtensionUi(),
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
  };
  if (options.sendUserMessage !== false) {
    ctx.sendUserMessage = (content: string | Array<{ type: string }>) => {
      sentUserMessages.push(typeof content === "string" ? content : JSON.stringify(content));
    };
  }
  return ctx as ExtensionContext;
}

function makeExtensionUi(): ExtensionContext["ui"] {
  const ui: Partial<ExtensionContext["ui"]> & Pick<ExtensionContext["ui"], "notify"> = {
    notify() {},
  };
  return ui as ExtensionContext["ui"];
}

function makeTheme(): Theme {
  return {} as Theme;
}

function makeRenderOptions(): ToolRenderResultOptions {
  return { expanded: true, isPartial: false };
}

function makeRenderContext(args: { artifactId: string }): Parameters<NonNullable<ToolDefinition["renderResult"]>>[3] {
  return {
    args,
    toolCallId: "tool-1",
    invalidate() {},
    lastComponent: undefined,
    state: undefined,
    cwd: "/tmp/project",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
  };
}

function readFirstText(result: AgentToolResult<unknown>): string {
  const item = result.content[0];
  assert.equal(item?.type, "text");
  return item.text;
}

