import type { BrowserHostArtifactStateSummary, BrowserHostReadinessSummary, BrowserHostReviewAnnotationSummary } from "./browser-host-evidence.js";

export interface BrowserHostDisplaySummary {
  readiness?: BrowserHostReadinessSummary | undefined;
  artifactState?: BrowserHostArtifactStateSummary | undefined;
  reviewAnnotations?: BrowserHostReviewAnnotationSummary | undefined;
}

export function formatBrowserHostEvidenceLines(summary: BrowserHostDisplaySummary | undefined, options: { prefixBlankLine?: boolean } = {}): string[] {
  if (summary === undefined) return [];
  const lines = [
    ...formatBrowserArtifactStateLines(summary.artifactState),
    ...formatBrowserReviewAnnotationLines(summary.reviewAnnotations),
    ...formatBrowserHostReadinessLines(summary.readiness),
  ];
  if (lines.length === 0) return [];
  return options.prefixBlankLine === true ? ["", ...lines] : lines;
}

export function formatBrowserHostReadinessLines(readiness: BrowserHostReadinessSummary | undefined): string[] {
  if (readiness === undefined) return [];
  return [`Browser-host readiness: ${readiness.status} - ${readiness.reason}`, `Browser-host next action: ${readiness.nextAction}`];
}

export function formatBrowserArtifactStateLines(summary: BrowserHostArtifactStateSummary | undefined, options: { prefixBlankLine?: boolean } = {}): string[] {
  if (summary === undefined) return [];
  const lines = [`Browser artifact state: ${summary.status} - ${summary.summary}`];
  return options.prefixBlankLine === true ? ["", ...lines] : lines;
}

export function formatBrowserReviewAnnotationLines(summary: BrowserHostReviewAnnotationSummary | undefined, options: { prefixBlankLine?: boolean } = {}): string[] {
  if (summary === undefined) return [];
  const noteLabel = summary.total === 1 ? "note" : "notes";
  const targetLabel = summary.targetCount === 1 ? "target" : "targets";
  const lines = [`Review annotations: ${summary.total} ${noteLabel} across ${summary.targetCount} ${targetLabel}`];
  if (summary.targets.length > 0) {
    lines.push(`Review annotation targets: ${summary.targets.map((target) => `${target.targetKey} (${target.count})`).join(", ")}`);
  }
  const latest = summary.recent[0];
  if (latest !== undefined) {
    lines.push(`Latest review annotation: ${latest.targetKey} - ${formatBoundedInlineText(latest.text)}`);
  }
  return options.prefixBlankLine === true ? ["", ...lines] : lines;
}

function formatBoundedInlineText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 160);
}
