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
export MDTOOLS_MD_BIN=/path/to/md
```

Then load the package:

```bash
pi install git:github.com/pro-vi/pi-mdtools
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

- `md_set_task(file, loc, status)` — toggle a checkbox by structural loc
- `md_move_section(file, source, destination, placement)` — relocate a section and auto-relevel by default
- `md_replace_section(file, heading, content, expectEtag?)` — replace a section; when `expectEtag` is supplied, the heading block etag is checked before mutation

Ambiguous heading mutations return `status: "ambiguous"` with `candidates[]` rather than mutating. Stale task locs return `E_BAD_LOC` with current task candidates so the agent can retry with a fresh `loc` from `md_tasks`.

## Recovery codes

Representative failure codes:

- `E_MD_BINARY_MISSING` — install `md`, put it on `PATH`, or set `MDTOOLS_MD_BIN`
- `E_AMBIGUOUS_HEADING` — choose a `candidates[].occurrence` and retry with `occurrence`, `sourceOccurrence`, or `destinationOccurrence`
- `E_HEADING_NOT_FOUND` — run `md_outline` and retry with an exact current heading
- `E_OCCURRENCE_OUT_OF_RANGE` — choose an occurrence from `candidates[]`
- `E_BAD_LOC` — run `md_tasks` or use the returned task `candidates[]`, then retry `md_set_task`
- `E_ETAG_MISMATCH` — run `md_blocks` and retry with a fresh `expectEtag`
- `E_ETAG_UNAVAILABLE` — upgrade mdtools or retry without `expectEtag` if drift safety is not required
- `E_MD_JSON_PARSE` / `E_MD_SCHEMA_MISMATCH` — confirm the installed `md` binary is compatible
- `E_MD_COMMAND_FAILED` / `E_MD_COMMAND_ABORTED` — inspect `error.stderr` and follow `error.nextAction`

## Commands

```text
/mdtools status
/mdtools help
```

`/mdtools status` shows which `md` binary will be used. Resolution order is:

1. explicit extension runtime binary, when supplied by tests/embedders
2. `MDTOOLS_MD_BIN`
3. `md` on `PATH`
4. `~/.cargo/bin/md`
5. `~/.local/bin/md`

## Drift safety

`md_replace_section` accepts `expectEtag` from `md_blocks`. Since mdtools currently exposes etags on blocks, the adapter treats the selected heading block's etag as the section drift guard. If the installed `md` binary does not emit etags, `expectEtag` requests fail closed with an upgrade hint.

## Demo loop

A compact structural workflow for an agent:

1. Call `md_outline({ file: "README.md" })` to see the current heading tree.
2. Call `md_tasks({ file: "README.md" })` to get current task `loc` values.
3. Call `md_set_task({ file: "README.md", loc: "2.0", status: "done" })` to mutate a checkbox by structural loc.
4. Call `md_tasks({ file: "README.md" })` again to verify the task status changed.
5. Call `md_blocks({ file: "README.md" })` and copy the selected heading block's `etag`.
6. Call `md_replace_section({ file: "README.md", heading: "Demo", content: "## Demo\nnew text", expectEtag: "stale" })` to see `E_ETAG_MISMATCH` fail closed.
7. Recover by re-running `md_blocks`, then retry `md_replace_section` with the fresh `expectEtag`.

This package complements generic anchored editors such as hashline: use those for general text edits, and use `md_*` tools when Markdown structure, task locs, tables, block indices, or etags matter.

## Dev

```bash
npm install
npm run check
```

The smoke test loads the extension in Pi print mode and runs `/mdtools status`.
