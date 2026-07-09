# Pi Canvas

Pi TUI `pi-canvas` candidate for stateful, reviewable canvas artifacts.

This package proves the first inside-out slice:

- separate source, state, action, provenance, readback, and export artifacts;
- `/canvas` command registration;
- Pi TUI renderer registration with `builtin.json-card` and `builtin.counter`;
- direct renderer-owned TUI surfaces through `/canvas open [artifactId]`;
- read-only Pi TUI previews through `/canvas render [artifactId]`;
- model-facing `canvas_browser_artifacts`, `canvas_create`, `canvas_update`, `canvas_read`, `canvas_render`, `canvas_present`, and `canvas_export` tools;
- governed browser-host artifacts through `canvas_create` + `canvas_present`;
- one actable browser-host substrate, `builtin.canvas`, a composition of declared Pi-owned widgets whose interactions reduce to canonical Pi state; `optionChooser` and `reviewDecision` are preset shorthands on `canvas_create` that assemble canvas widgets, not separate renderers;
- host-owned browser review notes that record human feedback in receipts without mutating canonical canvas state;
- a real-browser layout audit, inspired by Lavish AXI, with browser-reported open-time findings in receipts plus harness viewport gates for overflow/clipped-text/overlap;
- fixture-mode and browser-driven harness scenarios for green paths and expected-red controls.

The current harness includes one RPC-visible roundtrip, one direct TUI component roundtrip, one live Pi TTY roundtrip, one browser-addressable terminal roundtrip, browser-host contract, review-note, and same-trace success-gate flows, and expected-red controls. The default terminal path remains the Pi TUI renderer registry; the browser-host path is the high-fidelity artifact surface.

## V0 Contract

The V0 contract is documented in `docs/release-readiness.md`; the module and
authority map is documented in `docs/architecture.md`; the release harness
coverage is documented in `docs/harness-matrix.md`; the latest local release
audit is documented in `docs/release-audit.md`. In short: HTML is the
high-fidelity browser projection, while Pi-owned source, state, actions,
provenance, readback, and export remain the truth.

`docs/widget-kit.html` is a static, browser-openable visual reference for every
composable-form widget kind and state. `examples/browser-artifact.md` walks the
shortest end-to-end browser artifact path (`optionChooser` create, present, read).

## Development

The browser-terminal scenario expects the local `agent-browser` CLI on `PATH`.

```bash
npm install
npm run typecheck
npm test
npm run smoke-test
npm run eval:harness -- --scenario roundtrip-green
npm run eval:harness -- --scenario rpc-ui-roundtrip-green
npm run eval:harness -- --scenario direct-tui-roundtrip-green
npm run eval:harness -- --scenario live-tui-roundtrip-green
npm run eval:harness -- --scenario browser-terminal-roundtrip-green
npm run eval:harness -- --scenario browser-host-contract-green
npm run eval:harness -- --scenario browser-host-review-note-green
npm run eval:harness -- --scenario browser-host-layout-overflow-red --expect fail
npm run eval:harness -- --scenario visual-only-red --expect fail
npm run check
```

## Browser Artifact Playbooks

The browser-host path keeps HTML as the projection layer while Pi source, state,
and provenance remain authoritative. There is one actable browser-host substrate,
`builtin.canvas` (ADR 0004): a composition of declared, Pi-owned widgets that
produces a structured readback the agent digests. `canvas_create` exposes bounded
preset shorthands — `optionChooser`, `reviewDecision`, and `form` — that all build
`builtin.canvas`. They are recipes routed to a tested widget composition
(`optionChooser` is a single single-select; `reviewDecision` is an
approve/revise/discuss single-select plus an optional short-text comment; `form`
is the general widget list), not separate renderers, state models, or reducers.

`canvas_browser_artifacts` lists the registered browser artifact catalog — the
single `builtin.canvas` entry — with its renderer id, the shared
`browser-host-artifact` layer, state/evidence authorities, creation hints,
capabilities, actions, and quality gates. `canvas_create` and `canvas_present`
surface the selected playbook back to the agent with purpose, fit, avoidance
cases, quality gates, and immediate next steps, plus browser-host readiness and
renderer-owned `artifactState`, so the model can drive the flow without another
human-facing subcommand.

- Use `canvas_render` for terminal-native review when the interaction does not need a real browser.
- Use `canvas_browser_artifacts` before choosing a browser-host surface when the right registered artifact is ambiguous.
- Do not use `surfaceKind: "browser"` by itself; choose `optionChooser`, `reviewDecision`, `form`, or an explicit `browserRendererId`.
- Use `canvas_create` with `optionChooser.options` containing 2-6 bounded `{ id, title, detail }` options for option, comparison, or mock-direction decisions.
- Use `canvas_create` with a bounded `reviewDecision` prompt/context when the human should approve, request revisions, or leave a canonical decision comment; it builds a canvas approve/revise/discuss composition with an optional comment.
- Use `canvas_create` with a bounded `form` payload for several related questions or a design review the human answers at their own pace.
- After `canvas_present`, treat browser DOM, visual captures, visible text, and review notes as evidence only. Use `canvas_read` for canonical state plus browser-host receipt evidence.
- Use `canvas_export` for diffable source/state/provenance plus browser-host readiness and evidence handoff.

### Presentation policy and readiness

