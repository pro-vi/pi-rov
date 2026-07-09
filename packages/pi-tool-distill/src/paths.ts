import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME } from "./constants.js";
import { sha256 } from "./artifacts.js";

export const SETTINGS_FILE_NAME = "pi-tool-distill.settings.json";
export const USAGE_VERSION_DIR = "v1";

export function getSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, SETTINGS_FILE_NAME);
}

export function getToolDistillRoot(agentDir = getAgentDir()): string {
  return join(agentDir, EXTENSION_NAME);
}

export function getUsageRoot(agentDir = getAgentDir()): string {
  return join(getToolDistillRoot(agentDir), "usage", USAGE_VERSION_DIR);
}

export function cwdHashForPath(cwd: string): string {
  return sha256(cwd).slice(0, 16);
}

export function isSafeCwdHash(value: string): boolean {
  return /^[a-f0-9]{16}$/.test(value);
}
