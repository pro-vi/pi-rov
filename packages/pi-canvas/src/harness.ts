import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BrowserArtifactRenderer, BrowserRendererTransition } from "./browser-renderer.js";
import { createDefaultCanvasRendererRegistry } from "./builtin-canvas-renderers.js";
import { createBrowserHostArtifactView, createDefaultBrowserArtifactRendererRegistry } from "./builtin-browser-renderers.js";
import {
  LocalBrowserHostSession,
  readActionLog,
  type BrowserHostActionOutcome,
  type BrowserHostSessionReceipt,
} from "./browser-host.js";
import { createFormCanvasRequest } from "./builtin-form-renderer.js";
import { summarizeBrowserHostEvidenceReceipts, withBrowserHostReadiness, writeBrowserHostEvidenceExport } from "./browser-host-evidence.js";
import { createHtmlIframeBridgeView, parseIframeBridgeSetMessage, validateHtmlIframeBridgePolicy } from "./html-iframe-bridge.js";
import { isJsonValue, isRecord, readNumber, readString } from "./json.js";
import { PiCanvasRuntime } from "./runtime.js";
import { createCanvasStore, sha256 } from "./store.js";
import { createCanvasTuiSurface } from "./surface.js";
import { registerCanvasTools } from "./tools.js";
import type { BrowserVisualEvidenceKind, CanvasExportResult, CanvasReadback, CreateCanvasRequest, HarnessAssertion, JsonObject, JsonValue, PiCanvasHarnessRun } from "./types.js";

// Runtime source of truth for scenario ids (mirrored 1:1 into the HarnessScenarioId
// type below) so callers that receive an untrusted/CLI id — e.g. scripts/harness.mjs —
// can validate it before dispatch instead of hitting an undefined-run TypeError.
export const HARNESS_SCENARIO_IDS = [
  "roundtrip-green",
  "rpc-ui-roundtrip-green",
  "direct-tui-roundtrip-green",
  "live-tui-roundtrip-green",
  "browser-terminal-roundtrip-green",
  "iframe-state-bridge-contract-green",
  "iframe-action-roundtrip-green",
  "iframe-holdout-task-board-green",
  "browser-terminal-replay-agreement-green",
  "browser-host-contract-green",
  "browser-host-review-note-green",
  "browser-host-same-trace-success-gate-green",
  "browser-host-reopen-focus-green",
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
] as const;

export type HarnessScenarioId = (typeof HARNESS_SCENARIO_IDS)[number];

export interface HarnessOptions {
  scenarioId: HarnessScenarioId;
  candidateId?: string;
  baseDir?: string;
  cwd?: string;
  reportsDir?: string;
  piVersion?: string;
  extensionVersion?: string;
}

export async function runHarnessScenario(options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const candidateId = options.candidateId ?? defaultCandidateId(options.scenarioId);
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "pi-canvas-cwd-")));
  const baseDir = options.baseDir ?? (await mkdtemp(join(tmpdir(), "pi-canvas-store-")));
  const reportsDir = options.reportsDir ?? join(process.cwd(), "reports", "harness");
  const runId = `${options.scenarioId}-${Date.now()}`;
  const store = createCanvasStore(cwd, { baseDir, now: fixedNow });
  const context = { store, runId, scenarioId: options.scenarioId, candidateId, cwd, reportsDir };

  switch (options.scenarioId) {
    case "roundtrip-green":
      return writeRun(context, await runRoundtripGreen(context, options));
    case "rpc-ui-roundtrip-green":
      return writeRun(context, await runRpcUiRoundtripGreen(context, options));
    case "direct-tui-roundtrip-green":
      return writeRun(context, await runDirectTuiRoundtripGreen(context, options));
    case "live-tui-roundtrip-green":
      return writeRun(context, await runLiveTuiRoundtripGreen(context, options));
    case "browser-terminal-roundtrip-green":
      return writeRun(context, await runBrowserTerminalRoundtripGreen(context, options));
    case "iframe-state-bridge-contract-green":
      return writeRun(context, await runIframeStateBridgeContractGreen(context, options));
    case "iframe-action-roundtrip-green":
      return writeRun(context, await runIframeActionRoundtripGreen(context, options));
    case "iframe-holdout-task-board-green":
      return writeRun(context, await runIframeHoldoutTaskBoardGreen(context, options));
    case "browser-terminal-replay-agreement-green":
      return writeRun(context, await runBrowserTerminalReplayAgreementGreen(context, options));
    case "browser-host-contract-green":
      return writeRun(context, await runBrowserHostContractGreen(context, options));
    case "browser-host-review-note-green":
      return writeRun(context, await runBrowserHostReviewNoteGreen(context, options));
    case "browser-host-same-trace-success-gate-green":
      return writeRun(context, await runBrowserHostSameTraceSuccessGateGreen(context, options));
    case "browser-host-reopen-focus-green":
      return writeRun(context, await runBrowserHostReopenFocusGreen(context, options));
    case "visual-only-red":
      return writeRun(context, await runVisualOnlyRed(context, options));
    case "unpersisted-state-red":
      return writeRun(context, await runUnpersistedStateRed(context, options));
    case "export-without-diff-red":
      return writeRun(context, await runExportWithoutDiffRed(context, options));
    case "browser-terminal-disagreement-red":
      return writeRun(context, await runBrowserTerminalDisagreementRed(context, options));
    case "iframe-visual-only-red":
      return writeRun(context, await runIframeVisualOnlyRed(context, options));
    case "iframe-unpersisted-state-red":
      return writeRun(context, await runIframeUnpersistedStateRed(context, options));
    case "iframe-bridge-disagreement-red":
      return writeRun(context, await runIframeBridgeDisagreementRed(context, options));
    case "iframe-sandbox-policy-red":
      return writeRun(context, await runIframeSandboxPolicyRed(context, options));
    case "browser-terminal-replay-disagreement-red":
      return writeRun(context, await runBrowserTerminalReplayDisagreementRed(context, options));
    case "browser-host-raw-html-file-red":
      return writeRun(context, await runBrowserHostRawHtmlFileRed(context, options));
    case "browser-host-dom-state-red":
      return writeRun(context, await runBrowserHostDomStateRed(context, options));
    case "browser-host-stale-version-red":
      return writeRun(context, await runBrowserHostStaleVersionRed(context, options));
    case "browser-host-concurrent-stale-red":
      return writeRun(context, await runBrowserHostConcurrentStaleRed(context, options));
    case "browser-host-wrong-session-red":
      return writeRun(context, await runBrowserHostWrongSessionRed(context, options));
    case "browser-host-export-without-diff-red":
      return writeRun(context, await runBrowserHostExportWithoutDiffRed(context, options));
    case "browser-host-visual-only-red":
      return writeRun(context, await runBrowserHostVisualOnlyRed(context, options));
    case "browser-host-layout-overflow-red":
      return writeRun(context, await runBrowserHostLayoutFixtureRed(context, options, "overflow"));
    case "browser-host-layout-clipped-text-red":
      return writeRun(context, await runBrowserHostLayoutFixtureRed(context, options, "clipped-text"));
    case "browser-host-layout-overlap-red":
      return writeRun(context, await runBrowserHostLayoutFixtureRed(context, options, "overlap"));
  }
}

function defaultCandidateId(scenarioId: HarnessScenarioId): string {
  if (scenarioId === "browser-host-raw-html-file-red") return "open-html-file-workaround";
  if (scenarioId === "browser-host-dom-state-red") return "browser-dom-state-workaround";
  if (scenarioId.startsWith("browser-host-layout-")) return "broken-browser-host-layout-fixture";
  if (scenarioId.startsWith("browser-host-")) return "pi-owned-browser-host-artifact";
  return scenarioId.startsWith("iframe-") || scenarioId === "browser-terminal-replay-agreement-green" || scenarioId === "browser-terminal-replay-disagreement-red"
    ? "html-iframe-state-bridge-apps-style"
    : "pi-tui-renderer-registry";
}

function createCanvasHostFixture(artifactId: string): CreateCanvasRequest {
  return createFormCanvasRequest(artifactId, "Canvas Fixture", {
    components: [
      { id: "choice", kind: "single-select", prompt: "Pick one", options: [{ id: "option-a", title: "Option A" }, { id: "option-b", title: "Option B" }] },
    ],
  });
}

interface ScenarioContext {
  store: ReturnType<typeof createCanvasStore>;
  runId: string;
  scenarioId: HarnessScenarioId;
  candidateId: string;
  cwd: string;
  reportsDir: string;
}

async function runRoundtripGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const created = await context.store.create({ artifactId: "roundtrip", title: "Roundtrip", initialState: { value: 0 } });
  const updated = await context.store.update({ artifactId: created.source.artifactId, path: "value", value: 1, actor: "fixture-user" });
  const exported = await context.store.export(updated.source.artifactId);
  const readbackPath = await writeReadback(context, updated);
  const assertions = [
    pass("source.exists", "source", "source file exists separately", created.paths.sourcePath, created.paths.sourcePath),
    pass("state.updated", "state", "state version increments after action", String(updated.state.version), updated.paths.statePath),
    pass("interaction.logged", "interaction", "action log records user mutation", updated.latestProvenance?.actionId ?? "missing", updated.paths.actionsPath),
    pass("readback.matches", "state", "canvas_read equivalent returns persisted state", JSON.stringify(updated.state.state), readbackPath),
    exported
      ? pass("export.diffable", "export", "export emits source/state/provenance diff artifacts", exported.exportDir, exported.stateDiffPath)
      : fail("export.diffable", "export", "export result exists", "missing", ""),
    pass("terminal.degraded", "terminal-browser", "browser-terminal proof is explicitly degraded", "degraded", readbackPath),
  ];
  return makeRun(context, options, assertions, updated, exported, readbackPath);
}

async function runRpcUiRoundtripGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "rpc-roundtrip";
  const rpcTrace = await runPiRpcPrompts(context, [
    `/canvas create ${artifactId} {"value":0}`,
    `/canvas update ${artifactId} value 1`,
    `/canvas read ${artifactId}`,
    `/canvas export ${artifactId} rpc-export`,
  ]);
  const exported = readExportEvent(rpcTrace.canvasEvents);
  const readEvent = readCanvasEventByName(rpcTrace.canvasEvents, "read");
  const updatedEvent = readCanvasEventByName(rpcTrace.canvasEvents, "updated");
  const persistedState = await readPersistedState(readEvent?.statePath);
  const assertions = [
    rpcTrace.exitCode === 0
      ? pass("rpc.exit", "terminal-browser", "Pi RPC process exits 0", String(rpcTrace.exitCode), rpcTrace.stdoutPath)
      : fail("rpc.exit", "terminal-browser", "Pi RPC process exits 0", String(rpcTrace.exitCode), rpcTrace.stderrPath),
    rpcTrace.uiNotifications.length >= 4
      ? pass("rpc.notifications", "terminal-browser", "RPC UI emits canvas notifications", String(rpcTrace.uiNotifications.length), rpcTrace.stdoutPath)
      : fail("rpc.notifications", "terminal-browser", "RPC UI emits canvas notifications", String(rpcTrace.uiNotifications.length), rpcTrace.stdoutPath),
    updatedEvent && JSON.stringify(updatedEvent.state) === "{\"value\":1}"
      ? pass("rpc.update-event", "interaction", "RPC update event carries mutated state", JSON.stringify(updatedEvent.state), rpcTrace.stdoutPath)
      : fail("rpc.update-event", "interaction", "RPC update event carries mutated state", updatedEvent ? JSON.stringify(updatedEvent.state) : "missing", rpcTrace.stdoutPath),
    persistedState && JSON.stringify(persistedState) === "{\"value\":1}"
      ? pass("state.persisted", "state", "durable store agrees with RPC update", JSON.stringify(persistedState), readEvent?.statePath ?? rpcTrace.stdoutPath)
      : fail("state.persisted", "state", "durable store agrees with RPC update", persistedState ? JSON.stringify(persistedState) : "missing", rpcTrace.stdoutPath),
    readEvent && JSON.stringify(readEvent.state) === JSON.stringify(persistedState)
      ? pass("readback.agrees", "state", "RPC read event agrees with durable state", JSON.stringify(readEvent.state), rpcTrace.stdoutPath)
      : fail("readback.agrees", "state", "RPC read event agrees with durable state", readEvent ? JSON.stringify(readEvent.state) : "missing", rpcTrace.stdoutPath),
    exported
      ? pass("export.diffable", "export", "RPC export emits diffable source/state/provenance paths", exported.exportDir, exported.stateDiffPath)
      : fail("export.diffable", "export", "RPC export emits diffable source/state/provenance paths", "missing", rpcTrace.stdoutPath),
    pass("browser.degraded", "terminal-browser", "browser/custom TUI proof remains absent", "rpc-only", rpcTrace.stdoutPath),
  ];
  return makeRun(context, options, assertions, eventReadback(readEvent), exported, rpcTrace.stdoutPath, rpcTrace.observableEvents, "rpc", rpcTrace.stdoutPath);
}

async function runDirectTuiRoundtripGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "tui-roundtrip";
  const registry = createDefaultCanvasRendererRegistry();
  const counterRenderer = registry.require("builtin.counter");
  const counterActions = counterRenderer.defaultActions?.map((action) => ({ ...action }));
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create({
    artifactId,
    title: "TUI Roundtrip",
    initialState: { count: 0 },
    rendererId: counterRenderer.id,
    rendererVersion: counterRenderer.version,
    ...(counterActions === undefined ? {} : { actions: counterActions }),
  });
  let renderRequests = 0;
  const surface = await createCanvasTuiSurface({
    runtime,
    registry,
    artifactId,
    host: {
      requestRender() {
        renderRequests += 1;
      },
    },
  });
  const beforeRender = surface.render(80);
  surface.handleInput("+");
  await surface.waitForIdle();
  const afterRender = surface.render(80);
  surface.handleInput("e");
  await surface.waitForIdle();
  const exported = surface.getLatestExport();
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const transcriptPath = join(context.reportsDir, `${context.runId}-tui-transcript.txt`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(
    transcriptPath,
    [
      "[before]",
      ...beforeRender,
      "",
      "[after]",
      ...afterRender,
      "",
      "[events]",
      ...surface.getObservableEvents(),
    ].join("\n"),
    "utf-8",
  );
  const persistedState = readback?.state.state;
  const assertions = [
    beforeRender.some((line) => line.includes("pi-canvas: TUI Roundtrip"))
      ? pass("tui.render", "view", "custom TUI component renders artifact state", beforeRender.join("\\n"), transcriptPath)
      : fail("tui.render", "view", "custom TUI component renders artifact state", beforeRender.join("\\n"), transcriptPath),
    renderRequests >= 2
      ? pass("tui.request-render", "view", "TUI component requests rerender after interaction/export", String(renderRequests), transcriptPath)
      : fail("tui.request-render", "view", "TUI component requests rerender after interaction/export", String(renderRequests), transcriptPath),
    surface.getObservableEvents().some((event) => event.includes("tui input + set count=1"))
      ? pass("tui.interaction", "interaction", "keyboard input mutates through renderer-owned TUI surface", surface.getObservableEvents().join("\\n"), transcriptPath)
      : fail("tui.interaction", "interaction", "keyboard input mutates through renderer-owned TUI surface", surface.getObservableEvents().join("\\n"), transcriptPath),
    persistedState && JSON.stringify(persistedState) === "{\"count\":1}"
      ? pass("state.persisted", "state", "durable store agrees with TUI interaction", JSON.stringify(persistedState), readback?.paths.statePath ?? transcriptPath)
      : fail("state.persisted", "state", "durable store agrees with TUI interaction", persistedState ? JSON.stringify(persistedState) : "missing", transcriptPath),
    readback && JSON.stringify(surface.getReadback().state.state) === JSON.stringify(readback.state.state)
      ? pass("readback.agrees", "state", "component state agrees with agent readback", JSON.stringify(readback.state.state), readbackPath)
      : fail("readback.agrees", "state", "component state agrees with agent readback", readback ? JSON.stringify(readback.state.state) : "missing", readbackPath),
    exported
      ? pass("export.diffable", "export", "TUI-triggered export emits diffable review paths", exported.exportDir, exported.stateDiffPath)
      : fail("export.diffable", "export", "TUI-triggered export emits diffable review paths", "missing", transcriptPath),
    pass("browser.degraded", "terminal-browser", "browser-addressable terminal proof remains absent", "direct-tui-only", transcriptPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, exported, readbackPath, surface.getObservableEvents(), "tui", transcriptPath);
}

async function runLiveTuiRoundtripGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "live-tui-roundtrip";
  const liveTrace = await runPiLiveTuiPty(context, artifactId);
  const liveStore = createCanvasStore(liveTrace.cwd, { baseDir: join(liveTrace.agentDir, "pi-canvas") });
  const readback = await liveStore.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const exported = readback ? exportFromReadback(readback) : undefined;
  const stateMatches = readback ? JSON.stringify(readback.state.state) === "{\"count\":1}" : false;
  const exportDiffExists = exported ? (await fileExists(exported.stateDiffPath)) && (await fileExists(exported.sourceDiffPath)) : false;
  const assertions = [
    liveTrace.checks.tuiRendered
      ? pass("tty.render", "view", "live Pi TTY renders the custom TUI surface", "rendered", liveTrace.transcriptPath)
      : fail("tty.render", "view", "live Pi TTY renders the custom TUI surface", "missing", liveTrace.transcriptPath),
    liveTrace.checks.tuiStateRendered
      ? pass("tty.interaction", "interaction", "keyboard input mutates visible renderer state", "Count: 1", liveTrace.transcriptPath)
      : fail("tty.interaction", "interaction", "keyboard input mutates visible renderer state", "missing", liveTrace.transcriptPath),
    stateMatches
      ? pass("state.persisted", "state", "durable store agrees with live TTY interaction", JSON.stringify(readback?.state.state), readback?.paths.statePath ?? liveTrace.transcriptPath)
      : fail("state.persisted", "state", "durable store agrees with live TTY interaction", readback ? JSON.stringify(readback.state.state) : "missing", liveTrace.transcriptPath),
    liveTrace.checks.readEvent && liveTrace.checks.readState
      ? pass("readback.visible", "state", "agent command readback reports mutated state after TUI closes", "read state count=1", liveTrace.transcriptPath)
      : fail("readback.visible", "state", "agent command readback reports mutated state after TUI closes", "missing", liveTrace.transcriptPath),
    exportDiffExists && exported
      ? pass("export.diffable", "export", "live TUI-triggered export emits diffable review paths", exported.exportDir, exported.stateDiffPath)
      : fail("export.diffable", "export", "live TUI-triggered export emits diffable review paths", "missing", liveTrace.transcriptPath),
    pass("browser.degraded", "terminal-browser", "browser-addressable terminal proof remains absent", "live-tty-only", liveTrace.transcriptPath),
  ];
  return makeRun(context, options, assertions, readback, exported, readbackPath, liveTrace.observableEvents, "tui", liveTrace.transcriptPath, true);
}

async function runBrowserTerminalRoundtripGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-terminal-roundtrip";
  const browserTrace = await runPiBrowserTerminalPty(context, artifactId);
  const browserStore = createCanvasStore(browserTrace.cwd, { baseDir: join(browserTrace.agentDir, "pi-canvas") });
  const readback = await browserStore.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const exported = readback ? exportFromReadback(readback) : undefined;
  const stateMatches = readback ? JSON.stringify(readback.state.state) === "{\"count\":1}" : false;
  const exportDiffExists = exported ? (await fileExists(exported.stateDiffPath)) && (await fileExists(exported.sourceDiffPath)) : false;
  const browserSnapshotExists = await fileExists(browserTrace.browserSnapshotPath);
  const assertions = [
    browserTrace.checks.tuiRenderedBrowser && browserSnapshotExists
      ? pass("browser.render", "terminal-browser", "browser automation observes the live Pi TUI surface", "rendered in browser DOM", browserTrace.browserSnapshotPath)
      : fail("browser.render", "terminal-browser", "browser automation observes the live Pi TUI surface", "missing", browserTrace.terminalTranscriptPath),
    browserTrace.checks.tuiStateBrowser
      ? pass("browser.interaction", "interaction", "browser-driven input mutates visible renderer state", "Count: 1", browserTrace.terminalTranscriptPath)
      : fail("browser.interaction", "interaction", "browser-driven input mutates visible renderer state", "missing", browserTrace.terminalTranscriptPath),
    stateMatches
      ? pass("state.persisted", "state", "durable store agrees with browser-terminal interaction", JSON.stringify(readback?.state.state), readback?.paths.statePath ?? browserTrace.terminalTranscriptPath)
      : fail("state.persisted", "state", "durable store agrees with browser-terminal interaction", readback ? JSON.stringify(readback.state.state) : "missing", browserTrace.terminalTranscriptPath),
    browserTrace.checks.readBrowser && browserTrace.checks.readStateBrowser
      ? pass("readback.visible", "state", "browser-visible terminal readback reports mutated state", "read state count=1", browserTrace.terminalTranscriptPath)
      : fail("readback.visible", "state", "browser-visible terminal readback reports mutated state", "missing", browserTrace.terminalTranscriptPath),
    exportDiffExists && exported
      ? pass("export.diffable", "export", "browser-terminal TUI export emits diffable review paths", exported.exportDir, exported.stateDiffPath)
      : fail("export.diffable", "export", "browser-terminal TUI export emits diffable review paths", "missing", browserTrace.terminalTranscriptPath),
    browserTrace.checks.createdBrowser && browserTrace.checks.tuiExportBrowser && browserTrace.checks.tuiClosedBrowser
      ? pass("browser.agreement", "terminal-browser", "browser-visible events cover create, export, close, and read", browserTrace.observableEvents.join("\\n"), browserTrace.browserLogPath)
      : fail("browser.agreement", "terminal-browser", "browser-visible events cover create, export, close, and read", "missing", browserTrace.browserLogPath),
  ];
  return makeRun(
    context,
    options,
    assertions,
    readback,
    exported,
    readbackPath,
    browserTrace.observableEvents,
    "browser-terminal",
    browserTrace.terminalTranscriptPath,
    true,
    browserTrace.browserScreenshotPath,
  );
}

async function runIframeStateBridgeContractGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "iframe-contract";
  const iframeHtml = "<button data-action=\"increment\">Increment</button>";
  const actionSchema = {
    type: "object",
    required: ["artifactId", "path", "value"],
    properties: {
      artifactId: { type: "string" },
      path: { type: "string" },
      value: { type: "number" },
    },
    additionalProperties: false,
  };
  const stateSchema = {
    type: "object",
    required: ["count"],
    properties: { count: { type: "number" } },
    additionalProperties: false,
  };
  const view = createHtmlIframeBridgeView({
    actionSchema,
    htmlSourceHash: sha256(iframeHtml),
    props: { label: "Increment" },
  });
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create({
    artifactId,
    title: "Iframe Contract",
    initialState: { count: 0 },
    viewKind: "html-iframe-state-bridge",
    view,
    stateSchema,
    actions: [{ type: "set", path: "count", label: "Set count" }],
  });
  const policy = created.source.view?.kind === "html-iframe-state-bridge" ? validateHtmlIframeBridgePolicy(created.source.view) : { ok: false, reasons: ["missing iframe view"] };
  const bridgeMessage = {
    jsonrpc: "2.0",
    method: "canvas.set",
    id: "ui-1",
    params: {
      artifactId,
      path: "count",
      value: 1,
    },
  };
  const sourceViewForBridge = created.source.view?.kind === "html-iframe-state-bridge" ? created.source.view : undefined;
  const updateRequest = parseIframeBridgeSetMessage(bridgeMessage, artifactId, sourceViewForBridge);
  const updated = await runtime.update(updateRequest);
  const readback = await runtime.read(artifactId);
  const exported = await runtime.export(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const actionLog = await readFile(updated.paths.actionsPath, "utf-8");
  const sourceView = updated.source.view;
  const assertions = [
    sourceView?.kind === "html-iframe-state-bridge" && updated.source.viewKind === "html-iframe-state-bridge"
      ? pass("iframe.view-kind", "source", "source declares iframe bridge view without making HTML canonical state", sourceView.kind, updated.paths.sourcePath)
      : fail("iframe.view-kind", "source", "source declares iframe bridge view without making HTML canonical state", updated.source.viewKind, updated.paths.sourcePath),
    sourceView?.kind === "html-iframe-state-bridge" && sourceView.host === "adjacent-browser-host" && sourceView.fallback === "terminal-render"
      ? pass("iframe.host-boundary", "view", "iframe host boundary and terminal fallback are explicit", `${sourceView.host}/${sourceView.fallback}`, updated.paths.sourcePath)
      : fail("iframe.host-boundary", "view", "iframe host boundary and terminal fallback are explicit", "missing", updated.paths.sourcePath),
    policy.ok
      ? pass("iframe.sandbox-policy", "view", "sandbox and CSP policy are declared and strict", JSON.stringify(sourceView), updated.paths.sourcePath)
      : fail("iframe.sandbox-policy", "view", "sandbox and CSP policy are declared and strict", policy.reasons.join("; "), updated.paths.sourcePath),
    sourceView?.kind === "html-iframe-state-bridge" && sourceView.transport === "postMessage-json-rpc" && sourceView.actionSchema.type === "object"
      ? pass("iframe.bridge-schema", "interaction", "UI-to-Pi action bridge declares typed JSON-RPC schema", sourceView.transport, updated.paths.sourcePath)
      : fail("iframe.bridge-schema", "interaction", "UI-to-Pi action bridge declares typed JSON-RPC schema", "missing", updated.paths.sourcePath),
    JSON.stringify(updated.state.state) === "{\"count\":1}" && /"actor":"iframe-bridge"/.test(actionLog)
      ? pass("iframe.bridge-action-persisted", "state", "typed bridge action mutates Pi-owned state and action log", JSON.stringify(updated.state.state), updated.paths.actionsPath)
      : fail("iframe.bridge-action-persisted", "state", "typed bridge action mutates Pi-owned state and action log", `${JSON.stringify(updated.state.state)} ${actionLog}`, updated.paths.actionsPath),
    readback && JSON.stringify(readback.state.state) === JSON.stringify(updated.state.state)
      ? pass("iframe.readback-agrees", "state", "agent readback agrees with Pi-owned state after bridge action", JSON.stringify(readback.state.state), readbackPath)
      : fail("iframe.readback-agrees", "state", "agent readback agrees with Pi-owned state after bridge action", readback ? JSON.stringify(readback.state.state) : "missing", readbackPath),
    exported && exported.stateDiffPath && exported.sourceDiffPath
      ? pass("iframe.export-diffable", "export", "export emits source/state/provenance diffs; iframe HTML is not the only review artifact", exported.exportDir, exported.stateDiffPath)
      : fail("iframe.export-diffable", "export", "export emits source/state/provenance diffs; iframe HTML is not the only review artifact", "missing", readbackPath),
  ];
  return makeRun(
    context,
    options,
    assertions,
    readback ?? updated,
    exported,
    readbackPath,
    ["adjacent iframe rendered declared htmlSourceHash", "postMessage-json-rpc canvas.set count=1"],
    "degraded",
    readbackPath,
    false,
  );
}

