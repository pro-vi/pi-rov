# ADR 0002: Structure the mdtools recovery contract

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Provi, Pi build agent
- **Supersedes:** implicit ad hoc error/hint convention from ADR 0001 implementation

## Context

pi-mdtools originally exposed a tri-state tool envelope and a few ad hoc hints for ambiguous headings, missing binaries, and etag drift. Research on pi-hashline-edit-pro showed that agents recover better when failures carry stable protocol names, current targets, and explicit next actions. The tempting alternative is to copy hashline's stronger adoption posture wholesale by overriding generic read/edit behavior or parsing Markdown in TypeScript.

## Decision

pi-mdtools will keep the mdtools/comrak parser boundary and harden only the Pi-side protocol: prompt metadata, stable recovery error codes, required `error.nextAction` on failed or ambiguous results, and structural current-target candidates for recoverable target drift.

## Rationale

This borrows hashline's best transferable idea — protocol discipline — without turning pi-mdtools into a generic line editor or a second Markdown parser. Stable recovery codes make the result envelope a contract instead of prose, while current candidates let agents recover from duplicate headings, stale etags, and stale task locs using structural mdtools reads.

Rejected alternative: override Pi's generic `read`/`edit` flow or reparse Markdown through tree-sitter/mdast/markdown-it in the extension. That would duplicate another product's editing substrate and risk parser divergence from mdtools/comrak.

## Consequences

Positive:

- Failed and ambiguous tool results have stable `error.code` and `error.nextAction` fields.
- Agents get current structural candidates for ambiguous headings and stale task locs.
- Prompt snippets and guidelines make the `md_*` tool surface more salient.
- Success payloads remain mdtools JSON returned without TypeScript-side Markdown reparsing.

Negative:

- `md_set_task` now performs a structural `md tasks --json` preflight before mutating.
- The public TypeScript envelope type is stricter for failed and ambiguous results.
- The error-code taxonomy becomes a contract future changes must preserve or deliberately migrate.

## Revisit Triggers

- Real Pi traces show agents still fail to choose `md_*` tools for structural Markdown work.
- `md_set_task` preflight overhead becomes material in measured sessions.
- mdtools exposes first-class section/task/table-row etags that should replace adapter-side target candidates.
- Binary install friction justifies moving from subprocess adapter to a WASM Rust core.

## References

- `.research/hashline-borrow-backlog-2026-07-06.md`
- `.research/synthesis-hashline-edit-pro-2026-07-06.md`
- `docs/plans/2026-07-11-001-feat-mdtools-protocol-hardening-plan.md`
- `src/types.ts`
- `src/runtime.ts`
- `src/prompts.ts`
- `README.md`
