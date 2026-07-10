// Widget reducer table + derived-state helpers for `builtin.canvas` (ADR 0003, plan U3).
//
// Each browser action names a `componentId` + `op`; the reducer applies the op to
// that widget's sub-state and enforces the answer-model invariants atomically:
//   - confirmed === true  iff  confirmedSignature !== null
//   - unsure === true      ⟹  (every option unset AND value === null)
//   - skipped === true     ⟹  widget is not required (else reject)
//   - note is orthogonal   — never changes status, never clears confirmation
// `status` is derived, never stored, so there is no co-variance to keep in sync.

import { isJsonObject, isSafeJsonObjectKey } from "../json.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
  type FormActionEnvelope,
  type FormDefinition,
  type FormOp,
  type FormReadback,
  type FormReadbackComponent,
  type FormState,
  type OptionAnswer,
  type WidgetDef,
  type WidgetState,
  type WidgetStatus,
} from "./types.js";

export const FORM_OPS: readonly FormOp[] = [
  "affirm",
  "negate",
  "clear",
  "unsure",
  "skip",
  "note",
  "value",
  "confirm",
  "submit",
];

export type WidgetReduceResult = { ok: true; next: WidgetState } | { ok: false; reason: string };

export function emptyWidgetState(def: WidgetDef): WidgetState {
  return {
    kind: def.kind,
    selections: {},
    value: null,
    unsure: false,
    skipped: false,
    note: null,
    confirmed: false,
    confirmedSignature: null,
  };
}

export function widgetStateToJson(w: WidgetState): JsonObject {
  return {
    kind: w.kind,
    selections: { ...w.selections },
    value: w.value,
    unsure: w.unsure,
    skipped: w.skipped,
    note: w.note,
    confirmed: w.confirmed,
    confirmedSignature: w.confirmedSignature,
  };
}

type WidgetValueNormalization = { ok: true; value: JsonValue | null } | { ok: false };

function ratingMax(def: WidgetDef): number {
  return typeof def.max === "number" && def.max > 0 ? def.max : 5;
}

function normalizeProvidedWidgetValue(def: WidgetDef, raw: JsonValue): WidgetValueNormalization {
  if (def.kind === "rating") {
    const max = ratingMax(def);
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= max
      ? { ok: true, value: raw }
      : { ok: false };
  }
  if (def.kind === "short-text") {
    return typeof raw === "string"
      ? { ok: true, value: raw.trim().length > 0 ? raw : null }
      : { ok: false };
  }
  return { ok: false }; // select / design-variant / html-embed carry no scalar value
}

/** Rehydrate a persisted/foreign `value` only if it fits the widget's kind; otherwise null (untouched). */
function normalizeWidgetValue(def: WidgetDef, raw: JsonValue | undefined): JsonValue | null {
  if (raw === undefined || raw === null) return null;
  const normalized = normalizeProvidedWidgetValue(def, raw);
  return normalized.ok ? normalized.value : null;
}

function isSelectionWidget(def: WidgetDef): boolean {
  return def.kind === "single-select" || def.kind === "multi-select" || def.kind === "design-variant";
}

function isSingleSelectionWidget(def: WidgetDef): boolean {
  return def.kind === "single-select" || def.kind === "design-variant";
}

/** Keep only reducer-reachable selections for the current definition; malformed input degrades to untouched. */
function normalizeWidgetSelections(def: WidgetDef, raw: JsonValue | undefined): Record<string, OptionAnswer> {
  if (!isSelectionWidget(def) || !isJsonObject(raw)) return {};
  const optionIds = new Set((def.options ?? []).map((option) => option.id));
  const selections: Array<[string, OptionAnswer]> = [];
  for (const [key, answer] of Object.entries(raw)) {
    if (!isSafeJsonObjectKey(key) || !optionIds.has(key)) continue;
    if (answer === "affirm" || answer === "negate" || answer === "unset") selections.push([key, answer]);
  }
  if (isSingleSelectionWidget(def) && selections.length > 1) return {};
  return Object.fromEntries(selections);
}

