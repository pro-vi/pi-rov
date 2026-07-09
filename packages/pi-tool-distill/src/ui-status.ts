import { STATUS_KEY } from "./constants.js";
import type { ArtifactStatus, DistillDetails, ObservationMethod, ToolResultContent } from "./types.js";

export type DistillFeedbackKind = "model" | "code" | "cache" | "fallback" | "expand";

export interface DistillFeedback {
  kind: DistillFeedbackKind;
  rawBytes?: number;
  visibleBytes?: number;
}

export interface DistillStatusContext {
  ui: {
    setStatus(key: string, text: string | undefined): void;
    theme: {
      fg(color: "success" | "accent" | "muted" | "dim" | "warning", text: string): string;
    };
  };
}

export function setDistillFeedbackStatus(ctx: DistillStatusContext, feedback: DistillFeedback): void {
  ctx.ui.setStatus(STATUS_KEY, formatDistillFeedback(ctx, feedback));
}

export function formatDistillFeedback(ctx: DistillStatusContext, feedback: DistillFeedback): string {
  const icon = feedbackIcon(ctx, feedback.kind);
  const tokenDelta = formatEstimatedTokenDelta(feedback.rawBytes, feedback.visibleBytes);
  const suffix = tokenDelta ?? (feedback.kind === "fallback" || feedback.kind === "expand" ? "raw" : undefined);
  const base = ctx.ui.theme.fg("success", "distill");
  return suffix ? `${base} ${icon} ${ctx.ui.theme.fg("dim", suffix)}` : `${base} ${icon}`;
}

export function feedbackFromDistillPatch(patch: { content?: ToolResultContent[]; details?: unknown }): DistillFeedback | undefined {
  const details = readDistillDetails(patch.details);
  if (!details) {
    return undefined;
  }
  const kind = feedbackKindForDetails(details);
  if (!kind) {
    return undefined;
  }
  return {
    kind,
    rawBytes: details.rawBytes,
    visibleBytes: contentBytes(patch.content ?? []),
  };
}

function feedbackKindForDetails(details: Pick<DistillDetails, "status" | "method">): DistillFeedbackKind | undefined {
  if (details.status === "fallback") {
    return "fallback";
  }
  if (details.method === "semantic") {
    return "model";
  }
  if (details.method === "semantic-cache") {
    return "cache";
  }
  if (details.method === "reducer") {
    return "code";
  }
  return undefined;
}

function feedbackIcon(ctx: DistillStatusContext, kind: DistillFeedbackKind): string {
  switch (kind) {
    case "model":
      return ctx.ui.theme.fg("accent", "◆");
    case "code":
      return ctx.ui.theme.fg("success", "◇");
    case "cache":
      return ctx.ui.theme.fg("muted", "↻");
    case "fallback":
      return ctx.ui.theme.fg("warning", "!");
    case "expand":
      return ctx.ui.theme.fg("accent", "↗");
  }
}

function formatEstimatedTokenDelta(rawBytes: number | undefined, visibleBytes: number | undefined): string | undefined {
  if (rawBytes === undefined || visibleBytes === undefined) {
    return undefined;
  }
  const estimatedTokens = Math.round((rawBytes - visibleBytes) / 4);
  if (estimatedTokens === 0) {
    return undefined;
  }
  return estimatedTokens > 0 ? `−${formatCompactNumber(estimatedTokens)}` : `+${formatCompactNumber(Math.abs(estimatedTokens))}`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${trimTrailingZero((value / 1_000_000).toFixed(1))}m`;
  }
  if (value >= 1_000) {
    return `${trimTrailingZero((value / 1_000).toFixed(1))}k`;
  }
  return String(value);
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function contentBytes(content: ToolResultContent[]): number {
  return content.reduce((total, part) => (part.type === "text" ? total + Buffer.byteLength(part.text, "utf-8") : total), 0);
}

function readDistillDetails(value: unknown): Pick<DistillDetails, "status" | "method" | "rawBytes"> | undefined {
  const record = isRecord(value) ? value : undefined;
  if (!record) {
    return undefined;
  }
  return readDistillDetailsRecord(record) ?? readDistillDetailsRecord(record.distill);
}

function readDistillDetailsRecord(value: unknown): Pick<DistillDetails, "status" | "method" | "rawBytes"> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = readStatus(value.status);
  const method = readMethod(value.method);
  const rawBytes = value.rawBytes;
  if (!status || typeof rawBytes !== "number" || !Number.isFinite(rawBytes)) {
    return undefined;
  }
  return method ? { status, method, rawBytes } : { status, rawBytes };
}

function readStatus(value: unknown): ArtifactStatus | undefined {
  return value === "raw" || value === "distilled" || value === "reduced" || value === "fallback" ? value : undefined;
}

function readMethod(value: unknown): ObservationMethod | undefined {
  return value === "semantic" || value === "semantic-cache" || value === "reducer" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
