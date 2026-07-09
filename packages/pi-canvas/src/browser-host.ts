import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeTextAtomic } from "./atomic-write.js";
import { formatBrowserHostReceiptFileName } from "./browser-host-receipts.js";
import {
  assertMatchesJsonSchema,
  type BrowserArtifactRenderer,
  type BrowserArtifactRendererRegistry,
  type BrowserHostBootstrap,
  type BrowserRendererSetTransition,
} from "./browser-renderer.js";
import { createDefaultBrowserArtifactRendererRegistry } from "./builtin-browser-renderers.js";
import { isJsonObject, isJsonValue, isRecord, readNumber, readString } from "./json.js";
import type { PiCanvasRuntime } from "./runtime.js";
import { sha256 } from "./store.js";
import type {
  BrowserHostTraceEvent,
  BrowserVisualEvidenceKind,
  CanvasBrowserHostArtifactDefinition,
  CanvasExportResult,
  CanvasReadback,
  JsonObject,
  JsonValue,
  UpdateCanvasRequest,
} from "./types.js";

export const BROWSER_HOST_ARTIFACT_VIEW_KIND = "browser-host-artifact";
export const BROWSER_HOST_VERSION = 1;
export const BROWSER_HOST_NAME = "local-browser-host";
export const BROWSER_HOST_TRANSPORT = "http-json";
export const BROWSER_HOST_FALLBACK = "terminal-render";
export const BROWSER_HOST_RECEIPT_LIMITS = {
  actions: 40,
  reviewNotes: 40,
  rejections: 40,
  events: 120,
  layoutAudits: 20,
} as const;
export const BROWSER_HOST_REQUEST_BODY_LIMIT_BYTES = 64_000;

export interface BrowserHostSessionOptions {
  runtime: PiCanvasRuntime;
  artifactId: string;
  candidateId: string;
  scenarioId: string;
  runId: string;
  reportsDir: string;
  browserRenderers?: BrowserArtifactRendererRegistry;
  now?: () => Date;
}

export interface BrowserHostEvidence {
  visualEvidencePath?: string;
  visualEvidenceKind?: BrowserVisualEvidenceKind;
  screenshotPath?: string;
  domSnapshotPath?: string;
  layoutAuditPath?: string;
  layoutAuditErrorCount?: number;
  readbackJsonPath?: string;
  exported?: CanvasExportResult;
}

export interface BrowserHostActionReceipt {
  path: string;
  beforeVersion: number;
  afterVersion: number;
  sourceHash: string;
  origin: string;
}

export interface BrowserHostRejectionReceipt {
  reason: string;
  actual: string;
}

export interface BrowserHostReviewNoteReceipt {
  id: string;
  text: string;
  target: JsonObject;
  targetKey?: string | undefined;
  sourceHash: string;
  stateVersion: number;
  origin: string;
  createdAt: string;
}

export interface BrowserHostLayoutFindingReceipt {
  kind: string;
  selector: string;
  severity: "warning" | "error";
  overflowPx: number;
  viewportWidth?: number | undefined;
  viewportHeight?: number | undefined;
}

export interface BrowserHostLayoutAuditReceipt {
  id: string;
  sourceHash: string;
  stateVersion: number;
  origin: string;
  createdAt: string;
  findings: BrowserHostLayoutFindingReceipt[];
  errorCount: number;
  warningCount: number;
}

export interface BrowserHostSessionReceipt {
  candidateId: string;
  scenarioId: string;
  command: string;
  runId: string;
  artifactId: string;
  sourceHash: string;
  initialStateVersion: number;
  finalStateVersion: number;
  hostSessionId: string;
  signedUrl: string;
  allowedOrigin: string;
  tokenHash: string;
  status: "open" | "focused" | "closed";
  openedAt: string;
  fallback: "terminal-render";
  renderer: string;
  sourcePath: string;
  statePath: string;
  actionLogPath: string;
  reviewDiffPaths: string[];
  actions: BrowserHostActionReceipt[];
  reviewNotes: BrowserHostReviewNoteReceipt[];
  layoutAudits?: BrowserHostLayoutAuditReceipt[] | undefined;
  rejections: BrowserHostRejectionReceipt[];
  events: BrowserHostTraceEvent[];
  receiptPath: string;
  focusedAt?: string;
  closedAt?: string;
  screenshotPath?: string;
  visualEvidencePath?: string;
  visualEvidenceKind?: BrowserVisualEvidenceKind;
  domSnapshotPath?: string;
  layoutAuditPath?: string;
  layoutAuditErrorCount?: number;
  layoutAuditSourceHash?: string;
  layoutAuditStateVersion?: number;
  readbackJsonPath?: string;
  exportDir?: string;
}

export interface BrowserHostActionOutcome {
  ok: boolean;
  status: number;
  text: string;
}

interface BrowserHostViewResolution {
  view: CanvasBrowserHostArtifactDefinition;
  rendererId: string;
  rendererVersion: number;
}

export class LocalBrowserHostSession {
  readonly receipt: BrowserHostSessionReceipt;
  readonly token: string;
  private readonly runtime: PiCanvasRuntime;
  private readonly now: () => Date;
  private readonly server: Server;
  private readonly view: CanvasBrowserHostArtifactDefinition;
  private readonly renderer: BrowserArtifactRenderer;
  private liveUrl = "";

  private constructor(options: {
    runtime: PiCanvasRuntime;
    now: () => Date;
    server: Server;
    token: string;
    view: CanvasBrowserHostArtifactDefinition;
    renderer: BrowserArtifactRenderer;
    receipt: BrowserHostSessionReceipt;
  }) {
    this.runtime = options.runtime;
    this.now = options.now;
    this.server = options.server;
    this.token = options.token;
    this.view = options.view;
    this.renderer = options.renderer;
    this.receipt = options.receipt;
  }

  get url(): string {
    return this.liveUrl;
  }

  static async start(options: BrowserHostSessionOptions): Promise<LocalBrowserHostSession> {
    const now = options.now ?? (() => new Date());
    const readback = await options.runtime.read(options.artifactId);
    if (!readback) {
      throw new Error(`Canvas artifact not found: ${options.artifactId}`);
    }
    const browserRenderers = options.browserRenderers ?? createDefaultBrowserArtifactRendererRegistry();
    const resolution = readBrowserHostView(readback);
    const renderer = browserRenderers.require(resolution.rendererId, resolution.rendererVersion);
    const hostSessionId = `bhost-${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const receiptPath = join(options.reportsDir, formatBrowserHostReceiptFileName(options.artifactId, options.runId, readback.paths.sourcePath));
    const server = createServer();
    const receipt: BrowserHostSessionReceipt = {
      candidateId: options.candidateId,
      scenarioId: options.scenarioId,
      command: `npm run eval:harness -- --scenario ${options.scenarioId}`,
      runId: options.runId,
      artifactId: options.artifactId,
      sourceHash: readback.state.sourceHash,
      initialStateVersion: readback.state.version,
      finalStateVersion: readback.state.version,
      hostSessionId,
      signedUrl: "",
      allowedOrigin: "",
      tokenHash: sha256(token),
      status: "open",
      openedAt: now().toISOString(),
      fallback: BROWSER_HOST_FALLBACK,
      renderer: renderer.id,
      sourcePath: readback.paths.sourcePath,
      statePath: readback.paths.statePath,
      actionLogPath: readback.paths.actionsPath,
      reviewDiffPaths: [],
      actions: [],
      reviewNotes: [],
      layoutAudits: [],
      rejections: [],
      events: [],
      receiptPath,
    };
    const session = new LocalBrowserHostSession({ runtime: options.runtime, now, server, token, view: resolution.view, renderer, receipt });
    session.recordEvent("session_opened", { sourceHash: readback.state.sourceHash, beforeVersion: readback.state.version, afterVersion: readback.state.version, status: "ok" });
    server.on("request", (request, response) => {
      void session.handleRequest(request, response).catch((error: unknown) => {
        session.writeJsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
    await listen(server);
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Browser host did not bind to a local TCP port");
    }
    receipt.allowedOrigin = `http://127.0.0.1:${address.port}`;
    session.liveUrl = `${receipt.allowedOrigin}/session/${hostSessionId}?token=${encodeURIComponent(token)}`;
    receipt.signedUrl = redactBrowserHostUrl(session.liveUrl);
    await session.writeReceipt();
    return session;
  }

