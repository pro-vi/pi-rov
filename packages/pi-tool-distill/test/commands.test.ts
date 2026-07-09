import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, ModelRegistry, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createArtifactStore } from "../src/artifacts.js";
import { handleDistillCommand, type SettingsAccess, type StatsAccess } from "../src/commands.js";
import { DEFAULT_DISTILL_SETTINGS, normalizeSettings } from "../src/config.js";
import { DistillRuntime } from "../src/runtime.js";
import type { ActivationUsageEventV1, UsageStatsReportV1 } from "../src/usage.js";
import type { UsageQuery } from "../src/usage-store.js";
import type { ArtifactStore, DistillSettings, ObservationArtifact } from "../src/types.js";

const validSummary = [
  "## Outcome",
  "Selftest completed.",
  "## Verbatim evidence",
  "src/selftest.ts:42 simulated failure line",
  "## Omitted",
  "Repeated synthetic log lines.",
  "## Uncertainty",
  "No uncertainty.",
].join("\n");

const TEST_MODEL_REF = { provider: "test-distill", modelId: "spark" };

interface Notification {
  text: string;
  type: "info" | "warning" | "error";
}

interface CapturedCommandContext {
  ctx: ExtensionCommandContext;
  notifications: Notification[];
  statuses: Array<{ key: string; value: string | undefined }>;
  selects: Array<{ title: string; options: string[] }>;
}

interface CapturedSettingsAccess {
  access: SettingsAccess;
  current(): DistillSettings;
  saves: DistillSettings[];
}

void test("mode command saves injected settings and updates status", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("mode auto", captured.ctx, runtime, settings.access);

  assert.equal(settings.current().mode, "auto");
  assert.match(lastNotification(captured).text, /mode updated to auto/);
  assert.deepEqual(captured.statuses.at(-1), { key: "tool-distill", value: "distill" });
});

void test("threshold and policy commands mutate only injected settings", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("threshold 20000", captured.ctx, runtime, settings.access);
  await handleDistillCommand("policy set bash semantic", captured.ctx, runtime, settings.access);

  assert.equal(settings.current().thresholdChars, 20_000);
  assert.equal(settings.current().policies.bash, "semantic");
  assert.match(lastNotification(captured).text, /Policy updated: bash -> semantic/);
});

void test("malformed threshold reports warning and does not save", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("threshold nope", captured.ctx, runtime, settings.access);

  assert.equal(settings.saves.length, 0);
  assert.equal(lastNotification(captured).type, "warning");
  assert.match(lastNotification(captured).text, /Usage: \/distill threshold/);
});

void test("model command with no argument opens selector and saves selected model", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("model", captured.ctx, runtime, settings.access);

  assert.equal(captured.selects[0]?.title, "Choose tool-distill model");
  assert.equal(settings.current().model?.provider, TEST_MODEL_REF.provider);
  assert.equal(settings.current().model?.modelId, TEST_MODEL_REF.modelId);
  assert.match(lastNotification(captured).text, /model updated to test-distill\/spark/);
});

void test("model command rejects unknown models without mutating settings", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext({ modelFound: false });
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("model test-distill/spark", captured.ctx, runtime, settings.access);

  assert.equal(settings.current().model, undefined);
  assert.equal(captured.notifications[0]?.type, "warning");
  assert.match(captured.notifications[0]?.text ?? "", /Model not found/);
});

void test("status reports configured and missing auth lines from fake registry", async () => {
  const settings = createSettingsAccess({ model: TEST_MODEL_REF });
  const configured = createCommandContext({ authConfigured: true });
  const missing = createCommandContext({ authConfigured: false });
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("status", configured.ctx, runtime, settings.access);
  await handleDistillCommand("status", missing.ctx, runtime, settings.access);

  assert.match(configured.notifications[0]?.text ?? "", /Distiller auth: configured/);
  assert.match(configured.notifications[0]?.text ?? "", /semantic model calls:/);
  assert.match(configured.notifications[0]?.text ?? "", /semantic cache: 0 hit \/ 0 miss \/ 0 stale \/ 0 invalid \/ 0 error/);
  assert.match(configured.notifications[0]?.text ?? "", /usage record errors: 0/);
  assert.match(missing.notifications[0]?.text ?? "", /Distiller auth: missing/);
});

void test("stats command renders project scoped durable totals", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);
  const stats = createStatsAccess({
    tracked: {
      records: 1,
      rawBytes: 2000,
      visibleBytes: 500,
      mainBytesDelta: 1500,
      estimatedMainTokensDelta: 375,
      semanticModelCalls: 1,
      semanticCacheHits: 0,
      reducerHits: 0,
      fallbackCount: 0,
      validationRejectedCount: 0,
      expansionCount: 0,
      distillerInputTokensExact: 10,
      distillerOutputTokensExact: 5,
      distillerTokensEstimated: 0,
      distillerCostUsdExact: 0,
    },
  });

  await handleDistillCommand("stats", captured.ctx, runtime, settings.access, stats);

  assert.equal(stats.queries[0]?.scope, "project");
  assert.match(lastNotification(captured).text, /Tool distill stats/);
  assert.match(lastNotification(captured).text, /main bytes delta: 1500/);
});

