import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  assertJsonObject,
  assertJsonValue,
  cloneJson,
  isJsonValue,
  isRecord,
  isSafeJsonPath,
  readActionDefinitions,
  readNumber,
  readString,
  readViewKind,
  serializeJson,
  setJsonPath,
} from "./json.js";
import { validateHtmlIframeBridgePolicy } from "./html-iframe-bridge.js";
import type {
  CanvasActionRecord,
  CanvasBrowserHostArtifactDefinition,
  CanvasHtmlIframeBridgeDefinition,
  CanvasExportResult,
  CanvasPiTuiViewDefinition,
  CanvasPaths,
  CanvasProvenanceRecord,
  CanvasReadback,
  CanvasSource,
  CanvasViewDefinition,
  CanvasStateSnapshot,
  CreateCanvasRequest,
  JsonObject,
  JsonValue,
  UpdateCanvasRequest,
} from "./types.js";
import { DEFAULT_CANVAS_RENDERER_ID, DEFAULT_CANVAS_RENDERER_VERSION } from "./types.js";

export interface CanvasStoreOptions {
  baseDir?: string;
  now?: () => Date;
}

export interface CanvasStore {
  rootDir: string;
  create(request: CreateCanvasRequest): Promise<CanvasReadback>;
  update(request: UpdateCanvasRequest): Promise<CanvasReadback>;
  read(artifactId: string): Promise<CanvasReadback | undefined>;
  export(artifactId: string, targetDir?: string): Promise<CanvasExportResult | undefined>;
  listArtifactIds(): Promise<string[]>;
}

interface PendingCanvasUpdateCommit {
  kind: "update";
  state: CanvasStateSnapshot;
  action: CanvasActionRecord;
  provenance: CanvasProvenanceRecord;
}

// Only "update" pending commits are produced now that the legacy source
// migrations are gone; the provenance event:"migrate" reader stays for historical
// on-disk logs (parseCanvasProvenance).
type PendingCanvasCommit = PendingCanvasUpdateCommit;

