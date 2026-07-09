import { type BrowserArtifactRendererRegistry } from "./browser-renderer.js";
import { cloneJson, isJsonObject } from "./json.js";
import type { CanvasReadback, JsonValue, UpdateCanvasRequest } from "./types.js";

export function prepareGuardedCanvasUpdate(
  request: UpdateCanvasRequest,
  current: CanvasReadback,
  browserRegistry: BrowserArtifactRendererRegistry,
): UpdateCanvasRequest {
  // Reject browser-only writes unconditionally (independent of the optimistic-lock check):
  // the human owns answers on a canvas form, so the agent must not write them via tool/command.
  assertBrowserArtifactUpdatePolicyAllowsWrite(current, browserRegistry);
  const expectationMatches =
    (request.expectedSourceHash === undefined || request.expectedSourceHash === current.state.sourceHash) &&
    (request.expectedStateVersion === undefined || request.expectedStateVersion === current.state.version);
  if (expectationMatches) {
    assertBrowserArtifactRendererStateAllowsUpdate(current, request.path, request.value, browserRegistry);
  }
  return {
    ...request,
    expectedSourceHash: request.expectedSourceHash ?? current.state.sourceHash,
    expectedStateVersion: request.expectedStateVersion ?? current.state.version,
  };
}

function assertBrowserArtifactUpdatePolicyAllowsWrite(current: CanvasReadback, browserRegistry: BrowserArtifactRendererRegistry): void {
  const view = current.source.view;
  if (view?.kind !== "browser-host-artifact") return;
  const renderer = browserRegistry.get(view.rendererId, view.rendererVersion);
  if (renderer?.updatePolicy === "browser-only") {
    throw new Error(
      "This is a browser-host canvas artifact: the human commits answers in the browser session (open it with canvas_present), so canvas_update cannot write its state. To change the questions, create a new canvas.",
    );
  }
}

function assertBrowserArtifactRendererStateAllowsUpdate(
  current: CanvasReadback,
  path: string,
  value: JsonValue,
  browserRegistry: BrowserArtifactRendererRegistry,
): void {
  const view = current.source.view;
  if (view?.kind !== "browser-host-artifact") return;
  if (!isSafeJsonPath(path)) return;
  const renderer = browserRegistry.get(view.rendererId, view.rendererVersion);
  if (!renderer?.validateState) return;
  renderer.validateState(setJsonPathForValidation(current.state.state, path, value));
}

function setJsonPathForValidation(value: JsonValue, path: string, nextValue: JsonValue): JsonValue {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return cloneJson(nextValue);
  return setJsonPathParts(value, parts, nextValue);
}

function setJsonPathParts(value: JsonValue, parts: string[], nextValue: JsonValue): JsonValue {
  const [head, ...tail] = parts;
  if (!head) return cloneJson(nextValue);
  if (tail.length === 0) {
    if (Array.isArray(value) && isArrayIndex(head)) {
      const copy = value.map((item) => cloneJson(item));
      copy[Number(head)] = cloneJson(nextValue);
      return copy;
    }
    const object = isJsonObject(value) ? cloneJson(value) : {};
    object[head] = cloneJson(nextValue);
    return object;
  }
  if (Array.isArray(value) && isArrayIndex(head)) {
    const copy = value.map((item) => cloneJson(item));
    const index = Number(head);
    copy[index] = setJsonPathParts(copy[index] ?? {}, tail, nextValue);
    return copy;
  }
  const object = isJsonObject(value) ? cloneJson(value) : {};
  object[head] = setJsonPathParts(object[head] ?? {}, tail, nextValue);
  return object;
}

function isArrayIndex(value: string): boolean {
  return /^(0|[1-9][0-9]{0,5})$/.test(value);
}

function isSafeJsonPath(path: string): boolean {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 16 || parts.join(".") !== path.trim()) return false;
  return parts.every((part) => /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(part));
}
