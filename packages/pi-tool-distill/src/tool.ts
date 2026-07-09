import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DEFAULT_MAX_EXPAND_CHARS, EXPAND_TOOL_NAME, MAX_MAX_CHARS, MIN_MAX_CHARS } from "./constants.js";
import { renderExpandResultText } from "./render.js";
import type { DistillRuntime } from "./runtime.js";
import type { DistillDetails, ExpandMode } from "./types.js";

const ExpandParams = Type.Object({
  id: Type.String({ description: "Tool-distill artifact id returned in an observation card" }),
  mode: Type.Optional(
    StringEnum(["summary", "raw", "head", "tail"] as const, {
      description: "What to retrieve. summary returns the card summary when available; raw/head/tail retrieve raw output.",
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      minimum: MIN_MAX_CHARS,
      maximum: MAX_MAX_CHARS,
      description: "Maximum raw characters to return for raw/head/tail modes.",
    }),
  ),
});

type ExpandParamsType = Static<typeof ExpandParams>;
export type RuntimeGetter = (ctx: ExtensionContext) => DistillRuntime;
export type ExpandFeedback = (ctx: ExtensionContext) => void;

export function registerExpandTool(pi: ExtensionAPI, getRuntime: RuntimeGetter, feedback?: ExpandFeedback): void {
  pi.registerTool({
    name: EXPAND_TOOL_NAME,
    label: "Distill Expand",
    description:
      "Retrieve raw output saved by tool-distill. Use when a distilled observation card may have omitted details needed for correctness.",
    promptSnippet: "Retrieve raw output behind a tool-distill observation card",
    promptGuidelines: [
      "Use distill_expand when a tool-distill card says raw output may contain details needed for an edit, exact diagnosis, or citation.",
    ],
    parameters: ExpandParams,
    async execute(_toolCallId, params: ExpandParamsType, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const settings = await runtime.loadSettings();
      const mode: ExpandMode = params.mode ?? "raw";
      const maxChars = clampMaxChars(params.maxChars ?? settings.maxExpandChars);
      const expanded = await runtime.expandArtifact({ id: params.id, mode, maxChars }, { ctx });
      if (expanded.isError !== true) {
        feedback?.(ctx);
      }
      return {
        content: [{ type: "text", text: expanded.text }],
        details: expanded.details,
      };
    },
    renderCall(args, theme) {
      return renderExpandResultText(
        {
          artifactId: args.id,
          status: "raw",
          rawPath: "",
          rawHash: "",
          rawBytes: 0,
          rawLines: 0,
          toolName: EXPAND_TOOL_NAME,
        },
        false,
        `distill_expand ${args.id}`,
        themeColors(theme),
      );
    },
    renderResult(result, { expanded }, theme) {
      const content = result.content.find((part) => part.type === "text");
      const text = content?.type === "text" ? content.text : "";
      return renderExpandResultText(readDistillDetails(result.details), expanded, text, themeColors(theme));
    },
  });
}

function themeColors(theme: { fg(color: "success" | "muted" | "dim" | "warning", text: string): string }) {
  return {
    success: (text: string) => theme.fg("success", text),
    muted: (text: string) => theme.fg("muted", text),
    dim: (text: string) => theme.fg("dim", text),
    warning: (text: string) => theme.fg("warning", text),
  };
}

function clampMaxChars(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_EXPAND_CHARS;
  }
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.trunc(value)));
}

function readDistillDetails(value: unknown): DistillDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const artifactId = value.artifactId;
  const status = value.status;
  const rawPath = value.rawPath;
  const rawHash = value.rawHash;
  const rawBytes = value.rawBytes;
  const rawLines = value.rawLines;
  const toolName = value.toolName;
  if (
    typeof artifactId !== "string" ||
    (status !== "raw" && status !== "distilled" && status !== "fallback") ||
    typeof rawPath !== "string" ||
    typeof rawHash !== "string" ||
    typeof rawBytes !== "number" ||
    typeof rawLines !== "number" ||
    typeof toolName !== "string"
  ) {
    return undefined;
  }
  const details: DistillDetails = { artifactId, status, rawPath, rawHash, rawBytes, rawLines, toolName };
  if (typeof value.compressionRatio === "number") details.compressionRatio = value.compressionRatio;
  if (typeof value.fallbackReason === "string") details.fallbackReason = value.fallbackReason;
  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
