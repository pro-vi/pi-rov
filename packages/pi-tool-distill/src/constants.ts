export const EXTENSION_NAME = "tool-distill";
export const COMMAND_NAME = "distill";
export const EXPAND_TOOL_NAME = "distill_expand";
export const STATUS_KEY = "tool-distill";

export const DEFAULT_THRESHOLD_CHARS = 12_000;
export const DEFAULT_MAX_SUMMARY_CHARS = 4_000;
export const DEFAULT_MAX_EXPAND_CHARS = 20_000;
export const DEFAULT_MAX_MODEL_TOKENS = 2_500;
export const DEFAULT_MAX_SUMMARY_RATIO = 0.6;

export const MIN_THRESHOLD_CHARS = 500;
export const MAX_THRESHOLD_CHARS = 500_000;
export const MIN_MAX_CHARS = 500;
export const MAX_MAX_CHARS = 100_000;
export const MIN_MODEL_TOKENS = 256;
export const MAX_MODEL_TOKENS = 16_384;

export const DEFAULT_POLICY_ACTIONS = ["pass", "semantic", "deny"] as const;
export const DEFAULT_DISTILL_MODES = ["off", "auto", "force"] as const;
export const EXPAND_MODES = ["summary", "raw", "head", "tail"] as const;

export const HARD_PASS_TOOLS = new Set(["read", "edit", "write", EXPAND_TOOL_NAME]);
export const DEFAULT_SEMANTIC_TOOLS = new Set([
  "bash",
  "grep",
  "find",
  "ls",
  "web_search",
  "reddit_pack",
  "reddit_search",
  "reddit_thread",
  "reddit_trends",
]);

export const SETTINGS_ARGUMENT_OPTIONS = [
  "status",
  "help",
  "recent",
  "selftest",
  "stats",
  "stats --json",
  "stats --project",
  "stats --global",
  "stats --activation",
  "stats backfill --dry-run",
  "mode off",
  "mode auto",
  "mode force",
  "model",
  "threshold 12000",
  "policy list",
  "policy set bash semantic",
  "policy set read pass",
  "policy set web_search semantic",
  "reset",
] as const;
