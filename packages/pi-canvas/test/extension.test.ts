import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCanvasExtension from "../src/index.js";
import { CANVAS_COMMAND } from "../src/commands.js";

interface CapturedExtension {
  events: string[];
  tools: string[];
  commands: string[];
}

function createMockPi(captured: CapturedExtension): ExtensionAPI {
  const mock: Partial<ExtensionAPI> = {
    on(event: string) {
      captured.events.push(event);
    },
    registerTool(tool: { name: string }) {
      captured.tools.push(tool.name);
    },
    registerCommand(name: string) {
      captured.commands.push(name);
    },
  };
  return mock as ExtensionAPI;
}

void test("extension registers session hook, canvas command, and canvas tools", () => {
  const captured: CapturedExtension = { events: [], tools: [], commands: [] };
  piCanvasExtension(createMockPi(captured));

  assert.ok(captured.events.includes("session_start"));
  assert.ok(captured.commands.includes(CANVAS_COMMAND));
  assert.deepEqual(
    captured.tools.sort(),
    ["canvas_browser_artifacts", "canvas_create", "canvas_export", "canvas_present", "canvas_read", "canvas_render", "canvas_update"].sort(),
  );
});
