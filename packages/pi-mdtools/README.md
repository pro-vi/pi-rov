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

Reads return a tri-state JSON envelope: `ok`, `ambiguous`, or `failed`. The mdtools JSON payload is returned under `data` without TypeScript-side reparsing.

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

Ambiguous heading mutations return `status: "ambiguous"` with `candidates[]` rather than mutating.

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

## Dev

```bash
npm install
npm run check
```

The smoke test loads the extension in Pi print mode and runs `/mdtools status`.
