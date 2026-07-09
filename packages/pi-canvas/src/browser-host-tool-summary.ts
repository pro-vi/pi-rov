import type { BrowserArtifactRendererRegistry } from "./browser-renderer.js";
import {
  readBrowserHostEvidence,
  withBrowserHostReadiness,
  type BrowserHostArtifactStateSummary,
  type BrowserHostEvidenceExport,
  type BrowserHostReadinessSummary,
  type BrowserHostReviewAnnotationSummary,
} from "./browser-host-evidence.js";
import type { CanvasReadback } from "./types.js";

export interface BrowserHostToolSummary {
  browserHost: BrowserHostEvidenceExport;
  browserReadiness?: BrowserHostReadinessSummary | undefined;
  artifactState?: BrowserHostArtifactStateSummary | undefined;
  reviewAnnotations?: BrowserHostReviewAnnotationSummary | undefined;
}

export async function readBrowserHostToolSummary(
  rootDir: string,
  readback: CanvasReadback,
  browserRegistry: BrowserArtifactRendererRegistry,
): Promise<BrowserHostToolSummary> {
  const browserHost = withBrowserHostReadiness(readback, await readBrowserHostEvidence(rootDir, readback), browserRegistry);
  return {
    browserHost,
    browserReadiness: browserHost.readiness,
    artifactState: browserHost.artifactState,
    reviewAnnotations: browserHost.reviewAnnotations,
  };
}

export function shouldIncludeBrowserHostExport(browserHost: BrowserHostEvidenceExport): boolean {
  return (
    browserHost.receipts.length > 0 ||
    (browserHost.receiptReadErrors?.length ?? 0) > 0 ||
    browserHost.readiness !== undefined ||
    browserHost.artifactPattern !== undefined ||
    browserHost.artifactState !== undefined ||
    browserHost.reviewAnnotations !== undefined
  );
}
