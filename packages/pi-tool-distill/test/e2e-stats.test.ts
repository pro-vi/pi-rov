import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cwdHashForPath, getSettingsPath, getUsageRoot } from "../src/paths.js";
import { makeSemanticUsageDelta } from "../src/usage.js";
import { createUsageStore } from "../src/usage-store.js";

void test("Pi CLI e2e stats smoke uses isolated agent dir and durable side files", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-distill-e2e-agent-"));
  const realSettingsPath = join(homedir(), ".pi", "agent", "pi-tool-distill.settings.json");
  const before = await statOrUndefined(realSettingsPath);
  try {
    runPi(agentDir, "/distill mode auto");
    const settingsRaw = await readFile(getSettingsPath(agentDir), "utf-8");
    const settingsParsed: unknown = JSON.parse(settingsRaw);
    assert.ok(isRecord(settingsParsed));
    assert.equal(settingsParsed.mode, "auto");

    const usageStore = createUsageStore({ usageRoot: getUsageRoot(agentDir) });
    await usageStore.append(
      makeSemanticUsageDelta({
        at: 123,
        sessionKey: "e2e-session",
        cwdHash: cwdHashForPath("/tmp/tool-distill-e2e"),
        artifactId: "0123456789abcdef0123",
        rawBytes: 10_000,
        visibleBytes: 1_000,
      }),
    );

    runPi(agentDir, "/distill stats --json --global");
    runPi(agentDir, "/distill status");

    const report = await usageStore.summarize({ scope: "global" });
    assert.equal(report.tracked.records, 1);
    assert.equal(report.tracked.mainBytesDelta, 9_000);
    const usageText = await readTreeText(getUsageRoot(agentDir));
    assert.equal(usageText.includes("inputPreview"), false);
    assert.equal(usageText.includes("summary"), false);
    assert.equal(usageText.includes("/tmp/tool-distill-e2e"), false);

    const after = await statOrUndefined(realSettingsPath);
    assert.equal(after?.mtimeMs, before?.mtimeMs);
    assert.equal(after?.size, before?.size);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

function runPi(agentDir: string, prompt: string): void {
  const result = spawnSync(
    "pi",
    ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", "./src/index.ts", "-p", prompt],
    {
      cwd: process.cwd(),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `pi failed for ${prompt}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

async function statOrUndefined(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function readTreeText(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readTreeText(child));
    } else if (entry.isFile()) {
      chunks.push(await readFile(child, "utf-8"));
    }
  }
  return chunks.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
