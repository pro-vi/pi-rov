import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createArtifactStore } from "./artifacts.js";
import { registerDistillCommand, updateStatus } from "./commands.js";
import { loadSettings } from "./config.js";
import { DistillRuntime } from "./runtime.js";
import { createSummaryCache } from "./summary-cache.js";
import { registerExpandTool } from "./tool.js";
import { feedbackFromDistillPatch, setDistillFeedbackStatus } from "./ui-status.js";
import { createUsageRecorder, createUsageStore, ensureInferredActivation } from "./usage-store.js";

const TOOL_DISTILL_LOADED_KEY = Symbol.for("pi-tool-distill.loaded");

type ToolDistillGlobalState = typeof globalThis & {
  [TOOL_DISTILL_LOADED_KEY]?: true;
};

function getGlobalState(): ToolDistillGlobalState {
  return globalThis as ToolDistillGlobalState;
}

export default function toolDistillExtension(pi: ExtensionAPI): void {
  const globalState = getGlobalState();
  if (globalState[TOOL_DISTILL_LOADED_KEY]) {
    return;
  }
  globalState[TOOL_DISTILL_LOADED_KEY] = true;

  let runtime: DistillRuntime | undefined;
  let runtimeCwd: string | undefined;
  const usageStore = createUsageStore();
  const usageRecorder = createUsageRecorder(usageStore);

  const getRuntime = (ctx: ExtensionContext): DistillRuntime => {
    if (!runtime || runtimeCwd !== ctx.cwd) {
      runtimeCwd = ctx.cwd;
      runtime = new DistillRuntime({
        store: createArtifactStore(ctx.cwd),
        summaryCache: createSummaryCache(ctx.cwd),
        loadSettings,
        usageRecorder,
      });
    }
    return runtime;
  };

  pi.on("session_start", async (_event, ctx) => {
    getRuntime(ctx);
    const settings = await loadSettings();
    await ensureInferredActivation({ mode: settings.mode });
    updateStatus(ctx, settings);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx, await loadSettings());
  });

  pi.on("tool_result", async (event, ctx) => {
    const patch = await getRuntime(ctx).processToolResult(event, ctx);
    const feedback = patch ? feedbackFromDistillPatch(patch) : undefined;
    if (feedback) {
      setDistillFeedbackStatus(ctx, feedback);
    }
    return patch;
  });

  pi.on("session_shutdown", async () => {
    try {
      await usageRecorder.flush();
    } finally {
      delete globalState[TOOL_DISTILL_LOADED_KEY];
    }
  });

  pi.on("agent_end", async () => {
    await usageRecorder.flush();
  });

  registerDistillCommand(pi, getRuntime);
  registerExpandTool(pi, getRuntime, (ctx) => setDistillFeedbackStatus(ctx, { kind: "expand" }));
}