void test("stats --json emits versioned parseable JSON", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);
  const stats = createStatsAccess();

  await handleDistillCommand("stats --json --global", captured.ctx, runtime, settings.access, stats);

  const parsed: unknown = JSON.parse(lastNotification(captured).text);
  assert.ok(isRecord(parsed));
  assert.equal(parsed.schema, "tool-distill.stats.v1");
  assert.equal(stats.queries[0]?.scope, "global");
  assert.equal(lastNotification(captured).text.includes("inputPreview"), false);
});

void test("stats --activation uses the latest closed activation window", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);
  const stats = createStatsAccess({}, [
    { schema: "tool-distill.activation.v1", event: "started", at: 100, mode: "auto", activationId: "activation-start" },
    { schema: "tool-distill.activation.v1", event: "stopped", at: 200, mode: "off", activationId: "activation-stop" },
  ]);

  await handleDistillCommand("stats --activation", captured.ctx, runtime, settings.access, stats);

  assert.equal(stats.queries[0]?.since, 100);
  assert.equal(stats.queries[0]?.until, 200);
  assert.equal(stats.queries[0]?.periodKind, "activation");
});

void test("stats --activation marks inferred windows partial", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);
  const stats = createStatsAccess({}, [
    { schema: "tool-distill.activation.v1", event: "inferred-started", at: 100, mode: "auto", activationId: "activation-inferred", partial: true },
  ]);

  await handleDistillCommand("stats --activation", captured.ctx, runtime, settings.access, stats);

  assert.equal(stats.queries[0]?.periodPartial, true);
});

void test("stats backfill delegates to stats access", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);
  const stats = createStatsAccess();

  await handleDistillCommand("stats backfill --dry-run", captured.ctx, runtime, settings.access, stats);

  assert.equal(stats.backfills.length, 1);
  assert.equal(stats.backfills[0]?.dryRun, true);
  assert.match(lastNotification(captured).text, /backfill dry run/);
});

void test("selftest without a configured model warns before runtime work", async () => {
  const settings = createSettingsAccess();
  const captured = createCommandContext();
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("selftest", captured.ctx, runtime, settings.access);

  assert.equal(runtime.metrics.eligible, 0);
  assert.equal(lastNotification(captured).type, "warning");
  assert.match(lastNotification(captured).text, /requires a configured model/);
});

void test("selftest with missing auth warns before runtime work", async () => {
  const settings = createSettingsAccess({ model: TEST_MODEL_REF });
  const captured = createCommandContext({ authConfigured: false });
  const runtime = createRuntime(settings.access);

  await handleDistillCommand("selftest", captured.ctx, runtime, settings.access);

  assert.equal(runtime.metrics.eligible, 0);
  assert.equal(lastNotification(captured).type, "warning");
  assert.match(lastNotification(captured).text, /auth is missing/);
});

void test("selftest success reports artifact id and recovery proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-commands-"));
  const settings = createSettingsAccess({ model: TEST_MODEL_REF });
  const captured = createCommandContext({ authConfigured: true });
  const runtime = createRuntime(settings.access, createArtifactStore("/tmp/project", { baseDir: dir }), async () => validSummary);

  await handleDistillCommand("selftest", captured.ctx, runtime, settings.access);

  assert.equal(lastNotification(captured).type, "info");
  assert.match(lastNotification(captured).text, /selftest PASS/);
  assert.match(lastNotification(captured).text, /artifact: [a-f0-9]{20}/);
  assert.match(lastNotification(captured).text, /expansion tail verified: yes/);
  assert.equal(settings.saves.length, 0);

  await rm(dir, { recursive: true, force: true });
});

void test("selftest runtime failure reports failure reason with raw artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-distill-commands-"));
  const settings = createSettingsAccess({ model: TEST_MODEL_REF });
  const captured = createCommandContext({ authConfigured: true });
  const runtime = createRuntime(settings.access, createArtifactStore("/tmp/project", { baseDir: dir }), async () => {
    throw new Error("live auth failed");
  });

  await handleDistillCommand("selftest", captured.ctx, runtime, settings.access);

  assert.equal(lastNotification(captured).type, "warning");
  assert.match(lastNotification(captured).text, /selftest FAIL/);
  assert.match(lastNotification(captured).text, /live auth failed/);
  assert.match(lastNotification(captured).text, /artifact: [a-f0-9]{20}/);

  await rm(dir, { recursive: true, force: true });
});

