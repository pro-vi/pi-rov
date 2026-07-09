import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import {
  BrowserHostSessionManager,
  type BrowserHostLayoutAuditReceipt,
  type BrowserHostReviewNoteReceipt,
} from "./browser-host.js";
import { prepareGuardedCanvasUpdate } from "./browser-artifact-update-guard.js";
import {
  writeBrowserHostEvidenceExport,
  type BrowserHostArtifactStateSummary,
  type BrowserHostEventSummary,
  type BrowserHostEvidenceSummary,
  type BrowserHostReadinessSummary,
  type BrowserHostReviewAnnotationSummary,
} from "./browser-host-evidence.js";
import { readBrowserHostToolSummary, shouldIncludeBrowserHostExport } from "./browser-host-tool-summary.js";
import {
  formatBrowserArtifactStateLines,
  formatBrowserHostEvidenceLines,
  formatBrowserReviewAnnotationLines,
  type BrowserHostDisplaySummary,
} from "./browser-host-lines.js";
import { createBrowserHostArtifactView, createDefaultBrowserArtifactRendererRegistry } from "./builtin-browser-renderers.js";
import { createFormCanvasRequest } from "./builtin-form-renderer.js";
import { CANVAS_BROWSER_RENDERER_ID } from "./widgets/types.js";
import { createDefaultCanvasRendererRegistry } from "./builtin-canvas-renderers.js";
import { cloneRendererState, type BrowserArtifactPlaybook, type BrowserArtifactRendererRegistry } from "./browser-renderer.js";
import { CanvasTextComponent, createCanvasPreviewComponent, type CanvasRendererRegistry } from "./canvas-renderer.js";
import { assertJsonObject, assertJsonValue, isJsonValue, isRecord } from "./json.js";
import type { PiCanvasRuntime } from "./runtime.js";
import { renderCanvasTerminal } from "./surface.js";
import type { CanvasReadback, CreateCanvasRequest, JsonObject } from "./types.js";

const OptionChooserParams = Type.Object({
  options: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ description: "Stable option id. Use letters, numbers, underscores, or hyphens." }),
        title: Type.String({ description: "Human-readable option title." }),
        detail: Type.Optional(Type.String({ description: "Short option description." })),
      }),
      { description: "Bounded options to present. Provide 2-6 options.", minItems: 2, maxItems: 6 },
    ),
  ),
});

const ReviewDecisionParams = Type.Object({
  prompt: Type.Optional(Type.String({ description: "Decision prompt shown to the human reviewer. Provide 1-160 characters." })),
  context: Type.Optional(Type.String({ description: "Short review context shown under the prompt. Provide 1-500 characters." })),
});

const FormWidgetOption = Type.Object({
  id: Type.String({ description: "Stable option id (letters, numbers, underscores, hyphens)." }),
  title: Type.String({ description: "Option title." }),
  detail: Type.Optional(Type.String({ description: "Short option description." })),
  take: Type.Optional(Type.String({ description: "design-variant only: one-sentence committed direction (required for variants)." })),
  html: Type.Optional(Type.String({ description: "design-variant only: self-contained page content, rendered sandboxed." })),
  previewValue: Type.Optional(Type.Unknown({ description: "Value applied to a local preview when this option is chosen." })),
});

const FormWidget = Type.Object({
  id: Type.String({ description: "Stable widget id. Must start with a letter, underscore, or $; letters, numbers, underscores, hyphens, and $ are allowed after the first character." }),
  kind: Type.Union(
    [
      Type.Literal("single-select"),
      Type.Literal("multi-select"),
      Type.Literal("rating"),
      Type.Literal("short-text"),
      Type.Literal("design-variant"),
      Type.Literal("html-embed"),
    ],
    { description: "Widget kind." },
  ),
  prompt: Type.String({ description: "Question or label shown to the human." }),
  required: Type.Optional(Type.Boolean({ description: "If true, blocks handoff until answered or marked not-sure." })),
  allowUnsure: Type.Optional(Type.Boolean({ description: "Offer an explicit 'I'm not sure' choice (default true)." })),
  allowNote: Type.Optional(Type.Boolean({ description: "Offer a free-text note alongside the answer." })),
  previewKind: Type.Optional(
    Type.Union([Type.Literal("motion"), Type.Literal("density"), Type.Literal("spacing"), Type.Literal("swatch")], { description: "Bind an option value to a local live preview." }),
  ),
  max: Type.Optional(Type.Number({ description: "rating: number of steps (default 5)." })),
  html: Type.Optional(Type.String({ description: "html-embed: self-contained display content, rendered sandboxed." })),
  placeholder: Type.Optional(Type.String({ description: "short-text placeholder." })),
  options: Type.Optional(Type.Array(FormWidgetOption, { description: "Options for select / design-variant widgets.", minItems: 1, maxItems: 12 })),
});

const FormParams = Type.Object({
  components: Type.Array(FormWidget, { description: "Ordered widgets the human answers at their own pace. Provide 1-12.", minItems: 1, maxItems: 12 }),
  requireSubmit: Type.Optional(Type.Boolean({ description: "If true, handoff pends until the human explicitly submits." })),
});

const CreateParams = Type.Object({
  artifactId: Type.Optional(Type.String({ description: "Stable artifact id. Must be filesystem-safe." })),
  title: Type.String({ description: "Canvas title." }),
  initialState: Type.Optional(Type.Unknown({ description: "Initial structured JSON state. Browser renderers can provide a default when omitted." })),
  surfaceKind: Type.Optional(Type.Union([Type.Literal("terminal"), Type.Literal("browser")], { description: "Target surface kind. Use browser for governed local browser-host artifacts." })),
  rendererId: Type.Optional(Type.String({ description: "Optional registered canvas renderer id, for example builtin.counter." })),
  rendererVersion: Type.Optional(Type.Number({ description: "Optional renderer contract version." })),
  browserRendererId: Type.Optional(Type.String({ description: "Id of an externally registered browser artifact renderer. Not for the built-in canvas: use the form, optionChooser, or reviewDecision shorthand for that." })),
  browserRendererVersion: Type.Optional(Type.Number({ description: "Optional browser renderer contract version." })),
  viewProps: Type.Optional(Type.Unknown({ description: "Optional renderer props as a JSON object." })),
  optionChooser: Type.Optional(OptionChooserParams),
  reviewDecision: Type.Optional(ReviewDecisionParams),
  form: Type.Optional(FormParams),
});

const EmptyParams = Type.Object({});

const UpdateParams = Type.Object({
  artifactId: Type.String({ description: "Canvas artifact id." }),
  path: Type.String({ description: "Dot-separated JSON path to set, for example count or user.name." }),
  value: Type.Unknown({ description: "JSON value to write at path." }),
  actor: Type.Optional(Type.String({ description: "Actor label for provenance." })),
  expectedSourceHash: Type.Optional(Type.String({ description: "Optional optimistic-lock source hash from canvas_read." })),
  expectedStateVersion: Type.Optional(Type.Number({ description: "Optional optimistic-lock state version from canvas_read." })),
});

