import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFormReadback,
  deriveStatus,
  emptyWidgetState,
  parseFormAction,
  parseFormState,
  reduceWidget,
  requiredRemaining,
  widgetStateFromJson,
  widgetStateToJson,
  type WidgetReduceResult,
} from "../src/widgets/reducers.js";
import {
  assertValidFormDefinition,
  buildFormActions,
  buildFormInitialState,
  readFormDefinition,
} from "../src/widgets/schema.js";
import type { FormDefinition, WidgetDef, WidgetState } from "../src/widgets/types.js";

function unwrap(result: WidgetReduceResult): WidgetState {
  if (!result.ok) throw new Error(`expected ok, got reject: ${result.reason}`);
  return result.next;
}

function single(id: string, options: string[], required = false): WidgetDef {
  return { id, kind: "single-select", prompt: id, required, options: options.map((o) => ({ id: o, title: o })) };
}
function multi(id: string, options: string[]): WidgetDef {
  return { id, kind: "multi-select", prompt: id, options: options.map((o) => ({ id: o, title: o })) };
}

test("single-select affirm sets one option and clears the prior selection", () => {
  const def = single("layout", ["a", "b", "c"]);
  let state = unwrap(reduceWidget(def, emptyWidgetState(def), { op: "affirm", optionId: "a" }));
  assert.equal(state.selections.a, "affirm");
  state = unwrap(reduceWidget(def, state, { op: "affirm", optionId: "b" }));
  assert.equal(state.selections.b, "affirm");
  assert.equal(state.selections.a, undefined);
  assert.equal(deriveStatus(state), "answered");
});

test("multi-select keeps affirm, negate, and blank as distinct per-option states", () => {
  const def = multi("sections", ["profile", "security", "integrations", "billing"]);
  let state = unwrap(reduceWidget(def, emptyWidgetState(def), { op: "affirm", optionId: "profile" }));
  state = unwrap(reduceWidget(def, state, { op: "affirm", optionId: "security" }));
  state = unwrap(reduceWidget(def, state, { op: "negate", optionId: "integrations" }));
  const rb = buildFormReadback({ components: [def] }, { form: { submitted: false }, components: { sections: state } });
  const c = rb.components[0];
  assert.deepEqual(c?.affirmed, ["profile", "security"]);
  assert.deepEqual(c?.negated, ["integrations"]);
  assert.deepEqual(c?.blank, ["billing"]);
  assert.equal(c?.status, "answered");
});

test("unsure clears selections and value and reports status unsure", () => {
  const rating: WidgetDef = { id: "conf", kind: "rating", prompt: "confidence", max: 5 };
  const answered = unwrap(reduceWidget(rating, emptyWidgetState(rating), { op: "value", value: 4 }));
  assert.equal(answered.value, 4);
  const unsure = unwrap(reduceWidget(rating, answered, { op: "unsure" }));
  assert.equal(unsure.unsure, true);
  assert.equal(unsure.value, null);
  assert.equal(deriveStatus(unsure), "unsure");
});

test("skip is rejected on a required widget and accepted on an optional one", () => {
  const required = single("motion", ["x", "y"], true);
  assert.equal(reduceWidget(required, emptyWidgetState(required), { op: "skip" }).ok, false);
  const optional = single("extras", ["x", "y"]);
  const skipped = unwrap(reduceWidget(optional, emptyWidgetState(optional), { op: "skip" }));
  assert.equal(deriveStatus(skipped), "skipped");
});

test("note is orthogonal — it does not change status or clear confirmation", () => {
  const def = single("q", ["a", "b"]);
  let state = unwrap(reduceWidget(def, emptyWidgetState(def), { op: "affirm", optionId: "a" }));
  state = unwrap(reduceWidget(def, state, { op: "confirm" }));
  assert.equal(state.confirmed, true);
  assert.notEqual(state.confirmedSignature, null);
  const withNote = unwrap(reduceWidget(def, state, { op: "note", note: "because mobile" }));
  assert.equal(withNote.note, "because mobile");
  assert.equal(withNote.confirmed, true);
  assert.equal(deriveStatus(withNote), "answered");
});

