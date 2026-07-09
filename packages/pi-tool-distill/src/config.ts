import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_MAX_EXPAND_CHARS,
  DEFAULT_MAX_MODEL_TOKENS,
  DEFAULT_MAX_SUMMARY_CHARS,
  DEFAULT_MAX_SUMMARY_RATIO,
  DEFAULT_THRESHOLD_CHARS,
  HARD_PASS_TOOLS,
  MAX_MAX_CHARS,
  MAX_MODEL_TOKENS,
  MAX_THRESHOLD_CHARS,
  MIN_MAX_CHARS,
  MIN_MODEL_TOKENS,
  MIN_THRESHOLD_CHARS,
} from "./constants.js";
import { getSettingsPath } from "./paths.js";
import { recordActivationTransition } from "./usage-store.js";
import type { DistillMode, DistillSettings, ModelRef, PolicyAction } from "./types.js";

export const DEFAULT_DISTILL_SETTINGS: DistillSettings = {
  mode: "off",
  thresholdChars: DEFAULT_THRESHOLD_CHARS,
  maxSummaryChars: DEFAULT_MAX_SUMMARY_CHARS,
  maxExpandChars: DEFAULT_MAX_EXPAND_CHARS,
  maxModelTokens: DEFAULT_MAX_MODEL_TOKENS,
  maxSummaryRatio: DEFAULT_MAX_SUMMARY_RATIO,
  policies: Object.fromEntries([...HARD_PASS_TOOLS].map((toolName) => [toolName, "pass"])),
};

export async function loadSettings(path = getSettingsPath()): Promise<DistillSettings> {
  try {
    const raw = await readFile(path, "utf-8");
    try {
      const parsed: unknown = JSON.parse(raw);
      return normalizeSettings(parsed);
    } catch {
      return { ...DEFAULT_DISTILL_SETTINGS, policies: { ...DEFAULT_DISTILL_SETTINGS.policies } };
    }
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { ...DEFAULT_DISTILL_SETTINGS, policies: { ...DEFAULT_DISTILL_SETTINGS.policies } };
    }
    throw error;
  }
}

export async function saveSettings(settings: Partial<DistillSettings>, path = getSettingsPath()): Promise<DistillSettings> {
  const normalized = normalizeSettings(settings);
  const shouldRecordActivation = path === getSettingsPath();
  const previous = shouldRecordActivation ? await loadSettings(path) : undefined;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  if (previous) {
    try {
      await recordActivationTransition({ previousMode: previous.mode, nextMode: normalized.mode });
    } catch {
      // Settings are authoritative; a stats activation write must not make /distill mode/reset fail.
    }
  }
  return normalized;
}

export function normalizeSettings(value: unknown): DistillSettings {
  const record = isRecord(value) ? value : {};
  const defaults = DEFAULT_DISTILL_SETTINGS;
  const model = normalizeModelRef(record.model);
  const normalized: DistillSettings = {
    mode: normalizeMode(record.mode, defaults.mode),
    thresholdChars: integerInRange(record.thresholdChars, MIN_THRESHOLD_CHARS, MAX_THRESHOLD_CHARS, defaults.thresholdChars),
    maxSummaryChars: integerInRange(record.maxSummaryChars, MIN_MAX_CHARS, MAX_MAX_CHARS, defaults.maxSummaryChars),
    maxExpandChars: integerInRange(record.maxExpandChars, MIN_MAX_CHARS, MAX_MAX_CHARS, defaults.maxExpandChars),
    maxModelTokens: integerInRange(record.maxModelTokens, MIN_MODEL_TOKENS, MAX_MODEL_TOKENS, defaults.maxModelTokens),
    maxSummaryRatio: numberInRange(record.maxSummaryRatio, 0.05, 1, defaults.maxSummaryRatio),
    policies: normalizePolicies(record.policies, defaults.policies),
  };
  if (model) {
    normalized.model = model;
  }
  return normalized;
}

export function parseModelRef(input: string): ModelRef | undefined {
  const trimmed = input.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!provider || !modelId || provider.includes(" ") || modelId.includes(" ")) {
    return undefined;
  }
  return { provider, modelId };
}

export function formatModelRef(model: ModelRef | undefined): string {
  return model ? `${model.provider}/${model.modelId}` : "none";
}

export function formatSettings(settings: DistillSettings): string {
  const policyLines = Object.entries(settings.policies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tool, action]) => `  ${tool}: ${action}`);

  return [
    "Tool distill settings:",
    `  Mode: ${settings.mode}`,
    `  Model: ${formatModelRef(settings.model)}`,
    `  Threshold: ${settings.thresholdChars} chars`,
    `  Max summary: ${settings.maxSummaryChars} chars`,
    `  Max expand: ${settings.maxExpandChars} chars`,
    `  Max model tokens: ${settings.maxModelTokens}`,
    `  Max summary ratio: ${settings.maxSummaryRatio}`,
    "Policies:",
    ...(policyLines.length > 0 ? policyLines : ["  none"]),
  ].join("\n");
}

function normalizeModelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = value.provider;
  const modelId = value.modelId;
  if (typeof provider !== "string" || typeof modelId !== "string") {
    return undefined;
  }
  const parsed = parseModelRef(`${provider}/${modelId}`);
  return parsed;
}

function normalizePolicies(value: unknown, fallback: Record<string, PolicyAction>): Record<string, PolicyAction> {
  const result: Record<string, PolicyAction> = { ...fallback };
  if (!isRecord(value)) {
    return result;
  }
  for (const [toolName, action] of Object.entries(value)) {
    if (isPolicyAction(action) && isSafeToolPolicyKey(toolName)) {
      result[toolName] = action;
    }
  }
  return result;
}

function normalizeMode(value: unknown, fallback: DistillMode): DistillMode {
  return value === "off" || value === "auto" || value === "force" ? value : fallback;
}

function isPolicyAction(value: unknown): value is PolicyAction {
  return value === "pass" || value === "semantic" || value === "deny";
}

function isSafeToolPolicyKey(value: string): boolean {
  return value.length > 0 && value.length <= 80 && /^[a-zA-Z0-9_.:-]+$/.test(value);
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) {
    return fallback;
  }
  return rounded;
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < min || value > max) {
    return fallback;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
