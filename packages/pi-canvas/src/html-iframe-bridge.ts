import { isJsonObject, isJsonValue, isRecord, readString } from "./json.js";
import type { CanvasHtmlIframeBridgeDefinition, JsonObject, JsonValue, UpdateCanvasRequest } from "./types.js";

export const HTML_IFRAME_BRIDGE_VERSION = 1;
export const HTML_IFRAME_BRIDGE_TRANSPORT = "postMessage-json-rpc";
export const HTML_IFRAME_HOST = "adjacent-browser-host";
export const HTML_IFRAME_FALLBACK = "terminal-render";
export const HTML_IFRAME_STRICT_SANDBOX = ["allow-scripts"] as const;
export const HTML_IFRAME_STRICT_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'none'";

const FORBIDDEN_SANDBOX_TOKENS = new Set(["allow-same-origin", "allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-popups"]);

export interface HtmlIframeBridgePolicyResult {
  ok: boolean;
  reasons: string[];
}

export interface HtmlIframeBridgeViewOptions {
  actionSchema: JsonObject;
  htmlSourceHash?: string;
  props?: JsonObject;
}

export function createHtmlIframeBridgeView(options: HtmlIframeBridgeViewOptions): CanvasHtmlIframeBridgeDefinition {
  return {
    kind: "html-iframe-state-bridge",
    bridgeVersion: HTML_IFRAME_BRIDGE_VERSION,
    host: HTML_IFRAME_HOST,
    fallback: HTML_IFRAME_FALLBACK,
    transport: HTML_IFRAME_BRIDGE_TRANSPORT,
    sandbox: [...HTML_IFRAME_STRICT_SANDBOX],
    csp: HTML_IFRAME_STRICT_CSP,
    permissions: [],
    actionSchema: options.actionSchema,
    ...(options.htmlSourceHash === undefined ? {} : { htmlSourceHash: options.htmlSourceHash }),
    ...(options.props === undefined ? {} : { props: options.props }),
  };
}

export function validateHtmlIframeBridgePolicy(view: CanvasHtmlIframeBridgeDefinition): HtmlIframeBridgePolicyResult {
  const reasons: string[] = [];
  if (view.bridgeVersion !== HTML_IFRAME_BRIDGE_VERSION) reasons.push("bridgeVersion must be 1");
  if (view.host !== HTML_IFRAME_HOST) reasons.push("host must be adjacent-browser-host");
  if (view.fallback !== HTML_IFRAME_FALLBACK) reasons.push("fallback must be terminal-render");
  if (view.transport !== HTML_IFRAME_BRIDGE_TRANSPORT) reasons.push("transport must be postMessage-json-rpc");
  for (const token of HTML_IFRAME_STRICT_SANDBOX) {
    if (!view.sandbox.includes(token)) reasons.push(`sandbox missing ${token}`);
  }
  for (const token of view.sandbox) {
    if (FORBIDDEN_SANDBOX_TOKENS.has(token)) reasons.push(`sandbox token not allowed: ${token}`);
  }
  if (view.permissions.length > 0) reasons.push("permissions must be empty until explicitly justified");
  for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "frame-ancestors 'none'"]) {
    if (!view.csp.includes(directive)) reasons.push(`csp missing ${directive}`);
  }
  if (!isRecord(view.actionSchema) || view.actionSchema.type !== "object") {
    reasons.push("actionSchema must describe an object");
  }
  return { ok: reasons.length === 0, reasons };
}

export function parseIframeBridgeSetMessage(message: unknown, expectedArtifactId: string, view?: CanvasHtmlIframeBridgeDefinition): UpdateCanvasRequest {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || message.method !== "canvas.set" || !isJsonObject(message.params)) {
    throw new Error("Iframe bridge message must be JSON-RPC 2.0 method canvas.set");
  }
  if (view) {
    const policy = validateHtmlIframeBridgePolicy(view);
    if (!policy.ok) {
      throw new Error(`Iframe bridge policy invalid: ${policy.reasons.join("; ")}`);
    }
    assertMatchesJsonSchema(view.actionSchema, message.params, "iframe action params");
  }
  const artifactId = readString(message.params, "artifactId");
  const path = readString(message.params, "path");
  const value: JsonValue | undefined = isJsonValue(message.params.value) ? message.params.value : undefined;
  if (!artifactId || artifactId !== expectedArtifactId) {
    throw new Error(`Iframe bridge artifact mismatch: ${artifactId ?? "missing"}`);
  }
  if (!path) {
    throw new Error("Iframe bridge path is required");
  }
  if (value === undefined) {
    throw new Error("Iframe bridge value must be JSON-serializable");
  }
  return { artifactId, path, value, actor: "iframe-bridge" };
}

function assertMatchesJsonSchema(schema: JsonObject, value: JsonValue, label: string): void {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !matchesSchemaType(value, type)) {
    throw new Error(`${label} must be ${type}`);
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
