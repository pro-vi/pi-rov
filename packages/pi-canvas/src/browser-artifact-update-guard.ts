import { type BrowserArtifactRendererRegistry } from "./browser-renderer.js";
import { isSafeJsonPath, setJsonPath } from "./json.js";
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
  if (!renderer) {
    throw new Error(
      `Cannot update browser-host artifact: renderer is not registered: ${view.rendererId} v${view.rendererVersion}. Register the renderer or migrate the artifact before writing state.`,
    );
  }
  if (renderer.updatePolicy === "browser-only") {
    throw new Error(
      renderer.updatePolicyRejectionMessage ??
        "This browser-host artifact commits state only through its browser session, so canvas_update cannot write its state.",
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
  renderer.validateState(setJsonPath(current.state.state, path, value));
}
