---
title: pi-mdtools v0.2 — binary-owned contract
objective: Make weak-model markdown editing in pi trustworthy by moving matching, ambiguity, and error semantics into the md binary, so the TS adapter can never disagree with the tool it wraps.
type: feat
status: completed
date: 2026-07-17
origin: mdtools session 2026-07-17 — representation-integrity audit of pi-mdtools + pi extension-pattern and integration-point exploration; supersedes the error-mapping decisions of docs/plans/2026-07-11-001-feat-mdtools-protocol-hardening-plan.md (completed)
---

# pi-mdtools v0.2 — binary-owned contract

> **Re-ground note (2026-07-17, /build Phase 1).** The plan was authored against a
> local mdtools master 13 commits stale. After fast-forward to origin/master
> (7070049): U3's etag-flag surface ALREADY SHIPPED upstream (#13/#22/#23 +
> frontmatter state etag: `--expect-etag` on replace-section/delete-section/set/
> set-task/table rows; `--expect-source-etag`/`--expect-dest-etag` on move-section;
> etags in section/table/tasks JSON). U3 executes as the residual slice only:
> atomic temp+rename write with permission preservation, `guarded` on
> MutationResult, `etag_ambiguous` fail-closed, outline-entry etags. Command count
> is now 21 (collect, replace-table-row, delete-table-row added); diagnostics are
> 19 (TableRowNotFound, InvalidTableRow added); `section --ignore-case` is now
> Unicode lowercase-projection, not ASCII-only. Upstream also added
> `bench/md_inventory_v1.json` — a hand-maintained command inventory that U2's
> `md schema` must subsume (parity-test or generate it). U1/U2/U4-U8 unchanged in
> intent; counts and file anchors in the unit bodies are superseded by this note
> where they conflict.

Cross-repo plan. Path prefixes: `mdtools:` = ~/Development/_projs/mdtools (Rust),
`pi:` = this repo (TypeScript). Rust units land first; they are useful to every md
consumer (bench, future MCP), not only to pi-mdtools.

## Background (read cold)

pi-mdtools is a thin Pi extension over the `md` Rust CLI: 9 typed tools
(`md_outline` ... `md_replace_section`) shell out to `md <cmd> --json` and forward
the success payload opaquely (ADR 0001). The 2026-07-11 hardening plan added a
recovery envelope (`ok`/`ambiguous`/`failed` + `error.code` + `nextAction`, ADR
0002). A 2026-07-17 representation-integrity audit found that the recovery layer,
built entirely TS-side, created three hand-maintained seams with no equivalence
guard, two of which are latent bugs today:

- **R1 — second heading matcher.** `pi:src/runtime.ts` `headingMatches` uses
  `toLocaleLowerCase()` (full Unicode); `mdtools:src/commands/section.rs:251` uses
  `eq_ignore_ascii_case` (ASCII only). For non-ASCII headings under `ignoreCase`,
  the TS candidate set and the Rust selection can disagree; because TS counts
  `occurrence` over ITS match set and passes `--occurrence N` to md, the mutation
  can land on the wrong section. Wrong-target, the exact failure class md exists
  to remove.
- **R2/R3 — error taxonomy reconstructed from prose.** Exit code 4 is mapped
  unconditionally to `E_ETAG_MISMATCH` (`pi:src/runtime.ts:385`), but Rust exit 4
  = Conflict = {EtagMismatch, DuplicateHeadingMatch, FrontmatterFieldConflict}
  (`mdtools:src/errors.rs:50-57`). The stderr sniff for ambiguity looks for
  "ambiguous"/"multiple"/"more than one"; Rust's actual message contains none of
  those tokens. A duplicate-heading conflict is reported to the model as etag
  drift with the wrong recovery hint.
- **R4 — dead protocol token.** `schema_version: "mdtools.v1"` is emitted on every
  md JSON result and validated nowhere in TS.
- **R5 — synthetic etag guard.** `md_replace_section`'s `expectEtag` is a TS-side
  compare of the heading block's etag from a separate `md blocks` call:
  heading-line-only (a body change passes) and TOCTOU-racy across two processes.
  Rust `replace-section` has no `--expect-etag` (`mdtools:src/cli.rs:69-82`).
- **Triplicated literals.** Command/flag strings exist independently in
  `mdtools:src/cli.rs` (authority), `pi:src/runtime.ts` arg arrays, and
  `mdtools:bench/command_policy.py`, with no parity check anywhere.

Constraints that stay true from prior ADRs/plans: mdtools/comrak is the only
Markdown parser (no TS parsing); success payloads stay opaque in TS; loc and etag
stay opaque strings in TS; pi built-in read/edit are not overridden or disabled.

## Architecture Decision

