import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolResultContent, DistillDetails, ExtractedToolText, ObservationArtifact, ExpandMode } from "./types.js";

export function extractToolText(content: ToolResultContent[]): ExtractedToolText {
  const textParts: string[] = [];
  let hasImages = false;

  for (const part of content) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else if (part.type === "image") {
      hasImages = true;
    }
  }

  const text = textParts.join("\n");
  return {
    text,
    textBytes: Buffer.byteLength(text, "utf-8"),
    lineCount: text.length === 0 ? 0 : text.split("\n").length,
    hasImages,
    textBlockCount: textParts.length,
  };
}

export function appendFallbackNotice(content: ToolResultContent[], notice: string): TextContent[] {
  const text = extractToolText(content).text;
  const combined = text.trim().length > 0 ? `${text}\n\n[tool-distill fallback: ${notice}]` : `[tool-distill fallback: ${notice}]`;
  return [{ type: "text", text: combined }];
}

export function buildObservationCard(artifact: ObservationArtifact, summary: string): string {
  const ratio = artifact.compressionRatio === undefined ? "unknown" : `${Math.round(artifact.compressionRatio * 100)}%`;
  const model = artifact.model ? `${artifact.model.provider}/${artifact.model.modelId}` : "unknown";
  const kind = artifact.status === "reduced" ? "reduced" : "distilled";
  const lines = [
    `[tool-distill: ${kind} ${artifact.toolName} result]`,
    `raw: ${artifact.id}`,
    `rawPath: ${artifact.rawPath}`,
  ];
  if (artifact.method === "reducer") {
    lines.push(`reducer: ${artifact.summarySource?.reducerId ?? "unknown"}`);
    if (artifact.summarySource?.previousArtifactId) {
      lines.push(`previous: ${artifact.summarySource.previousArtifactId}`);
    }
  } else {
    lines.push(`model: ${model}`);
    if (artifact.method === "semantic-cache" && artifact.summarySource?.sourceArtifactId) {
      lines.push(`summary reused from: ${artifact.summarySource.sourceArtifactId}`);
    }
  }
  lines.push(
    `compression: ${artifact.rawBytes} bytes -> ${artifact.summaryBytes ?? Buffer.byteLength(summary, "utf-8")} bytes (${ratio})`,
    "",
    summary.trim(),
    "",
    `To inspect raw output, call distill_expand with id \"${artifact.id}\".`,
  );
  return lines.join("\n");
}

export function buildFallbackCard(artifact: ObservationArtifact, reason: string): string {
  return [
    `[tool-distill fallback for ${artifact.toolName}]`,
    `reason: ${reason}`,
    `raw: ${artifact.id}`,
    `rawPath: ${artifact.rawPath}`,
    "",
    "The original tool result was preserved in this message because distillation was not trusted.",
    `To inspect saved raw output later, call distill_expand with id \"${artifact.id}\".`,
  ].join("\n");
}

export function buildDistillDetails(artifact: ObservationArtifact): DistillDetails {
  const details: DistillDetails = {
    artifactId: artifact.id,
    status: artifact.status,
    rawPath: artifact.rawPath,
    rawHash: artifact.rawHash,
    rawBytes: artifact.rawBytes,
    rawLines: artifact.rawLines,
    toolName: artifact.toolName,
  };
  if (artifact.model) details.model = artifact.model;
  if (artifact.method) details.method = artifact.method;
  if (artifact.compressionRatio !== undefined) details.compressionRatio = artifact.compressionRatio;
  if (artifact.summarySource) details.summarySource = artifact.summarySource;
  if (artifact.fallbackReason) details.fallbackReason = artifact.fallbackReason;
  return details;
}

export function selectRawText(rawText: string, mode: ExpandMode, maxChars: number, summary?: string): string {
  if (mode === "summary") {
    return summary ?? "No summary stored for this artifact.";
  }
  if (rawText.length <= maxChars) {
    return rawText;
  }
  if (mode === "tail") {
    return `[tail: showing last ${maxChars} of ${rawText.length} chars]\n${rawText.slice(rawText.length - maxChars)}`;
  }
  if (mode === "head") {
    return `${rawText.slice(0, maxChars)}\n[head: showing first ${maxChars} of ${rawText.length} chars]`;
  }
  return `${rawText.slice(0, maxChars)}\n[raw truncated by distill_expand: showing first ${maxChars} of ${rawText.length} chars]`;
}

export function looksLikeDiff(toolName: string, input: Record<string, unknown>, text: string): boolean {
  const command = typeof input.command === "string" ? input.command : "";
  if (/\bgit\s+diff\b/.test(command) || /\bdiff\b/.test(command)) {
    return true;
  }
  if (toolName === "edit" || toolName === "write") {
    return true;
  }
  const sample = text.slice(0, 4_000);
  return /(^|\n)diff --git /.test(sample) || /(^|\n)@@ -\d+,?\d* \+\d+,?\d* @@/.test(sample);
}

export function previewInput(input: Record<string, unknown>, maxChars = 500): string {
  const serialized = JSON.stringify(input);
  if (serialized.length <= maxChars) {
    return serialized;
  }
  return `${serialized.slice(0, maxChars)}…`;
}