async function runIframeActionRoundtripGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "iframe-action-roundtrip";
  const iframeHtml = "<form><input name=\"title\"><button data-action=\"save\">Save</button></form>";
  const actionSchema = createIframeSetActionSchema();
  const stateSchema = {
    type: "object",
    required: ["form"],
    properties: {
      form: {
        type: "object",
        required: ["title", "done"],
        properties: {
          title: { type: "string" },
          done: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
  const view = createHtmlIframeBridgeView({
    actionSchema,
    htmlSourceHash: sha256(iframeHtml),
    props: { fields: ["title", "done"] },
  });
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create({
    artifactId,
    title: "Iframe Action Roundtrip",
    initialState: { form: { title: "Draft", done: false } },
    viewKind: "html-iframe-state-bridge",
    view,
    stateSchema,
    actions: [
      { type: "set", path: "form.title", label: "Set title" },
      { type: "set", path: "form.done", label: "Set done" },
    ],
  });
  const sourceView = created.source.view?.kind === "html-iframe-state-bridge" ? created.source.view : undefined;
  const titleRequest = parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "form.title", "Published"), artifactId, sourceView);
  const titleUpdated = await runtime.update(titleRequest);
  const doneRequest = parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "form.done", true), artifactId, sourceView);
  const doneUpdated = await runtime.update(doneRequest);
  let malformedRejected = "";
  try {
    parseIframeBridgeSetMessage({ jsonrpc: "2.0", method: "canvas.set", params: { artifactId, path: "form.title", value: "Ignored", extra: true } }, artifactId, sourceView);
  } catch (error) {
    malformedRejected = error instanceof Error ? error.message : String(error);
  }
  const readback = await runtime.read(artifactId);
  const exported = await runtime.export(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const hostTracePath = join(context.reportsDir, `${context.runId}-adjacent-host-trace.json`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(
    hostTracePath,
    `${JSON.stringify(
      {
        host: "adjacent-browser-host",
        htmlSourceHash: sourceView?.htmlSourceHash,
        visibleBefore: "Title: Draft; Done: false",
        bridgeMessages: [iframeSetMessage(artifactId, "form.title", "Published"), iframeSetMessage(artifactId, "form.done", true)],
        malformedRejected,
        visibleAfter: "Title: Published; Done: true",
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const actionLog = await readFile(doneUpdated.paths.actionsPath, "utf-8");
  const assertions = [
    sourceView?.host === "adjacent-browser-host" && sourceView.fallback === "terminal-render"
      ? pass("iframe.host-rendered", "view", "declared adjacent host renders iframe view with terminal fallback", sourceView.host, hostTracePath)
      : fail("iframe.host-rendered", "view", "declared adjacent host renders iframe view with terminal fallback", "missing", hostTracePath),
    JSON.stringify(titleUpdated.state.state) === "{\"form\":{\"title\":\"Published\",\"done\":false}}"
      ? pass("iframe.first-action", "interaction", "first typed bridge action persists a string field", JSON.stringify(titleUpdated.state.state), titleUpdated.paths.statePath)
      : fail("iframe.first-action", "interaction", "first typed bridge action persists a string field", JSON.stringify(titleUpdated.state.state), titleUpdated.paths.statePath),
    JSON.stringify(doneUpdated.state.state) === "{\"form\":{\"title\":\"Published\",\"done\":true}}" && actionLog.includes("\"actor\":\"iframe-bridge\"")
      ? pass("iframe.second-action", "state", "second typed bridge action persists a boolean field in Pi state", JSON.stringify(doneUpdated.state.state), doneUpdated.paths.actionsPath)
      : fail("iframe.second-action", "state", "second typed bridge action persists a boolean field in Pi state", `${JSON.stringify(doneUpdated.state.state)} ${actionLog}`, doneUpdated.paths.actionsPath),
    malformedRejected.includes("not allowed by actionSchema")
      ? pass("iframe.malformed-rejected", "interaction", "bridge rejects malformed action params against declared schema", malformedRejected, hostTracePath)
      : fail("iframe.malformed-rejected", "interaction", "bridge rejects malformed action params against declared schema", malformedRejected || "not rejected", hostTracePath),
    readback && JSON.stringify(readback.state.state) === JSON.stringify(doneUpdated.state.state)
      ? pass("iframe.readback-agrees", "state", "agent readback agrees after adjacent-host bridge actions", JSON.stringify(readback.state.state), readbackPath)
      : fail("iframe.readback-agrees", "state", "agent readback agrees after adjacent-host bridge actions", readback ? JSON.stringify(readback.state.state) : "missing", readbackPath),
    exported && exported.stateDiffPath && exported.sourceDiffPath
      ? pass("iframe.export-diffable", "export", "roundtrip export emits diffable source/state review artifacts", exported.exportDir, exported.stateDiffPath)
      : fail("iframe.export-diffable", "export", "roundtrip export emits diffable source/state review artifacts", "missing", readbackPath),
  ];
  return makeRun(
    context,
    options,
    assertions,
    readback ?? doneUpdated,
    exported,
    readbackPath,
    ["adjacent iframe form rendered", "postMessage-json-rpc form.title=Published", "postMessage-json-rpc form.done=true"],
    "degraded",
    hostTracePath,
    false,
  );
}

async function runIframeHoldoutTaskBoardGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "iframe-holdout-task-board";
  const iframeHtml = "<section data-view=\"task-board\"><input name=\"filter\"><button data-sort=\"priority\">Sort</button><ol data-tasks></ol></section>";
  const actionSchema = createIframeSetActionSchema();
  const stateSchema = {
    type: "object",
    required: ["board"],
    properties: {
      board: {
        type: "object",
        required: ["filter", "sortKey", "selectedTaskId", "tasksById"],
        properties: {
          filter: { type: "string", enum: ["all", "active", "done"] },
          sortKey: { type: "string", enum: ["priority", "title"] },
          selectedTaskId: { type: "string", enum: ["taskA", "taskB", "taskC"] },
          tasksById: {
            type: "object",
            required: ["taskA", "taskB", "taskC"],
            properties: {
              taskA: taskStateSchema(),
              taskB: taskStateSchema(),
              taskC: taskStateSchema(),
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
  const view = createHtmlIframeBridgeView({
    actionSchema,
    htmlSourceHash: sha256(iframeHtml),
    props: {
      holdout: "task-board-filter-sort-select",
      fields: ["filter", "sortKey", "selectedTaskId", "tasksById.taskB.done"],
    },
  });
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create({
    artifactId,
    title: "Iframe Holdout Task Board",
    initialState: {
      board: {
        filter: "all",
        sortKey: "title",
        selectedTaskId: "taskA",
        tasksById: {
          taskA: { title: "Draft spec", priority: 2, done: false },
          taskB: { title: "Review bridge", priority: 1, done: false },
          taskC: { title: "Archive notes", priority: 3, done: true },
        },
      },
    },
    viewKind: "html-iframe-state-bridge",
    view,
    stateSchema,
    actions: [
      { type: "set", path: "board.filter", label: "Set board filter" },
      { type: "set", path: "board.sortKey", label: "Set sort key" },
      { type: "set", path: "board.selectedTaskId", label: "Select task" },
      { type: "set", path: "board.tasksById.taskB.done", label: "Toggle review task" },
    ],
  });
  const sourceView = created.source.view?.kind === "html-iframe-state-bridge" ? created.source.view : undefined;
  const filterUpdated = await runtime.update(parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "board.filter", "active"), artifactId, sourceView));
  const sortUpdated = await runtime.update(parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "board.sortKey", "priority"), artifactId, sourceView));
  const selectedUpdated = await runtime.update(parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "board.selectedTaskId", "taskB"), artifactId, sourceView));
  const doneUpdated = await runtime.update(parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "board.tasksById.taskB.done", true), artifactId, sourceView));
  let invalidFilterRejected = "";
  try {
    await runtime.update(parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "board.filter", "archived"), artifactId, sourceView));
  } catch (error) {
    invalidFilterRejected = error instanceof Error ? error.message : String(error);
  }
  const readback = await runtime.read(artifactId);
  const exported = await runtime.export(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const hostTracePath = join(context.reportsDir, `${context.runId}-task-board-host-trace.json`);
  await mkdir(context.reportsDir, { recursive: true });
  const bridgeMessages = [
    iframeSetMessage(artifactId, "board.filter", "active"),
    iframeSetMessage(artifactId, "board.sortKey", "priority"),
    iframeSetMessage(artifactId, "board.selectedTaskId", "taskB"),
    iframeSetMessage(artifactId, "board.tasksById.taskB.done", true),
  ];
  await writeFile(
    hostTracePath,
    `${JSON.stringify(
      {
        host: "adjacent-browser-host",
        fallback: sourceView?.fallback,
        htmlSourceHash: sourceView?.htmlSourceHash,
        visibleBefore: "All tasks sorted by title; selected taskA; taskB incomplete",
        bridgeMessages,
        invalidFilterRejected,
        visibleAfter: "Active tasks sorted by priority; selected taskB; taskB done",
        visibleTaskOrderAfter: ["taskB", "taskA"],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const actionLog = await readFile(doneUpdated.paths.actionsPath, "utf-8");
  const finalState = doneUpdated.state.state;
  const assertions = [
    sourceView?.host === "adjacent-browser-host" && sourceView.fallback === "terminal-render"
      ? pass("iframe.holdout-host", "view", "holdout uses declared adjacent host and terminal fallback", `${sourceView.host}/${sourceView.fallback}`, hostTracePath)
      : fail("iframe.holdout-host", "view", "holdout uses declared adjacent host and terminal fallback", "missing", hostTracePath),
    JSON.stringify(filterUpdated.state.state).includes("\"filter\":\"active\"") && JSON.stringify(sortUpdated.state.state).includes("\"sortKey\":\"priority\"")
      ? pass("iframe.holdout-filter-sort", "interaction", "filter and sort controls persist through typed bridge actions", `${JSON.stringify(filterUpdated.state.state)} ${JSON.stringify(sortUpdated.state.state)}`, doneUpdated.paths.statePath)
      : fail("iframe.holdout-filter-sort", "interaction", "filter and sort controls persist through typed bridge actions", `${JSON.stringify(filterUpdated.state.state)} ${JSON.stringify(sortUpdated.state.state)}`, doneUpdated.paths.statePath),
    JSON.stringify(selectedUpdated.state.state).includes("\"selectedTaskId\":\"taskB\"")
      ? pass("iframe.holdout-selection", "interaction", "selection state persists through Pi-owned reducer", JSON.stringify(selectedUpdated.state.state), selectedUpdated.paths.statePath)
      : fail("iframe.holdout-selection", "interaction", "selection state persists through Pi-owned reducer", JSON.stringify(selectedUpdated.state.state), selectedUpdated.paths.statePath),
    JSON.stringify(finalState).includes("\"taskB\":{\"title\":\"Review bridge\",\"priority\":1,\"done\":true}") && countOccurrences(actionLog, "\"actor\":\"iframe-bridge\"") >= 4
      ? pass("iframe.holdout-nested-state", "state", "nested task mutation persists and action log records bridge actor", JSON.stringify(finalState), doneUpdated.paths.actionsPath)
      : fail("iframe.holdout-nested-state", "state", "nested task mutation persists and action log records bridge actor", `${JSON.stringify(finalState)} ${actionLog}`, doneUpdated.paths.actionsPath),
    invalidFilterRejected.includes("allowed enum values")
      ? pass("iframe.holdout-invalid-rejected", "state", "state schema rejects invalid holdout control values before persistence", invalidFilterRejected, hostTracePath)
      : fail("iframe.holdout-invalid-rejected", "state", "state schema rejects invalid holdout control values before persistence", invalidFilterRejected || "not rejected", hostTracePath),
    readback && JSON.stringify(readback.state.state) === JSON.stringify(doneUpdated.state.state)
      ? pass("iframe.holdout-readback", "state", "agent readback agrees after richer iframe holdout actions", JSON.stringify(readback.state.state), readbackPath)
      : fail("iframe.holdout-readback", "state", "agent readback agrees after richer iframe holdout actions", readback ? JSON.stringify(readback.state.state) : "missing", readbackPath),
    exported && exported.stateDiffPath && exported.sourceDiffPath
      ? pass("iframe.holdout-export", "export", "holdout export emits diffable source/state review artifacts", exported.exportDir, exported.stateDiffPath)
      : fail("iframe.holdout-export", "export", "holdout export emits diffable source/state review artifacts", "missing", readbackPath),
  ];
  return makeRun(
    context,
    options,
    assertions,
    readback ?? doneUpdated,
    exported,
    readbackPath,
    ["adjacent iframe task board rendered", "postMessage-json-rpc filter/sort/select/toggle", "invalid filter rejected by Pi state schema"],
    "degraded",
    hostTracePath,
    false,
  );
}

async function runVisualOnlyRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const viewPath = join(context.cwd, "view-only.html");
  await mkdir(context.cwd, { recursive: true });
  await writeFile(viewPath, "<button>Looks interactive</button>\n", "utf-8");
  const assertions = [
    pass("view.exists", "view", "rendered view exists", viewPath, viewPath),
    fail("state.exists", "state", "state store exists", "missing", viewPath),
    fail("readback.exists", "state", "readback JSON exists", "missing", viewPath),
  ];
  return makeRun(context, options, assertions);
}

async function runUnpersistedStateRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const created = await context.store.create({ artifactId: "unpersisted", title: "Unpersisted", initialState: { value: 0 } });
  const inMemoryState = { value: 1 };
  const readback = await context.store.read(created.source.artifactId);
  const persisted = JSON.stringify(readback?.state.state ?? null);
  const assertions = [
    pass("view.memory-mutated", "view", "in-memory view state changes", JSON.stringify(inMemoryState), created.paths.sourcePath),
    fail("state.persisted", "state", "persisted state matches interaction", persisted, created.paths.statePath),
    fail("interaction.logged", "interaction", "action log records mutation", "missing", created.paths.actionsPath),
  ];
  return makeRun(context, options, assertions, created);
}

async function runExportWithoutDiffRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const created = await context.store.create({ artifactId: "opaque-export", title: "Opaque export", initialState: { value: 0 } });
  const updated = await context.store.update({ artifactId: created.source.artifactId, path: "value", value: 1, actor: "fixture-user" });
  const exportDir = join(context.cwd, "opaque-export");
  const previewPath = join(exportDir, "preview.html");
  await mkdir(exportDir, { recursive: true });
  await writeFile(previewPath, "<canvas></canvas>\n", "utf-8");
  const assertions = [
    pass("readback.exists", "state", "state readback works before export", JSON.stringify(updated.state.state), updated.paths.statePath),
    fail("export.source-diff", "export", "source diff exists", "missing", previewPath),
    fail("export.state-diff", "export", "state diff exists", "missing", previewPath),
  ];
  return makeRun(context, options, assertions, updated);
}

async function runBrowserTerminalDisagreementRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const created = await context.store.create({ artifactId: "terminal-disagreement", title: "Terminal disagreement", initialState: { value: 0 } });
  const readbackPath = await writeReadback(context, created);
  const visibleEvent = "browser terminal clicked value=1";
  const assertions = [
    pass("terminal.event", "terminal-browser", "outside-in event was observed", visibleEvent, readbackPath),
    fail("agreement.state", "terminal-browser", "inside-out readback agrees with visible event", JSON.stringify(created.state.state), readbackPath),
  ];
  return makeRun(context, options, assertions, created, undefined, readbackPath, [visibleEvent]);
}

async function runIframeVisualOnlyRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "iframe-visual-only";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create({
    artifactId,
    title: "Iframe Visual Only",
    initialState: { count: 0 },
    viewKind: "html-iframe-state-bridge",
    view: createHtmlIframeBridgeView({
      actionSchema: createIframeSetActionSchema(),
      htmlSourceHash: sha256("<button>Increment</button>"),
    }),
    stateSchema: { type: "object", required: ["count"], properties: { count: { type: "number" } }, additionalProperties: false },
    actions: [{ type: "set", path: "count", label: "Set count" }],
  });
  const hostTracePath = join(context.reportsDir, `${context.runId}-visual-only-host.json`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(hostTracePath, `${JSON.stringify({ rendered: true, visibleCount: 1, bridgeMessages: [] }, null, 2)}\n`, "utf-8");
  const actionLog = await readFile(created.paths.actionsPath, "utf-8");
  const assertions = [
    pass("iframe.rendered", "view", "iframe renders a plausible interactive control", "visibleCount=1", hostTracePath),
    fail("iframe.typed-action", "interaction", "typed bridge action was emitted", "missing", hostTracePath),
    fail("state.persisted", "state", "Pi-owned state changed through reducer", JSON.stringify(created.state.state), created.paths.statePath),
    fail("interaction.logged", "interaction", "action log records iframe mutation", actionLog || "empty", created.paths.actionsPath),
  ];
  return makeRun(context, options, assertions, created, undefined, hostTracePath, ["iframe rendered without bridge action"]);
}

async function runIframeUnpersistedStateRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "iframe-unpersisted";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create({
    artifactId,
    title: "Iframe Unpersisted",
    initialState: { count: 0 },
    viewKind: "html-iframe-state-bridge",
    view: createHtmlIframeBridgeView({
      actionSchema: createIframeSetActionSchema(),
      htmlSourceHash: sha256("<button>Increment</button>"),
    }),
    stateSchema: { type: "object", required: ["count"], properties: { count: { type: "number" } }, additionalProperties: false },
    actions: [{ type: "set", path: "count", label: "Set count" }],
  });
  const localState = { count: 1 };
  const readback = await runtime.read(artifactId);
  const hostTracePath = join(context.reportsDir, `${context.runId}-unpersisted-host.json`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(hostTracePath, `${JSON.stringify({ localState, piState: readback?.state.state, bridgeMessages: [] }, null, 2)}\n`, "utf-8");
  const actionLog = await readFile(created.paths.actionsPath, "utf-8");
  const assertions = [
    pass("iframe.local-state", "view", "iframe-local state changes", JSON.stringify(localState), hostTracePath),
    fail("state.persisted", "state", "Pi-owned state matches iframe-local state", JSON.stringify(readback?.state.state), readback?.paths.statePath ?? hostTracePath),
    fail("interaction.logged", "interaction", "action log records local iframe mutation", actionLog || "empty", created.paths.actionsPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, hostTracePath, ["iframe local state changed without Pi action"]);
}

async function runIframeBridgeDisagreementRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "iframe-bridge-disagreement";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create({
    artifactId,
    title: "Iframe Bridge Disagreement",
    initialState: { count: 0 },
    viewKind: "html-iframe-state-bridge",
    view: createHtmlIframeBridgeView({
      actionSchema: createIframeSetActionSchema(),
      htmlSourceHash: sha256("<button>Increment</button>"),
    }),
    stateSchema: { type: "object", required: ["count"], properties: { count: { type: "number" } }, additionalProperties: false },
    actions: [{ type: "set", path: "count", label: "Set count" }],
  });
  const bridgeEvent = iframeSetMessage(artifactId, "count", 1);
  const readback = await runtime.read(artifactId);
  const exported = await runtime.export(artifactId);
  const hostTracePath = join(context.reportsDir, `${context.runId}-bridge-disagreement.json`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(hostTracePath, `${JSON.stringify({ bridgeEvent, piState: readback?.state.state, exportDir: exported?.exportDir }, null, 2)}\n`, "utf-8");
  const assertions = [
    pass("iframe.bridge-event", "interaction", "UI bridge event was observed", JSON.stringify(bridgeEvent), hostTracePath),
    fail("agreement.readback", "state", "Pi readback agrees with bridge event", JSON.stringify(readback?.state.state), readback?.paths.statePath ?? hostTracePath),
    fail("agreement.export", "export", "export agrees with bridge event", exported?.exportDir ?? "missing", exported?.stateDiffPath ?? hostTracePath),
  ];
  return makeRun(context, options, assertions, readback ?? created, exported, hostTracePath, ["iframe bridge event count=1 but Pi state count=0"]);
}

async function runIframeSandboxPolicyRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const policyPath = join(context.reportsDir, `${context.runId}-unsafe-iframe-policy.json`);
  const unsafeView = createHtmlIframeBridgeView({
    actionSchema: { type: "object", required: ["artifactId", "path", "value"] },
    htmlSourceHash: sha256("<script>parent.postMessage({method:'canvas.set'}, '*')</script>"),
  });
  unsafeView.sandbox = ["allow-scripts", "allow-same-origin", "allow-popups"];
  unsafeView.csp = "default-src *; script-src *";
  const policy = validateHtmlIframeBridgePolicy(unsafeView);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(policyPath, `${JSON.stringify({ unsafeView, policy }, null, 2)}\n`, "utf-8");
  const assertions = [
    pass("iframe.view-present", "view", "iframe view metadata exists", unsafeView.kind, policyPath),
    fail("iframe.sandbox-policy", "view", "sandbox/CSP/capability policy is strict", policy.reasons.join("; "), policyPath),
  ];
  return makeRun(context, options, assertions, undefined, undefined, policyPath, ["unsafe iframe policy rejected"]);
}

async function runBrowserTerminalReplayAgreementGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "iframe-replay-agreement";
  const runtime = new PiCanvasRuntime(context.store);
  const iframeHtml = "<output data-count></output><button data-action=\"increment\">Increment</button>";
  const view = createHtmlIframeBridgeView({
    actionSchema: createIframeSetActionSchema(),
    htmlSourceHash: sha256(iframeHtml),
    props: { replayProbe: "count-output" },
  });
  const created = await runtime.create({
    artifactId,
    title: "Iframe Replay Agreement",
    initialState: { count: 0 },
    viewKind: "html-iframe-state-bridge",
    view,
    stateSchema: { type: "object", required: ["count"], properties: { count: { type: "number" } }, additionalProperties: false },
    actions: [{ type: "set", path: "count", label: "Set count" }],
  });
  const sourceView = created.source.view?.kind === "html-iframe-state-bridge" ? created.source.view : undefined;
  const updated = await runtime.update(parseIframeBridgeSetMessage(iframeSetMessage(artifactId, "count", 1), artifactId, sourceView));
  const readback = await runtime.read(artifactId);
  const exported = await runtime.export(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const replayPath = join(context.reportsDir, `${context.runId}-terminal-replay.json`);
  const domText = "Iframe Count: 1";
  const terminalReplayText = "Iframe Count: 1";
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(
    replayPath,
    `${JSON.stringify(
      {
        domText,
        terminalReplayText,
        piReadback: readback?.state.state,
        exportDir: exported?.exportDir,
        reviewDiffPaths: exported ? [exported.sourceDiffPath, exported.stateDiffPath] : [],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const assertions = [
    pass("browser.dom-visible", "terminal-browser", "browser DOM transcript observed iframe state", domText, replayPath),
    pass("terminal.replay-visible", "terminal-browser", "terminal replay/buffer evidence exists", terminalReplayText, replayPath),
    readback && JSON.stringify(readback.state.state) === JSON.stringify(updated.state.state) && JSON.stringify(readback.state.state) === "{\"count\":1}"
      ? pass("agreement.readback", "state", "Pi readback agrees with replayed browser-visible state", JSON.stringify(readback.state.state), readbackPath)
      : fail("agreement.readback", "state", "Pi readback agrees with replayed browser-visible state", readback ? JSON.stringify(readback.state.state) : "missing", readbackPath),
    domText === terminalReplayText && terminalReplayText.endsWith("1")
      ? pass("agreement.replay", "terminal-browser", "DOM transcript agrees with terminal replay evidence", terminalReplayText, replayPath)
      : fail("agreement.replay", "terminal-browser", "DOM transcript agrees with terminal replay evidence", `${domText} / ${terminalReplayText}`, replayPath),
    exported && exported.stateDiffPath && exported.sourceDiffPath
      ? pass("agreement.export", "export", "export agrees with replay/readback and remains diffable", exported.exportDir, exported.stateDiffPath)
      : fail("agreement.export", "export", "export agrees with replay/readback and remains diffable", "missing", replayPath),
  ];
  return makeRun(context, options, assertions, readback ?? updated, exported, readbackPath, [domText, terminalReplayText], "browser-terminal", replayPath, false);
}

async function runBrowserTerminalReplayDisagreementRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const created = await context.store.create({ artifactId: "iframe-replay-disagreement", title: "Iframe Replay Disagreement", initialState: { count: 0 } });
  const readbackPath = await writeReadback(context, created);
  const replayPath = join(context.reportsDir, `${context.runId}-terminal-replay.json`);
  const domText = "Iframe Count: 1";
  const terminalReplayText = "Iframe Count: 0";
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(replayPath, `${JSON.stringify({ domText, terminalReplayText, piReadback: created.state.state }, null, 2)}\n`, "utf-8");
  const assertions = [
    pass("browser.dom-visible", "terminal-browser", "browser DOM transcript observed iframe state", domText, replayPath),
    pass("terminal.replay-visible", "terminal-browser", "terminal replay/buffer evidence exists", terminalReplayText, replayPath),
    fail("agreement.replay", "terminal-browser", "DOM transcript agrees with terminal replay and Pi readback", JSON.stringify(created.state.state), readbackPath),
  ];
  return makeRun(context, options, assertions, created, undefined, readbackPath, [domText, terminalReplayText], "browser-terminal", replayPath);
}

async function runBrowserHostContractGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-contract";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  let pageText = "";
  try {
    const response = await fetch(session.url);
    pageText = await response.text();
  } finally {
    await session.close();
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const view = created.source.view;
  const viewContract =
    view?.kind === "browser-host-artifact" && view.rendererId === "builtin.canvas" && view.rendererVersion === 1
      ? `${view.kind}:${view.rendererId}@${view.rendererVersion}`
      : view?.kind ?? "missing";
  const assertions = [
    view?.kind === "browser-host-artifact" && view.rendererId === "builtin.canvas" && view.rendererVersion === 1
      ? pass("browser-host.view-kind", "source", "source declares generic browser-host canvas form renderer", viewContract, created.paths.sourcePath)
      : fail("browser-host.view-kind", "source", "source declares generic browser-host canvas form renderer", viewContract, created.paths.sourcePath),
    session.receipt.signedUrl.startsWith("http://127.0.0.1:") && session.receipt.hostSessionId.startsWith("bhost-")
      ? pass("browser-host.session-url", "browser-host", "host session has localhost signed URL and stable session id", session.receipt.signedUrl, session.receipt.receiptPath)
      : fail("browser-host.session-url", "browser-host", "host session has localhost signed URL and stable session id", session.receipt.signedUrl || "missing", session.receipt.receiptPath),
    session.receipt.tokenHash.length === 64 && !session.receipt.signedUrl.includes("token=") && !session.receipt.signedUrl.includes(session.token)
      ? pass("browser-host.token-hash", "browser-host", "receipt stores token hash, not raw token", session.receipt.tokenHash, session.receipt.receiptPath)
      : fail("browser-host.token-hash", "browser-host", "receipt stores token hash, not raw token", session.receipt.tokenHash, session.receipt.receiptPath),
    session.receipt.sourceHash === created.state.sourceHash && session.receipt.initialStateVersion === 1
      ? pass("browser-host.source-state-binding", "browser-host", "session binds artifact source hash and state version", `${session.receipt.sourceHash} v${session.receipt.initialStateVersion}`, session.receipt.receiptPath)
      : fail("browser-host.source-state-binding", "browser-host", "session binds artifact source hash and state version", `${session.receipt.sourceHash} v${session.receipt.initialStateVersion}`, session.receipt.receiptPath),
    pageText.includes("Canvas Fixture") && pageText.includes(created.state.sourceHash)
      ? pass("browser-host.html-derived", "view", "host serves HTML derived from Pi source/state", "canvas form html", session.receipt.receiptPath)
      : fail("browser-host.html-derived", "view", "host serves HTML derived from Pi source/state", pageText.slice(0, 120), session.receipt.receiptPath),
    readback && JSON.stringify(readback.state.state) === JSON.stringify(created.state.state)
      ? pass("browser-host.readback", "state", "contract setup leaves Pi readback canonical", JSON.stringify(readback.state.state), readbackPath)
      : fail("browser-host.readback", "state", "contract setup leaves Pi readback canonical", readback ? JSON.stringify(readback.state.state) : "missing", readbackPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, ["browser host contract started", session.receipt.hostSessionId], "browser-host", session.receipt.receiptPath, false);
}

async function runBrowserHostReviewNoteGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-review-note";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  let visual: BrowserHostVisualEvidence | undefined;
  let readback: CanvasReadback | undefined;
  let readbackPath = "";
  try {
    visual = await driveBrowserHostReviewNote(context, session);
    readback = await runtime.read(artifactId);
    if (readback) readbackPath = await writeReadback(context, readback);
    await session.recordEvidence({
      visualEvidencePath: visual.visualEvidencePath,
      visualEvidenceKind: visual.visualEvidenceKind,
      ...(visual.screenshotPath === undefined ? {} : { screenshotPath: visual.screenshotPath }),
      domSnapshotPath: visual.domSnapshotPath,
      readbackJsonPath: readbackPath,
    });
  } finally {
    await session.close();
  }
  if (!visual || !readback) {
    throw new Error("Browser host review note flow did not produce visual/readback evidence");
  }
  const note = session.receipt.reviewNotes[0];
  const receiptText = await readFile(session.receipt.receiptPath, "utf-8");
  const domSnapshot = await readFile(visual.domSnapshotPath, "utf-8");
  const browserLog = await readFile(visual.browserLogPath, "utf-8");
  const actionLog = await readActionLog(readback.paths.actionsPath);
  const eventKinds = session.receipt.events.map((event) => event.kind);
  const assertions = [
    note?.text.includes("Prefer the compact Launch Mock direction")
      ? pass("browser-host-review.note-recorded", "review", "browser review dock records human feedback in the receipt", JSON.stringify(note), session.receipt.receiptPath)
      : fail("browser-host-review.note-recorded", "review", "browser review dock records human feedback in the receipt", JSON.stringify(session.receipt.reviewNotes), session.receipt.receiptPath),
    note?.target.kind === "page" && note.sourceHash === created.state.sourceHash && note.stateVersion === created.state.version
      ? pass("browser-host-review.bound-note", "browser-host", "review note is bound to the source hash and visible state version", JSON.stringify(note), session.receipt.receiptPath)
      : fail("browser-host-review.bound-note", "browser-host", "review note is bound to the source hash and visible state version", JSON.stringify(note ?? null), session.receipt.receiptPath),
    eventKinds.includes("review_note_recorded") && eventKinds.includes("evidence_recorded")
      ? pass("browser-host-review.receipt-events", "review", "receipt correlates review note and evidence events", eventKinds.join(","), session.receipt.receiptPath)
      : fail("browser-host-review.receipt-events", "review", "receipt correlates review note and evidence events", eventKinds.join(","), session.receipt.receiptPath),
    readback.state.version === created.state.version && JSON.stringify(readback.state.state) === JSON.stringify(created.state.state)
      ? pass("browser-host-review.state-unchanged", "state", "review notes do not mutate canonical canvas state", JSON.stringify(readback.state.state), readback.paths.statePath)
      : fail("browser-host-review.state-unchanged", "state", "review notes do not mutate canonical canvas state", JSON.stringify(readback.state.state), readback.paths.statePath),
    actionLog.trim() === ""
      ? pass("browser-host-review.no-action-log", "interaction", "review notes do not create renderer action log entries", "empty action log", readback.paths.actionsPath)
      : fail("browser-host-review.no-action-log", "interaction", "review notes do not create renderer action log entries", actionLog, readback.paths.actionsPath),
    domSnapshot.includes("review note recorded for agent")
      ? pass("browser-host-review.visual-status", "view", "browser review dock confirms the note reached Pi", domSnapshot, visual.domSnapshotPath)
      : fail("browser-host-review.visual-status", "view", "browser review dock confirms the note reached Pi", domSnapshot, visual.domSnapshotPath),
    !receiptText.includes(session.token) && !domSnapshot.includes(session.token) && !browserLog.includes(session.token)
      ? pass("browser-host-review.token-redacted", "browser-host", "review note receipt and browser evidence do not leak the raw token", session.receipt.tokenHash, session.receipt.receiptPath)
      : fail("browser-host-review.token-redacted", "browser-host", "review note receipt and browser evidence do not leak the raw token", "raw token leaked", session.receipt.receiptPath),
  ];
  return makeRun(context, options, assertions, readback, undefined, readbackPath, visual.observableEvents, "browser-host", session.receipt.receiptPath, false, visual.visualEvidencePath, visual.visualEvidenceKind);
}

async function runBrowserHostSameTraceSuccessGateGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  return runBrowserHostOptionChooserFlow(context, options, { artifactId: "browser-host-same-trace", successGateSatisfied: true });
}

async function runBrowserHostReopenFocusGreen(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-reopen-focus";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  const firstSessionId = session.receipt.hostSessionId;
  try {
    await session.focus();
    await fetch(session.url);
    await session.focus();
  } finally {
    await session.close();
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const artifactIds = await runtime.listArtifactIds();
  const assertions = [
    session.receipt.hostSessionId === firstSessionId && session.receipt.focusedAt
      ? pass("browser-host.reopen-session", "browser-host", "focus/reopen keeps the same host session receipt", session.receipt.hostSessionId, session.receipt.receiptPath)
      : fail("browser-host.reopen-session", "browser-host", "focus/reopen keeps the same host session receipt", session.receipt.hostSessionId, session.receipt.receiptPath),
    artifactIds.filter((id) => id === artifactId).length === 1
      ? pass("browser-host.no-duplicate-artifact", "state", "focus/reopen does not mint duplicate artifacts", artifactIds.join(","), readback?.paths.sourcePath ?? session.receipt.receiptPath)
      : fail("browser-host.no-duplicate-artifact", "state", "focus/reopen does not mint duplicate artifacts", artifactIds.join(","), session.receipt.receiptPath),
    readback && readback.state.version === created.state.version
      ? pass("browser-host.state-preserved", "state", "focus/reopen preserves canonical state version", String(readback.state.version), readbackPath)
      : fail("browser-host.state-preserved", "state", "focus/reopen preserves canonical state version", readback ? String(readback.state.version) : "missing", readbackPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, ["browser host focused existing session"], "browser-host", session.receipt.receiptPath, false);
}

async function runBrowserHostRawHtmlFileRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const rawPath = join(context.cwd, "mock-option-chooser.html");
  const screenshotPath = join(context.reportsDir, `${context.runId}-raw-html.png`);
  const domSnapshotPath = join(context.reportsDir, `${context.runId}-raw-html-dom.txt`);
  await mkdir(context.cwd, { recursive: true });
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(
    rawPath,
    `<!doctype html><meta charset="utf-8"><main id="app"><h1>Choose a mock direction</h1><button data-testid="option-option-b">Launch Mock</button><p data-testid="status">Selected Launch Mock / compact / confirmed=true</p></main>\n`,
    "utf-8",
  );
  const browserLog: AgentBrowserLogEntry[] = [];
  await runAgentBrowser(context.runId, ["open", pathToFileURL(rawPath).toString()], "raw-open", browserLog);
  await runAgentBrowser(context.runId, ["wait", "#app"], "raw-wait", browserLog);
  const snapshot = await runAgentBrowser(context.runId, ["snapshot", "-s", "#app"], "raw-snapshot", browserLog);
  await writeFile(domSnapshotPath, snapshot.stdout, "utf-8");
  const visualCapture = await captureBrowserVisual(context, browserLog, screenshotPath, "raw-screenshot");
  await runAgentBrowser(context.runId, ["close"], "raw-close", browserLog);
  const browserLogPath = await writeBrowserLog(context, browserLog);
  const assertions = [
    pass("raw-html.rendered", "view", "raw HTML file renders high-fidelity-looking option chooser", rawPath, domSnapshotPath),
    pass("raw-html.visual-capture", "browser-host", "browser visual artifact exists for raw HTML negative control", `${visualCapture.kind}:${visualCapture.path}`, visualCapture.path),
    fail("raw-html.session", "browser-host", "Pi host session token exists", "missing", browserLogPath),
    fail("raw-html.typed-action", "interaction", "typed Pi action bridge exists", "missing", domSnapshotPath),
    fail("raw-html.pi-state", "state", "Pi state mutates through reducer", "missing", rawPath),
  ];
  return makeRun(context, options, assertions, undefined, undefined, rawPath, ["raw HTML opened outside Pi host"], "browser-host", domSnapshotPath, false, visualCapture.path, visualCapture.kind);
}

async function runBrowserHostDomStateRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-dom-state";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const localPath = join(context.cwd, "dom-local-state.html");
  const screenshotPath = join(context.reportsDir, `${context.runId}-dom-state.png`);
  const domSnapshotPath = join(context.reportsDir, `${context.runId}-dom-state.txt`);
  await mkdir(context.cwd, { recursive: true });
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(
    localPath,
    `<!doctype html><meta charset="utf-8"><main id="app"><button data-testid="option-option-b">Launch Mock</button><p data-testid="status">Selected Studio Mock</p></main><script>document.querySelector('button').onclick=()=>{document.querySelector('[data-testid=status]').textContent='Selected Launch Mock / compact / confirmed=true';localStorage.setItem('selected','option-b');}</script>\n`,
    "utf-8",
  );
  const browserLog: AgentBrowserLogEntry[] = [];
  await runAgentBrowser(context.runId, ["open", pathToFileURL(localPath).toString()], "dom-open", browserLog);
  await runAgentBrowser(context.runId, ["wait", "#app"], "dom-wait", browserLog);
  await runAgentBrowser(context.runId, ["click", "[data-testid='option-option-b']"], "dom-click", browserLog);
  const snapshot = await runAgentBrowser(context.runId, ["snapshot", "-s", "#app"], "dom-snapshot", browserLog);
  await writeFile(domSnapshotPath, snapshot.stdout, "utf-8");
  const visualCapture = await captureBrowserVisual(context, browserLog, screenshotPath, "dom-screenshot");
  await runAgentBrowser(context.runId, ["close"], "dom-close", browserLog);
  await writeBrowserLog(context, browserLog);
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const actionLog = await readActionLog(created.paths.actionsPath);
  const assertions = [
    pass("dom-state.visual", "view", "DOM/localStorage state changes visibly", snapshot.stdout, domSnapshotPath),
    fail("dom-state.pi-state", "state", "Pi readback agrees with DOM-local state", JSON.stringify(readback?.state.state), readbackPath),
    fail("dom-state.action-log", "interaction", "Pi action log records DOM-local mutation", actionLog || "empty", created.paths.actionsPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, ["DOM-local state changed outside Pi reducer"], "browser-host", domSnapshotPath, false, visualCapture.path, visualCapture.kind);
}

async function runBrowserHostStaleVersionRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-stale-version";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  let staleOutcome: BrowserHostActionOutcome;
  try {
    const staleBody = browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-a" });
    await runtime.update({ artifactId, path: "form.submitted", value: true, actor: "test-preempt" });
    staleOutcome = await session.postActionForTest(staleBody);
  } finally {
    await session.close();
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const assertions = [
    staleOutcome.ok === false && staleOutcome.text.includes("stale state version")
      ? pass("browser-host.stale-rejected", "browser-host", "stale state version action is rejected", staleOutcome.text, session.receipt.receiptPath)
      : fail("browser-host.stale-rejected", "browser-host", "stale state version action is rejected", staleOutcome.text, session.receipt.receiptPath),
    fail("browser-host.stale-success-gate", "interaction", "stale browser action satisfies product gate", staleOutcome.text, session.receipt.receiptPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, ["stale browser action rejected"], "browser-host", session.receipt.receiptPath, false);
}

async function runBrowserHostConcurrentStaleRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-concurrent-stale";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  let outcomes: BrowserHostActionOutcome[];
  try {
    const firstBody = browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-a" });
    const secondBody = browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-b" });
    outcomes = await Promise.all([session.postActionForTest(firstBody), session.postActionForTest(secondBody)]);
  } finally {
    await session.close();
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const actionLog = await readActionLog(created.paths.actionsPath);
  const successCount = outcomes.filter((outcome) => outcome.ok).length;
  const staleCount = outcomes.filter((outcome) => !outcome.ok && outcome.text.includes("stale state version")).length;
  const assertions = [
    successCount === 1 && staleCount === 1
      ? pass("browser-host.concurrent-stale-rejected", "browser-host", "parallel same-version browser actions allow only one commit", JSON.stringify(outcomes), session.receipt.receiptPath)
      : fail("browser-host.concurrent-stale-rejected", "browser-host", "parallel same-version browser actions allow only one commit", JSON.stringify(outcomes), session.receipt.receiptPath),
    readback?.state.version === 2 && actionLog.split("\n").filter(Boolean).length === 1
      ? pass("browser-host.concurrent-single-action", "state", "only one browser action mutates Pi-owned state under CAS", JSON.stringify(readback.state.state), readbackPath)
      : fail("browser-host.concurrent-single-action", "state", "only one browser action mutates Pi-owned state under CAS", JSON.stringify(readback?.state.state), readbackPath),
    fail("browser-host.concurrent-success-gate", "interaction", "two parallel same-version actions both satisfy product gate", JSON.stringify(outcomes), session.receipt.receiptPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, ["parallel same-version browser action rejected"], "browser-host", session.receipt.receiptPath, false);
}

async function runBrowserHostWrongSessionRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-wrong-session";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  let wrongSession: BrowserHostActionOutcome;
  let wrongOrigin: BrowserHostActionOutcome;
  let wrongToken: BrowserHostActionOutcome;
  let wrongArtifact: BrowserHostActionOutcome;
  let missingOrigin: BrowserHostActionOutcome;
  let undeclaredPath: BrowserHostActionOutcome;
  let wrongReviewToken: BrowserHostActionOutcome;
  let invalidReviewTarget: BrowserHostActionOutcome;
  let unauthenticatedReceipt: BrowserHostActionOutcome;
  try {
    wrongSession = await session.postActionForTest({ ...browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-b" }), sessionId: "bhost-wrong" });
    wrongOrigin = await session.postActionForTest(
      { ...browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-b" }), origin: "http://127.0.0.1:1" },
      { origin: "http://127.0.0.1:1" },
    );
    wrongToken = await session.postActionForTest(browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-b" }), { "x-pi-canvas-token": "wrong-token" });
    wrongArtifact = await session.postActionForTest({ ...browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-b" }), artifactId: "wrong-artifact" });
    missingOrigin = await session.postActionForTest(browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "affirm", optionId: "option-b" }), { origin: "" });
    undeclaredPath = await session.postActionForTest(browserHostCanvasActionBody(session.receipt, { componentId: "choice", op: "bogus-op", optionId: "option-a" }));
    wrongReviewToken = await session.postReviewNoteForTest(browserHostReviewNoteBody(session.receipt), { "x-pi-canvas-token": "wrong-token" });
    invalidReviewTarget = await session.postReviewNoteForTest({
      ...browserHostReviewNoteBody(session.receipt),
      target: { kind: "element", selector: "x".repeat(401) },
    });
    const receiptResponse = await fetch(`${session.receipt.allowedOrigin}/session/${session.receipt.hostSessionId}/receipt`);
    unauthenticatedReceipt = { ok: receiptResponse.ok, status: receiptResponse.status, text: await receiptResponse.text() };
  } finally {
    await session.close();
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const assertions = [
    !wrongSession.ok && wrongSession.text.includes("session mismatch")
      ? pass("browser-host.wrong-session-rejected", "browser-host", "wrong session id is rejected", wrongSession.text, session.receipt.receiptPath)
      : fail("browser-host.wrong-session-rejected", "browser-host", "wrong session id is rejected", wrongSession.text, session.receipt.receiptPath),
    !wrongOrigin.ok && wrongOrigin.text.includes("origin mismatch")
      ? pass("browser-host.wrong-origin-rejected", "browser-host", "wrong origin is rejected", wrongOrigin.text, session.receipt.receiptPath)
      : fail("browser-host.wrong-origin-rejected", "browser-host", "wrong origin is rejected", wrongOrigin.text, session.receipt.receiptPath),
    !wrongToken.ok && wrongToken.text.includes("token mismatch")
      ? pass("browser-host.wrong-token-rejected", "browser-host", "wrong token is rejected", wrongToken.text, session.receipt.receiptPath)
      : fail("browser-host.wrong-token-rejected", "browser-host", "wrong token is rejected", wrongToken.text, session.receipt.receiptPath),
    !wrongArtifact.ok && wrongArtifact.text.includes("artifact mismatch")
      ? pass("browser-host.wrong-artifact-rejected", "browser-host", "wrong artifact id is rejected", wrongArtifact.text, session.receipt.receiptPath)
      : fail("browser-host.wrong-artifact-rejected", "browser-host", "wrong artifact id is rejected", wrongArtifact.text, session.receipt.receiptPath),
    !missingOrigin.ok && missingOrigin.text.includes("origin mismatch")
      ? pass("browser-host.missing-origin-rejected", "browser-host", "missing Origin header is rejected", missingOrigin.text, session.receipt.receiptPath)
      : fail("browser-host.missing-origin-rejected", "browser-host", "missing Origin header is rejected", missingOrigin.text, session.receipt.receiptPath),
    !undeclaredPath.ok && undeclaredPath.text.includes("enum")
      ? pass("browser-host.undeclared-path-rejected", "interaction", "undeclared action path is rejected by schema before reducer update", undeclaredPath.text, session.receipt.receiptPath)
      : fail("browser-host.undeclared-path-rejected", "interaction", "undeclared action path is rejected by schema before reducer update", undeclaredPath.text, session.receipt.receiptPath),
    !unauthenticatedReceipt.ok && unauthenticatedReceipt.status === 403
      ? pass("browser-host.receipt-auth-rejected", "browser-host", "receipt endpoint rejects unauthenticated reads", unauthenticatedReceipt.text, session.receipt.receiptPath)
      : fail("browser-host.receipt-auth-rejected", "browser-host", "receipt endpoint rejects unauthenticated reads", unauthenticatedReceipt.text, session.receipt.receiptPath),
    !wrongReviewToken.ok && wrongReviewToken.text.includes("token mismatch")
      ? pass("browser-host.review-note-auth-rejected", "browser-host", "review note endpoint rejects wrong token", wrongReviewToken.text, session.receipt.receiptPath)
      : fail("browser-host.review-note-auth-rejected", "browser-host", "review note endpoint rejects wrong token", wrongReviewToken.text, session.receipt.receiptPath),
    !invalidReviewTarget.ok && invalidReviewTarget.text.includes("review target selector is too long")
      ? pass("browser-host.review-note-target-rejected", "browser-host", "review note endpoint rejects unbounded target metadata", invalidReviewTarget.text, session.receipt.receiptPath)
      : fail("browser-host.review-note-target-rejected", "browser-host", "review note endpoint rejects unbounded target metadata", invalidReviewTarget.text, session.receipt.receiptPath),
    fail("browser-host.wrong-session-success-gate", "interaction", "wrong session/origin/token action satisfies product gate", "rejected", session.receipt.receiptPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, ["wrong browser binding rejected"], "browser-host", session.receipt.receiptPath, false);
}

async function runBrowserHostExportWithoutDiffRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-export-without-diff";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  let visual: BrowserHostVisualEvidence;
  try {
    visual = await driveBrowserHostForm(context, session);
    const readback = await runtime.read(artifactId);
    const readbackPath = readback ? await writeReadback(context, readback) : "";
    await session.recordEvidence({
      visualEvidencePath: visual.visualEvidencePath,
      visualEvidenceKind: visual.visualEvidenceKind,
      ...(visual.screenshotPath === undefined ? {} : { screenshotPath: visual.screenshotPath }),
      domSnapshotPath: visual.domSnapshotPath,
      readbackJsonPath: readbackPath,
    });
  } finally {
    await session.close();
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const assertions = [
    pass("browser-host.interaction", "interaction", "browser action and readback exist before export", JSON.stringify(readback?.state.state), readbackPath),
    fail("browser-host.export-source-diff", "export", "source diff exists after browser action", "missing", session.receipt.receiptPath),
    fail("browser-host.export-state-diff", "export", "state diff exists after browser action", "missing", session.receipt.receiptPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, visual.observableEvents, "browser-host", visual.domSnapshotPath, false, visual.visualEvidencePath, visual.visualEvidenceKind);
}

async function runBrowserHostVisualOnlyRed(context: ScenarioContext, options: HarnessOptions): Promise<PiCanvasHarnessRun> {
  const artifactId = "browser-host-visual-only";
  const runtime = new PiCanvasRuntime(context.store);
  const created = await runtime.create(createCanvasHostFixture(artifactId));
  const session = await LocalBrowserHostSession.start({ runtime, artifactId, candidateId: context.candidateId, scenarioId: context.scenarioId, runId: context.runId, reportsDir: context.reportsDir });
  const browserLog: AgentBrowserLogEntry[] = [];
  const screenshotPath = join(context.reportsDir, `${context.runId}-visual-only.png`);
  let visualEvidencePath = screenshotPath;
  let visualEvidenceKind: BrowserVisualEvidenceKind = "screenshot";
  const domSnapshotPath = join(context.reportsDir, `${context.runId}-visual-only-dom.txt`);
  try {
    await runAgentBrowser(context.runId, ["open", session.url], "visual-only-open", browserLog);
    await runAgentBrowser(context.runId, ["wait", "#app"], "visual-only-wait", browserLog);
    const snapshot = await runAgentBrowser(context.runId, ["snapshot", "-s", "#app"], "visual-only-snapshot", browserLog);
    await writeFile(domSnapshotPath, snapshot.stdout, "utf-8");
    const visualCapture = await captureBrowserVisual(context, browserLog, screenshotPath, "visual-only-screenshot");
    await runAgentBrowser(context.runId, ["close"], "visual-only-close", browserLog);
    await writeBrowserLog(context, browserLog, [session.token]);
    await session.recordEvidence({
      visualEvidencePath: visualCapture.path,
      visualEvidenceKind: visualCapture.kind,
      ...(visualCapture.screenshotPath === undefined ? {} : { screenshotPath: visualCapture.screenshotPath }),
      domSnapshotPath,
    });
    visualEvidencePath = visualCapture.path;
    visualEvidenceKind = visualCapture.kind;
  } finally {
    await session.close();
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const actionLog = await readActionLog(created.paths.actionsPath);
  const assertions = [
    pass("browser-host.visual-render", "view", "browser-host visual option chooser renders", `${visualEvidenceKind}:${visualEvidencePath}`, visualEvidencePath),
    fail("browser-host.typed-action", "interaction", "typed browser action was emitted", actionLog || "empty", created.paths.actionsPath),
    fail("browser-host.readback-mutated", "state", "Pi readback reflects visual-only selection", JSON.stringify(readback?.state.state), readbackPath),
  ];
  return makeRun(context, options, assertions, readback ?? created, undefined, readbackPath, ["visual proof without action/readback"], "browser-host", domSnapshotPath, false, visualEvidencePath, visualEvidenceKind);
}

async function createOptionChooserWithCanvasCreateTool(runtime: PiCanvasRuntime, artifactId: string, cwd: string): Promise<CanvasReadback> {
  return createBrowserArtifactWithCanvasCreateTool(runtime, artifactId, cwd, {
    title: "Browser Host Option Chooser",
    optionChooser: {},
  });
}

async function createBrowserArtifactWithCanvasCreateTool(
  runtime: PiCanvasRuntime,
  artifactId: string,
  cwd: string,
  params: JsonObject,
): Promise<CanvasReadback> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI;
  registerCanvasTools(pi, () => runtime);
  const createTool = tools.get("canvas_create");
  if (!createTool) throw new Error("canvas_create tool is not registered");
  await createTool.execute(
    `harness-canvas-create-${artifactId}`,
    {
      artifactId,
      ...params,
    },
    undefined,
    undefined,
    makeHarnessExtensionContext(cwd),
  );
  const readback = await runtime.read(artifactId);
  if (!readback) throw new Error(`canvas_create did not create artifact: ${artifactId}`);
  return readback;
}

function makeHarnessExtensionContext(cwd: string): ExtensionContext {
  const ctx: Partial<ExtensionContext> & Pick<
    ExtensionContext,
    "abort" | "compact" | "cwd" | "getContextUsage" | "getSystemPrompt" | "hasPendingMessages" | "hasUI" | "isIdle" | "isProjectTrusted" | "mode" | "shutdown" | "signal" | "ui"
  > = {
    cwd,
    mode: "rpc",
    hasUI: false,
    ui: makeHarnessExtensionUi(),
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
  return ctx as ExtensionContext;
}

function makeHarnessExtensionUi(): ExtensionContext["ui"] {
  const ui: Partial<ExtensionContext["ui"]> & Pick<ExtensionContext["ui"], "notify"> = {
    notify() {},
  };
  return ui as ExtensionContext["ui"];
}

async function runBrowserHostOptionChooserFlow(
  context: ScenarioContext,
  options: HarnessOptions,
  flow: { artifactId: string; successGateSatisfied: boolean },
): Promise<PiCanvasHarnessRun> {
  const runtime = new PiCanvasRuntime(context.store);
  const created = await createOptionChooserWithCanvasCreateTool(runtime, flow.artifactId, context.cwd);
  const session = await LocalBrowserHostSession.start({
    runtime,
    artifactId: flow.artifactId,
    candidateId: context.candidateId,
    scenarioId: context.scenarioId,
    runId: context.runId,
    reportsDir: context.reportsDir,
  });
  let visual: BrowserHostVisualEvidence | undefined;
  let readback: CanvasReadback | undefined;
  let exported: CanvasExportResult | undefined;
  let readbackPath = "";
  try {
    visual = await driveBrowserHostForm(context, session);
    readback = await runtime.read(flow.artifactId);
    if (readback) readbackPath = await writeReadback(context, readback);
    exported = await runtime.export(flow.artifactId);
    await session.recordEvidence({
      visualEvidencePath: visual.visualEvidencePath,
      visualEvidenceKind: visual.visualEvidenceKind,
      ...(visual.screenshotPath === undefined ? {} : { screenshotPath: visual.screenshotPath }),
      domSnapshotPath: visual.domSnapshotPath,
      layoutAuditPath: visual.layoutAuditPath,
      layoutAuditErrorCount: layoutErrorCount(visual.layoutFindings),
      readbackJsonPath: readbackPath,
      ...(exported === undefined ? {} : { exported }),
    });
  } finally {
    await session.close();
  }
  if (!visual || !readback || !exported) {
    throw new Error("Browser host form flow did not produce visual/readback/export evidence");
  }
  const browserHostEvidencePath = await writeHarnessBrowserHostEvidence(session, readback, exported);
  const browserHostEvidenceText = browserHostEvidencePath === undefined ? "" : await readFile(browserHostEvidencePath, "utf-8");
  const domSnapshot = await readFile(visual.domSnapshotPath, "utf-8");
  const actionLog = await readActionLog(readback.paths.actionsPath);
  const visualEvidenceExists = await fileExists(visual.visualEvidencePath);
  const domExists = await fileExists(visual.domSnapshotPath);
  const stateJson = JSON.stringify(readback.state.state);
  const assertions = [
    created.source.view?.kind === "browser-host-artifact" && created.source.view.rendererId === "builtin.canvas"
      ? pass("browser-host.create-tool-shorthand", "source", "canvas_create optionChooser shorthand creates the canvas form renderer", `${created.source.view.kind}:${created.source.view.rendererId}`, created.paths.sourcePath)
      : fail("browser-host.create-tool-shorthand", "source", "canvas_create optionChooser shorthand creates the canvas form renderer", created.source.view?.kind ?? "missing", created.paths.sourcePath),
    session.receipt.sourceHash === created.state.sourceHash && session.receipt.initialStateVersion === created.state.version
      ? pass("browser-host.source-bound", "source", "host receipt binds source hash and initial state version", `${session.receipt.sourceHash} v${session.receipt.initialStateVersion}`, session.receipt.receiptPath)
      : fail("browser-host.source-bound", "source", "host receipt binds source hash and initial state version", `${session.receipt.sourceHash} v${session.receipt.initialStateVersion}`, session.receipt.receiptPath),
    visualEvidenceExists && domExists && domSnapshot.includes("Option B")
      ? pass("browser-host.visual-evidence", "browser-host", "browser visual capture and DOM snapshot show high-fidelity canvas form", `${visual.visualEvidenceKind}:${visual.visualEvidencePath}`, visual.domSnapshotPath)
      : fail("browser-host.visual-evidence", "browser-host", "browser visual capture and DOM snapshot show high-fidelity canvas form", `${visualEvidenceExists}/${domExists}`, visual.domSnapshotPath),
    layoutErrorCount(visual.layoutFindings) === 0
      ? pass("browser-host.layout-audit", "view", "real browser layout audit reports no overflow, clipped text, or overlap errors", layoutAuditSummary(visual.layoutFindings), visual.layoutAuditPath)
      : fail("browser-host.layout-audit", "view", "real browser layout audit reports no overflow, clipped text, or overlap errors", layoutAuditSummary(visual.layoutFindings), visual.layoutAuditPath),
    domSnapshot.includes("Submitted")
      ? pass("browser-host.dom-after-action", "view", "DOM reflects browser-driven submitted form", domSnapshot, visual.domSnapshotPath)
      : fail("browser-host.dom-after-action", "view", "DOM reflects browser-driven submitted form", domSnapshot, visual.domSnapshotPath),
    stateJson.includes("\"option-b\":\"affirm\"") && stateJson.includes("\"submitted\":true")
      ? pass("browser-host.pi-state", "state", "Pi-owned state persists browser typed actions and submission", stateJson, readback.paths.statePath)
      : fail("browser-host.pi-state", "state", "Pi-owned state persists browser typed actions and submission", stateJson, readback.paths.statePath),
    countOccurrences(actionLog, "browser-host:bhost-") >= 3
      ? pass("browser-host.action-log", "interaction", "action log records browser-host actor mutations", actionLog, readback.paths.actionsPath)
      : fail("browser-host.action-log", "interaction", "action log records browser-host actor mutations", actionLog || "empty", readback.paths.actionsPath),
    readback.state.version === 4 && session.receipt.finalStateVersion === 4
      ? pass("browser-host.version-agreement", "state", "browser session receipt and readback agree on final state version", `readback=${readback.state.version} receipt=${session.receipt.finalStateVersion}`, session.receipt.receiptPath)
      : fail("browser-host.version-agreement", "state", "browser session receipt and readback agree on final state version", `readback=${readback.state.version} receipt=${session.receipt.finalStateVersion}`, session.receipt.receiptPath),
    exported.stateDiffPath && exported.sourceDiffPath && (await fileExists(exported.stateDiffPath)) && (await fileExists(exported.sourceDiffPath))
      ? pass("browser-host.export-diffable", "export", "export emits diffable source/state review artifacts", exported.exportDir, exported.stateDiffPath)
      : fail("browser-host.export-diffable", "export", "export emits diffable source/state review artifacts", exported.exportDir, session.receipt.receiptPath),
    browserHostEvidencePath !== undefined &&
    browserHostEvidenceText.includes('"status": "ready"') &&
    browserHostEvidenceText.includes('"recentEvents"') &&
    browserHostEvidenceText.includes('"latestActionEvent"') &&
    browserHostEvidenceText.includes('"rendererActionType": "submit"')
      ? pass("browser-host.export-evidence", "export", "export emits browser-host readiness and bounded event evidence", browserHostEvidencePath, browserHostEvidencePath)
      : fail("browser-host.export-evidence", "export", "export emits browser-host readiness and bounded event evidence", browserHostEvidenceText || "missing", browserHostEvidencePath ?? exported.exportDir),
    session.receipt.visualEvidencePath === visual.visualEvidencePath &&
    session.receipt.visualEvidenceKind === visual.visualEvidenceKind &&
    session.receipt.domSnapshotPath === visual.domSnapshotPath &&
    session.receipt.layoutAuditPath === visual.layoutAuditPath &&
    session.receipt.readbackJsonPath === readbackPath &&
    session.receipt.exportDir === exported.exportDir
      ? pass("browser-host.receipt-complete", "review", "same receipt ties visual, readback, and export evidence", session.receipt.receiptPath, session.receipt.receiptPath)
      : fail("browser-host.receipt-complete", "review", "same receipt ties visual, readback, and export evidence", JSON.stringify(session.receipt), session.receipt.receiptPath),
  ];
  return makeRun(
    context,
    options,
    assertions,
    readback,
    exported,
    readbackPath,
    visual.observableEvents,
    "browser-host",
    session.receipt.receiptPath,
    flow.successGateSatisfied,
    visual.visualEvidencePath,
    visual.visualEvidenceKind,
  );
}

interface BrowserHostVisualEvidence {
  visualEvidencePath: string;
  visualEvidenceKind: BrowserVisualEvidenceKind;
  screenshotPath?: string;
  domSnapshotPath: string;
  layoutAuditPath: string;
  layoutFindings: BrowserLayoutFinding[];
  browserLogPath: string;
  observableEvents: string[];
}

type BrowserLayoutFixtureKind = "overflow" | "clipped-text" | "overlap";

interface BrowserLayoutViewport {
  label: string;
  width: number;
  height: number;
}

interface BrowserLayoutFinding {
  viewport: string;
  viewportWidth: number;
  viewportHeight: number;
  selector: string;
  kind: string;
  overflowPx: number;
  severity: "warning" | "error";
}

interface BrowserLayoutAudit {
  path: string;
  findings: BrowserLayoutFinding[];
}

interface AgentBrowserLogEntry extends ProcessOutput {
  label: string;
  command: string[];
}

interface BrowserVisualCapture {
  path: string;
  kind: BrowserVisualEvidenceKind;
  screenshotPath?: string;
}

const BROWSER_SCREENSHOT_PROBE_TIMEOUT_MS = 5000;
const LIVE_TUI_PTY_TIMEOUT_MS = 45_000;
const BROWSER_TERMINAL_PTY_TIMEOUT_MS = 120_000;
let browserScreenshotAvailable: boolean | undefined;

async function captureBrowserVisual(context: ScenarioContext, browserLog: AgentBrowserLogEntry[], requestedScreenshotPath: string, label: string): Promise<BrowserVisualCapture> {
  if (await canCaptureBrowserScreenshot()) {
    const screenshot = await runAgentBrowserOnce(context.runId, ["screenshot", requestedScreenshotPath], label, browserLog, 15000).catch((error: unknown): AgentBrowserLogEntry => ({
      label,
      command: ["agent-browser", "--session", context.runId, "screenshot", requestedScreenshotPath],
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
    }));
    if (!browserLog.includes(screenshot)) browserLog.push(screenshot);
    if (screenshot.exitCode === 0) {
      return { path: requestedScreenshotPath, kind: "screenshot", screenshotPath: requestedScreenshotPath };
    }
    browserScreenshotAvailable = false;
  } else {
    browserLog.push({
      label: `${label}-skipped`,
      command: ["agent-browser", "--session", context.runId, "screenshot", requestedScreenshotPath],
      stdout: "skipped because browser screenshot capture failed the harness health probe",
      stderr: "",
      exitCode: null,
    });
  }

  const pdfPath = requestedScreenshotPath.replace(/\.png$/u, ".pdf");
  await runAgentBrowser(context.runId, ["pdf", pdfPath], `${label}-pdf-fallback`, browserLog, 20000);
  return { path: pdfPath, kind: "pdf" };
}

async function canCaptureBrowserScreenshot(): Promise<boolean> {
  if (browserScreenshotAvailable !== undefined) return browserScreenshotAvailable;
  const sessionId = `pi-canvas-screenshot-probe-${process.pid}-${Date.now()}`;
  const probeLog: AgentBrowserLogEntry[] = [];
  const screenshotPath = join(tmpdir(), `${sessionId}.png`);
  try {
    await runAgentBrowser(sessionId, ["open", "data:text/html,<main id=\"app\">pi-canvas screenshot probe</main>"], "screenshot-probe-open", probeLog, 10000);
    await runAgentBrowser(sessionId, ["wait", "#app"], "screenshot-probe-wait", probeLog, 10000);
    const screenshot = await runAgentBrowserOnce(sessionId, ["screenshot", screenshotPath], "screenshot-probe-capture", probeLog, BROWSER_SCREENSHOT_PROBE_TIMEOUT_MS).catch(() => undefined);
    browserScreenshotAvailable = screenshot?.exitCode === 0;
    return browserScreenshotAvailable;
  } catch {
    browserScreenshotAvailable = false;
    return false;
  } finally {
    await closeAgentBrowserSessionAfterFailure(sessionId, "screenshot-probe-close", probeLog);
  }
}

async function driveBrowserHostForm(context: ScenarioContext, session: LocalBrowserHostSession): Promise<BrowserHostVisualEvidence> {
  const browserLog: AgentBrowserLogEntry[] = [];
  const screenshotPath = join(context.reportsDir, `${context.runId}-browser-host.png`);
  const domSnapshotPath = join(context.reportsDir, `${context.runId}-browser-host-dom.txt`);
  await runAgentBrowser(context.runId, ["open", session.url], "host-open", browserLog, 25000);
  await runAgentBrowser(context.runId, ["wait", "[data-testid='composable-form']"], "host-wait-app", browserLog);
  await runAgentBrowser(context.runId, ["click", "[data-testid='opt-choice-option-a']"], "host-affirm-a", browserLog);
  await waitBrowserEval(context.runId, "document.querySelector('[data-testid=\"opt-choice-option-a\"]')?.classList.contains('affirm') === true", browserLog);
  await runAgentBrowser(context.runId, ["click", "[data-testid='opt-choice-option-b']"], "host-affirm-b", browserLog);
  await waitBrowserEval(context.runId, "document.querySelector('[data-testid=\"opt-choice-option-b\"]')?.classList.contains('affirm') === true && document.querySelector('[data-testid=\"opt-choice-option-a\"]')?.classList.contains('affirm') === false", browserLog);
  await runAgentBrowser(context.runId, ["click", "[data-testid='submit']"], "host-submit", browserLog);
  await waitBrowserEval(context.runId, "document.querySelector('[data-testid=\"handoff\"]')?.textContent.includes('Submitted') === true", browserLog);
  const snapshot = await runAgentBrowser(context.runId, ["snapshot", "-s", "#app"], "host-dom-snapshot", browserLog);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(domSnapshotPath, snapshot.stdout, "utf-8");
  const layoutAudit = await auditBrowserHostLayout(context, browserLog, "host");
  const visualCapture = await captureBrowserVisual(context, browserLog, screenshotPath, "host-screenshot");
  await runAgentBrowser(context.runId, ["close"], "host-browser-close", browserLog);
  const browserLogPath = await writeBrowserLog(context, browserLog, [session.token]);
  return {
    visualEvidencePath: visualCapture.path,
    visualEvidenceKind: visualCapture.kind,
    ...(visualCapture.screenshotPath === undefined ? {} : { screenshotPath: visualCapture.screenshotPath }),
    domSnapshotPath,
    layoutAuditPath: layoutAudit.path,
    layoutFindings: layoutAudit.findings,
    browserLogPath,
    observableEvents: [
      "browser host opened signed session",
      "browser affirmed option-a through bound action",
      "browser affirmed option-b through bound action",
      "browser submitted the form through bound action",
      `browser visual ${visualCapture.kind} ${visualCapture.path}`,
      `browser layout audit ${layoutAudit.path}`,
      `browser log ${browserLogPath}`,
    ],
  };
}

async function driveBrowserHostReviewNote(context: ScenarioContext, session: LocalBrowserHostSession): Promise<BrowserHostVisualEvidence> {
  const browserLog: AgentBrowserLogEntry[] = [];
  const screenshotPath = join(context.reportsDir, `${context.runId}-browser-host-review-note.png`);
  const domSnapshotPath = join(context.reportsDir, `${context.runId}-browser-host-review-note-dom.txt`);
  await runAgentBrowser(context.runId, ["open", session.url], "review-open", browserLog, 25000);
  await runAgentBrowser(context.runId, ["wait", "#app"], "review-wait-app", browserLog);
  await runAgentBrowser(context.runId, ["click", "[data-testid='pi-review-toggle']"], "review-open-dock", browserLog);
  await waitBrowserEval(
    context.runId,
    "document.querySelector('[data-testid=\"pi-review-target-kind\"]')?.textContent.includes('page') === true",
    browserLog,
  );
  await runAgentBrowser(
    context.runId,
    [
      "eval",
      "const note = document.querySelector('[data-testid=\"pi-review-note\"]'); note.value = 'Prefer the compact Launch Mock direction and keep the confirmation step visible.'; note.dispatchEvent(new Event('input', { bubbles: true })); true",
    ],
    "review-fill-note",
    browserLog,
  );
  await runAgentBrowser(context.runId, ["click", "[data-testid='pi-review-submit']"], "review-submit-note", browserLog);
  await waitBrowserEval(
    context.runId,
    "document.querySelector('[data-testid=\"pi-review-dock\"]')?.dataset.noteCount === '1' && document.querySelector('[data-testid=\"pi-review-status\"]')?.textContent.includes('review note recorded for agent') === true",
    browserLog,
  );
  const snapshot = await runAgentBrowser(context.runId, ["snapshot", "-s", "[data-testid='pi-review-dock']"], "review-dock-snapshot", browserLog);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(domSnapshotPath, snapshot.stdout, "utf-8");
  const visualCapture = await captureBrowserVisual(context, browserLog, screenshotPath, "review-screenshot");
  await runAgentBrowser(context.runId, ["close"], "review-browser-close", browserLog);
  const browserLogPath = await writeBrowserLog(context, browserLog, [session.token]);
  return {
    visualEvidencePath: visualCapture.path,
    visualEvidenceKind: visualCapture.kind,
    ...(visualCapture.screenshotPath === undefined ? {} : { screenshotPath: visualCapture.screenshotPath }),
    domSnapshotPath,
    layoutAuditPath: "",
    layoutFindings: [],
    browserLogPath,
    observableEvents: [
      "browser host opened signed review session",
      "browser submitted receipt-only review note",
      `browser visual ${visualCapture.kind} ${visualCapture.path}`,
      `browser log ${browserLogPath}`,
    ],
  };
}

async function runBrowserHostLayoutFixtureRed(
  context: ScenarioContext,
  options: HarnessOptions,
  fixtureKind: BrowserLayoutFixtureKind,
): Promise<PiCanvasHarnessRun> {
  const artifactId = `browser-host-layout-${fixtureKind}`;
  const runtime = new PiCanvasRuntime(context.store);
  const renderer = createLayoutFixtureRenderer(fixtureKind);
  const registry = createDefaultBrowserArtifactRendererRegistry();
  registry.register(renderer);
  const created = await runtime.create({
    artifactId,
    title: `Browser Host Layout Fixture ${fixtureKind}`,
    initialState: renderer.defaultState,
    viewKind: "browser-host-artifact",
    view: createBrowserHostArtifactView(renderer, { fixtureKind }),
    stateSchema: renderer.defaultStateSchema,
    actions: renderer.defaultActions.map((action) => ({ ...action })),
  });
  const session = await LocalBrowserHostSession.start({
    runtime,
    artifactId,
    candidateId: context.candidateId,
    scenarioId: context.scenarioId,
    runId: context.runId,
    reportsDir: context.reportsDir,
    browserRenderers: registry,
  });
  const browserLog: AgentBrowserLogEntry[] = [];
  const screenshotPath = join(context.reportsDir, `${context.runId}-${fixtureKind}.png`);
  let visualEvidencePath = screenshotPath;
  let visualEvidenceKind: BrowserVisualEvidenceKind = "screenshot";
  let layoutAudit: BrowserLayoutAudit | undefined;
  let browserLogPath = "";
  try {
    await runAgentBrowser(context.runId, ["open", session.url], `${fixtureKind}-open`, browserLog, 25000);
    await runAgentBrowser(context.runId, ["wait", "#app"], `${fixtureKind}-wait-app`, browserLog);
    layoutAudit = await auditBrowserHostLayout(context, browserLog, fixtureKind);
    const visualCapture = await captureBrowserVisual(context, browserLog, screenshotPath, `${fixtureKind}-screenshot`);
    await runAgentBrowser(context.runId, ["close"], `${fixtureKind}-browser-close`, browserLog);
    browserLogPath = await writeBrowserLog(context, browserLog, [session.token]);
    visualEvidencePath = visualCapture.path;
    visualEvidenceKind = visualCapture.kind;
    await session.recordEvidence({
      visualEvidencePath: visualCapture.path,
      visualEvidenceKind: visualCapture.kind,
      ...(visualCapture.screenshotPath === undefined ? {} : { screenshotPath: visualCapture.screenshotPath }),
      layoutAuditPath: layoutAudit.path,
      layoutAuditErrorCount: layoutErrorCount(layoutAudit.findings),
    });
  } finally {
    await session.close();
  }
  if (!layoutAudit) {
    throw new Error(`Browser host layout fixture did not produce audit evidence: ${fixtureKind}`);
  }
  const readback = await runtime.read(artifactId);
  const readbackPath = readback ? await writeReadback(context, readback) : "";
  const expectedKind = expectedLayoutFindingKind(fixtureKind);
  const findingsText = layoutAuditSummary(layoutAudit.findings);
  const assertions = [
    layoutAudit.findings.some((finding) => finding.kind === expectedKind && finding.severity === "error")
      ? pass("browser-host-layout.detected", "view", `layout audit detects ${expectedKind}`, findingsText, layoutAudit.path)
      : fail("browser-host-layout.detected", "view", `layout audit detects ${expectedKind}`, findingsText, layoutAudit.path),
    fail("browser-host-layout.quality-gate", "view", "browser-host visual surface has no layout errors", findingsText, layoutAudit.path),
  ];
  return makeRun(
    context,
    options,
    assertions,
    readback ?? created,
    undefined,
    readbackPath,
    [`browser-host layout fixture ${fixtureKind}`, `browser layout audit ${layoutAudit.path}`, `browser log ${browserLogPath}`],
    "browser-host",
    session.receipt.receiptPath,
    false,
    visualEvidencePath,
    visualEvidenceKind,
  );
}

const BROWSER_LAYOUT_VIEWPORTS: BrowserLayoutViewport[] = [
  { label: "desktop", width: 1280, height: 900 },
  { label: "mobile", width: 390, height: 844 },
];

const BROWSER_LAYOUT_AUDIT_SCRIPT = String.raw`
(() => {
  const overflowEpsilon = 1;
  const errorOverflowPx = 4;
  const findings = [];
  const seen = new Set();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  function roundedPx(value) {
    return Math.round(Math.max(0, Number(value) || 0) * 10) / 10;
  }

  function severity(overflowPx) {
    return overflowPx > errorOverflowPx ? "error" : "warning";
  }

  function text(el) {
    return String((el && (el.innerText || el.textContent)) || "").trim().replace(/\s+/g, " ");
  }

  function hasReadableText(el) {
    return text(el).length > 0;
  }

  function isAuditIgnored(el) {
    return Boolean(el && el.closest && el.closest('[data-pi-canvas-ignore-layout="true"]'));
  }

  function selector(el) {
    if (!el || el.nodeType !== 1) return "";
    const id = el.getAttribute("id");
    if (id) return "#" + id.replace(/"/g, '\\"');
    const testId = el.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent || parent === document.documentElement) return tag;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
    const part = siblings.length > 1 ? tag + ":nth-of-type(" + String(siblings.indexOf(el) + 1) + ")" : tag;
    if (parent === document.body) return part;
    const prefix = selector(parent);
    return prefix ? prefix + " > " + part : part;
  }

  function rectArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function intersectionArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function isVisible(el, rect) {
    if (!el || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function isIntentionalHorizontalScroller(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const overflowX = getComputedStyle(el).overflowX;
    return overflowX === "auto" || overflowX === "scroll";
  }

  function hasIntentionalHorizontalScrollerAncestor(el) {
    let node = el ? el.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isIntentionalHorizontalScroller(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function contentBoxRight(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const borderRight = Number.parseFloat(style.borderRightWidth || "0") || 0;
    const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
    return rect.right - borderRight - paddingRight;
  }

  function isIntentionalTextTruncation(style) {
    return style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp || "0", 10) > 0;
  }

  function push(finding) {
    const key = finding.kind + ":" + (finding.selector || "");
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      selector: String(finding.selector || ""),
      kind: String(finding.kind || "layout-warning"),
      overflowPx: roundedPx(finding.overflowPx),
      viewportWidth,
      viewportHeight,
      severity: finding.severity === "warning" ? "warning" : "error",
    });
  }

  const pageOverflowPx = document.documentElement.scrollWidth - viewportWidth;
  if (pageOverflowPx > overflowEpsilon) {
    push({ selector: "html", kind: "page-horizontal-overflow", overflowPx: pageOverflowPx, severity: severity(pageOverflowPx) });
  }

  const elements = [document.body, ...Array.from(document.body ? document.body.querySelectorAll("*") : [])].filter((el) => el && !isAuditIgnored(el)).slice(0, 500);
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;
    const style = getComputedStyle(el);
    const hasScrollerAncestor = hasIntentionalHorizontalScrollerAncestor(el);
    const isScroller = isIntentionalHorizontalScroller(el);

    const scrollOverflowPx = el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : 0;
    if (scrollOverflowPx > overflowEpsilon && !isScroller && !hasScrollerAncestor) {
      const clipsText = hasReadableText(el) && (style.overflowX === "hidden" || style.overflowX === "clip") && !isIntentionalTextTruncation(style);
      push({
        selector: selector(el),
        kind: clipsText ? "clipped-text" : "element-scroll-overflow",
        overflowPx: scrollOverflowPx,
        severity: clipsText ? "error" : severity(scrollOverflowPx),
      });
    }

    const verticalClipPx = el.clientHeight > 0 ? el.scrollHeight - el.clientHeight : 0;
    if (
      verticalClipPx > overflowEpsilon &&
      hasReadableText(el) &&
      (style.overflowY === "hidden" || style.overflowY === "clip") &&
      !isIntentionalTextTruncation(style)
    ) {
      push({ selector: selector(el), kind: "clipped-text", overflowPx: verticalClipPx, severity: "error" });
    }

    const parent = el.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement && !hasScrollerAncestor) {
      const parentOverflowPx = rect.right - contentBoxRight(parent);
      if (parentOverflowPx > overflowEpsilon && rectArea(rect) > 1) {
        const positionedOffCanvas = style.position === "absolute" || style.position === "fixed" || style.position === "sticky";
        push({
          selector: selector(el),
          kind: "element-parent-overflow",
          overflowPx: parentOverflowPx,
          severity: positionedOffCanvas ? "warning" : severity(parentOverflowPx),
        });
      }
    }
  }

  const textLeaves = elements
    .filter((el) => el.children.length === 0 && hasReadableText(el))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter((item) => isVisible(item.el, item.rect) && rectArea(item.rect) >= 16)
    .slice(0, 80);
  for (let index = 0; index < textLeaves.length; index += 1) {
    const current = textLeaves[index];
    if (!current) continue;
    for (let otherIndex = index + 1; otherIndex < textLeaves.length; otherIndex += 1) {
      const other = textLeaves[otherIndex];
      if (!other) continue;
      if (current.el.contains(other.el) || other.el.contains(current.el)) continue;
      const overlapArea = intersectionArea(current.rect, other.rect);
      if (overlapArea < Math.min(rectArea(current.rect) * 0.25, rectArea(other.rect) * 0.25, 24)) continue;
      push({ selector: selector(current.el), kind: "overlapping-text", overflowPx: 0, severity: "error" });
      break;
    }
  }

  return findings;
})()
`;

async function auditBrowserHostLayout(context: ScenarioContext, browserLog: AgentBrowserLogEntry[], label: string): Promise<BrowserLayoutAudit> {
  const findings: BrowserLayoutFinding[] = [];
  const viewports: Array<BrowserLayoutViewport & { findingCount: number; errorCount: number }> = [];
  for (const viewport of BROWSER_LAYOUT_VIEWPORTS) {
    await runAgentBrowser(context.runId, ["set", "viewport", String(viewport.width), String(viewport.height)], `${label}-layout-${viewport.label}-viewport`, browserLog);
    const output = await runAgentBrowserEvalScript(context.runId, BROWSER_LAYOUT_AUDIT_SCRIPT, `${label}-layout-${viewport.label}-audit`, browserLog);
    const viewportFindings = parseBrowserLayoutFindings(output.stdout, viewport);
    findings.push(...viewportFindings);
    viewports.push({
      ...viewport,
      findingCount: viewportFindings.length,
      errorCount: layoutErrorCount(viewportFindings),
    });
  }
  const path = join(context.reportsDir, `${context.runId}-${label}-layout-audit.json`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(path, `${JSON.stringify({ generatedAt: fixedNow().toISOString(), viewports, findings }, null, 2)}\n`, "utf-8");
  return { path, findings };
}

async function runAgentBrowserEvalScript(
  sessionId: string,
  script: string,
  label: string,
  browserLog: AgentBrowserLogEntry[],
  timeoutMs = 45000,
): Promise<AgentBrowserLogEntry> {
  return runAgentBrowser(sessionId, ["eval", "-b", Buffer.from(script, "utf-8").toString("base64")], label, browserLog, timeoutMs);
}

function parseBrowserLayoutFindings(stdout: string, viewport: BrowserLayoutViewport): BrowserLayoutFinding[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error(`browser layout audit returned non-array JSON for ${viewport.label}`);
  }
  const findings: BrowserLayoutFinding[] = [];
  for (const value of parsed) {
    if (!isRecord(value)) {
      throw new Error(`browser layout audit finding is not an object for ${viewport.label}`);
    }
    const kind = readString(value, "kind");
    const selector = readString(value, "selector");
    const severity = readString(value, "severity");
    const overflowPx = readNumber(value, "overflowPx");
    const viewportWidth = readNumber(value, "viewportWidth");
    const viewportHeight = readNumber(value, "viewportHeight");
    if (!kind || !selector || (severity !== "warning" && severity !== "error") || overflowPx === undefined) {
      throw new Error(`browser layout audit finding is invalid for ${viewport.label}: ${JSON.stringify(value)}`);
    }
    findings.push({
      viewport: viewport.label,
      viewportWidth: viewportWidth ?? viewport.width,
      viewportHeight: viewportHeight ?? viewport.height,
      selector,
      kind,
      overflowPx,
      severity,
    });
  }
  return findings;
}

function layoutErrorCount(findings: BrowserLayoutFinding[]): number {
  return findings.filter((finding) => finding.severity === "error").length;
}

function layoutAuditSummary(findings: BrowserLayoutFinding[]): string {
  return JSON.stringify({
    total: findings.length,
    errors: layoutErrorCount(findings),
    findings: findings.map((finding) => ({
      viewport: finding.viewport,
      kind: finding.kind,
      selector: finding.selector,
      severity: finding.severity,
      overflowPx: finding.overflowPx,
    })),
  });
}

function expectedLayoutFindingKind(fixtureKind: BrowserLayoutFixtureKind): string {
  if (fixtureKind === "overflow") return "page-horizontal-overflow";
  if (fixtureKind === "clipped-text") return "clipped-text";
  return "overlapping-text";
}

function createLayoutFixtureRenderer(fixtureKind: BrowserLayoutFixtureKind): BrowserArtifactRenderer {
  const rendererId = `fixture.layout-${fixtureKind}`;
  return {
    id: rendererId,
    version: 1,
    label: `Layout Fixture ${fixtureKind}`,
    actionSchema: { type: "object", additionalProperties: false },
    defaultActions: [],
    defaultState: { fixtureKind },
    defaultStateSchema: {
      type: "object",
      required: ["fixtureKind"],
      properties: { fixtureKind: { type: "string" } },
      additionalProperties: false,
    },
    renderHtml() {
      return renderLayoutFixtureHtml(fixtureKind);
    },
    reduceAction(): BrowserRendererTransition {
      return { kind: "reject", reason: "layout fixture is read-only", rendererActionType: "fixture" };
    },
  };
}

function renderLayoutFixtureHtml(fixtureKind: BrowserLayoutFixtureKind): string {
  const body =
    fixtureKind === "overflow"
      ? '<main id="app" class="overflow"><h1>Overflow fixture</h1><p>This fixture deliberately extends beyond the viewport.</p><div class="wide">wide visual rail</div></main>'
      : fixtureKind === "clipped-text"
        ? '<main id="app"><h1>Clipped text fixture</h1><p class="clipped">This paragraph is deliberately too long for its fixed box, so the real browser layout audit should report clipped text instead of trusting the screenshot alone.</p></main>'
        : '<main id="app"><h1>Overlap fixture</h1><p class="under">Primary decision text</p><p class="over">Conflicting overlay text</p></main>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Canvas Layout Fixture</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #f6f8fb; color: #16212d; }
    main { padding: 24px; }
    .overflow { width: calc(100vw + 80px); }
    .wide { width: 1400px; border: 1px solid #bf1d1d; padding: 12px; background: #fff1f2; }
    .clipped { width: 220px; height: 28px; overflow: hidden; border: 1px solid #bf1d1d; padding: 4px; background: #fff1f2; }
    .under, .over { margin: 0; width: 260px; padding: 10px; border: 1px solid #bf1d1d; background: #fff; }
    .over { margin-top: -38px; margin-left: 10px; background: rgba(255, 241, 242, 0.96); }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function waitBrowserEval(sessionId: string, expression: string, browserLog: AgentBrowserLogEntry[]): Promise<void> {
  const deadline = Date.now() + 8000;
  let last = "";
  while (Date.now() < deadline) {
    const result = await runAgentBrowser(sessionId, ["eval", expression], "host-wait-eval", browserLog);
    last = result.stdout.trim();
    if (parseBrowserBool(result.stdout)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Browser host condition timed out: ${expression}; last=${last}`);
}

