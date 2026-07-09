export const CANVAS_VIEW_KINDS = [
  "pi-tui-component",
  "json-render-schema",
  "html-iframe-state-bridge",
  "browser-host-artifact",
  "ts-component-bundle",
  "canvas-custom-renderer",
  "hybrid",
] as const;

export const CANVAS_ACTION_TYPES = ["set"] as const;
export const DEFAULT_CANVAS_RENDERER_ID = "builtin.json-card";
export const DEFAULT_CANVAS_RENDERER_VERSION = 1;

export type CanvasViewKind = (typeof CANVAS_VIEW_KINDS)[number];
export type CanvasActionType = (typeof CANVAS_ACTION_TYPES)[number];
export type BrowserVisualEvidenceKind = "screenshot" | "pdf";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface CanvasActionDefinition {
  type: CanvasActionType;
  path: string;
  label: string;
}

export interface CanvasPiTuiViewDefinition {
  kind: "pi-tui-component";
  rendererId: string;
  rendererVersion: number;
  props?: JsonObject;
}

export interface CanvasHtmlIframeBridgeDefinition {
  kind: "html-iframe-state-bridge";
  bridgeVersion: 1;
  host: "adjacent-browser-host";
  fallback: "terminal-render";
  transport: "postMessage-json-rpc";
  sandbox: string[];
  csp: string;
  permissions: string[];
  actionSchema: JsonObject;
  htmlSourceHash?: string;
  props?: JsonObject;
}

export interface CanvasBrowserHostArtifactDefinition {
  kind: "browser-host-artifact";
  bridgeVersion: 1;
  host: "local-browser-host";
  fallback: "terminal-render";
  transport: "http-json";
  rendererId: string;
  rendererVersion: number;
  props?: JsonObject;
}

export type CanvasViewDefinition = CanvasPiTuiViewDefinition | CanvasHtmlIframeBridgeDefinition | CanvasBrowserHostArtifactDefinition;

export interface CanvasSource {
  artifactId: string;
  schemaVersion: 1 | 2;
  title: string;
  viewKind: CanvasViewKind;
  view?: CanvasViewDefinition;
  stateSchema: JsonObject;
  initialState: JsonValue;
  actions: CanvasActionDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface CanvasStateSnapshot {
  artifactId: string;
  version: number;
  sourceHash: string;
  state: JsonValue;
  updatedAt: string;
}

export interface CanvasActionRecord {
  id: string;
  artifactId: string;
  type: CanvasActionType;
  path: string;
  value: JsonValue;
  actor: string;
  createdAt: string;
}

export interface CanvasProvenanceRecord {
  id: string;
  artifactId: string;
  event: "create" | "update" | "export" | "migrate";
  sourceHash: string;
  createdAt: string;
  actionId?: string;
  beforeVersion?: number;
  afterVersion?: number;
  beforeState?: JsonValue;
  afterState?: JsonValue;
  beforeSourceHash?: string;
  afterSourceHash?: string;
  exportDir?: string;
}

export interface CanvasPaths {
  artifactDir: string;
  sourcePath: string;
  statePath: string;
  actionsPath: string;
  provenancePath: string;
}

export interface CanvasReadback {
  source: CanvasSource;
  state: CanvasStateSnapshot;
  latestProvenance?: CanvasProvenanceRecord;
  paths: CanvasPaths;
}

export interface CreateCanvasRequest {
  artifactId?: string;
  title: string;
  initialState: JsonValue;
  viewKind?: CanvasViewKind;
  view?: CanvasViewDefinition;
  surfaceKind?: "terminal" | "browser";
  rendererId?: string;
  rendererVersion?: number;
  browserRendererId?: string;
  browserRendererVersion?: number;
  viewProps?: JsonObject;
  stateSchema?: JsonObject;
  actions?: CanvasActionDefinition[];
}

export interface UpdateCanvasRequest {
  artifactId: string;
  path: string;
  value: JsonValue;
  actor?: string;
  expectedSourceHash?: string;
  expectedStateVersion?: number;
}

export interface CanvasExportResult {
  artifactId: string;
  exportDir: string;
  sourcePath: string;
  statePath: string;
  provenancePath: string;
  sourceDiffPath: string;
  stateDiffPath: string;
}

export type BrowserHostTraceEventKind =
  | "session_opened"
  | "session_focused"
  | "auth_rejected"
  | "action_committed"
  | "action_rejected"
  | "layout_audit_recorded"
  | "layout_audit_rejected"
  | "review_note_recorded"
  | "review_note_rejected"
  | "evidence_recorded"
  | "session_closed";

export interface BrowserHostTraceEvent {
  eventId: string;
  kind: BrowserHostTraceEventKind;
  createdAt: string;
  sessionId: string;
  artifactId: string;
  sourceHash?: string | undefined;
  beforeVersion?: number | undefined;
  afterVersion?: number | undefined;
  actionId?: string | undefined;
  provenanceId?: string | undefined;
  rendererActionType?: string | undefined;
  status?: "ok" | "failed" | "skipped" | "rejected" | undefined;
  errorCode?: string | undefined;
  message?: string | undefined;
}

export interface HarnessAssertion {
  id: string;
  layer: "source" | "state" | "view" | "interaction" | "review" | "export" | "terminal-browser" | "browser-host";
  expected: string;
  actual: string;
  artifactPath: string;
  verdict: "pass" | "fail";
}

export interface PiCanvasHarnessRun {
  runId: string;
  scenarioId: string;
  candidateId: string;
  piVersion: string;
  extensionVersion: string;
  commands: string[];
  outsideIn: {
    surfaceKind: "tui" | "rpc" | "browser-terminal" | "browser-host" | "degraded";
    observableEvents: string[];
    visualEvidencePath?: string;
    visualEvidenceKind?: BrowserVisualEvidenceKind;
    screenshotPath?: string;
    terminalTranscriptPath?: string;
  };
  insideOut: {
    sourcePath: string;
    statePath: string;
    actionLogPath: string;
    readbackJsonPath: string;
    exportDir: string;
    reviewDiffPaths: string[];
  };
  assertions: HarnessAssertion[];
  verdict: "pass" | "fail" | "flaky" | "blocked";
  successGateSatisfied: boolean;
}
