import { assertJsonObject, cloneJson, isJsonObject, isJsonValue } from "./json.js";
import type { CanvasActionDefinition, CanvasReadback, JsonObject, JsonValue } from "./types.js";

export interface BrowserHostBootstrap {
  artifactId: string;
  sessionId: string;
  sourceHash: string;
  stateVersion: number;
  state: JsonValue;
  token: string;
  allowedOrigin: string;
}

export interface BrowserRendererSetTransition {
  kind: "set";
  path: string;
  value: JsonValue;
  rendererActionType: string;
}

export interface BrowserRendererRejectTransition {
  kind: "reject";
  reason: string;
  rendererActionType?: string | undefined;
}

export type BrowserRendererTransition = BrowserRendererSetTransition | BrowserRendererRejectTransition;

export interface BrowserRendererHandoffCheck {
  checkId: string;
  readyForHandoff: boolean;
  status: "pending" | "blocked";
  reason: string;
}

export interface BrowserArtifactStateSummary {
  kind: string;
  status: "ready" | "pending" | "blocked";
  summary: string;
  fields: JsonObject;
}

export interface BrowserArtifactPlaybook {
  id: string;
  title: string;
  purpose: string;
  canonicalState: string;
  agentAction: string;
  useWhen: string[];
  avoidWhen: string[];
  qualityGates: string[];
  nextSteps: string[];
}

export interface BrowserArtifactRenderer {
  id: string;
  version: number;
  label: string;
  playbook?: BrowserArtifactPlaybook | undefined;
  actionSchema: JsonObject;
  defaultActions: CanvasActionDefinition[];
  defaultState: JsonValue;
  defaultStateSchema: JsonObject;
  /**
   * Governs agent-facing state writes (canvas_update / `/canvas update`), enforced in the
   * update guard. "open" (default) validates the write via validateState; "browser-only"
   * rejects it outright — the human commits answers through the browser session, so every
   * declared path is an answer path the agent must not forge. The browser action path and
   * direct runtime.update are unaffected.
   */
  updatePolicy?: "open" | "browser-only";
  validateState?(state: JsonValue): void;
  renderHtml(readback: CanvasReadback, bootstrap: BrowserHostBootstrap): string;
  reduceAction(readback: CanvasReadback, action: JsonObject): BrowserRendererTransition;
  summarizeState?(readback: CanvasReadback): BrowserArtifactStateSummary | undefined;
  summarizeHandoff?(readback: CanvasReadback): BrowserRendererHandoffCheck | undefined;
  renderTerminalFallback?(readback: CanvasReadback, width: number): string[];
}

export class BrowserArtifactRendererRegistry {
  private readonly renderers = new Map<string, BrowserArtifactRenderer>();

  register(renderer: BrowserArtifactRenderer): void {
    const existing = this.renderers.get(renderer.id);
    if (existing) {
      throw new Error(`Browser artifact renderer already registered: ${renderer.id}`);
    }
    this.renderers.set(renderer.id, renderer);
  }

  get(rendererId: string, rendererVersion?: number): BrowserArtifactRenderer | undefined {
    const renderer = this.renderers.get(rendererId);
    if (!renderer) return undefined;
    if (rendererVersion !== undefined && renderer.version !== rendererVersion) return undefined;
    return renderer;
  }

  require(rendererId: string, rendererVersion?: number): BrowserArtifactRenderer {
    const renderer = this.get(rendererId, rendererVersion);
    if (!renderer) {
      const versionSuffix = rendererVersion === undefined ? "" : ` v${rendererVersion}`;
      throw new Error(`Browser artifact renderer not found: ${rendererId}${versionSuffix}`);
    }
    return renderer;
  }

  list(): BrowserArtifactRenderer[] {
    return [...this.renderers.values()];
  }
}

export function assertMatchesJsonSchema(schema: JsonObject, value: JsonValue, label: string): void {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !matchesSchemaType(value, type)) {
    throw new Error(`${label} must be ${type}`);
  }
  if (Array.isArray(schema.enum) && schema.enum.every(isJsonValue) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${label} must match one of the allowed enum values`);
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  const properties = isJsonObject(schema.properties) ? schema.properties : undefined;
  if ((type === "object" || required.length > 0 || properties) && !isJsonObject(value)) {
    throw new Error(`${label} must be object`);
  }
  if (!isJsonObject(value)) return;
  for (const key of required) {
    if (!(key in value)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
  if (!properties) return;
  for (const [key, childSchema] of Object.entries(properties)) {
    if (value[key] !== undefined && isJsonObject(childSchema)) {
      assertMatchesJsonSchema(childSchema, value[key], `${label}.${key}`);
    }
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const extra = Object.keys(value).find((key) => !allowed.has(key));
    if (extra) {
      throw new Error(`${label}.${extra} is not allowed by actionSchema`);
    }
  }
}

export function cloneRendererState(value: JsonValue): JsonValue {
  return cloneJson(value);
}

function matchesSchemaType(value: JsonValue, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  if (type === "object") return isJsonObject(value);
  if (type === "array") return Array.isArray(value);
  return true;
}

export function assertBrowserRendererAction(action: unknown, label: string): asserts action is JsonObject {
  assertJsonObject(action, label);
}
