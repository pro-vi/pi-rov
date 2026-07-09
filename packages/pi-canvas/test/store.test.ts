import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isRecord, serializeJson } from "../src/json.js";
import { createCanvasStore, sha256 } from "../src/store.js";

void test("create persists separate source, state, and provenance artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });

  const readback = await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });

  assert.equal(readback.source.artifactId, "demo");
  assert.equal(readback.state.version, 1);
  assert.deepEqual(readback.state.state, { value: 0 });
  const sourceJson: unknown = JSON.parse(await readFile(readback.paths.sourcePath, "utf-8"));
  const stateJson: unknown = JSON.parse(await readFile(readback.paths.statePath, "utf-8"));
  assert.ok(isRecord(sourceJson));
  assert.ok(isRecord(stateJson));
  assert.equal(sourceJson.artifactId, "demo");
  assert.equal(sourceJson.schemaVersion, 2);
  assert.deepEqual(sourceJson.view, { kind: "pi-tui-component", rendererId: "builtin.json-card", rendererVersion: 1 });
  assert.equal(stateJson.version, 1);
  assert.match(await readFile(readback.paths.provenancePath, "utf-8"), /"event":"create"/);

  await rm(dir, { recursive: true, force: true });
});

void test("read accepts legacy schemaVersion 1 source without a renderer reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });

  const created = await store.create({ artifactId: "legacy", title: "Legacy", initialState: { value: 0 } });
  const legacySource = {
    artifactId: "legacy",
    schemaVersion: 1,
    title: "Legacy",
    viewKind: "json-render-schema",
    stateSchema: {},
    initialState: { value: 0 },
    actions: [{ type: "set", path: "value", label: "Set value" }],
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  await writeFile(created.paths.sourcePath, `${JSON.stringify(legacySource, null, 2)}\n`, "utf-8");
  const stateJson: unknown = JSON.parse(await readFile(created.paths.statePath, "utf-8"));
  assert.ok(isRecord(stateJson));
  await writeFile(created.paths.statePath, `${JSON.stringify({ ...stateJson, sourceHash: sha256(serializeJson(legacySource)) }, null, 2)}\n`, "utf-8");

  const reread = await store.read("legacy");

  assert.equal(reread?.source.schemaVersion, 1);
  assert.equal(reread?.source.view, undefined);
  assert.deepEqual(reread?.state.state, { value: 0 });

  await rm(dir, { recursive: true, force: true });
});

void test("read rejects source files whose content no longer matches state sourceHash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });

  const created = await store.create({ artifactId: "tampered", title: "Tampered", initialState: { value: 0 } });
  const sourceJson: unknown = JSON.parse(await readFile(created.paths.sourcePath, "utf-8"));
  assert.ok(isRecord(sourceJson));
  await writeFile(created.paths.sourcePath, `${JSON.stringify({ ...sourceJson, title: "Tampered Source" }, null, 2)}\n`, "utf-8");

  await assert.rejects(() => store.read("tampered"), /Canvas source hash mismatch/);
  await assert.rejects(() => store.update({ artifactId: "tampered", path: "value", value: 1 }), /Canvas source hash mismatch/);
  await assert.rejects(() => store.export("tampered"), /Canvas source hash mismatch/);

  await rm(dir, { recursive: true, force: true });
});

void test("read and export reject persisted state that violates stateSchema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });

  const created = await store.create({
    artifactId: "tampered-state",
    title: "Tampered State",
    initialState: { value: 0 },
    stateSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "number" } },
      additionalProperties: false,
    },
  });
  const stateJson: unknown = JSON.parse(await readFile(created.paths.statePath, "utf-8"));
  assert.ok(isRecord(stateJson));
  await writeFile(created.paths.statePath, `${JSON.stringify({ ...stateJson, state: { value: "bad" } }, null, 2)}\n`, "utf-8");

  await assert.rejects(() => store.read("tampered-state"), /state\.value must be number/);
  await assert.rejects(() => store.export("tampered-state"), /state\.value must be number/);

  await rm(dir, { recursive: true, force: true });
});