**Approach:** Make the md binary the single authority for matching, ambiguity,
error taxonomy, and drift guards, exposed through two machine-readable surfaces:
a structured JSON error envelope (with the serialized `DiagnosticCode` and
structured context) and a `md schema --json` surface dump. The TS adapter becomes
a pure projection: it deletes its heading matcher and stderr sniffing, maps
`DiagnosticCode -> MdErrorCode` with an exhaustive switch, validates
`schema_version`, and gets real `--expect-etag` semantics from the binary for
section and task mutations.

**Rationale (consistency first):** ADR 0001 already chose "the binary owns
parsing"; every audit finding is a place where ownership silently leaked back
into TS. Extending the same rule from parsing to matching and error semantics is
the smallest consistent fix. The rejected alternative — keep the TS recovery
layer and add parity tests around the second matcher and the prose sniffing —
was rejected because it guards the drift instead of removing it: every new md
diagnostic or message tweak would need a synchronized TS change forever, and the
occurrence-shift bug class survives any test gap. Structured errors also serve
the bench harness and any future MCP adapter for free.

**Trade-offs accepted:** mdtools grows adapter-serving surface (error envelope,
schema dump, three new `--expect-etag` sites) — justified because "fail-closed
drift guards on all mutations" was already a stated cross-cutting goal in
mdtools' CLAUDE.md, not a pi-only need. Old-binary compatibility requires a
version handshake and a degraded path in TS for one release.

**One-way doors** (spec detail concentrated here): the error-envelope JSON shape
and the wire meaning of `schema_version` are wire contracts; the section/task
etag definitions (what bytes are fingerprinted) are protocol semantics that
consumers will bake in. All three get explicit shapes below and locking tests.
Tool names, prompt text, and instrumentation shape are two-way doors.

## High-Level Technical Design

Error envelope (stdout, only when `--json`; human text stays on stderr; exit
codes unchanged):

```json
{
  "schema_version": "mdtools.v1",
  "error": {
    "code": "duplicate_heading_match",     // serde snake_case of DiagnosticCode
    "exit_code": 4,
    "message": "heading \"Setup\" matches 3 sections; ...",
    "hint": "re-run `md outline --json` and pass --occurrence N",  // same source as stderr prose; serves direct-bash agents, not just typed adapters (/cli F1)
    "context": {                            // per-code structured payload
      "role": "target",                      // target | source | destination (move-section threads it)
      "requested_occurrence": null, "total_matches": 3,
      "matches": [ {"block_index": 4, "occurrence": 1, "line": 12}, ... ],
      "expected_etag": null, "found_etag": null, "loc": null
    }
  }
}
```

Schema dump (`md schema --json`): `{ schema_version, binary_version,
capabilities: ["error_envelope", "section_etag", ...], commands: [{name, flags:
[{long, takes_value, repeatable}], args }], diagnostic_codes: [{code,
exit_code}] }`, derived at runtime from clap's `CommandFactory::command()`
introspection — no hand-maintained table. Fallback if clap introspection can't
express something: a `schema.rs` static table with a Rust unit test asserting it
matches clap; the authority stays single and mechanically checked.

Etag semantics (additive to mdtools.v1): section etag = FNV-1a over the full
section byte span (heading line through section end), surfaced as `etag` on
`SectionReadResult` and outline entries; task etag = FNV-1a over the task list
item's line bytes, surfaced per task in `TasksResult`. `--expect-etag` on
`replace-section`, `delete-section`, `set-task` verifies in-process at parse
time, same as blocks (`mdtools:src/commands/replace.rs verify_etag` pattern).

TS decode order: parse stdout JSON -> require `schema_version == "mdtools.v1"`
(else `E_MD_SCHEMA_MISMATCH`, nextAction: upgrade/pin md) -> if `error` present,
exhaustive-switch `code` into `MdErrorCode` + `nextAction` + candidates projected
from `context.matches` -> else forward `data` opaquely. Legacy binaries (no
envelope, no `md schema`): detected once per session via `md schema --json`
probe; degrade to `E_MD_VERSION_UNSUPPORTED` guidance on conflict-class failures
instead of guessing.

## Implementation Units

### U1. mdtools: structured JSON error envelope

- **Goal:** Machine-readable errors with the authoritative `DiagnosticCode` and
  structured context, so no consumer ever parses stderr prose.
- **Requirements:** kills R2, R3, R6 (audit); enables U4.
- **Dependencies:** None.
- **Files:**
  - Modify: `mdtools:src/errors.rs` (Serialize on `DiagnosticCode`, snake_case;
    context payload struct; new `OccurrenceOutOfRange` code), `mdtools:src/main.rs`
    (on error + `--json`, emit envelope to stdout before exiting with the mapped
    code), `mdtools:src/commands/section.rs` (distinguish out-of-range occurrence
    from not-found; thread match role/requested/total into errors),
    `mdtools:src/commands/move_section.rs` (annotate source vs destination role on
    selector errors), `mdtools:src/multifile.rs` + `mdtools:src/commands/tasks.rs`
    (multi-file error emission, see scope note)
  - Test: `mdtools:tests/cli_error_envelope.rs`
