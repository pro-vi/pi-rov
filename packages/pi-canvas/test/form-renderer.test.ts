import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createDefaultBrowserArtifactRendererRegistry } from "../src/builtin-browser-renderers.js";
import { createFormCanvasRequest, canvasBrowserRenderer } from "../src/builtin-form-renderer.js";
import type { BrowserHostBootstrap } from "../src/browser-renderer.js";
import type { CanvasReadback, JsonObject, JsonValue } from "../src/types.js";
import { parseFormState, reduceWidget, widgetStateToJson } from "../src/widgets/reducers.js";
import { buildFormActions, buildFormInitialState, buildFormStateSchema, readFormDefinition } from "../src/widgets/schema.js";

const PROPS: JsonObject = {
  components: [
    { id: "layout", kind: "single-select", prompt: "Primary layout", required: true, options: [{ id: "a", title: "Sidebar" }, { id: "b", title: "Tabs" }] },
    { id: "extras", kind: "multi-select", prompt: "Nice to haves", options: [{ id: "x", title: "X" }, { id: "y", title: "Y" }] },
  ],
};

function readbackWith(state: JsonValue, props: JsonObject = PROPS): CanvasReadback {
  const def = readFormDefinition(props);
  return {
    source: {
      artifactId: "a1",
      schemaVersion: 2,
      title: "Settings review",
      viewKind: "browser-host-artifact",
      view: {
        kind: "browser-host-artifact",
        bridgeVersion: 1,
        host: "local-browser-host",
        fallback: "terminal-render",
        transport: "http-json",
        rendererId: "builtin.canvas",
        rendererVersion: 1,
        props,
      },
      stateSchema: buildFormStateSchema(),
      initialState: state,
      actions: buildFormActions(def),
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    },
    state: { artifactId: "a1", version: 3, sourceHash: "hash", state, updatedAt: "2026-07-07T00:00:00.000Z" },
    paths: { artifactDir: "", sourcePath: "", statePath: "", actionsPath: "", provenancePath: "" },
  };
}

const bootstrap: BrowserHostBootstrap = {
  artifactId: "a1",
  sessionId: "s1",
  sourceHash: "hash",
  stateVersion: 3,
  state: buildFormInitialState(readFormDefinition(PROPS)),
  token: "tok",
  allowedOrigin: "http://127.0.0.1:1",
};

function answeredState(): JsonValue {
  const def = readFormDefinition(PROPS);
  const state = parseFormState(buildFormInitialState(def), def);
  const layoutDef = def.components[0]!;
  const result = reduceWidget(layoutDef, state.components.layout!, { op: "affirm", optionId: "a" });
  if (!result.ok) throw new Error(result.reason);
  return { form: { submitted: false }, components: { layout: widgetStateToJson(result.next) } };
}

function extractScriptJson(html: string, id: string): string {
  const marker = `<script type="application/json" id="${id}">`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `missing script #${id}`);
  const from = start + marker.length;
  const end = html.indexOf("</script>", from);
  assert.ok(end >= 0, `unterminated script #${id}`);
  return html.slice(from, end);
}

test("renderHtml embeds valid parseable JSON in the bootstrap and form-def blocks (no entity corruption)", () => {
  const html = canvasBrowserRenderer.renderHtml(readbackWith(buildFormInitialState(readFormDefinition(PROPS))), bootstrap);
  const bootRaw = extractScriptJson(html, "pi-host-bootstrap");
  const defRaw = extractScriptJson(html, "pi-form-def");
  // structural quotes/angle-brackets must not be HTML-entity-escaped, or JSON.parse throws (blank page).
  assert.doesNotMatch(bootRaw, /&quot;|&lt;|&gt;/);
  const boot = JSON.parse(bootRaw);
  const def = JSON.parse(defRaw);
  assert.equal(boot.artifactId, "a1");
  assert.equal(boot.token, "tok");
  assert.equal(def.components.length, 2);
  assert.equal(def.components[0].prompt, "Primary layout");
});

test("builtin.canvas is registered in the default registry", () => {
  const registry = createDefaultBrowserArtifactRendererRegistry();
  const renderer = registry.get("builtin.canvas");
  assert.ok(renderer);
  assert.equal(renderer?.id, "builtin.canvas");
});

