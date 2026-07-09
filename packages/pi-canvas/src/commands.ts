import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  readBrowserHostEvidence,
  withBrowserHostReadiness,
  writeBrowserHostEvidenceExport,
  type BrowserHostEvidenceExport,
} from "./browser-host-evidence.js";
import { prepareGuardedCanvasUpdate } from "./browser-artifact-update-guard.js";
import type { BrowserArtifactRendererRegistry } from "./browser-renderer.js";
import { createDefaultBrowserArtifactRendererRegistry } from "./builtin-browser-renderers.js";
import { formatBrowserHostEvidenceLines } from "./browser-host-lines.js";
import { createDefaultCanvasRendererRegistry } from "./builtin-canvas-renderers.js";
import { createCanvasPreviewComponent, type CanvasRendererRegistry } from "./canvas-renderer.js";
import { assertJsonValue } from "./json.js";
import type { PiCanvasRuntime } from "./runtime.js";
import { createCanvasTuiSurface, renderCanvasTerminal, type CanvasTuiResult } from "./surface.js";
import type { CanvasExportResult, CanvasReadback, JsonValue } from "./types.js";

export const CANVAS_COMMAND = "canvas";

export type RuntimeGetter = (ctx: ExtensionContext) => PiCanvasRuntime;

interface CanvasArtifactSummary {
  artifactId: string;
  title: string;
  version: number;
  surface: string;
}

interface CanvasRenderResult {
  artifactId: string;
  version: number;
  closedBy: "escape" | "quit";
}

export function registerCanvasCommand(
  pi: ExtensionAPI,
  getRuntime: RuntimeGetter,
  registry: CanvasRendererRegistry = createDefaultCanvasRendererRegistry(),
  browserRegistry: BrowserArtifactRendererRegistry = createDefaultBrowserArtifactRendererRegistry(),
): void {
  pi.registerCommand(CANVAS_COMMAND, {
    description: "Inspect pi-canvas artifacts",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const items = ["browse", "create", "create-counter", "export", "help", "open", "read", "render", "status", "update"].filter((item) => item.startsWith(normalized)).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      await handleCanvasCommand(args, ctx, getRuntime(ctx), registry, browserRegistry);
    },
  });
}

