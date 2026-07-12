---
title: pi-mdtools protocol hardening from hashline patterns
objective: Make pi-mdtools easier for agents to choose and recover from without abandoning the mdtools/comrak structural Markdown boundary.
type: feat
status: completed
date: 2026-07-11
origin: .research/hashline-borrow-backlog-2026-07-06.md
---

# pi-mdtools protocol hardening from hashline patterns

## Background

`pi-mdtools` is a thin Pi extension over the Rust `md` binary. The backlog in `.research/hashline-borrow-backlog-2026-07-06.md` identified patterns worth borrowing from `pi-hashline-edit-pro`: stronger prompt guidance, recovery-shaped errors, current-target context, and a visible demo loop. This plan intentionally keeps `pi-mdtools` as the structural Markdown layer over mdtools/comrak. It does not copy hashline's generic read/edit override posture or introduce a second Markdown parser in TypeScript.

## Architecture Decision

**Approach:** Ship a focused protocol-hardening milestone: borrow hashline's prompt discipline, recovery-shaped errors, and current-target context where those patterns stay structural. Do not borrow hashline's read/edit override or TypeScript AST editing model.

**Rationale:** This improves adoption and recovery without changing `pi-mdtools`' core identity: a typed Pi adapter over `md --json` / comrak. Local patterns already support this: tool registration lives in `index.ts`, typed result envelopes live in `src/types.ts`, runtime failure handling lives in `src/runtime.ts`, and tests already exercise ambiguity, etags, and mutation command wiring.

**Trade-offs:** `md_set_task` gains a structural preflight subprocess for safer stale-loc handling. Error envelopes become richer, but only through backward-compatible optional fields. Batch operations, post-success warning scans, symlink-canonical queueing, and WASM are deferred.

## Requirements

- **R1:** Preserve mdtools/comrak as the only Markdown parser.
- **R2:** Make models more likely to choose `md_*` tools.
- **R3:** Make every failure recoverable with stable `code` plus concrete `nextAction`.
- **R4:** Surface current structural anchors on ambiguous, missing, stale, or bad targets.
- **R5:** Keep result-envelope changes backward-compatible.
- **R6:** Prove behavior in tests and README demo.

## High-Level Technical Design

Directional target shape:

```ts
MdResultEnvelope {
  status: "ok" | "ambiguous" | "failed"
  command: string
  file?: string
  data?: unknown
  candidates?: MdCandidate[]
  error?: {
    code: MdErrorCode
    message: string
    hint?: string
    nextAction: string
    exitCode?: number | null
    stderr?: string
  }
  meta: MdResultMeta
}
```

Prompt metadata target:

```txt
src/prompts.ts
  MD_TOOL_PROMPTS.md_outline.promptSnippet
  MD_TOOL_PROMPTS.md_outline.promptGuidelines
  ...one entry per md_* tool
```

Runtime recovery target:

```txt
tool -> runtime -> md --json
  resolution failure -> E_MD_BINARY_MISSING
  command failure -> E_MD_COMMAND_FAILED / E_ETAG_MISMATCH / E_BAD_LOC
  preflight ambiguity -> E_AMBIGUOUS_HEADING + candidates
  no match -> E_HEADING_NOT_FOUND + nextAction
  JSON shape failure -> E_MD_JSON_PARSE / E_MD_SCHEMA_MISMATCH
```

## Implementation Units

### U1. Centralize prompt snippets and add promptGuidelines

- **Goal:** Borrow hashline's "teach the model the protocol" advantage.
- **Requirements:** R2
- **Dependencies:** None
- **Files:**
  - Create: `src/prompts.ts`
  - Modify: `index.ts`
  - Modify: `src/content.ts`
- **Approach:** Move current inline `promptSnippet`s from `index.ts` into `src/prompts.ts`; add concise `promptGuidelines` per tool or shared guideline groups. Guidelines must name exact tools because Pi appends them flat into the default Guidelines section.
- **Patterns to follow:** `defineTool` declarations in `index.ts`; Pi supports `promptSnippet` and `promptGuidelines` on tool definitions.
- **Test scenarios:**
  - *Happy path:* extension typechecks with snippets/guidelines wired for every `md_*` tool.
  - *Edge case:* guideline bullets name exact tools, e.g. "Use md_tasks...", not "Use this tool...".
