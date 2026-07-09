import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeTextAtomic } from "./atomic-write.js";
import { BROWSER_HOST_RECEIPT_SUFFIX, browserHostReceiptFileNameMatchesSource, isScopedBrowserHostReceiptFileName } from "./browser-host-receipts.js";
import { readBrowserHostRenderer, summarizeBrowserHostReadiness } from "./browser-host-readiness.js";
import {
  BROWSER_HOST_ARTIFACT_VIEW_KIND,
  type BrowserHostLayoutAuditReceipt,
  type BrowserHostReviewNoteReceipt,
  type BrowserHostSessionReceipt,
} from "./browser-host.js";
import type { BrowserArtifactRendererRegistry, BrowserArtifactStateSummary, BrowserRendererHandoffCheck } from "./browser-renderer.js";
import { isJsonValue, isRecord } from "./json.js";
import type { BrowserHostTraceEvent, BrowserVisualEvidenceKind, CanvasReadback } from "./types.js";

export const BROWSER_HOST_SCOPED_RECEIPT_SCAN_LIMIT = 100;
const BROWSER_HOST_LEGACY_RECEIPT_SCAN_LIMIT = 50;
export const BROWSER_HOST_RECEIPT_FILE_LIMIT_BYTES = 2_000_000;

const BROWSER_HOST_TRACE_EVENT_KINDS = [
  "session_opened",
  "session_focused",
  "auth_rejected",
  "action_committed",
  "action_rejected",
  "layout_audit_recorded",
  "layout_audit_rejected",
  "review_note_recorded",
  "review_note_rejected",
  "evidence_recorded",
  "session_closed",
] as const satisfies readonly BrowserHostTraceEvent["kind"][];

const BROWSER_HOST_TRACE_EVENT_STATUSES = ["ok", "failed", "skipped", "rejected"] as const satisfies readonly NonNullable<BrowserHostTraceEvent["status"]>[];

export interface BrowserHostEventSummary {
  eventId: string;
  kind: BrowserHostTraceEvent["kind"];
  createdAt: string;
  status?: BrowserHostTraceEvent["status"];
  sourceHash?: string | undefined;
  beforeVersion?: number | undefined;
  afterVersion?: number | undefined;
  actionId?: string | undefined;
  provenanceId?: string | undefined;
  rendererActionType?: string | undefined;
  errorCode?: string | undefined;
  message?: string | undefined;
}

export interface BrowserHostReceiptSummary {
  receiptPath: string;
  hostSessionId: string;
  sourceHash: string;
  sourcePath: string;
  status: BrowserHostSessionReceipt["status"];
  openedAt: string;
  focusedAt?: string | undefined;
  closedAt?: string | undefined;
  finalStateVersion: number;
  actionCount: number;
  reviewNoteCount: number;
  layoutAuditCount: number;
  layoutAuditErrorCount: number;
  currentLayoutAuditCount: number;
  currentLayoutAuditErrorCount: number;
  eventKinds: string[];
  recentEvents: BrowserHostEventSummary[];
  recentActionEvents?: BrowserHostEventSummary[] | undefined;
  latestActionEvent?: BrowserHostEventSummary | undefined;
  latestReviewNoteEvent?: BrowserHostEventSummary | undefined;
  latestLayoutAuditEvent?: BrowserHostEventSummary | undefined;
  visualEvidencePath?: string | undefined;
  visualEvidenceKind?: BrowserVisualEvidenceKind | undefined;
  screenshotPath?: string | undefined;
  domSnapshotPath?: string | undefined;
  layoutAuditPath?: string | undefined;
  layoutAuditSourceHash?: string | undefined;
  layoutAuditStateVersion?: number | undefined;
  readbackJsonPath?: string | undefined;
  exportDir?: string | undefined;
}

export interface BrowserHostEvidenceSummary {
  receiptDir: string;
  receipts: BrowserHostReceiptSummary[];
  reviewNotes: BrowserHostReviewNoteReceipt[];
  layoutAudits: BrowserHostLayoutAuditReceipt[];
  receiptReadErrors?: BrowserHostReceiptReadError[] | undefined;
}

