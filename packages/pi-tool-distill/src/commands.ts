import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_NAME, SETTINGS_ARGUMENT_OPTIONS, STATUS_KEY } from "./constants.js";
import { DEFAULT_DISTILL_SETTINGS, formatModelRef, formatSettings, loadSettings, parseModelRef, saveSettings } from "./config.js";
import { cwdHashForPath } from "./paths.js";
import { runUsageBackfill, type BackfillResult } from "./usage-backfill.js";
import { createUsageStore, type UsageQuery } from "./usage-store.js";
import type { DistillRuntime } from "./runtime.js";
import type { ActivationUsageEventV1, UsageStatsReportV1, UsageTotals } from "./usage.js";
import type { DistillMode, DistillSelfTestResult, DistillSettings, PolicyAction } from "./types.js";

export type RuntimeGetter = (ctx: ExtensionContext) => DistillRuntime;

export interface SettingsAccess {
  load(): Promise<DistillSettings>;
  save(settings: Partial<DistillSettings>): Promise<DistillSettings>;
}

export interface StatsAccess {
  summarize(query: UsageQuery): Promise<UsageStatsReportV1>;
  readActivations(): Promise<ActivationUsageEventV1[]>;
  backfill?(options: { dryRun: boolean; global: boolean; now?: () => number }): Promise<BackfillResult>;
}

const DEFAULT_SETTINGS_ACCESS: SettingsAccess = {
  load: () => loadSettings(),
  save: (settings) => saveSettings(settings),
};

function createDefaultStatsAccess(): StatsAccess {
  const store = createUsageStore();
  return {
    summarize: (query) => store.summarize(query),
    readActivations: () => store.readActivations(),
    backfill: (options) => runUsageBackfill({ dryRun: options.dryRun }),
  };
}

export function registerDistillCommand(
  pi: ExtensionAPI,
  getRuntime: RuntimeGetter,
  settingsAccess: SettingsAccess = DEFAULT_SETTINGS_ACCESS,
  statsAccess: StatsAccess = createDefaultStatsAccess(),
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure recoverable tool-result distillation",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const items = SETTINGS_ARGUMENT_OPTIONS.filter((option) => option.startsWith(normalized)).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      await handleDistillCommand(args, ctx, getRuntime(ctx), settingsAccess, statsAccess);
    },
  });
}

export async function handleDistillCommand(
  args: string,
  ctx: ExtensionCommandContext,
  runtime: DistillRuntime,
  settingsAccess: SettingsAccess = DEFAULT_SETTINGS_ACCESS,
  statsAccess: StatsAccess = createDefaultStatsAccess(),
): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "help") {
    notify(ctx, helpText());
    return;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  const value = rest.join(" ");

  switch (command) {
    case "status":
      await showStatus(ctx, runtime, settingsAccess);
      return;
    case "recent":
      await showRecent(ctx, runtime);
      return;
    case "mode": {
      const saved = await setMode(value, ctx, settingsAccess);
      if (saved) updateStatus(ctx, saved);
      return;
    }
    case "model": {
      const saved = await setModel(value, ctx, settingsAccess);
      if (saved) updateStatus(ctx, saved);
      return;
    }
    case "threshold":
      await setThreshold(value, ctx, settingsAccess);
      return;
    case "policy":
      await handlePolicy(value, ctx, settingsAccess);
      return;
    case "selftest":
      await runSelfTestCommand(ctx, runtime, settingsAccess);
      return;
    case "stats":
      await showStats(ctx, value, statsAccess);
      return;
    case "reset": {
      const saved = await settingsAccess.save(DEFAULT_DISTILL_SETTINGS);
      updateStatus(ctx, saved);
      notify(ctx, `Tool distill settings reset.\n\n${formatSettings(saved)}`);
      return;
    }
    default:
      notify(ctx, `Unknown /distill argument: ${args}\n\n${helpText()}`, "warning");
  }
}

