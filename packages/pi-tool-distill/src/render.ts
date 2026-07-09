import { Text } from "@earendil-works/pi-tui";
import type { DistillDetails } from "./types.js";

export interface RenderColors {
  success(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  warning(text: string): string;
}

export function renderExpandResultText(details: DistillDetails | undefined, expanded: boolean, contentText: string, colors: RenderColors): Text {
  if (!details) {
    return new Text(colors.dim(expanded ? contentText : "tool-distill artifact"), 0, 0);
  }

  let text = colors.success(`tool-distill ${details.status}`);
  text += colors.muted(` ${details.artifactId} ${details.toolName}`);
  if (details.compressionRatio !== undefined) {
    text += colors.dim(` ratio=${Math.round(details.compressionRatio * 100)}%`);
  }
  if (details.fallbackReason) {
    text += colors.warning(` fallback=${details.fallbackReason}`);
  }
  if (expanded) {
    text += `\n${colors.dim(`raw: ${details.rawPath}`)}`;
    text += `\n\n${contentText}`;
  }
  return new Text(text, 0, 0);
}