export interface BrowserHostReceiptReadError {
  receiptPath: string;
  reason: "invalid-json" | "invalid-receipt" | "too-large";
  message: string;
}

export interface BrowserHostReviewAnnotationSummary {
  total: number;
  targetCount: number;
  targets: BrowserHostReviewAnnotationTargetSummary[];
  recent: BrowserHostReviewAnnotationNoteSummary[];
}

export interface BrowserHostReviewAnnotationTargetSummary {
  targetKey: string;
  targetKind: string;
  label: string;
  count: number;
  latestNoteId: string;
  latestText: string;
  latestCreatedAt: string;
}

export interface BrowserHostReviewAnnotationNoteSummary {
  id: string;
  targetKey: string;
  targetKind: string;
  label: string;
  text: string;
  createdAt: string;
}

export type BrowserHostReadinessStatus = "ready" | "not-presented" | "pending" | "stale" | "blocked";

export interface BrowserHostArtifactPatternSummary {
  layer: "browser-host-artifact";
  rendererId: string;
  rendererVersion: number;
  playbookId: string;
  stateAuthority: "canvas_read";
  evidenceAuthority: "browser-host-receipts";
  title: string;
  purpose: string;
  canonicalState: string;
  agentAction: string;
  qualityGates: string[];
}

export interface BrowserHostArtifactStateSummary extends BrowserArtifactStateSummary {
  rendererId: string;
  rendererVersion: number;
}

export interface BrowserRendererHandoffSummary extends BrowserRendererHandoffCheck {
  rendererId: string;
  rendererVersion: number;
}

export interface BrowserHostReadinessSummary {
  status: BrowserHostReadinessStatus;
  readyForHandoff: boolean;
  reason: string;
  nextAction: string;
  expectedStateVersion: number;
  latestReceiptStateVersion?: number | undefined;
  latestReceiptPath?: string | undefined;
  rendererHandoff?: BrowserRendererHandoffSummary | undefined;
  checks: {
    receiptRecorded: boolean;
    sourceHashCurrent: boolean;
    stateVersionCurrent: boolean;
    latestActionAcceptedForHandoff: boolean;
    latestReviewNoteAcceptedForHandoff: boolean;
    latestLayoutAuditAcceptedForHandoff: boolean;
    layoutAuditRecorded: boolean;
    layoutAuditClean: boolean;
    rendererResolved: boolean;
    rendererHandoffSatisfied: boolean;
  };
}

export interface BrowserHostEvidenceExport extends BrowserHostEvidenceSummary {
  readiness?: BrowserHostReadinessSummary | undefined;
  artifactPattern?: BrowserHostArtifactPatternSummary | undefined;
  artifactState?: BrowserHostArtifactStateSummary | undefined;
  reviewAnnotations?: BrowserHostReviewAnnotationSummary | undefined;
}

function isBrowserHostCanvas(readback: CanvasReadback): boolean {
  return readback.source.view?.kind === BROWSER_HOST_ARTIFACT_VIEW_KIND;
}

export function withBrowserHostReadiness(
  readback: CanvasReadback,
  browserHost: BrowserHostEvidenceSummary,
  browserRenderers?: BrowserArtifactRendererRegistry | undefined,
): BrowserHostEvidenceExport {
  const readiness = isBrowserHostCanvas(readback) ? summarizeBrowserHostReadiness(readback, browserHost, browserRenderers) : undefined;
  const artifactPattern = isBrowserHostCanvas(readback) ? summarizeBrowserHostArtifactPattern(readback, browserRenderers) : undefined;
  const artifactState = isBrowserHostCanvas(readback) ? summarizeBrowserHostArtifactState(readback, browserRenderers) : undefined;
  const reviewAnnotations = summarizeBrowserHostReviewAnnotations(browserHost.reviewNotes);
  return {
    ...browserHost,
    ...(readiness === undefined ? {} : { readiness }),
    ...(artifactPattern === undefined ? {} : { artifactPattern }),
    ...(artifactState === undefined ? {} : { artifactState }),
    ...(reviewAnnotations === undefined ? {} : { reviewAnnotations }),
  };
}