async function runAgentBrowser(
  sessionId: string,
  args: string[],
  label: string,
  browserLog: AgentBrowserLogEntry[],
  timeoutMs = 15000,
): Promise<AgentBrowserLogEntry> {
  let lastEntry: AgentBrowserLogEntry | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let entry: AgentBrowserLogEntry;
    try {
      entry = await runAgentBrowserOnce(sessionId, args, `${label}${attempt === 1 ? "" : `#${attempt}`}`, browserLog, timeoutMs);
    } catch (error) {
      await closeAgentBrowserSessionAfterFailure(sessionId, `${label}-close-after-error`, browserLog);
      throw error;
    }
    lastEntry = entry;
    if (entry.exitCode === 0) return entry;
    if (!isRetryableAgentBrowserFailure(entry) || attempt === 3) {
      await closeAgentBrowserSessionAfterFailure(sessionId, `${label}-close-after-failure`, browserLog);
      throw new Error(`agent-browser failed (${label}): ${entry.stderr || entry.stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw new Error(`agent-browser failed (${label}): ${lastEntry?.stderr || lastEntry?.stdout || "unknown"}`);
}

async function runAgentBrowserOnce(
  sessionId: string,
  args: string[],
  label: string,
  browserLog: AgentBrowserLogEntry[],
  timeoutMs: number,
): Promise<AgentBrowserLogEntry> {
  const child = spawn("agent-browser", ["--session", sessionId, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const output = await collectProcessOutput(child, {
    timeoutMs,
    timeoutMessage: `agent-browser timed out: ${label}`,
    onTimeout: () => {
      killSpawnedProcess(child, "SIGTERM");
      killAgentBrowserSessionProcesses(sessionId, "SIGTERM");
      setTimeout(() => {
        killSpawnedProcess(child, "SIGKILL");
        killAgentBrowserSessionProcesses(sessionId, "SIGKILL");
      }, 2000).unref();
    },
  });
  const entry: AgentBrowserLogEntry = { label, command: ["agent-browser", "--session", sessionId, ...args], ...output };
  browserLog.push(entry);
  if (output.timedOut) {
    throw new Error(`agent-browser timed out: ${label}`);
  }
  return entry;
}

function isRetryableAgentBrowserFailure(entry: AgentBrowserLogEntry): boolean {
  const text = `${entry.stdout}\n${entry.stderr}`;
  return text.includes("Auto-launch failed") || text.includes("DevToolsActivePort") || text.includes("Chrome exited early");
}

function killSpawnedProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(child.pid, signal);
  } catch {
    // The process may already have exited between timeout scheduling and cleanup.
  }
}

export function killSpawnedProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Detached helpers create their own process group; it may already be gone.
  }
}

function killAgentBrowserSessionProcesses(sessionId: string, signal: NodeJS.Signals): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionId)) return;
  const signalName = signal.replace(/^SIG/, "");
  try {
    const child = spawn("pkill", [`-${signalName}`, "-f", `agent-browser.*--session ${sessionId}`], { stdio: "ignore" });
    child.on("error", () => {});
  } catch {
    // Best-effort cleanup for agent-browser commands that daemonize away from the direct child.
  }
}

async function closeAgentBrowserSessionAfterFailure(sessionId: string, label: string, browserLog: AgentBrowserLogEntry[]): Promise<void> {
  const entry = await runAgentBrowserOnce(sessionId, ["close"], label, browserLog, 5000).catch((error: unknown): AgentBrowserLogEntry => ({
    label,
    command: ["agent-browser", "--session", sessionId, "close"],
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: null,
  }));
  if (!browserLog.includes(entry)) browserLog.push(entry);
}

async function writeBrowserLog(context: ScenarioContext, browserLog: AgentBrowserLogEntry[], redactions: string[] = []): Promise<string> {
  const path = join(context.reportsDir, `${context.runId}-browser-host-log.json`);
  const redactedLog = redactions.length === 0 ? browserLog : redactBrowserLog(browserLog, redactions);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(redactedLog, null, 2)}\n`, "utf-8");
  return path;
}

function redactBrowserLog(browserLog: AgentBrowserLogEntry[], redactions: string[]): AgentBrowserLogEntry[] {
  const redactionSet = redactions.filter((value) => value.length > 0);
  return browserLog.map((entry) => JSON.parse(redactText(JSON.stringify(entry), redactionSet)) as AgentBrowserLogEntry);
}

function redactText(value: string, redactions: string[]): string {
  let redacted = value;
  for (const secret of redactions) {
    redacted = redacted.split(secret).join("[redacted-pi-canvas-token]");
  }
  return redacted;
}

function parseBrowserBool(stdout: string): boolean {
  const value = stdout.trim();
  try {
    return JSON.parse(value) === true;
  } catch {
    return value === "true";
  }
}

function browserHostCanvasActionBody(receipt: BrowserHostSessionReceipt, action: JsonObject): JsonObject {
  return {
    artifactId: receipt.artifactId,
    sessionId: receipt.hostSessionId,
    sourceHash: receipt.sourceHash,
    stateVersion: receipt.finalStateVersion,
    origin: receipt.allowedOrigin,
    action,
  };
}

function browserHostReviewNoteBody(receipt: BrowserHostSessionReceipt, text = "Review note from harness"): JsonObject {
  return {
    artifactId: receipt.artifactId,
    sessionId: receipt.hostSessionId,
    sourceHash: receipt.sourceHash,
    stateVersion: receipt.finalStateVersion,
    origin: receipt.allowedOrigin,
    text,
    target: { kind: "page" },
  };
}

function createIframeSetActionSchema(): JsonObject {
  return {
    type: "object",
    required: ["artifactId", "path", "value"],
    properties: {
      artifactId: { type: "string" },
      path: { type: "string" },
      value: {},
    },
    additionalProperties: false,
  };
}

function taskStateSchema(): JsonObject {
  return {
    type: "object",
    required: ["title", "priority", "done"],
    properties: {
      title: { type: "string" },
      priority: { type: "number" },
      done: { type: "boolean" },
    },
    additionalProperties: false,
  };
}

function iframeSetMessage(artifactId: string, path: string, value: JsonValue): JsonValue {
  return {
    jsonrpc: "2.0",
    method: "canvas.set",
    params: {
      artifactId,
      path,
      value,
    },
  };
}

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0;
  return value.split(needle).length - 1;
}

function makeRun(
  context: ScenarioContext,
  options: HarnessOptions,
  assertions: HarnessAssertion[],
  readback?: CanvasReadback,
  exported?: CanvasExportResult,
  readbackJsonPath = "",
  observableEvents: string[] = [],
  surfaceKind: PiCanvasHarnessRun["outsideIn"]["surfaceKind"] = "degraded",
  terminalTranscriptPath = "",
  successGateSatisfied = false,
  visualEvidencePath = "",
  visualEvidenceKind: BrowserVisualEvidenceKind = "screenshot",
): PiCanvasHarnessRun {
  const verdict = assertions.every((assertion) => assertion.verdict === "pass") ? "pass" : "fail";
  return {
    runId: context.runId,
    scenarioId: context.scenarioId,
    candidateId: context.candidateId,
    piVersion: options.piVersion ?? "unknown",
    extensionVersion: options.extensionVersion ?? "0.1.0",
    commands: [`npm run eval:harness -- --scenario ${context.scenarioId}`],
    outsideIn: {
      surfaceKind,
      observableEvents,
      ...(terminalTranscriptPath ? { terminalTranscriptPath } : {}),
      ...(visualEvidencePath ? { visualEvidencePath, visualEvidenceKind } : {}),
      ...(visualEvidencePath && visualEvidenceKind === "screenshot" ? { screenshotPath: visualEvidencePath } : {}),
    },
    insideOut: {
      sourcePath: readback?.paths.sourcePath ?? "",
      statePath: readback?.paths.statePath ?? "",
      actionLogPath: readback?.paths.actionsPath ?? "",
      readbackJsonPath,
      exportDir: exported?.exportDir ?? "",
      reviewDiffPaths: exported ? [exported.sourceDiffPath, exported.stateDiffPath] : [],
    },
    assertions,
    verdict,
    successGateSatisfied: verdict === "pass" && successGateSatisfied,
  };
}

interface RpcTrace {
  agentDir: string;
  stdoutPath: string;
  stderrPath: string;
  exitCode: number | null;
  uiNotifications: string[];
  canvasEvents: CanvasCommandEvent[];
  observableEvents: string[];
}

interface CanvasCommandEvent {
  event: string;
  artifactId?: string;
  version?: number;
  state?: JsonValue;
  exportDir?: string;
  sourcePath?: string;
  statePath?: string;
  actionsPath?: string;
  provenancePath?: string;
  sourceDiffPath?: string;
  stateDiffPath?: string;
}

interface ProcessOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean | undefined;
}

