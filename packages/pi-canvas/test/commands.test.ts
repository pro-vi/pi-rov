import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserHostSessionManager } from "../src/browser-host.js";
import { createFormCanvasRequest } from "../src/builtin-form-renderer.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleCanvasCommand } from "../src/commands.js";
import { PiCanvasRuntime } from "../src/runtime.js";
import { createCanvasStore } from "../src/store.js";

function createCanvasFixture(artifactId: string) {
  return createFormCanvasRequest(artifactId, "Canvas Fixture", {
    components: [{ id: "choice", kind: "single-select", prompt: "Pick one", options: [{ id: "a", title: "Option A" }, { id: "b", title: "Option B" }] }],
  });
}

void test("/canvas command subcommands write structured events and durable state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-canvas-command-cwd-"));
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  const ctx = makeCommandContext(messages);

  await handleCanvasCommand('create demo {"value":0}', ctx, runtime);
  await handleCanvasCommand("update demo value 5", ctx, runtime);
  await handleCanvasCommand("read demo", ctx, runtime);
  await handleCanvasCommand("export demo exported", ctx, runtime);

  assert.equal(messages.length, 4);
  assert.match(messages[0] ?? "", /^pi-canvas event /);
  assert.match(messages[1] ?? "", /"event":"updated"/);
  assert.match(messages[2] ?? "", /"state":\{"value":5\}/);
  assert.match(messages[3] ?? "", /"event":"exported"/);
  const readback = await runtime.read("demo");
  assert.deepEqual(readback?.state.state, { value: 5 });
  assert.match(await readFile(join(cwd, "exported", "state.diff"), "utf-8"), /canvas.state.after.json/);

  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

