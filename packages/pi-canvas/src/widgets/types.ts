// Widget vocabulary for the composable `builtin.canvas` renderer (ADR 0003).
//
// A form artifact is an ordered list of trusted, Pi-owned widgets, each with its
// own canonical sub-state under `components.<id>`. These are pure type
// definitions — the reducer table (`./reducers.ts`) and schema builders
// (`./schema.ts`) give them behavior, and `../builtin-form-renderer.ts` renders
// and reduces them through the existing `BrowserArtifactRenderer` contract.

import type { JsonObject, JsonValue } from "../types.js";

export const CANVAS_BROWSER_RENDERER_ID = "builtin.canvas";
export const CANVAS_BROWSER_RENDERER_VERSION = 1;

export const WIDGET_KINDS = [
  "single-select",
  "multi-select",
  "rating",
  "short-text",
  "design-variant",
  "html-embed",
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export function isWidgetKind(value: unknown): value is WidgetKind {
  return typeof value === "string" && (WIDGET_KINDS as readonly string[]).includes(value);
}

/** Per-option answer. `unset` is the default (blank); `negate` means considered-and-declined. */
export type OptionAnswer = "unset" | "affirm" | "negate";

/** Derived (never stored) — computed from the primitives so there is no co-variance to keep in sync. */
export type WidgetStatus = "untouched" | "answered" | "unsure" | "skipped";

/** A widget option (single-select, multi-select, design-variant). */
export interface WidgetOptionDef {
  id: string;
  title: string;
  detail?: string;
  /** design-variant only: required one-sentence committed direction, surfaced in provenance. */
  take?: string;
  /** design-variant only: self-contained page content rendered in a sandboxed, token-free iframe. */
  html?: string;
  /** preview binding: the value applied to a local demo element when this option is chosen. */
  previewValue?: JsonValue;
}

/** Live-preview binding — applies a chosen value to a local demo element with no round-trip. */
export type PreviewKind = "motion" | "density" | "spacing" | "swatch";

/** Authoring-time definition of one widget, stored in the form view `props`. */
export interface WidgetDef {
  id: string;
  kind: WidgetKind;
  prompt: string;
  required?: boolean;
  /** select / design-variant options. */
  options?: WidgetOptionDef[];
  allowUnsure?: boolean;
  allowNote?: boolean;
  /** binds an option's `previewValue` to a local demo element. */
  previewKind?: PreviewKind;
  /** rating: number of steps (default 5). */
  max?: number;
  /** html-embed: self-contained display-only content, sandboxed. */
  html?: string;
  /** short-text placeholder. */
  placeholder?: string;
}

export interface FormDefinition {
  components: WidgetDef[];
  /** when true, handoff pends until the human submits — a hard async checkpoint. */
  requireSubmit?: boolean;
}

/** Canonical per-widget sub-state. JSON-serializable; stored under `components.<id>`. */
export interface WidgetState {
  kind: WidgetKind;
  /** per-option answers (select / design-variant); `{}` for value widgets. */
  selections: Record<string, OptionAnswer>;
  /** rating (number) or short-text (string); `null` when blank. */
  value: JsonValue | null;
  /** explicit "I'm not sure" — distinct from untouched. */
  unsure: boolean;
  /** explicit decline of the whole widget (optional widgets only). */
  skipped: boolean;
  /** free-text supplement, orthogonal to the answer. */
  note: string | null;
  confirmed: boolean;
  confirmedSignature: string | null;
}

export interface FormState {
  form: { submitted: boolean };
  components: Record<string, WidgetState>;
}

/** Op carried by a browser action envelope, validated against the renderer actionSchema pre-reduce. */
export type FormOp = "affirm" | "negate" | "clear" | "unsure" | "skip" | "note" | "value" | "confirm" | "submit";

export interface FormActionEnvelope {
  componentId?: string;
  op: FormOp;
  optionId?: string;
  value?: JsonValue;
  note?: string;
}

/** Per-component readback returned by `canvas_read`. */
export interface FormReadbackComponent {
  id: string;
  kind: WidgetKind;
  prompt: string;
  required: boolean;
  status: WidgetStatus;
  confirmed: boolean;
  affirmed: string[];
  negated: string[];
  blank: string[];
  value: JsonValue | null;
  unsure: boolean;
  note: string | null;
}

export interface FormReadbackRollup {
  total: number;
  answered: number;
  blank: number;
  skipped: number;
  /** ids of required widgets not yet answered or marked "not sure" — the handoff blockers. */
  requiredRemaining: string[];
}

export interface FormReadback {
  submitted: boolean;
  rollup: FormReadbackRollup;
  components: FormReadbackComponent[];
}

/** Narrow a stored JsonValue back to FormState shape without trusting it blindly. */
export function isFormStateShape(value: JsonValue | undefined): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as JsonObject).form === "object" &&
    typeof (value as JsonObject).components === "object"
  );
}
