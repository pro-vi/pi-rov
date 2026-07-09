import { BROWSER_HOST_ARTIFACT_VIEW_KIND } from "./browser-host.js";
import type { BrowserArtifactRenderer, BrowserArtifactRendererRegistry } from "./browser-renderer.js";
import type {
  BrowserHostEvidenceSummary,
  BrowserHostEventSummary,
  BrowserHostReadinessSummary,
  BrowserRendererHandoffSummary,
} from "./browser-host-evidence.js";
import type { BrowserHostTraceEvent, CanvasReadback } from "./types.js";

export function summarizeBrowserHostReadiness(
  readback: CanvasReadback,
  browserHost: BrowserHostEvidenceSummary,
  browserRenderers: BrowserArtifactRendererRegistry | undefined,
): BrowserHostReadinessSummary {
  const rendererResolution = resolveBrowserHostRenderer(readback, browserRenderers);
  if (rendererResolution.status === "missing") {
    return {
      status: "blocked",
      readyForHandoff: false,
      reason: `Browser artifact renderer is not registered: ${rendererResolution.rendererId} v${rendererResolution.rendererVersion}.`,
      nextAction: "Register the browser artifact renderer or migrate this artifact to a registered renderer before presenting or handing off.",
      expectedStateVersion: readback.state.version,
      checks: {
        receiptRecorded: browserHost.receipts.length > 0,
        sourceHashCurrent: false,
        stateVersionCurrent: false,
        latestActionAcceptedForHandoff: false,
        latestReviewNoteAcceptedForHandoff: false,
        latestLayoutAuditAcceptedForHandoff: false,
        layoutAuditRecorded: false,
        layoutAuditClean: false,
        rendererResolved: false,
        rendererHandoffSatisfied: false,
      },
    };
  }
  const latest = browserHost.receipts[0];
  const receiptReadErrorCount = browserHost.receiptReadErrors?.length ?? 0;
  if (receiptReadErrorCount > 0) {
    return {
      status: "blocked",
      readyForHandoff: false,
      reason: `${receiptReadErrorCount} browser-host receipt file(s) could not be read; browser evidence is incomplete.`,
      nextAction: "Inspect receiptReadErrors in browser-host evidence, repair or remove the unreadable receipt files, then rerun canvas_present or canvas_read before handoff.",
      expectedStateVersion: readback.state.version,
      ...(latest === undefined ? {} : { latestReceiptStateVersion: latest.finalStateVersion, latestReceiptPath: latest.receiptPath }),
      checks: {
        receiptRecorded: latest !== undefined,
        sourceHashCurrent: latest?.sourceHash === readback.state.sourceHash,
        stateVersionCurrent: latest?.finalStateVersion === readback.state.version,
        latestActionAcceptedForHandoff: false,
        latestReviewNoteAcceptedForHandoff: false,
        latestLayoutAuditAcceptedForHandoff: false,
        layoutAuditRecorded: false,
        layoutAuditClean: false,
        rendererResolved: rendererResolution.status === "resolved",
        rendererHandoffSatisfied: false,
      },
    };
  }
  if (!latest) {
    return {
      status: "not-presented",
      readyForHandoff: false,
      reason: "No browser-host receipt recorded yet; call canvas_present before treating browser evidence as reviewed.",
      nextAction: "Call canvas_present for this artifact, then wait for a browser-host receipt and layout audit before acting on browser evidence.",
      expectedStateVersion: readback.state.version,
      checks: {
        receiptRecorded: false,
        sourceHashCurrent: false,
        stateVersionCurrent: false,
        latestActionAcceptedForHandoff: false,
        latestReviewNoteAcceptedForHandoff: false,
        latestLayoutAuditAcceptedForHandoff: false,
        layoutAuditRecorded: false,
        layoutAuditClean: false,
        rendererResolved: rendererResolution.status === "resolved",
        rendererHandoffSatisfied: false,
      },
    };
  }
  const sourceHashCurrent = latest.sourceHash === readback.state.sourceHash;
  const stateVersionCurrent = latest.finalStateVersion === readback.state.version;
  const latestActionAcceptedForHandoff = isActionAcceptedForHandoff(latest.latestActionEvent, latest.sourceHash, latest.finalStateVersion);
  const latestReviewNoteAcceptedForHandoff = isReviewNoteAcceptedForHandoff(latest.latestReviewNoteEvent, latest.sourceHash, latest.finalStateVersion);
  const latestLayoutAuditAcceptedForHandoff = isLayoutAuditAcceptedForHandoff(latest.latestLayoutAuditEvent, latest.sourceHash, latest.finalStateVersion, latest.currentLayoutAuditErrorCount);
  const layoutAuditRecorded = latest.currentLayoutAuditCount > 0;
  const layoutAuditClean = layoutAuditRecorded && latest.currentLayoutAuditErrorCount === 0;
  const rendererHandoff = summarizeRendererHandoff(readback, browserRenderers);
  const rendererHandoffSatisfied = rendererHandoff === undefined;
  const base = {
    expectedStateVersion: readback.state.version,
    latestReceiptStateVersion: latest.finalStateVersion,
    latestReceiptPath: latest.receiptPath,
    ...(rendererHandoff === undefined ? {} : { rendererHandoff }),
    checks: {
      receiptRecorded: true,
      sourceHashCurrent,
      stateVersionCurrent,
      latestActionAcceptedForHandoff,
      latestReviewNoteAcceptedForHandoff,
      latestLayoutAuditAcceptedForHandoff,
      layoutAuditRecorded,
      layoutAuditClean,
      rendererResolved: rendererResolution.status === "resolved",
      rendererHandoffSatisfied,
    },
  };
  if (!sourceHashCurrent) {
    return {
      status: "stale",
      readyForHandoff: false,
      reason: `Latest browser-host receipt is for source ${formatShortHash(latest.sourceHash)}, but canonical source is ${formatShortHash(readback.state.sourceHash)}; present or refresh before handoff.`,
      nextAction: "Call canvas_present to refresh the browser host against canonical source and state before handoff.",
      ...base,
    };
  }
  if (!stateVersionCurrent) {
    return {
      status: "stale",
      readyForHandoff: false,
      reason: `Latest browser-host receipt is for state v${latest.finalStateVersion}, but canonical state is v${readback.state.version}; present or refresh before handoff.`,
      nextAction: "Call canvas_present to refresh the browser host against canonical source and state before handoff.",
      ...base,
    };
  }
  if (!latestActionAcceptedForHandoff) {
    if (latest.latestActionEvent?.kind !== "action_committed") {
      const codeSuffix = latest.latestActionEvent?.errorCode === undefined ? "" : ` (${latest.latestActionEvent.errorCode})`;
      return {
        status: "blocked",
        readyForHandoff: false,
        reason: `Latest browser-host action was rejected${codeSuffix}; inspect the receipt or perform a successful browser action before handoff.`,
        nextAction: "Inspect the latest action rejection, then perform a valid browser action or update canonical state directly before handoff.",
        ...base,
      };
    }
    return {
      status: "blocked",
      readyForHandoff: false,
      reason: "Latest browser-host action evidence is inconsistent with the receipt state; inspect the receipt or present again before handoff.",
      nextAction: "Inspect the latest action event source/version/status fields, then perform a valid browser action or present again before handoff.",
      ...base,
    };
  }
  if (!latestReviewNoteAcceptedForHandoff) {
    if (latest.latestReviewNoteEvent?.kind !== "review_note_recorded") {
      const codeSuffix = eventCodeSuffix(latest.latestReviewNoteEvent);
      return {
        status: "blocked",
        readyForHandoff: false,
        reason: `Latest browser-host review note was rejected${codeSuffix}; inspect the receipt or submit review evidence successfully before handoff.`,
        nextAction: "Resubmit review feedback through the current browser session or ignore the rejected note before handoff.",
        ...base,
      };
    }
    return {
      status: "blocked",
      readyForHandoff: false,
      reason: "Latest browser-host review note evidence is inconsistent with the receipt state; inspect the receipt or submit review evidence again before handoff.",
      nextAction: "Inspect the latest review note event source/version/status fields, then resubmit review feedback or present again before handoff.",
      ...base,
    };
  }
  if (!latestLayoutAuditAcceptedForHandoff) {
    if (latest.latestLayoutAuditEvent?.kind !== "layout_audit_recorded") {
      const codeSuffix = eventCodeSuffix(latest.latestLayoutAuditEvent);
      return {
        status: "blocked",
        readyForHandoff: false,
        reason: `Latest browser-host layout audit was rejected${codeSuffix}; inspect the receipt or record a clean layout audit before handoff.`,
        nextAction: "Present again and wait for an accepted layout audit before handoff.",
        ...base,
      };
    }
    return {
      status: "blocked",
      readyForHandoff: false,
      reason: "Latest browser-host layout audit evidence is inconsistent with the receipt state; inspect the receipt or record layout evidence again before handoff.",
      nextAction: "Inspect the latest layout audit event source/version/status fields, then present again and wait for accepted layout evidence before handoff.",
      ...base,
    };
  }
  if (!layoutAuditRecorded) {
    return {
      status: "pending",
      readyForHandoff: false,
      reason: `Latest browser-host receipt has no layout audit for current state v${readback.state.version}; wait for browser audit evidence or present again.`,
      nextAction: "Wait for browser layout audit evidence or call canvas_present again for the current state.",
      ...base,
    };
  }
  if (!layoutAuditClean) {
    return {
      status: "blocked",
      readyForHandoff: false,
      reason: `Latest browser-host layout audit for current state has ${latest.currentLayoutAuditErrorCount} error(s); fix visual layout before handoff.`,
      nextAction: "Fix the rendered layout, present again, and require a clean layout audit before handoff.",
      ...base,
    };
  }
  if (rendererHandoff !== undefined) {
    return {
      status: rendererHandoff.status,
      readyForHandoff: false,
      reason: `Renderer handoff gate ${rendererHandoff.checkId} is ${rendererHandoff.status}: ${rendererHandoff.reason}`,
      nextAction: `Satisfy renderer handoff gate ${rendererHandoff.checkId} through the browser or canonical state, then rerun canvas_read.`,
      ...base,
    };
  }
  return {
    status: "ready",
    readyForHandoff: true,
    reason: "Latest browser-host receipt matches canonical state and has a clean layout audit.",
    nextAction: "Use canonical canvas state plus browser-host evidence for handoff; call canvas_export if a durable artifact is needed.",
    ...base,
  };
}