export async function handleCanvasCommand(
  args: string,
  ctx: ExtensionCommandContext,
  runtime: PiCanvasRuntime,
  registry: CanvasRendererRegistry = createDefaultCanvasRendererRegistry(),
  browserRegistry: BrowserArtifactRendererRegistry = createDefaultBrowserArtifactRendererRegistry(),
): Promise<void> {
  try {
    const { token: command, rest } = readToken(args.trim() || "help");
    if (command === "help") {
      notify(ctx, helpText());
      return;
    }
    if (command === "status") {
      const ids = await runtime.listArtifactIds();
      notify(ctx, [`pi-canvas status`, `store: ${runtime.store.rootDir}`, `artifacts: ${ids.length}`, ...ids.slice(0, 10).map((id) => `  ${id}`)].join("\n"));
      return;
    }
    if (command === "browse" || command === "list") {
      const artifactId = await browseCanvasArtifacts(ctx, runtime, browserRegistry, "Browse pi-canvas artifacts");
      if (artifactId) {
        await openCanvasTui(ctx, runtime, registry, browserRegistry, artifactId);
      }
      return;
    }
    if (command === "create") {
      const { token: artifactId, rest: stateText } = readRequiredToken(rest, "artifact id");
      const state = parseJsonValue(stateText, "initial state");
      const readback = await runtime.create({ artifactId, title: artifactId, initialState: state, ...rendererCreateOptions(registry, "builtin.json-card") });
      notifyReadback(ctx, "created", readback);
      return;
    }
    if (command === "create-counter") {
      const { token: artifactId, rest: countText } = readRequiredToken(rest, "artifact id");
      const count = parseCounterInitialValue(countText);
      const readback = await runtime.create({ artifactId, title: artifactId, initialState: { count }, ...rendererCreateOptions(registry, "builtin.counter") });
      notifyReadback(ctx, "created", readback);
      return;
    }
    if (command === "update") {
      const { token: artifactId, rest: pathAndValue } = readRequiredToken(rest, "artifact id");
      const { token: path, rest: valueText } = readRequiredToken(pathAndValue, "state path");
      const value = parseJsonValue(valueText, "update value");
      const current = await runtime.read(artifactId);
      if (!current) {
        notify(ctx, formatCanvasEvent({ event: "missing", artifactId }));
        return;
      }
      const readback = await runtime.update(prepareGuardedCanvasUpdate({ artifactId, path, value, actor: "command-user" }, current, browserRegistry));
      const browserHost = withBrowserHostReadiness(readback, await readBrowserHostEvidence(runtime.store.rootDir, readback), browserRegistry);
      notifyReadback(ctx, "updated", readback, browserHost);
      return;
    }
    if (command === "read") {
      const { token: artifactId } = readRequiredToken(rest, "artifact id");
      const readback = await runtime.read(artifactId);
      if (!readback) {
        notify(ctx, formatCanvasEvent({ event: "missing", artifactId }));
        return;
      }
      const browserHost = withBrowserHostReadiness(readback, await readBrowserHostEvidence(runtime.store.rootDir, readback), browserRegistry);
      notifyReadback(ctx, "read", readback, browserHost);
      return;
    }
    if (command === "render") {
      const { token: artifactId } = readToken(rest);
      const selectedArtifactId = artifactId || (await browseCanvasArtifacts(ctx, runtime, browserRegistry, "Render pi-canvas artifact"));
      if (!selectedArtifactId) return;
      const readback = await runtime.read(selectedArtifactId);
      if (!readback) {
        notify(ctx, formatCanvasEvent({ event: "missing", artifactId: selectedArtifactId }), "warning");
        return;
      }
      const browserHost = withBrowserHostReadiness(readback, await readBrowserHostEvidence(runtime.store.rootDir, readback), browserRegistry);
      if (ctx.mode === "tui") {
        await renderCanvasTui(ctx, readback, registry, browserHost);
        return;
      }
      notify(ctx, formatCanvasRender(readback, browserHost));
      return;
    }
    if (command === "export") {
      const { token: artifactId, rest: targetDirText } = readRequiredToken(rest, "artifact id");
      const targetDir = targetDirText.trim() || undefined;
      const readback = await runtime.read(artifactId);
      if (!readback) {
        notify(ctx, formatCanvasEvent({ event: "missing", artifactId }));
        return;
      }
      const browserHost = withBrowserHostReadiness(readback, await readBrowserHostEvidence(runtime.store.rootDir, readback), browserRegistry);
      const exported = await runtime.export(artifactId, targetDir);
      if (!exported) {
        notify(ctx, formatCanvasEvent({ event: "missing", artifactId }));
        return;
      }
      const browserHostEvidencePath = await writeBrowserHostEvidenceExport(exported.exportDir, browserHost);
      notify(ctx, formatExportEvent(exported, browserHostEvidencePath, browserHost));
      return;
    }
    if (command === "open") {
      const { token: artifactId } = readToken(rest);
      const selectedArtifactId = artifactId || (await browseCanvasArtifacts(ctx, runtime, browserRegistry, "Open pi-canvas artifact"));
      if (selectedArtifactId) {
        await openCanvasTui(ctx, runtime, registry, browserRegistry, selectedArtifactId);
      }
      return;
    }
    notify(ctx, `Unknown /canvas argument: ${args}\n\n${helpText()}`, "warning");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function openCanvasTui(
  ctx: ExtensionCommandContext,
  runtime: PiCanvasRuntime,
  registry: CanvasRendererRegistry,
  browserRegistry: BrowserArtifactRendererRegistry,
  artifactId: string,
): Promise<void> {
  const readback = await runtime.read(artifactId);
  if (!readback) {
    notify(ctx, formatCanvasEvent({ event: "missing", artifactId }), "warning");
    return;
  }
  const browserHost = withBrowserHostReadiness(readback, await readBrowserHostEvidence(runtime.store.rootDir, readback), browserRegistry);
  if (ctx.mode !== "tui") {
    notify(ctx, formatCanvasOpenFallback(readback, ctx.mode, browserHost), "warning");
    return;
  }
  if (readback.source.view !== undefined && readback.source.view.kind !== "pi-tui-component") {
    await renderCanvasTui(ctx, readback, registry, browserHost);
    return;
  }
  const result = await ctx.ui.custom<CanvasTuiResult>(async (tui, _theme, _keybindings, done) =>
    createCanvasTuiSurface({
      runtime,
      registry,
      artifactId,
      host: { requestRender: () => tui.requestRender() },
      onDone: done,
    }),
  );
  notify(ctx, formatCanvasEvent({ event: "tui-closed", ...result }));
}

async function renderCanvasTui(ctx: ExtensionCommandContext, readback: CanvasReadback, registry: CanvasRendererRegistry, browserHost?: BrowserHostEvidenceExport | undefined): Promise<void> {
  const result = await ctx.ui.custom<CanvasRenderResult>(
    (tui, _theme, _keybindings, done) => new CanvasReadonlyPreviewSurface(readback, registry, formatBrowserHostEvidenceLines(browserHost), done, () => tui.requestRender()),
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
  );
  notify(ctx, formatCanvasEvent({ event: "render-closed", ...result }));
}

function helpText(): string {
  return [
    "pi-canvas commands:",
    "  /canvas help",
    "  /canvas status",
    "  /canvas browse",
    "  /canvas create <artifactId> <jsonState>",
    "  /canvas create-counter <artifactId> [initialCount]",
    "  /canvas update <artifactId> <path> <jsonValue>",
    "  /canvas read <artifactId>",
    "  /canvas render [artifactId]",
    "  /canvas export <artifactId> [targetDir]",
    "  /canvas open [artifactId]",
    "",
    "Model tools:",
    "  canvas_browser_artifacts({})",
    "  canvas_create({ title, initialState?, artifactId?, surfaceKind?, rendererId?, rendererVersion?, browserRendererId?, browserRendererVersion?, viewProps?, optionChooser?, reviewDecision?, form? })",
    "  canvas_update({ artifactId, path, value, actor?, expectedSourceHash?, expectedStateVersion? })",
    "  canvas_read({ artifactId })",
    "  canvas_render({ artifactId })",
    "  canvas_present({ artifactId })",
    "  canvas_export({ artifactId, targetDir? })",
    "",
    "Terminal canvases render through Pi TUI components. Browser artifacts are local browser-host patterns whose canonical state is read with canvas_read.",
  ].join("\n");
}

function readRequiredToken(input: string, label: string): { token: string; rest: string } {
  const token = readToken(input);
  if (!token.token) {
    throw new Error(`/canvas ${label} is required`);
  }
  return token;
}

function readToken(input: string): { token: string; rest: string } {
  const trimmed = input.trim();
  if (!trimmed) return { token: "", rest: "" };
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return { token: trimmed, rest: "" };
  return { token: trimmed.slice(0, firstSpace), rest: trimmed.slice(firstSpace).trim() };
}

function parseJsonValue(input: string, label: string): JsonValue {
  if (!input.trim()) {
    throw new Error(`/canvas ${label} JSON is required`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const suffix = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`/canvas ${label} must be valid JSON${suffix}`);
  }
  assertJsonValue(parsed, label);
  return parsed;
}

function parseCounterInitialValue(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error("/canvas initialCount must be a finite number");
  }
  return parsed;
}

function rendererCreateOptions(registry: CanvasRendererRegistry, rendererId: string): { rendererId: string; rendererVersion: number; actions?: CanvasReadback["source"]["actions"] } {
  const renderer = registry.require(rendererId);
  return {
    rendererId: renderer.id,
    rendererVersion: renderer.version,
    ...(renderer.defaultActions ? { actions: renderer.defaultActions.map((action) => ({ ...action })) } : {}),
  };
}

function formatReadbackEvent(event: "created" | "updated" | "read", readback: CanvasReadback, browserHost?: BrowserHostEvidenceExport | undefined): string {
  return formatCanvasEvent({
    event,
    artifactId: readback.source.artifactId,
    version: readback.state.version,
    state: readback.state.state,
    sourcePath: readback.paths.sourcePath,
    statePath: readback.paths.statePath,
    actionsPath: readback.paths.actionsPath,
    provenancePath: readback.paths.provenancePath,
    ...(browserHost?.readiness === undefined
      ? {}
      : {
          browserHostReadiness: {
            status: browserHost.readiness.status,
            readyForHandoff: browserHost.readiness.readyForHandoff,
            reason: browserHost.readiness.reason,
            nextAction: browserHost.readiness.nextAction,
          },
          browserHostReceipts: browserHost.receipts.length,
          browserHostReviewNotes: browserHost.reviewNotes.length,
          browserHostLayoutAudits: browserHost.layoutAudits.length,
          ...(browserHost.artifactPattern === undefined ? {} : { browserHostArtifactPattern: browserHost.artifactPattern }),
          ...(browserHost.artifactState === undefined ? {} : { browserHostArtifactState: browserHost.artifactState }),
          ...(browserHost.reviewAnnotations === undefined ? {} : { browserHostReviewAnnotations: browserHost.reviewAnnotations }),
        }),
  });
}

function notifyReadback(ctx: ExtensionCommandContext, event: "created" | "updated" | "read", readback: CanvasReadback, browserHost?: BrowserHostEvidenceExport | undefined): void {
  if (ctx.mode === "print") {
    notify(ctx, formatCanvasRender(readback, browserHost));
    return;
  }
  notify(ctx, formatReadbackEvent(event, readback, browserHost));
}

function formatExportEvent(
  exported: CanvasExportResult,
  browserHostEvidencePath?: string | undefined,
  browserHost?: BrowserHostEvidenceExport | undefined,
): string {
  return formatCanvasEvent({
    event: "exported",
    artifactId: exported.artifactId,
    exportDir: exported.exportDir,
    sourcePath: exported.sourcePath,
    statePath: exported.statePath,
    provenancePath: exported.provenancePath,
    sourceDiffPath: exported.sourceDiffPath,
    stateDiffPath: exported.stateDiffPath,
    ...(browserHostEvidencePath === undefined ? {} : { browserHostEvidencePath }),
    ...(browserHost?.readiness === undefined
      ? {}
      : {
          browserHostReadiness: {
            status: browserHost.readiness.status,
            readyForHandoff: browserHost.readiness.readyForHandoff,
            reason: browserHost.readiness.reason,
            nextAction: browserHost.readiness.nextAction,
          },
        }),
    ...(browserHost?.artifactPattern === undefined ? {} : { browserHostArtifactPattern: browserHost.artifactPattern }),
    ...(browserHost?.artifactState === undefined ? {} : { browserHostArtifactState: browserHost.artifactState }),
    ...(browserHost?.reviewAnnotations === undefined ? {} : { browserHostReviewAnnotations: browserHost.reviewAnnotations }),
  });
}

function formatCanvasRender(readback: CanvasReadback, browserHost?: BrowserHostEvidenceExport | undefined): string {
  const extraLines = formatBrowserHostEvidenceLines(browserHost);
  return renderCanvasTerminal(readback, {
    width: process.stdout.columns,
    ...(extraLines.length === 0 ? {} : { extraLines }),
  }).join("\n");
}

function formatCanvasOpenFallback(readback: CanvasReadback, mode: string, browserHost?: BrowserHostEvidenceExport | undefined): string {
  const extraLines = formatBrowserHostEvidenceLines(browserHost);
  return [
    ...renderCanvasTerminal(readback, { width: process.stdout.columns, ...(extraLines.length === 0 ? {} : { extraLines }) }),
    "",
    `Interactive controls require Pi TUI mode. Current mode: ${mode}.`,
    "Run plain `pi`, then `/canvas open` to browse artifacts.",
  ].join("\n");
}

function formatCanvasEvent(event: Record<string, unknown>): string {
  return `pi-canvas event ${JSON.stringify(event)}`;
}

async function browseCanvasArtifacts(ctx: ExtensionCommandContext, runtime: PiCanvasRuntime, browserRegistry: BrowserArtifactRendererRegistry, title: string): Promise<string | undefined> {
  const summaries = await readArtifactSummaries(runtime, browserRegistry);
  if (summaries.length === 0) {
    notify(ctx, "No pi-canvas artifacts found.\nCreate one with `/canvas create <artifactId> <jsonState>`.", "warning");
    return undefined;
  }
  if (ctx.mode === "tui") {
    const selected = await ctx.ui.select(title, summaries.map(formatArtifactChoice));
    if (!selected) return undefined;
    return readArtifactIdFromChoice(selected);
  }
  notify(ctx, formatArtifactList(summaries), "warning");
  return undefined;
}

async function readArtifactSummaries(runtime: PiCanvasRuntime, browserRegistry: BrowserArtifactRendererRegistry): Promise<CanvasArtifactSummary[]> {
  const ids = await runtime.listArtifactIds();
  const summaries: CanvasArtifactSummary[] = [];
  for (const artifactId of ids) {
    const readback = await runtime.read(artifactId);
    const browserHost = readback === undefined ? undefined : withBrowserHostReadiness(readback, await readBrowserHostEvidence(runtime.store.rootDir, readback), browserRegistry);
    summaries.push({
      artifactId,
      title: readback?.source.title ?? artifactId,
      version: readback?.state.version ?? 0,
      surface: readback === undefined ? "missing" : formatArtifactSurface(readback, browserHost),
    });
  }
  return summaries;
}

function formatArtifactChoice(summary: CanvasArtifactSummary): string {
  return `${summary.artifactId}  ${summary.title}  v${summary.version}  ${summary.surface}`;
}

function formatArtifactSurface(readback: CanvasReadback, browserHost: BrowserHostEvidenceExport | undefined): string {
  const view = readback.source.view;
  if (view?.kind === "browser-host-artifact") {
    return `browser:${browserHost?.readiness?.status ?? "unknown"}`;
  }
  if (view === undefined || view.kind === "pi-tui-component") return "terminal";
  return `adjacent:${view.kind}`;
}

function readArtifactIdFromChoice(choice: string): string {
  const [artifactId] = choice.trim().split(/\s+/, 1);
  return artifactId ?? "";
}

function formatArtifactList(summaries: CanvasArtifactSummary[]): string {
  return [
    "pi-canvas artifacts:",
    ...summaries.map((summary) => `  ${formatArtifactChoice(summary)}`),
    "",
    "Run `/canvas open` in Pi TUI to browse, or `/canvas render <artifactId>` to print one.",
  ].join("\n");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
  if (ctx.mode === "print") {
    process.stdout.write(`${message}\n`);
  }
}

class CanvasReadonlyPreviewSurface implements Component {
  private readonly component: Component;

  constructor(
    readback: CanvasReadback,
    registry: CanvasRendererRegistry,
    extraLines: string[],
    private readonly done: (result: CanvasRenderResult) => void,
    private readonly requestRender: () => void,
  ) {
    this.component = createCanvasPreviewComponent(readback, registry, extraLines.length === 0 ? {} : { extraLines });
    this.result = { artifactId: readback.source.artifactId, version: readback.state.version, closedBy: "quit" };
  }

  private readonly result: CanvasRenderResult;
  private closed = false;

  handleInput(data: string): void {
    if (this.closed) return;
    if (data !== "q" && data !== "Q" && data !== "\x1b") return;
    this.closed = true;
    this.done({ ...this.result, closedBy: data === "\x1b" ? "escape" : "quit" });
    this.requestRender();
  }

  invalidate(): void {
    this.component.invalidate();
  }

  render(width: number): string[] {
    return this.component.render(width);
  }
}