- **Approach:** Envelope shape per High-Level Design. `DuplicateHeadingMatch`
  carries `matches[]` (block_index, occurrence, line); `EtagMismatch` carries
  expected/found; `InvalidTaskLoc`/`TaskItemNotFound` carry the parsed loc.
  Every envelope carries `hint` (structured remediation, same source as the
  stderr prose) so bash-level agents get the recovery affordance without a
  typed adapter. Candidate lists capped at 20 with a `total` count. Stderr text
  unchanged. The stdout-on-error-under-`--json` channel choice is a documented
  posture decision: it makes `md ... --json | jq -e .error` a branchable
  pipeline step; document it in the mdtools README alongside the envelope shape.
  Scope of the one-object guarantee: SINGLE-FILE commands, post-clap-parse.
  Multi-file NDJSON commands (outline, search, links, frontmatter, stats)
  already stream per-file successes (`mdtools:src/multifile.rs:76-103`); there,
  per-file failures emit per-file envelope objects into the same NDJSON stream
  and the final aggregate error is one last envelope object (consumers
  distinguish rows by the `error` key). `tasks` is the deliberate exception and
  KEEPS its single-aggregate-object wire shape: the one `TasksResult` object
  gains an additive `failures: [{file, error}]` array beside `results`, so
  partial success plus structured failures arrive in one object and the exit
  code stays worst-of — never NDJSON for tasks.
  clap usage errors exit inside `Cli::parse()` before any envelope and stay
  plain text — documented, with the note that clap's own exit code 2 collides
  with `ParseError=2` and is disambiguated only by the absence of an envelope.
  Selector errors gain authoritative targeting context: `role`
  ("target" | "source" | "destination" — move-section threads it),
  `requested_occurrence`, `total_matches`; out-of-range occurrence becomes its
  own `occurrence_out_of_range` code (exit code stays 1 for back-compat; the
  envelope code is the discriminator).
- **Patterns to follow:** `mdtools:src/commands/replace.rs:377-421 emit_mutation`
  for the json-flag branching discipline; existing error Display impls stay the
  stderr source.
- **Test scenarios:**
  - *Happy path:* each `DiagnosticCode` variant produces an envelope whose
    `code` round-trips serde and whose `exit_code` matches `MdExitCode` mapping.
  - *Edge:* without `--json`, stdout is untouched on error (bench compatibility).
  - *Edge:* duplicate-heading envelope lists all matches with correct
    occurrence indices, capped at 20.
  - *Error path:* envelope itself failing to serialize still exits with the
    mapped code and stderr text (envelope is best-effort, exit code is truth).
- **Verification:** every single-file error path under `--json` yields exactly
  one parseable JSON object on stdout; multi-file paths yield a well-formed
  NDJSON stream whose rows are each parseable; `cargo test` green; full mdtools
  suite unaffected.

### U2. mdtools: `md schema --json` surface dump

- **Goal:** One derivable authority for command names, flags, and the
  diagnostic/exit table; consumers test against it instead of restating it.
- **Requirements:** collapses the triplicated-literals duplicate; enables U7.
- **Dependencies:** None (U1's code list is included once U1 lands; order U1
  before U2 in execution).
- **Files:**
  - Create: `mdtools:src/commands/schema.rs`
  - Modify: `mdtools:src/cli.rs` (Command::Schema), `mdtools:src/main.rs`
  - Test: `mdtools:tests/cli_schema.rs`
- **Approach:** clap `CommandFactory::command()` walk -> commands/flags;
  diagnostic table from a single static slice that U1's serde names are tested
  against. Output carries `schema_version`, `binary_version` (crate version),
  and a `capabilities` list (e.g. `error_envelope`, `section_etag`) so the
  handshake reads one surface instead of probing features. Also enable clap's
  version flag (`#[command(version)]` — the CLI has none today) for humans
  and `/mdtools status`.
- **Patterns to follow:** read-command emit pattern in
  `mdtools:src/commands/outline.rs` (write_json).
- **Test scenarios:**
  - *Happy path:* dump contains all 18 existing subcommands + `schema` (19
    total; count derived from the clap walk, not hardcoded); `move-section`
    shows the placement arg group; `--expect-etag` listed on exactly the
    commands that accept it (updated by U3).
  - *Edge:* TSV mode prints a flat table (consistency with other reads).
- **Verification:** `md schema --json | jq` round-trips; a Rust test asserts the
  diagnostic table covers every `DiagnosticCode` variant (exhaustive match).

### U3. mdtools: `--expect-etag` for section and task mutations

- **Goal:** Real fail-closed drift guards where TS currently fakes one (R5),
  closing the "etag on all mutation commands" slice from mdtools CLAUDE.md.