  async focus(): Promise<void> {
    this.receipt.status = "focused";
    this.receipt.focusedAt = this.now().toISOString();
    this.recordEvent("session_focused", { sourceHash: this.receipt.sourceHash, afterVersion: this.receipt.finalStateVersion, status: "ok" });
    await this.writeReceipt();
  }

  canFocusFor(readback: CanvasReadback): boolean {
    if (this.receipt.status === "closed") return false;
    if (this.receipt.artifactId !== readback.source.artifactId) return false;
    if (this.receipt.sourceHash !== readback.state.sourceHash) return false;
    if (this.receipt.sourcePath !== readback.paths.sourcePath) return false;
    if (this.receipt.finalStateVersion !== readback.state.version) return false;
    return true;
  }

  async recordEvidence(evidence: BrowserHostEvidence): Promise<void> {
    const readback = await this.runtime.read(this.receipt.artifactId);
    if (readback) {
      this.receipt.finalStateVersion = readback.state.version;
      this.receipt.statePath = readback.paths.statePath;
      this.receipt.actionLogPath = readback.paths.actionsPath;
    }
    if (evidence.visualEvidencePath !== undefined) this.receipt.visualEvidencePath = evidence.visualEvidencePath;
    if (evidence.visualEvidenceKind !== undefined) this.receipt.visualEvidenceKind = evidence.visualEvidenceKind;
    if (evidence.screenshotPath !== undefined) this.receipt.screenshotPath = evidence.screenshotPath;
    if (evidence.domSnapshotPath !== undefined) {
      await this.redactEvidenceFile(evidence.domSnapshotPath);
      this.receipt.domSnapshotPath = evidence.domSnapshotPath;
    }
    if (evidence.layoutAuditPath !== undefined) {
      await this.redactEvidenceFile(evidence.layoutAuditPath);
      this.receipt.layoutAuditPath = evidence.layoutAuditPath;
      if (readback) {
        this.receipt.layoutAuditSourceHash = readback.state.sourceHash;
        this.receipt.layoutAuditStateVersion = readback.state.version;
      }
    }
    if (evidence.layoutAuditErrorCount !== undefined) this.receipt.layoutAuditErrorCount = evidence.layoutAuditErrorCount;
    if (evidence.readbackJsonPath !== undefined) this.receipt.readbackJsonPath = evidence.readbackJsonPath;
    if (evidence.exported !== undefined) {
      this.receipt.exportDir = evidence.exported.exportDir;
      this.receipt.reviewDiffPaths = [evidence.exported.sourceDiffPath, evidence.exported.stateDiffPath];
    }
    this.recordEvent("evidence_recorded", { sourceHash: this.receipt.sourceHash, afterVersion: this.receipt.finalStateVersion, status: "ok" });
    await this.writeReceipt();
  }