function createStatsAccess(
  overrides: Partial<UsageStatsReportV1> = {},
  activations: ActivationUsageEventV1[] = [],
): StatsAccess & { queries: UsageQuery[]; backfills: Array<{ dryRun: boolean; global: boolean }> } {
  const queries: UsageQuery[] = [];
  const backfills: Array<{ dryRun: boolean; global: boolean }> = [];
  const report: UsageStatsReportV1 = {
    schema: "tool-distill.stats.v1",
    generatedAt: 123,
    scope: "project",
    period: { kind: "all" },
    tracked: emptyTotals(),
    warnings: [],
    ...overrides,
  };
  return {
    queries,
    backfills,
    async summarize(query) {
      queries.push({ ...query });
      const next: UsageStatsReportV1 = { ...report, scope: query.scope };
      if (query.cwdHash !== undefined) {
        next.cwdHash = query.cwdHash;
      }
      return next;
    },
    async readActivations() {
      return activations;
    },
    async backfill(options) {
      backfills.push({ dryRun: options.dryRun, global: options.global });
      return { dryRun: options.dryRun, scannedCwdHashes: 0, scannedArtifacts: 0, records: 0, skipped: 0, warnings: [] };
    },
  };
}

function emptyTotals(): UsageStatsReportV1["tracked"] {
  return {
    records: 0,
    rawBytes: 0,
    visibleBytes: 0,
    mainBytesDelta: 0,
    estimatedMainTokensDelta: 0,
    semanticModelCalls: 0,
    semanticCacheHits: 0,
    reducerHits: 0,
    fallbackCount: 0,
    validationRejectedCount: 0,
    expansionCount: 0,
    distillerInputTokensExact: 0,
    distillerOutputTokensExact: 0,
    distillerTokensEstimated: 0,
    distillerCostUsdExact: 0,
  };
}

function createSettingsAccess(overrides: Partial<DistillSettings> = {}): CapturedSettingsAccess {
  let current = normalizeSettings({ ...DEFAULT_DISTILL_SETTINGS, ...overrides });
  const saves: DistillSettings[] = [];
  return {
    access: {
      async load() {
        return current;
      },
      async save(settings: Partial<DistillSettings>) {
        current = normalizeSettings(settings);
        saves.push(current);
        return current;
      },
    },
    current: () => current,
    saves,
  };
}

function createRuntime(
  settingsAccess: SettingsAccess,
  store: ArtifactStore = memoryStore(),
  invokeModel: asyncModel = async () => validSummary,
): DistillRuntime {
  return new DistillRuntime({
    store,
    loadSettings: settingsAccess.load,
    invokeModel,
    now: () => 123,
  });
}

type asyncModel = () => Promise<string>;

function memoryStore(): ArtifactStore {
  return {
    async writeRaw(): Promise<ObservationArtifact> {
      throw new Error("memory store should not write raw in this test");
    },
    async update(artifact: ObservationArtifact): Promise<ObservationArtifact> {
      return artifact;
    },
    async read() {
      return undefined;
    },
    async listRecent() {
      return [];
    },
  };
}

function createCommandContext(options: { modelFound?: boolean; authConfigured?: boolean; selectedModelIndex?: number } = {}): CapturedCommandContext {
  const notifications: Notification[] = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const modelFound = options.modelFound ?? true;
  const authConfigured = options.authConfigured ?? true;
  const ui: ExtensionCommandContext["ui"] = {
    select: async (title: string, modelOptions: string[]) => {
      selects.push({ title, options: modelOptions });
      return modelOptions[options.selectedModelIndex ?? 0];
    },
    notify: (text: string, type: "info" | "warning" | "error") => {
      notifications.push({ text, type });
    },
    setStatus: (key: string, value: string | undefined) => {
      statuses.push({ key, value });
    },
    theme: {
      fg: (_color: "success" | "muted" | "dim" | "warning", text: string) => text,
    },
  } as ExtensionCommandContext["ui"];
  const authStorage = AuthStorage.inMemory(
    authConfigured ? { [TEST_MODEL_REF.provider]: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 } } : {},
  );
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  if (modelFound) {
    modelRegistry.registerProvider(TEST_MODEL_REF.provider, {
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      oauth: {
        name: "Test Distill",
        login: async () => ({ refresh: "refresh", access: "access", expires: Date.now() + 60_000 }),
        refreshToken: async (credentials) => credentials,
        getApiKey: (credentials) => credentials.access,
      },
      models: [
        {
          id: TEST_MODEL_REF.modelId,
          name: "Test Distill Spark",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
      ],
    });
  }
  const ctx: ExtensionCommandContext = {
    hasUI: true,
    cwd: "/tmp/project",
    ui,
    sessionManager: {} as ExtensionCommandContext["sessionManager"],
    modelRegistry,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => undefined,
  };
  return { ctx, notifications, statuses, selects };
}

function lastNotification(captured: CapturedCommandContext): Notification {
  const notification = captured.notifications.at(-1);
  assert.ok(notification);
  return notification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