test("reduceAction affirm returns a single set transition on components.<id>", () => {
  const readback = readbackWith(buildFormInitialState(readFormDefinition(PROPS)));
  const transition = canvasBrowserRenderer.reduceAction(readback, { componentId: "layout", op: "affirm", optionId: "a" });
  assert.equal(transition.kind, "set");
  if (transition.kind === "set") {
    assert.equal(transition.path, "components.layout");
    assert.equal(transition.rendererActionType, "affirm");
  }
});

test("reduceAction rejects an unknown component and an unknown option", () => {
  const readback = readbackWith(buildFormInitialState(readFormDefinition(PROPS)));
  assert.equal(canvasBrowserRenderer.reduceAction(readback, { componentId: "ghost", op: "affirm", optionId: "a" }).kind, "reject");
  assert.equal(canvasBrowserRenderer.reduceAction(readback, { componentId: "layout", op: "affirm", optionId: "zzz" }).kind, "reject");
});

test("reduceAction submit is blocked while a required widget is unanswered", () => {
  const readback = readbackWith(buildFormInitialState(readFormDefinition(PROPS)));
  const blocked = canvasBrowserRenderer.reduceAction(readback, { op: "submit" });
  assert.equal(blocked.kind, "reject");
});

test("summarizeHandoff blocks on required-unanswered and clears once answered — blanks never block", () => {
  const untouched = canvasBrowserRenderer.summarizeHandoff?.(readbackWith(buildFormInitialState(readFormDefinition(PROPS))));
  assert.equal(untouched?.readyForHandoff, false);
  assert.equal(untouched?.status, "pending");
  // Answer the required widget; the optional multi-select stays blank and must not block.
  const answered = canvasBrowserRenderer.summarizeHandoff?.(readbackWith(answeredState()));
  assert.equal(answered, undefined);
});

test("summarizeState exposes formReadback with per-component selections and blanks", () => {
  const summary = canvasBrowserRenderer.summarizeState?.(readbackWith(answeredState()));
  assert.ok(summary);
  const readback = (summary?.fields as JsonObject).formReadback as JsonObject;
  const rollup = readback.rollup as JsonObject;
  assert.equal(rollup.total, 2);
  assert.deepEqual(rollup.requiredRemaining, []);
  const components = readback.components as JsonObject[];
  const layout = components.find((c) => c.id === "layout")!;
  assert.deepEqual(layout.affirmed, ["a"]);
  assert.deepEqual(layout.blank, ["b"]);
});

test("renderHtml emits the form surface, prompts, and the token substrate", () => {
  const html = canvasBrowserRenderer.renderHtml(readbackWith(buildFormInitialState(readFormDefinition(PROPS))), bootstrap);
  assert.match(html, /data-testid="composable-form"/);
  assert.match(html, /Primary layout/);
  assert.match(html, /--pc-accent/);
  assert.match(html, /prefers-color-scheme: dark/);
  // structure is built once and patched in place (so variant iframes are not recreated → no flash)
  assert.match(html, /function syncState/);
});

test("canvas client script serializes in-flight actions (single-flight guard)", () => {
  // Guards against double-submit in the browser; the server also rejects stale/concurrent commits.
  const html = canvasBrowserRenderer.renderHtml(readbackWith(buildFormInitialState(readFormDefinition(PROPS))), bootstrap);
  assert.match(html, /let actionInFlight = false;/);
  assert.match(html, /if \(actionInFlight\) return;/);
  assert.match(html, /finally \{\s*actionInFlight = false;\s*\}/);
});

test("requireSubmit pends handoff until the form is submitted", () => {
  const submitProps: JsonObject = {
    requireSubmit: true,
    components: [{ id: "a", kind: "single-select", prompt: "A", options: [{ id: "x", title: "X" }, { id: "y", title: "Y" }] }],
  };
  const def = readFormDefinition(submitProps);
  const state = parseFormState(buildFormInitialState(def), def);
  const answered = reduceWidget(def.components[0]!, state.components.a!, { op: "affirm", optionId: "x" });
  if (!answered.ok) throw new Error(answered.reason);
  const answeredJson = { form: { submitted: false }, components: { a: widgetStateToJson(answered.next) } };
  const pending = canvasBrowserRenderer.summarizeHandoff?.(readbackWith(answeredJson, submitProps));
  assert.equal(pending?.checkId, "form-submit");
  assert.equal(pending?.readyForHandoff, false);
  const submittedJson = { form: { submitted: true }, components: { a: widgetStateToJson(answered.next) } };
  assert.equal(canvasBrowserRenderer.summarizeHandoff?.(readbackWith(submittedJson, submitProps)), undefined);
});