export function readBrowserHostRenderer(readback: CanvasReadback, browserRenderers: BrowserArtifactRendererRegistry | undefined) {
  return resolveBrowserHostRenderer(readback, browserRenderers).renderer;
}

function summarizeRendererHandoff(readback: CanvasReadback, browserRenderers: BrowserArtifactRendererRegistry | undefined): BrowserRendererHandoffSummary | undefined {
  const renderer = resolveBrowserHostRenderer(readback, browserRenderers).renderer;
  if (!renderer) return undefined;
  const check = renderer.summarizeHandoff?.(readback);
  if (check === undefined || check.readyForHandoff) return undefined;
  return {
    rendererId: renderer.id,
    rendererVersion: renderer.version,
    ...check,
  };
}

type BrowserHostRendererResolution =
  | { status: "resolved"; rendererId: string; rendererVersion: number; renderer: BrowserArtifactRenderer }
  | { status: "missing"; rendererId: string; rendererVersion: number; renderer?: undefined }
  | { status: "unknown"; renderer?: undefined };

function resolveBrowserHostRenderer(readback: CanvasReadback, browserRenderers: BrowserArtifactRendererRegistry | undefined): BrowserHostRendererResolution {
  const view = readback.source.view;
  if (!view) return { status: "unknown" };
  const reference = readBrowserHostRendererReference(readback);
  if (!reference || !browserRenderers) return { status: "unknown" };
  const renderer = browserRenderers.get(reference.rendererId, reference.rendererVersion);
  if (!renderer) return { status: "missing", rendererId: reference.rendererId, rendererVersion: reference.rendererVersion };
  return { status: "resolved", rendererId: renderer.id, rendererVersion: renderer.version, renderer };
}