export function updateStatus(ctx: ExtensionContext, settings: { mode: DistillMode }): void {
  ctx.ui.setStatus(STATUS_KEY, settings.mode === "off" ? undefined : ctx.ui.theme.fg("success", "distill"));
}

async function showStatus(ctx: ExtensionCommandContext, runtime: DistillRuntime, settingsAccess: SettingsAccess): Promise<void> {
  const settings = await settingsAccess.load();
  const metrics = runtime.metrics;
  const authLine = modelAuthLine(settings.model, ctx);
  const decision = metrics.lastDecision
    ? `last: ${metrics.lastDecision.action} ${metrics.lastDecision.toolName} (${metrics.lastDecision.reason})`
    : "last: none";
  notify(
    ctx,
    [
      formatSettings(settings),
      "",
      authLine,
      "",
      "Session metrics:",
      `  eligible: ${metrics.eligible}`,
      `  distilled: ${metrics.distilled}`,
      `  reduced: ${metrics.reduced}`,
      `  skipped: ${metrics.skipped}`,
      `  fallback: ${metrics.fallback}`,
      `  expanded: ${metrics.expanded}`,
      `  raw bytes: ${metrics.rawBytes}`,
      `  distilled bytes: ${metrics.distilledBytes}`,
      `  semantic model calls: ${metrics.semanticModelCalls}`,
      `  semantic cache: ${metrics.semanticCacheHits} hit / ${metrics.semanticCacheMisses} miss / ${metrics.semanticCacheStale} stale / ${metrics.semanticCacheInvalid} invalid / ${metrics.semanticCacheErrors} error`,
      `  usage record errors: ${runtime.usageRecordErrorCount()}`,
      `  ${decision}`,
    ].join("\n"),
  );
}

async function showRecent(ctx: ExtensionCommandContext, runtime: DistillRuntime): Promise<void> {
  const recent = await runtime.recent(10);
  if (recent.length === 0) {
    notify(ctx, "No tool-distill artifacts yet.");
    return;
  }
  const lines = recent.map((artifact) => {
    const ratio = artifact.compressionRatio === undefined ? "" : ` ratio=${Math.round(artifact.compressionRatio * 100)}%`;
    const reason = artifact.fallbackReason ? ` fallback=${artifact.fallbackReason}` : "";
    return `${artifact.id} ${artifact.status} ${artifact.toolName} raw=${artifact.rawBytes}B${ratio}${reason}`;
  });
  notify(ctx, `Recent tool-distill artifacts:\n${lines.join("\n")}`);
}

async function showStats(ctx: ExtensionCommandContext, value: string, statsAccess: StatsAccess): Promise<void> {
  const args = value.trim().split(/\s+/).filter(Boolean);
  if (args[0] === "backfill") {
    if (!statsAccess.backfill) {
      notify(ctx, "Tool distill stats backfill is not available in this runtime.", "warning");
      return;
    }
    const result = await statsAccess.backfill({ dryRun: args.includes("--dry-run"), global: args.includes("--global") });
    notify(ctx, formatBackfillResult(result));
    return;
  }

  const json = args.includes("--json");
  const scope: UsageQuery["scope"] = args.includes("--global") ? "global" : "project";
  const query: UsageQuery = {
    scope,
    includeBackfill: args.includes("--include-backfill"),
  };
  if (scope === "project") {
    query.cwdHash = cwdHashForPath(ctx.cwd);
  }
  const since = parseSinceArg(args, Date.now());
  if (since !== undefined) {
    query.since = since;
    query.periodKind = "since";
  }
  if (args.includes("--activation")) {
    const activation = activationWindow(await statsAccess.readActivations());
    if (activation) {
      query.since = activation.since;
      query.periodKind = "activation";
      if (activation.until !== undefined) query.until = activation.until;
      if (activation.partial !== undefined) query.periodPartial = activation.partial;
    }
  }
  const report = await statsAccess.summarize(query);
  notify(ctx, json ? `${JSON.stringify(report, null, 2)}\n` : formatStatsReport(report));
}