export function createCanvasStore(cwd: string, options: CanvasStoreOptions = {}): CanvasStore {
  const rootDir = options.baseDir ?? join(getAgentDir(), "pi-canvas");
  const cwdHash = sha256(cwd).slice(0, 16);
  const artifactsDir = join(rootDir, cwdHash, "artifacts");
  const now = options.now ?? (() => new Date());
  const locks = new Map<string, Promise<void>>();

  const pathsFor = (artifactId: string): CanvasPaths => {
    const artifactDir = join(artifactsDir, artifactId);
    return {
      artifactDir,
      sourcePath: join(artifactDir, "canvas.source.json"),
      statePath: join(artifactDir, "canvas.state.json"),
      actionsPath: join(artifactDir, "canvas.actions.jsonl"),
      provenancePath: join(artifactDir, "canvas.provenance.jsonl"),
    };
  };

  const withArtifactLock = async <T>(artifactId: string, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(artifactId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const chained = previous.catch(() => undefined).then(() => next);
    locks.set(artifactId, chained);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (locks.get(artifactId) === chained) {
        locks.delete(artifactId);
      }
    }
  };

  const readUnlocked = async (artifactId: string): Promise<CanvasReadback | undefined> => {
    if (!isSafeArtifactId(artifactId)) return undefined;
    const paths = pathsFor(artifactId);
    try {
      await recoverPendingCommit(paths);
      const source = parseCanvasSource(await readJson(paths.sourcePath));
      const state = parseCanvasState(await readJson(paths.statePath));
      if (!source || !state || source.artifactId !== artifactId || state.artifactId !== artifactId) {
        return undefined;
      }
      assertSourceHashMatchesState(source, state);
      assertStateMatchesSchema(source.stateSchema, state.state, "state");
      const latestProvenance = await readLatestProvenance(paths.provenancePath);
      return latestProvenance ? { source, state, latestProvenance, paths } : { source, state, paths };
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  };

  return {
    rootDir,

    async create(request: CreateCanvasRequest): Promise<CanvasReadback> {
      assertSafeOptionalArtifactId(request.artifactId);
      assertJsonValue(request.initialState, "initialState");
      const stateSchema = request.stateSchema ?? {};
      assertJsonObject(stateSchema, "stateSchema");
      assertStateMatchesSchema(stateSchema, request.initialState, "initialState");
      if (request.viewProps !== undefined) {
        assertJsonObject(request.viewProps, "viewProps");
      }
      const timestamp = now().toISOString();
      const artifactId = request.artifactId ?? `canvas-${sha256(`${request.title}:${timestamp}:${randomUUID()}`).slice(0, 12)}`;
      return withArtifactLock(artifactId, async () => {
        const paths = pathsFor(artifactId);
        if (await artifactExists(paths)) {
          throw new Error(`Canvas artifact already exists: ${artifactId}`);
        }
        const actions = request.actions ? request.actions.map((action) => ({ ...action })) : [{ type: "set" as const, path: "value", label: "Set value" }];
        for (const action of actions) {
          assertSafeJsonPath(action.path, "canvas action path");
        }
        const view = buildCanvasViewDefinition(request);
        const viewKind = request.viewKind ?? view.kind;
        if (view.kind !== viewKind) {
          throw new Error(`Canvas view kind mismatch: ${view.kind} cannot be stored as ${viewKind}`);
        }
        const source: CanvasSource = {
          artifactId,
          schemaVersion: 2,
          title: request.title,
          viewKind,
          view,
          stateSchema: cloneJson(stateSchema),
          initialState: cloneJson(request.initialState),
          actions,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const sourceHash = sha256(serializeJson(source));
        const state: CanvasStateSnapshot = {
          artifactId,
          version: 1,
          sourceHash,
          state: cloneJson(request.initialState),
          updatedAt: timestamp,
        };
        const provenance: CanvasProvenanceRecord = {
          id: `prov-${sha256(`${artifactId}:create:${timestamp}`).slice(0, 16)}`,
          artifactId,
          event: "create",
          sourceHash,
          createdAt: timestamp,
          afterVersion: 1,
          afterState: cloneJson(state.state),
        };
        await writeJson(paths.sourcePath, source);
        await writeJson(paths.statePath, state);
        await writeText(paths.actionsPath, "");
        await appendJsonLine(paths.provenancePath, provenance);
        return { source, state, latestProvenance: provenance, paths };
      });
    },

    async update(request: UpdateCanvasRequest): Promise<CanvasReadback> {
      assertSafeArtifactId(request.artifactId);
      assertJsonValue(request.value, "value");
      assertSafeJsonPath(request.path, "canvas update path");
      assertUpdateExpectation(request);
      return withArtifactLock(request.artifactId, async () => {
        const current = await readUnlocked(request.artifactId);
        if (!current) {
          throw new Error(`Canvas artifact not found: ${request.artifactId}`);
        }
        assertUpdateExpectationMatches(request, current.state);
        assertDeclaredActionPath(current.source, request.path);
        const timestamp = now().toISOString();
        const action: CanvasActionRecord = {
          id: `act-${sha256(`${request.artifactId}:${request.path}:${timestamp}:${randomUUID()}`).slice(0, 16)}`,
          artifactId: request.artifactId,
          type: "set",
          path: request.path,
          value: cloneJson(request.value),
          actor: request.actor ?? "user",
          createdAt: timestamp,
        };
        const beforeState = cloneJson(current.state.state);
        const afterState = setJsonPath(current.state.state, request.path, request.value);
        assertStateMatchesSchema(current.source.stateSchema, afterState, "state");
        const nextState: CanvasStateSnapshot = {
          ...current.state,
          version: current.state.version + 1,
          state: afterState,
          updatedAt: timestamp,
        };
        const provenance: CanvasProvenanceRecord = {
          id: `prov-${sha256(`${action.id}:update`).slice(0, 16)}`,
          artifactId: request.artifactId,
          event: "update",
          sourceHash: current.state.sourceHash,
          createdAt: timestamp,
          actionId: action.id,
          beforeVersion: current.state.version,
          afterVersion: nextState.version,
          beforeState,
          afterState: cloneJson(afterState),
        };
        await commitUpdate(current.paths, { kind: "update", state: nextState, action, provenance });
        return { source: current.source, state: nextState, latestProvenance: provenance, paths: current.paths };
      });
    },

    async read(artifactId: string): Promise<CanvasReadback | undefined> {
      if (!isSafeArtifactId(artifactId)) return undefined;
      return withArtifactLock(artifactId, () => readUnlocked(artifactId));
    },

    async export(artifactId: string, targetDir?: string): Promise<CanvasExportResult | undefined> {
      assertSafeArtifactId(artifactId);
      return withArtifactLock(artifactId, async () => {
        const current = await readUnlocked(artifactId);
        if (!current) return undefined;
        const timestampDate = now();
        const timestamp = safeTimestamp(timestampDate);
        const exportDir = resolveExportDir(cwd, artifactId, timestamp, targetDir);
        const sourcePath = join(exportDir, "canvas.source.json");
        const statePath = join(exportDir, "canvas.state.json");
        const provenancePath = join(exportDir, "canvas.provenance.jsonl");
        const sourceDiffPath = join(exportDir, "source.diff");
        const stateDiffPath = join(exportDir, "state.diff");
        const provenance: CanvasProvenanceRecord = {
          id: `prov-${sha256(`${artifactId}:export:${timestamp}`).slice(0, 16)}`,
          artifactId,
          event: "export",
          sourceHash: current.state.sourceHash,
          createdAt: timestampDate.toISOString(),
          afterVersion: current.state.version,
          afterState: cloneJson(current.state.state),
          exportDir,
        };
        const provenanceLog = await readValidProvenanceLog(current.paths.provenancePath);
        await writeJson(sourcePath, current.source);
        await writeJson(statePath, current.state);
        await writeText(provenancePath, `${provenanceLog}${JSON.stringify(provenance)}\n`);
        await writeText(sourceDiffPath, addedDiff("canvas.source.json", serializeJson(current.source)));
        await writeText(stateDiffPath, stateDiff(current.latestProvenance, current.state.state));
        await appendJsonLine(current.paths.provenancePath, provenance);
        return { artifactId, exportDir, sourcePath, statePath, provenancePath, sourceDiffPath, stateDiffPath };
      });
    },

    async listArtifactIds(): Promise<string[]> {
      try {
        const entries = await readdir(artifactsDir, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory() && isSafeArtifactId(entry.name)).map((entry) => entry.name).sort();
      } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) return [];
        throw error;
      }
    },
  };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildCanvasViewDefinition(request: CreateCanvasRequest): CanvasViewDefinition {
  if (request.view !== undefined) {
    assertCanvasViewDefinition(request.view);
    return cloneCanvasViewDefinition(request.view);
  }
  if (request.viewKind === "html-iframe-state-bridge") {
    throw new Error("HTML iframe canvas view requires explicit view metadata");
  }
  return {
    kind: "pi-tui-component",
    rendererId: request.rendererId ?? DEFAULT_CANVAS_RENDERER_ID,
    rendererVersion: request.rendererVersion ?? DEFAULT_CANVAS_RENDERER_VERSION,
    ...(request.viewProps === undefined ? {} : { props: cloneJson(request.viewProps) }),
  };
}

function assertCanvasViewDefinition(view: CanvasViewDefinition): void {
  if (view.kind === "pi-tui-component") {
    if (!parsePiTuiViewDefinition(view)) {
      throw new Error("Invalid Pi TUI canvas view metadata");
    }
    return;
  }
  if (view.kind === "html-iframe-state-bridge") {
    const parsed = parseHtmlIframeBridgeDefinition(view);
    if (!parsed) {
      throw new Error("Invalid HTML iframe canvas view metadata");
    }
    const policy = validateHtmlIframeBridgePolicy(parsed);
    if (!policy.ok) {
      throw new Error(`Invalid HTML iframe sandbox policy: ${policy.reasons.join("; ")}`);
    }
    return;
  }
  if (view.kind === "browser-host-artifact") {
    if (!parseBrowserHostArtifactDefinition(view)) {
      throw new Error("Invalid browser host artifact view metadata");
    }
    return;
  }
  throw new Error(`Unsupported canvas view kind: ${String((view as { kind?: unknown }).kind)}`);
}

function cloneCanvasViewDefinition(view: CanvasViewDefinition): CanvasViewDefinition {
  if (view.kind === "html-iframe-state-bridge") {
    return {
      kind: view.kind,
      bridgeVersion: view.bridgeVersion,
      host: view.host,
      fallback: view.fallback,
      transport: view.transport,
      sandbox: [...view.sandbox],
      csp: view.csp,
      permissions: [...view.permissions],
      actionSchema: cloneJson(view.actionSchema),
      ...(view.htmlSourceHash === undefined ? {} : { htmlSourceHash: view.htmlSourceHash }),
      ...(view.props === undefined ? {} : { props: cloneJson(view.props) }),
    };
  }
  if (view.kind === "browser-host-artifact") {
    return {
      kind: view.kind,
      bridgeVersion: view.bridgeVersion,
      host: view.host,
      fallback: view.fallback,
      transport: view.transport,
      rendererId: view.rendererId,
      rendererVersion: view.rendererVersion,
      ...(view.props === undefined ? {} : { props: cloneJson(view.props) }),
    };
  }
  return {
    kind: view.kind,
    rendererId: view.rendererId,
    rendererVersion: view.rendererVersion,
    ...(view.props === undefined ? {} : { props: cloneJson(view.props) }),
  };
}

async function artifactExists(paths: CanvasPaths): Promise<boolean> {
  return (await pathExists(paths.sourcePath)) || (await pathExists(paths.statePath)) || (await pathExists(paths.actionsPath)) || (await pathExists(paths.provenancePath));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function commitUpdate(paths: CanvasPaths, commit: PendingCanvasCommit): Promise<void> {
  const pendingPath = pendingCommitPath(paths);
  await writeText(pendingPath, `${JSON.stringify(commit, null, 2)}\n`);
  await applyPendingCommit(paths, commit);
  await rm(pendingPath, { force: true });
}

async function recoverPendingCommit(paths: CanvasPaths): Promise<void> {
  const pendingPath = pendingCommitPath(paths);
  let raw: string;
  try {
    raw = await readFile(pendingPath, "utf-8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  const parsed = parsePendingCommit(JSON.parse(raw));
  if (!parsed) {
    throw new Error(`Invalid pending canvas commit: ${pendingPath}`);
  }
  await applyPendingCommit(paths, parsed);
  await rm(pendingPath, { force: true });
}

async function applyPendingCommit(paths: CanvasPaths, commit: PendingCanvasCommit): Promise<void> {
  await writeJson(paths.statePath, commit.state);
  if (!(await jsonLineLogContainsId(paths.actionsPath, commit.action.id))) {
    await appendJsonLine(paths.actionsPath, commit.action);
  }
  if (!(await jsonLineLogContainsId(paths.provenancePath, commit.provenance.id))) {
    await appendJsonLine(paths.provenancePath, commit.provenance);
  }
}

async function jsonLineLogContainsId(path: string, id: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf-8");
    for (const line of raw.split("\n").filter(Boolean)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (isRecord(parsed) && parsed.id === id) return true;
    }
    return false;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function pendingCommitPath(paths: CanvasPaths): string {
  return join(paths.artifactDir, "canvas.pending.json");
}

function parsePendingCommit(value: unknown): PendingCanvasCommit | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "update") {
    const state = parseCanvasState(value.state);
    const action = parseCanvasAction(value.action);
    const provenance = parseCanvasProvenance(value.provenance);
    if (!state || !action || !provenance || provenance.event !== "update") return undefined;
    return { kind: "update", state, action, provenance };
  }
  return undefined;
}

function parseCanvasAction(value: unknown): CanvasActionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, "id");
  const artifactId = readString(value, "artifactId");
  const type = value.type === "set" ? value.type : undefined;
  const path = readString(value, "path");
  const actor = readString(value, "actor");
  const createdAt = readString(value, "createdAt");
  if (!id || !artifactId || !type || !path || !actor || !createdAt || !isJsonValue(value.value)) {
    return undefined;
  }
  return { id, artifactId, type, path, value: value.value, actor, createdAt };
}

function assertDeclaredActionPath(source: CanvasSource, path: string): void {
  if (!source.actions.some((action) => action.path === path)) {
    throw new Error(`Canvas update path is not declared in source.actions: ${path}`);
  }
}

function assertSourceHashMatchesState(source: CanvasSource, state: CanvasStateSnapshot): void {
  const actualSourceHash = sha256(serializeJson(source));
  if (actualSourceHash !== state.sourceHash) {
    throw new Error("Canvas source hash mismatch");
  }
}

function assertUpdateExpectation(request: UpdateCanvasRequest): void {
  if (request.expectedSourceHash !== undefined && typeof request.expectedSourceHash !== "string") {
    throw new Error("expectedSourceHash must be a string");
  }
  if (request.expectedStateVersion !== undefined && (!Number.isInteger(request.expectedStateVersion) || request.expectedStateVersion < 1)) {
    throw new Error("expectedStateVersion must be a positive integer");
  }
}

function assertUpdateExpectationMatches(request: UpdateCanvasRequest, state: CanvasStateSnapshot): void {
  if (request.expectedSourceHash !== undefined && request.expectedSourceHash !== state.sourceHash) {
    throw new Error("Canvas source hash mismatch");
  }
  if (request.expectedStateVersion !== undefined && request.expectedStateVersion !== state.version) {
    throw new Error(`Canvas stale state version: ${request.expectedStateVersion} != ${state.version}`);
  }
}

function assertSafeJsonPath(path: string, label: string): void {
  if (!isSafeJsonPath(path)) throw new Error(`Unsafe ${label}: ${path}`);
}

function assertStateMatchesSchema(schema: JsonObject, value: JsonValue, label: string): void {
  if (Object.keys(schema).length === 0) return;
  validateStateAgainstSchema(schema, value, label);
}

function validateStateAgainstSchema(schema: JsonObject, value: JsonValue, label: string): void {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !matchesSchemaType(value, type)) {
    throw new Error(`${label} must be ${type}`);
  }
  if (Array.isArray(schema.enum) && schema.enum.every(isJsonValue) && !schema.enum.some((item) => jsonEqual(item, value))) {
    throw new Error(`${label} must match one of the allowed enum values`);
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  const properties = isJsonRecord(schema.properties) ? schema.properties : undefined;
  if ((type === "object" || required.length > 0 || properties) && !isJsonRecord(value)) {
    throw new Error(`${label} must be object`);
  }
  if (isJsonRecord(value)) {
    for (const key of required) {
      if (!(key in value)) {
        throw new Error(`${label}.${key} is required`);
      }
    }
    if (properties) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (value[key] !== undefined && isJsonRecord(childSchema)) {
          validateStateAgainstSchema(childSchema, value[key], `${label}.${key}`);
        }
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(properties));
        const extra = Object.keys(value).find((key) => !allowed.has(key));
        if (extra) {
          throw new Error(`${label}.${extra} is not allowed by stateSchema`);
        }
      }
    }
  }
  const items = isJsonRecord(schema.items) ? schema.items : undefined;
  if ((type === "array" || items) && !Array.isArray(value)) {
    throw new Error(`${label} must be array`);
  }
  if (Array.isArray(value) && items) {
    value.forEach((item, index) => validateStateAgainstSchema(items, item, `${label}.${index}`));
  }
}