- **Requirements:** R5; enables U5's honest tool description.
- **Dependencies:** None.
- **Files:**
  - Modify: `mdtools:src/cli.rs` (flag on ReplaceSection/DeleteSection/SetTask),
    `mdtools:src/model.rs` (additive `etag` on SectionReadResult, outline
    entries, task items), `mdtools:src/commands/section.rs`,
    `mdtools:src/commands/replace.rs` (incl. `emit_mutation` atomic write),
    `mdtools:src/commands/tasks.rs`, `mdtools:src/commands/outline.rs` (emit
    section etags on entries), `mdtools:src/output.rs` (span-etag helper)
  - Test: `mdtools:tests/cli_section_etag.rs`, extend `mdtools:tests/cli_tasks*`
- **Approach:** Section etag over the full section span; task etag over the
  item's line bytes (per High-Level Design). Verification happens in-process
  after parse, before splice — same TOCTOU class as blocks. `move-section` is
  explicitly deferred (two targets; needs a two-etag design). `MutationResult`
  gains an additive `guarded: bool` (was an etag expectation checked; default
  false, every constructor site updated, not required of consumers) so guard
  adoption is observable to agents and to U6's usage lines — the data behind
  the open "do agents actually use --expect-etag" question. New flags and the
  schema command carry example invocations in their clap doc comments. Two
  hardening rules ride along: (a) `emit_mutation` switches to atomic
  temp-file-plus-rename in the target's directory, so a killed process can
  never leave a truncated document (today's `std::fs::write` is a
  partial-write window); (b) etag verification fails closed when the expected
  hash is NON-UNIQUE among the command's current candidate set — duplicate-
  content sections/tasks share a fingerprint, and a content-only match cannot
  prove identity (mdtools CLAUDE.md documents this collision for blocks). The
  ambiguity failure is exit 4 with its own diagnostic (`etag_ambiguous`),
  hint: re-query and disambiguate by occurrence.
- **Patterns to follow:** `verify_etag` in `mdtools:src/commands/replace.rs:15-45`
  (current formatting-only uncommitted diff there must land or rebase first).
- **Test scenarios:**
  - *Happy path:* matching etag mutates; JSON result unchanged plus new fields.
  - *Error path:* stale etag -> exit 4, `etag_mismatch` envelope (with U1) naming
    expected/found; file untouched.
  - *Edge:* CRLF and multibyte fixtures produce stable etags (re-run the pinned
    comrak fixture suite per mdtools CLAUDE.md comrak-pin rule).
  - *Edge:* body-only change under old heading -> section etag DOES change
    (differentiates from the heading-block-only guard it replaces).
  - *Edge:* two byte-identical sections, `--expect-etag` matching both ->
    exit 4 `etag_ambiguous`, file untouched (the identical-duplicate fixture).
  - *Edge:* mutation output file appears atomically (write goes to a temp file
    in the same directory, then rename; no path observes partial content).
- **Verification:** `--expect-etag` accepted on the three commands; schema dump
  (U2) reflects it; mdtools.v1 consumers without the new fields still parse
  (additive-only check against bench scorer tests). Acceptance criteria from
  review: (1) atomic replacement preserves the original file's permission bits
  (locked by a test on a non-default-mode fixture); (2) etag uniqueness for the
  `etag_ambiguous` check is defined across ALL same-hash targets in the
  document (every section for section mutations, every task for set-task), not
  merely selector matches — the identical-duplicate fixture asserts this scope.

### U4. pi-mdtools: derive the recovery contract from the binary

- **Goal:** Delete the second matcher and prose sniffing; envelope becomes a
  projection of md's structured errors. Kills R1-R4.
- **Requirements:** R1, R2, R3, R4.
- **Dependencies:** U1 (envelope), U2 (handshake probe).
- **Files:**
  - Modify: `pi:src/runtime.ts` (remove `headingMatches`, occurrence recount,
    `classifyFailureStatus` sniffing; add envelope decoder + exhaustive
    `DiagnosticCode -> MdErrorCode` switch + `schema_version` gate + one-shot
    `md schema` handshake), `pi:src/types.ts` (add `E_MD_VERSION_UNSUPPORTED`;
    map `duplicate_heading_match -> E_AMBIGUOUS_HEADING` etc.)
  - Test: `pi:test/runtime.test.ts`
- **Approach:** Ambiguity/not-found candidates come from `error.context.matches`
  (duplicates) or a plain `md outline --json` listing projected verbatim
  (not-found) — listing is projection, matching is not; no TS code may decide
  whether a heading "matches". Exhaustive switch over the serialized code union;
  unknown code -> `E_MD_COMMAND_FAILED` with the raw code in the message (fail
  visible, not silent). `occurrence_out_of_range` maps to the already-public
  `E_OCCURRENCE_OUT_OF_RANGE`; the envelope's `role` field decides whether
  nextAction recommends `occurrence`, `sourceOccurrence`, or `destOccurrence`.
  Handshake verdict "current" requires BOTH `schema_version == "mdtools.v1"`
  AND the required capability set (`error_envelope`, `section_etag`) present in
  `capabilities`; a version match with a missing required capability is
  "legacy", never "current". Envelope absent + nonzero exit -> legacy path:
  `E_MD_VERSION_UNSUPPORTED` guidance for exit 4, coarse mapping otherwise.
  Lifecycle change: the runtime
  becomes a session-scoped singleton (today `pi:index.ts` constructs
  `new MdtoolsRuntime` per call), keyed by resolved binary path, so the
  handshake result is cached once and invalidated only when the binary path
  changes.