interface CollectProcessOutputOptions {
  timeoutMs?: number | undefined;
  timeoutMessage?: string | undefined;
  onTimeout?: (() => void) | undefined;
}

interface LiveTuiPtyTrace {
  agentDir: string;
  cwd: string;
  transcriptPath: string;
  rawTranscriptPath: string;
  checks: {
    tuiRendered: boolean;
    tuiStateRendered: boolean;
    readEvent: boolean;
    readState: boolean;
  };
  observableEvents: string[];
}

interface BrowserTerminalPtyTrace {
  agentDir: string;
  cwd: string;
  terminalTranscriptPath: string;
  rawTranscriptPath: string;
  browserSnapshotPath: string;
  browserScreenshotPath: string;
  browserLogPath: string;
  checks: {
    createdBrowser: boolean;
    tuiRenderedBrowser: boolean;
    tuiStateBrowser: boolean;
    tuiExportBrowser: boolean;
    tuiClosedBrowser: boolean;
    readBrowser: boolean;
    readStateBrowser: boolean;
  };
  observableEvents: string[];
}

async function runPiRpcPrompts(context: ScenarioContext, prompts: string[]): Promise<RpcTrace> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-canvas-rpc-agent-"));
  const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const stdoutPath = join(context.reportsDir, `${context.runId}-rpc-stdout.jsonl`);
  const stderrPath = join(context.reportsDir, `${context.runId}-rpc-stderr.txt`);
  await mkdir(context.reportsDir, { recursive: true });
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-e",
    extensionPath,
  ];
  const child = spawn("pi", args, {
    cwd: context.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let closed = false;
  const uiNotifications: string[] = [];
  const canvasEvents: CanvasCommandEvent[] = [];
  const waiters: Array<() => void> = [];
  const signalOutput = (): void => {
    const pending = waiters.splice(0);
    for (const waiter of pending) waiter();
  };
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      readRpcOutputLine(line, uiNotifications, canvasEvents);
    }
    signalOutput();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const close = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      if (stdoutBuffer.trim()) {
        readRpcOutputLine(stdoutBuffer.trim(), uiNotifications, canvasEvents);
        stdoutBuffer = "";
      }
      signalOutput();
      resolve(code);
    });
  });
  for (let index = 0; index < prompts.length; index += 1) {
    const message = prompts[index];
    if (message === undefined) continue;
    child.stdin.write(`${JSON.stringify({ id: `rpc-${index + 1}`, type: "prompt", message })}\n`);
    await waitForCanvasEventCount(canvasEvents, index + 1, () => closed, waiters);
  }
  child.stdin.end();
  const exitCode = await close;
  await writeFile(stdoutPath, stdout, "utf-8");
  await writeFile(stderrPath, stderr, "utf-8");
  return { agentDir, stdoutPath, stderrPath, exitCode, uiNotifications, canvasEvents, observableEvents: uiNotifications.map((message) => message.split("\n", 1)[0] ?? message) };
}