function matchesSchemaType(value: JsonValue, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  if (type === "object") return isJsonRecord(value);
  if (type === "array") return Array.isArray(value);
  return true;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseCanvasSource(value: unknown): CanvasSource | undefined {
  if (!isRecord(value)) return undefined;
  const artifactId = readString(value, "artifactId");
  const schemaVersion = readNumber(value, "schemaVersion");
  const title = readString(value, "title");
  const viewKind = readViewKind(value.viewKind);
  const stateSchema = value.stateSchema;
  const initialState = value.initialState;
  const actions = readActionDefinitions(value.actions);
  const createdAt = readString(value, "createdAt");
  const updatedAt = readString(value, "updatedAt");
  if (
    !artifactId ||
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    !title ||
    !viewKind ||
    !isJsonRecord(stateSchema) ||
    !isJsonValue(initialState) ||
    !actions ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  if (schemaVersion === 1) {
    return { artifactId, schemaVersion, title, viewKind, stateSchema, initialState, actions, createdAt, updatedAt };
  }
  const view = parseCanvasViewDefinition(value.view);
  if (!view) return undefined;
  return { artifactId, schemaVersion, title, viewKind, view, stateSchema, initialState, actions, createdAt, updatedAt };
}

function parseCanvasViewDefinition(value: unknown): CanvasViewDefinition | undefined {
  const kind = isRecord(value) ? readString(value, "kind") : undefined;
  if (kind === "pi-tui-component") return parsePiTuiViewDefinition(value);
  if (kind === "html-iframe-state-bridge") return parseHtmlIframeBridgeDefinition(value);
  if (kind === "browser-host-artifact") return parseBrowserHostArtifactDefinition(value);
  return undefined;
}

function parsePiTuiViewDefinition(value: unknown): CanvasPiTuiViewDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readString(value, "kind");
  const rendererId = readString(value, "rendererId");
  const rendererVersion = readNumber(value, "rendererVersion");
  if (kind !== "pi-tui-component" || !rendererId || rendererVersion === undefined) {
    return undefined;
  }
  const parsed: CanvasViewDefinition = { kind, rendererId, rendererVersion };
  if (value.props !== undefined) {
    if (!isJsonRecord(value.props)) return undefined;
    parsed.props = value.props;
  }
  return parsed;
}

function parseHtmlIframeBridgeDefinition(value: unknown): CanvasHtmlIframeBridgeDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readString(value, "kind");
  const bridgeVersion = readNumber(value, "bridgeVersion");
  const host = readString(value, "host");
  const fallback = readString(value, "fallback");
  const transport = readString(value, "transport");
  const sandbox = readStringArray(value.sandbox);
  const csp = readString(value, "csp");
  const permissions = readStringArray(value.permissions);
  const actionSchema = isJsonRecord(value.actionSchema) ? value.actionSchema : undefined;
  if (
    kind !== "html-iframe-state-bridge" ||
    bridgeVersion !== 1 ||
    host !== "adjacent-browser-host" ||
    fallback !== "terminal-render" ||
    transport !== "postMessage-json-rpc" ||
    !sandbox ||
    !csp ||
    !permissions ||
    !actionSchema
  ) {
    return undefined;
  }
  const parsed: CanvasHtmlIframeBridgeDefinition = { kind, bridgeVersion, host, fallback, transport, sandbox, csp, permissions, actionSchema };
  const htmlSourceHash = readString(value, "htmlSourceHash");
  if (htmlSourceHash !== undefined) parsed.htmlSourceHash = htmlSourceHash;
  if (value.props !== undefined) {
    if (!isJsonRecord(value.props)) return undefined;
    parsed.props = value.props;
  }
  return parsed;
}