function summarizeBrowserHostArtifactState(
  readback: CanvasReadback,
  browserRenderers: BrowserArtifactRendererRegistry | undefined,
): BrowserHostArtifactStateSummary | undefined {
  const renderer = readBrowserHostRenderer(readback, browserRenderers);
  const summary = renderer?.summarizeState?.(readback);
  if (!renderer || !summary) return undefined;
  return {
    rendererId: renderer.id,
    rendererVersion: renderer.version,
    ...summary,
  };
}

function summarizeBrowserHostReviewAnnotations(reviewNotes: BrowserHostReviewNoteReceipt[]): BrowserHostReviewAnnotationSummary | undefined {
  if (reviewNotes.length === 0) return undefined;
  const targets = new Map<string, BrowserHostReviewAnnotationTargetSummary>();
  for (const note of reviewNotes) {
    const targetKey = note.targetKey ?? fallbackReviewTargetKey(note.target);
    const targetKind = readReviewTargetKind(note.target);
    const label = summarizeReviewTargetLabel(note.target, targetKey);
    const previous = targets.get(targetKey);
    if (previous === undefined) {
      targets.set(targetKey, {
        targetKey,
        targetKind,
        label,
        count: 1,
        latestNoteId: note.id,
        latestText: note.text,
        latestCreatedAt: note.createdAt,
      });
      continue;
    }
    previous.count += 1;
    if (compareIsoDesc(note.createdAt, previous.latestCreatedAt) < 0) {
      previous.latestNoteId = note.id;
      previous.latestText = note.text;
      previous.latestCreatedAt = note.createdAt;
      previous.label = label;
      previous.targetKind = targetKind;
    }
  }
  const targetSummaries = [...targets.values()].sort((left, right) => right.count - left.count || compareIsoDesc(left.latestCreatedAt, right.latestCreatedAt)).slice(0, 20);
  return {
    total: reviewNotes.length,
    targetCount: targets.size,
    targets: targetSummaries,
    recent: reviewNotes.slice(0, 10).map((note) => {
      const targetKey = note.targetKey ?? fallbackReviewTargetKey(note.target);
      return {
        id: note.id,
        targetKey,
        targetKind: readReviewTargetKind(note.target),
        label: summarizeReviewTargetLabel(note.target, targetKey),
        text: note.text,
        createdAt: note.createdAt,
      };
    }),
  };
}

function readReviewTargetKind(target: BrowserHostReviewNoteReceipt["target"]): string {
  const kind = target.kind;
  return typeof kind === "string" && kind.trim().length > 0 ? kind : "page";
}

function fallbackReviewTargetKey(target: BrowserHostReviewNoteReceipt["target"]): string {
  return `${readReviewTargetKind(target)}:${boundedHash(JSON.stringify(target))}`;
}

function summarizeReviewTargetLabel(target: BrowserHostReviewNoteReceipt["target"], targetKey: string): string {
  const kind = readReviewTargetKind(target);
  if (kind === "page") return "page";
  if (kind === "selection") {
    const text = typeof target.text === "string" ? target.text : "";
    return text.trim().length === 0 ? targetKey : `selection ${formatBoundedEvidenceText(text)}`;
  }
  if (kind === "element") {
    const label = [target.testId, target.id, target.selector, target.tag].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const text = typeof target.text === "string" && target.text.trim().length > 0 ? ` - ${formatBoundedEvidenceText(target.text)}` : "";
    return `${label ?? targetKey}${text}`;
  }
  return targetKey;
}

function formatBoundedEvidenceText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 120);
}