export function widgetStateFromJson(value: JsonValue | undefined, def: WidgetDef): WidgetState {
  if (!isJsonObject(value)) return emptyWidgetState(def);
  const selections = normalizeWidgetSelections(def, value.selections);
  const normalizedValue = normalizeWidgetValue(def, value.value);
  const skipped = value.skipped === true && def.required !== true;
  const unsure = !skipped && value.unsure === true && def.allowUnsure !== false;
  const base: WidgetState = {
    kind: def.kind,
    selections: skipped || unsure ? {} : selections,
    value: skipped || unsure ? null : normalizedValue,
    unsure,
    skipped,
    note: typeof value.note === "string" ? value.note : null,
    confirmed: false,
    confirmedSignature: null,
  };
  const confirmedSignature = typeof value.confirmedSignature === "string" ? value.confirmedSignature : null;
  return value.confirmed === true && deriveStatus(base) !== "untouched" && confirmedSignature === signatureOf(base)
    ? { ...base, confirmed: true, confirmedSignature }
    : base;
}

export function hasAnswer(w: WidgetState): boolean {
  // Empty or whitespace-only short-text is not an answer (rating values are numbers,
  // which are always answers when non-null). Guards a required text field from being
  // satisfied by a blank string.
  if (w.value !== null) return typeof w.value === "string" ? w.value.trim().length > 0 : true;
  return Object.values(w.selections).some((a) => a === "affirm" || a === "negate");
}

export function deriveStatus(w: WidgetState): WidgetStatus {
  if (w.skipped) return "skipped";
  if (w.unsure) return "unsure";
  return hasAnswer(w) ? "answered" : "untouched";
}

function signatureOf(w: WidgetState): string {
  const selection = Object.keys(w.selections)
    .sort()
    .map((key) => `${key}:${w.selections[key]}`)
    .join(",");
  return JSON.stringify([selection, w.value, w.unsure, w.skipped]);
}

function clearConfirm(w: WidgetState): WidgetState {
  return { ...w, confirmed: false, confirmedSignature: null };
}

function invalidWidgetValueReason(def: WidgetDef): string {
  return def.kind === "rating"
    ? `rating for ${def.id} must be an integer 1..${ratingMax(def)}`
    : `text for ${def.id} must be a string`;
}

/** Apply one op to a widget's sub-state, enforcing the answer-model invariants. */
export function reduceWidget(def: WidgetDef, current: WidgetState, action: FormActionEnvelope): WidgetReduceResult {
  const kind = def.kind;
  const isSelect = isSelectionWidget(def);
  const isSingle = isSingleSelectionWidget(def);
  const optionIds = new Set((def.options ?? []).map((o) => o.id));

  switch (action.op) {
    case "affirm":
    case "negate": {
      if (!isSelect) return { ok: false, reason: `widget ${def.id} (${kind}) does not take option selections` };
      const optionId = action.optionId;
      if (!optionId || !optionIds.has(optionId)) {
        return { ok: false, reason: `unknown option for ${def.id}: ${optionId ?? "(none)"}` };
      }
      const answer: OptionAnswer = action.op === "affirm" ? "affirm" : "negate";
      const selections: Record<string, OptionAnswer> = isSingle
        ? { [optionId]: answer }
        : { ...current.selections, [optionId]: answer };
      return { ok: true, next: clearConfirm({ ...current, selections, value: null, unsure: false, skipped: false }) };
    }
    case "clear": {
      if (!isSelect) return { ok: false, reason: `widget ${def.id} does not take option selections` };
      const optionId = action.optionId;
      if (!optionId || !optionIds.has(optionId)) {
        return { ok: false, reason: `unknown option for ${def.id}: ${optionId ?? "(none)"}` };
      }
      const selections = { ...current.selections };
      delete selections[optionId];
      return { ok: true, next: clearConfirm({ ...current, selections }) };
    }
    case "unsure": {
      if (def.allowUnsure === false) return { ok: false, reason: `widget ${def.id} does not allow "not sure"` };
      const nextUnsure = !current.unsure;
      return {
        ok: true,
        next: clearConfirm({
          ...current,
          unsure: nextUnsure,
          selections: nextUnsure ? {} : current.selections,
          value: nextUnsure ? null : current.value,
          skipped: false,
        }),
      };
    }
    case "skip": {
      if (def.required) return { ok: false, reason: `required widget ${def.id} cannot be skipped` };
      const nextSkipped = !current.skipped;
      return {
        ok: true,
        next: clearConfirm({
          ...current,
          skipped: nextSkipped,
          selections: nextSkipped ? {} : current.selections,
          value: nextSkipped ? null : current.value,
          unsure: false,
        }),
      };
    }
    case "note": {
      // Orthogonal: never changes the answer or clears confirmation.
      const note = typeof action.note === "string" ? action.note : null;
      return { ok: true, next: { ...current, note } };
    }
    case "value": {
      if (kind !== "rating" && kind !== "short-text") {
        return { ok: false, reason: `widget ${def.id} (${kind}) does not take a value` };
      }
      const raw = action.value;
      if (raw === undefined) return { ok: false, reason: invalidWidgetValueReason(def) };
      const normalized = normalizeProvidedWidgetValue(def, raw);
      if (!normalized.ok) return { ok: false, reason: invalidWidgetValueReason(def) };
      return { ok: true, next: clearConfirm({ ...current, value: normalized.value, unsure: false, skipped: false, selections: {} }) };
    }
    case "confirm": {
      if (deriveStatus(current) === "untouched") return { ok: false, reason: `nothing to confirm for ${def.id}` };
      return { ok: true, next: { ...current, confirmed: true, confirmedSignature: signatureOf(current) } };
    }
    case "submit":
      return { ok: false, reason: "submit is a form-level action, not a widget op" };
    default:
      return { ok: false, reason: `unknown op` };
  }
}

