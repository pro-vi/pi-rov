import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { resolveCanvasViewDefinition, type CanvasRendererRegistry, type CanvasSurfaceContext } from "./canvas-renderer.js";
import type { PiCanvasRuntime } from "./runtime.js";
import type { CanvasExportResult, CanvasReadback, JsonValue } from "./types.js";

export interface CanvasTuiHost {
  requestRender(): void;
}

export interface CanvasTuiResult {
  artifactId: string;
  version: number;
  state: JsonValue;
  closedBy: "escape" | "quit";
  exportDir?: string;
}

export interface CanvasTuiSurfaceOptions {
  runtime: PiCanvasRuntime;
  registry: CanvasRendererRegistry;
  artifactId: string;
  host: CanvasTuiHost;
  onDone?: (result: CanvasTuiResult) => void;
}

export interface CanvasTerminalRenderOptions {
  width?: number;
  includeControls?: boolean;
  extraLines?: string[];
}

export class CanvasTuiSurface implements Component {
  private readonly runtime: PiCanvasRuntime;
  private readonly artifactId: string;
  private readonly host: CanvasTuiHost;
  private readonly onDone: ((result: CanvasTuiResult) => void) | undefined;
  private readonly component: Component;
  private readonly surfaceContext: CanvasSurfaceContext;
  private readback: CanvasReadback;
  private latestExport: CanvasExportResult | undefined;
  private latestError: string | undefined;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  private readonly observableEvents: string[] = [];

  constructor(options: CanvasTuiSurfaceOptions, readback: CanvasReadback) {
    this.runtime = options.runtime;
    this.artifactId = options.artifactId;
    this.host = options.host;
    this.onDone = options.onDone;
    this.readback = readback;
    const view = resolveCanvasViewDefinition(readback);
    const renderer = options.registry.require(view.rendererId, view.rendererVersion);
    this.surfaceContext = {
      readback: this.readback,
      view,
      update: (path, value, actor, input) => this.update(path, value, actor, input),
      export: () => this.export(),
      close: (closedBy) => this.closeAfterPending(closedBy),
      getLatestExport: () => this.latestExport,
      getLatestError: () => this.latestError,
    };
    this.component = renderer.createSurface?.(this.surfaceContext) ?? renderer.createPreview(this.surfaceContext);
    this.observableEvents.push(`tui opened ${this.artifactId} v${this.readback.state.version}`);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.component.handleInput?.(data);
  }

  invalidate(): void {
    this.component.invalidate();
    this.host.requestRender();
  }

  render(width: number): string[] {
    return this.component.render(width);
  }

  waitForIdle(): Promise<void> {
    return this.pending;
  }

  getReadback(): CanvasReadback {
    return this.readback;
  }

  getLatestExport(): CanvasExportResult | undefined {
    return this.latestExport;
  }

  getObservableEvents(): string[] {
    return [...this.observableEvents];
  }

  private enqueue(task: () => Promise<void>): void {
    this.pending = this.pending
      .then(task)
      .catch((error: unknown) => {
        this.latestError = error instanceof Error ? error.message : String(error);
        this.observableEvents.push(`tui error ${this.latestError}`);
      })
      .finally(() => {
        this.surfaceContext.readback = this.readback;
        this.component.invalidate();
        this.host.requestRender();
      });
  }

  private update(path: string, value: JsonValue, actor: string, input: string): void {
    this.enqueue(async () => {
      this.readback = await this.runtime.update({
        artifactId: this.artifactId,
        path,
        value,
        actor,
      });
      this.surfaceContext.readback = this.readback;
      this.observableEvents.push(`tui input ${displayKey(input)} set ${path}=${JSON.stringify(value)}`);
    });
  }

  private export(): void {
    this.enqueue(async () => {
      const exported = await this.runtime.export(this.artifactId);
      if (!exported) {
        throw new Error(`Canvas artifact not found: ${this.artifactId}`);
      }
      this.latestExport = exported;
      this.readback = (await this.runtime.read(this.artifactId)) ?? this.readback;
      this.surfaceContext.readback = this.readback;
      this.observableEvents.push(`tui exported ${this.artifactId} ${exported.exportDir}`);
    });
  }

  private closeAfterPending(closedBy: CanvasTuiResult["closedBy"]): void {
    if (this.closed) return;
    this.closed = true;
    this.enqueue(async () => {
      this.readback = (await this.runtime.read(this.artifactId)) ?? this.readback;
      this.surfaceContext.readback = this.readback;
      this.observableEvents.push(`tui closed ${this.artifactId} ${closedBy}`);
      this.onDone?.({
        artifactId: this.artifactId,
        version: this.readback.state.version,
        state: this.readback.state.state,
        closedBy,
        ...(this.latestExport ? { exportDir: this.latestExport.exportDir } : {}),
      });
    });
  }
}

export async function createCanvasTuiSurface(options: CanvasTuiSurfaceOptions): Promise<CanvasTuiSurface> {
  const readback = await options.runtime.read(options.artifactId);
  if (!readback) {
    throw new Error(`Canvas artifact not found: ${options.artifactId}`);
  }
  if (readback.source.view !== undefined && readback.source.view.kind !== "pi-tui-component") {
    throw new Error(`Canvas view requires an adjacent host: ${readback.source.view.kind}`);
  }
  return new CanvasTuiSurface(options, readback);
}

