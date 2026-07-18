# pi-mdtools

Pi extension that exposes mdtools' structural Markdown reads and safe mutation macros as typed Pi tools.

This package is a thin adapter over the installed Rust `md` binary. It does **not** reparse Markdown in TypeScript. Comrak/mdtools remains the single parser and source of truth.

## Install

Install mdtools first so `md` is available:

```bash
cargo install mdtools
```

Or set an explicit binary path before starting Pi:

```bash
export MD_BINARY_PATH=/path/to/md   # MDTOOLS_MD_BIN also works (compatibility alias)
```

Then load the package:

```bash
pi install npm:pi-mdtools            # once published
pi install git:github.com/pro-vi/pi-mdtools
pi install /path/to/checkout         # local path
```

For local development:

```bash
pi --no-extensions -e ./index.ts
```

## Tools

Reads return a tri-state JSON envelope: `ok`, `ambiguous`, or `failed`. The mdtools JSON payload is returned under `data` without TypeScript-side reparsing. Failed or ambiguous results include a stable `error.code`, human-readable `error.message`, and concrete `error.nextAction`.

- `md_outline(file)` — heading outline with spans
- `md_section(file, heading, occurrence?, ignoreCase?)` — section body by heading
- `md_tasks(file, status?)` — GFM checkbox tasks with structural locs
- `md_table(file, index?, select?, where?)` — table metadata or projection
- `md_blocks(file)` — top-level blocks with spans, previews, and etags when supported by the installed `md`
- `md_block(file, index)` — one block with content

Mutation macros are sequential and use Pi's file mutation queue for the target file:

- `md_set_task(file, loc, status, expectEtag?)` — toggle a checkbox by structural loc; `expectEtag` is the task etag from `md_tasks`
- `md_move_section(file, source, destination, placement)` — relocate a section and auto-relevel by default
- `md_replace_section(file, heading, content, expectEtag?)` — replace a section; `expectEtag` is the SECTION etag from `md_outline`/`md_section`, verified by the `md` binary in-process, atomically with the splice

Ambiguous heading mutations return `status: "ambiguous"` with `candidates[]` rather than mutating. Stale task locs return `E_BAD_LOC` with current task candidates so the agent can retry with a fresh `loc` from `md_tasks`.

## Recovery codes

Representative failure codes:

All failure semantics come from the `md` binary's structured error envelope
(its serialized diagnostic code, hint, role, and match candidates); the
adapter is a projection and never re-derives errors from stderr text.

- `E_MD_BINARY_MISSING` — install `md`, put it on `PATH`, or set `MD_BINARY_PATH`
- `E_MD_VERSION_UNSUPPORTED` — the installed `md` predates the structured contract; upgrade it
- `E_AMBIGUOUS_HEADING` — choose a `candidates[].occurrence` and retry with `occurrence`, `sourceOccurrence`, or `destinationOccurrence` (the envelope's role picks the right one)
- `E_HEADING_NOT_FOUND` — candidates list every current heading; retry with an exact one
- `E_OCCURRENCE_OUT_OF_RANGE` — choose an occurrence from `candidates[]`
- `E_BAD_LOC` — run `md_tasks` or use the returned task `candidates[]`, then retry `md_set_task`
- `E_ETAG_MISMATCH` — re-read (`md_outline`/`md_section` for sections, `md_tasks` for tasks) and retry with the fresh `expectEtag`
- `E_ETAG_AMBIGUOUS` — identical duplicate targets share the etag; the guard fails closed because a content match cannot prove identity
- `E_MD_JSON_PARSE` / `E_MD_SCHEMA_MISMATCH` — confirm the installed `md` binary is compatible
- `E_MD_COMMAND_FAILED` — inspect `error.stderr` and follow `error.nextAction`
- `E_MD_COMMAND_ABORTED` — indeterminate: the mutation may have fully committed (never partially); re-read before any retry

## Commands

```text
/mdtools status
/mdtools help
```

`/mdtools status` shows which `md` binary will be used, plus the contract
handshake (`current` / `legacy` / `missing`, from `md schema --json`) and a
repair command when an upgrade is needed. Resolution order is:

1. explicit extension runtime binary, when supplied by tests/embedders
2. `MD_BINARY_PATH`, then `MDTOOLS_MD_BIN` (compatibility alias)
3. `md` on `PATH`
4. `~/.cargo/bin/md`
5. `~/.local/bin/md`

## Drift safety

Guards are owned by the `md` binary and verified in-process, atomically with
the mutation. `md_replace_section` takes a SECTION etag (full section span,
heading through body) from `md_outline` entries or `md_section`;
`md_set_task` takes a task etag from `md_tasks`. A stale etag fails closed
(`E_ETAG_MISMATCH`); identical duplicate targets sharing a fingerprint also
fail closed (`E_ETAG_AMBIGUOUS`) because a content match cannot prove
identity. Writes are atomic temp-file-plus-rename: a killed process never
leaves a truncated document.

## Usage log

Each `md_*` call appends one line to
`~/.local/share/pi-mdtools/usage.jsonl` (`pi-mdtools-usage.v1`): a per-session
id, tool, kind, outcome, whether an etag guard was attempted (plus
`guardedResult` cross-checked from the mutation payload on success), and the
re-query signal. Re-query identity is the file's realpath, so a symlink and
its referent count as the same document. No content, headings, or paths are
recorded — files appear only as an 8-char sha256 prefix of the resolved path.
Set `PI_MDTOOLS_USAGE_LOG=/path` to redirect or `PI_MDTOOLS_USAGE_LOG=""` to
disable.

## Demo loop

A compact structural workflow for an agent:

1. Call `md_outline({ file: "README.md" })` to see the current heading tree.
2. Call `md_tasks({ file: "README.md" })` to get current task `loc` values.
3. Call `md_set_task({ file: "README.md", loc: "2.0", status: "done" })` to mutate a checkbox by structural loc.
4. Call `md_tasks({ file: "README.md" })` again to verify the task status changed.
5. Call `md_outline({ file: "README.md" })` and copy the target entry's section `etag`.
6. Call `md_replace_section({ file: "README.md", heading: "Demo", content: "## Demo\nnew text", expectEtag: "stale" })` to see `E_ETAG_MISMATCH` fail closed.
7. Recover by re-running `md_outline`, then retry `md_replace_section` with the fresh `expectEtag`.

This package complements generic anchored editors such as hashline: use those for general text edits, and use `md_*` tools when Markdown structure, task locs, tables, block indices, or etags matter.

## Dev

```bash
npm install
npm run check                       # typecheck + unit tests + Pi smoke test
MD_BINARY=/path/to/md npm run test:parity   # cross-repo parity vs the real binary
```

The smoke test loads the extension in Pi print mode and runs `/mdtools status`.
The parity suite proves the adapter against the actual `md` binary: every
emitted flag exists in `md schema`, every diagnostic code is mapped, and the
behavioral roundtrips (ambiguity, occurrence, bad loc, etag mismatch/ambiguity)
hit the exact adapter codes.