- **Verification:** `md_*` tools remain registered and expose stronger prompt metadata.

### U2. Add stable recovery contract types

- **Goal:** Make the public JSON envelope explicitly recovery-shaped.
- **Requirements:** R3, R5
- **Dependencies:** None
- **Files:**
  - Modify: `src/types.ts`
  - Create optional: `src/recovery.ts`
  - Test: `test/runtime.test.ts`
- **Approach:** Add an `MdErrorCode` union and extend `MdErrorInfo` with `code` and `nextAction`. Keep existing `message`, `hint`, `exitCode`, and `stderr` fields for compatibility.
- **Patterns to follow:** existing `MdResultEnvelope` and `MdErrorInfo` in `src/types.ts`.
- **Test scenarios:**
  - *Happy path:* successful envelopes keep the existing shape.
  - *Error path:* failed envelopes include stable `error.code` and `error.nextAction`.
  - *Compatibility:* older consumers can still read `status`, `error.message`, and `candidates`.
- **Verification:** every failed or ambiguous result can carry a stable recovery code without breaking existing consumers.

### U3. Normalize runtime failure paths through recovery helpers

- **Goal:** Replace ad hoc hints with uniform next-action failures.
- **Requirements:** R3, R4
- **Dependencies:** U2
- **Files:**
  - Modify: `src/runtime.ts`
  - Test: `test/runtime.test.ts`
- **Approach:** Route failure construction through shared helpers. Cover at least:
  - binary missing -> `E_MD_BINARY_MISSING`
  - command exit code 4 -> `E_ETAG_MISMATCH`
  - command killed -> `E_MD_COMMAND_ABORTED`
  - command nonzero -> `E_MD_COMMAND_FAILED`
  - JSON parse failure -> `E_MD_JSON_PARSE`
  - outline missing `entries[]` -> `E_MD_SCHEMA_MISMATCH`
  - no heading -> `E_HEADING_NOT_FOUND`
  - duplicate heading -> `E_AMBIGUOUS_HEADING`
  - occurrence out of range -> `E_OCCURRENCE_OUT_OF_RANGE`
- **Patterns to follow:** `resultFromExecutionFailure`, `selectCandidate`, and `runJsonData` in `src/runtime.ts`.
- **Test scenarios:**
  - *Error path:* missing binary returns install next action.
  - *Error path:* etag mismatch returns "re-read md_blocks..." next action.
  - *Error path:* ambiguous heading returns candidates plus occurrence instruction.
  - *Error path:* malformed JSON returns parse code.
- **Verification:** no `status: "failed"` or `status: "ambiguous"` leaves runtime without `error.code` and `error.nextAction`.

### U4. Add structural current-target context for bad task locs

- **Goal:** Borrow hashline's "current targets in the error" pattern without becoming a line editor.
- **Requirements:** R1, R4
- **Dependencies:** U2, U3
- **Files:**
  - Modify: `src/types.ts`
  - Modify: `src/runtime.ts`
  - Test: `test/runtime.test.ts`
- **Approach:** Extend `MdCandidate` with optional task fields: `loc`, `status`, and `heading`. Preflight `md_set_task` with `md_tasks` before mutation; if `loc` is absent, return `E_BAD_LOC` with current task candidates and next action to re-run `md_tasks` / choose a valid loc. Keep all preflight reads structural through `md --json`.
- **Patterns to follow:** heading candidate extraction in `src/runtime.ts`; mutation serialization remains the existing `withFileMutationQueue` path in `index.ts`.
- **Test scenarios:**
  - *Happy path:* valid loc still calls `set-task`.
  - *Error path:* invalid loc returns `E_BAD_LOC`, current task candidates, and no mutation call.
  - *Edge case:* task preflight failure returns a coded command failure, not silent success.