test("createFormCanvasRequest declares one path per component and rejects a variant without a take", () => {
  const req = createFormCanvasRequest("f1", "Form", {
    components: [{ id: "a", kind: "single-select", prompt: "A", options: [{ id: "x", title: "X" }] }],
  });
  assert.deepEqual(req.actions?.map((action) => action.path), ["components.a", "form.submitted"]);
  assert.equal(req.browserRendererId, "builtin.canvas");
  assert.throws(() =>
    createFormCanvasRequest("f2", "Form", {
      components: [{ id: "v", kind: "design-variant", prompt: "P", options: [{ id: "o", title: "O", html: "<h1>x</h1>" }] }],
    }),
  );
});

test("renderHtml renders design-variant options as sandboxed iframes and blocks external refs", () => {
  const variantProps: JsonObject = {
    components: [
      {
        id: "card",
        kind: "design-variant",
        prompt: "Card style",
        options: [
          { id: "bordered", title: "Bordered", take: "hairline rows, quiet", html: "<h1>Bordered variant</h1>" },
          { id: "evil", title: "Evil", take: "phones home", html: '<script src="https://evil.example/x.js"></script>' },
        ],
      },
    ],
  };
  const state = buildFormInitialState(readFormDefinition(variantProps));
  const html = canvasBrowserRenderer.renderHtml(readbackWith(state, variantProps), bootstrap);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /Bordered variant/);
  assert.match(html, /connect-src &#39;none&#39;|connect-src 'none'/); // strict CSP inside the variant srcdoc
  assert.match(html, /variant blocked/); // external-ref variant is not rendered
  assert.doesNotMatch(html, /evil\.example/); // blocked content never reaches the page
  // the form-def JSON (with variant srcdoc full of </...> tags) must still parse cleanly
  const def = JSON.parse(extractScriptJson(html, "pi-form-def"));
  const cardOptions = def.components[0].options as Array<Record<string, string>>;
  const srcdoc = cardOptions[0]?.srcdoc;
  assert.ok(srcdoc);
  assert.match(srcdoc, /<h1>Bordered variant<\/h1>/);
});

test("form client escapes hostile widget text into the DOM (executable XSS pin)", () => {
  // The client JSON-parses the form-def and re-renders widget text into app.innerHTML via esc().
  // Execute it against a hostile form-def and assert no attribute breakout — this pins esc() so a
  // future unescaped interpolation site fails the suite instead of shipping.
  const hostileProps: JsonObject = {
    components: [
      { id: "q", kind: "single-select", prompt: 'x" autofocus data-owned="bad', options: [{ id: "a", title: 'y" onmouseover="evil()' }, { id: "b", title: "B" }] },
    ],
  };
  const html = canvasBrowserRenderer.renderHtml(readbackWith(buildFormInitialState(readFormDefinition(hostileProps)), hostileProps), bootstrap);
  const bootstrapJson = extractScriptJson(html, "pi-host-bootstrap");
  const formDefJson = extractScriptJson(html, "pi-form-def");
  const clientScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(clientScript, "client script present");

  let appHtml = "";
  const el = (): Record<string, unknown> => ({
    textContent: "",
    className: "",
    value: "",
    disabled: false,
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector: () => el(),
    querySelectorAll: () => [],
    addEventListener() {},
  });
  const app: Record<string, unknown> = {
    get innerHTML() {
      return appHtml;
    },
    set innerHTML(value: string) {
      appHtml = value;
    },
    querySelector: () => el(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const documentStub = {
    querySelector(selector: string) {
      if (selector === "#pi-host-bootstrap") return { textContent: bootstrapJson };
      if (selector === "#pi-form-def") return { textContent: formDefJson };
      if (selector === "#app") return app;
      return el();
    },
  };
  runInNewContext(clientScript, { document: documentStub });

  assert.ok(appHtml.length > 0, "client rendered into #app");
  assert.doesNotMatch(appHtml, /autofocus data-owned="bad"/); // no attribute breakout
  assert.doesNotMatch(appHtml, /onmouseover="evil\(\)"/);
  assert.match(appHtml, /&quot;/); // the hostile quotes were entity-escaped
});