export function parseFormAction(
  action: JsonObject,
): { ok: true; envelope: FormActionEnvelope } | { ok: false; reason: string } {
  const op = action.op;
  if (typeof op !== "string" || !(FORM_OPS as readonly string[]).includes(op)) {
    return { ok: false, reason: `invalid form op: ${String(op)}` };
  }
  const envelope: FormActionEnvelope = { op: op as FormOp };
  if (typeof action.componentId === "string") envelope.componentId = action.componentId;
  if (typeof action.optionId === "string") envelope.optionId = action.optionId;
  if (typeof action.note === "string") envelope.note = action.note;
  if (action.value !== undefined) envelope.value = action.value;
  return { ok: true, envelope };
}

export function parseFormState(value: JsonValue | undefined, def: FormDefinition): FormState {
  const components: Record<string, WidgetState> = {};
  const rawComponents = isJsonObject(value) && isJsonObject(value.components) ? value.components : {};
  for (const wdef of def.components) {
    components[wdef.id] = widgetStateFromJson(rawComponents[wdef.id], wdef);
  }
  const submitted =
    isJsonObject(value) && isJsonObject(value.form) && value.form.submitted === true ? true : false;
  return { form: { submitted }, components };
}

/** Required widgets not yet answered or explicitly marked "not sure" — the handoff blockers. */
export function requiredRemaining(def: FormDefinition, state: FormState): string[] {
  const remaining: string[] = [];
  for (const wdef of def.components) {
    if (!wdef.required) continue;
    const status = deriveStatus(state.components[wdef.id] ?? emptyWidgetState(wdef));
    if (status !== "answered" && status !== "unsure") remaining.push(wdef.id);
  }
  return remaining;
}

export function buildFormReadback(def: FormDefinition, state: FormState): FormReadback {
  const components: FormReadbackComponent[] = [];
  let answered = 0;
  let blank = 0;
  let skipped = 0;
  const remaining: string[] = [];
  for (const wdef of def.components) {
    const w = state.components[wdef.id] ?? emptyWidgetState(wdef);
    const status = deriveStatus(w);
    const affirmed: string[] = [];
    const negated: string[] = [];
    const blankOpts: string[] = [];
    for (const opt of wdef.options ?? []) {
      const answer = w.selections[opt.id];
      if (answer === "affirm") affirmed.push(opt.id);
      else if (answer === "negate") negated.push(opt.id);
      else blankOpts.push(opt.id);
    }
    if (status === "answered" || status === "unsure") answered += 1;
    else if (status === "skipped") skipped += 1;
    else blank += 1;
    if (wdef.required && status !== "answered" && status !== "unsure") remaining.push(wdef.id);
    components.push({
      id: wdef.id,
      kind: wdef.kind,
      prompt: wdef.prompt,
      required: wdef.required === true,
      status,
      confirmed: w.confirmed,
      affirmed,
      negated,
      blank: blankOpts,
      value: w.value,
      unsure: w.unsure,
      note: w.note,
    });
  }
  return {
    submitted: state.form.submitted === true,
    rollup: { total: def.components.length, answered, blank, skipped, requiredRemaining: remaining },
    components,
  };
}
