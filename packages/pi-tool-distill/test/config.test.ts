import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_DISTILL_SETTINGS, formatSettings, loadSettings, normalizeSettings, parseModelRef, saveSettings } from "../src/config.js";
import { getSettingsPath, getUsageRoot } from "../src/paths.js";
import { ensureTrackingInfo } from "../src/usage-store.js";

void test("normalizeSettings fills invalid values with defaults", () => {
  const normalized = normalizeSettings({
    mode: "broken",
    thresholdChars: 1,
    maxSummaryChars: 999999999,
    maxExpandChars: "large",
    maxModelTokens: 1,
    maxSummaryRatio: 2,
    model: { provider: "openai-codex", modelId: "gpt-5.3-spark" },
    policies: { read: "semantic", bad: "broken", "bad key": "pass" },
  });

  assert.equal(normalized.mode, DEFAULT_DISTILL_SETTINGS.mode);
  assert.equal(normalized.thresholdChars, DEFAULT_DISTILL_SETTINGS.thresholdChars);
  assert.equal(normalized.maxSummaryChars, DEFAULT_DISTILL_SETTINGS.maxSummaryChars);
  assert.equal(normalized.maxExpandChars, DEFAULT_DISTILL_SETTINGS.maxExpandChars);
  assert.equal(normalized.maxModelTokens, DEFAULT_DISTILL_SETTINGS.maxModelTokens);
  assert.equal(normalized.maxSummaryRatio, DEFAULT_DISTILL_SETTINGS.maxSummaryRatio);
  assert.deepEqual(normalized.model, { provider: "openai-codex", modelId: "gpt-5.3-spark" });
  assert.equal(normalized.policies.read, "semantic");
  assert.equal(normalized.policies["bad key"], undefined);
});

void test("parseModelRef accepts provider/modelId and rejects malformed strings", () => {
  assert.deepEqual(parseModelRef("openai-codex/gpt-5.3-spark"), {
    provider: "openai-codex",
    modelId: "gpt-5.3-spark",
  });
  assert.equal(parseModelRef("missing-slash"), undefined);
  assert.equal(parseModelRef("/missing-provider"), undefined);
  assert.equal(parseModelRef("missing-model/"), undefined);
  assert.equal(parseModelRef("bad provider/model"), undefined);
});

void test("loadSettings returns defaults when file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-config-"));
  const path = join(dir, "settings.json");
  const settings = await loadSettings(path);
  assert.deepEqual(settings, DEFAULT_DISTILL_SETTINGS);
  await rm(dir, { recursive: true, force: true });
});

void test("loadSettings returns defaults when settings JSON is malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-config-"));
  const path = join(dir, "settings.json");
  await writeFile(path, "{not valid json", "utf-8");

  const settings = await loadSettings(path);
  assert.deepEqual(settings, DEFAULT_DISTILL_SETTINGS);

  await rm(dir, { recursive: true, force: true });
});

void test("default settings path honors PI_CODING_AGENT_DIR at call time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-agent-dir-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const saved = await saveSettings({ ...DEFAULT_DISTILL_SETTINGS, mode: "auto" });
    assert.equal(saved.mode, "auto");
    const raw = await readFile(getSettingsPath(dir), "utf-8");
    assert.match(raw, /"mode": "auto"/);
    const loaded = await loadSettings();
    assert.equal(loaded.mode, "auto");
  } finally {
    if (original === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = original;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

void test("saveSettings records activation transitions at the save chokepoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-activation-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await saveSettings({ ...DEFAULT_DISTILL_SETTINGS, mode: "auto" });
    await saveSettings({ ...DEFAULT_DISTILL_SETTINGS, mode: "auto", thresholdChars: 20_000 });
    await saveSettings({ ...DEFAULT_DISTILL_SETTINGS, mode: "off" });
    const { createUsageStore } = await import("../src/usage-store.js");
    const events = await createUsageStore({ usageRoot: getUsageRoot(dir) }).readActivations();

    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "started");
    assert.equal(events[1]?.event, "stopped");
  } finally {
    if (original === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = original;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

void test("tracking watermark is created once under concurrent initialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-tracking-"));
  const usageRoot = getUsageRoot(dir);
  const first = await Promise.all([ensureTrackingInfo(usageRoot, () => 111), ensureTrackingInfo(usageRoot, () => 222)]);
  const second = await ensureTrackingInfo(usageRoot, () => 333);

  assert.equal(first[0].trackingStartedAt, first[1].trackingStartedAt);
  assert.equal(second.trackingStartedAt, first[0].trackingStartedAt);

  await rm(dir, { recursive: true, force: true });
});

void test("saveSettings writes normalized settings that loadSettings can read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-config-"));
  const path = join(dir, "settings.json");

  const saved = await saveSettings(
    {
      ...DEFAULT_DISTILL_SETTINGS,
      mode: "auto",
      thresholdChars: 20_000,
      model: { provider: "openai-codex", modelId: "gpt-5.3-spark" },
      policies: { ...DEFAULT_DISTILL_SETTINGS.policies, bash: "semantic" },
    },
    path,
  );

  const loaded = await loadSettings(path);
  assert.deepEqual(loaded, saved);
  const raw = await readFile(path, "utf-8");
  assert.match(raw, /"mode": "auto"/);
  assert.match(formatSettings(loaded), /Model: openai-codex\/gpt-5\.3-spark/);

  await rm(dir, { recursive: true, force: true });
});
