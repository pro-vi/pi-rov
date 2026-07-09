# Pi Canvas Harness Matrix

The harness is the release oracle for `pi-canvas`. A browser screenshot can
support a claim, but it cannot satisfy source, state, interaction, review, or
export claims by itself.

`src/harness.ts` runs 32 scenarios (13 green, 19 expected-red); `npm run
check` runs the same 32 ids. Every id in `HarnessScenarioId` has a row below.

The `html-iframe-state-bridge` lane (9 of the 32 scenarios: 4 green, 5 red)
guards the same claim as the browser-host lane for adjacent, non-Pi-owned
HTML: an iframe can render and look interactive for free, but only a typed
`postMessage-json-rpc` bridge action that reaches one of Pi's declared `set`
paths — validated against a declared action schema and Pi's state schema —
commits canonical state; DOM appearance, iframe-local state, and
browser/terminal transcripts are evidence only, never the source of truth.

## Green Scenarios

| Scenario | Claim proven |
|---|---|
| `roundtrip-green` | Durable source, state, action log, readback, and export exist in the base store. |
| `rpc-ui-roundtrip-green` | Pi command/RPC surface can drive create, update, read, and export without relying on browser state. |
| `direct-tui-roundtrip-green` | Pi TUI renderer components can mutate durable state. |
| `live-tui-roundtrip-green` | Live Pi TTY flow can exercise the terminal-native artifact path. |
| `browser-terminal-roundtrip-green` | Browser-addressable terminal proof is recorded as evaluator substrate, not product authority. |
| `iframe-state-bridge-contract-green` | Adjacent iframe view declares a typed JSON-RPC action/state bridge without making HTML canonical state; a bridge action persists to Pi-owned state, agrees on readback, and exports diffably. |
| `iframe-action-roundtrip-green` | Typed bridge actions roundtrip string and boolean fields into Pi-owned state through the adjacent host, and a malformed bridge action (extra params not in the declared schema) is rejected. |
| `iframe-holdout-task-board-green` | A richer held-out iframe app (filter/sort/select/nested-toggle) persists every control through Pi-owned reducers, and an out-of-enum bridge value is rejected before persistence. |
| `browser-terminal-replay-agreement-green` | Browser DOM transcript, terminal replay evidence, and Pi readback agree on iframe-bridged state after interaction. |
| `browser-host-contract-green` | Local browser host records signed URL, session, source hash, state version, origin, and fallback policy. |
| `browser-host-review-note-green` | Receipt-backed review notes are recorded without mutating canonical renderer state. |
| `browser-host-same-trace-success-gate-green` | One trace ties visual evidence, action, state, readback, export, and receipt evidence. |
| `browser-host-reopen-focus-green` | Presenting an eligible artifact focuses the existing host session instead of duplicating state. |

## Expected-Red Controls

| Scenario | Failure protected against |
|---|---|
| `visual-only-red` | A visual render without structured state/readback is not a canvas artifact. |
| `unpersisted-state-red` | UI-local mutation without durable state fails. |
| `export-without-diff-red` | Opaque previews without source/state/provenance diffs fail. |
| `browser-terminal-disagreement-red` | Outside-in terminal/browser evidence cannot contradict Pi readback/export. |
| `iframe-visual-only-red` | An iframe that renders a plausible control but never emits a typed bridge action leaves Pi state and the action log untouched. |
| `iframe-unpersisted-state-red` | Iframe-local state changes that never cross the typed bridge do not reach Pi-owned state or the action log. |
| `iframe-bridge-disagreement-red` | A bridge event with no matching Pi state/export change is caught, not accepted as fact. |
| `iframe-sandbox-policy-red` | A loose iframe sandbox/CSP policy (`allow-same-origin`, wildcard `script-src`) fails the sandbox/CSP policy check. |
| `browser-terminal-replay-disagreement-red` | Browser DOM transcript and terminal replay evidence that disagree with each other or with Pi readback are caught, not accepted as fact. |
| `browser-host-raw-html-file-red` | Opening raw HTML is not product progress. |
| `browser-host-dom-state-red` | Browser-local DOM state is not canonical Pi state. |
| `browser-host-stale-version-red` | Stale source hash or state version browser actions are rejected. |
| `browser-host-concurrent-stale-red` | Concurrent same-version browser actions cannot both commit. |
| `browser-host-wrong-session-red` | Wrong token, origin, artifact, or session is rejected. |
| `browser-host-export-without-diff-red` | Browser-host success without diffable export fails. |
| `browser-host-visual-only-red` | Browser visual evidence without typed Pi action/readback fails. |
| `browser-host-layout-overflow-red` | Overflow layout breakage blocks visual readiness. |
| `browser-host-layout-clipped-text-red` | Clipped text blocks visual readiness. |
| `browser-host-layout-overlap-red` | Overlapping UI blocks visual readiness. |

## Release Claim Coverage

| Release claim | Green evidence | Red evidence |
|---|---|---|
| HTML is a renderer only. | browser-host green scenarios | `browser-host-dom-state-red`, `browser-host-visual-only-red`, `browser-host-raw-html-file-red` |
| Agent can read the result after user interaction. | `browser-host-review-note-green`, `browser-host-contract-green`, `browser-host-same-trace-success-gate-green` | `unpersisted-state-red`, `browser-terminal-disagreement-red` |
| Export is reviewable. | green export assertions | `export-without-diff-red`, `browser-host-export-without-diff-red` |
| Visual quality is checked, not assumed. | clean layout audits in browser-host greens | layout expected-red controls |

## Composable Form Coverage

The `builtin.canvas` renderer (ADR 0003) is covered by the unit and integration suite
rather than a browser-driven scenario:

- `test/widgets.test.ts` — the answer-model state-action matrix (affirm / negate / blank,
  unsure clears, required-cannot-skip, note orthogonal, confirm / reset, rating bounds,
  required-remaining).
- `test/form-renderer.test.ts` — registration, `reduceAction` (single set per
  `components.<id>`, submit-blocked-while-required), `summarizeHandoff` (required-only
  blocking plus `requireSubmit`), `summarizeState` `formReadback`, and sandboxed
  design-variant rendering with external-reference blocking.
- `test/document-guard.test.ts` — external-reference rejection and strict-CSP wrapping.
- `test/tools.test.ts` — the `form` shorthand fans widgets into declared paths and
  `canvas_read` surfaces `formReadback`.

Deferred: a browser-driven `browser-host-form-*` scenario (present → answer partially →
read exact selections/blanks → export). The browser-driven harness is environment-flaky
on the current machine, so this is deferred to a stable agent-browser environment; the
form's behavior is fully exercised by the suite above.

## Gate Command

The full gate is the package `check` script:

```bash
npm --prefix .pi/extensions/pi-canvas run -s check
```

Focused demo gates:

```bash
npm --prefix .pi/extensions/pi-canvas run -s eval:harness -- --scenario browser-host-contract-green
npm --prefix .pi/extensions/pi-canvas run -s eval:harness -- --scenario browser-host-review-note-green
```

Harness reports are written under `reports/harness/` inside the extension
package and are ignored by git.
