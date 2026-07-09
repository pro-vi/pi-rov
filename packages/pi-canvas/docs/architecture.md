# Pi Canvas Architecture

## Product Shape

`pi-canvas` separates durable artifact truth from rendered views:

```text
source -> state -> view -> interaction -> evidence -> export
```

Browser-host artifacts follow the same rule. The browser renders HTML from Pi
source and current state, then sends typed actions back to Pi. Pi validates and
reduces those actions before mutating canonical state.

## Component Map

| Component | Responsibility |
|---|---|
| `src/tools.ts` | Model-facing tool registration and tool result presentation |
| `src/commands.ts` | Human `/canvas` inspection and recovery commands |
| `src/runtime.ts` | Small runtime facade over the store |
| `src/store.ts` | Source/state/action/provenance persistence and CAS updates |
| `src/browser-renderer.ts` | Browser artifact renderer contract and registry |
| `src/builtin-browser-renderers.ts` | Sole-substrate browser renderer registry (`builtin.canvas`) plus `createBrowserHostArtifactView` |
| `src/builtin-form-renderer.ts` | The `builtin.canvas` renderer itself (ADR 0003): form definition parsing, `reduceAction`, `updatePolicy: "browser-only"`, the sandboxed HTML client, and `createFormCanvasRequest` (the `form` create-request builder; `tools.ts` composes `optionChooser`/`reviewDecision` down to the same builder) |
| `src/widgets/types.ts`, `src/widgets/schema.ts`, `src/widgets/reducers.ts` | The answer-model state machine behind `builtin.canvas`: widget/form types, id and definition validation (`assertValidFormDefinition`), and the per-op reducer (`reduceWidget`) enforcing the confirmed/unsure/skip invariants |
| `src/browser-host.ts` | Signed local browser session, bound action endpoints, receipts |
| `src/browser-host-evidence.ts` | Receipt reading, evidence summarization, readiness export |
| `src/harness.ts` | Local evaluator scenarios and expected-red controls |

## Browser-Host Flow

```text
agent
  -> canvas_create
  -> CanvasStore writes source/state/provenance
  -> canvas_present
  -> LocalBrowserHostSession starts/focuses localhost URL
  -> BrowserArtifactRenderer renders HTML
  -> browser posts action/review/layout envelope
  -> host validates token/origin/session/source/version/schema
  -> renderer reduces domain action
  -> runtime.update commits canonical state
  -> receipt records action/evidence
  -> canvas_read summarizes canonical state plus evidence
  -> canvas_export writes diffable bundle plus browser-host.evidence.json
```

## Authority Boundaries

| Boundary | Owner | Rule |
|---|---|---|
| State authority | `CanvasStore` and `canvas_read` | Browser state is never authoritative. |
| Form-answer authority | `CanvasStore` per-widget state under `components.<id>` | Composable-form answers (select / value / unsure / skip / note) are Pi-owned; blank is valid data. Design-variant and html-embed content is display-only and sandboxed — it never owns state (ADR 0003). |
| Evidence authority | browser-host receipts | Evidence explains what happened but does not replace state. |
| Renderer authority | `BrowserArtifactRenderer` | Renderers own HTML and domain reductions only. |
| Session authority | `LocalBrowserHostSession` | Host owns token, origin, session, source hash, and state version checks. |
| Handoff authority | readiness summary and renderer handoff checks | Handoff blocks on stale, rejected, missing, or visually broken evidence. |

## Built-In Browser Substrate

There is one actable browser-host renderer, `builtin.canvas` (ADR 0004): a
composition of declared, Pi-owned widgets that produces a structured readback the
agent digests. It is the only entry in the registry and the only renderer
`canvas_browser_artifacts` lists.

| Substrate | Use when | Canonical result |
|---|---|---|
| `builtin.canvas` | Several related questions or a design review the human answers at their own pace; blank / not-sure / skipped are meaningful signal. | per-widget answers plus `formReadback` (affirmed / negated / blank / note + required-remaining); handoff blocks only on required-unanswered |

`canvas_create` exposes bounded **preset shorthands** — `optionChooser`,
`reviewDecision`, and `form` — that assemble widgets on this one substrate.
They are recipes routed to a tested composition (`optionChooser` is a single
single-select; `reviewDecision` is an approve/revise/discuss single-select plus
an optional short-text comment), not separate renderers, state models, or
reducers.

## Failure Semantics

- Missing receipt: not presented.
- Source hash or state version mismatch: stale.
- Rejected action, rejected review note, rejected layout audit, or unreadable
  receipt: blocked.
- No current layout audit: pending.
- Current layout errors: blocked.
- Renderer handoff gate unsatisfied: pending or blocked according to renderer.

These states are intentionally visible to the agent in `canvas_read` and
`canvas_export` so the browser surface cannot silently become a screenshot-only
workaround.
