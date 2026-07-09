import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultCanvasRendererRegistry } from "../src/builtin-canvas-renderers.js";
import { CanvasRendererRegistry, createCanvasPreviewComponent } from "../src/canvas-renderer.js";
import { createHtmlIframeBridgeView } from "../src/html-iframe-bridge.js";
import { PiCanvasRuntime } from "../src/runtime.js";
import { createCanvasStore, sha256 } from "../src/store.js";
import { createCanvasTuiSurface } from "../src/surface.js";

void test("default registry renders counter canvas through a Pi TUI component", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-renderers-"));
  const registry = createDefaultCanvasRendererRegistry();
  const counter = registry.require("builtin.counter");
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create({
    artifactId: "counter",
    title: "Counter",
    initialState: { count: 7 },
    rendererId: counter.id,
    rendererVersion: counter.version,
    ...(counter.defaultActions ? { actions: counter.defaultActions.map((action) => ({ ...action })) } : {}),
  });

  const lines = createCanvasPreviewComponent(readback, registry).render(60).join("\n");

  assert.match(lines, /^pi-canvas: Counter/m);
  assert.match(lines, /^Count: 7/m);
  assert.doesNotMatch(lines, /\{"count":7\}/);

  await rm(dir, { recursive: true, force: true });
});

void test("renderer registry rejects duplicate renderer ids", () => {
  const source = createDefaultCanvasRendererRegistry();
  const registry = new CanvasRendererRegistry();
  const counter = source.require("builtin.counter");

  registry.register(counter);

  assert.throws(() => registry.register(counter), /Canvas renderer already registered: builtin\.counter/);
});

void test("renderer registry treats version mismatches as missing renderers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-renderers-"));
  const registry = createDefaultCanvasRendererRegistry();
  const counter = registry.require("builtin.counter");
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  const readback = await runtime.create({
    artifactId: "counter",
    title: "Counter",
    initialState: { count: 7 },
    rendererId: counter.id,
    rendererVersion: counter.version + 1,
    ...(counter.defaultActions ? { actions: counter.defaultActions.map((action) => ({ ...action })) } : {}),
  });

  const lines = createCanvasPreviewComponent(readback, registry).render(60).join("\n");

  assert.match(lines, /Canvas renderer not found: builtin\.counter v2/);
  assert.doesNotMatch(lines, /^Count: 7/m);

  await rm(dir, { recursive: true, force: true });
});

void test("counter surface mutates durable state through renderer-owned input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-renderers-"));
  const registry = createDefaultCanvasRendererRegistry();
  const counter = registry.require("builtin.counter");
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create({
    artifactId: "counter",
    title: "Counter",
    initialState: { count: 0 },
    rendererId: counter.id,
    rendererVersion: counter.version,
    ...(counter.defaultActions ? { actions: counter.defaultActions.map((action) => ({ ...action })) } : {}),
  });
  let renderRequests = 0;
  const surface = await createCanvasTuiSurface({
    runtime,
    registry,
    artifactId: "counter",
    host: {
      requestRender() {
        renderRequests += 1;
      },
    },
  });

  surface.handleInput("+");
  await surface.waitForIdle();

  assert.equal(renderRequests, 1);
  assert.deepEqual((await runtime.read("counter"))?.state.state, { count: 1 });
  assert.match(surface.render(60).join("\n"), /^Count: 1/m);

  await rm(dir, { recursive: true, force: true });
});

void test("surface close waits for queued updates before reporting final state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-renderers-"));
  const registry = createDefaultCanvasRendererRegistry();
  const counter = registry.require("builtin.counter");
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create({
    artifactId: "counter",
    title: "Counter",
    initialState: { count: 0 },
    rendererId: counter.id,
    rendererVersion: counter.version,
    ...(counter.defaultActions ? { actions: counter.defaultActions.map((action) => ({ ...action })) } : {}),
  });
  let result: unknown;
  const surface = await createCanvasTuiSurface({
    runtime,
    registry,
    artifactId: "counter",
    host: { requestRender() {} },
    onDone(value) {
      result = value;
    },
  });

  surface.handleInput("+");
  surface.handleInput("q");
  await surface.waitForIdle();

  assert.deepEqual(result, {
    artifactId: "counter",
    version: 2,
    state: { count: 1 },
    closedBy: "quit",
  });

  await rm(dir, { recursive: true, force: true });
});

void test("iframe bridge views require an adjacent host instead of opening as Pi TUI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-renderers-"));
  const registry = createDefaultCanvasRendererRegistry();
  const runtime = new PiCanvasRuntime(createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") }));
  await runtime.create({
    artifactId: "iframe",
    title: "Iframe",
    initialState: { count: 0 },
    viewKind: "html-iframe-state-bridge",
    view: createHtmlIframeBridgeView({
      actionSchema: { type: "object", required: ["artifactId", "path", "value"] },
      htmlSourceHash: sha256("<button>Increment</button>"),
    }),
    stateSchema: { type: "object", required: ["count"], properties: { count: { type: "number" } } },
    actions: [{ type: "set", path: "count", label: "Set count" }],
  });

  await assert.rejects(
    () =>
      createCanvasTuiSurface({
        runtime,
        registry,
        artifactId: "iframe",
        host: { requestRender() {} },
      }),
    /Canvas view requires an adjacent host: html-iframe-state-bridge/,
  );

  await rm(dir, { recursive: true, force: true });
});