async function setMode(value: string, ctx: ExtensionCommandContext, settingsAccess: SettingsAccess): Promise<DistillSettings | undefined> {
  const mode = parseMode(value);
  if (!mode) {
    notify(ctx, "Usage: /distill mode off|auto|force", "warning");
    return undefined;
  }
  const settings = await settingsAccess.load();
  const saved = await settingsAccess.save({ ...settings, mode });
  notify(ctx, `Tool distill mode updated to ${saved.mode}.`);
  return saved;
}

async function setModel(value: string, ctx: ExtensionCommandContext, settingsAccess: SettingsAccess): Promise<DistillSettings | undefined> {
  const settings = await settingsAccess.load();
  if (!value.trim()) {
    return chooseModelFromMenu(ctx, settings, settingsAccess);
  }

  const modelRef = parseModelRef(value);
  if (!modelRef) {
    notify(ctx, "Could not parse model reference. Opening the distiller model menu instead.", "warning");
    return chooseModelFromMenu(ctx, settings, settingsAccess);
  }
  const model = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
  if (!model) {
    notify(ctx, `Model not found: ${formatModelRef(modelRef)}. Opening the distiller model menu instead.`, "warning");
    return chooseModelFromMenu(ctx, settings, settingsAccess);
  }
  const saved = await settingsAccess.save({ ...settings, model: modelRef });
  notify(ctx, `Tool distill model updated to ${formatModelRef(saved.model)}.`);
  return saved;
}

async function chooseModelFromMenu(
  ctx: ExtensionCommandContext,
  settings: DistillSettings,
  settingsAccess: SettingsAccess,
): Promise<DistillSettings | undefined> {
  if (!ctx.hasUI) {
    notify(ctx, "Open Pi interactively to choose from the model menu, or pass a model as provider/modelId.", "warning");
    return undefined;
  }

  const available = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
  if (available.length === 0) {
    notify(ctx, "No authenticated text models are available for tool distill. Use /login or pass provider/modelId after configuring auth.", "warning");
    return undefined;
  }

  const choices = available.map((model) => {
    const ref = `${model.provider}/${model.id}`;
    const current = settings.model?.provider === model.provider && settings.model.modelId === model.id ? " ✓" : "";
    return model.name && model.name !== model.id ? `${ref} — ${model.name}${current}` : `${ref}${current}`;
  });
  const selected = await ctx.ui.select("Choose tool-distill model", choices);
  if (!selected) {
    notify(ctx, "Tool distill model unchanged.");
    return undefined;
  }

  const selectedRef = parseModelRef(selected.split(" — ")[0]?.replace(/ ✓$/, "") ?? "");
  if (!selectedRef) {
    notify(ctx, "Selected model could not be parsed; model unchanged.", "warning");
    return undefined;
  }
  const saved = await settingsAccess.save({ ...settings, model: selectedRef });
  notify(ctx, `Tool distill model updated to ${formatModelRef(saved.model)}.`);
  return saved;
}

async function setThreshold(value: string, ctx: ExtensionCommandContext, settingsAccess: SettingsAccess): Promise<void> {
  const threshold = parsePositiveInteger(value);
  if (threshold === undefined) {
    notify(ctx, "Usage: /distill threshold <chars>", "warning");
    return;
  }
  const settings = await settingsAccess.load();
  const saved = await settingsAccess.save({ ...settings, thresholdChars: threshold });
  notify(ctx, `Tool distill threshold updated to ${saved.thresholdChars} chars.`);
}

async function handlePolicy(value: string, ctx: ExtensionCommandContext, settingsAccess: SettingsAccess): Promise<void> {
  const settings = await settingsAccess.load();
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts[0] === "list") {
    notify(ctx, formatPolicyList(settings.policies));
    return;
  }
  if (parts[0] !== "set" || parts.length !== 3) {
    notify(ctx, "Usage: /distill policy list | /distill policy set <tool> pass|semantic|deny", "warning");
    return;
  }
  const toolName = parts[1];
  const action = parsePolicyAction(parts[2]);
  if (!toolName || !action) {
    notify(ctx, "Usage: /distill policy set <tool> pass|semantic|deny", "warning");
    return;
  }
  const saved = await settingsAccess.save({
    ...settings,
    policies: { ...settings.policies, [toolName]: action },
  });
  notify(ctx, `Policy updated: ${toolName} -> ${saved.policies[toolName]}`);
}