const IdParams = Type.Object({
  artifactId: Type.String({ description: "Canvas artifact id." }),
});

const ExportParams = Type.Object({
  artifactId: Type.String({ description: "Canvas artifact id." }),
  targetDir: Type.Optional(Type.String({ description: "Optional export directory." })),
});

type CreateParamsType = Static<typeof CreateParams>;
type EmptyParamsType = Static<typeof EmptyParams>;
type UpdateParamsType = Static<typeof UpdateParams>;
type IdParamsType = Static<typeof IdParams>;
type ExportParamsType = Static<typeof ExportParams>;

export type RuntimeGetter = (ctx: ExtensionContext) => PiCanvasRuntime;

interface BrowserArtifactCreateHint {
  tool: "canvas_create";
  params: Record<string, string>;
  note: string;
}

interface BrowserArtifactCatalogEntry {
  layer: "browser-host-artifact";
  rendererId: string;
  rendererVersion: number;
  label: string;
  patternId?: string | undefined;
  stateAuthority: "canvas_read";
  evidenceAuthority: "browser-host-receipts";
  playbook?: BrowserArtifactPlaybook | undefined;
  create: BrowserArtifactCreateHint[];
  capabilities: {
    canonicalState: true;
    browserHostReceipts: true;
    layoutAuditEvidence: true;
    reviewNotes: true;
    terminalFallback: boolean;
  };
  actions: Array<{ type: string; path: string; label: string }>;
}

interface BrowserHostPresentationPolicy {
  urlScope: "local-loopback";
  urlLifetime: "transient-session";
  tokenBearing: true;
  sharePolicy: "do-not-paste-persist-or-share";
  stateAuthority: "canvas_read";
  evidenceAuthority: "browser-host-receipts";
}

const BROWSER_ARTIFACT_PLAYBOOK_GUIDELINES = [
  "Use the browser-host path only when the browser interaction must produce canonical Pi state from declared widgets; otherwise prefer canvas_render in the terminal.",
  "Use canvas_browser_artifacts when choosing between registered browser artifact renderers or when the right browser surface is ambiguous.",
  "Do not call canvas_create with only surfaceKind:\"browser\"; choose optionChooser, reviewDecision, or form to build the built-in canvas. browserRendererId is only for externally registered browser renderers, not the built-in canvas.",
  "For bounded option, comparison, or mock-direction decisions, use canvas_create with an optionChooser payload rather than creating arbitrary HTML.",
  "For several related questions or a design review the human answers at their own pace — where blank, not-sure, and skipped are meaningful signal and design variants can be picked — use canvas_create with a bounded form payload; the answers read back via canvas_read formReadback.",
  "For approve/revise/comment review decisions, use canvas_create with a bounded reviewDecision payload; it builds a canvas approve/revise/discuss composition with an optional comment.",
  "Treat browser DOM, screenshots, visual text, and review notes as evidence only; canonical state comes from canvas_read and diffable handoff comes from canvas_export.",
];

