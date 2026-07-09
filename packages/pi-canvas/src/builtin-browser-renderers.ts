import { BrowserArtifactRendererRegistry, type BrowserArtifactRenderer } from "./browser-renderer.js";
import { cloneJson } from "./json.js";
import { canvasBrowserRenderer } from "./builtin-form-renderer.js";
import type { CanvasBrowserHostArtifactDefinition, JsonObject } from "./types.js";

// builtin.canvas is the sole actable browser-host substrate (ADR 0004). The
// former category renderers were special cases of this substrate wearing
// use-case costumes; they are now preset shorthands that assemble canvas widgets
// in tools.ts, not standalone renderers.

export function createDefaultBrowserArtifactRendererRegistry(): BrowserArtifactRendererRegistry {
  const registry = new BrowserArtifactRendererRegistry();
  for (const renderer of createBuiltinBrowserArtifactRenderers()) {
    registry.register(renderer);
  }
  return registry;
}

export function createBuiltinBrowserArtifactRenderers(): BrowserArtifactRenderer[] {
  return [canvasBrowserRenderer];
}

export function createBrowserHostArtifactView(renderer: BrowserArtifactRenderer, props: JsonObject = {}): CanvasBrowserHostArtifactDefinition {
  return {
    kind: "browser-host-artifact",
    bridgeVersion: 1,
    host: "local-browser-host",
    fallback: "terminal-render",
    transport: "http-json",
    rendererId: renderer.id,
    rendererVersion: renderer.version,
    ...(Object.keys(props).length === 0 ? {} : { props: cloneJson(props) }),
  };
}