function boundedHash(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function summarizeBrowserHostArtifactPattern(
  readback: CanvasReadback,
  browserRenderers: BrowserArtifactRendererRegistry | undefined,
): BrowserHostArtifactPatternSummary | undefined {
  const renderer = readBrowserHostRenderer(readback, browserRenderers);
  const playbook = renderer?.playbook;
  if (!renderer || !playbook) return undefined;
  return {
    layer: "browser-host-artifact",
    rendererId: renderer.id,
    rendererVersion: renderer.version,
    playbookId: playbook.id,
    stateAuthority: "canvas_read",
    evidenceAuthority: "browser-host-receipts",
    title: playbook.title,
    purpose: playbook.purpose,
    canonicalState: playbook.canonicalState,
    agentAction: playbook.agentAction,
    qualityGates: [...playbook.qualityGates],
  };
}

export async function readBrowserHostEvidence(rootDir: string, readback: CanvasReadback): Promise<BrowserHostEvidenceSummary> {
  const receiptDir = join(rootDir, "browser-host-receipts");
  const receipts: BrowserHostSessionReceipt[] = [];
  const receiptReadErrors: BrowserHostReceiptReadError[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(receiptDir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { receiptDir, receipts: [], reviewNotes: [], layoutAudits: [] };
    throw error;
  }
  for (const entry of await browserHostReceiptEvidenceEntries(receiptDir, entries, readback)) {
    const result = await readBrowserHostReceipt(join(receiptDir, entry));
    if (result?.receipt) receipts.push(result.receipt);
    if (result?.error && browserHostReceiptFileNameMatchesSource(entry, readback.source.artifactId, readback.paths.sourcePath)) {
      receiptReadErrors.push(result.error);
    }
  }
  return summarizeBrowserHostEvidenceReceipts(receiptDir, readback, receipts, receiptReadErrors);
}

async function browserHostReceiptEvidenceEntries(receiptDir: string, entries: string[], readback: CanvasReadback): Promise<string[]> {
  const currentScoped: string[] = [];
  const legacyUnscoped: string[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(BROWSER_HOST_RECEIPT_SUFFIX)) continue;
    if (browserHostReceiptFileNameMatchesSource(entry, readback.source.artifactId, readback.paths.sourcePath)) {
      currentScoped.push(entry);
      continue;
    }
    if (!isScopedBrowserHostReceiptFileName(entry)) {
      legacyUnscoped.push(entry);
    }
  }
  const currentScopedByMtime = await readReceiptEntryStats(receiptDir, currentScoped);
  currentScopedByMtime.sort((left, right) => right.mtimeMs - left.mtimeMs || right.entry.localeCompare(left.entry));
  return [...currentScopedByMtime.slice(0, BROWSER_HOST_SCOPED_RECEIPT_SCAN_LIMIT).map((candidate) => candidate.entry), ...legacyUnscoped.slice(0, BROWSER_HOST_LEGACY_RECEIPT_SCAN_LIMIT)];
}

async function readReceiptEntryStats(receiptDir: string, entries: string[]): Promise<Array<{ entry: string; mtimeMs: number }>> {
  const candidates: Array<{ entry: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    try {
      const info = await lstat(join(receiptDir, entry));
      if (info.isFile()) candidates.push({ entry, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    }
  }
  return candidates;
}

export function summarizeBrowserHostEvidenceReceipts(
  receiptDir: string,
  readback: CanvasReadback,
  sourceReceipts: BrowserHostSessionReceipt[],
  receiptReadErrors: BrowserHostReceiptReadError[] = [],
): BrowserHostEvidenceSummary {
  const receipts = sourceReceipts.filter((receipt) => receipt.artifactId === readback.source.artifactId && receipt.sourcePath === readback.paths.sourcePath);
  receipts.sort(compareReceiptActivityDesc);
  const currentReceipts = receipts.filter((receipt) => isReceiptCurrentForReadback(receipt, readback));
  const staleReceipts = receipts.filter((receipt) => !isReceiptCurrentForReadback(receipt, readback));
  const limitedReceipts = [...currentReceipts, ...staleReceipts].slice(0, 5);
  const currentEvidenceReceipts = currentReceipts.slice(0, 5);
  const reviewNotes = currentEvidenceReceipts
    .flatMap((receipt) => receipt.reviewNotes)
    .filter((note) => note.sourceHash === readback.state.sourceHash && note.stateVersion === readback.state.version)
    .sort((left, right) => compareIsoDesc(left.createdAt, right.createdAt));
  const layoutAudits = currentEvidenceReceipts
    .flatMap((receipt) => receipt.layoutAudits ?? [])
    .filter((audit) => audit.sourceHash === readback.state.sourceHash && audit.stateVersion === readback.state.version)
    .sort((left, right) => compareIsoDesc(left.createdAt, right.createdAt));
  return {
    receiptDir,
    receipts: limitedReceipts.map(summarizeBrowserHostReceipt),
    reviewNotes: reviewNotes.slice(0, 20),
    layoutAudits: layoutAudits.slice(0, 20),
    ...(receiptReadErrors.length === 0 ? {} : { receiptReadErrors: receiptReadErrors.slice(0, 20) }),
  };
}

function isReceiptCurrentForReadback(receipt: BrowserHostSessionReceipt, readback: CanvasReadback): boolean {
  return receipt.sourceHash === readback.state.sourceHash && receipt.finalStateVersion === readback.state.version;
}

function compareReceiptActivityDesc(left: BrowserHostSessionReceipt, right: BrowserHostSessionReceipt): number {
  return compareIsoDesc(readLatestReceiptActivityIso(left), readLatestReceiptActivityIso(right)) || compareIsoDesc(left.openedAt, right.openedAt);
}

function readLatestReceiptActivityIso(receipt: BrowserHostSessionReceipt): string {
  const candidates = [receipt.openedAt, receipt.focusedAt, receipt.closedAt, ...receipt.events.map((event) => event.createdAt)].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.sort(compareIsoDesc)[0] ?? receipt.openedAt;
}

export async function writeBrowserHostEvidenceExport(exportDir: string, browserHost: BrowserHostEvidenceExport): Promise<string | undefined> {
  if (browserHost.receipts.length === 0 && browserHost.readiness === undefined && (browserHost.receiptReadErrors?.length ?? 0) === 0) return undefined;
  const evidencePath = join(exportDir, "browser-host.evidence.json");
  await writeTextAtomic(evidencePath, `${JSON.stringify(browserHost, null, 2)}\n`);
  return evidencePath;
}

async function readBrowserHostReceipt(path: string): Promise<{ receipt: BrowserHostSessionReceipt; error?: undefined } | { receipt?: undefined; error: BrowserHostReceiptReadError } | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    if (info.size > BROWSER_HOST_RECEIPT_FILE_LIMIT_BYTES) {
      return { error: { receiptPath: path, reason: "too-large", message: `Browser-host receipt exceeds ${BROWSER_HOST_RECEIPT_FILE_LIMIT_BYTES} bytes.` } };
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (!isBrowserHostSessionReceipt(parsed)) {
      return { error: { receiptPath: path, reason: "invalid-receipt", message: "Browser-host receipt does not match the receipt schema." } };
    }
    return { receipt: parsed };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError) {
      return { error: { receiptPath: path, reason: "invalid-json", message: "Browser-host receipt JSON is malformed." } };
    }
    throw error;
  }
}

function isBrowserHostSessionReceipt(value: unknown): value is BrowserHostSessionReceipt {
  return (
    isRecord(value) &&
    typeof value.artifactId === "string" &&
    typeof value.hostSessionId === "string" &&
    typeof value.receiptPath === "string" &&
    typeof value.sourceHash === "string" &&
    typeof value.sourcePath === "string" &&
    typeof value.openedAt === "string" &&
    typeof value.finalStateVersion === "number" &&
    (value.status === "open" || value.status === "focused" || value.status === "closed") &&
    (value.layoutAuditSourceHash === undefined || typeof value.layoutAuditSourceHash === "string") &&
    (value.layoutAuditStateVersion === undefined || typeof value.layoutAuditStateVersion === "number") &&
    Array.isArray(value.actions) &&
    Array.isArray(value.reviewNotes) &&
    value.reviewNotes.every(isBrowserHostReviewNoteReceipt) &&
    (value.layoutAudits === undefined || (Array.isArray(value.layoutAudits) && value.layoutAudits.every(isBrowserHostLayoutAuditReceipt))) &&
    Array.isArray(value.events) &&
    value.events.every(isBrowserHostTraceEvent)
  );
}

function isBrowserHostTraceEvent(value: unknown): value is BrowserHostTraceEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    isBrowserHostTraceEventKind(value.kind) &&
    typeof value.createdAt === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.artifactId === "string" &&
    (value.sourceHash === undefined || typeof value.sourceHash === "string") &&
    (value.beforeVersion === undefined || typeof value.beforeVersion === "number") &&
    (value.afterVersion === undefined || typeof value.afterVersion === "number") &&
    (value.actionId === undefined || typeof value.actionId === "string") &&
    (value.provenanceId === undefined || typeof value.provenanceId === "string") &&
    (value.rendererActionType === undefined || typeof value.rendererActionType === "string") &&
    (value.status === undefined || isBrowserHostTraceEventStatus(value.status)) &&
    (value.errorCode === undefined || typeof value.errorCode === "string") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isBrowserHostTraceEventKind(value: unknown): value is BrowserHostTraceEvent["kind"] {
  return typeof value === "string" && (BROWSER_HOST_TRACE_EVENT_KINDS as readonly string[]).includes(value);
}

function isBrowserHostTraceEventStatus(value: unknown): value is NonNullable<BrowserHostTraceEvent["status"]> {
  return typeof value === "string" && (BROWSER_HOST_TRACE_EVENT_STATUSES as readonly string[]).includes(value);
}

function isBrowserHostReviewNoteReceipt(value: unknown): value is BrowserHostReviewNoteReceipt {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    isRecord(value.target) &&
    isJsonValue(value.target) &&
    (value.targetKey === undefined || typeof value.targetKey === "string") &&
    typeof value.sourceHash === "string" &&
    typeof value.stateVersion === "number" &&
    typeof value.origin === "string" &&
    typeof value.createdAt === "string"
  );
}

