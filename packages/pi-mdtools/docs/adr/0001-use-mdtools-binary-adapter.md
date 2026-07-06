# ADR 0001: Use the mdtools binary as the parser boundary

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Provi, Pi build agent

## Context

pi-mdtools exists to make mdtools' structural Markdown operations salient inside Pi as typed tools. The tempting alternative is to reimplement outline/task/table/section parsing in TypeScript, but that would introduce a second Markdown parser and a second source of truth for source positions, task locations, table behavior, and etags.

## Decision

pi-mdtools will remain a thin adapter over the installed Rust `md` binary. The extension shells out to `md <command> --json`, validates the top-level JSON envelope, and returns mdtools' payload without reparsing Markdown in TypeScript.

## Rationale

This preserves mdtools/comrak as the single parser boundary and keeps CLI, benchmark, and Pi-tool semantics aligned. The extension's value is the typed Pi affordance layer: schemas, tool names, mutation queue integration, ambiguity handling, and concise result envelopes.

Rejected alternative: a TypeScript Markdown implementation over another parser. That would duplicate mdtools behavior, risk parser divergence, and require every mdtools fix to be ported twice.

## Consequences

Positive:

- Pi tool results match mdtools CLI semantics by construction.
- Source spans, task locs, table projection, and block etags stay owned by mdtools.
- The package can ship quickly and improve adoption salience without re-solving Markdown parsing.

Negative:

- Users must install `md` or set `MDTOOLS_MD_BIN`.
- Each tool call incurs a subprocess boundary.
- Binary distribution remains a future packaging question.

## Revisit Triggers

- Installing `md` becomes the dominant adoption failure.
- Subprocess overhead is measured as material in real Pi sessions.
- mdtools exposes a stable WASM or library API that preserves the same parser boundary with less install friction.

## References

- `README.md`
- `index.ts`
- `src/runtime.ts`
