import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDefaultCanvasRendererRegistry } from "./builtin-canvas-renderers.js";
import { registerCanvasCommand } from "./commands.js";
import { createRuntimeForContext, type PiCanvasRuntime } from "./runtime.js";
import { registerCanvasTools } from "./tools.js";

export default function piCanvasExtension(pi: ExtensionAPI): void {
  const rendererRegistry = createDefaultCanvasRendererRegistry();
  let runtime: PiCanvasRuntime | undefined;
  let runtimeCwd: string | undefined;

  const getRuntime = (ctx: ExtensionContext): PiCanvasRuntime => {
    if (!runtime || runtimeCwd !== ctx.cwd) {
      runtimeCwd = ctx.cwd;
      runtime = createRuntimeForContext(ctx);
    }
    return runtime;
  };

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("pi-canvas", ctx.ui.theme.fg("success", "canvas"));
    getRuntime(ctx);
  });

  registerCanvasCommand(pi, getRuntime, rendererRegistry);
  registerCanvasTools(pi, getRuntime, rendererRegistry);
}
