# pi-rov

pro-vi's suite of extensions for the [Pi](https://github.com/earendil-works/pi) coding agent —
the rig you pilot your agent with.

These are **independent** extensions that happen to share a home. Each is published as its own
npm package and installs on its own; there is no shared runtime and no meta-package. Install only
the ones you want.

## Extensions

| Package | What it does |
|---|---|
| [`pi-canvas`](packages/pi-canvas) | Stateful, reviewable canvas artifacts — an actable surface the agent composes from declared interaction points and digests as structured state. |
| [`pi-tool-distill`](packages/pi-tool-distill) | Recoverable semantic compression of tool results, to keep long sessions inside the context budget. |
| [`pi-codex-fast-mode`](packages/pi-codex-fast-mode) | Enables OpenAI Codex fast mode via `service_tier=priority`. |

## Install

Each package installs independently:

```bash
pi install npm:pi-canvas
pi install npm:pi-tool-distill
pi install npm:pi-codex-fast-mode
```

See each package's own README for configuration and usage.

## Develop

This is an npm-workspaces monorepo. From the repo root:

```bash
npm install              # installs all workspace deps
npm run check            # runs each package's check (typecheck + tests + smoke)
npm run typecheck        # typecheck across all packages
npm run test             # tests across all packages
```

Or work inside a single package:

```bash
cd packages/pi-canvas
npm run check
```

## Layout

```
pi-rov/
├── package.json          # private workspace root
└── packages/
    ├── pi-canvas/
    ├── pi-tool-distill/
    └── pi-codex-fast-mode/
```

Each package is self-contained: its own `package.json`, `pi` manifest, tests, and `pi-package`
keyword (how Pi discovers it). Host libraries (`@earendil-works/pi-*`, `typebox`) are declared as
peer dependencies — provided by the Pi host, never bundled.

## License

MIT © pro-vi
