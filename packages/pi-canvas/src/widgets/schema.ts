// Form source builders (plan U3): fan a FormDefinition into the (stateSchema,
// initialState, actions, actionSchema) a canvas source needs. The store applies
// each browser action as a single `set components.<id>` (or `set form.submitted`)
// transition — so every settable path is declared here (exact-match, store.ts:710),
// and option ids are validated in the reducer rather than pinned into the schema
// enum, so an option set can change without a rejected schema (unlike the legacy
// option chooser).

import { isJsonObject } from "../json.js";
import type { CanvasActionDefinition, JsonObject, JsonValue } from "../types.js";
import { emptyWidgetState, FORM_OPS, widgetStateToJson } from "./reducers.js";
import {
  type FormDefinition,
  isWidgetKind,
  type PreviewKind,
  type WidgetDef,
  type WidgetOptionDef,
} from "./types.js";

const WIDGET_ID_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
// Reserved JS object keys match the pattern but corrupt state: components.__proto__ writes the
// prototype instead of an own key, and the write silently vanishes on JSON.stringify. Reject them.
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PREVIEW_KINDS: readonly PreviewKind[] = ["motion", "density", "spacing", "swatch"];

/** Lenient parse of the stored form view `props` into a FormDefinition (for rendering). */
export function readFormDefinition(props: JsonObject | undefined): FormDefinition {
  const components: WidgetDef[] = [];
  const raw = props && Array.isArray(props.components) ? props.components : [];
  for (const item of raw) {
    if (!isJsonObject(item)) continue;
    const id = typeof item.id === "string" ? item.id : undefined;
    const kind = item.kind;
    if (!id || !isWidgetKind(kind)) continue;
    const def: WidgetDef = { id, kind, prompt: typeof item.prompt === "string" ? item.prompt : "" };
    if (item.required === true) def.required = true;
    if (item.allowUnsure === false) def.allowUnsure = false;
    if (item.allowNote === true) def.allowNote = true;
    if (typeof item.previewKind === "string" && (PREVIEW_KINDS as readonly string[]).includes(item.previewKind)) {
      def.previewKind = item.previewKind as PreviewKind;
    }
    if (typeof item.max === "number") def.max = item.max;
    if (typeof item.html === "string") def.html = item.html;
    if (typeof item.placeholder === "string") def.placeholder = item.placeholder;
    if (Array.isArray(item.options)) {
      const options: WidgetOptionDef[] = [];
      for (const rawOpt of item.options) {
        if (!isJsonObject(rawOpt) || typeof rawOpt.id !== "string") continue;
        const opt: WidgetOptionDef = { id: rawOpt.id, title: typeof rawOpt.title === "string" ? rawOpt.title : rawOpt.id };
        if (typeof rawOpt.detail === "string") opt.detail = rawOpt.detail;
        if (typeof rawOpt.take === "string") opt.take = rawOpt.take;
        if (typeof rawOpt.html === "string") opt.html = rawOpt.html;
        if (rawOpt.previewValue !== undefined) opt.previewValue = rawOpt.previewValue;
        options.push(opt);
      }
      def.options = options;
    }
    components.push(def);
  }
  return { components, requireSubmit: props?.requireSubmit === true };
}

/** Strict validation for create time — throws on a malformed form definition. */
export function assertValidFormDefinition(def: FormDefinition): void {
  if (def.components.length === 0) throw new Error("form requires at least one component");
  const seen = new Set<string>();
  for (const wdef of def.components) {
    if (!WIDGET_ID_PATTERN.test(wdef.id) || RESERVED_OBJECT_KEYS.has(wdef.id)) throw new Error(`invalid widget id: ${wdef.id}`);
    if (seen.has(wdef.id)) throw new Error(`duplicate widget id: ${wdef.id}`);
    seen.add(wdef.id);
    const needsOptions = wdef.kind === "single-select" || wdef.kind === "multi-select" || wdef.kind === "design-variant";
    if (needsOptions && (!wdef.options || wdef.options.length === 0)) {
      throw new Error(`widget ${wdef.id} (${wdef.kind}) requires options`);
    }
    if (wdef.kind === "design-variant") {
      for (const opt of wdef.options ?? []) {
        if (!opt.take || opt.take.trim().length === 0) {
          throw new Error(`design-variant option ${wdef.id}.${opt.id} requires a one-sentence "take"`);
        }
      }
    }
    if (wdef.kind === "html-embed" && (typeof wdef.html !== "string" || wdef.html.length === 0)) {
      throw new Error(`html-embed widget ${wdef.id} requires html content`);
    }
    const optionIds = new Set<string>();
    for (const opt of wdef.options ?? []) {
      if (optionIds.has(opt.id)) throw new Error(`duplicate option id in ${wdef.id}: ${opt.id}`);
      optionIds.add(opt.id);
    }
  }
}

export function buildFormInitialState(def: FormDefinition): JsonValue {
  const components: JsonObject = {};
  for (const wdef of def.components) {
    components[wdef.id] = widgetStateToJson(emptyWidgetState(wdef));
  }
  return { form: { submitted: false }, components };
}

/** Structural schema — validates the top-level shape, leaves per-widget internals to the reducer. */
export function buildFormStateSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      form: {
        type: "object",
        properties: { submitted: { type: "boolean" } },
        required: ["submitted"],
      },
      components: { type: "object" },
    },
    required: ["form", "components"],
  };
}

/** One declared `set` path per component + `form.submitted` (exact-match validated by the store). */
export function buildFormActions(def: FormDefinition): CanvasActionDefinition[] {
  const actions: CanvasActionDefinition[] = def.components.map((wdef) => ({
    type: "set",
    path: `components.${wdef.id}`,
    label: `Set ${wdef.id}`,
  }));
  actions.push({ type: "set", path: "form.submitted", label: "Submit form" });
  return actions;
}

/** Permissive union action schema — one shape for every widget op; the reducer validates per kind. */
export function buildFormActionSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      componentId: { type: "string" },
      op: { type: "string", enum: [...FORM_OPS] },
      optionId: { type: "string" },
      value: {},
      note: { type: "string" },
    },
    required: ["op"],
  };
}