test("changing a selection clears a prior confirmation", () => {
  const def = single("q", ["a", "b"]);
  let state = unwrap(reduceWidget(def, emptyWidgetState(def), { op: "affirm", optionId: "a" }));
  state = unwrap(reduceWidget(def, state, { op: "confirm" }));
  assert.equal(state.confirmed, true);
  const changed = unwrap(reduceWidget(def, state, { op: "affirm", optionId: "b" }));
  assert.equal(changed.confirmed, false);
  assert.equal(changed.confirmedSignature, null);
});

test("clear rejects an unknown option id and accepts a known one", () => {
  const def = single("layout", ["a", "b"]);
  let state = unwrap(reduceWidget(def, emptyWidgetState(def), { op: "affirm", optionId: "a" }));
  assert.equal(reduceWidget(def, state, { op: "clear", optionId: "nope" }).ok, false);
  assert.equal(state.selections.a, "affirm");
  state = unwrap(reduceWidget(def, state, { op: "clear", optionId: "a" }));
  assert.equal(state.selections.a, undefined);
  assert.equal(deriveStatus(state), "untouched");
});

test("rating rejects out-of-range values and accepts valid ones", () => {
  const rating: WidgetDef = { id: "conf", kind: "rating", prompt: "c", max: 5 };
  assert.equal(reduceWidget(rating, emptyWidgetState(rating), { op: "value", value: 9 }).ok, false);
  assert.equal(reduceWidget(rating, emptyWidgetState(rating), { op: "value", value: 0 }).ok, false);
  const ok = unwrap(reduceWidget(rating, emptyWidgetState(rating), { op: "value", value: 3 }));
  assert.equal(ok.value, 3);
});

test("required-remaining blocks on untouched required and is satisfied by an answer or unsure", () => {
  const defA = single("a", ["x", "y"], true);
  const defB = single("b", ["p", "q"]);
  const def: FormDefinition = { components: [defA, defB] };
  const state = parseFormState(buildFormInitialState(def), def);
  assert.deepEqual(requiredRemaining(def, state), ["a"]);
  state.components.a = unwrap(reduceWidget(defA, state.components.a as WidgetState, { op: "affirm", optionId: "x" }));
  assert.deepEqual(requiredRemaining(def, state), []);
  // an explicit "not sure" also satisfies required
  state.components.a = unwrap(reduceWidget(defA, emptyWidgetState(defA), { op: "unsure" }));
  assert.deepEqual(requiredRemaining(def, state), []);
});

test("required short-text is not satisfied by an empty or whitespace value", () => {
  const defT: WidgetDef = { id: "note", kind: "short-text", prompt: "note", required: true };
  const def: FormDefinition = { components: [defT] };
  const state = parseFormState(buildFormInitialState(def), def);
  assert.deepEqual(requiredRemaining(def, state), ["note"]);

  // an empty string is normalized to null and does NOT satisfy the requirement
  const empty = unwrap(reduceWidget(defT, emptyWidgetState(defT), { op: "value", value: "" }));
  assert.equal(empty.value, null);
  assert.equal(deriveStatus(empty), "untouched");
  state.components.note = empty;
  assert.deepEqual(requiredRemaining(def, state), ["note"]);

  // whitespace-only text is treated the same
  const whitespace = unwrap(reduceWidget(defT, emptyWidgetState(defT), { op: "value", value: "   " }));
  assert.equal(whitespace.value, null);
  state.components.note = whitespace;
  assert.deepEqual(requiredRemaining(def, state), ["note"]);

  // real text answers it
  const filled = unwrap(reduceWidget(defT, emptyWidgetState(defT), { op: "value", value: "ship it" }));
  assert.equal(filled.value, "ship it");
  assert.equal(deriveStatus(filled), "answered");
  state.components.note = filled;
  assert.deepEqual(requiredRemaining(def, state), []);
});

test("reserved object keys are rejected as widget and option ids", () => {
  for (const id of ["__proto__", "constructor", "prototype"]) {
    assert.throws(
      () => assertValidFormDefinition({ components: [{ id, kind: "single-select", prompt: id, options: [{ id: "a", title: "A" }] }] }),
      /invalid widget id/,
    );
    assert.throws(
      () => assertValidFormDefinition({ components: [{ id: "safe", kind: "single-select", prompt: id, options: [{ id, title: "A" }] }] }),
      /invalid option id/,
    );
  }
});