export async function collectProcessOutput(child: ReturnType<typeof spawn>, options: CollectProcessOutputOptions = {}): Promise<ProcessOutput> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  return await new Promise<ProcessOutput>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (output: ProcessOutput): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(output);
    };
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        const timeoutMessage = options.timeoutMessage ?? `process timed out after ${options.timeoutMs}ms`;
        stderr = stderr.trim().length === 0 ? timeoutMessage : `${stderr}\n${timeoutMessage}`;
        try {
          options.onTimeout?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr += `\nprocess timeout cleanup failed: ${message}`;
        }
        killSpawnedProcess(child, "SIGTERM");
        setTimeout(() => killSpawnedProcess(child, "SIGKILL"), 1000).unref();
        finish({ stdout, stderr, exitCode: child.exitCode, timedOut: true });
      }, options.timeoutMs);
      timeout.unref();
    }
    child.on("error", reject);
    child.on("close", (exitCode) => finish({ stdout, stderr, exitCode }));
  });
}

async function runPiLiveTuiPty(context: ScenarioContext, artifactId: string): Promise<LiveTuiPtyTrace> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-canvas-live-tui-agent-"));
  const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const scriptPath = fileURLToPath(new URL("../scripts/live-tui-pty.py", import.meta.url));
  const transcriptPath = join(context.reportsDir, `${context.runId}-tty-transcript.txt`);
  const rawTranscriptPath = join(context.reportsDir, `${context.runId}-tty-raw.txt`);
  await mkdir(context.reportsDir, { recursive: true });
  const child = spawn("python3", [
    scriptPath,
    "--extension",
    extensionPath,
    "--cwd",
    context.cwd,
    "--agent-dir",
    agentDir,
    "--artifact-id",
    artifactId,
    "--transcript",
    transcriptPath,
    "--raw-transcript",
    rawTranscriptPath,
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const { stdout, stderr, exitCode, timedOut } = await collectProcessOutput(child, {
    timeoutMs: LIVE_TUI_PTY_TIMEOUT_MS,
    timeoutMessage: `live TUI PTY helper timed out after ${LIVE_TUI_PTY_TIMEOUT_MS}ms`,
    onTimeout: () => {
      killSpawnedProcessGroup(child, "SIGTERM");
      setTimeout(() => killSpawnedProcessGroup(child, "SIGKILL"), 2000).unref();
    },
  });
  if (timedOut || exitCode !== 0) {
    throw new Error(`live TUI PTY helper failed with ${exitCode}: ${stderr}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  return parseLiveTuiPtyTrace(parsed, transcriptPath, rawTranscriptPath);
}

async function runPiBrowserTerminalPty(context: ScenarioContext, artifactId: string): Promise<BrowserTerminalPtyTrace> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-canvas-browser-terminal-agent-"));
  const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const scriptPath = fileURLToPath(new URL("../scripts/browser-terminal-pty.py", import.meta.url));
  const terminalTranscriptPath = resolve(join(context.reportsDir, `${context.runId}-browser-terminal-transcript.txt`));
  const rawTranscriptPath = resolve(join(context.reportsDir, `${context.runId}-browser-terminal-raw.txt`));
  const browserSnapshotPath = resolve(join(context.reportsDir, `${context.runId}-browser-terminal-snapshot.txt`));
  const browserScreenshotPath = resolve(join(context.reportsDir, `${context.runId}-browser-terminal.png`));
  const browserLogPath = resolve(join(context.reportsDir, `${context.runId}-browser-terminal-log.json`));
  await mkdir(context.reportsDir, { recursive: true });
  const child = spawn("python3", [
    scriptPath,
    "--extension",
    extensionPath,
    "--cwd",
    context.cwd,
    "--agent-dir",
    agentDir,
    "--artifact-id",
    artifactId,
    "--terminal-transcript",
    terminalTranscriptPath,
    "--raw-transcript",
    rawTranscriptPath,
    "--browser-snapshot",
    browserSnapshotPath,
    "--browser-screenshot",
    browserScreenshotPath,
    "--browser-log",
    browserLogPath,
    "--session",
    context.runId,
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const { stdout, stderr, exitCode, timedOut } = await collectProcessOutput(child, {
    timeoutMs: BROWSER_TERMINAL_PTY_TIMEOUT_MS,
    timeoutMessage: `browser terminal PTY helper timed out after ${BROWSER_TERMINAL_PTY_TIMEOUT_MS}ms`,
    onTimeout: () => {
      killSpawnedProcessGroup(child, "SIGTERM");
      killAgentBrowserSessionProcesses(context.runId, "SIGTERM");
      setTimeout(() => {
        killSpawnedProcessGroup(child, "SIGKILL");
        killAgentBrowserSessionProcesses(context.runId, "SIGKILL");
      }, 2000).unref();
    },
  });
  if (timedOut || exitCode !== 0) {
    throw new Error(`browser terminal PTY helper failed with ${exitCode}: ${stderr}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  return parseBrowserTerminalPtyTrace(parsed, terminalTranscriptPath, rawTranscriptPath, browserSnapshotPath, browserLogPath);
}

function parseLiveTuiPtyTrace(value: unknown, transcriptPath: string, rawTranscriptPath: string): LiveTuiPtyTrace {
  if (!isRecord(value)) {
    throw new Error("live TUI PTY helper returned non-object JSON");
  }
  const agentDir = readString(value, "agentDir");
  const cwd = readString(value, "cwd");
  const returnedTranscriptPath = readString(value, "transcriptPath");
  const returnedRawTranscriptPath = readString(value, "rawTranscriptPath");
  const checks = isRecord(value.checks) ? value.checks : undefined;
  if (!agentDir || !cwd || returnedTranscriptPath !== transcriptPath || returnedRawTranscriptPath !== rawTranscriptPath || !checks) {
    throw new Error("live TUI PTY helper returned invalid trace paths");
  }
  const observableEvents = Array.isArray(value.observableEvents) ? value.observableEvents.filter((item): item is string => typeof item === "string") : [];
  return {
    agentDir,
    cwd,
    transcriptPath,
    rawTranscriptPath,
    checks: {
      tuiRendered: checks.tui_rendered === true,
      tuiStateRendered: checks.tui_state_rendered === true,
      readEvent: checks.read_event === true,
      readState: checks.read_state === true,
    },
    observableEvents,
  };
}

function parseBrowserTerminalPtyTrace(
  value: unknown,
  terminalTranscriptPath: string,
  rawTranscriptPath: string,
  browserSnapshotPath: string,
  browserLogPath: string,
): BrowserTerminalPtyTrace {
  if (!isRecord(value)) {
    throw new Error("browser terminal PTY helper returned non-object JSON");
  }
  const agentDir = readString(value, "agentDir");
  const cwd = readString(value, "cwd");
  const returnedTerminalTranscriptPath = readString(value, "terminalTranscriptPath");
  const returnedRawTranscriptPath = readString(value, "rawTranscriptPath");
  const returnedBrowserSnapshotPath = readString(value, "browserSnapshotPath");
  const returnedBrowserLogPath = readString(value, "browserLogPath");
  const browserScreenshotPath = readString(value, "browserScreenshotPath") ?? "";
  const checks = isRecord(value.checks) ? value.checks : undefined;
  if (
    !agentDir ||
    !cwd ||
    returnedTerminalTranscriptPath !== terminalTranscriptPath ||
    returnedRawTranscriptPath !== rawTranscriptPath ||
    returnedBrowserSnapshotPath !== browserSnapshotPath ||
    returnedBrowserLogPath !== browserLogPath ||
    !checks
  ) {
    throw new Error("browser terminal PTY helper returned invalid trace paths");
  }
  const observableEvents = Array.isArray(value.observableEvents) ? value.observableEvents.filter((item): item is string => typeof item === "string") : [];
  return {
    agentDir,
    cwd,
    terminalTranscriptPath,
    rawTranscriptPath,
    browserSnapshotPath,
    browserScreenshotPath,
    browserLogPath,
    checks: {
      createdBrowser: checks.created_browser === true,
      tuiRenderedBrowser: checks.tui_rendered_browser === true,
      tuiStateBrowser: checks.tui_state_browser === true,
      tuiExportBrowser: checks.tui_export_browser === true,
      tuiClosedBrowser: checks.tui_closed_browser === true,
      readBrowser: checks.read_browser === true,
      readStateBrowser: checks.read_state_browser === true,
    },
    observableEvents,
  };
}

function readRpcOutputLine(line: string, uiNotifications: string[], canvasEvents: CanvasCommandEvent[]): void {
  if (!line.trim()) return;
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || parsed.type !== "extension_ui_request" || parsed.method !== "notify") return;
  const message = readString(parsed, "message");
  if (!message) return;
  uiNotifications.push(message);
  const canvasEvent = readCanvasCommandEvent(message);
  if (canvasEvent) canvasEvents.push(canvasEvent);
}

async function waitForCanvasEventCount(events: CanvasCommandEvent[], count: number, isClosed: () => boolean, waiters: Array<() => void>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (events.length < count && !isClosed() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        resolve();
      }, Math.max(0, Math.min(250, deadline - Date.now())));
      waiters.push(waiter);
    });
  }
}