function isBrowserHostLayoutAuditReceipt(value: unknown): value is BrowserHostLayoutAuditReceipt {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sourceHash === "string" &&
    typeof value.stateVersion === "number" &&
    typeof value.origin === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.findings) &&
    value.findings.every(
      (finding) =>
        isRecord(finding) &&
        typeof finding.kind === "string" &&
        typeof finding.selector === "string" &&
        (finding.severity === "warning" || finding.severity === "error") &&
        typeof finding.overflowPx === "number",
    ) &&
    typeof value.errorCount === "number" &&
    typeof value.warningCount === "number"
  );
}

function summarizeBrowserHostReceipt(receipt: BrowserHostSessionReceipt): BrowserHostReceiptSummary {
  const layoutAudits = receipt.layoutAudits ?? [];
  const externalLayoutAuditCount = receipt.layoutAuditPath === undefined ? 0 : 1;
  const externalLayoutAuditErrorCount = receipt.layoutAuditPath === undefined ? 0 : (receipt.layoutAuditErrorCount ?? 0);
  const currentInlineLayoutAudits = layoutAudits.filter((audit) => audit.sourceHash === receipt.sourceHash && audit.stateVersion === receipt.finalStateVersion);
  const latestCurrentInlineLayoutAudit = [...currentInlineLayoutAudits].sort((left, right) => compareIsoDesc(left.createdAt, right.createdAt))[0];
  const externalLayoutAuditCurrent = receipt.layoutAuditPath !== undefined && receipt.layoutAuditSourceHash === receipt.sourceHash && receipt.layoutAuditStateVersion === receipt.finalStateVersion;
  const currentExternalLayoutAuditCount = externalLayoutAuditCurrent ? 1 : 0;
  const currentExternalLayoutAuditErrorCount = externalLayoutAuditCurrent ? (receipt.layoutAuditErrorCount ?? 0) : 0;
  const currentLayoutAuditErrorCount = Math.max(latestCurrentInlineLayoutAudit?.errorCount ?? 0, currentExternalLayoutAuditErrorCount);
  const recentEvents = receipt.events.slice(-10).map(summarizeBrowserHostEvent);
  const recentActionEvents = receipt.events
    .filter((event) => event.kind === "action_committed" || event.kind === "action_rejected")
    .slice(-6)
    .map(summarizeBrowserHostEvent);
  const latestActionEvent = findLatestBrowserHostEvent(receipt.events, (event) => event.kind === "action_committed" || event.kind === "action_rejected");
  const latestReviewNoteEvent = findLatestBrowserHostEvent(receipt.events, (event) => event.kind === "review_note_recorded" || event.kind === "review_note_rejected");
  const latestLayoutAuditEvent = findLatestBrowserHostEvent(receipt.events, (event) => event.kind === "layout_audit_recorded" || event.kind === "layout_audit_rejected");
  return {
    receiptPath: receipt.receiptPath,
    hostSessionId: receipt.hostSessionId,
    sourceHash: receipt.sourceHash,
    sourcePath: receipt.sourcePath,
    status: receipt.status,
    openedAt: receipt.openedAt,
    ...(receipt.focusedAt === undefined ? {} : { focusedAt: receipt.focusedAt }),
    ...(receipt.closedAt === undefined ? {} : { closedAt: receipt.closedAt }),
    finalStateVersion: receipt.finalStateVersion,
    actionCount: receipt.actions.length,
    reviewNoteCount: receipt.reviewNotes.length,
    layoutAuditCount: layoutAudits.length + externalLayoutAuditCount,
    layoutAuditErrorCount: layoutAudits.reduce((count, audit) => count + audit.errorCount, 0) + externalLayoutAuditErrorCount,
    currentLayoutAuditCount: currentInlineLayoutAudits.length + currentExternalLayoutAuditCount,
    currentLayoutAuditErrorCount,
    eventKinds: receipt.events.map((event) => event.kind),
    recentEvents,
    ...(recentActionEvents.length === 0 ? {} : { recentActionEvents }),
    ...(latestActionEvent === undefined ? {} : { latestActionEvent }),
    ...(latestReviewNoteEvent === undefined ? {} : { latestReviewNoteEvent }),
    ...(latestLayoutAuditEvent === undefined ? {} : { latestLayoutAuditEvent }),
    ...(receipt.visualEvidencePath === undefined ? {} : { visualEvidencePath: receipt.visualEvidencePath }),
    ...(receipt.visualEvidenceKind === undefined ? {} : { visualEvidenceKind: receipt.visualEvidenceKind }),
    ...(receipt.screenshotPath === undefined ? {} : { screenshotPath: receipt.screenshotPath }),
    ...(receipt.domSnapshotPath === undefined ? {} : { domSnapshotPath: receipt.domSnapshotPath }),
    ...(receipt.layoutAuditPath === undefined ? {} : { layoutAuditPath: receipt.layoutAuditPath }),
    ...(receipt.layoutAuditErrorCount === undefined ? {} : { layoutAuditErrorCount: receipt.layoutAuditErrorCount }),
    ...(receipt.layoutAuditSourceHash === undefined ? {} : { layoutAuditSourceHash: receipt.layoutAuditSourceHash }),
    ...(receipt.layoutAuditStateVersion === undefined ? {} : { layoutAuditStateVersion: receipt.layoutAuditStateVersion }),
    ...(receipt.readbackJsonPath === undefined ? {} : { readbackJsonPath: receipt.readbackJsonPath }),
    ...(receipt.exportDir === undefined ? {} : { exportDir: receipt.exportDir }),
  };
}