`canvas_present` starts or focuses a signed loopback browser session. It reuses a session only while the receipt still matches the current Pi source hash and state version; stale sessions are closed and restarted, and the manager bounds the number of live sessions. Browser clicks send host-bound action envelopes; the host validates token/origin/session/source/version, asks the renderer to reduce the declared widget action, and commits a canonical store update. The live browser-host URL is local, transient, and token-bearing; open it locally, but do not paste, persist, or share it. `canvas_present` also returns a structured `presentationPolicy` with URL scope/lifetime, token-bearing status, share policy, state authority, and evidence authority so agents do not have to infer those rules from prose.

The host injects a layout audit client. On browser open, the page waits for layout to settle and reports bounded layout findings back to the signed host receipt; these are receipt evidence, while the stricter desktop/mobile layout quality gate still runs in the harness. `canvas_read` reports browser-host readiness as `not-presented`, `pending`, `stale`, `blocked`, or `ready`, plus a concrete next action, so the agent can tell whether the latest receipt matches canonical state, has no handoff-blocking rejected browser action/review/layout event, and has clean layout evidence before handoff. Handoff blocks only on required-unanswered widgets from the canvas readback. Browser-host artifacts whose renderer id is not registered at runtime are blocked for handoff: the store can preserve their source metadata for portability, but `canvas_read` and `canvas_export` require the renderer to resolve before browser evidence is treated as actionable.

### Review dock and evidence

The browser host also injects a small review dock. Notes submitted there can target a picked artifact element and are source/version-bound receipt evidence; they do not enter renderer reducers, action logs, or canonical canvas state. Each note carries a compact `targetKey`, such as `element:testId:option-option-b`, so exported review evidence has a stable annotation handle. After interaction, `canvas_read` returns canonical state plus a separate browser-host evidence summary with recent receipt paths, renderer-owned `artifactState`, review notes, a compact `reviewAnnotations` target index, and recent browser actions for that artifact. `canvas_export` writes `browser-host.evidence.json` for browser artifacts — the readiness verdict, artifact contract with layer/state/evidence authorities, artifact-state summary, review annotation index, and bounded event summaries — even when the artifact has not yet been presented. Together these record browser visual capture (`visualEvidencePath` / `visualEvidenceKind`, PNG when available with PDF fallback), redacted DOM snapshot, layout audit JSON, canonical readback, action log, receipt events, and export diffs in one receipt-backed trace.

The falsifiable demo gate is:

```bash
npm run eval:harness -- --scenario browser-host-contract-green
npm run eval:harness -- --scenario browser-host-review-note-green
```

## Composable Form

`builtin.canvas` is one composable renderer over an ordered list of trusted, Pi-owned
widgets — an async, visual generalization of a structured question prompt (ADR 0003).
Create it with the bounded `form` shorthand:

```json
{
  "title": "Settings review",
  "form": {
    "components": [
      { "id": "layout", "kind": "single-select", "prompt": "Primary layout", "required": true,
        "options": [{ "id": "sidebar", "title": "Left sidebar" }, { "id": "tabs", "title": "Top tabs" }] },
      { "id": "card", "kind": "design-variant", "prompt": "Card style",
        "options": [{ "id": "bordered", "title": "Bordered", "take": "hairline rows, quiet", "html": "<h1>Bordered</h1>" }] },
      { "id": "extras", "kind": "multi-select", "prompt": "Nice-to-haves",
        "options": [{ "id": "shortcuts", "title": "Keyboard shortcuts" }] }
    ]
  }
}
```

Widget kinds: `single-select`, `multi-select`, `rating`, `short-text`, `design-variant`
(sandboxed page previews, each with a required one-sentence `take`), and `html-embed`
(sandboxed display content). Per widget the human can leave options blank, mark "not
sure", skip (optional widgets only), and attach a free-text note. The human answers at
their own pace; the browser updates optimistically then reconciles with canonical state,
and a `previewKind` widget applies the chosen value to a local demo element (e.g. a
motion duration) with no round-trip.

After interaction, `canvas_read` returns `formReadback` (through the renderer's
`artifactState`): per component `affirmed` / `negated` / `blank` / `note` plus a rollup
with `requiredRemaining`. Handoff blocks only on required-unanswered widgets — optional
blanks never block, and an explicit "not sure" satisfies a required widget without
forcing a false pick. Set `form.requireSubmit` for a hard submit checkpoint.
Design-variant and html-embed content is guarded for self-containment (no external
references) and rendered in a sandboxed, token-free iframe under the strict CSP.

## Opening a Canvas

`/canvas open` browses existing artifacts in the Pi TUI. Passing an artifact id
still opens that artifact directly.

`/canvas render <artifactId>` opens a read-only Pi TUI preview in TUI mode and
uses the semantic terminal fallback in print/RPC modes. The model-facing
`canvas_render` tool owns its TUI result surface, so an agent can produce a
rendered artifact directly in the terminal instead of only returning JSON state
in the default tool-output shell. For browser-host artifacts, these render
surfaces also show renderer-owned artifact state, review annotation summaries,
and the current browser-host readiness verdict.

`/canvas export <artifactId> [targetDir]` writes source, state, provenance, and
diff files under the current project cwd. For browser artifacts, it also writes
`browser-host.evidence.json` with the same readiness verdict used by
`canvas_read` and `canvas_export`. Absolute or `..` paths that escape the project
are rejected.

From a shell or script, `pi -p '/canvas open <artifactId>'` prints the same
terminal render and a hint to reopen plain Pi for interactive controls.

```sh
pi -e ./.pi/extensions/pi-canvas/src/index.ts
/canvas create demo {"value":0}
/canvas create-counter clicks 0
/canvas open
/canvas render demo
```

Harness reports are written under `reports/harness/` and are gitignored by the repo-level `.gitignore`.