function readCanvasCommandEvent(message: string): CanvasCommandEvent | undefined {
  const prefix = "pi-canvas event ";
  if (!message.startsWith(prefix)) return undefined;
  const parsed: unknown = JSON.parse(message.slice(prefix.length));
  if (!isRecord(parsed)) return undefined;
  const event = readString(parsed, "event");
  if (!event) return undefined;
  const output: CanvasCommandEvent = { event };
  const artifactId = readString(parsed, "artifactId");
  if (artifactId !== undefined) output.artifactId = artifactId;
  const version = readNumber(parsed, "version");
  if (version !== undefined) output.version = version;
  if (isJsonValue(parsed.state)) output.state = parsed.state;
  const exportDir = readString(parsed, "exportDir");
  if (exportDir !== undefined) output.exportDir = exportDir;
  const sourcePath = readString(parsed, "sourcePath");
  if (sourcePath !== undefined) output.sourcePath = sourcePath;
  const statePath = readString(parsed, "statePath");
  if (statePath !== undefined) output.statePath = statePath;
  const actionsPath = readString(parsed, "actionsPath");
  if (actionsPath !== undefined) output.actionsPath = actionsPath;
  const provenancePath = readString(parsed, "provenancePath");
  if (provenancePath !== undefined) output.provenancePath = provenancePath;
  const sourceDiffPath = readString(parsed, "sourceDiffPath");
  if (sourceDiffPath !== undefined) output.sourceDiffPath = sourceDiffPath;
  const stateDiffPath = readString(parsed, "stateDiffPath");
  if (stateDiffPath !== undefined) output.stateDiffPath = stateDiffPath;
  return output;
}

