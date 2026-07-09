import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolDistillExtension from "../src/index.js";
import { COMMAND_NAME, EXPAND_TOOL_NAME } from "../src/constants.js";

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
  events: string[];
  tools: string[];
  commands: string[];
  handlers: Map<string, CapturedHandler[]>;
}

const LOADED_KEY = Symbol.for("pi-tool-distill.loaded");

type TestGlobalState = typeof globalThis & {
  [LOADED_KEY]?: true;
};

function createCapturedExtension(): CapturedExtension {
  return { events: [], tools: [], commands: [], handlers: new Map() };
}

function resetLoadedMarker(): void {
  delete (globalThis as TestGlobalState)[LOADED_KEY];
}

async function runSessionShutdown(captured: CapturedExtension): Promise<void> {
  for (const handler of captured.handlers.get("session_shutdown") ?? []) {
    await handler();
  }
}

function createMockPi(captured: CapturedExtension): ExtensionAPI {
  const on = ((event: string, handler?: CapturedHandler) => {
    captured.events.push(event);
    if (handler) {
      const handlers = captured.handlers.get(event) ?? [];
      handlers.push(handler);
      captured.handlers.set(event, handlers);
    }
  }) as ExtensionAPI["on"];

  const mock: ExtensionAPI = {
    on,
    registerTool(tool) {
      captured.tools.push(tool.name);
    },
    registerCommand(name) {
      captured.commands.push(name);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    events: createEventBus(),
  };
  return mock;
}

void test("extension registers tool_result hook, distill command, and expand tool", async () => {
  resetLoadedMarker();
  const captured = createCapturedExtension();
  toolDistillExtension(createMockPi(captured));

  assert.ok(captured.events.includes("tool_result"));
  assert.ok(captured.events.includes("session_start"));
  assert.equal(captured.events.includes("context"), false);
  assert.ok(captured.tools.includes(EXPAND_TOOL_NAME));
  assert.ok(captured.commands.includes(COMMAND_NAME));

  await runSessionShutdown(captured);
});

void test("extension no-ops when another tool-distill copy is already loaded", async () => {
  resetLoadedMarker();
  const first = createCapturedExtension();
  toolDistillExtension(createMockPi(first));

  const second = createCapturedExtension();
  toolDistillExtension(createMockPi(second));

  assert.equal(second.events.length, 0);
  assert.equal(second.tools.length, 0);
  assert.equal(second.commands.length, 0);

  await runSessionShutdown(first);

  const afterShutdown = createCapturedExtension();
  toolDistillExtension(createMockPi(afterShutdown));
  assert.ok(afterShutdown.commands.includes(COMMAND_NAME));

  await runSessionShutdown(afterShutdown);
});