async function runSelfTestCommand(ctx: ExtensionCommandContext, runtime: DistillRuntime, settingsAccess: SettingsAccess): Promise<void> {
  const settings = await settingsAccess.load();
  if (!settings.model) {
    notify(ctx, "Tool distill selftest requires a configured model. Use /distill model <provider>/<modelId> first.", "warning");
    return;
  }
  const resolved = ctx.modelRegistry.find(settings.model.provider, settings.model.modelId);
  if (!resolved) {
    notify(ctx, `Tool distill selftest cannot find configured model: ${formatModelRef(settings.model)}.`, "warning");
    return;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(resolved)) {
    notify(ctx, `Tool distill selftest auth is missing for ${formatModelRef(settings.model)}.`, "warning");
    return;
  }

  const result = await runtime.runSelfTest(ctx);
  notify(ctx, formatSelfTestResult(result), result.success ? "info" : "warning");
}

function formatStatsReport(report: UsageStatsReportV1): string {
  const scope = report.scope === "project" && report.cwdHash ? `project ${report.cwdHash}` : "global";
  const lines = [`Tool distill stats — ${scope}`, `schema: ${report.schema}`, "", "Tracked live totals:", ...formatTotals(report.tracked)];
  if (report.backfill) {
    lines.push("", "Historical backfill estimates:", ...formatTotals(report.backfill), "  historical expansions: unknown", "  historical distiller spend: unknown");
  }
  if (report.combined) {
    lines.push("", "Combined tracked + historical estimate:", ...formatTotals(report.combined));
  }
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:", ...report.warnings.map((warning) => `  ${warning}`));
  }
  if (report.tracked.records === 0 && !report.backfill) {
    lines.push("", "No durable tool-distill usage recorded yet.");
  }
  return lines.join("\n");
}

function formatTotals(totals: UsageTotals): string[] {
  return [
    `  records: ${totals.records}`,
    `  raw bytes: ${totals.rawBytes}`,
    `  visible bytes: ${totals.visibleBytes}`,
    `  main bytes delta: ${totals.mainBytesDelta}`,
    `  est main tokens delta: ${totals.estimatedMainTokensDelta}`,
    `  semantic model calls: ${totals.semanticModelCalls}`,
    `  semantic cache hits: ${totals.semanticCacheHits}`,
    `  reducer hits: ${totals.reducerHits}`,
    `  fallbacks: ${totals.fallbackCount}`,
    `  validation rejected: ${totals.validationRejectedCount}`,
    `  expansions: ${totals.expansionCount}`,
    `  exact distiller tokens: ${totals.distillerInputTokensExact + totals.distillerOutputTokensExact}`,
    `  estimated distiller tokens: ${totals.distillerTokensEstimated}`,
    `  exact distiller cost: ${totals.distillerCostUsdExact}`,
  ];
}

function formatBackfillResult(result: BackfillResult): string {
  const mode = result.dryRun ? "dry run" : "snapshot written";
  return [
    `Tool distill stats backfill ${mode}.`,
    `  scanned cwd hashes: ${result.scannedCwdHashes}`,
    `  scanned artifacts: ${result.scannedArtifacts}`,
    `  records: ${result.records}`,
    `  skipped: ${result.skipped}`,
    ...(result.snapshotId ? [`  snapshot: ${result.snapshotId}`] : []),
    ...(result.warnings.length > 0 ? ["Warnings:", ...result.warnings.map((warning) => `  ${warning}`)] : []),
  ].join("\n");
}