export function renderCanvasTerminal(readback: CanvasReadback, options: CanvasTerminalRenderOptions = {}): string[] {
  const width = normalizeRenderWidth(options.width);
  const bodyLines = [
    `pi-canvas: ${readback.source.title}`,
    `${readback.source.artifactId}  v${readback.state.version}`,
    ruleLine(width),
    "",
    ...renderCanvasContent(readback.state.state, width),
  ];
  if (options.includeControls) {
    bodyLines.push("", `action: ${readback.source.actions[0]?.label ?? "Set value"} (+/space/enter)`, "export: press e", "close: q or escape");
  }
  if (options.extraLines && options.extraLines.length > 0) {
    bodyLines.push("", ...options.extraLines);
  }
  return bodyLines.map((line) => fitLine(line, width));
}

function renderCanvasContent(value: JsonValue, width: number): string[] {
  if (isJsonRecord(value)) return renderRecordCanvas(value, width);
  if (Array.isArray(value)) return renderItemsSection(value, width);
  return [formatScalar(value)];
}

function renderRecordCanvas(value: { [key: string]: JsonValue }, width: number): string[] {
  const lines: string[] = [];
  const consumed = new Set<string>();
  const message = readRecordString(value, "message") ?? readRecordString(value, "title") ?? readRecordString(value, "name");
  if (message) {
    lines.push(message);
    consumed.add("message");
    consumed.add("title");
    consumed.add("name");
  }
  const createdAt = readRecordString(value, "createdAt");
  if (createdAt) {
    lines.push(`Created ${createdAt}`);
    consumed.add("createdAt");
  }
  const items = value.items;
  if (items !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(...renderItemsSection(Array.isArray(items) ? items : [items], width));
    consumed.add("items");
  }
  const detailLines = Object.entries(value)
    .filter(([key]) => !consumed.has(key))
    .flatMap(([key, child]) => renderDetailLine(humanizeField(key), child, 1));
  if (detailLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Details");
    lines.push(...detailLines);
  }
  if (lines.length === 0) return ["Empty canvas"];
  return lines;
}

function renderItemsSection(items: JsonValue[], width: number): string[] {
  if (items.length === 0) return ["Items", ...renderEmptyCanvasArea(width)];
  return ["Items", ...items.flatMap((item, index) => renderItem(item, index))];
}

function renderEmptyCanvasArea(width: number): string[] {
  const innerWidth = Math.max(18, Math.min(72, width - 6));
  const border = `  +${"-".repeat(innerWidth)}+`;
  const blank = `  |${" ".repeat(innerWidth)}|`;
  const label = "No items yet";
  const left = Math.max(0, Math.floor((innerWidth - label.length) / 2));
  const right = Math.max(0, innerWidth - label.length - left);
  return [border, blank, `  |${" ".repeat(left)}${label}${" ".repeat(right)}|`, blank, border];
}

function renderItem(item: JsonValue, index: number): string[] {
  const label = `${index + 1}.`;
  if (!isJsonRecord(item)) return [`  ${label} ${formatScalarOrSummary(item)}`];
  const title = readRecordString(item, "title") ?? readRecordString(item, "name") ?? readRecordString(item, "label") ?? `Item ${index + 1}`;
  const consumed = new Set(["title", "name", "label"]);
  const lines = [`  ${label} ${title}`];
  for (const [key, value] of Object.entries(item)) {
    if (!consumed.has(key)) {
      lines.push(...renderDetailLine(humanizeField(key), value, 3));
    }
  }
  return lines;
}

function renderDetailLine(label: string, value: JsonValue, indent: number): string[] {
  const prefix = " ".repeat(indent * 2);
  if (isJsonRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${prefix}${label}: empty`];
    return [`${prefix}${label}`, ...entries.flatMap(([key, child]) => renderDetailLine(humanizeField(key), child, indent + 1))];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}${label}: none`];
    return [`${prefix}${label}`, ...value.flatMap((item, index) => renderDetailLine(`${index + 1}`, item, indent + 1))];
  }
  return [`${prefix}${label}: ${formatScalar(value)}`];
}

function formatScalarOrSummary(value: JsonValue): string {
  if (isJsonRecord(value)) return "object";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return formatScalar(value);
}

function formatScalar(value: JsonValue): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized || "(empty string)";
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "null";
}

function isJsonRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fitLine(line: string, width: number): string {
  const maxWidth = Math.max(1, width);
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth, maxWidth <= 3 ? ".".repeat(maxWidth) : "...");
}

function normalizeRenderWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return 80;
  return Math.min(140, Math.max(32, Math.floor(width)));
}

function ruleLine(width: number): string {
  return "-".repeat(Math.max(12, width));
}

function readRecordString(value: { [key: string]: JsonValue }, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function humanizeField(field: string): string {
  return field
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (first) => first.toUpperCase());
}

function displayKey(data: string): string {
  if (data === " ") return "space";
  if (data === "\r" || data === "\n") return "enter";
  return data;
}