function readBrowserHostRendererReference(readback: CanvasReadback): { rendererId: string; rendererVersion: number } | undefined {
  const view = readback.source.view;
  if (!view) return undefined;
  if (view.kind === BROWSER_HOST_ARTIFACT_VIEW_KIND) {
    return { rendererId: view.rendererId, rendererVersion: view.rendererVersion };
  }
  return undefined;
}

function isHandoffBlockingRejection(event: BrowserHostEventSummary | undefined, rejectedKind: BrowserHostTraceEvent["kind"]): boolean {
  if (event?.kind !== rejectedKind) return false;
  return !isNonHandoffBlockingRejectionCode(event.errorCode);
}

function isActionAcceptedForHandoff(event: BrowserHostEventSummary | undefined, expectedSourceHash: string, expectedFinalStateVersion: number): boolean {
  if (!event) return true;
  if (event.kind === "action_rejected") return !isHandoffBlockingRejection(event, "action_rejected");
  if (event.kind !== "action_committed") return true;
  if (event.status !== "ok") return false;
  if (event.sourceHash !== expectedSourceHash) return false;
  if (event.beforeVersion === undefined || event.afterVersion === undefined) return false;
  if (event.beforeVersion >= event.afterVersion) return false;
  return event.afterVersion <= expectedFinalStateVersion;
}

function isReviewNoteAcceptedForHandoff(event: BrowserHostEventSummary | undefined, expectedSourceHash: string, expectedFinalStateVersion: number): boolean {
  if (!event) return true;
  if (event.kind === "review_note_rejected") return !isHandoffBlockingRejection(event, "review_note_rejected");
  if (event.kind !== "review_note_recorded") return true;
  if (event.status !== "ok") return false;
  if (event.sourceHash !== expectedSourceHash) return false;
  return event.afterVersion === expectedFinalStateVersion;
}

function isLayoutAuditAcceptedForHandoff(event: BrowserHostEventSummary | undefined, expectedSourceHash: string, expectedFinalStateVersion: number, currentLayoutAuditErrorCount: number): boolean {
  if (!event) return true;
  if (event.kind === "layout_audit_rejected") return !isHandoffBlockingRejection(event, "layout_audit_rejected");
  if (event.kind !== "layout_audit_recorded") return true;
  if (event.sourceHash !== expectedSourceHash) return false;
  if (event.afterVersion !== expectedFinalStateVersion) return false;
  if (event.status === "ok") return true;
  return event.status === "failed" && currentLayoutAuditErrorCount > 0;
}

function isNonHandoffBlockingRejectionCode(errorCode: string | undefined): boolean {
  return errorCode === "token_mismatch" || errorCode === "token_rejected" || errorCode === "origin_mismatch" || errorCode === "artifact_mismatch" || errorCode === "session_mismatch";
}

function eventCodeSuffix(event: BrowserHostEventSummary | undefined): string {
  return event?.errorCode === undefined ? "" : ` (${event.errorCode})`;
}

function formatShortHash(hash: string | undefined): string {
  return hash === undefined || hash.length === 0 ? "missing" : hash.slice(0, 12);
}