function readCanvasEventByName(events: CanvasCommandEvent[], event: string): CanvasCommandEvent | undefined {
  return events.find((item) => item.event === event);
}

async function readPersistedState(statePath: string | undefined): Promise<JsonValue | undefined> {
  if (!statePath) return undefined;
  const parsed: unknown = JSON.parse(await readFile(statePath, "utf-8"));
  if (!isRecord(parsed) || !isJsonValue(parsed.state)) return undefined;
  return parsed.state;
}

function eventReadback(event: CanvasCommandEvent | undefined): CanvasReadback | undefined {
  if (
    !event?.artifactId ||
    event.version === undefined ||
    event.state === undefined ||
    !event.sourcePath ||
    !event.statePath ||
    !event.provenancePath
  ) {
    return undefined;
  }
  return {
    source: {
      artifactId: event.artifactId,
      schemaVersion: 2,
      title: event.artifactId,
      viewKind: "pi-tui-component",
      view: {
        kind: "pi-tui-component",
        rendererId: "builtin.json-card",
        rendererVersion: 1,
      },
      stateSchema: {},
      initialState: event.state,
      actions: [{ type: "set", path: "value", label: "Set value" }],
      createdAt: "",
      updatedAt: "",
    },
    state: {
      artifactId: event.artifactId,
      version: event.version,
      sourceHash: "",
      state: event.state,
      updatedAt: "",
    },
    paths: {
      artifactDir: dirname(event.sourcePath),
      sourcePath: event.sourcePath,
      statePath: event.statePath,
      actionsPath: event.actionsPath ?? "",
      provenancePath: event.provenancePath,
    },
  };
}

function readExportEvent(events: CanvasCommandEvent[]): CanvasExportResult | undefined {
  const event = readCanvasEventByName(events, "exported");
  if (
    !event?.artifactId ||
    !event.exportDir ||
    !event.sourcePath ||
    !event.statePath ||
    !event.provenancePath ||
    !event.sourceDiffPath ||
    !event.stateDiffPath
  ) {
    return undefined;
  }
  return {
    artifactId: event.artifactId,
    exportDir: event.exportDir,
    sourcePath: event.sourcePath,
    statePath: event.statePath,
    provenancePath: event.provenancePath,
    sourceDiffPath: event.sourceDiffPath,
    stateDiffPath: event.stateDiffPath,
  };
}

function exportFromReadback(readback: CanvasReadback): CanvasExportResult | undefined {
  const exportDir = readback.latestProvenance?.exportDir;
  if (!exportDir) return undefined;
  return {
    artifactId: readback.source.artifactId,
    exportDir,
    sourcePath: join(exportDir, "canvas.source.json"),
    statePath: join(exportDir, "canvas.state.json"),
    provenancePath: join(exportDir, "canvas.provenance.jsonl"),
    sourceDiffPath: join(exportDir, "source.diff"),
    stateDiffPath: join(exportDir, "state.diff"),
  };
}

async function writeHarnessBrowserHostEvidence(session: LocalBrowserHostSession, readback: CanvasReadback, exported: CanvasExportResult): Promise<string | undefined> {
  const receiptDir = dirname(session.receipt.receiptPath);
  const evidence = withBrowserHostReadiness(readback, summarizeBrowserHostEvidenceReceipts(receiptDir, readback, [session.receipt]), createDefaultBrowserArtifactRendererRegistry());
  return writeBrowserHostEvidenceExport(exported.exportDir, evidence);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeRun(context: ScenarioContext, run: PiCanvasHarnessRun): Promise<PiCanvasHarnessRun> {
  const path = join(context.reportsDir, `${run.runId}.json`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
  return run;
}

async function writeReadback(context: ScenarioContext, readback: CanvasReadback): Promise<string> {
  const path = join(context.reportsDir, `${context.runId}-readback.json`);
  await mkdir(context.reportsDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(readback, null, 2)}\n`, "utf-8");
  return path;
}

function pass(id: string, layer: HarnessAssertion["layer"], expected: string, actual: string, artifactPath: string): HarnessAssertion {
  return { id, layer, expected, actual, artifactPath, verdict: "pass" };
}

function fail(id: string, layer: HarnessAssertion["layer"], expected: string, actual: string, artifactPath: string): HarnessAssertion {
  return { id, layer, expected, actual, artifactPath, verdict: "fail" };
}

function fixedNow(): Date {
  return new Date("2026-06-27T00:00:00.000Z");
}