- **Verification:** stale task locs become recoverable without grep/read.

### U5. Document and demo the borrowed protocol

- **Goal:** Make adoption visible and copyable.
- **Requirements:** R2, R5, R6
- **Dependencies:** U1-U4
- **Files:**
  - Modify: `README.md`
  - Modify: `src/content.ts`
  - Test: `test/runtime.test.ts`
- **Approach:** Add a compact demo/proof loop:
  1. `md_outline(file)`
  2. `md_tasks(file)`
  3. `md_set_task(file, loc, done)`
  4. `md_tasks(file)` again to prove mutation
  5. `md_blocks(file)` to fetch heading etag
  6. stale `md_replace_section(..., expectEtag)` fails closed
  7. recover via fresh `md_blocks`
- **Patterns to follow:** existing README install/tool/drift sections.
- **Test scenarios:**
  - *Docs expectation:* README names structural use cases and recovery codes.
  - *Error path:* docs examples align with actual envelope fields.
- **Verification:** README demonstrates why `pi-mdtools` complements rather than competes with hashline.

## Scope Boundaries

- Do not override Pi `read`.
- Do not disable Pi `edit`.
- Do not add tree-sitter/mdast/markdown-it parsing.
- Do not add batch macros in this milestone.
- Do not change mdtools binary distribution.
- Do not add dependencies unless a compile/test failure proves they are necessary.

### Deferred to Follow-Up Work

- Post-success warning scans for duplicate adjacent headings.
- `md_set_tasks` / `md_replace_sections` batch macros with one-snapshot validation.
- Symlink-canonical mutation queueing.
- WASM Rust core if binary install friction becomes real.
- Upstream mdtools section/task/table-row etags.

## System-Wide Impact

- **Interaction graph:** Pi tool call -> `index.ts` schema/execute -> `MdtoolsRuntime` -> `md --json` subprocess -> `MdResultEnvelope` -> `renderMdToolResult`.
- **Prompt surface:** stronger tool salience via `promptGuidelines` and centralized snippets.
- **Error propagation:** failures become structured `MdErrorInfo` with stable `code` and concrete `nextAction`.
- **State lifecycle risks:** mutating tools continue to run through Pi's file mutation queue; U4 adds read-before-write structural preflight for `md_set_task`.
- **API surface parity:** all `md_*` tools should share the same recovery contract.
- **Integration coverage:** runtime tests must lock representative failure envelopes and task-loc preflight behavior.
- **Unchanged invariants:** mdtools/comrak remains the only parser; success data from `md --json` remains returned verbatim.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Error-code taxonomy becomes too broad | Keep first union small and runtime-owned. |
| Prompt guidelines get noisy | Short bullets only; README holds longer examples. |
| Task preflight adds subprocess cost | Only for mutating `md_set_task`; acceptable for safety. |
| Envelope shape breaks consumers | Add optional fields only; keep existing fields. |
| Drift between docs and behavior | Lock example-shaped outputs in tests. |

## Disconfirming Evidence

- If tests require parsing Markdown in TypeScript to identify headings/tasks, the plan has violated R1 and must be revised.
- If `promptGuidelines` are not accepted by the current Pi `defineTool` type, U1 must fall back to stronger `promptSnippet`s and `/mdtools help` docs rather than type casts.
- If `md tasks --json` does not include enough stable loc/status fields for task candidates, U4 must be reduced to coded `E_BAD_LOC` recovery via CLI failure rather than inventing a parser.

## Bug-trace / Confidence Cross-Check

| Backlog concern | Plan coverage | Match? |
|---|---|---|
| Agents may not choose `md_*` tools | U1 promptGuidelines | Yes |
| Failures lack recovery path | U2-U3 codes + nextAction | Yes |
| Need current targets | U3 headings, U4 task locs | Yes |
| Avoid parser divergence | Scope boundary keeps `md --json` only | Yes |
| Need demo proof | U5 README loop | Yes |