void test("create persists generic browser-host artifact metadata without resolving renderer availability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });

  const readback = await store.create({
    artifactId: "browser-artifact",
    title: "Browser Artifact",
    initialState: { board: { columns: [], cards: [], selectedCardId: "", agentIntents: [] } },
    viewKind: "browser-host-artifact",
    view: {
      kind: "browser-host-artifact",
      bridgeVersion: 1,
      host: "local-browser-host",
      fallback: "terminal-render",
      transport: "http-json",
      rendererId: "missing.renderer-is-runtime-layer",
      rendererVersion: 1,
      props: { test: true },
    },
    actions: [{ type: "set", path: "board", label: "Update board" }],
  });

  assert.equal(readback.source.view?.kind, "browser-host-artifact");
  assert.equal(readback.source.view?.kind === "browser-host-artifact" ? readback.source.view.rendererId : "", "missing.renderer-is-runtime-layer");
  assert.equal((await store.read("browser-artifact"))?.source.view?.kind, "browser-host-artifact");

  await assert.rejects(
    () =>
      store.create({
        artifactId: "bad-browser-artifact",
        title: "Bad Browser Artifact",
        initialState: {},
        viewKind: "browser-host-artifact",
        view: {
          kind: "browser-host-artifact",
          bridgeVersion: 1,
          host: "local-browser-host",
          fallback: "terminal-render",
          transport: "http-json",
          rendererId: "",
          rendererVersion: 1,
        },
      }),
    /Invalid browser host artifact view metadata/,
  );

  await rm(dir, { recursive: true, force: true });
});

void test("update mutates structured state and records action provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });

  const updated = await store.update({ artifactId: "demo", path: "value", value: 2, actor: "test-user" });
  const reread = await store.read("demo");

  assert.equal(updated.state.version, 2);
  assert.deepEqual(reread?.state.state, { value: 2 });
  assert.match(await readFile(updated.paths.actionsPath, "utf-8"), /"actor":"test-user"/);
  assert.match(await readFile(updated.paths.provenancePath, "utf-8"), /"event":"update"/);

  await rm(dir, { recursive: true, force: true });
});

void test("read skips malformed trailing provenance lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  const updated = await store.update({ artifactId: "demo", path: "value", value: 2, actor: "test-user" });
  const provenanceLog = await readFile(updated.paths.provenancePath, "utf-8");
  await writeFile(updated.paths.provenancePath, `${provenanceLog}{"id":`, "utf-8");

  const reread = await store.read("demo");

  assert.equal(reread?.state.version, 2);
  assert.deepEqual(reread?.state.state, { value: 2 });
  assert.equal(reread?.latestProvenance?.event, "update");
  assert.equal(reread?.latestProvenance?.afterVersion, 2);

  await rm(dir, { recursive: true, force: true });
});

void test("export appends provenance after malformed tails on a fresh JSONL line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-canvas-cwd-"));
  const store = createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  const updated = await store.update({ artifactId: "demo", path: "value", value: 2, actor: "test-user" });
  const provenanceLog = await readFile(updated.paths.provenancePath, "utf-8");
  await writeFile(updated.paths.provenancePath, `${provenanceLog}{"id":`, "utf-8");

  const exported = await store.export("demo");
  if (!exported) throw new Error("export must succeed");
  const currentLines = (await readFile(updated.paths.provenancePath, "utf-8")).split("\n").filter(Boolean);
  const latestCurrentLine = currentLines.at(-1);
  if (!latestCurrentLine) throw new Error("current provenance log must include an export line");
  assert.equal(readJsonLineEvent(latestCurrentLine), "export");
  const exportedLines = (await readFile(exported.provenancePath, "utf-8")).split("\n").filter(Boolean);
  assert.ok(exportedLines.length >= 3);
  assert.deepEqual(exportedLines.map(readJsonLineEvent), ["create", "update", "export"]);
  assert.equal((await store.read("demo"))?.latestProvenance?.event, "export");

  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