function parseBrowserHostArtifactDefinition(value: unknown): CanvasBrowserHostArtifactDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readString(value, "kind");
  const bridgeVersion = readNumber(value, "bridgeVersion");
  const host = readString(value, "host");
  const fallback = readString(value, "fallback");
  const transport = readString(value, "transport");
  const rendererId = readString(value, "rendererId");
  const rendererVersion = readNumber(value, "rendererVersion");
  if (
    kind !== "browser-host-artifact" ||
    bridgeVersion !== 1 ||
    host !== "local-browser-host" ||
    fallback !== "terminal-render" ||
    transport !== "http-json" ||
    !rendererId ||
    rendererVersion === undefined
  ) {
    return undefined;
  }
  const parsed: CanvasBrowserHostArtifactDefinition = { kind, bridgeVersion, host, fallback, transport, rendererId, rendererVersion };
  if (value.props !== undefined) {
    if (!isJsonRecord(value.props)) return undefined;
    parsed.props = value.props;
  }
  return parsed;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined;
}

function parseCanvasState(value: unknown): CanvasStateSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const artifactId = readString(value, "artifactId");
  const version = readNumber(value, "version");
  const sourceHash = readString(value, "sourceHash");
  const updatedAt = readString(value, "updatedAt");
  const state = value.state;
  if (!artifactId || version === undefined || !sourceHash || !updatedAt || !isJsonValue(state)) {
    return undefined;
  }
  return { artifactId, version, sourceHash, state, updatedAt };
}

