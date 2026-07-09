import type { DistillSettings, ValidationResult } from "./types.js";

const REFUSAL_PATTERNS = [
  /please provide/i,
  /cannot summarize/i,
  /can't summarize/i,
  /wish summarized/i,
  /provided command output/i,
  /as an ai/i,
];

export function validateSummary(rawText: string, summary: string, settings: DistillSettings): ValidationResult {
  const trimmed = summary.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty summary" };
  }
  if (Buffer.byteLength(trimmed, "utf-8") > settings.maxSummaryChars) {
    return { ok: false, reason: "summary exceeds configured max chars" };
  }
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: "summary looks like a refusal or meta-response" };
    }
  }
  const rawBytes = Buffer.byteLength(rawText, "utf-8");
  const summaryBytes = Buffer.byteLength(trimmed, "utf-8");
  if (rawBytes > 0 && summaryBytes >= rawBytes * settings.maxSummaryRatio) {
    return { ok: false, reason: "summary is too large relative to source" };
  }
  if (!hasRequiredCardSections(trimmed)) {
    return { ok: false, reason: "summary is missing required card sections" };
  }
  return { ok: true };
}

export function hasRequiredCardSections(summary: string): boolean {
  return hasSection(summary, "Outcome") && hasSection(summary, "Verbatim evidence") && hasSection(summary, "Omitted") && hasSection(summary, "Uncertainty");
}

function hasSection(summary: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n)#{1,3}\\s*${escaped}\\b|(^|\\n)${escaped}:`, "i");
  return pattern.test(summary);
}