void test("update appends actions after malformed action tails on a fresh JSONL line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  const updated = await store.update({ artifactId: "demo", path: "value", value: 1, actor: "first" });
  const actionLog = await readFile(updated.paths.actionsPath, "utf-8");
  await writeFile(updated.paths.actionsPath, `${actionLog}{"id":`, "utf-8");

  const second = await store.update({ artifactId: "demo", path: "value", value: 2, actor: "second" });
  const actionLines = (await readFile(second.paths.actionsPath, "utf-8")).split("\n").filter(Boolean);
  const latestActionLine = actionLines.at(-1);
  if (!latestActionLine) throw new Error("action log must include the second update");
  assert.equal(readJsonLineActor(latestActionLine), "second");

  await rm(dir, { recursive: true, force: true });
});

void test("pending update recovery ignores malformed JSONL fragments when checking replay ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const timestamp = "2026-06-27T00:00:00.000Z";
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date(timestamp) });
  const created = await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  const action = {
    id: "act-recovered",
    artifactId: "demo",
    type: "set",
    path: "value",
    value: 1,
    actor: "recovered-user",
    createdAt: timestamp,
  };
  const state = {
    artifactId: "demo",
    version: 2,
    sourceHash: created.state.sourceHash,
    state: { value: 1 },
    updatedAt: timestamp,
  };
  const provenance = {
    id: "prov-recovered",
    artifactId: "demo",
    event: "update",
    sourceHash: created.state.sourceHash,
    createdAt: timestamp,
    actionId: action.id,
    beforeVersion: 1,
    afterVersion: 2,
    beforeState: { value: 0 },
    afterState: { value: 1 },
  };
  await writeFile(join(created.paths.artifactDir, "canvas.pending.json"), serializeTestJson({ kind: "update", state, action, provenance }), "utf-8");
  await writeFile(created.paths.actionsPath, `{"id":"${action.id}"`, "utf-8");
  await writeFile(created.paths.provenancePath, `{"id":"${provenance.id}"`, "utf-8");

  const recovered = await store.read("demo");

  assert.equal(recovered?.state.version, 2);
  assert.deepEqual(recovered?.state.state, { value: 1 });
  assert.equal(recovered?.latestProvenance?.event, "update");
  assert.equal(recovered?.latestProvenance?.id, provenance.id);
  const actionLines = (await readFile(created.paths.actionsPath, "utf-8")).split("\n").filter(Boolean);
  const latestActionLine = actionLines.at(-1);
  if (!latestActionLine) throw new Error("action log must include the recovered update");
  assert.equal(readJsonLineActor(latestActionLine), "recovered-user");
  const provenanceLines = (await readFile(created.paths.provenancePath, "utf-8")).split("\n").filter(Boolean);
  const latestProvenanceLine = provenanceLines.at(-1);
  if (!latestProvenanceLine) throw new Error("provenance log must include the recovered update");
  assert.equal(readJsonLineEvent(latestProvenanceLine), "update");

  await rm(dir, { recursive: true, force: true });
});

void test("create rejects duplicate artifact ids instead of resetting state over old provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });

  await assert.rejects(() => store.create({ artifactId: "demo", title: "Demo again", initialState: { value: 1 } }), /Canvas artifact already exists: demo/);

  assert.deepEqual((await store.read("demo"))?.state.state, { value: 0 });

  await rm(dir, { recursive: true, force: true });
});

void test("state schema validates create and update state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  const stateSchema = {
    type: "object",
    required: ["value"],
    properties: { value: { type: "number" } },
    additionalProperties: false,
  };

  await assert.rejects(() => store.create({ artifactId: "bad", title: "Bad", initialState: { value: "nope" }, stateSchema }), /initialState\.value must be number/);
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 }, stateSchema });
  await assert.rejects(() => store.update({ artifactId: "demo", path: "value", value: "nope" }), /state\.value must be number/);

  assert.deepEqual((await store.read("demo"))?.state.state, { value: 0 });

  await rm(dir, { recursive: true, force: true });
});

void test("update only accepts declared safe action paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 }, actions: [{ type: "set", path: "value", label: "Set value" }] });

  await assert.rejects(() => store.update({ artifactId: "demo", path: "other", value: 1 }), /not declared/);
  await assert.rejects(
    () => store.create({ artifactId: "sparse", title: "Sparse", initialState: { items: [] }, actions: [{ type: "set", path: "items.999999", label: "Sparse" }] }),
    /Unsafe canvas action path/,
  );

  assert.deepEqual((await store.read("demo"))?.state.state, { value: 0 });

  await rm(dir, { recursive: true, force: true });
});

