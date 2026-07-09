import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CanvasRendererRegistry, type CanvasRenderer, type CanvasSurfaceContext } from "./canvas-renderer.js";
import { renderCanvasTerminal } from "./surface.js";
import type { CanvasActionDefinition, JsonValue } from "./types.js";

const JSON_CARD_ACTIONS: CanvasActionDefinition[] = [{ type: "set", path: "value", label: "Set value" }];
const COUNTER_ACTIONS: CanvasActionDefinition[] = [{ type: "set", path: "count", label: "Increment count" }];

export function createDefaultCanvasRendererRegistry(): CanvasRendererRegistry {
  const registry = new CanvasRendererRegistry();
  for (const renderer of createBuiltinCanvasRenderers()) {
    registry.register(renderer);
  }
  return registry;
}

export function createBuiltinCanvasRenderers(): CanvasRenderer[] {
  return [jsonCardRenderer, counterRenderer];
}

const jsonCardRenderer: CanvasRenderer = {
  id: "builtin.json-card",
  version: 1,
  label: "JSON Card",
  defaultActions: JSON_CARD_ACTIONS,
  createPreview({ readback, extraLines }) {
    return new JsonCardComponent((width) => renderCanvasTerminal(readback, { width, ...(extraLines === undefined ? {} : { extraLines }) }));
  },
  createSurface(ctx) {
    return new JsonCardSurfaceComponent(ctx);
  },
};

const counterRenderer: CanvasRenderer = {
  id: "builtin.counter",
  version: 1,
  label: "Counter",
  defaultActions: COUNTER_ACTIONS,
  createPreview({ readback, extraLines }) {
    return new CounterComponent(() => appendExtraLines(renderCounterLines(readback.state.state, readback.source.title, readback.source.artifactId, readback.state.version), extraLines));
  },
  createSurface(ctx) {
    return new CounterSurfaceComponent(ctx);
  },
};

class JsonCardComponent implements Component {
  private readonly text = new Text("", 0, 0);

  constructor(private readonly lines: (width: number) => string[]) {}

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    this.text.setText(this.lines(width).join("\n"));
    return this.text.render(width);
  }
}

class JsonCardSurfaceComponent implements Component {
  private readonly text = new Text("", 0, 0);

  constructor(private readonly ctx: CanvasSurfaceContext) {}

  handleInput(data: string): void {
    handleDefaultSurfaceInput(this.ctx, data);
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    this.text.setText(renderCanvasTerminal(this.ctx.readback, { width, includeControls: true, extraLines: surfaceStatusLines(this.ctx) }).join("\n"));
    return this.text.render(width);
  }
}

class CounterComponent implements Component {
  private readonly text = new Text("", 0, 0);

  constructor(private readonly lines: (width: number) => string[]) {}

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    this.text.setText(this.lines(width).map((line) => fitLine(line, width)).join("\n"));
    return this.text.render(width);
  }
}

class CounterSurfaceComponent implements Component {
  private readonly text = new Text("", 0, 0);

  constructor(private readonly ctx: CanvasSurfaceContext) {}

  handleInput(data: string): void {
    if (isQuitKey(data)) {
      this.ctx.close(data === "\x1b" ? "escape" : "quit");
      return;
    }
    if (isExportKey(data)) {
      this.ctx.export();
      return;
    }
    if (!isPrimaryActionKey(data)) return;
    const action = this.ctx.readback.source.actions[0] ?? COUNTER_ACTIONS[0];
    if (!action) return;
    const nextValue = deriveNextActionValue(this.ctx.readback.state.state, action.path);
    this.ctx.update(action.path, nextValue, "tui-user", data);
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    this.text.setText(
      [
        ...renderCounterLines(this.ctx.readback.state.state, this.ctx.readback.source.title, this.ctx.readback.source.artifactId, this.ctx.readback.state.version),
        "",
        `action: ${this.ctx.readback.source.actions[0]?.label ?? "Increment count"} (+/space/enter)`,
        "export: press e",
        "close: q or escape",
        ...surfaceStatusLines(this.ctx),
      ]
        .map((line) => fitLine(line, width))
        .join("\n"),
    );
    return this.text.render(width);
  }
}

function handleDefaultSurfaceInput(ctx: CanvasSurfaceContext, data: string): void {
  if (isQuitKey(data)) {
    ctx.close(data === "\x1b" ? "escape" : "quit");
    return;
  }
  if (isExportKey(data)) {
    ctx.export();
    return;
  }
  if (!isPrimaryActionKey(data)) return;
  const action = ctx.readback.source.actions[0] ?? JSON_CARD_ACTIONS[0];
  if (!action) return;
  const nextValue = deriveNextActionValue(ctx.readback.state.state, action.path);
  ctx.update(action.path, nextValue, "tui-user", data);
}

function renderCounterLines(state: JsonValue, title: string, artifactId: string, version: number): string[] {
  const count = readJsonPath(state, "count");
  const countText = typeof count === "number" ? String(count) : "0";
  return [`pi-canvas: ${title}`, `${artifactId}  v${version}`, "", `Count: ${countText}`];
}

function appendExtraLines(lines: string[], extraLines: string[] | undefined): string[] {
  if (extraLines === undefined || extraLines.length === 0) return lines;
  return [...lines, "", ...extraLines];
}

function surfaceStatusLines(ctx: CanvasSurfaceContext): string[] {
  const lines: string[] = [];
  const latestExport = ctx.getLatestExport();
  if (latestExport) lines.push("", `exported: ${latestExport.exportDir}`);
  const latestError = ctx.getLatestError();
  if (latestError) lines.push("", `error: ${latestError}`);
  return lines;
}

function isPrimaryActionKey(data: string): boolean {
  return data === "+" || data === "=" || data === " " || data === "\r" || data === "\n";
}

function isExportKey(data: string): boolean {
  return data.toLowerCase() === "e";
}

function isQuitKey(data: string): boolean {
  return data.toLowerCase() === "q" || data === "\x1b";
}

function deriveNextActionValue(state: JsonValue, path: string): JsonValue {
  const current = readJsonPath(state, path);
  if (typeof current === "number") return current + 1;
  if (typeof current === "boolean") return !current;
  if (typeof current === "string") return `${current} updated`;
  if (current === null) return true;
  return 1;
}

function readJsonPath(value: JsonValue, path: string): JsonValue | undefined {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  let current: JsonValue | undefined = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      current = isArrayIndex(part) ? current[Number(part)] : undefined;
    } else if (isJsonRecord(current)) {
      current = current[part];
    } else {
      current = undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function isJsonRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayIndex(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

function fitLine(line: string, width: number): string {
  const maxWidth = Math.max(1, width);
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth, maxWidth <= 3 ? ".".repeat(maxWidth) : "...");
}