  async postActionForTest(body: JsonObject, headers: Record<string, string> = {}): Promise<BrowserHostActionOutcome> {
    const requestHeaders: Record<string, string> = {
      "content-type": "application/json",
      "origin": this.receipt.allowedOrigin,
      "x-pi-canvas-token": this.token,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (value === "") delete requestHeaders[key.toLowerCase()];
      else requestHeaders[key] = value;
    }
    const response = await fetch(`${this.receipt.allowedOrigin}/session/${this.receipt.hostSessionId}/action`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }

  async postReviewNoteForTest(body: JsonObject, headers: Record<string, string> = {}): Promise<BrowserHostActionOutcome> {
    const requestHeaders: Record<string, string> = {
      "content-type": "application/json",
      "origin": this.receipt.allowedOrigin,
      "x-pi-canvas-token": this.token,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (value === "") delete requestHeaders[key.toLowerCase()];
      else requestHeaders[key] = value;
    }
    const response = await fetch(`${this.receipt.allowedOrigin}/session/${this.receipt.hostSessionId}/review-note`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }

  async postLayoutAuditForTest(body: JsonObject, headers: Record<string, string> = {}): Promise<BrowserHostActionOutcome> {
    const requestHeaders: Record<string, string> = {
      "content-type": "application/json",
      "origin": this.receipt.allowedOrigin,
      "x-pi-canvas-token": this.token,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (value === "") delete requestHeaders[key.toLowerCase()];
      else requestHeaders[key] = value;
    }
    const response = await fetch(`${this.receipt.allowedOrigin}/session/${this.receipt.hostSessionId}/layout-audit`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }

  async close(): Promise<void> {
    if (this.receipt.status === "closed") return;
    this.receipt.status = "closed";
    this.receipt.closedAt = this.now().toISOString();
    const readback = await this.runtime.read(this.receipt.artifactId);
    if (readback) {
      this.receipt.finalStateVersion = readback.state.version;
      this.receipt.statePath = readback.paths.statePath;
      this.receipt.actionLogPath = readback.paths.actionsPath;
    }
    this.recordEvent("session_closed", { sourceHash: this.receipt.sourceHash, afterVersion: this.receipt.finalStateVersion, status: "ok" });
    await this.writeReceipt();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.receipt.allowedOrigin || "http://127.0.0.1");
    const sessionPath = `/session/${this.receipt.hostSessionId}`;
    if (request.method === "GET" && url.pathname === sessionPath) {
      await this.handleSessionPage(url, response);
      return;
    }
    if (request.method === "GET" && url.pathname === `${sessionPath}/receipt`) {
      if (!this.isAuthorizedRequest(request, url)) {
        this.recordAuthRejection("receipt token rejected", "missing", { errorCode: "token_mismatch" });
        await this.writeReceipt();
        this.writeJsonResponse(response, 403, { ok: false, error: "Browser host token rejected" });
        return;
      }
      this.writeJsonResponse(response, 200, this.receipt);
      return;
    }
    if (request.method === "POST" && url.pathname === `${sessionPath}/action`) {
      await this.handleAction(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === `${sessionPath}/review-note`) {
      await this.handleReviewNote(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === `${sessionPath}/layout-audit`) {
      await this.handleLayoutAudit(request, response);
      return;
    }
    this.writeJsonResponse(response, 404, { ok: false, error: "Browser host route not found" });
  }

  private async handleSessionPage(url: URL, response: ServerResponse): Promise<void> {
    const token = url.searchParams.get("token");
    if (!token || !secureEqual(token, this.token)) {
      this.recordAuthRejection("session token rejected", token ? "present" : "missing", { errorCode: "token_mismatch" });
      await this.writeReceipt();
      this.writeJsonResponse(response, 403, { ok: false, error: "Browser host token rejected" });
      return;
    }
    const readback = await this.runtime.read(this.receipt.artifactId);
    if (!readback) {
      this.writeJsonResponse(response, 404, { ok: false, error: "Canvas artifact not found" });
      return;
    }
    const bootstrap = {
      artifactId: readback.source.artifactId,
      sessionId: this.receipt.hostSessionId,
      sourceHash: readback.state.sourceHash,
      stateVersion: readback.state.version,
      state: readback.state.state,
      token: this.token,
      allowedOrigin: this.receipt.allowedOrigin,
    };
    const html = injectBrowserHostChrome(this.renderer.renderHtml(readback, bootstrap), bootstrap);
    response.writeHead(200, {
      ...browserHostResponseHeaders("text/html; charset=utf-8"),
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; font-src data:; frame-src 'self'; frame-ancestors 'none'",
    });
    response.end(html);
  }

  private async handleAction(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let statusCode = 409;
    try {
      const body = await readJsonBody(request);
      const envelope = await this.parseBoundActionEnvelope(request, body);
      const before = await this.runtime.read(this.receipt.artifactId);
      if (!before) {
        throw new BrowserHostRequestError(404, "not_found", `Canvas artifact not found: ${this.receipt.artifactId}`);
      }
      this.assertActionEnvelopeCurrent(envelope, before);
      try {
        assertMatchesJsonSchema(this.renderer.actionSchema, envelope.action, "browser host action payload");
      } catch (error) {
        throw new BrowserHostRequestError(409, "action_schema_invalid", error instanceof Error ? error.message : String(error), readString(envelope.action, "type"));
      }
      const transition = this.renderer.reduceAction(before, envelope.action);
      if (transition.kind === "reject") {
        throw new BrowserHostRequestError(409, "renderer_rejected", transition.reason, transition.rendererActionType);
      }
      const update = this.transitionToUpdate(envelope, transition);
      const updated = await this.updateFromBrowserAction(update, envelope.action);
      this.receipt.finalStateVersion = updated.state.version;
      this.receipt.statePath = updated.paths.statePath;
      this.receipt.actionLogPath = updated.paths.actionsPath;
      const actionId = updated.latestProvenance?.actionId;
      const provenanceId = updated.latestProvenance?.id;
      pushBounded(this.receipt.actions, {
        path: update.path,
        beforeVersion: update.expectedStateVersion ?? updated.state.version - 1,
        afterVersion: updated.state.version,
        sourceHash: updated.state.sourceHash,
        origin: envelope.origin,
      }, BROWSER_HOST_RECEIPT_LIMITS.actions);
      this.recordEvent("action_committed", {
        sourceHash: updated.state.sourceHash,
        beforeVersion: update.expectedStateVersion ?? updated.state.version - 1,
        afterVersion: updated.state.version,
        actionId,
        provenanceId,
        rendererActionType: transition.rendererActionType,
        status: "ok",
      });
      await this.writeReceipt();
      this.writeJsonResponse(response, 200, {
        ok: true,
        stateVersion: updated.state.version,
        state: updated.state.state,
        actionLogPath: updated.paths.actionsPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BrowserHostRequestError) statusCode = error.statusCode;
      const errorCode = error instanceof BrowserHostRequestError ? error.code : "action_rejected";
      this.recordRejection(message, "browser action rejected", {
        errorCode,
        rendererActionType: error instanceof BrowserHostRequestError ? error.rendererActionType : undefined,
        sourceHash: error instanceof BrowserHostRequestError ? error.sourceHash : undefined,
        afterVersion: error instanceof BrowserHostRequestError ? error.afterVersion : undefined,
      });
      await this.writeReceipt();
      this.writeJsonResponse(response, statusCode, { ok: false, error: message, errorCode });
    }
  }

  private async handleReviewNote(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let statusCode = 409;
    try {
      const body = await readJsonBody(request);
      const envelope = await this.parseBoundReviewNoteEnvelope(request, body);
      await this.assertEvidenceEnvelopeCurrent(envelope, "review note");
      const note: BrowserHostReviewNoteReceipt = {
        id: `bhrn-${sha256(`${this.receipt.hostSessionId}:${randomUUID()}:${envelope.text}`).slice(0, 16)}`,
        text: envelope.text,
        target: envelope.target,
        targetKey: reviewNoteTargetKey(envelope.target),
        sourceHash: envelope.sourceHash,
        stateVersion: envelope.stateVersion,
        origin: envelope.origin,
        createdAt: this.now().toISOString(),
      };
      pushBounded(this.receipt.reviewNotes, note, BROWSER_HOST_RECEIPT_LIMITS.reviewNotes);
      this.recordEvent("review_note_recorded", {
        sourceHash: note.sourceHash,
        afterVersion: note.stateVersion,
        status: "ok",
        message: note.text.slice(0, 200),
      });
      await this.writeReceipt();
      this.writeJsonResponse(response, 200, { ok: true, noteId: note.id, reviewNoteCount: this.receipt.reviewNotes.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BrowserHostRequestError) statusCode = error.statusCode;
      const errorCode = error instanceof BrowserHostRequestError ? error.code : "review_note_rejected";
      this.recordReviewNoteRejection(message, {
        errorCode,
        sourceHash: error instanceof BrowserHostRequestError ? error.sourceHash : undefined,
        afterVersion: error instanceof BrowserHostRequestError ? error.afterVersion : undefined,
      });
      await this.writeReceipt();
      this.writeJsonResponse(response, statusCode, { ok: false, error: message, errorCode });
    }
  }

  private async handleLayoutAudit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let statusCode = 409;
    try {
      const body = await readJsonBody(request);
      const envelope = await this.parseBoundLayoutAuditEnvelope(request, body);
      await this.assertEvidenceEnvelopeCurrent(envelope, "layout audit");
      const errorCount = envelope.findings.filter((finding) => finding.severity === "error").length;
      const audit: BrowserHostLayoutAuditReceipt = {
        id: `bhla-${sha256(`${this.receipt.hostSessionId}:${randomUUID()}:${JSON.stringify(envelope.findings)}`).slice(0, 16)}`,
        sourceHash: envelope.sourceHash,
        stateVersion: envelope.stateVersion,
        origin: envelope.origin,
        createdAt: this.now().toISOString(),
        findings: envelope.findings,
        errorCount,
        warningCount: envelope.findings.length - errorCount,
      };
      this.receipt.layoutAudits = [...(this.receipt.layoutAudits ?? []), audit].slice(-BROWSER_HOST_RECEIPT_LIMITS.layoutAudits);
      this.recordEvent("layout_audit_recorded", {
        sourceHash: audit.sourceHash,
        afterVersion: audit.stateVersion,
        status: errorCount === 0 ? "ok" : "failed",
        message: `layout audit findings=${audit.findings.length} errors=${audit.errorCount}`,
      });
      await this.writeReceipt();
      this.writeJsonResponse(response, 200, { ok: true, auditId: audit.id, findingCount: audit.findings.length, errorCount: audit.errorCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BrowserHostRequestError) statusCode = error.statusCode;
      const errorCode = error instanceof BrowserHostRequestError ? error.code : "layout_audit_rejected";
      this.recordLayoutAuditRejection(message, {
        errorCode,
        sourceHash: error instanceof BrowserHostRequestError ? error.sourceHash : undefined,
        afterVersion: error instanceof BrowserHostRequestError ? error.afterVersion : undefined,
      });
      await this.writeReceipt();
      this.writeJsonResponse(response, statusCode, { ok: false, error: message, errorCode });
    }
  }

  private async parseBoundActionEnvelope(request: IncomingMessage, body: JsonObject): Promise<{ sourceHash: string; stateVersion: number; origin: string; action: JsonObject }> {
    const headerToken = readHeader(request, "x-pi-canvas-token");
    if (!headerToken || !secureEqual(headerToken, this.token)) {
      throw new BrowserHostRequestError(403, "token_mismatch", "Browser host token mismatch");
    }
    const headerOrigin = readHeader(request, "origin");
    if (headerOrigin !== this.receipt.allowedOrigin) {
      throw new BrowserHostRequestError(403, "origin_mismatch", `Browser host origin mismatch: ${headerOrigin ?? "missing"}`);
    }
    const artifactId = readString(body, "artifactId");
    const sessionId = readString(body, "sessionId");
    const sourceHash = readString(body, "sourceHash");
    const stateVersion = readNumber(body, "stateVersion");
    const origin = readString(body, "origin");
    if (artifactId !== this.receipt.artifactId) {
      throw new BrowserHostRequestError(409, "artifact_mismatch", `Browser host artifact mismatch: ${artifactId ?? "missing"}`);
    }
    if (sessionId !== this.receipt.hostSessionId) {
      throw new BrowserHostRequestError(409, "session_mismatch", `Browser host session mismatch: ${sessionId ?? "missing"}`);
    }
    if (origin !== this.receipt.allowedOrigin) {
      throw new BrowserHostRequestError(403, "origin_mismatch", `Browser host action origin mismatch: ${origin ?? "missing"}`);
    }
    if (!sourceHash) {
      throw new BrowserHostRequestError(409, "source_hash_missing", "Browser host source hash missing");
    }
    if (stateVersion === undefined) {
      throw new BrowserHostRequestError(409, "state_version_missing", "Browser host state version missing");
    }
    const rawAction = body.action;
    if (!isJsonObject(rawAction)) {
      throw new BrowserHostRequestError(409, "action_invalid", "Browser host action payload must be a JSON object");
    }
    return { sourceHash, stateVersion, origin, action: rawAction };
  }

  private async parseBoundReviewNoteEnvelope(request: IncomingMessage, body: JsonObject): Promise<{ sourceHash: string; stateVersion: number; origin: string; text: string; target: JsonObject }> {
    const headerToken = readHeader(request, "x-pi-canvas-token");
    if (!headerToken || !secureEqual(headerToken, this.token)) {
      throw new BrowserHostRequestError(403, "token_mismatch", "Browser host review note token mismatch");
    }
    const headerOrigin = readHeader(request, "origin");
    if (headerOrigin !== this.receipt.allowedOrigin) {
      throw new BrowserHostRequestError(403, "origin_mismatch", `Browser host review note origin mismatch: ${headerOrigin ?? "missing"}`);
    }
    const artifactId = readString(body, "artifactId");
    const sessionId = readString(body, "sessionId");
    const sourceHash = readString(body, "sourceHash");
    const stateVersion = readNumber(body, "stateVersion");
    const origin = readString(body, "origin");
    if (artifactId !== this.receipt.artifactId) {
      throw new BrowserHostRequestError(409, "artifact_mismatch", `Browser host review note artifact mismatch: ${artifactId ?? "missing"}`);
    }
    if (sessionId !== this.receipt.hostSessionId) {
      throw new BrowserHostRequestError(409, "session_mismatch", `Browser host review note session mismatch: ${sessionId ?? "missing"}`);
    }
    if (origin !== this.receipt.allowedOrigin) {
      throw new BrowserHostRequestError(403, "origin_mismatch", `Browser host review note origin mismatch: ${origin ?? "missing"}`);
    }
    if (sourceHash !== this.receipt.sourceHash) {
      throw new BrowserHostRequestError(409, "source_hash_mismatch", `Browser host review note source hash mismatch: ${sourceHash ?? "missing"}`);
    }
    if (stateVersion === undefined) {
      throw new BrowserHostRequestError(409, "state_version_missing", "Browser host review note state version missing");
    }
    if (stateVersion !== this.receipt.finalStateVersion) {
      throw new BrowserHostRequestError(409, "state_version_stale", `Browser host review note state version stale: ${stateVersion}`);
    }
    const text = readString(body, "text")?.trim();
    if (!text) {
      throw new BrowserHostRequestError(409, "review_note_empty", "Browser host review note text is required");
    }
    if (text.length > 2_000) {
      throw new BrowserHostRequestError(409, "review_note_too_long", "Browser host review note text is too long");
    }
    return {
      sourceHash,
      stateVersion,
      origin,
      text,
      target: parseBrowserReviewNoteTarget(body.target),
    };
  }

  private async parseBoundLayoutAuditEnvelope(
    request: IncomingMessage,
    body: JsonObject,
  ): Promise<{ sourceHash: string; stateVersion: number; origin: string; findings: BrowserHostLayoutFindingReceipt[] }> {
    const headerToken = readHeader(request, "x-pi-canvas-token");
    if (!headerToken || !secureEqual(headerToken, this.token)) {
      throw new BrowserHostRequestError(403, "token_mismatch", "Browser host layout audit token mismatch");
    }
    const headerOrigin = readHeader(request, "origin");
    if (headerOrigin !== this.receipt.allowedOrigin) {
      throw new BrowserHostRequestError(403, "origin_mismatch", `Browser host layout audit origin mismatch: ${headerOrigin ?? "missing"}`);
    }
    const artifactId = readString(body, "artifactId");
    const sessionId = readString(body, "sessionId");
    const sourceHash = readString(body, "sourceHash");
    const stateVersion = readNumber(body, "stateVersion");
    const origin = readString(body, "origin");
    if (artifactId !== this.receipt.artifactId) {
      throw new BrowserHostRequestError(409, "artifact_mismatch", `Browser host layout audit artifact mismatch: ${artifactId ?? "missing"}`);
    }
    if (sessionId !== this.receipt.hostSessionId) {
      throw new BrowserHostRequestError(409, "session_mismatch", `Browser host layout audit session mismatch: ${sessionId ?? "missing"}`);
    }
    if (origin !== this.receipt.allowedOrigin) {
      throw new BrowserHostRequestError(403, "origin_mismatch", `Browser host layout audit origin mismatch: ${origin ?? "missing"}`);
    }
    if (sourceHash !== this.receipt.sourceHash) {
      throw new BrowserHostRequestError(409, "source_hash_mismatch", `Browser host layout audit source hash mismatch: ${sourceHash ?? "missing"}`);
    }
    if (stateVersion === undefined) {
      throw new BrowserHostRequestError(409, "state_version_missing", "Browser host layout audit state version missing");
    }
    if (stateVersion !== this.receipt.finalStateVersion) {
      throw new BrowserHostRequestError(409, "state_version_stale", `Browser host layout audit state version stale: ${stateVersion}`);
    }
    return {
      sourceHash,
      stateVersion,
      origin,
      findings: parseBrowserHostLayoutFindings(body.findings),
    };
  }

  private transitionToUpdate(envelope: { sourceHash: string; stateVersion: number }, transition: BrowserRendererSetTransition): UpdateCanvasRequest {
    return {
      artifactId: this.receipt.artifactId,
      path: transition.path,
      value: transition.value,
      actor: `browser-host:${this.receipt.hostSessionId}`,
      expectedSourceHash: envelope.sourceHash,
      expectedStateVersion: envelope.stateVersion,
    };
  }

  private assertActionEnvelopeCurrent(envelope: { sourceHash: string; stateVersion: number; action: JsonObject }, readback: CanvasReadback): void {
    const rendererActionType = readString(envelope.action, "type");
    if (envelope.sourceHash !== readback.state.sourceHash) {
      throw new BrowserHostRequestError(
        409,
        "source_hash_mismatch",
        `Browser host action source hash mismatch: ${envelope.sourceHash || "missing"} != ${readback.state.sourceHash}`,
        rendererActionType,
        readback.state.sourceHash,
        readback.state.version,
      );
    }
    if (envelope.stateVersion !== readback.state.version) {
      throw new BrowserHostRequestError(
        409,
        "state_version_stale",
        `Browser host action stale state version: ${envelope.stateVersion} != ${readback.state.version}`,
        rendererActionType,
        readback.state.sourceHash,
        readback.state.version,
      );
    }
  }

  private async updateFromBrowserAction(update: UpdateCanvasRequest, action: JsonObject): Promise<CanvasReadback> {
    try {
      return await this.runtime.update(update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.runtime.read(update.artifactId);
      const rendererActionType = readString(action, "type");
      if (message.includes("Canvas stale state version")) {
        throw new BrowserHostRequestError(409, "state_version_stale", `Browser host action stale state version: ${message}`, rendererActionType, current?.state.sourceHash, current?.state.version);
      }
      if (message.includes("Canvas source hash mismatch")) {
        throw new BrowserHostRequestError(409, "source_hash_mismatch", `Browser host action source hash mismatch: ${message}`, rendererActionType, current?.state.sourceHash, current?.state.version);
      }
      throw error;
    }
  }

  private async assertEvidenceEnvelopeCurrent(envelope: { sourceHash: string; stateVersion: number }, evidenceKind: "review note" | "layout audit"): Promise<void> {
    const current = await this.runtime.read(this.receipt.artifactId);
    if (!current) {
      throw new BrowserHostRequestError(404, "not_found", `Canvas artifact not found: ${this.receipt.artifactId}`);
    }
    if (envelope.sourceHash !== current.state.sourceHash) {
      throw new BrowserHostRequestError(
        409,
        "source_hash_mismatch",
        `Browser host ${evidenceKind} source hash mismatch: ${envelope.sourceHash || "missing"} != ${current.state.sourceHash}`,
        undefined,
        current.state.sourceHash,
        current.state.version,
      );
    }
    if (envelope.stateVersion !== current.state.version) {
      throw new BrowserHostRequestError(
        409,
        "state_version_stale",
        `Browser host ${evidenceKind} stale state version: ${envelope.stateVersion} != ${current.state.version}`,
        undefined,
        current.state.sourceHash,
        current.state.version,
      );
    }
  }

  private isAuthorizedRequest(request: IncomingMessage, url: URL): boolean {
    const headerToken = readHeader(request, "x-pi-canvas-token");
    const queryToken = url.searchParams.get("token") ?? undefined;
    return (headerToken !== undefined && secureEqual(headerToken, this.token)) || (queryToken !== undefined && secureEqual(queryToken, this.token));
  }

  private recordRejection(reason: string, actual: string, event: { errorCode?: string | undefined; rendererActionType?: string | undefined; sourceHash?: string | undefined; afterVersion?: number | undefined } = {}): void {
    pushBounded(this.receipt.rejections, { reason, actual }, BROWSER_HOST_RECEIPT_LIMITS.rejections);
    this.recordEvent("action_rejected", {
      sourceHash: event.sourceHash ?? this.receipt.sourceHash,
      afterVersion: event.afterVersion ?? this.receipt.finalStateVersion,
      rendererActionType: event.rendererActionType,
      status: "rejected",
      errorCode: event.errorCode,
      message: reason,
    });
  }

  private recordAuthRejection(reason: string, actual: string, event: { errorCode?: string | undefined } = {}): void {
    pushBounded(this.receipt.rejections, { reason, actual }, BROWSER_HOST_RECEIPT_LIMITS.rejections);
    this.recordEvent("auth_rejected", {
      sourceHash: this.receipt.sourceHash,
      afterVersion: this.receipt.finalStateVersion,
      status: "rejected",
      errorCode: event.errorCode,
      message: reason,
    });
  }

  private recordReviewNoteRejection(reason: string, event: { errorCode?: string | undefined; sourceHash?: string | undefined; afterVersion?: number | undefined } = {}): void {
    pushBounded(this.receipt.rejections, { reason, actual: "browser review note rejected" }, BROWSER_HOST_RECEIPT_LIMITS.rejections);
    this.recordEvent("review_note_rejected", {
      sourceHash: event.sourceHash ?? this.receipt.sourceHash,
      afterVersion: event.afterVersion ?? this.receipt.finalStateVersion,
      status: "rejected",
      errorCode: event.errorCode,
      message: reason,
    });
  }

  private recordLayoutAuditRejection(reason: string, event: { errorCode?: string | undefined; sourceHash?: string | undefined; afterVersion?: number | undefined } = {}): void {
    pushBounded(this.receipt.rejections, { reason, actual: "browser layout audit rejected" }, BROWSER_HOST_RECEIPT_LIMITS.rejections);
    this.recordEvent("layout_audit_rejected", {
      sourceHash: event.sourceHash ?? this.receipt.sourceHash,
      afterVersion: event.afterVersion ?? this.receipt.finalStateVersion,
      status: "rejected",
      errorCode: event.errorCode,
      message: reason,
    });
  }

  private recordEvent(kind: BrowserHostTraceEvent["kind"], details: Partial<Omit<BrowserHostTraceEvent, "eventId" | "kind" | "createdAt" | "sessionId" | "artifactId">> = {}): void {
    pushBounded(this.receipt.events, {
      eventId: `bhe-${sha256(`${this.receipt.hostSessionId}:${kind}:${randomUUID()}`).slice(0, 16)}`,
      kind,
      createdAt: this.now().toISOString(),
      sessionId: this.receipt.hostSessionId,
      artifactId: this.receipt.artifactId,
      ...details,
    }, BROWSER_HOST_RECEIPT_LIMITS.events);
  }

  private async redactEvidenceFile(path: string): Promise<void> {
    try {
      const raw = await readFile(path, "utf-8");
      const redacted = raw.split(this.token).join("[redacted-pi-canvas-token]");
      if (redacted !== raw) {
        await writeTextAtomic(path, redacted);
      }
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    }
  }

  private async writeReceipt(): Promise<void> {
    await writeTextAtomic(this.receipt.receiptPath, `${JSON.stringify(this.receipt, null, 2)}\n`);
  }

  private writeJsonResponse(response: ServerResponse, statusCode: number, value: JsonValue | BrowserHostSessionReceipt): void {
    const body = `${JSON.stringify(value)}\n`;
    response.writeHead(statusCode, browserHostResponseHeaders("application/json; charset=utf-8"));
    response.end(body);
  }
}

export async function readActionLog(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

function injectBrowserHostChrome(html: string, bootstrap: BrowserHostBootstrap): string {
  const chrome = `${renderBrowserHostReviewChrome(bootstrap)}${renderBrowserHostLayoutAuditClient(bootstrap)}`;
  const bodyCloseIndex = html.toLowerCase().lastIndexOf("</body>");
  if (bodyCloseIndex === -1) return `${html}\n${chrome}`;
  return `${html.slice(0, bodyCloseIndex)}${chrome}${html.slice(bodyCloseIndex)}`;
}

function renderBrowserHostReviewChrome(bootstrap: BrowserHostBootstrap): string {
  const encodedBootstrap = escapeScriptJson(
    JSON.stringify({
      artifactId: bootstrap.artifactId,
      sessionId: bootstrap.sessionId,
      sourceHash: bootstrap.sourceHash,
      stateVersion: bootstrap.stateVersion,
      token: bootstrap.token,
    }),
  );
  return `
  <style data-pi-canvas-ignore-layout="true">
    #pi-canvas-review-dock { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: min(320px, calc(100vw - 32px)); font: 13px var(--pc-font-ui, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); color: var(--pc-text, #16212d); }
    #pi-canvas-review-dock[data-open="false"] .pi-review-panel { display: none; }
    #pi-canvas-review-dock button, #pi-canvas-review-dock textarea { font: inherit; }
    .pi-review-toggle { float: right; border: 1px solid var(--pc-border-strong, #8fa0af); border-radius: 6px; background: var(--pc-surface, #ffffff); color: var(--pc-text, #16212d); padding: 7px 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14); cursor: pointer; }
    .pi-review-panel { clear: both; margin-top: 8px; border: 1px solid var(--pc-border, #bfccd7); border-radius: 8px; background: var(--pc-surface, #ffffff); box-shadow: 0 14px 34px rgba(15, 23, 42, 0.18); padding: 10px; display: grid; gap: 8px; }
    .pi-review-panel label { font-weight: 700; font-size: 12px; color: var(--pc-text-muted, #334252); }
    .pi-review-panel textarea { width: 100%; box-sizing: border-box; min-height: 78px; resize: vertical; border: 1px solid var(--pc-border-strong, #aebdca); border-radius: 6px; padding: 8px; color: var(--pc-text, #16212d); background: var(--pc-surface, #fbfdff); }
    .pi-review-target { display: grid; gap: 5px; }
    .pi-review-target-row { display: flex; align-items: center; gap: 8px; }
    .pi-review-target button { border: 1px solid var(--pc-border-strong, #8fa0af); border-radius: 6px; background: var(--pc-surface, #ffffff); color: var(--pc-text, #16212d); padding: 6px 8px; cursor: pointer; }
    .pi-review-target-output { color: var(--pc-text-muted, #4b5b6a); font-size: 12px; overflow-wrap: anywhere; }
    .pi-review-submit { border: 1px solid var(--pc-accent, #0f766e); border-radius: 6px; background: var(--pc-accent, #0f766e); color: var(--pc-on-accent, #ffffff); padding: 7px 10px; cursor: pointer; font-weight: 700; }
    .pi-review-status { min-height: 18px; color: var(--pc-text-muted, #4b5b6a); font-size: 12px; overflow-wrap: anywhere; }
  </style>
  <aside id="pi-canvas-review-dock" data-testid="pi-review-dock" data-open="false" data-note-count="0" data-pi-canvas-ignore-layout="true" aria-label="Pi canvas review notes">
    <button class="pi-review-toggle" type="button" data-testid="pi-review-toggle" aria-expanded="false">Review</button>
    <div class="pi-review-panel" role="group" aria-label="Review note">
      <label for="pi-canvas-review-note">Review note</label>
      <textarea id="pi-canvas-review-note" data-testid="pi-review-note" placeholder="Leave feedback for the agent"></textarea>
      <div class="pi-review-target">
        <div class="pi-review-target-row">
          <button type="button" data-testid="pi-review-pick-target">Pick target</button>
          <span data-testid="pi-review-target-kind">target: page</span>
        </div>
        <div class="pi-review-target-output" data-testid="pi-review-target-summary">page</div>
      </div>
      <button class="pi-review-submit" type="button" data-testid="pi-review-submit">Send to Pi</button>
      <div class="pi-review-status" data-testid="pi-review-status">review notes are receipt evidence, not canvas state</div>
    </div>
  </aside>
  <script data-pi-canvas-ignore-layout="true">
    (() => {
      const bootstrap = JSON.parse(${JSON.stringify(encodedBootstrap)});
      const dock = document.querySelector('[data-testid="pi-review-dock"]');
      const toggle = document.querySelector('[data-testid="pi-review-toggle"]');
      const note = document.querySelector('[data-testid="pi-review-note"]');
      const pickTarget = document.querySelector('[data-testid="pi-review-pick-target"]');
      const targetKind = document.querySelector('[data-testid="pi-review-target-kind"]');
      const targetSummary = document.querySelector('[data-testid="pi-review-target-summary"]');
      const submit = document.querySelector('[data-testid="pi-review-submit"]');
      const status = document.querySelector('[data-testid="pi-review-status"]');
      if (!dock || !toggle || !note || !pickTarget || !targetKind || !targetSummary || !submit || !status) return;
      let selectedTarget = { kind: 'page' };
      let pickingTarget = false;

      function setOpen(open) {
        dock.dataset.open = open ? 'true' : 'false';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) note.focus();
      }

      function currentStateVersion() {
        const appVersion = Number(document.querySelector('#app')?.dataset?.stateVersion || bootstrap.stateVersion);
        return Number.isFinite(appVersion) ? appVersion : bootstrap.stateVersion;
      }

      function textSummary(el) {
        return String((el && (el.innerText || el.textContent)) || '').trim().replace(/\s+/g, ' ').slice(0, 240);
      }

      function selectorFor(el) {
        if (!el || !(el instanceof HTMLElement)) return '';
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
        if (el.id) return '#' + el.id.replace(/"/g, '\\"');
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (!parent || parent === document.body) return tag;
        const siblings = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
        const index = siblings.indexOf(el);
        return tag + (siblings.length > 1 ? ':nth-of-type(' + String(index + 1) + ')' : '');
      }

      function targetForElement(el) {
        if (!el || !(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return { kind: 'page' };
        return {
          kind: 'element',
          testId: el.getAttribute('data-testid') || '',
          id: el.id || '',
          tag: el.tagName.toLowerCase(),
          selector: selectorFor(el),
          text: textSummary(el)
        };
      }

      function setSelectedTarget(target) {
        selectedTarget = target && target.kind ? target : { kind: 'page' };
        targetKind.textContent = 'target: ' + selectedTarget.kind;
        targetSummary.textContent =
          selectedTarget.kind === 'element'
            ? (selectedTarget.testId || selectedTarget.selector || selectedTarget.tag || 'element') + (selectedTarget.text ? ' / ' + selectedTarget.text : '')
            : selectedTarget.kind === 'selection'
              ? selectedTarget.text
              : 'page';
      }

      function currentTarget() {
        if (selectedTarget && selectedTarget.kind !== 'page') return selectedTarget;
        const selection = String(window.getSelection?.().toString() || '').trim();
        if (selection) return { kind: 'selection', text: selection.slice(0, 240) };
        const active = document.activeElement;
        if (active && active instanceof HTMLElement && !dock.contains(active) && active !== document.body && active !== document.documentElement) {
          return targetForElement(active);
        }
        return { kind: 'page' };
      }

      toggle.addEventListener('click', () => setOpen(dock.dataset.open !== 'true'));
      pickTarget.addEventListener('click', () => {
        pickingTarget = true;
        status.textContent = 'click an artifact element to target this note';
      });
      document.addEventListener('click', (event) => {
        if (!pickingTarget) return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || dock.contains(target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        pickingTarget = false;
        setSelectedTarget(targetForElement(target));
        status.textContent = 'review target selected';
      }, true);
      submit.addEventListener('click', async () => {
        const text = String(note.value || '').trim();
        if (!text) {
          status.textContent = 'review note is required';
          return;
        }
        submit.disabled = true;
        status.textContent = 'sending review note to Pi...';
        try {
          const response = await fetch('/session/' + bootstrap.sessionId + '/review-note', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-pi-canvas-token': bootstrap.token },
            body: JSON.stringify({
              artifactId: bootstrap.artifactId,
              sessionId: bootstrap.sessionId,
              sourceHash: bootstrap.sourceHash,
              stateVersion: currentStateVersion(),
              origin: window.location.origin,
              text,
              target: currentTarget()
            })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'review note rejected');
          dock.dataset.noteCount = String(result.reviewNoteCount || 1);
          note.value = '';
          status.textContent = 'review note recorded for agent';
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          submit.disabled = false;
        }
      });
    })();
  </script>`;
}

function renderBrowserHostLayoutAuditClient(bootstrap: BrowserHostBootstrap): string {
  const encodedBootstrap = escapeScriptJson(
    JSON.stringify({
      artifactId: bootstrap.artifactId,
      sessionId: bootstrap.sessionId,
      sourceHash: bootstrap.sourceHash,
      stateVersion: bootstrap.stateVersion,
      token: bootstrap.token,
    }),
  );
  return `
  <script data-pi-canvas-ignore-layout="true">
    (() => {
      const bootstrap = JSON.parse(${JSON.stringify(encodedBootstrap)});
      const root = document.documentElement;
      root.dataset.piCanvasLayoutAuditStatus = 'pending';
      let inFlight = false;
      let rerunAfterFlight = false;
      let scheduledTimer = 0;
      let lastReportedVersion = null;

      function currentStateVersion() {
        const appVersion = Number(document.querySelector('#app')?.dataset?.stateVersion || bootstrap.stateVersion);
        return Number.isFinite(appVersion) ? appVersion : bootstrap.stateVersion;
      }

      function waitFrames(count) {
        return new Promise((resolve) => {
          function step(remaining) {
            if (remaining <= 0) {
              resolve();
              return;
            }
            window.requestAnimationFrame(() => step(remaining - 1));
          }
          step(count);
        });
      }

      function text(el) {
        return String((el && (el.innerText || el.textContent)) || '').trim().replace(/\\s+/g, ' ');
      }

      function isIgnored(el) {
        return Boolean(el && el.closest && el.closest('[data-pi-canvas-ignore-layout="true"]'));
      }

      function selector(el) {
        if (!el || el.nodeType !== 1) return '';
        const id = el.getAttribute('id');
        if (id) return '#' + id.replace(/"/g, '\\\\"').slice(0, 260);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + testId.replace(/"/g, '\\\\"').slice(0, 240) + '"]';
        return String(el.tagName || 'element').toLowerCase();
      }

      function isVisible(el, rect) {
        if (!el || rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      function isIntentionalTextTruncation(style) {
        return style.textOverflow === 'ellipsis' || Number.parseInt(style.webkitLineClamp || '0', 10) > 0;
      }

      function isIntentionalScroller(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        const style = getComputedStyle(el);
        return style.overflowX === 'auto' || style.overflowX === 'scroll';
      }

      function roundPx(value) {
        return Math.round(Math.max(0, Number(value) || 0) * 10) / 10;
      }

      function audit() {
        const findings = [];
        const seen = new Set();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        function push(finding) {
          if (findings.length >= 80) return;
          const key = finding.kind + ':' + finding.selector;
          if (seen.has(key)) return;
          seen.add(key);
          findings.push({
            kind: finding.kind,
            selector: finding.selector || 'unknown',
            severity: finding.severity === 'warning' ? 'warning' : 'error',
            overflowPx: roundPx(finding.overflowPx),
            viewportWidth,
            viewportHeight
          });
        }

        const pageOverflowPx = document.documentElement.scrollWidth - viewportWidth;
        if (pageOverflowPx > 4) {
          push({ kind: 'page-horizontal-overflow', selector: 'html', overflowPx: pageOverflowPx, severity: 'error' });
        }

        const elements = [document.body, ...Array.from(document.body ? document.body.querySelectorAll('*') : [])].filter((el) => el && !isIgnored(el));
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          if (!isVisible(el, rect) || isIntentionalScroller(el)) continue;
          const style = getComputedStyle(el);
          const readable = text(el).length > 0;
          const horizontalClipPx = el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : 0;
          const verticalClipPx = el.clientHeight > 0 ? el.scrollHeight - el.clientHeight : 0;
          if (horizontalClipPx > 4 && readable && (style.overflowX === 'hidden' || style.overflowX === 'clip') && !isIntentionalTextTruncation(style)) {
            push({ kind: 'clipped-text', selector: selector(el), overflowPx: horizontalClipPx, severity: 'error' });
          }
          if (verticalClipPx > 4 && readable && (style.overflowY === 'hidden' || style.overflowY === 'clip') && !isIntentionalTextTruncation(style)) {
            push({ kind: 'clipped-text', selector: selector(el), overflowPx: verticalClipPx, severity: 'error' });
          }
        }
        return findings;
      }

      async function report() {
        const stateVersion = currentStateVersion();
        if (inFlight) {
          rerunAfterFlight = true;
          return;
        }
        inFlight = true;
        rerunAfterFlight = false;
        try {
          try {
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
          } catch {
            // Font readiness is best-effort; animation frames still give layout a chance to settle.
          }
          await waitFrames(2);
          const settledVersion = currentStateVersion();
          if (settledVersion !== stateVersion) {
            scheduleReport();
            return;
          }
          const findings = audit();
          const response = await fetch('/session/' + bootstrap.sessionId + '/layout-audit', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-pi-canvas-token': bootstrap.token },
            body: JSON.stringify({
              artifactId: bootstrap.artifactId,
              sessionId: bootstrap.sessionId,
              sourceHash: bootstrap.sourceHash,
              stateVersion,
              origin: window.location.origin,
              findings
            })
          });
          const result = await response.json();
          if (!response.ok && currentStateVersion() !== stateVersion) {
            scheduleReport();
            return;
          }
          if (!response.ok) throw new Error(result.error || 'layout audit rejected');
          lastReportedVersion = stateVersion;
          root.dataset.piCanvasLayoutAuditStatus = result.errorCount > 0 ? 'reported-with-errors' : 'reported';
          root.dataset.piCanvasLayoutAuditStateVersion = String(stateVersion);
          root.dataset.piCanvasLayoutAuditFindingCount = String(result.findingCount || 0);
          root.dataset.piCanvasLayoutAuditErrorCount = String(result.errorCount || 0);
        } catch (error) {
          root.dataset.piCanvasLayoutAuditStatus = 'error';
          root.dataset.piCanvasLayoutAuditError = error instanceof Error ? error.message : String(error);
        } finally {
          inFlight = false;
          if (rerunAfterFlight && currentStateVersion() !== lastReportedVersion) scheduleReport();
        }
      }

      function scheduleReport() {
        const version = currentStateVersion();
        if (version === lastReportedVersion && root.dataset.piCanvasLayoutAuditStatus !== 'error') return;
        root.dataset.piCanvasLayoutAuditStatus = 'pending';
        if (scheduledTimer) window.clearTimeout(scheduledTimer);
        scheduledTimer = window.setTimeout(() => {
          scheduledTimer = 0;
          void report();
        }, 40);
      }

      function observeArtifact() {
        const app = document.querySelector('#app');
        if (!app || typeof MutationObserver === 'undefined') return;
        const observer = new MutationObserver(() => scheduleReport());
        observer.observe(app, { attributes: true, childList: true, characterData: true, subtree: true });
      }

      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { observeArtifact(); scheduleReport(); }, { once: true });
      else { observeArtifact(); scheduleReport(); }
    })();
  </script>`;
}

function readBrowserHostView(readback: CanvasReadback): BrowserHostViewResolution {
  const view = readback.source.view;
  if (view?.kind === BROWSER_HOST_ARTIFACT_VIEW_KIND) {
    return { view, rendererId: view.rendererId, rendererVersion: view.rendererVersion };
  }
  throw new Error(`Canvas view requires browser host metadata: ${view?.kind ?? "missing"}`);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8");
    receivedBytes += buffer.byteLength;
    if (receivedBytes > BROWSER_HOST_REQUEST_BODY_LIMIT_BYTES) {
      throw new BrowserHostRequestError(413, "body_too_large", "Browser host request body is too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, receivedBytes).toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrowserHostRequestError(400, "body_invalid_json", "Browser host request body must be valid JSON");
  }
  if (!isJsonObject(parsed)) {
    throw new BrowserHostRequestError(400, "body_invalid", "Browser host request body must be a JSON object");
  }
  return parsed;
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function parseBrowserHostLayoutFindings(value: JsonValue | undefined): BrowserHostLayoutFindingReceipt[] {
  if (!Array.isArray(value)) {
    throw new BrowserHostRequestError(409, "layout_audit_invalid", "Browser host layout audit findings must be an array");
  }
  if (value.length > 100) {
    throw new BrowserHostRequestError(409, "layout_audit_invalid", "Browser host layout audit has too many findings");
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new BrowserHostRequestError(409, "layout_audit_invalid", `Browser host layout audit finding ${index} must be an object`);
    }
    const kind = readBoundedLayoutAuditString(item, "kind", 80);
    const selector = readBoundedLayoutAuditString(item, "selector", 300);
    const severity = readString(item, "severity");
    const overflowPx = readNumber(item, "overflowPx");
    const viewportWidth = readOptionalBoundedLayoutAuditNumber(item, "viewportWidth", 10_000);
    const viewportHeight = readOptionalBoundedLayoutAuditNumber(item, "viewportHeight", 10_000);
    if (!kind) {
      throw new BrowserHostRequestError(409, "layout_audit_invalid", `Browser host layout audit finding ${index} requires kind`);
    }
    if (!selector) {
      throw new BrowserHostRequestError(409, "layout_audit_invalid", `Browser host layout audit finding ${index} requires selector`);
    }
    if (severity !== "warning" && severity !== "error") {
      throw new BrowserHostRequestError(409, "layout_audit_invalid", `Browser host layout audit finding ${index} has invalid severity`);
    }
    if (overflowPx === undefined || !Number.isFinite(overflowPx) || overflowPx < 0 || overflowPx > 100_000) {
      throw new BrowserHostRequestError(409, "layout_audit_invalid", `Browser host layout audit finding ${index} has invalid overflowPx`);
    }
    return {
      kind,
      selector,
      severity,
      overflowPx,
      ...(viewportWidth === undefined ? {} : { viewportWidth }),
      ...(viewportHeight === undefined ? {} : { viewportHeight }),
    };
  });
}

function readBoundedLayoutAuditString(value: JsonObject, key: string, maxLength: number): string | undefined {
  const text = readString(value, key);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new BrowserHostRequestError(409, "layout_audit_invalid", `Browser host layout audit ${key} is too long`);
  }
  return trimmed;
}

function readOptionalBoundedLayoutAuditNumber(value: JsonObject, key: string, max: number): number | undefined {
  const number = readNumber(value, key);
  if (number === undefined) return undefined;
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new BrowserHostRequestError(409, "layout_audit_invalid", `Browser host layout audit ${key} is invalid`);
  }
  return number;
}

function parseBrowserReviewNoteTarget(value: JsonValue | undefined): JsonObject {
  if (value === undefined || value === null) return { kind: "page" };
  if (!isJsonObject(value)) {
    throw new BrowserHostRequestError(409, "review_target_invalid", "Browser host review note target must be an object");
  }
  const kind = readString(value, "kind") ?? "page";
  if (kind === "page") return { kind: "page" };
  if (kind === "selection") {
    const text = readBoundedReviewTargetString(value, "text", 240);
    if (!text) {
      throw new BrowserHostRequestError(409, "review_target_invalid", "Browser host selection review target requires text");
    }
    return { kind, text };
  }
  if (kind === "element") {
    const testId = readBoundedReviewTargetString(value, "testId", 160);
    const id = readBoundedReviewTargetString(value, "id", 160);
    const tag = readBoundedReviewTargetString(value, "tag", 80);
    const selector = readBoundedReviewTargetString(value, "selector", 400);
    const text = readBoundedReviewTargetString(value, "text", 240);
    if (!testId && !id && !tag && !selector) {
      throw new BrowserHostRequestError(409, "review_target_invalid", "Browser host element review target requires an identifier");
    }
    return {
      kind,
      ...(testId === undefined ? {} : { testId }),
      ...(id === undefined ? {} : { id }),
      ...(tag === undefined ? {} : { tag }),
      ...(selector === undefined ? {} : { selector }),
      ...(text === undefined ? {} : { text }),
    };
  }
  throw new BrowserHostRequestError(409, "review_target_invalid", `Browser host review note target kind is invalid: ${kind}`);
}

function reviewNoteTargetKey(target: JsonObject): string {
  const kind = readString(target, "kind") ?? "page";
  if (kind === "page") return "page";
  if (kind === "selection") {
    const text = readString(target, "text") ?? "";
    return `selection:${sha256(text).slice(0, 12)}`;
  }
  if (kind === "element") {
    const testId = readString(target, "testId");
    if (testId) return `element:testId:${reviewTargetKeyPart(testId)}`;
    const id = readString(target, "id");
    if (id) return `element:id:${reviewTargetKeyPart(id)}`;
    const selector = readString(target, "selector");
    if (selector) return `element:selector:${sha256(selector).slice(0, 12)}`;
    const tag = readString(target, "tag");
    if (tag) return `element:tag:${reviewTargetKeyPart(tag)}`;
  }
  return `${kind}:${sha256(JSON.stringify(target)).slice(0, 12)}`;
}

function reviewTargetKeyPart(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length > 0 && normalized.length <= 80) return normalized;
  return sha256(value).slice(0, 12);
}

function readBoundedReviewTargetString(value: JsonObject, key: string, maxLength: number): string | undefined {
  const text = readString(value, key);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new BrowserHostRequestError(409, "review_target_invalid", `Browser host review target ${key} is too long`);
  }
  return trimmed;
}


function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });
}

function redactBrowserHostUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.delete("token");
  return url.toString();
}

function browserHostResponseHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function pushBounded<T>(values: T[], value: T, limit: number): void {
  values.push(value);
  if (values.length > limit) {
    values.splice(0, values.length - limit);
  }
}

function escapeScriptJson(value: string): string {
  return value.replaceAll("</", "<\\/");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

class BrowserHostRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly rendererActionType?: string,
    readonly sourceHash?: string,
    readonly afterVersion?: number,
  ) {
    super(message);
  }
}

export class BrowserHostSessionManager {
  private readonly sessions = new Map<string, LocalBrowserHostSession>();
  private readonly inflight = new Map<string, Promise<LocalBrowserHostSession>>();
  private readonly maxOpenSessions: number;

  constructor(options: { maxOpenSessions?: number } = {}) {
    const maxOpenSessions = options.maxOpenSessions ?? 8;
    if (!Number.isInteger(maxOpenSessions) || maxOpenSessions < 1) {
      throw new Error("Browser host maxOpenSessions must be a positive integer");
    }
    this.maxOpenSessions = maxOpenSessions;
  }

  async getOrStart(key: string, options: BrowserHostSessionOptions): Promise<LocalBrowserHostSession> {
    const existing = this.sessions.get(key);
    if (existing && existing.receipt.status !== "closed") {
      const readback = await options.runtime.read(options.artifactId);
      if (readback && existing.canFocusFor(readback)) {
        await existing.focus();
        return existing;
      }
      await existing.close();
      this.sessions.delete(key);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const started = LocalBrowserHostSession.start(options)
      .then(async (session) => {
        this.sessions.set(key, session);
        await this.closeOverflowSessions(key);
        return session;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, started);
    return started;
  }

  private async closeOverflowSessions(currentKey: string): Promise<void> {
    let openCount = [...this.sessions.values()].filter((session) => session.receipt.status !== "closed").length;
    if (openCount <= this.maxOpenSessions) return;
    for (const [key, session] of this.sessions) {
      if (openCount <= this.maxOpenSessions) return;
      if (key === currentKey || session.receipt.status === "closed") continue;
      await session.close();
      this.sessions.delete(key);
      openCount -= 1;
    }
  }
}
