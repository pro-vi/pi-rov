import { Text, type Component } from "@earendil-works/pi-tui";
import type { CanvasExportResult, CanvasPiTuiViewDefinition, CanvasReadback, JsonValue } from "./types.js";
import { DEFAULT_CANVAS_RENDERER_ID, DEFAULT_CANVAS_RENDERER_VERSION } from "./types.js";

export interface CanvasPreviewContext {
  readback: CanvasReadback;
  view: CanvasPiTuiViewDefinition;
  extraLines?: string[];
}

export interface CanvasSurfaceContext extends CanvasPreviewContext {
  update(path: string, value: JsonValue, actor: string, input: string): void;
  export(): void;
  close(closedBy: "escape" | "quit"): void;
  getLatestExport(): CanvasExportResult | undefined;
  getLatestError(): string | undefined;
}

export interface CanvasRenderer {
  id: string;
  version: number;
  label: string;
  defaultActions?: Array<{ type: "set"; path: string; label: string }>;
  createPreview(ctx: CanvasPreviewContext): Component;
  createSurface?(ctx: CanvasSurfaceContext): Component;
}

export class CanvasRendererRegistry {
  private readonly renderers = new Map<string, CanvasRenderer>();

  register(renderer: CanvasRenderer): void {
    const existing = this.renderers.get(renderer.id);
    if (existing) {
      throw new Error(`Canvas renderer already registered: ${renderer.id}`);
    }
    this.renderers.set(renderer.id, renderer);
  }

  get(rendererId: string, rendererVersion?: number): CanvasRenderer | undefined {
    const renderer = this.renderers.get(rendererId);
    if (!renderer) return undefined;
    if (rendererVersion !== undefined && renderer.version !== rendererVersion) return undefined;
    return renderer;
  }

  require(rendererId: string, rendererVersion?: number): CanvasRenderer {
    const renderer = this.get(rendererId, rendererVersion);
    if (!renderer) {
      const versionSuffix = rendererVersion === undefined ? "" : ` v${rendererVersion}`;
      throw new Error(`Canvas renderer not found: ${rendererId}${versionSuffix}`);
    }
    return renderer;
  }

  list(): CanvasRenderer[] {
    return [...this.renderers.values()];
  }
}

export function resolveCanvasViewDefinition(readback: CanvasReadback): CanvasPiTuiViewDefinition {
  return readback.source.view?.kind === "pi-tui-component" ? readback.source.view : {
    kind: "pi-tui-component",
    rendererId: DEFAULT_CANVAS_RENDERER_ID,
    rendererVersion: DEFAULT_CANVAS_RENDERER_VERSION,
  };
}

export function createCanvasPreviewComponent(readback: CanvasReadback, registry: CanvasRendererRegistry, options: { extraLines?: string[] } = {}): Component {
  if (readback.source.view !== undefined && readback.source.view.kind !== "pi-tui-component") {
    return new UnsupportedCanvasViewComponent(readback, readback.source.view.kind, options.extraLines);
  }
  const view = resolveCanvasViewDefinition(readback);
  const renderer = registry.get(view.rendererId, view.rendererVersion);
  if (!renderer) return new MissingCanvasRendererComponent(readback, view, options.extraLines);
  return renderer.createPreview({ readback, view, ...(options.extraLines === undefined ? {} : { extraLines: options.extraLines }) });
}

export class CanvasTextComponent implements Component {
  private readonly text: Text;

  constructor(content: string) {
    this.text = new Text(content, 0, 0);
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }
}

class UnsupportedCanvasViewComponent implements Component {
  private readonly text: Text;

  constructor(readback: CanvasReadback, viewKind: string, extraLines: string[] | undefined) {
    this.text = new Text(
      [
        `pi-canvas: ${readback.source.title}`,
        `${readback.source.artifactId}  v${readback.state.version}`,
        "",
        `Canvas view requires an adjacent host: ${viewKind}`,
        ...(extraLines === undefined || extraLines.length === 0 ? [] : ["", ...extraLines]),
      ].join("\n"),
      0,
      0,
    );
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }
}

class MissingCanvasRendererComponent implements Component {
  private readonly text: Text;

  constructor(readback: CanvasReadback, view: CanvasPiTuiViewDefinition, extraLines: string[] | undefined) {
    this.text = new Text(
      [
        `pi-canvas: ${readback.source.title}`,
        `${readback.source.artifactId}  v${readback.state.version}`,
        "",
        `Canvas renderer not found: ${view.rendererId} v${view.rendererVersion}`,
        ...(extraLines === undefined || extraLines.length === 0 ? [] : ["", ...extraLines]),
      ].join("\n"),
      0,
      0,
    );
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }
}