void test("/canvas help documents the canvas_create signature and terminal/browser split", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir }));
  const messages: string[] = [];

  await handleCanvasCommand("help", makeCommandContext(messages), runtime);

  const help = messages[0] ?? "";
  assert.match(help, /canvas_create\(\{ title, initialState\?, artifactId\?, surfaceKind\?, rendererId\?, rendererVersion\?, browserRendererId\?, browserRendererVersion\?, viewProps\?, optionChooser\?, reviewDecision\?, form\? \}\)/);
  assert.match(help, /Terminal canvases render through Pi TUI components\. Browser artifacts are local browser-host patterns whose canonical state is read with canvas_read\./);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas command reports invalid JSON without mutating state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir }));
  const messages: string[] = [];
  const ctx = makeCommandContext(messages);

  await handleCanvasCommand("create bad {oops", ctx, runtime);

  assert.match(messages[0] ?? "", /must be valid JSON/);
  assert.equal(await runtime.read("bad"), undefined);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas export writes browser-host readiness evidence for browser artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-canvas-command-cwd-"));
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create(createCanvasFixture("chooser"));

  await handleCanvasCommand("export chooser browser-export", makeCommandContext(messages), runtime);

  assert.match(messages[0] ?? "", /"event":"exported"/);
  assert.match(messages[0] ?? "", /"browserHostEvidencePath":/);
  assert.match(messages[0] ?? "", /"browserHostReadiness":\{"status":"not-presented","readyForHandoff":false/);
  assert.match(messages[0] ?? "", /"nextAction":"Call canvas_present for this artifact/);
  assert.match(messages[0] ?? "", /"browserHostArtifactPattern":\{"layer":"browser-host-artifact","rendererId":"builtin\.canvas"/);
  assert.match(messages[0] ?? "", /"playbookId":"builtin\.canvas"/);
  assert.match(messages[0] ?? "", /"stateAuthority":"canvas_read"/);
  assert.match(messages[0] ?? "", /"evidenceAuthority":"browser-host-receipts"/);
  assert.match(messages[0] ?? "", /"browserHostArtifactState":\{"rendererId":"builtin\.canvas"/);
  assert.match(messages[0] ?? "", /"summary":"0\/1 answered, 1 blank, 0 skipped"/);
  const evidenceText = await readFile(join(cwd, "browser-export", "browser-host.evidence.json"), "utf-8");
  assert.match(evidenceText, /"artifactPattern"/);
  assert.match(evidenceText, /"layer": "browser-host-artifact"/);
  assert.match(evidenceText, /"stateAuthority": "canvas_read"/);
  assert.match(evidenceText, /"evidenceAuthority": "browser-host-receipts"/);
  assert.match(evidenceText, /"artifactState"/);
  assert.match(evidenceText, /"formReadback"/);
  assert.match(evidenceText, /"playbookId": "builtin.canvas"/);
  assert.match(evidenceText, /"canonicalState": "Pi owns per-widget answers under components/);
  assert.match(evidenceText, /"agentAction": "canvas_create with a form payload/);
  assert.match(evidenceText, /"status": "not-presented"/);
  assert.match(evidenceText, /"readyForHandoff": false/);
  assert.match(evidenceText, /"nextAction": "Call canvas_present for this artifact/);

  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

void test("/canvas read reports browser-host readiness evidence for browser artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create(createCanvasFixture("chooser"));

  await handleCanvasCommand("read chooser", makeCommandContext(messages), runtime);

  assert.match(messages[0] ?? "", /"event":"read"/);
  assert.match(messages[0] ?? "", /"browserHostReadiness":\{"status":"not-presented","readyForHandoff":false/);
  assert.match(messages[0] ?? "", /"nextAction":"Call canvas_present for this artifact/);
  assert.match(messages[0] ?? "", /"browserHostArtifactPattern":\{"layer":"browser-host-artifact","rendererId":"builtin\.canvas"/);
  assert.match(messages[0] ?? "", /"playbookId":"builtin\.canvas"/);
  assert.match(messages[0] ?? "", /"stateAuthority":"canvas_read"/);
  assert.match(messages[0] ?? "", /"evidenceAuthority":"browser-host-receipts"/);
  assert.match(messages[0] ?? "", /"browserHostArtifactState":\{"rendererId":"builtin\.canvas"/);
  assert.match(messages[0] ?? "", /"formReadback"/);
  assert.match(messages[0] ?? "", /"browserHostReceipts":0/);
  assert.match(messages[0] ?? "", /"browserHostReviewNotes":0/);
  assert.match(messages[0] ?? "", /"browserHostLayoutAudits":0/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas read and export report browser-host review annotation summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-canvas-command-cwd-"));
  const runtime = new PiCanvasRuntime(createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create(createCanvasFixture("chooser"));
  const session = await new BrowserHostSessionManager().getOrStart(`${cwd}:chooser`, {
    runtime,
    artifactId: "chooser",
    candidateId: "command-review-annotation-test",
    scenarioId: "command-review-annotation-test",
    runId: "command-review-annotation-test",
    reportsDir: join(dir, "browser-host-receipts"),
  });
  const reviewResponse = await session.postReviewNoteForTest({
    artifactId: "chooser",
    sessionId: session.receipt.hostSessionId,
    sourceHash: session.receipt.sourceHash,
    stateVersion: session.receipt.finalStateVersion,
    origin: session.receipt.allowedOrigin,
    text: "Command review note",
    target: { kind: "element", testId: "command-option", selector: "[data-testid=\"opt-choice-a\"]", text: "Command option target" },
  });
  assert.equal(reviewResponse.ok, true);

  await handleCanvasCommand("read chooser", makeCommandContext(messages), runtime);
  await handleCanvasCommand("export chooser command-export", makeCommandContext(messages), runtime);

  assert.match(messages[0] ?? "", /"event":"read"/);
  assert.match(messages[0] ?? "", /"browserHostReviewNotes":1/);
  assert.match(messages[0] ?? "", /"browserHostReviewAnnotations":\{"total":1,"targetCount":1/);
  assert.match(messages[0] ?? "", /"targetKey":"element:testId:command-option"/);
  assert.match(messages[0] ?? "", /"text":"Command review note"/);
  assert.match(messages[1] ?? "", /"event":"exported"/);
  assert.match(messages[1] ?? "", /"browserHostReviewAnnotations":\{"total":1,"targetCount":1/);
  assert.match(messages[1] ?? "", /"targetKey":"element:testId:command-option"/);
  const evidenceText = await readFile(join(cwd, "command-export", "browser-host.evidence.json"), "utf-8");
  assert.match(evidenceText, /"reviewAnnotations"/);
  assert.match(evidenceText, /"targetKey": "element:testId:command-option"/);

  await session.close();
  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

void test("/canvas update is rejected on a browser canvas (human-write-only)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create(createCanvasFixture("chooser"));

  await handleCanvasCommand("update chooser form.submitted true", makeCommandContext(messages), runtime);

  // A browser-host canvas is human-write-only: the guard rejects the command write; it surfaces as an
  // error and canonical state is untouched (still v1). Readiness is inspected with `/canvas read`.
  assert.match(messages[0] ?? "", /human commits answers in the browser session|create a new canvas/);
  const rb = await runtime.read("chooser");
  assert.equal(rb?.state.version, 1);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas read in print mode appends browser-host readiness below the terminal render", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create(createCanvasFixture("chooser"));

  const stdout = await captureStdout(async () => {
    await handleCanvasCommand("read chooser", makePrintCommandContext(messages), runtime);
  });

  assert.match(messages[0] ?? "", /^pi-canvas: Canvas Fixture/m);
  assert.match(messages[0] ?? "", /Browser artifact state: ready - 0\/1 answered, 1 blank, 0 skipped/);
  assert.match(messages[0] ?? "", /Browser-host readiness: not-presented/);
  assert.match(messages[0] ?? "", /Browser-host next action: Call canvas_present for this artifact/);
  assert.doesNotMatch(messages[0] ?? "", /^pi-canvas event /m);
  assert.match(stdout, /Browser artifact state: ready - 0\/1 answered, 1 blank, 0 skipped/);
  assert.match(stdout, /Browser-host readiness: not-presented/);
  assert.match(stdout, /Browser-host next action: Call canvas_present for this artifact/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas open uses direct TUI surface to mutate and export state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  const ctx = makeTuiCommandContext(messages);

  await handleCanvasCommand("open demo", ctx, runtime);

  assert.match(messages[0] ?? "", /"event":"tui-closed"/);
  assert.match(messages[0] ?? "", /"state":\{"value":1\}/);
  const readback = await runtime.read("demo");
  assert.deepEqual(readback?.state.state, { value: 1 });
  assert.match(messages[0] ?? "", /"exportDir":/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas open in print mode emits a visible terminal render", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  const stdout = await captureStdout(async () => {
    await handleCanvasCommand("open demo", makePrintCommandContext(messages), runtime);
  });

  assert.match(messages[0] ?? "", /^pi-canvas: Demo/m);
  assert.match(messages[0] ?? "", /^Details$/m);
  assert.match(messages[0] ?? "", /  Value: 0/);
  assert.doesNotMatch(messages[0] ?? "", /^state$/m);
  assert.doesNotMatch(messages[0] ?? "", /state: \{"value":0\}/);
  assert.match(stdout, /^pi-canvas: Demo/m);
  assert.match(stdout, /Run plain `pi`, then `\/canvas open` to browse artifacts\./);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas browse in print mode labels terminal and browser artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  await runtime.create(createCanvasFixture("chooser"));

  const stdout = await captureStdout(async () => {
    await handleCanvasCommand("browse", makePrintCommandContext(messages), runtime);
  });

  assert.match(messages[0] ?? "", /demo  Demo  v1  terminal/);
  assert.match(messages[0] ?? "", /chooser  Canvas Fixture  v1  browser:not-presented/);
  assert.match(stdout, /chooser  Canvas Fixture  v1  browser:not-presented/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas open in TUI mode previews browser-host artifacts instead of opening mutable TUI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  const renderedFrames: string[][] = [];
  await runtime.create(createCanvasFixture("chooser"));

  await handleCanvasCommand("open chooser", makeTuiCommandContext(messages, { renderedFrames }), runtime);

  const rendered = renderedFrames[0]?.join("\n") ?? "";
  const readback = await runtime.read("chooser");
  assert.match(messages[0] ?? "", /"event":"render-closed"/);
  assert.doesNotMatch(messages[0] ?? "", /"event":"tui-closed"/);
  assert.equal(readback?.state.version, 1);
  assert.match(rendered, /^pi-canvas: Canvas Fixture/m);
  assert.match(rendered, /Canvas view requires an adjacent host: browser-host-artifact/);
  assert.match(rendered, /Browser artifact state: ready - 0\/1 answered, 1 blank, 0 skipped/);
  assert.match(rendered, /Browser-host next action: Call canvas_present for this artifact/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas create in print mode emits the terminal artifact instead of raw JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  const stdout = await captureStdout(async () => {
    await handleCanvasCommand('create demo {"value":0,"label":"draft"}', makePrintCommandContext(messages), runtime);
  });

  assert.match(stdout, /^pi-canvas: demo/m);
  assert.match(stdout, /  Value: 0/);
  assert.match(stdout, /  Label: draft/);
  assert.doesNotMatch(stdout, /^pi-canvas event /m);
  assert.doesNotMatch(stdout, /\{"value":0,"label":"draft"\}/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas render in print mode emits the terminal artifact without raw JSON state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create({ artifactId: "demo", title: "Demo", initialState: { value: 0, label: "draft" } });
  const stdout = await captureStdout(async () => {
    await handleCanvasCommand("render demo", makePrintCommandContext(messages), runtime);
  });

  assert.match(stdout, /^pi-canvas: Demo/m);
  assert.match(stdout, /  Value: 0/);
  assert.match(stdout, /  Label: draft/);
  assert.doesNotMatch(stdout, /^state$/m);
  assert.doesNotMatch(stdout, /\{"value":0,"label":"draft"\}/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas render in print mode appends browser-host readiness for browser artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create(createCanvasFixture("chooser"));

  const stdout = await captureStdout(async () => {
    await handleCanvasCommand("render chooser", makePrintCommandContext(messages), runtime);
  });

  assert.match(messages[0] ?? "", /^pi-canvas: Canvas Fixture/m);
  assert.match(messages[0] ?? "", /Browser-host readiness: not-presented/);
  assert.match(messages[0] ?? "", /Browser-host next action: Call canvas_present for this artifact/);
  assert.doesNotMatch(messages[0] ?? "", /^pi-canvas event /m);
  assert.match(stdout, /Browser-host readiness: not-presented/);
  assert.match(stdout, /Browser-host next action: Call canvas_present for this artifact/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas render in TUI mode surfaces browser-host summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  const renderedFrames: string[][] = [];
  await runtime.create(createCanvasFixture("chooser"));

  await handleCanvasCommand("render chooser", makeTuiCommandContext(messages, { renderedFrames }), runtime);

  const rendered = renderedFrames[0]?.join("\n") ?? "";
  assert.match(messages[0] ?? "", /"event":"render-closed"/);
  assert.match(rendered, /^pi-canvas: Canvas Fixture/m);
  assert.match(rendered, /Canvas view requires an adjacent host: browser-host-artifact/);
  assert.match(rendered, /Browser artifact state: ready - 0\/1 answered, 1 blank, 0 skipped/);
  assert.match(rendered, /Browser-host readiness: not-presented/);
  assert.match(rendered, /Browser-host next action: Call canvas_present for this artifact/);

  await rm(dir, { recursive: true, force: true });
});

void test("/canvas open without an id browses artifacts in TUI mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-command-"));
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const messages: string[] = [];
  await runtime.create({ artifactId: "alpha", title: "Alpha", initialState: { value: 0 } });
  await runtime.create({ artifactId: "beta", title: "Beta", initialState: { value: 10 } });
  const ctx = makeTuiCommandContext(messages, { selectedChoice: "beta  Beta  v1" });

  await handleCanvasCommand("open", ctx, runtime);

  const alpha = await runtime.read("alpha");
  const beta = await runtime.read("beta");
  assert.deepEqual(alpha?.state.state, { value: 0 });
  assert.deepEqual(beta?.state.state, { value: 11 });
  assert.match(messages[0] ?? "", /"artifactId":"beta"/);

  await rm(dir, { recursive: true, force: true });
});

function makeCommandContext(messages: string[]): ExtensionCommandContext {
  return {
    mode: "rpc",
    hasUI: true,
    ui: {
      notify(message: string) {
        messages.push(message);
      },
    },
  } as ExtensionCommandContext;
}

function makeTuiCommandContext(messages: string[], options: { selectedChoice?: string; renderedFrames?: string[][] } = {}): ExtensionCommandContext {
  return {
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string) {
        messages.push(message);
      },
      select(_title: string, choices: string[]) {
        return Promise.resolve(options.selectedChoice ?? choices[0]);
      },
      async custom(factory: (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => Promise<{ handleInput?(data: string): void; waitForIdle?(): Promise<void>; render?(width: number): string[] }>) {
        let result: unknown;
        const component = await factory({ requestRender() {} }, {}, {}, (value) => {
          result = value;
        });
        const rendered = component.render?.(100);
        if (rendered) options.renderedFrames?.push(rendered);
        component.handleInput?.("+");
        await component.waitForIdle?.();
        component.handleInput?.("e");
        await component.waitForIdle?.();
        component.handleInput?.("q");
        await component.waitForIdle?.();
        return result;
      },
    },
  } as ExtensionCommandContext;
}

function makePrintCommandContext(messages: string[]): ExtensionCommandContext {
  return {
    mode: "print",
    hasUI: false,
    ui: {
      notify(message: string) {
        messages.push(message);
      },
    },
  } as ExtensionCommandContext;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    if (callback) callback();
    return true;
  }) as Writable["write"];
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}