function findLatestBrowserHostEvent(receiptEvents: BrowserHostTraceEvent[], predicate: (event: BrowserHostTraceEvent) => boolean): BrowserHostEventSummary | undefined {
  return findLatestBrowserHostEventMatch(receiptEvents, predicate)?.event;
}

function findLatestBrowserHostEventMatch(
  receiptEvents: BrowserHostTraceEvent[],
  predicate: (event: BrowserHostTraceEvent) => boolean,
): { event: BrowserHostEventSummary; index: number } | undefined {
  for (let index = receiptEvents.length - 1; index >= 0; index -= 1) {
    const event = receiptEvents[index];
    if (event !== undefined && predicate(event)) return { event: summarizeBrowserHostEvent(event), index };
  }
  return undefined;
}

function summarizeBrowserHostEvent(event: BrowserHostTraceEvent): BrowserHostEventSummary {
  return {
    eventId: event.eventId,
    kind: event.kind,
    createdAt: event.createdAt,
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.sourceHash === undefined ? {} : { sourceHash: event.sourceHash }),
    ...(event.beforeVersion === undefined ? {} : { beforeVersion: event.beforeVersion }),
    ...(event.afterVersion === undefined ? {} : { afterVersion: event.afterVersion }),
    ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
    ...(event.provenanceId === undefined ? {} : { provenanceId: event.provenanceId }),
    ...(event.rendererActionType === undefined ? {} : { rendererActionType: event.rendererActionType }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(event.message === undefined ? {} : { message: event.message }),
  };
}

function compareIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