export function registerCanvasTools(
  pi: ExtensionAPI,
  getRuntime: RuntimeGetter,
  registry: CanvasRendererRegistry = createDefaultCanvasRendererRegistry(),
  browserRegistry: BrowserArtifactRendererRegistry = createDefaultBrowserArtifactRendererRegistry(),
): void {
  const browserHostSessions = new BrowserHostSessionManager();
  pi.registerTool({
    name: "canvas_browser_artifacts",
    label: "Canvas Browser Artifacts",
    description: "List registered pi-canvas browser artifact renderers, playbooks, creation hints, capabilities, and quality gates.",
    promptSnippet: "Inspect the registered pi-canvas browser artifact catalog before choosing a browser-host artifact",
    promptGuidelines: [
      "Use canvas_browser_artifacts before creating a browser-host artifact when the user's intent could map to multiple registered browser renderers.",
      "Choose from the returned renderer ids and creation hints instead of inventing arbitrary HTML or undocumented renderer ids.",
      ...BROWSER_ARTIFACT_PLAYBOOK_GUIDELINES,
    ],
    parameters: EmptyParams,
    async execute(_toolCallId, _params: EmptyParamsType) {
      const artifacts = createBrowserArtifactCatalog(browserRegistry);
      return {
        content: [{ type: "text", text: formatBrowserArtifactCatalogText(artifacts) }],
        details: { artifacts },
      };
    },
  });

  pi.registerTool({
    name: "canvas_create",
    label: "Canvas Create",
    description: "Create a pi-canvas artifact with durable source and state.",
    promptSnippet: "Create a durable pi-canvas artifact with terminal preview or browser-host readiness",
    promptGuidelines: [
      "Use canvas_create when the user asks for an interactive stateful artifact that must be readable and rendered later.",
      ...BROWSER_ARTIFACT_PLAYBOOK_GUIDELINES,
    ],
    parameters: CreateParams,
    renderShell: "self",
    renderCall: renderEmptyCanvasToolCall,
    renderResult: (result) => renderCanvasToolResult(result, registry),
    async execute(_toolCallId, params: CreateParamsType, _signal, _onUpdate, ctx) {
      const request = createCanvasRequest(params, registry, browserRegistry);
      const runtime = getRuntime(ctx);
      const readback = await runtime.create(request);
      const { browserHost: browserHostExport, browserReadiness, artifactState } = await readBrowserHostToolSummary(
        runtime.store.rootDir,
        readback,
        browserRegistry,
      );
      const playbook = readBrowserArtifactPlaybook(readback, browserRegistry);
      const nextSteps = playbook === undefined ? undefined : browserArtifactNextSteps(readback.source.artifactId, "created");
      return {
        content: [{ type: "text", text: formatCanvasCreateText("Created canvas", readback, playbook, browserReadiness, artifactState, nextSteps) }],
        details: {
          canvas: readback,
          ...(playbook === undefined ? {} : { playbook, nextSteps }),
          ...(shouldIncludeBrowserHostExport(browserHostExport) ? { browserHost: browserHostExport } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "canvas_update",
    label: "Canvas Update",
    description: "Apply a typed state update to a pi-canvas artifact.",
    promptSnippet: "Update pi-canvas structured state and return its terminal render",
    promptGuidelines: ["Use canvas_update to mutate pi-canvas state through the state store instead of editing rendered views."],
    parameters: UpdateParams,
    renderShell: "self",
    renderCall: renderEmptyCanvasToolCall,
    renderResult: (result) => renderCanvasToolResult(result, registry),
    async execute(_toolCallId, params: UpdateParamsType, _signal, _onUpdate, ctx) {
      assertJsonValue(params.value, "value");
      const request = {
        artifactId: params.artifactId,
        path: params.path,
        value: params.value,
        ...(params.actor === undefined ? {} : { actor: params.actor }),
        ...(params.expectedSourceHash === undefined ? {} : { expectedSourceHash: params.expectedSourceHash }),
        ...(params.expectedStateVersion === undefined ? {} : { expectedStateVersion: params.expectedStateVersion }),
      };
      const runtime = getRuntime(ctx);
      const current = await runtime.read(params.artifactId);
      if (!current) {
        throw new Error(`Canvas artifact not found: ${params.artifactId}`);
      }
      const readback = await runtime.update(prepareGuardedCanvasUpdate(request, current, browserRegistry));
      const { browserHost: browserHostExport, browserReadiness, artifactState, reviewAnnotations } = await readBrowserHostToolSummary(
        runtime.store.rootDir,
        readback,
        browserRegistry,
      );
      const playbook = readBrowserArtifactPlaybook(readback, browserRegistry);
      return {
        content: [{ type: "text", text: formatCanvasUpdateText(readback, browserReadiness, reviewAnnotations, artifactState) }],
        details: {
          canvas: readback,
          ...(playbook === undefined ? {} : { playbook }),
          ...(browserHostExport.receipts.length === 0 && browserReadiness === undefined ? {} : { browserHost: browserHostExport }),
        },
      };
    },
  });

  pi.registerTool({
    name: "canvas_present",
    label: "Canvas Present",
    description: "Start or focus a governed local browser-host session for a pi-canvas artifact.",
    promptSnippet: "Start or focus the local browser host for a browser-host pi-canvas artifact",
    promptGuidelines: [
      "Use canvas_present only for artifacts whose source declares a browser-host view.",
      "Do not treat the browser DOM or review notes as state; use canvas_read and canvas_export after interaction.",
      ...BROWSER_ARTIFACT_PLAYBOOK_GUIDELINES,
    ],
    parameters: IdParams,
    renderShell: "self",
    renderCall: renderEmptyCanvasToolCall,
    renderResult: (result) => renderCanvasToolResult(result, registry),
    async execute(_toolCallId, params: IdParamsType, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const readback = await runtime.read(params.artifactId);
      if (!readback) {
        return { content: [{ type: "text", text: `Canvas not found: ${params.artifactId}` }], details: { found: false } };
      }
      if (readback.source.view?.kind !== "browser-host-artifact") {
        return { content: [{ type: "text", text: `Canvas does not declare a browser-host view: ${params.artifactId}` }], details: { found: true, canvas: readback, browserHost: null } };
      }
      const key = `${ctx.cwd}:${params.artifactId}`;
      const session = await browserHostSessions.getOrStart(key, {
        runtime,
        artifactId: params.artifactId,
        candidateId: "pi-owned-browser-host-artifact",
        scenarioId: "canvas-present-tool",
        runId: `canvas-present-${Date.now()}`,
        reportsDir: join(runtime.store.rootDir, "browser-host-receipts"),
        browserRenderers: browserRegistry,
      });
      const playbook = readBrowserArtifactPlaybook(readback, browserRegistry);
      const nextSteps = browserArtifactNextSteps(params.artifactId, "presented");
      const presentationPolicy = createBrowserHostPresentationPolicy();
      const { browserHost: browserHostExport, browserReadiness, artifactState, reviewAnnotations } = await readBrowserHostToolSummary(
        runtime.store.rootDir,
        readback,
        browserRegistry,
      );
      return {
        content: [
          {
            type: "text",
            text: formatBrowserHostSessionText(params.artifactId, session.url, session.receipt.receiptPath, nextSteps, presentationPolicy, playbook, browserReadiness, reviewAnnotations, artifactState),
          },
        ],
        details: {
          found: true,
          canvas: readback,
          browserHost: { ...browserHostExport, url: session.url, presentationPolicy, receipt: session.receipt, nextSteps, ...(playbook === undefined ? {} : { playbook }) },
        },
      };
    },
  });

  pi.registerTool({
    name: "canvas_read",
    label: "Canvas Read",
    description: "Read current pi-canvas source, state, provenance, terminal render, and browser-host evidence summary.",
    promptSnippet: "Read current pi-canvas terminal render and structured state",
    promptGuidelines: [
      "Use canvas_read after user interaction to inspect canonical state and browser-host receipt evidence instead of relying on screenshots or paste-back.",
    ],
    parameters: IdParams,
    renderShell: "self",
    renderCall: renderEmptyCanvasToolCall,
    renderResult: (result) => renderCanvasToolResult(result, registry),
    async execute(_toolCallId, params: IdParamsType, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const readback = await runtime.read(params.artifactId);
      if (!readback) {
        return { content: [{ type: "text", text: `Canvas not found: ${params.artifactId}` }], details: { found: false } };
      }
      const { browserHost, browserReadiness, artifactState, reviewAnnotations } = await readBrowserHostToolSummary(
        runtime.store.rootDir,
        readback,
        browserRegistry,
      );
      const playbook = readBrowserArtifactPlaybook(readback, browserRegistry);
      return {
        content: [{ type: "text", text: formatCanvasReadText(readback, browserHost, browserReadiness, playbook, reviewAnnotations, artifactState) }],
        details: {
          found: true,
          canvas: readback,
          ...(playbook === undefined ? {} : { playbook }),
          ...(browserHost.receipts.length === 0 && browserReadiness === undefined ? {} : { browserHost }),
        },
      };
    },
  });

  pi.registerTool({
    name: "canvas_render",
    label: "Canvas Render",
    description: "Render a pi-canvas artifact as a framed terminal artifact.",
    promptSnippet: "Render an existing pi-canvas artifact in the terminal",
    promptGuidelines: [
      "Use canvas_render when the user asks to see or open the canvas artifact in the terminal window.",
      "Use canvas_render as the final action; do not add a follow-up assistant message after rendering.",
    ],
    parameters: IdParams,
    renderShell: "self",
    renderCall: renderEmptyCanvasToolCall,
    renderResult: (result) => renderCanvasToolResult(result, registry),
    async execute(_toolCallId, params: IdParamsType, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const readback = await runtime.read(params.artifactId);
      if (!readback) {
        return { content: [{ type: "text", text: `Canvas not found: ${params.artifactId}` }], details: { found: false } };
      }
      const { browserHost: browserHostExport, browserReadiness, artifactState, reviewAnnotations } = await readBrowserHostToolSummary(
        runtime.store.rootDir,
        readback,
        browserRegistry,
      );
      return {
        content: [{ type: "text", text: formatCanvasRenderText(readback, { readiness: browserReadiness, artifactState, reviewAnnotations }) }],
        details: {
          found: true,
          canvas: readback,
          ...(shouldIncludeBrowserHostExport(browserHostExport) ? { browserHost: browserHostExport } : {}),
        },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "canvas_export",
    label: "Canvas Export",
    description: "Export a pi-canvas artifact to diffable source, state, provenance, and browser-host evidence files.",
    promptSnippet: "Export pi-canvas source/state/provenance and browser-host evidence",
    promptGuidelines: ["Use canvas_export when a canvas artifact must return to durable repo/docs/code form with reviewable diffs, including browser-host readiness and receipt evidence for browser artifacts."],
    parameters: ExportParams,
    async execute(_toolCallId, params: ExportParamsType, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const readback = await runtime.read(params.artifactId);
      if (!readback) {
        return { content: [{ type: "text", text: `Canvas not found: ${params.artifactId}` }], details: { found: false } };
      }
      const { browserHost: browserHostExport, browserReadiness, reviewAnnotations, artifactState } = await readBrowserHostToolSummary(
        runtime.store.rootDir,
        readback,
        browserRegistry,
      );
      const exported = await runtime.export(params.artifactId, params.targetDir);
      if (!exported) {
        return { content: [{ type: "text", text: `Canvas not found: ${params.artifactId}` }], details: { found: false } };
      }
      const browserHostEvidencePath = await writeBrowserHostEvidenceExport(exported.exportDir, browserHostExport);
      return {
        content: [
          {
            type: "text",
            text: formatCanvasExportText(
              exported.artifactId,
              exported.exportDir,
              browserHostEvidencePath,
              browserReadiness,
              reviewAnnotations,
              artifactState,
              browserHostExport.receiptReadErrors?.length ?? 0,
            ),
          },
        ],
        details: {
          found: true,
          export: exported,
          ...(browserHostEvidencePath === undefined && browserReadiness === undefined
            ? {}
            : { browserHost: { ...browserHostExport, ...(browserHostEvidencePath === undefined ? {} : { evidencePath: browserHostEvidencePath }) } }),
        },
      };
    },
  });
}

const DEFAULT_CHOICE_FORM_OPTIONS: Array<{ id: string; title: string; detail?: string }> = [
  { id: "option-a", title: "Option A" },
  { id: "option-b", title: "Option B" },
];

function optionChooserToFormParams(optionChooser: NonNullable<CreateParamsType["optionChooser"]>, title: string): JsonObject {
  const options = (optionChooser.options ?? DEFAULT_CHOICE_FORM_OPTIONS).map((option) => ({
    id: option.id,
    title: option.title,
    ...(option.detail === undefined ? {} : { detail: option.detail }),
  }));
  return {
    requireSubmit: true,
    components: [{ id: "choice", kind: "single-select", prompt: title, required: true, options }],
  };
}

function reviewDecisionToFormParams(reviewDecision: NonNullable<CreateParamsType["reviewDecision"]>, title: string): JsonObject {
  const prompt = reviewDecision.prompt ?? title;
  return {
    requireSubmit: true,
    components: [
      {
        id: "outcome",
        kind: "single-select",
        prompt: reviewDecision.context === undefined ? prompt : `${prompt} — ${reviewDecision.context}`,
        required: true,
        options: [
          { id: "approved", title: "Approve", detail: "Accept this direction and continue." },
          { id: "revisions_requested", title: "Request revisions", detail: "Send the agent back with concrete changes." },
          { id: "needs_discussion", title: "Needs discussion", detail: "Pause for ambiguity or a tradeoff call." },
        ],
      },
      { id: "comment", kind: "short-text", prompt: "Comment", placeholder: "Add a comment (optional)" },
    ],
  };
}

function createCanvasRequest(params: CreateParamsType, registry: CanvasRendererRegistry, browserRegistry: BrowserArtifactRendererRegistry): CreateCanvasRequest {
  if (params.viewProps !== undefined) {
    assertJsonObject(params.viewProps, "viewProps");
  }
  if (params.optionChooser !== undefined && params.surfaceKind === "terminal") {
    throw new Error("optionChooser options require a browser-host canvas; omit surfaceKind or use surfaceKind:\"browser\"");
  }
  if (params.reviewDecision !== undefined && params.surfaceKind === "terminal") {
    throw new Error("reviewDecision options require a browser-host canvas; omit surfaceKind or use surfaceKind:\"browser\"");
  }
  if (params.form !== undefined && params.surfaceKind === "terminal") {
    throw new Error("form components require a browser-host canvas; omit surfaceKind or use surfaceKind:\"browser\"");
  }
  if ([params.optionChooser, params.reviewDecision, params.form].filter((value) => value !== undefined).length > 1) {
    throw new Error("Use only one of optionChooser, reviewDecision, or form options for a browser-host canvas");
  }
  if (
    params.surfaceKind === "browser" ||
    params.browserRendererId !== undefined ||
    params.browserRendererVersion !== undefined ||
    params.optionChooser !== undefined ||
    params.reviewDecision !== undefined ||
    params.form !== undefined
  ) {
    if (params.rendererId !== undefined || params.rendererVersion !== undefined) {
      throw new Error("Use browserRendererId/browserRendererVersion for browser canvas artifacts");
    }
    if (params.form !== undefined) {
      if (params.initialState !== undefined) {
        throw new Error("Use either form components or initialState for a form, not both");
      }
      assertJsonObject(params.form, "form");
      return createFormCanvasRequest(params.artifactId, params.title, params.form);
    }
    if (params.optionChooser !== undefined) {
      if (params.initialState !== undefined) {
        throw new Error("Use either optionChooser options or initialState, not both");
      }
      return createFormCanvasRequest(params.artifactId, params.title, optionChooserToFormParams(params.optionChooser, params.title));
    }
    if (params.reviewDecision !== undefined) {
      if (params.initialState !== undefined) {
        throw new Error("Use either reviewDecision options or initialState, not both");
      }
      return createFormCanvasRequest(params.artifactId, params.title, reviewDecisionToFormParams(params.reviewDecision, params.title));
    }
    if (params.browserRendererId === CANVAS_BROWSER_RENDERER_ID) {
      throw new Error("Create composable forms with the form shorthand (form: { components: [...] }), not a raw browserRendererId");
    }
    if (params.browserRendererId === undefined) {
      throw new Error("Browser canvas artifacts require optionChooser, reviewDecision, form, or browserRendererId");
    }
    const renderer = browserRegistry.require(params.browserRendererId, params.browserRendererVersion);
    const initialState = params.initialState === undefined ? cloneRendererState(renderer.defaultState) : params.initialState;
    assertJsonValue(initialState, "initialState");
    renderer.validateState?.(initialState);
    const actions = renderer.defaultActions.map((action) => ({ ...action }));
    return {
      title: params.title,
      initialState,
      surfaceKind: "browser",
      viewKind: "browser-host-artifact",
      view: createBrowserHostArtifactView(renderer, params.viewProps ?? {}),
      browserRendererId: renderer.id,
      browserRendererVersion: renderer.version,
      stateSchema: renderer.defaultStateSchema,
      actions,
      ...(params.artifactId === undefined ? {} : { artifactId: params.artifactId }),
    };
  }
  if (params.initialState === undefined) {
    throw new Error("initialState is required for terminal canvas artifacts");
  }
  assertJsonValue(params.initialState, "initialState");
  const rendererId = params.rendererId ?? "builtin.json-card";
  const renderer = registry.require(rendererId);
  if (params.rendererVersion !== undefined && params.rendererVersion !== renderer.version) {
    throw new Error(`Canvas renderer not found: ${rendererId} v${params.rendererVersion}`);
  }
  const actions = renderer.defaultActions?.map((action) => ({ ...action }));
  return {
    title: params.title,
    initialState: params.initialState,
    rendererId,
    rendererVersion: params.rendererVersion ?? renderer.version,
    ...(actions === undefined ? {} : { actions }),
    ...(params.viewProps === undefined ? {} : { viewProps: params.viewProps }),
    ...(params.artifactId === undefined ? {} : { artifactId: params.artifactId }),
  };
}

function createBrowserArtifactCatalog(browserRegistry: BrowserArtifactRendererRegistry): BrowserArtifactCatalogEntry[] {
  return browserRegistry.list().map((renderer) => ({
    layer: "browser-host-artifact",
    rendererId: renderer.id,
    rendererVersion: renderer.version,
    label: renderer.label,
    ...(renderer.playbook === undefined ? {} : { patternId: renderer.playbook.id }),
    stateAuthority: "canvas_read",
    evidenceAuthority: "browser-host-receipts",
    ...(renderer.playbook === undefined ? {} : { playbook: renderer.playbook }),
    create: createBrowserArtifactCreateHints(renderer.id),
    capabilities: {
      canonicalState: true,
      browserHostReceipts: true,
      layoutAuditEvidence: true,
      reviewNotes: true,
      terminalFallback: renderer.renderTerminalFallback !== undefined,
    },
    actions: renderer.defaultActions.map((action) => ({ ...action })),
  }));
}

function createBrowserArtifactCreateHints(rendererId: string): BrowserArtifactCreateHint[] {
  if (rendererId === CANVAS_BROWSER_RENDERER_ID) {
    return [
      {
        tool: "canvas_create",
        params: { title: "<title>", form: "{ components: [{ id, kind, prompt, required?, options?: [{ id, title, take? }] }], requireSubmit? }" },
        note: "Use the bounded form shorthand; it fans the widgets into canonical per-component state. Read answers with canvas_read formReadback (affirmed / negated / blank / note + required-remaining).",
      },
    ];
  }
  return [
    {
      tool: "canvas_create",
      params: { title: "<title>", surfaceKind: "browser", browserRendererId: rendererId },
      note: "Create this registered browser-host renderer through the generic canvas_create path.",
    },
  ];
}

function formatBrowserArtifactCatalogText(artifacts: BrowserArtifactCatalogEntry[]): string {
  return [
    "Browser artifact catalog",
    "Use these registered renderers when browser interaction must commit canonical Pi state through declared widgets.",
    "",
    ...artifacts.flatMap((artifact, index) => [
      `${index + 1}. ${artifact.rendererId} v${artifact.rendererVersion} - ${artifact.label}`,
      `   Layer: ${artifact.layer}; state: ${artifact.stateAuthority}; evidence: ${artifact.evidenceAuthority}`,
      ...(artifact.playbook === undefined
        ? []
        : [
            `   Playbook: ${artifact.playbook.title}`,
            `   Purpose: ${artifact.playbook.purpose}`,
            `   Canonical state: ${artifact.playbook.canonicalState}`,
            `   Agent action: ${artifact.playbook.agentAction}`,
          ]),
      ...formatBrowserArtifactCreateHintLines(artifact.create),
      `   Capabilities: canonical state, browser-host receipts, layout audit evidence, review notes`,
      `   Actions: ${artifact.actions.map((action) => `${action.type}:${action.path}`).join(", ") || "none"}`,
      ...(artifact.playbook === undefined ? [] : [`   First gate: ${artifact.playbook.qualityGates[0] ?? "none declared"}`]),
      "",
    ]),
    "After presentation, use canvas_read for canonical state and canvas_export for diffable source/state/provenance plus browser-host readiness and evidence.",
  ].join("\n");
}

function formatBrowserArtifactCreateHintLines(hints: BrowserArtifactCreateHint[]): string[] {
  if (hints.length === 0) return ["   Create: none"];
  return hints.map((hint, index) => `${index === 0 ? "   Create" : "   Also"}: ${formatBrowserArtifactCreateHint(hint)}`);
}

function formatBrowserArtifactCreateHint(hint: BrowserArtifactCreateHint | undefined): string {
  if (!hint) return "none";
  return `${hint.tool}(${JSON.stringify(hint.params)})`;
}

function browserArtifactNextSteps(artifactId: string, phase: "created" | "presented"): string[] {
  const firstStep =
    phase === "created"
      ? `Call canvas_present with artifactId ${artifactId} to start or focus the governed local browser host before asking the user to interact.`
      : `Open the live browser-host URL locally for ${artifactId}; do not paste, persist, or share it because it is transient and contains a session token.`;
  return [
    firstStep,
    `After the user interacts, call canvas_read with artifactId ${artifactId} to inspect canonical Pi state and browser-host receipt evidence.`,
    `If the artifact needs review or handoff, call canvas_export with artifactId ${artifactId} so source, state, provenance, browser-host readiness, and evidence are diffable.`,
    "Do not infer canonical state from browser DOM, screenshots, review notes, or pasted visual text.",
  ];
}

function createBrowserHostPresentationPolicy(): BrowserHostPresentationPolicy {
  return {
    urlScope: "local-loopback",
    urlLifetime: "transient-session",
    tokenBearing: true,
    sharePolicy: "do-not-paste-persist-or-share",
    stateAuthority: "canvas_read",
    evidenceAuthority: "browser-host-receipts",
  };
}

function readBrowserArtifactPlaybook(readback: CanvasReadback, browserRegistry: BrowserArtifactRendererRegistry): BrowserArtifactPlaybook | undefined {
  return readBrowserArtifactRenderer(readback, browserRegistry)?.playbook;
}

function readBrowserArtifactRenderer(readback: CanvasReadback, browserRegistry: BrowserArtifactRendererRegistry) {
  const view = readback.source.view;
  if (view?.kind === "browser-host-artifact") {
    return browserRegistry.get(view.rendererId, view.rendererVersion);
  }
  return undefined;
}

function formatBrowserPlaybookSummary(playbook: BrowserArtifactPlaybook | undefined): string {
  if (!playbook) return "";
  return [
    "",
    "",
    `Playbook: ${playbook.title}`,
    playbook.purpose,
    "",
    `Canonical state: ${playbook.canonicalState}`,
    `Agent action: ${playbook.agentAction}`,
    "",
    "Use when:",
    ...playbook.useWhen.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Avoid when:",
    ...playbook.avoidWhen.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Quality gates:",
    ...playbook.qualityGates.map((gate, index) => `${index + 1}. ${gate}`),
  ].join("\n");
}

function formatBrowserHostSessionText(
  artifactId: string,
  url: string,
  receiptPath: string,
  nextSteps: string[],
  presentationPolicy: BrowserHostPresentationPolicy,
  playbook: BrowserArtifactPlaybook | undefined,
  browserReadiness: BrowserHostReadinessSummary | undefined,
  reviewAnnotations: BrowserHostReviewAnnotationSummary | undefined,
  artifactState: BrowserHostArtifactStateSummary | undefined,
): string {
  return [
    `Browser host session available for ${artifactId}`,
    url,
    `Presentation policy: ${presentationPolicy.urlScope}, ${presentationPolicy.urlLifetime}, token-bearing; share policy: ${presentationPolicy.sharePolicy}; state: ${presentationPolicy.stateAuthority}; evidence: ${presentationPolicy.evidenceAuthority}`,
    formatBrowserPlaybookSummary(playbook),
    ...formatBrowserArtifactStateLines(artifactState, { prefixBlankLine: true }),
    ...formatBrowserReviewAnnotationLines(reviewAnnotations, { prefixBlankLine: true }),
    ...(browserReadiness === undefined ? [] : ["", `Browser-host readiness: ${browserReadiness.status} - ${browserReadiness.reason}`, `Browser-host next action: ${browserReadiness.nextAction}`]),
    "",
    "Next steps:",
    ...nextSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `Receipt: ${receiptPath}`,
  ].join("\n");
}

function formatCanvasCreateText(
  label: string,
  readback: CanvasReadback,
  playbook: BrowserArtifactPlaybook | undefined,
  browserReadiness: BrowserHostReadinessSummary | undefined,
  artifactState: BrowserHostArtifactStateSummary | undefined,
  nextSteps: string[] | undefined,
): string {
  return [
    `${label} ${readback.source.artifactId} v${readback.state.version}`,
    "",
    formatToolRender(readback),
    formatBrowserPlaybookSummary(playbook),
    ...formatBrowserArtifactStateLines(artifactState, { prefixBlankLine: true }),
    ...(browserReadiness === undefined ? [] : ["", `Browser-host readiness: ${browserReadiness.status} - ${browserReadiness.reason}`, `Browser-host next action: ${browserReadiness.nextAction}`]),
    ...(nextSteps === undefined ? [] : ["", "Next steps:", ...nextSteps.map((step, index) => `${index + 1}. ${step}`)]),
  ].join("\n");
}

function formatCanvasExportText(
  artifactId: string,
  exportDir: string,
  browserHostEvidencePath: string | undefined,
  browserReadiness: BrowserHostReadinessSummary | undefined,
  reviewAnnotations: BrowserHostReviewAnnotationSummary | undefined,
  artifactState: BrowserHostArtifactStateSummary | undefined,
  receiptReadErrorCount: number,
): string {
  return [
    `Exported canvas ${artifactId} to ${exportDir}`,
    ...(browserHostEvidencePath === undefined ? [] : [`Browser-host evidence: ${browserHostEvidencePath}`]),
    ...formatBrowserArtifactStateLines(artifactState),
    ...formatBrowserReviewAnnotationLines(reviewAnnotations),
    ...(receiptReadErrorCount === 0 ? [] : [`Browser-host receipt read errors: ${receiptReadErrorCount}`]),
    ...(browserReadiness === undefined ? [] : [`Browser-host readiness: ${browserReadiness.status} - ${browserReadiness.reason}`]),
    ...(browserReadiness === undefined ? [] : [`Browser-host next action: ${browserReadiness.nextAction}`]),
  ].join("\n");
}

function formatCanvasUpdateText(
  readback: CanvasReadback,
  browserReadiness: BrowserHostReadinessSummary | undefined,
  reviewAnnotations: BrowserHostReviewAnnotationSummary | undefined,
  artifactState: BrowserHostArtifactStateSummary | undefined,
): string {
  return [
    `Updated canvas ${readback.source.artifactId} to v${readback.state.version}`,
    "",
    formatToolRender(readback),
    ...formatBrowserArtifactStateLines(artifactState, { prefixBlankLine: true }),
    ...formatBrowserReviewAnnotationLines(reviewAnnotations, { prefixBlankLine: true }),
    ...(browserReadiness === undefined ? [] : ["", `Browser-host readiness: ${browserReadiness.status} - ${browserReadiness.reason}`, `Browser-host next action: ${browserReadiness.nextAction}`]),
  ].join("\n");
}

function formatCanvasReadText(
  readback: CanvasReadback,
  browserHost: BrowserHostEvidenceSummary,
  browserReadiness: BrowserHostReadinessSummary | undefined,
  playbook: BrowserArtifactPlaybook | undefined,
  reviewAnnotations: BrowserHostReviewAnnotationSummary | undefined,
  artifactState: BrowserHostArtifactStateSummary | undefined,
): string {
  const rendered = formatToolRender(readback);
  const artifactStateLines = formatBrowserArtifactStateLines(artifactState);
  const reviewAnnotationLines = formatBrowserReviewAnnotationLines(reviewAnnotations);
  const receiptReadErrorCount = browserHost.receiptReadErrors?.length ?? 0;
  if (
    browserHost.receipts.length === 0 &&
    receiptReadErrorCount === 0 &&
    browserReadiness === undefined &&
    artifactStateLines.length === 0 &&
    reviewAnnotationLines.length === 0
  ) {
    return rendered;
  }
  const noteCount = browserHost.reviewNotes.length;
  const latestNote = browserHost.reviewNotes[0];
  const latestLayoutAudit = browserHost.layoutAudits[0];
  const latestCurrentReceipt = browserHost.receipts.find((receipt) => isBrowserHostReceiptCurrentForReadback(receipt, readback));
  const layoutAuditCount = latestCurrentReceipt?.currentLayoutAuditCount ?? browserHost.layoutAudits.length;
  const layoutErrorCount = latestCurrentReceipt?.currentLayoutAuditErrorCount ?? browserHost.layoutAudits.reduce((count, audit) => count + audit.errorCount, 0);
  const recentActions = latestCurrentReceipt?.recentActionEvents === undefined ? undefined : formatBrowserHostRecentActionEvents(latestCurrentReceipt.recentActionEvents);
  const playbookLines =
    playbook === undefined
      ? []
      : [
          `Browser artifact pattern: ${playbook.title} (${playbook.id})`,
          "Authority contract: layer browser-host-artifact; state canvas_read; evidence browser-host-receipts",
          `Canonical state contract: ${playbook.canonicalState}`,
          `Agent action contract: ${playbook.agentAction}`,
          "",
        ];
  return [
    rendered,
    "",
    ...playbookLines,
    ...artifactStateLines,
    ...(artifactStateLines.length === 0 ? [] : [""]),
    `Browser-host receipts: ${browserHost.receipts.length}`,
    ...(receiptReadErrorCount === 0 ? [] : [`Browser-host receipt read errors: ${receiptReadErrorCount}`]),
    `Browser-host review notes: ${noteCount}`,
    ...reviewAnnotationLines,
    `Browser-host layout audits: ${layoutAuditCount} (${layoutErrorCount} errors)`,
    ...(browserReadiness === undefined ? [] : [`Browser-host readiness: ${browserReadiness.status} - ${browserReadiness.reason}`]),
    ...(browserReadiness === undefined ? [] : [`Browser-host next action: ${browserReadiness.nextAction}`]),
    ...(recentActions === undefined ? [] : [`Recent browser actions: ${recentActions}`]),
    ...(latestCurrentReceipt?.latestActionEvent === undefined ? [] : [`Latest browser action: ${formatBrowserHostActionEvent(latestCurrentReceipt.latestActionEvent)}`]),
    ...(latestNote === undefined ? [] : [`Latest review note: ${latestNote.text}`]),
    ...(latestNote === undefined ? [] : [`Latest review target: ${formatBrowserHostReviewTarget(latestNote)}`]),
    ...(latestLayoutAudit === undefined ? [] : [`Latest layout audit: ${formatBrowserHostLayoutAudit(latestLayoutAudit)}`]),
    ...(latestLayoutAudit === undefined ? [] : formatBrowserHostLayoutFinding(latestLayoutAudit)),
  ].join("\n");
}

function formatCanvasRenderText(readback: CanvasReadback, browserHost: BrowserHostDisplaySummary | undefined): string {
  return [`Rendered canvas ${readback.source.artifactId} v${readback.state.version}`, ...formatBrowserHostEvidenceLines(browserHost, { prefixBlankLine: true })].join("\n");
}

function isBrowserHostReceiptCurrentForReadback(receipt: BrowserHostEvidenceSummary["receipts"][number], readback: CanvasReadback): boolean {
  return receipt.sourceHash === readback.state.sourceHash && receipt.finalStateVersion === readback.state.version;
}

function formatBrowserHostReviewTarget(note: BrowserHostReviewNoteReceipt): string {
  const target = note.target;
  const kind = typeof target.kind === "string" ? target.kind : "page";
  const keySuffix = note.targetKey === undefined ? "" : ` [${note.targetKey}]`;
  if (kind === "page") return `page${keySuffix}`;
  if (kind === "selection") return `selection ${formatBoundedInlineText(typeof target.text === "string" ? target.text : "")}${keySuffix}`;
  if (kind === "element") {
    const label = [target.testId, target.id, target.selector, target.tag].find((item): item is string => typeof item === "string" && item.trim().length > 0) ?? "element";
    const text = typeof target.text === "string" && target.text.trim().length > 0 ? ` - ${formatBoundedInlineText(target.text)}` : "";
    return `element ${label}${text}${keySuffix}`;
  }
  return `${kind}${keySuffix}`;
}

function formatBrowserHostLayoutAudit(audit: BrowserHostLayoutAuditReceipt): string {
  return `${audit.errorCount} errors, ${audit.warningCount} warnings`;
}

function formatBrowserHostLayoutFinding(audit: BrowserHostLayoutAuditReceipt): string[] {
  const finding = audit.findings.find((item) => item.severity === "error") ?? audit.findings[0];
  if (!finding) return [];
  const viewport = finding.viewportWidth === undefined || finding.viewportHeight === undefined ? "" : ` ${finding.viewportWidth}x${finding.viewportHeight}`;
  return [`Latest layout finding: ${finding.kind} ${finding.selector} ${finding.severity} overflow=${finding.overflowPx}px${viewport}`];
}

function formatBoundedInlineText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 160);
}

function formatBrowserHostRecentActionEvents(events: BrowserHostEventSummary[]): string | undefined {
  const actions = events.filter((event) => event.kind === "action_committed" || event.kind === "action_rejected");
  if (actions.length <= 1) return undefined;
  return actions.map(formatBrowserHostActionEvent).join(", ");
}

function formatBrowserHostActionEvent(event: BrowserHostEventSummary): string {
  const action = event.rendererActionType ?? event.kind;
  return `${action}${formatBrowserHostVersionRange(event)}${formatBrowserHostStatus(event)}`;
}

function formatBrowserHostVersionRange(event: BrowserHostEventSummary): string {
  if (event.beforeVersion === undefined || event.afterVersion === undefined) return "";
  return ` v${event.beforeVersion}->v${event.afterVersion}`;
}

function formatBrowserHostStatus(event: BrowserHostEventSummary): string {
  if (event.status === undefined) return "";
  const errorCode = event.errorCode === undefined ? "" : `:${event.errorCode}`;
  return ` (${event.status}${errorCode})`;
}

function formatToolRender(readback: CanvasReadback): string {
  return renderCanvasTerminal(readback, { width: 80 }).join("\n");
}

function renderEmptyCanvasToolCall(): Component {
  return emptyCanvasComponent;
}

function renderCanvasToolResult(result: AgentToolResult<unknown>, registry: CanvasRendererRegistry): Component {
  const readback = readCanvasFromDetails(result.details);
  const extraLines = formatBrowserHostEvidenceLines(readBrowserHostDisplaySummaryFromDetails(result.details));
  if (readback) {
    const preview = createCanvasPreviewComponent(readback, registry, extraLines.length === 0 ? {} : { extraLines });
    const criticalText = readCriticalToolResultText(result);
    return criticalText === undefined ? preview : new CanvasToolResultWithTextComponent(preview, criticalText);
  }
  const first = result.content[0];
  return new CanvasTextComponent(first?.type === "text" ? first.text : "");
}

class CanvasToolResultWithTextComponent implements Component {
  private readonly text: CanvasTextComponent;

  constructor(
    private readonly preview: Component,
    content: string,
  ) {
    this.text = new CanvasTextComponent(content);
  }

  handleInput(data: string): void {
    this.preview.handleInput?.(data);
  }

  invalidate(): void {
    this.preview.invalidate();
    this.text.invalidate();
  }

  render(width: number): string[] {
    return [...this.preview.render(width), "", ...this.text.render(width)];
  }
}

function readCriticalToolResultText(result: AgentToolResult<unknown>): string | undefined {
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : undefined;
  if (text === undefined || !isRecord(result.details)) return undefined;
  const browserHost = result.details.browserHost;
  if (isRecord(browserHost) && typeof browserHost.url === "string") return text;
  if (browserHost === null) return text;
  if (isRecord(result.details.playbook) || Array.isArray(result.details.nextSteps)) return text;
  if (isRecord(result.details.reviewAnnotations) || isRecord(result.details.artifactState)) return text;
  if (isRecord(browserHost) && hasBrowserHostReceiptEvidence(browserHost)) return text;
  return undefined;
}

function hasBrowserHostReceiptEvidence(browserHost: Record<string, unknown>): boolean {
  return readArrayLength(browserHost.receipts) > 0 || readArrayLength(browserHost.reviewNotes) > 0 || readArrayLength(browserHost.layoutAudits) > 0 || readArrayLength(browserHost.receiptReadErrors) > 0;
}

function readArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

const emptyCanvasComponent: Component = {
  render() {
    return [];
  },
  invalidate() {},
};

function readCanvasFromDetails(details: unknown): CanvasReadback | undefined {
  if (!isRecord(details)) return undefined;
  return isCanvasReadback(details.canvas) ? details.canvas : undefined;
}

function readBrowserHostDisplaySummaryFromDetails(details: unknown): BrowserHostDisplaySummary | undefined {
  if (!isRecord(details)) return undefined;
  const browserHost = isRecord(details.browserHost) ? details.browserHost : undefined;
  const readiness = readBrowserHostReadinessSummary(browserHost?.readiness);
  const artifactState = readBrowserHostArtifactStateSummary(browserHost?.artifactState) ?? readBrowserHostArtifactStateSummary(details.artifactState);
  const reviewAnnotations = readBrowserHostReviewAnnotationSummary(browserHost?.reviewAnnotations) ?? readBrowserHostReviewAnnotationSummary(details.reviewAnnotations);
  const summary: BrowserHostDisplaySummary = {};
  if (readiness !== undefined) summary.readiness = readiness;
  if (artifactState !== undefined) summary.artifactState = artifactState;
  if (reviewAnnotations !== undefined) summary.reviewAnnotations = reviewAnnotations;
  return Object.keys(summary).length === 0 ? undefined : summary;
}

function readBrowserHostReadinessSummary(value: unknown): BrowserHostReadinessSummary | undefined {
  if (!isRecord(value)) return undefined;
  const readiness = value;
  if (!isBrowserHostReadinessStatus(readiness.status)) return undefined;
  if (typeof readiness.readyForHandoff !== "boolean" || typeof readiness.reason !== "string" || typeof readiness.nextAction !== "string" || typeof readiness.expectedStateVersion !== "number") {
    return undefined;
  }
  const checks = readBrowserHostReadinessChecks(readiness.checks);
  if (checks === undefined) return undefined;
  return {
    status: readiness.status,
    readyForHandoff: readiness.readyForHandoff,
    reason: readiness.reason,
    nextAction: readiness.nextAction,
    expectedStateVersion: readiness.expectedStateVersion,
    ...(typeof readiness.latestReceiptStateVersion === "number" ? { latestReceiptStateVersion: readiness.latestReceiptStateVersion } : {}),
    ...(typeof readiness.latestReceiptPath === "string" ? { latestReceiptPath: readiness.latestReceiptPath } : {}),
    checks,
  };
}

function isBrowserHostReadinessStatus(value: unknown): value is BrowserHostReadinessSummary["status"] {
  return value === "ready" || value === "not-presented" || value === "pending" || value === "stale" || value === "blocked";
}

function readBrowserHostReadinessChecks(value: unknown): BrowserHostReadinessSummary["checks"] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.receiptRecorded !== "boolean" ||
    typeof value.sourceHashCurrent !== "boolean" ||
    typeof value.stateVersionCurrent !== "boolean" ||
    typeof value.latestActionAcceptedForHandoff !== "boolean" ||
    typeof value.latestReviewNoteAcceptedForHandoff !== "boolean" ||
    typeof value.latestLayoutAuditAcceptedForHandoff !== "boolean" ||
    typeof value.layoutAuditRecorded !== "boolean" ||
    typeof value.layoutAuditClean !== "boolean" ||
    typeof value.rendererResolved !== "boolean" ||
    typeof value.rendererHandoffSatisfied !== "boolean"
  ) {
    return undefined;
  }
  return {
    receiptRecorded: value.receiptRecorded,
    sourceHashCurrent: value.sourceHashCurrent,
    stateVersionCurrent: value.stateVersionCurrent,
    latestActionAcceptedForHandoff: value.latestActionAcceptedForHandoff,
    latestReviewNoteAcceptedForHandoff: value.latestReviewNoteAcceptedForHandoff,
    latestLayoutAuditAcceptedForHandoff: value.latestLayoutAuditAcceptedForHandoff,
    layoutAuditRecorded: value.layoutAuditRecorded,
    layoutAuditClean: value.layoutAuditClean,
    rendererResolved: value.rendererResolved,
    rendererHandoffSatisfied: value.rendererHandoffSatisfied,
  };
}

function readBrowserHostArtifactStateSummary(value: unknown): BrowserHostArtifactStateSummary | undefined {
  if (!isRecord(value) || !isJsonObject(value.fields)) return undefined;
  if (typeof value.rendererId !== "string" || typeof value.rendererVersion !== "number" || typeof value.kind !== "string" || !isBrowserHostArtifactStateStatus(value.status) || typeof value.summary !== "string") {
    return undefined;
  }
  return {
    rendererId: value.rendererId,
    rendererVersion: value.rendererVersion,
    kind: value.kind,
    status: value.status,
    summary: value.summary,
    fields: value.fields,
  };
}

function isBrowserHostArtifactStateStatus(value: unknown): value is BrowserHostArtifactStateSummary["status"] {
  return value === "ready" || value === "pending" || value === "blocked";
}

function readBrowserHostReviewAnnotationSummary(value: unknown): BrowserHostReviewAnnotationSummary | undefined {
  if (!isRecord(value) || typeof value.total !== "number" || typeof value.targetCount !== "number" || !Array.isArray(value.targets) || !Array.isArray(value.recent)) return undefined;
  const targets = readBrowserHostReviewAnnotationTargets(value.targets);
  const recent = readBrowserHostReviewAnnotationNotes(value.recent);
  if (targets === undefined || recent === undefined) return undefined;
  return {
    total: value.total,
    targetCount: value.targetCount,
    targets,
    recent,
  };
}

function readBrowserHostReviewAnnotationTargets(values: unknown[]): BrowserHostReviewAnnotationSummary["targets"] | undefined {
  const targets: BrowserHostReviewAnnotationSummary["targets"] = [];
  for (const value of values) {
    if (
      !isRecord(value) ||
      typeof value.targetKey !== "string" ||
      typeof value.targetKind !== "string" ||
      typeof value.label !== "string" ||
      typeof value.count !== "number" ||
      typeof value.latestNoteId !== "string" ||
      typeof value.latestText !== "string" ||
      typeof value.latestCreatedAt !== "string"
    ) {
      return undefined;
    }
    targets.push({
      targetKey: value.targetKey,
      targetKind: value.targetKind,
      label: value.label,
      count: value.count,
      latestNoteId: value.latestNoteId,
      latestText: value.latestText,
      latestCreatedAt: value.latestCreatedAt,
    });
  }
  return targets;
}

function readBrowserHostReviewAnnotationNotes(values: unknown[]): BrowserHostReviewAnnotationSummary["recent"] | undefined {
  const notes: BrowserHostReviewAnnotationSummary["recent"] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.targetKey !== "string" || typeof value.targetKind !== "string" || typeof value.label !== "string" || typeof value.text !== "string" || typeof value.createdAt !== "string") {
      return undefined;
    }
    notes.push({
      id: value.id,
      targetKey: value.targetKey,
      targetKind: value.targetKind,
      label: value.label,
      text: value.text,
      createdAt: value.createdAt,
    });
  }
  return notes;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isCanvasReadback(value: unknown): value is CanvasReadback {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.state) || !isRecord(value.paths)) return false;
  return (
    typeof value.source.artifactId === "string" &&
    typeof value.source.title === "string" &&
    typeof value.state.artifactId === "string" &&
    typeof value.state.version === "number" &&
    isJsonValue(value.state.state) &&
    typeof value.paths.sourcePath === "string" &&
    typeof value.paths.statePath === "string"
  );
}