function parseCanvasProvenance(value: unknown): CanvasProvenanceRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, "id");
  const artifactId = readString(value, "artifactId");
  const event = readString(value, "event");
  const sourceHash = readString(value, "sourceHash");
  const createdAt = readString(value, "createdAt");
  if (!id || !artifactId || (event !== "create" && event !== "update" && event !== "export" && event !== "migrate") || !sourceHash || !createdAt) {
    return undefined;
  }
  const record: CanvasProvenanceRecord = { id, artifactId, event, sourceHash, createdAt };
  const actionId = readString(value, "actionId");
  if (actionId !== undefined) record.actionId = actionId;
  const beforeVersion = readNumber(value, "beforeVersion");
  if (beforeVersion !== undefined) record.beforeVersion = beforeVersion;
  const afterVersion = readNumber(value, "afterVersion");
  if (afterVersion !== undefined) record.afterVersion = afterVersion;
  if (isJsonValue(value.beforeState)) record.beforeState = value.beforeState;
  if (isJsonValue(value.afterState)) record.afterState = value.afterState;
  const beforeSourceHash = readString(value, "beforeSourceHash");
  if (beforeSourceHash !== undefined) record.beforeSourceHash = beforeSourceHash;
  const afterSourceHash = readString(value, "afterSourceHash");
  if (afterSourceHash !== undefined) record.afterSourceHash = afterSourceHash;
  const exportDir = readString(value, "exportDir");
  if (exportDir !== undefined) record.exportDir = exportDir;
  return record;
}