test("widgetStateFromJson drops out-of-contract values and selections to untouched (kind-aware rehydration)", () => {
  const rating: WidgetDef = { id: "r", kind: "rating", prompt: "r", max: 5 };
  assert.equal(widgetStateFromJson({ value: 9999 }, rating).value, null); // out of range
  assert.equal(widgetStateFromJson({ value: {} }, rating).value, null); // wrong type
  assert.equal(deriveStatus(widgetStateFromJson({ value: 9999 }, rating)), "untouched");
  assert.equal(widgetStateFromJson({ value: 3 }, rating).value, 3); // in-range survives
  assert.deepEqual(widgetStateFromJson({ selections: { ghost: "affirm" } }, rating).selections, {});

  const text: WidgetDef = { id: "t", kind: "short-text", prompt: "t" };
  assert.equal(widgetStateFromJson({ value: "   " }, text).value, null); // whitespace-only
  assert.equal(widgetStateFromJson({ value: 42 }, text).value, null); // wrong type
  assert.equal(widgetStateFromJson({ value: "ok" }, text).value, "ok"); // real text survives

  const select = single("s", ["a", "b"], true);
  assert.deepEqual(widgetStateFromJson({ selections: { a: "affirm", ghost: "negate" } }, select).selections, { a: "affirm" });
  const doubleSelection = widgetStateFromJson({ selections: { a: "affirm", b: "negate" } }, select);
  assert.deepEqual(doubleSelection.selections, {});
  assert.equal(deriveStatus(doubleSelection), "untouched");
  const reservedSelection = Object.fromEntries([["__proto__", "affirm"]]);
  assert.deepEqual(widgetStateFromJson({ selections: reservedSelection }, select).selections, {});

  const unsure = widgetStateFromJson({ selections: { a: "affirm" }, unsure: true }, select);
  assert.deepEqual(unsure.selections, {});
  assert.equal(deriveStatus(unsure), "unsure");
  const noUnsure = { ...select, allowUnsure: false };
  assert.equal(deriveStatus(widgetStateFromJson({ unsure: true }, noUnsure)), "untouched");
  assert.equal(deriveStatus(widgetStateFromJson({ skipped: true }, select)), "untouched");

  const answered = unwrap(reduceWidget(select, emptyWidgetState(select), { op: "affirm", optionId: "a" }));
  const confirmed = unwrap(reduceWidget(select, answered, { op: "confirm" }));
  assert.equal(widgetStateFromJson(widgetStateToJson(confirmed), select).confirmed, true);
  const staleConfirmation = widgetStateFromJson({ ...widgetStateToJson(confirmed), confirmedSignature: "stale" }, select);
  assert.equal(staleConfirmation.confirmed, false);
  assert.equal(staleConfirmation.confirmedSignature, null);
  const emptyConfirmation = widgetStateFromJson(
    { confirmed: true, confirmedSignature: JSON.stringify(["", null, false, false]) },
    select,
  );
  assert.equal(deriveStatus(emptyConfirmation), "untouched");
  assert.equal(emptyConfirmation.confirmed, false);
});

test("form source builders declare one path per component plus form.submitted", () => {
  const def: FormDefinition = { components: [single("a", ["x"]), single("b", ["y"])] };
  assert.deepEqual(
    buildFormActions(def).map((a) => a.path),
    ["components.a", "components.b", "form.submitted"],
  );
});

test("parseFormAction rejects an unknown op", () => {
  assert.equal(parseFormAction({ op: "frobnicate" }).ok, false);
  assert.equal(parseFormAction({ op: "affirm", optionId: "x" }).ok, true);
});

test("assertValidFormDefinition requires a take on every design-variant option", () => {
  assert.throws(() =>
    assertValidFormDefinition({
      components: [{ id: "v", kind: "design-variant", prompt: "p", options: [{ id: "o1", title: "o1" }] }],
    }),
  );
  assert.doesNotThrow(() =>
    assertValidFormDefinition({
      components: [{ id: "v", kind: "design-variant", prompt: "p", options: [{ id: "o1", title: "o1", take: "quiet and dense" }] }],
    }),
  );
});

test("readFormDefinition round-trips a stored props manifest", () => {
  const def = readFormDefinition({
    components: [
      { id: "layout", kind: "single-select", prompt: "Layout", required: true, options: [{ id: "a", title: "A" }] },
      { id: "junk", kind: "not-a-kind", prompt: "x" },
    ],
  });
  assert.equal(def.components.length, 1);
  assert.equal(def.components[0]?.id, "layout");
  assert.equal(def.components[0]?.required, true);
});