function parseSinceArg(args: string[], now: number): number | undefined {
  const index = args.indexOf("--since");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    return undefined;
  }
  const match = /^(\d+)(d|h|m)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2];
  const multiplier = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
  return now - amount * multiplier;
}

function activationWindow(events: ActivationUsageEventV1[]): { since: number; until?: number; partial?: boolean } | undefined {
  const ordered = [...events].sort((left, right) => right.at - left.at);
  const newest = ordered[0];
  if (!newest) {
    return undefined;
  }
  if (newest.event === "started" || newest.event === "inferred-started") {
    return activationWindowFromStart(newest);
  }
  const start = ordered.find((event) => event.at <= newest.at && (event.event === "started" || event.event === "inferred-started"));
  if (!start) {
    return undefined;
  }
  return { ...activationWindowFromStart(start), until: newest.at };
}

function activationWindowFromStart(event: ActivationUsageEventV1): { since: number; partial?: boolean } {
  return event.partial === true ? { since: event.at, partial: true } : { since: event.at };
}

function modelAuthLine(model: { provider: string; modelId: string } | undefined, ctx: ExtensionCommandContext): string {
  if (!model) {
    return "Distiller auth: no model configured";
  }
  const resolved = ctx.modelRegistry.find(model.provider, model.modelId);
  if (!resolved) {
    return `Distiller auth: model not found (${formatModelRef(model)})`;
  }
  return ctx.modelRegistry.hasConfiguredAuth(resolved)
    ? `Distiller auth: configured (${formatModelRef(model)})`
    : `Distiller auth: missing (${formatModelRef(model)})`;
}

function formatSelfTestResult(result: DistillSelfTestResult): string {
  const lines = [result.success ? "Tool distill selftest PASS." : "Tool distill selftest FAIL."];
  if (result.model) lines.push(`  model: ${formatModelRef(result.model)}`);
  if (result.artifactId) lines.push(`  artifact: ${result.artifactId}`);
  if (result.rawBytes !== undefined) lines.push(`  raw bytes: ${result.rawBytes}`);
  if (result.rawLines !== undefined) lines.push(`  raw lines: ${result.rawLines}`);
  lines.push(`  expansion tail verified: ${result.expandedTailVerified ? "yes" : "no"}`);
  if (result.reason) lines.push(`  reason: ${result.reason}`);
  return lines.join("\n");
}

function formatPolicyList(policies: Record<string, PolicyAction>): string {
  const lines = Object.entries(policies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolName, action]) => `${toolName}: ${action}`);
  return lines.length > 0 ? `Tool distill policies:\n${lines.join("\n")}` : "No tool distill policies configured.";
}

function parseMode(value: string): DistillMode | undefined {
  return value === "off" || value === "auto" || value === "force" ? value : undefined;
}

function parsePolicyAction(value: string | undefined): PolicyAction | undefined {
  return value === "pass" || value === "semantic" || value === "deny" ? value : undefined;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function helpText(): string {
  return [
    "Tool distill compresses large tool results into recoverable observation cards.",
    "Commands:",
    "/distill status                       Show settings, auth, and session metrics.",
    "/distill mode off|auto|force          Enable/disable distillation.",
    "/distill model                         Choose the distiller model from a menu.",
    "/distill model <provider>/<modelId>    Set the distiller model directly, e.g. openai-codex/gpt-5.3-spark.",
    "/distill threshold <chars>            Set the auto-mode minimum text size.",
    "/distill policy list                  List per-tool policies.",
    "/distill policy set <tool> <action>   action = pass, semantic, or deny.",
    "/distill recent                       Show recent raw artifacts.",
    "/distill selftest                     Run a live model/auth/recovery self-test with the configured distiller.",
    "/distill stats [--project|--global]    Show durable usage and savings stats.",
    "/distill stats --json                 Show versioned machine-readable stats.",
    "/distill stats backfill [--dry-run]   Estimate historical stats from existing metadata.",
    "Model tool: distill_expand({ id, mode, maxChars }) retrieves saved raw output.",
  ].join("\n");
}

function notify(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  console.log(text);
}