async function readLatestProvenance(path: string): Promise<CanvasProvenanceRecord | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      let rawProvenance: unknown;
      try {
        rawProvenance = JSON.parse(line);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      const parsed = parseCanvasProvenance(rawProvenance);
      if (parsed) return parsed;
    }
    return undefined;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
  return parsed;
}

async function writeJson(path: string, value: CanvasSource | CanvasStateSnapshot): Promise<void> {
  await writeText(path, serializeJson(value));
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
}

async function appendJsonLine(path: string, value: CanvasActionRecord | CanvasProvenanceRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const separator = (await jsonLineLogNeedsSeparator(path)) ? "\n" : "";
  await appendFile(path, `${separator}${JSON.stringify(value)}\n`, "utf-8");
}

async function jsonLineLogNeedsSeparator(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (stat.size === 0) return false;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, stat.size - 1);
    return buffer[0] !== 10;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readValidProvenanceLog(path: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return "";
    throw error;
  }
  const validLines: string[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const provenance = parseCanvasProvenance(parsed);
    if (provenance) validLines.push(JSON.stringify(provenance));
  }
  return validLines.length === 0 ? "" : `${validLines.join("\n")}\n`;
}

function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function assertSafeOptionalArtifactId(artifactId: string | undefined): void {
  if (artifactId !== undefined) assertSafeArtifactId(artifactId);
}