void test("concurrent updates serialize versions and provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });

  const [first, second] = await Promise.all([
    store.update({ artifactId: "demo", path: "value", value: 1, actor: "first" }),
    store.update({ artifactId: "demo", path: "value", value: 2, actor: "second" }),
  ]);
  const readback = await store.read("demo");
  const actions = await readFile(readback?.paths.actionsPath ?? "", "utf-8");

  assert.deepEqual([first.state.version, second.state.version].sort(), [2, 3]);
  assert.equal(readback?.state.version, 3);
  assert.equal(actions.split("\n").filter(Boolean).length, 2);

  await rm(dir, { recursive: true, force: true });
});

void test("expected source and state version are enforced inside the update lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  const created = await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });

  const [first, second] = await Promise.allSettled([
    store.update({
      artifactId: "demo",
      path: "value",
      value: 1,
      actor: "first",
      expectedSourceHash: created.state.sourceHash,
      expectedStateVersion: created.state.version,
    }),
    store.update({
      artifactId: "demo",
      path: "value",
      value: 2,
      actor: "second",
      expectedSourceHash: created.state.sourceHash,
      expectedStateVersion: created.state.version,
    }),
  ]);
  const rejected = [first, second].find((result) => result.status === "rejected");
  const fulfilled = [first, second].find((result) => result.status === "fulfilled");
  const readback = await store.read("demo");
  const actions = await readFile(readback?.paths.actionsPath ?? "", "utf-8");

  assert.ok(fulfilled);
  assert.ok(rejected);
  assert.match(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason), /Canvas stale state version/);
  assert.equal(readback?.state.version, 2);
  assert.equal(actions.split("\n").filter(Boolean).length, 1);

  await assert.rejects(
    () => store.update({ artifactId: "demo", path: "value", value: 3, expectedSourceHash: "wrong", expectedStateVersion: 2 }),
    /Canvas source hash mismatch/,
  );

  await rm(dir, { recursive: true, force: true });
});

void test("export writes diffable source state and provenance bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-canvas-cwd-"));
  const store = createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });
  await store.update({ artifactId: "demo", path: "value", value: 3 });

  const exported = await store.export("demo");

  assert.ok(exported);
  assert.match(await readFile(exported.sourceDiffPath, "utf-8"), /\+\{/);
  assert.match(await readFile(exported.stateDiffPath, "utf-8"), /canvas.state.after.json/);
  assert.match(await readFile(exported.stateDiffPath, "utf-8"), /^\+  "value": 3/m);
  assert.match(await readFile(exported.provenancePath, "utf-8"), /"event":"update"/);
  assert.match(await readFile(exported.provenancePath, "utf-8"), /"event":"export"/);
  assert.equal((await store.read("demo"))?.latestProvenance?.event, "export");

  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

void test("export target directory must stay inside the project cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-canvas-cwd-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-canvas-outside-"));
  const store = createCanvasStore(cwd, { baseDir: dir, now: () => new Date("2026-06-27T00:00:00.000Z") });
  await store.create({ artifactId: "demo", title: "Demo", initialState: { value: 0 } });

  await assert.rejects(() => store.export("demo", resolve(outside, "exported")), /Canvas export target must stay inside project cwd/);
  await assert.rejects(() => store.export("demo", "../escaped"), /Canvas export target must stay inside project cwd/);
  const exported = await store.export("demo", "exports/demo");

  assert.equal(exported?.exportDir, join(cwd, "exports/demo"));

  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

void test("unsafe ids are rejected or ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-store-"));
  const store = createCanvasStore("/tmp/project", { baseDir: dir });

  await assert.rejects(() => store.create({ artifactId: "../bad", title: "Bad", initialState: {} }), /Unsafe canvas artifact id/);
  assert.equal(await store.read("../bad"), undefined);

  await rm(dir, { recursive: true, force: true });
});

function readJsonLineEvent(line: string): unknown {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("JSONL line must parse to an object");
  return parsed.event;
}

function readJsonLineActor(line: string): unknown {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("JSONL line must parse to an object");
  return parsed.actor;
}

function serializeTestJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