- **Patterns to follow:** existing decoder helpers `isRecord`/`stringValue`
  (`pi:src/runtime.ts:93-115`) — keep the defensive style for the envelope too.
- **Test scenarios:**
  - *Happy path:* fixture envelopes for each code produce the right
    `MdErrorCode` + nextAction; success payloads still forwarded byte-identical.
  - *Error path:* duplicate-heading envelope -> `status: "ambiguous"` with md's
    own match list, occurrence advice quoting md's indices.
  - *Edge:* `schema_version: "mdtools.v2"` -> `E_MD_SCHEMA_MISMATCH` before any
    field decode; missing version on success payload -> same.
  - *Edge:* schema dump with matching version but `section_etag` absent from
    `capabilities` -> handshake verdict "legacy" (the missing-capability test).
  - *Edge:* non-ASCII heading, `ignoreCase: true` -> TS makes no match decision;
    behavior equals whatever `md section --ignore-case` returns (locked by U7
    parity test).
- **Verification:** grep gate: no `toLocaleLowerCase`/`toLowerCase`/locale
  compare in `pi:src/`; no stderr substring tests; every `status:"failed"`
  envelope still carries code + nextAction (prior plan's invariant preserved).

### U5. pi-mdtools: real etag params + pi-convention hardening

- **Goal:** Wire U3's guards honestly and align the extension with pi host
  conventions found in the pattern sweep.
- **Requirements:** R5 surface truth; adoption salience.
- **Dependencies:** U3 (flags), U4 (decoder).
- **Files:**
  - Modify: `pi:index.ts` (expectEtag params now pass `--expect-etag` through on
    the tools that exist: md_replace_section and md_set_task — there is no
    md_delete_section tool, so delete-section guarding is binary-only in v0.2
    and tool-surface expansion stays deferred; descriptions rewritten to claim
    exactly section-span semantics), `pi:src/prompts.ts` (guidelines name exact
    tools and the re-query loop), `pi:src/runtime.ts`, `pi:src/content.ts`
  - Test: `pi:test/runtime.test.ts`
- **Approach:** Delete the TS-side heading-block etag compare entirely (its
  reduced semantics are why R5 existed). Convention pass, each item verified
  against the host: `StringEnum` for every enum param; output truncation via
  pi's `truncateHead`/`DEFAULT_MAX_BYTES` with spill-to-temp-file footer; strip
  leading `@` on path params; resolve paths against `ctx.cwd`; mutation window
  (tempfile write for `--from` + `md` call) fully inside `withFileMutationQueue`
  on the resolved absolute target path; `pi.exec` timeout + abort signal
  passthrough, checking `signal.aborted` after each await (edit.ts pattern).
  Prompt cost is budgeted, not vibed: total promptSnippet + promptGuidelines
  across all 9 tools capped (target <= ~400 tokens measured by a unit test over
  the assembled strings); guidelines consolidated into shared tool-naming
  bullets where possible. Keeping 9 concrete tools (no list/call indirection)
  is a deliberate context-economy call at this surface size; the budget test is
  what keeps it honest as tools are added.
- **Patterns to follow:** pi-mono `examples/extensions/truncated-tool.ts`
  (wrapper discipline); `src/core/tools/edit.ts` abort/queue discipline;
  duplicate-error phrasing style from `edit-diff.ts:268-275` for descriptions.
- **Test scenarios:**
  - *Happy path:* stale section etag -> exit 4 envelope -> `E_ETAG_MISMATCH`
    with "re-read md_outline/md_blocks" nextAction; fresh etag mutates.
  - *Edge:* >50KB md output truncated with footer naming the spill file.
  - *Edge:* `@README.md` param resolves to `README.md`.
  - *Error path:* abort mid-mutation leaves no tempfile and releases the queue.
- **Verification:** tool descriptions contain no claim the binary doesn't
  enforce; smoke-test script still passes.

### U6. pi-mdtools: usage instrumentation sidecar

- **Goal:** Land mdtools roadmap "instrument real deployment" (tool choice,
  re-query rate) — the current usage.jsonl is an unshipped personal wrapper.
- **Requirements:** deployment evidence for the public-experiment storyline.
- **Dependencies:** None (parallel to U4/U5).
- **Files:**
  - Create: `pi:src/usage.ts`
  - Modify: `pi:index.ts` (session hooks), `pi:README.md` (disclosure + opt-out)
  - Test: `pi:test/usage.test.ts`
- **Approach:** Append JSONL (`pi-mdtools-usage.v1`) per md_* call:
  ts, sessionId hash, tool, kind (query|mutation — static per tool, no string
  parsing), errorCode|ok, guarded (an etag expectation was ATTEMPTED — derived
  from the validated tool input, since a stale-etag failure produces no
  MutationResult; cross-checked against MutationResult.guarded on success),
  requeried (query on same file after a prior mutation,
  ported from `mdtools:bench/pi_audit_adapter.py:_has_query_after_mutation`),
  duration, outputBytes. No file contents, no headings, no paths beyond a
  basename hash. Default path `~/.local/share/pi-mdtools/usage.jsonl`, kill
  switch `PI_MDTOOLS_USAGE_LOG=""` (mirrors mdtools convention). Write failures
  swallowed. Schema stays consumer-generic: no bench task IDs, modes, or scorer
  vocabulary in the extension schema, ever — a future bench adapter (the
  pi_audit_adapter.py pattern) owns domain mapping. That boundary is what lets
  the same log serve the public-experiment writeup and any harness.
- **Patterns to follow:** `~/.pi/agent/extensions/audit` sidecar shape
  (pi-audit.v1) for redaction/truncation discipline.
- **Test scenarios:**
  - *Happy path:* one line per tool call with correct kind; mutation ->
    query(same file) sets requeried on the query line.
  - *Edge:* env kill switch produces zero writes; unwritable dir is silent.
  - *Privacy:* no absolute paths or document text appear in any line (grep
    assertion in test).
- **Verification:** a scripted pi session yields a parseable sidecar whose
  re-query rate matches hand count.

### U7. Cross-repo parity and boundary tests

- **Goal:** Mechanically lock every remaining hand-maintained seam.
- **Requirements:** audit's named tests; the falsifiable check for every
  "matches the binary" claim in this plan.
- **Dependencies:** U1, U2, U3, U4.
- **Files:**
  - Create: `pi:test/integration.parity.test.ts` (opt-in: runs when `MD_BINARY`
    env points at a real binary; CI job builds mdtools first)
  - Modify: `mdtools:bench/test_command_policy.py` (policy sets tested against
    `md schema --json`)
  - Test: they are the tests.
- **Approach:** (a) surface parity: every literal subcommand/flag emitted by
  `pi:src/runtime.ts` arg builders exists in the schema dump — extract literals
  via a small exported arg-builder table so the test enumerates, not greps;
  (b) DiagnosticCode roundtrip, two layers: a mechanical totality test — every
  code in `md schema --json`'s `diagnostic_codes` appears in the exported TS
  mapping table (or in an explicit default list), so new Rust diagnostics fail
  the suite until mapped — plus behavioral drives of the real binary for the
  representable classes (heading-not-found, duplicate, occurrence out of range,
  bad loc, block OOB, etag mismatch, etag ambiguous, parse error, invalid
  selector) asserting the exact `MdErrorCode`; (c) heading semantics:
  ASCII + `CAFÉ`/`café` + Turkish-I fixtures assert adapter behavior equals
  binary behavior for match/no-match under ignoreCase; (d) field-decode: every
  field name `runtime.ts` reads is present in real `--json` output per command
  (catches serde renames); (e) NDJSON multi-file and `tasks` single-object
  envelope quirks locked.
- **Patterns to follow:** fixture layout of existing `pi:test/runtime.test.ts`;
  mdtools integration-test style in `mdtools:tests/`.
- **Test scenarios:** enumerated above; each is itself the scenario.
- **Verification:** parity suite green against a fresh `cargo build --release`;
  deliberately renaming a serde field locally makes (d) fail (spot-check once).

### U8. Packaging, distribution, and binary bootstrap UX

- **Goal:** Installable by strangers: `pi install npm:pi-mdtools` (or git repo
  URL) with a graceful no-binary experience.
- **Requirements:** distribution wedge (the reason this project exists).
- **Dependencies:** U4 (handshake text), U5 (final tool surface).
- **Files:**
  - Modify: `pi:package.json` (peerDependencies `"*"` for
    `@earendil-works/pi-coding-agent` + typebox per pi packaging rules; files
    whitelist already present), `pi:README.md` (install matrix: npm, git, local
    path; binary install: cargo install / GitHub release; `MD_BINARY_PATH`),
    `pi:src/runtime.ts` (binary resolution order: `MD_BINARY_PATH` env/flag ->
    `MDTOOLS_MD_BIN` (the currently shipped var, retained as a compatibility
    alias so existing installs keep working) -> PATH -> `~/.pi/agent/bin/md`;
    miss -> `E_MD_BINARY_MISSING` whose nextAction contains copyable install
    commands + the version handshake result)
  - Test: `pi:test/runtime.test.ts` (resolution order), manual: clean-machine
    install per README.
- **Approach:** Repo is already standalone (pi git installs clone whole repos —
  no subdir support — so the separate-repo shape is load-bearing; do not fold
  into the mdtools monorepo). Keep imports on `@earendil-works/*` (upstream
  renamed from `@mariozechner/*`). Slash command stays `/mdtools` (a global
  `/md` viewer extension already exists on this machine; avoid the name).
  `/mdtools status` becomes the human repair surface: binary path + which
  resolution rule found it, `md --version`, handshake verdict
  (current | legacy | missing) with the upgrade/install command, usage-log
  state and path. Verify `pi-package` keyword survives in package.json
  (npm keyword search is the de-facto registry); optional `pi.image`
  screenshot for the package browser.
- **Test scenarios:**
  - *Happy path:* env override wins over PATH; PATH wins over `~/.pi/agent/bin`;
    `MDTOOLS_MD_BIN` alone still resolves (alias honored), and `MD_BINARY_PATH`
    wins when both are set.
  - *Error path:* no binary -> `E_MD_BINARY_MISSING` with install nextAction,
    tools still register (fail at call time, not load time).
  - *Edge:* old binary (no `md schema`) -> handshake marks legacy; conflict
    errors say "upgrade md to >= <version>" rather than guessing.
  - *Human surface:* `pi -p '/mdtools status'` in each of the three handshake
    states shows the right verdict + repair command.
- **Verification:** `npm pack` tarball installs into a scratch pi setup and the
  smoke test passes with a real binary on PATH; interactive `/reload` after an
  edit re-registers tools cleanly.

## Scope Boundaries

- No TS Markdown parsing or matching, ever (extends ADR 0001 from parsing to
  matching — the U4 grep gate enforces it).
- No pi `read`/`edit` override or disable; no `--no-builtin-tools` posture.
- No batch/transactional multi-edit (`md apply`) — still gated on live-trace
  evidence of an execution (not planning) gap, per mdtools CLAUDE.md #3/#4.
- No new md commands beyond `schema`; no coverage expansion of the 9-tool
  surface in this milestone (insert-block/search tools are follow-up).
- No `--expect-etag` on `move-section` (two-target design deferred).
- No MCP server; no WASM.
- mdtools.v1 stays: all model changes additive; version bumps to v2 are out of
  scope and would trip the U4 gate by design.

### Deferred to Follow-Up Work

- Neighbor-aware (context-sensitive) etags — the hashline convergence — as a
  v0.3 once plain span etags are proven in usage data (U6 tells us).
- `md_insert_block` / `md_search` tool coverage; table row mutations.
- `move-section` dual etag guard.
- Auto-download of the md binary GitHub release (bootstrap today is copyable
  commands; pi's internal tools-manager is not exported).

## System-Wide Impact

- **Interaction graph:** model tool call -> `pi:index.ts` -> runtime ->
  `pi.exec(md --json ...)` -> envelope decode -> recovery projection -> render.
  New: one-shot `md schema` handshake at first tool use per session.
- **Error propagation:** DiagnosticCode is now the single taxonomy end-to-end;
  TS adds transport-only codes (`E_MD_BINARY_MISSING`, `E_MD_JSON_PARSE`,
  `E_MD_COMMAND_ABORTED`, `E_MD_VERSION_UNSUPPORTED`) that name failures the
  binary cannot see. That partition (binary owns semantics, adapter owns
  transport) is the ownership boundary.
- **Other md consumers:** bench harness unaffected (envelope only under
  `--json`, stdout-on-error was previously empty under `--json`; scorer reads
  files, not stdout — verified in U1 tests). `command_policy.py` gains a parity
  test, not a behavior change. The public README "etag on all mutations" gap
  text must be updated when U3 lands (mdtools repo).
- **State lifecycle:** all mutations remain inside `withFileMutationQueue`;
  etag verify is in-process in Rust (parse-to-splice window), so the remaining
  race is md-process-vs-external-writer, same class as pi's own edit tool.
- **Unchanged invariants:** success payload passthrough; loc/etag opacity in
  TS; `tasks` single-object and NDJSON multi-file envelope quirks; exit codes;
  stderr text; pi built-in tools untouched.

## Mutation-path contract matrix (etag guard, per U3/U5)

Axis: expectEtag given? × document state at md invocation.

| Cell | Caller sees | Durable state | Side effects | Race (2 callers) | Test |
|---|---|---|---|---|---|
| etag matches, doc unchanged | `status: ok`, MutationResult forwarded | file spliced once | usage line (kind=mutation) | second caller queued by mutation queue; sees fresh state, its etag now stale -> exit 4 | U3 happy + U5 queue test |
| etag stale (any byte in span changed) | `status: failed`, `E_ETAG_MISMATCH`, expected/found, nextAction re-query | file untouched | usage line (errorCode) | both fail closed | U3 error path |
| etag omitted | mutation proceeds (guard is opt-in) | file spliced | usage line notes guarded=false | last-writer-wins inside queue | U5 test |
| etag given, duplicate-content candidates share the hash | fail closed: exit 4 `etag_ambiguous` — a content match cannot prove identity | file untouched | usage line (errorCode) | both fail closed | U3 identical-duplicate fixture |
| etag given, heading duplicated but hashes distinct | occurrence resolves target; stale hash on the resolved target -> exit 4 | file spliced or untouched | — | as rows 1/2 | U7 (c) |
| abort / lost result mid-call | `E_MD_COMMAND_ABORTED`, marked INDETERMINATE; nextAction: re-read before any retry | untouched OR fully mutated (atomic rename, U3) — never partial; which of the two is unknowable adapter-side | tempfile removed, queue released | queue never blocked | U5 abort test |

Invariants: (1) an md-REPORTED failure (nonzero exit, envelope delivered)
implies an untouched target file — verification precedes splice, and the atomic
rename means there is no partially-written state to leak; (2) partial file
content is never observable by any reader (temp-file + rename in U3); (3)
response/state atomicity across the subprocess boundary is NOT promised — an
aborted call or a lost result is indeterminate (the mutation may have fully
committed), so `E_MD_COMMAND_ABORTED` is contractually "re-read before retry",
never "file unchanged". Omitted-state challenge: (1) binary killed mid-write —
covered by rename atomicity (the old contents survive); (2) `--from` tempfile
deleted by an outside actor between write and exec — md exits 1 (IoOpenFailed),
coded failure, no mutation; both are locked by U3/U5 tests.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| clap introspection can't express arg groups faithfully | U2 fallback: static table + exhaustiveness unit test against clap walk |
| Error envelope on stdout surprises an unknown md consumer | only under `--json`; U1 edge test pins no-json path; mdtools test suite full run |
| Section etag over full span makes guards "too twitchy" (any body edit invalidates) | that IS the guard's meaning; nextAction says re-query; U6 data will show real-world friction before v0.3 tightens/loosens |
| Legacy-binary users get degraded errors | explicit handshake + upgrade guidance rather than silent misclassification (strictly better than today's wrong hints) |
| Cross-repo sequencing (Rust must ship before TS) | U-order enforced by dependency graph; pi handshake makes partial deploys safe |
| Prior-plan consumers rely on exit-4->etag mapping | supersession stated here; U4 keeps the code value only when the envelope confirms it |

## Disconfirming Evidence

- If U7(c) shows md's own ASCII-only `--ignore-case` matcher is itself the
  wrong-target source for non-ASCII docs, the fix is upstream in
  `mdtools:src/commands/section.rs` (documented limitation becomes a bug), never
  a TS compensation — that outcome would spawn a mdtools unit, not soften the
  no-TS-matcher rule.
- If U1's envelope-on-stdout breaks any bench/pi_audit path (full suites run in
  U1), move the envelope to stderr-as-JSON under `--json` and re-lock U4's
  decoder; the contract survives, the channel moves.
- If usage data (U6, 2+ weeks of real sessions) shows near-zero `expectEtag`
  adoption by models even with prompts, the "proven agent advantage" claim stays
  retracted and v0.3's neighbor-aware etag work is deprioritized in favor of
  salience work — matching the honest-benchmark positioning.

## Bug-trace / Confidence Cross-Check

| Audit finding | Unit / clause | Match? |
|---|---|---|
| R1 divergent heading matcher | U4 delete + grep gate; U7(c) parity | Yes |
| R2 exit-4 unconditional etag mapping | U1 code in envelope; U4 exhaustive switch | Yes |
| R3 stderr sniff tokens never match | U1/U4 remove sniffing entirely | Yes |
| R4 schema_version never validated | U4 gate before decode; U7(d) | Yes |
| R5 heading-block-only TOCTOU guard | U3 real flags; U5 deletes TS guard | Yes |
| Triplicated command literals | U2 dump; U7(a) + command_policy parity | Yes |
| Exit-code space not exhaustive in TS | U4 switch + unknown-code visibility | Yes |
| usage.jsonl documented but unshipped | U6 sidecar (and mdtools README fix noted in Impact) | Yes |
| Prior plan R1 "comrak only parser" | Scope boundary extends to matching | Yes |
| Prior plan envelope compatibility (its R5) | U4 keeps fields additive; existing tests kept green | Yes |

High-risk checklist applied (wire-format one-way doors): decision rationale
explicit; data flow traced (tool call -> exec -> envelope -> projection); the
one "matches the binary" claim class is discharged by U7's named tests, not by
eye; integration shape is the already-working registerTool surface (no new
extension-point bridging); no polymorphic event stream is introduced beyond the
single-shape usage line (one `kind` field, closed set, tested).