function assertSafeArtifactId(artifactId: string): void {
  if (!isSafeArtifactId(artifactId)) {
    throw new Error(`Unsafe canvas artifact id: ${artifactId}`);
  }
}

function isSafeArtifactId(artifactId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(artifactId);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function resolveExportDir(cwd: string, artifactId: string, timestamp: string, targetDir: string | undefined): string {
  const root = resolve(cwd);
  const candidate = targetDir === undefined ? join(root, ".pi", "canvas-exports", artifactId, timestamp) : resolve(root, targetDir);
  if (!isPathInside(root, candidate)) {
    throw new Error(`Canvas export target must stay inside project cwd: ${targetDir}`);
  }
  return candidate;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function addedDiff(name: string, content: string): string {
  return [`--- /dev/null`, `+++ ${name}`, "@@", ...content.split("\n").filter((line) => line.length > 0).map((line) => `+${line}`), ""].join("\n");
}

function stateDiff(provenance: CanvasProvenanceRecord | undefined, currentState: JsonValue): string {
  const before = provenance?.beforeState ?? null;
  const after = provenance?.afterState ?? currentState;
  return [
    `--- canvas.state.before.json`,
    `+++ canvas.state.after.json`,
    "@@",
    ...prefixJsonLines("-", before),
    ...prefixJsonLines("+", after),
    "",
  ].join("\n");
}

function prefixJsonLines(prefix: "-" | "+", value: JsonValue): string[] {
  return JSON.stringify(value, null, 2).split("\n").map((line) => `${prefix}${line}`);
}
